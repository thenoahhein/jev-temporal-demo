import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, evaluatePolicy } from "./policy";
import type { Action, JevJudgment } from "./shared/types";

const j = (
  choice: Action,
  confidence: number,
  safe = 0.9,
  deeper = 0.1,
): JevJudgment => ({
  model: "mock-jev",
  real: false,
  next_action: { choice, confidence, probabilities: { [choice]: confidence } },
  incident_severity: { score: 2, label: "HIGH", confidence: 0.9 },
  safe_to_act_autonomously: safe,
  needs_deeper_reasoning: deeper,
});

describe("evaluatePolicy", () => {
  it("executes confident read-only actions", () => {
    expect(evaluatePolicy(j("check_recent_deploy", 0.9)).route).toBe("execute");
  });
  it("executes a confident, safe disruptive action", () => {
    expect(evaluatePolicy(j("rollback_deploy", 0.93, 0.9)).route).toBe("execute");
  });
  it("downgrades a low-confidence resolve_incident to wait_and_observe", () => {
    const r = evaluatePolicy(j("resolve_incident", 0.48));
    expect(r.route).toBe("execute");
    expect(r.action).toBe("wait_and_observe");
  });
  it("ignores the deeper-reasoning gate for read-only actions", () => {
    const r = evaluatePolicy(j("check_recent_deploy", 0.9, 0.9, 0.8));
    expect(r.route).toBe("execute");
    expect(r.action).toBe("check_recent_deploy");
  });
  it("still applies the deeper-reasoning gate to disruptive actions", () => {
    expect(evaluatePolicy(j("rollback_deploy", 0.9, 0.9, 0.8)).route).toBe("reasoning_model");
  });
  it("sends low-confidence actions to the reasoning model", () => {
    expect(evaluatePolicy(j("inspect_logs", 0.3)).route).toBe("reasoning_model");
  });
  it("sends ambiguous situations to the reasoning model", () => {
    expect(evaluatePolicy(j("restart_service", 0.8, 0.9, 0.7)).route).toBe("reasoning_model");
  });
  it("requires human approval for uncertain disruptive actions", () => {
    expect(evaluatePolicy(j("rollback_deploy", 0.61, 0.9)).route).toBe("human_approval");
  });
  it("requires human approval when safety is low", () => {
    expect(evaluatePolicy(j("rollback_deploy", 0.93, 0.5)).route).toBe("human_approval");
  });
  it("always requires approval for listed actions", () => {
    const policy = { ...DEFAULT_POLICY, alwaysRequireApproval: ["rollback_deploy"] as Action[] };
    expect(evaluatePolicy(j("rollback_deploy", 0.99, 0.99), policy).route).toBe("human_approval");
  });
  it("escalation goes to a human", () => {
    expect(evaluatePolicy(j("escalate_to_human", 0.95)).route).toBe("human_approval");
  });
});
