import type { Action, JevJudgment, Route } from "./shared/types";

/**
 * Action policy. This is ordinary application code and is deliberately the
 * only place where Jev's probabilities turn into permission to act.
 * Jev never grants itself permission; it only reports what it sees.
 */

export type Risk = "read_only" | "disruptive" | "terminal";

export const ACTION_RISK: Record<Action, Risk> = {
  inspect_logs: "read_only",
  inspect_metrics: "read_only",
  check_recent_deploy: "read_only",
  wait_and_observe: "read_only",
  restart_service: "disruptive",
  rollback_deploy: "disruptive",
  escalate_to_human: "read_only",
  resolve_incident: "terminal",
};

export interface PolicyConfig {
  /** Below this Choice confidence we do not trust the action at all; consult the reasoning model. */
  minConfidence: number;
  /** Disruptive actions need at least this Choice confidence to run unattended. */
  disruptiveMinConfidence: number;
  /** Disruptive actions need P(safe_to_act_autonomously) at least this high to run unattended. */
  disruptiveMinSafety: number;
  /**
   * Above this P(needs_deeper_reasoning) we consult the reasoning model before acting.
   * Only applied to disruptive/terminal actions: gathering evidence is cheap and
   * reversible, so it never warrants paying for slower reasoning first.
   */
  deeperReasoningThreshold: number;
  /** Declaring the incident resolved needs at least this confidence; otherwise keep observing. */
  terminalMinConfidence: number;
  /** Actions that always require a human regardless of confidence (demo lever + real-world policy hook). */
  alwaysRequireApproval: Action[];
}

export const DEFAULT_POLICY: PolicyConfig = {
  minConfidence: 0.4,
  disruptiveMinConfidence: 0.75,
  disruptiveMinSafety: 0.7,
  deeperReasoningThreshold: 0.6,
  terminalMinConfidence: 0.7,
  alwaysRequireApproval: [],
};

export interface PolicyResult {
  route: Route;
  /** The action to carry out; normally Jev's choice, occasionally downgraded by policy. */
  action: Action;
  reason: string;
}

export function evaluatePolicy(j: JevJudgment, policy: PolicyConfig = DEFAULT_POLICY): PolicyResult {
  const action = j.next_action.choice;
  const conf = j.next_action.confidence;
  const risk = ACTION_RISK[action];

  if (action === "escalate_to_human") {
    return { route: "human_approval", action, reason: "Jev chose to escalate" };
  }
  if (policy.alwaysRequireApproval.includes(action)) {
    return { route: "human_approval", action, reason: `policy: ${action} always requires approval` };
  }
  if (risk === "terminal" && conf < policy.terminalMinConfidence) {
    return {
      route: "execute",
      action: "wait_and_observe",
      reason: `${action} confidence ${pct(conf)} < ${pct(policy.terminalMinConfidence)}; keep observing`,
    };
  }
  if (conf < policy.minConfidence) {
    return {
      route: "reasoning_model",
      action,
      reason: `confidence ${pct(conf)} < ${pct(policy.minConfidence)}`,
    };
  }
  if (risk !== "read_only" && j.needs_deeper_reasoning >= policy.deeperReasoningThreshold) {
    return {
      route: "reasoning_model",
      action,
      reason: `needs_deeper_reasoning ${pct(j.needs_deeper_reasoning)} >= ${pct(policy.deeperReasoningThreshold)}`,
    };
  }
  if (risk === "disruptive") {
    if (conf < policy.disruptiveMinConfidence) {
      return {
        route: "human_approval",
        action,
        reason: `${action} confidence ${pct(conf)} < ${pct(policy.disruptiveMinConfidence)}`,
      };
    }
    if (j.safe_to_act_autonomously < policy.disruptiveMinSafety) {
      return {
        route: "human_approval",
        action,
        reason: `safe_to_act_autonomously ${pct(j.safe_to_act_autonomously)} < ${pct(policy.disruptiveMinSafety)}`,
      };
    }
  }
  return { route: "execute", action, reason: `${risk} action, confidence ${pct(conf)}` };
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
