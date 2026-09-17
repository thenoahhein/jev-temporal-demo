import { choice, noul, score } from "@typesafe-ai/sdk";
import type { Action, IncidentState } from "../shared/types";

// Jev questions. These are the only place natural language meets the model.
// Question ids are for code only; all meaning lives in `instructions` and `criteria`.

export const SEVERITY_LEVELS = [
  "Minor: small deviation from normal, no meaningful customer impact",
  "Moderate: noticeable degradation, some customers affected, revenue not yet at risk",
  "High: many customers failing on a critical path, revenue actively being lost",
  "Critical: service effectively down or data integrity at risk",
] as const;

export const SEVERITY_LABELS = ["MINOR", "MODERATE", "HIGH", "CRITICAL"] as const;

const ACTION_CRITERIA: Record<Action, string> = {
  inspect_logs:
    "Fetch recent application logs. Useful when the failure mode is unclear and logs have not been read yet.",
  inspect_metrics:
    "Refresh error rate, latency, CPU and memory. Useful when metrics are missing or stale.",
  check_recent_deploy:
    "Look up what was deployed recently and when, relative to when the incident started. Useful when a deploy is a plausible cause but its details are not yet known.",
  restart_service:
    "Restart the service's processes. Appropriate for resource exhaustion, leaks, or stuck workers when the code itself is believed healthy.",
  rollback_deploy:
    "Roll the service back to the previous version. Appropriate when the evidence points to a recent deploy as the cause and the deploy details are known.",
  wait_and_observe:
    "Take no action and re-check metrics shortly. Appropriate right after a remediation was applied and its effect has not been observed yet.",
  escalate_to_human:
    "Page an on-call engineer. Appropriate when the cause is unclear after investigation, remediation has already failed, or the situation is outside what an automated agent should handle.",
  resolve_incident:
    "Declare the incident over. Appropriate only when metrics are back to normal and the remediation is understood.",
};

/**
 * The set of actions Jev may choose from evolves with the state:
 * options that make no sense given what has already happened are removed in code,
 * so Jev is never asked to choose something the workflow cannot execute.
 */
export function availableActions(state: IncidentState): Action[] {
  const taken = new Set(state.actions_taken.map((a) => a.action));
  const actions: Action[] = [];
  if (!state.logs) actions.push("inspect_logs");
  actions.push("inspect_metrics");
  if (!state.deployments) actions.push("check_recent_deploy");
  actions.push("restart_service");
  if (state.deployments && !taken.has("rollback_deploy")) actions.push("rollback_deploy");
  actions.push("wait_and_observe", "escalate_to_human", "resolve_incident");
  return actions;
}

export function buildQuestions(state: IncidentState) {
  const options = availableActions(state);
  const criteria = Object.fromEntries(options.map((a) => [a, ACTION_CRITERIA[a]])) as Record<
    Action,
    string
  >;

  return {
    next_action: choice(
      {
        question:
          "You are the automated first responder for this production incident. Given everything currently known in the state, what is the single best next step?",
        guidance: [
          "Prefer gathering evidence (`check_recent_deploy`, `inspect_logs`) before disruptive remediation when the cause is not yet established.",
          "A deploy shortly before the incident with otherwise healthy infrastructure and dependencies strongly suggests the deploy is the cause.",
          "After a remediation in `actions_taken`, observe its effect before acting again.",
          "Only choose `resolve_incident` if `metrics.error_rate` is back near `metrics.normal_error_rate`.",
          "Respect any `human_feedback`.",
        ],
      },
      criteria,
    ),

    incident_severity: score(
      "How severe is this incident right now, based on `incident.symptoms` and `metrics` compared with the normal baselines?",
      SEVERITY_LEVELS,
    ),

    safe_to_act_autonomously: noul(
      "Does the current evidence justify an automated system taking its recommended next step without first asking a human?",
      {
        true: "The cause is well supported by the evidence, the step is standard for that cause, and a mistake would be easy to undo.",
        false:
          "The cause is unclear, evidence is conflicting (e.g. a degraded dependency AND a recent deploy), a prior remediation failed, or the step could make things worse.",
      },
    ),

    needs_deeper_reasoning: noul(
      "Is this situation ambiguous enough that a slower reasoning model or an on-call engineer should think it through before the next step?",
      {
        true: "Multiple plausible causes, conflicting signals, or a situation not covered by routine runbooks.",
        false: "A routine, well-understood pattern with one clear leading cause.",
      },
    ),
  };
}

export type IncidentQuestions = ReturnType<typeof buildQuestions>;
