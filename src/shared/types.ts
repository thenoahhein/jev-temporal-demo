// Shared types between the Workflow, Activities, and CLI.
// Everything here must be JSON-serialisable: it crosses the Temporal data converter.

export const ACTIONS = [
  "inspect_logs",
  "inspect_metrics",
  "check_recent_deploy",
  "restart_service",
  "rollback_deploy",
  "wait_and_observe",
  "escalate_to_human",
  "resolve_incident",
] as const;

export type Action = (typeof ACTIONS)[number];

export type DependencyStatus = "healthy" | "degraded" | "down";

export interface IncidentState {
  incident: {
    id: string;
    service: string;
    started_at: string;
    symptoms: string[];
  };
  metrics: {
    error_rate: number;
    normal_error_rate: number;
    p95_latency_ms: number;
    normal_p95_latency_ms: number;
    cpu: number;
    memory: number;
  } | null;
  logs: string[] | null;
  deployments: {
    latest: {
      version: string;
      previous_version: string;
      deployed_minutes_before_incident: number;
      change_summary: string;
    };
  } | null;
  dependency_status: Record<string, DependencyStatus>;
  actions_taken: ActionRecord[];
  human_feedback: string[];
}

export interface ActionRecord {
  action: Action;
  result: string;
  observed_error_rate?: number;
}

/** Raw, typed judgments from Jev. Policy is applied to these in code, never here. */
export interface JevJudgment {
  model: string;
  /** false when TYPESAFE_API_KEY is absent and the heuristic stand-in answered instead */
  real: boolean;
  next_action: {
    choice: Action;
    confidence: number;
    probabilities: Record<string, number>;
  };
  incident_severity: {
    /** 0..3 expected value over SEVERITY_LEVELS */
    score: number;
    label: string;
    confidence: number;
  };
  /** P(yes) */
  safe_to_act_autonomously: number;
  /** P(yes) */
  needs_deeper_reasoning: number;
}

export type Route = "execute" | "human_approval" | "reasoning_model";

export interface Decision {
  step: number;
  at: string;
  /** Raw Jev output — never mutated by policy. */
  judgment: JevJudgment;
  route: Route;
  /** The action actually carried out; may differ from judgment.next_action.choice when policy downgrades it. */
  action: Action;
  reason: string;
}

export interface HumanDecision {
  approved: boolean;
  note?: string;
}

export interface ReasoningAdvice {
  model: string;
  recommended_action: Action;
  rationale: string;
}

export interface IncidentWorkflowInput {
  incidentId: string;
  scenario: "deploy_regression" | "ambiguous";
  /** Partial policy overrides (JSON-serialisable); merged over DEFAULT_POLICY inside the workflow. */
  policy?: {
    minConfidence?: number;
    disruptiveMinConfidence?: number;
    disruptiveMinSafety?: number;
    deeperReasoningThreshold?: number;
    terminalMinConfidence?: number;
    alwaysRequireApproval?: Action[];
  };
}

export interface IncidentStatus {
  phase:
    | "gathering"
    | "deciding"
    | "executing"
    | "waiting_for_human"
    | "consulting_reasoning_model"
    | "observing"
    | "resolved"
    | "handed_off";
  step: number;
  state: IncidentState;
  decisions: Decision[];
  pendingAction: Action | null;
}
