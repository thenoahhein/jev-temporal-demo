# Durable AI decision loops with Temporal + Jev

> Jev makes fast semantic decisions over application state; Temporal durably executes those decisions across tools, failures, time, and human intervention.

**Jev decides. Temporal executes durably.**

This repo is a small autonomous **incident-response agent**. A production service starts throwing errors; the agent repeatedly answers *"given everything we know right now, what should we do next?"*, executes that step, observes the result, and asks again — until the incident is resolved or a human takes over.

The decision loop itself is a Temporal Workflow. Jev ([TypeSafe](https://typesafe.ai)'s System One model) is called inside that loop as an ordinary Activity that returns **typed judgments with probabilities**, not prose. There is no LLM holding the agent loop in memory.

```text
Temporal = durable agent runtime
Jev      = fast semantic decision primitive
LLM      = optional deep reasoning primitive
Tools    = actions
Human    = escalation
```

## Architecture

```text
                       ┌──────────────────────────────────────────────┐
                       │  Temporal Workflow: incidentResponseAgent    │
                       │  (owns state, history, retries, timers,      │
                       │   waiting, recovery)                         │
                       └──────────────────────────────────────────────┘
                                          │
            ┌─────────────────────────────┼──────────────────────────────┐
            │                             │                              │
            ▼                             ▼                              ▼
   gather state                      askJev()                     policy (plain code)
   getMetrics / getLogs /     ┌─────────────────────────┐        confidence thresholds,
   getRecentDeploy            │ next_action   : Choice  │        risk classes,
                              │ severity      : Score   │        "always ask a human" list
                              │ safe_to_act   : Noul    │
                              │ needs_deeper  : Noul    │
                              └─────────────────────────┘
                                          │
                 ┌────────────────────────┼────────────────────────┐
                 ▼                        ▼                        ▼
            execute action        consultReasoningModel      notifyHuman + wait
   inspect_logs / inspect_metrics   (optional slow LLM,      for humanDecision Signal
   check_recent_deploy              mocked without a key)    (durable, survives restarts)
   restart_service / rollback_deploy
   wait_and_observe (Temporal timer)
                 │                        │                        │
                 └────────────────────────┴────────────────────────┘
                                          │
                                  observe new state
                                          │
                                          ▼
                                    askJev() again …
```

The loop in `src/workflows/incident-response.ts`, condensed:

```ts
state.metrics = await getMetrics(...);
while (unresolved) {
  const judgment = await askJev(state);                 // Activity → TypeSafe API
  const { route, action, reason } = evaluatePolicy(judgment, policy);  // plain code
  decisions.push({ step, judgment, route, action, reason });           // in workflow state
  if (route === "reasoning_model") action = (await consultReasoningModel(...)).recommended_action;
  if (route === "human_approval")  { await notifyHuman(...); await condition(() => humanDecision); }
  await execute(action);                                // Activities with retry policies / timers
  state.metrics = await getMetrics(...);                // observe
}
```

### What each side owns

| Jev (TypeSafe) | Temporal |
| --- | --- |
| `next_action` — a **Choice** over the actions that make sense for the current state | Workflow state and the full decision/action history |
| `incident_severity` — a **Score** over four described severity levels | Activity execution, timeouts, and retry policies |
| `safe_to_act_autonomously` — a **Noul** (P(yes)) | Timers (`wait_and_observe` is a durable `sleep`) |
| `needs_deeper_reasoning` — a **Noul** (P(yes)) | Waiting for a human Signal without burning a process |
| Probabilities + confidence for every answer | Crash recovery: a killed worker resumes from history |

Jev never grants itself permission. All thresholds live in `src/policy.ts` and are trivially editable:

```ts
export const DEFAULT_POLICY = {
  minConfidence: 0.4,             // below this: consult the reasoning model
  disruptiveMinConfidence: 0.75,  // restart/rollback need this to run unattended
  disruptiveMinSafety: 0.7,       // ...and P(safe_to_act_autonomously) ≥ this
  deeperReasoningThreshold: 0.6,  // P(needs_deeper_reasoning) ≥ this → reasoning model (non-read-only actions)
  terminalMinConfidence: 0.7,     // "resolved" below this → keep observing instead
  alwaysRequireApproval: [],      // e.g. ["rollback_deploy"] to force a human gate
};
```

The Jev questions themselves are in `src/jev/questions.ts`. The state passed to Jev is the structured incident object (metrics, deploys, dependencies, actions taken and their results, human feedback) — not a prose prompt — and the option set for `next_action` is narrowed in code to actions the workflow can actually execute right now (no `rollback_deploy` before the deploy is known, none twice).

## Project layout

```text
src/
  workflows/incident-response.ts   the agent loop (Workflow, Signal, Query)
  activities/jev.ts                askJev → TypeSafe SDK (or heuristic mock)
  activities/infrastructure.ts     getMetrics, getLogs, getRecentDeploy, restartService, rollbackDeployment
  activities/human.ts              notifyHuman, consultReasoningModel
  jev/questions.ts                 the four Jev questions (Choice / Score / Noul / Noul)
  policy.ts                        thresholds → route (execute | reasoning_model | human_approval)
  simulation/incident-state.ts     deterministic mocked infrastructure
  worker.ts                        Temporal Worker + terminal event stream
  start-workflow.ts                start an incident
  human.ts                         approve / reject / status CLI
```

## Setup

Requirements: Node 20+, the [Temporal CLI](https://docs.temporal.io/cli#install) (`temporal` on your PATH), a TypeSafe API key (optional — see below).

```sh
git clone https://github.com/thenoahhein/jev-temporal-demo && cd jev-temporal-demo
npm install
cp .env.example .env        # add TYPESAFE_API_KEY=... (and optionally OPENAI_API_KEY)
```

Without `TYPESAFE_API_KEY` (or with `JEV_MOCK=1`) the `askJev` Activity uses a heuristic stand-in that is clearly labelled `(mock)` in the terminal. Without `OPENAI_API_KEY` the reasoning-model step is mocked. Everything else — Temporal, retries, the worker kill, human approval — is real either way.

Three terminals:

```sh
npm run temporal     # 1. Temporal dev server  (UI: http://localhost:8233)
npm run worker       # 2. the agent's Worker — this is the terminal you record
npm start            # 3. start an incident
```

Other commands:

```sh
npm start -- --scenario ambiguous                 # degraded DB + old deploy: Jev is less sure
npm start -- --require-approval rollback_deploy   # force the human gate on rollback
npm run approve                                   # approve the pending action (last started workflow)
npm run reject -- <workflowId> "why"              # reject it; Jev re-decides with your feedback
npm run status                                    # query the workflow's decision log
npm test && npm run typecheck
```

## Demo Script (60–90s)

Record terminal 2 (the worker) with the Temporal UI (`http://localhost:8233`) beside it. Every Activity name in the UI event history (`askJev`, `getRecentDeploy`, `rollbackDeployment`, `notifyHuman`, timers) reads as the story.

**1. Incident starts.** In terminal 3:

```sh
npm start -- --require-approval rollback_deploy
```

The worker prints `INCIDENT` (checkout-api, 18% errors, CPU/memory normal, dependencies healthy).

**2. Jev decides.** No rule says "deploy 7 minutes ago ⇒ rollback"; Jev reads the state and picks `CHECK_RECENT_DEPLOY` with its confidence and alternatives. Temporal runs `getRecentDeploy()`. With `v1.42.0 deployed 7 min before incident` now in the state, Jev's next answer is `ROLLBACK_DEPLOY`.

**3. Human approval is requested.** Because we passed `--require-approval rollback_deploy` (or, on a real run, because confidence/safety fell below the policy thresholds), the workflow prints `WAITING FOR HUMAN APPROVAL` and parks on a Signal. Show in the Temporal UI that the workflow is idle, consuming no worker. Then:

```sh
npm run approve
```

The *same* workflow continues.

**4. Activity fails and retries.** `rollbackDeployment()` throws a simulated network timeout on attempt 1 → `ACTIVITY FAILED` → `retrying activity (attempt 2)...` → `ROLLBACK COMPLETE`. Jev is not consulted again: it already said what should happen; Temporal makes sure it happens.

**5. Kill the worker.** Jev now chooses `WAIT_AND_OBSERVE` and the workflow sleeps for 20 seconds on a Temporal timer. In terminal 2 press `Ctrl-C` → `WORKER TERMINATED`. The agent process is gone. In the UI the workflow is still *Running*.

**6. Restart the worker.**

```sh
npm run worker
```

`WORKFLOW RESUMED` — the worker replays history and picks up exactly where it stopped: every Jev decision, the completed rollback, the pending timer. Nothing is re-executed (check the UI: one `rollbackDeployment`).

**7. Incident resolves.** New metrics come back near baseline; Jev answers `RESOLVE_INCIDENT` and the workflow completes: `INCIDENT RESOLVED`.

Run it again with `--scenario ambiguous` to see the escalation ladder without the forced gate: a degraded database with intermittent connection timeouts and no obvious culprit deploy make Jev's `safe_to_act_autonomously` lower and `needs_deeper_reasoning` higher, so the policy routes through `consultReasoningModel` and/or the human before anything disruptive runs.

## Why this shape

- **Jev is a primitive, not the agent.** One `systemOne` call answers four narrow questions in parallel over the same JSON state and returns calibrated probabilities. Code composes them.
- **Temporal is the runtime.** The `while` loop, the retries, the 20-second observation window and the wait for a human are all durable. Kill the process; the agent has not forgotten anything.
- **Pay for intelligence only when needed.** Read-only evidence gathering runs on Jev's answer alone. Disruptive actions need higher confidence and an explicit safety judgment; uncertain ones go to a slower reasoning model or a person — and the thresholds are yours to change.
