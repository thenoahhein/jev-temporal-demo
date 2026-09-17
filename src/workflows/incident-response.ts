import {
  condition,
  defineQuery,
  defineSignal,
  log,
  proxyActivities,
  proxySinks,
  setHandler,
  sleep,
  workflowInfo,
  Sinks,
} from "@temporalio/workflow";
import type * as infra from "../activities/infrastructure";
import type * as jev from "../activities/jev";
import type * as human from "../activities/human";
import { DEFAULT_POLICY, evaluatePolicy } from "../policy";
import { initialState } from "../simulation/incident-state";
import type {
  Action,
  Decision,
  HumanDecision,
  IncidentState,
  IncidentStatus,
  IncidentWorkflowInput,
} from "../shared/types";

export const humanDecisionSignal = defineSignal<[HumanDecision]>("humanDecision");
export const statusQuery = defineQuery<IncidentStatus>("status");

export interface DemoSinks extends Sinks {
  demo: {
    event(kind: string, payload: unknown): void;
  };
}
const { demo } = proxySinks<DemoSinks>();

const infraActs = proxyActivities<typeof infra>({
  startToCloseTimeout: "10 seconds",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumAttempts: 5 },
});
const jevActs = proxyActivities<typeof jev>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumAttempts: 3 },
});
const humanActs = proxyActivities<typeof human>({
  startToCloseTimeout: "60 seconds",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumAttempts: 3 },
});

export async function incidentResponseAgent(input: IncidentWorkflowInput): Promise<IncidentStatus> {
  const policy = { ...DEFAULT_POLICY, ...input.policy };
  const state: IncidentState = initialState(input.incidentId, input.scenario);
  const decisions: Decision[] = [];

  const status: IncidentStatus = {
    phase: "gathering",
    step: 0,
    state,
    decisions,
    pendingAction: null,
  };

  let humanDecision: HumanDecision | undefined;
  setHandler(statusQuery, () => status);
  setHandler(humanDecisionSignal, (d: HumanDecision) => {
    humanDecision = d;
  });

  demo.event("incident_started", {
    incidentId: input.incidentId,
    scenario: input.scenario,
    symptoms: state.incident.symptoms,
  });
  state.metrics = await infraActs.getMetrics({ scenario: input.scenario, actions_taken: state.actions_taken });

  for (let step = 1; step <= 12; step++) {
    status.step = step;
    status.phase = "deciding";
    const judgment = await jevActs.askJev(state);
    let { route, action, reason } = evaluatePolicy(judgment, policy);
    decisions.push({ step, at: new Date().toISOString(), judgment, route, action, reason });
    demo.event("decision", { step, route, action, reason });
    log.info("decision", { step, route, action, reason });

    if (route === "reasoning_model") {
      status.phase = "consulting_reasoning_model";
      const advice = await humanActs.consultReasoningModel({ state, judgment });
      state.human_feedback.push(`reasoning model (${advice.model}): ${advice.rationale}`);
      const reJudgment = {
        ...judgment,
        next_action: { ...judgment.next_action, choice: advice.recommended_action, confidence: 1 },
        needs_deeper_reasoning: 0,
      };
      ({ route, action, reason } = evaluatePolicy(reJudgment, policy));
      demo.event("decision", { step, route, action, reason: `after reasoning model: ${reason}` });
    }

    if (route === "human_approval" || action === "escalate_to_human") {
      status.phase = "waiting_for_human";
      if (action === "escalate_to_human") {
        // propose the strongest non-escalation alternative instead
        const alt = Object.entries(judgment.next_action.probabilities)
          .filter(([a]) => a !== "escalate_to_human")
          .sort((x, y) => y[1] - x[1])[0];
        action = (alt?.[0] ?? "wait_and_observe") as Action;
      }
      status.pendingAction = action;
      const rejections = state.actions_taken.filter((a) => a.result === "rejected by human").length;
      await humanActs.notifyHuman({ workflowId: workflowInfo().workflowId, action, judgment, reason });
      humanDecision = undefined;
      await condition(() => humanDecision !== undefined);
      status.pendingAction = null;
      if (humanDecision!.approved) {
        state.human_feedback.push(
          `human approved ${action}` + (humanDecision!.note ? ` (${humanDecision!.note})` : ""),
        );
        demo.event("human_approved", { action });
      } else {
        state.human_feedback.push(
          `human rejected ${action}: ${humanDecision!.note ?? "no note"}`,
        );
        state.actions_taken.push({ action, result: "rejected by human" });
        demo.event("human_rejected", { action });
        if (rejections + 1 >= 2) {
          status.phase = "handed_off";
          return status;
        }
        continue;
      }
    }

    status.phase = "executing";
    demo.event("executing", { action });
    let result = "";
    switch (action) {
      case "inspect_logs":
        state.logs = await infraActs.getLogs({ scenario: input.scenario, actions_taken: state.actions_taken });
        result = `read ${state.logs.length} log lines`;
        break;
      case "inspect_metrics":
        state.metrics = await infraActs.getMetrics({ scenario: input.scenario, actions_taken: state.actions_taken });
        result = "metrics refreshed";
        break;
      case "check_recent_deploy":
        state.deployments = await infraActs.getRecentDeploy({ scenario: input.scenario });
        result = `deploy ${state.deployments!.latest.version} found`;
        break;
      case "restart_service":
        result = await infraActs.restartService({ service: state.incident.service });
        break;
      case "rollback_deploy":
        result = await infraActs.rollbackDeployment({
          service: state.incident.service,
          from: state.deployments!.latest.version,
          to: state.deployments!.latest.previous_version,
        });
        break;
      case "wait_and_observe":
        status.phase = "observing";
        await sleep(input.scenario === "deploy_regression" ? "20 seconds" : "10 seconds");
        result = `observed for ${input.scenario === "deploy_regression" ? 20 : 10}s`;
        break;
      case "resolve_incident":
        status.phase = "resolved";
        demo.event("incident_resolved", { steps: step });
        return status;
      case "escalate_to_human":
        result = "escalated"; // handled above; unreachable
        break;
    }
    state.actions_taken.push({ action, result });
    state.metrics = await infraActs.getMetrics({ scenario: input.scenario, actions_taken: state.actions_taken });
    const rec = state.actions_taken[state.actions_taken.length - 1];
    rec.observed_error_rate = state.metrics?.error_rate;
    demo.event("action_done", { action, result, error_rate: rec.observed_error_rate });
  }

  status.phase = "handed_off";
  return status;
}
