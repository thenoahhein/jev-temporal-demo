import { Context } from "@temporalio/activity";
import { errorSection, kv, section, warnSection } from "../shared/console";
import {
  simulateDeploy,
  simulateLogs,
  simulateMetrics,
  type Scenario,
} from "../simulation/incident-state";
import type { ActionRecord, IncidentState } from "../shared/types";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 300 + Math.floor(Math.random() * 500);

interface SimInput {
  scenario: Scenario;
  actions_taken: ActionRecord[];
}

export async function getMetrics(input: SimInput): Promise<IncidentState["metrics"]> {
  section("TEMPORAL", "→ getMetrics()");
  await delay(jitter());
  const m = simulateMetrics(input.scenario, input.actions_taken);
  section(
    "METRICS",
    kv("error_rate", `${(m!.error_rate * 100).toFixed(1)}% (normal ${(m!.normal_error_rate * 100).toFixed(1)}%)`),
    kv("p95_latency", `${m!.p95_latency_ms}ms (normal ${m!.normal_p95_latency_ms}ms)`),
    kv("cpu / memory", `${m!.cpu} / ${m!.memory}`),
  );
  return m;
}

export async function getLogs(input: SimInput): Promise<string[]> {
  section("TEMPORAL", "→ getLogs()");
  await delay(jitter());
  const logs = simulateLogs(input.scenario, input.actions_taken);
  section("LOGS", ...logs.slice(0, 4));
  return logs;
}

export async function getRecentDeploy(input: {
  scenario: Scenario;
}): Promise<IncidentState["deployments"]> {
  section("TEMPORAL", "→ getRecentDeploy()");
  await delay(jitter());
  const d = simulateDeploy(input.scenario);
  section(
    "DEPLOY",
    kv("version", `${d!.latest.version} (prev ${d!.latest.previous_version})`),
    kv("deployed", `${d!.latest.deployed_minutes_before_incident} min before incident`),
    kv("change", d!.latest.change_summary),
  );
  return d;
}

export async function restartService(input: { service: string }): Promise<string> {
  section("TEMPORAL", `→ restartService(${input.service})`);
  await delay(jitter());
  const msg = `service ${input.service} restarted: 3/3 pods recycled`;
  section("RESTART", msg);
  return msg;
}

// Demo Moment 2: the first attempt always times out; Temporal's retry policy
// re-runs the activity automatically and the workflow never notices.
export async function rollbackDeployment(input: {
  service: string;
  from: string;
  to: string;
}): Promise<string> {
  const { attempt } = Context.current().info;
  if (attempt === 1) {
    errorSection("ACTIVITY FAILED", `rollbackDeployment(${input.from} → ${input.to})`);
    throw new Error("network timeout contacting deploy controller (simulated)");
  }
  warnSection("TEMPORAL", `retrying activity (attempt ${attempt})...`);
  section("TEMPORAL", `→ rollbackDeployment(${input.from} → ${input.to})`);
  await delay(jitter());
  const msg = `service ${input.service} rolled back ${input.from} → ${input.to}`;
  section("ROLLBACK COMPLETE", msg);
  return msg;
}
