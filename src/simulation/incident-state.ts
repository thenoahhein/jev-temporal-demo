import type { ActionRecord, IncidentState } from "../shared/types";

// Mocked infrastructure. Everything is a pure function of (scenario, actions_taken)
// so the worker can be killed and restarted at any point without losing state —
// the incident's evolution lives entirely in the workflow's history.

export type Scenario = "deploy_regression" | "ambiguous";

type Metrics = NonNullable<IncidentState["metrics"]>;
type Deployments = NonNullable<IncidentState["deployments"]>;

export function initialState(incidentId: string, scenario: Scenario): IncidentState {
  return {
    incident: {
      id: incidentId,
      service: "checkout-api",
      started_at: "2024-01-01T00:00:00.000Z",
      symptoms:
        scenario === "deploy_regression"
          ? ["elevated 5xx", "p95 latency 4.2s"]
          : ["elevated 5xx", "intermittent DB connection timeouts"],
    },
    metrics: null,
    logs: null,
    deployments: null,
    dependency_status:
      scenario === "deploy_regression"
        ? { payments: "healthy", database: "healthy", cache: "healthy" }
        : { payments: "healthy", database: "degraded", cache: "healthy" },
    actions_taken: [],
    human_feedback: [],
  };
}

function waitsAfter(taken: ActionRecord[], action: string): number {
  const idx = taken.map((a) => a.action).lastIndexOf(action as never);
  if (idx === -1) return -1;
  return taken.slice(idx + 1).filter((a) => a.action === "wait_and_observe").length;
}

export function simulateMetrics(scenario: Scenario, taken: ActionRecord[]): Metrics {
  const base: Metrics = {
    error_rate: 0.18,
    normal_error_rate: 0.002,
    p95_latency_ms: 4200,
    normal_p95_latency_ms: 310,
    cpu: 0.43,
    memory: 0.62,
  };

  if (scenario === "deploy_regression") {
    const rolledBack = taken.some((a) => a.action === "rollback_deploy");
    if (rolledBack) {
      const w = waitsAfter(taken, "rollback_deploy");
      const curve = [0.06, 0.003, 0.002, 0.002];
      base.error_rate = curve[Math.min(w, 3)];
      base.p95_latency_ms =
        base.error_rate <= 0.003 ? 340 : base.error_rate <= 0.01 ? 900 : 2600;
      return base;
    }
    // Restart helps only briefly; the regression is in the deployed code.
    if (taken.length && taken[taken.length - 1].action === "restart_service") {
      base.error_rate = 0.09;
      base.p95_latency_ms = 2400;
    }
    return base;
  }

  // ambiguous: DB pool exhaustion — rollback barely helps, restart does.
  base.error_rate = 0.06;
  base.p95_latency_ms = 2100;
  const rolledBack = taken.some((a) => a.action === "rollback_deploy");
  const restarted = taken.some((a) => a.action === "restart_service");
  if (restarted) {
    const w = waitsAfter(taken, "restart_service");
    base.error_rate = w >= 1 ? 0.004 : 0.02;
    base.p95_latency_ms = w >= 1 ? 380 : 900;
  } else if (rolledBack) {
    base.error_rate = 0.05;
    base.p95_latency_ms = 1900;
  }
  return base;
}

export function simulateLogs(scenario: Scenario, _taken: ActionRecord[]): string[] {
  if (scenario === "deploy_regression") {
    return [
      "2024-01-01T00:00:41Z ERROR checkout-api[7]: NullPointerException in PriceCalculator.applyDiscount (PriceCalculator.kt:118)",
      "2024-01-01T00:00:41Z WARN  checkout-api[7]: discount engine returned null for sku=SKU-9921 region=eu-west",
      "2024-01-01T00:00:42Z ERROR checkout-api[3]: 500 POST /checkout/confirm (cart_id=c_81f2) in 412ms",
      "2024-01-01T00:00:43Z ERROR checkout-api[7]: 500 POST /checkout/confirm (cart_id=c_19aa) in 390ms",
      "2024-01-01T00:00:44Z INFO  checkout-api[3]: health check ok (deps: payments=ok db=ok cache=ok)",
      "2024-01-01T00:00:45Z ERROR checkout-api[7]: 500 POST /checkout/confirm (cart_id=c_77d0) in 405ms",
    ];
  }
  return [
    "2024-01-01T00:00:41Z ERROR checkout-api[4]: pg: connection timeout after 5000ms (pool=primary)",
    "2024-01-01T00:00:42Z WARN  checkout-api[4]: pool exhausted (40/40 connections in use), queuing request",
    "2024-01-01T00:00:44Z ERROR checkout-api[2]: 500 POST /checkout/confirm (cart_id=c_31bc) in 5031ms",
    "2024-01-01T00:00:46Z WARN  checkout-api[4]: slow query 4800ms: SELECT * FROM carts WHERE id=$1",
    "2024-01-01T00:00:47Z INFO  checkout-api[2]: process healthy; cpu and memory within limits",
    "2024-01-01T00:00:49Z ERROR checkout-api[4]: pg: connection timeout after 5000ms (pool=primary)",
  ];
}

export function simulateDeploy(scenario: Scenario): Deployments {
  if (scenario === "deploy_regression") {
    return {
      latest: {
        version: "v1.42.0",
        previous_version: "v1.41.3",
        deployed_minutes_before_incident: 7,
        change_summary: "feat: new discount engine for checkout pricing",
      },
    };
  }
  return {
    latest: {
      version: "v1.42.0",
      previous_version: "v1.41.3",
      deployed_minutes_before_incident: 190,
      change_summary: "config: bump DB connection pool from 20 to 40",
    },
  };
}
