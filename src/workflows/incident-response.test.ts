import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "path";
import { humanDecisionSignal, incidentResponseAgent, statusQuery } from "./incident-response";
import { initialState, simulateDeploy, simulateMetrics } from "../simulation/incident-state";
import type { Action, IncidentState, JevJudgment } from "../shared/types";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const j = (choice: Action, confidence = 0.93): JevJudgment => ({
  model: "mock-jev",
  real: false,
  next_action: { choice, confidence, probabilities: { [choice]: confidence } },
  incident_severity: { score: 2.5, label: "HIGH", confidence: 0.9 },
  safe_to_act_autonomously: 0.9,
  needs_deeper_reasoning: 0.1,
});

// Scripted Jev: mirrors the happy-path deploy_regression run.
function scriptedAskJev(calls: { n: number }) {
  return async (state: IncidentState): Promise<JevJudgment> => {
    calls.n++;
    const taken = new Set(state.actions_taken.map((a) => a.action));
    if (!state.deployments) return j("check_recent_deploy", 0.9);
    if (!taken.has("rollback_deploy")) return j("rollback_deploy", 0.93);
    if ((state.metrics?.error_rate ?? 1) > 0.01) return j("wait_and_observe", 0.9);
    return j("resolve_incident", 0.94);
  };
}

const okImpl = {
  getMetrics: async (i: { scenario: "deploy_regression"; actions_taken: IncidentState["actions_taken"] }) =>
    simulateMetrics(i.scenario, i.actions_taken),
  getLogs: async () => ["log line"],
  getRecentDeploy: async (i: { scenario: "deploy_regression" }) => simulateDeploy(i.scenario),
  restartService: async () => "restarted",
};

describe("incidentResponseAgent", () => {
  it(
    "retries the flaky rollback activity and resolves without re-asking Jev",
    async () => {
      const calls = { n: 0 };
      let rollbacks = 0;
      const rollbackDeployment = async () => {
        rollbacks++;
        if (rollbacks === 1) throw new Error("network timeout contacting deploy controller (simulated)");
        return "rolled back v1.42.0 → v1.41.3";
      };
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: "tq-happy",
        workflowsPath: path.resolve(__dirname, "incident-response.ts"),
        activities: { ...okImpl, rollbackDeployment, askJev: scriptedAskJev(calls), notifyHuman: async () => {}, consultReasoningModel: async () => { throw new Error("unneeded"); } },
      });
      const result = await worker.runUntil(
        env.client.workflow.execute(incidentResponseAgent, {
          taskQueue: "tq-happy",
          workflowId: "wf-happy",
          args: [{ incidentId: "INC-1", scenario: "deploy_regression" }],
        }) as never,
      );
      const status = result as { phase: string; state: IncidentState };
      expect(status.phase).toBe("resolved");
      expect(rollbacks).toBe(2);
      expect(calls.n).toBe(4); // check_deploy, rollback, wait, resolve — not re-asked between attempts
      expect(status.state.actions_taken.filter((a) => a.action === "rollback_deploy")).toHaveLength(1);
    },
    60_000,
  );

  it(
    "routes a low-confidence disruptive action to human approval, then proceeds on approve",
    async () => {
      const calls = { n: 0 };
      const askJev = async (state: IncidentState) => {
        calls.n++;
        if (!state.deployments) return j("check_recent_deploy", 0.9);
        if (state.actions_taken.some((a) => a.action === "rollback_deploy")) return j("resolve_incident", 0.94);
        return j("rollback_deploy", 0.61); // below disruptiveMinConfidence → human_approval
      };
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: "tq-approval",
        workflowsPath: path.resolve(__dirname, "incident-response.ts"),
        activities: {
          ...okImpl,
          rollbackDeployment: async () => "rolled back",
          askJev,
          notifyHuman: async () => {},
          consultReasoningModel: async () => {
            throw new Error("unneeded");
          },
        },
      });
      const run = worker.run();
      const handle = await env.client.workflow.start(incidentResponseAgent, {
        taskQueue: "tq-approval",
        workflowId: "wf-approval",
        args: [{ incidentId: "INC-2", scenario: "deploy_regression" }],
      });
      // wait until it parks on the human
      await env.sleep("2 seconds").catch(() => {});
      let status = (await handle.query(statusQuery)) as { phase: string; pendingAction: string | null };
      expect(status.phase).toBe("waiting_for_human");
      expect(status.pendingAction).toBe("rollback_deploy");
      await handle.signal(humanDecisionSignal, { approved: true, note: "on-call says go" });
      const final = (await handle.result()) as { phase: string };
      expect(final.phase).toBe("resolved");
      run;
    },
    60_000,
  );
});

void initialState;
