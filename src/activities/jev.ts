import { TypeSafeClient, type JsonValue } from "@typesafe-ai/sdk";
import { buildQuestions, SEVERITY_LABELS } from "../jev/questions";
import { section, kv, colors } from "../shared/console";
import { loadEnv } from "../shared/env";
import type { Action, IncidentState, JevJudgment } from "../shared/types";

loadEnv();

function severityFromErrorRate(er: number | undefined): number {
  if (er === undefined) return 1.5;
  if (er >= 0.1) return 2.7;
  if (er >= 0.03) return 2.2;
  if (er >= 0.01) return 1.4;
  return 0.6;
}

// Heuristic stand-in for Jev used when TYPESAFE_API_KEY is absent or JEV_MOCK=1.
// It mirrors what the real model tends to answer on this scripted incident so
// the whole demo runs offline; `real: false` marks it as a substitute.
function mockJev(state: IncidentState): JevJudgment {
  const er = state.metrics?.error_rate;
  const taken = new Set(state.actions_taken.map((a) => a.action));
  const ambiguous = state.dependency_status.database === "degraded";
  const rejected = state.actions_taken.filter((a) => a.result === "rejected by human").length;

  let choice: Action;
  let conf: number;
  let safe: number;
  let deeper: number;
  const probs: Record<string, number> = {};

  if (ambiguous && !taken.has("restart_service")) {
    choice = "restart_service";
    conf = 0.55;
    safe = 0.35;
    deeper = 0.7;
    Object.assign(probs, {
      restart_service: 0.55,
      rollback_deploy: 0.2,
      escalate_to_human: 0.15,
      inspect_logs: 0.1,
    });
  } else if (ambiguous && er !== undefined && er <= 0.005) {
    choice = "resolve_incident";
    conf = 0.9;
    safe = 0.85;
    deeper = 0.1;
    Object.assign(probs, { resolve_incident: 0.9, wait_and_observe: 0.1 });
  } else if (ambiguous) {
    choice = "wait_and_observe";
    conf = 0.8;
    safe = 0.9;
    deeper = 0.2;
    Object.assign(probs, { wait_and_observe: 0.8, restart_service: 0.15, escalate_to_human: 0.05 });
  } else if (rejected >= 1 && state.deployments && !taken.has("rollback_deploy")) {
    choice = "restart_service";
    conf = 0.62;
    safe = 0.6;
    deeper = 0.3;
    Object.assign(probs, { restart_service: 0.62, wait_and_observe: 0.2, escalate_to_human: 0.18 });
  } else if (!state.deployments) {
    choice = "check_recent_deploy";
    conf = 0.9;
    safe = 0.92;
    deeper = 0.05;
    Object.assign(probs, { check_recent_deploy: 0.9, inspect_logs: 0.06, inspect_metrics: 0.04 });
  } else if (!taken.has("rollback_deploy") && state.deployments.latest.deployed_minutes_before_incident <= 30) {
    choice = "rollback_deploy";
    conf = 0.93;
    safe = 0.9;
    deeper = 0.1;
    Object.assign(probs, { rollback_deploy: 0.93, restart_service: 0.04, wait_and_observe: 0.03 });
  } else if (er !== undefined && er > 0.005) {
    choice = "wait_and_observe";
    conf = 0.88;
    safe = 0.95;
    deeper = 0.05;
    Object.assign(probs, { wait_and_observe: 0.88, inspect_metrics: 0.08, restart_service: 0.04 });
  } else {
    choice = "resolve_incident";
    conf = 0.94;
    safe = 0.9;
    deeper = 0.03;
    Object.assign(probs, { resolve_incident: 0.94, wait_and_observe: 0.06 });
  }

  const score = severityFromErrorRate(er);
  return {
    model: "mock-jev",
    real: false,
    next_action: { choice, confidence: conf, probabilities: probs },
    incident_severity: {
      score,
      label: SEVERITY_LABELS[Math.min(3, Math.max(0, Math.round(score)))],
      confidence: 0.85,
    },
    safe_to_act_autonomously: safe,
    needs_deeper_reasoning: deeper,
  };
}

function alternatives(j: JevJudgment): string {
  return Object.entries(j.next_action.probabilities)
    .filter(([a]) => a !== j.next_action.choice)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([a, p]) => `${a} ${Math.round(p * 100)}%`)
    .join(" · ");
}

function printJudgment(j: JevJudgment): void {
  const tag = j.real ? j.model : "jev-latest (mock)";
  section(`${colors.bold}JEV${colors.reset}${colors.dim}                                    (${tag})${colors.reset}`,
    kv("severity", `${j.incident_severity.label} (${j.incident_severity.score.toFixed(1)})`),
    kv("next action", j.next_action.choice.toUpperCase()),
    kv("confidence", `${Math.round(j.next_action.confidence * 100)}%`),
    kv("safe to act", `${Math.round(j.safe_to_act_autonomously * 100)}%`),
    kv("needs deeper reasoning", `${Math.round(j.needs_deeper_reasoning * 100)}%`),
    kv("alternatives", alternatives(j) || "—"),
  );
}

export async function askJev(state: IncidentState): Promise<JevJudgment> {
  const mock = process.env.JEV_MOCK === "1" || !process.env.TYPESAFE_API_KEY;
  if (mock) {
    const j = mockJev(state);
    printJudgment(j);
    return j;
  }

  const client = new TypeSafeClient();
  const { answers, model } = await client.systemOne({
    state: state as unknown as { [key: string]: JsonValue },
    questions: buildQuestions(state),
  });

  const score = Math.min(3, Math.max(0, answers.incident_severity.score));
  const j: JevJudgment = {
    model,
    real: true,
    next_action: {
      choice: answers.next_action.choice,
      confidence: answers.next_action.confidence,
      probabilities: { ...answers.next_action.probabilities },
    },
    incident_severity: {
      score,
      label: SEVERITY_LABELS[Math.round(score)],
      confidence: answers.incident_severity.confidence,
    },
    safe_to_act_autonomously: answers.safe_to_act_autonomously.noul,
    needs_deeper_reasoning: answers.needs_deeper_reasoning.noul,
  };
  printJudgment(j);
  return j;
}
