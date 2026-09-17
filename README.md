# Durable AI decision loops with Temporal + Jev

> Jev makes fast semantic decisions over application state; Temporal durably executes those decisions across tools, failures, time, and human intervention.

**Jev decides. Temporal executes durably.**

## What this demo shows

Most AI agents today are a `while` loop inside an LLM call: the model holds the plan in its context, calls tools, and if the process dies or a tool flakes, the whole thing starts over (or silently forgets). This repo shows the alternative — **put the loop in Temporal and use Jev for the decisions.**

The example is an autonomous **incident-response agent**. `checkout-api` starts throwing 18% errors. Every iteration the Temporal Workflow gathers structured state (metrics, recent deploys, dependency health, actions already taken), asks Jev *"given all of this, what should we do next?"*, applies a plain-code safety policy, executes the chosen action as a Temporal Activity, observes, and repeats until the incident is resolved or a human takes over.

Three things happen on screen that are hard to get any other way:

1. **Jev decides, in typed form.** No rule says "deploy 7 minutes ago ⇒ rollback". Jev looks at the state and returns `next_action: check_recent_deploy` (61%), then `rollback_deploy` (75%) — plus a severity Score and two Noul probabilities (`safe_to_act_autonomously`, `needs_deeper_reasoning`) that ordinary code turns into *execute / consult a reasoning model / ask a human*.
2. **Infrastructure fails; Temporal handles it.** The rollback Activity times out on attempt 1. Temporal retries it. Jev is not asked again — it already said what should happen.
3. **The agent process dies; nothing is lost.** The worker is killed mid-incident and restarted. The Workflow resumes from Temporal history with every Jev decision, the completed rollback, and the pending timer intact, then finishes the job.

Along the way a human-approval gate parks the workflow on a durable Signal until someone runs `npm run approve` — the same workflow then continues.

Jev ([TypeSafe](https://typesafe.ai)'s System One model) is called inside the loop as an ordinary Activity that returns **typed judgments with probabilities**, not prose. There is no LLM holding the agent loop in memory.

```text
Temporal = durable agent runtime
Jev      = fast semantic decision primitive
LLM      = optional deep reasoning primitive
Tools    = actions
Human    = escalation
```

## Architecture

Everything inside the box is one Temporal Workflow (`incidentResponseAgent`). Each arrow out of the box is an Activity — the only place I/O happens. The loop runs until the incident is resolved or handed off.

```text
 ┌─ Temporal Workflow ─────────────────────────────────────────────────────────┐
 │                                                                             │
 │   1. gather state ──────────────────────────► getMetrics / getLogs /        │
 │        incident, metrics, deploys,             getRecentDeploy  (Activities)│
 │        dependencies, actions taken                                          │
 │                │                                                            │
 │                ▼                                                            │
 │   2. ask Jev ───────────────────────────────► askJev  (Activity → TypeSafe) │
 │        next_action              : Choice     returns typed answers          │
 │        incident_severity        : Score      + probabilities + confidence   │
 │        safe_to_act_autonomously : Noul                                      │
 │        needs_deeper_reasoning   : Noul                                      │
 │                │                                                            │
 │                ▼                                                            │
 │   3. policy (plain TypeScript, src/policy.ts)                               │
 │        risk class of the action × Jev's confidence & safety → one route     │
 │                │                                                            │
 │        ┌───────┴────────────┬─────────────────────────┐                     │
 │        ▼                    ▼                         ▼                     │
 │     execute      consult reasoning model      wait for a human              │
 │        │         (consultReasoningModel:      (notifyHuman, then park on    │
 │        │          optional LLM, mocked         the humanDecision Signal —   │
 │        │          without a key)               durable, survives restarts)  │
 │        │                    │                         │                     │
 │        └────────────────────┴─────────────────────────┘                     │
 │                │                                                            │
 │                ▼                                                            │
 │   4. run the action ────────────────────────► restartService /              │
 │        retried by Temporal on failure;         rollbackDeployment /         │
 │        wait_and_observe = durable timer        getLogs … (Activities)       │
 │                │                                                            │
 │                ▼                                                            │
 │   5. observe ───────────────────────────────► getMetrics  (Activity)        │
 │        record result in workflow state                                      │
 │                │                                                            │
 │                └──────────────► back to 2, until resolve_incident           │
 │                                                                             │
 └─────────────────────────────────────────────────────────────────────────────┘

 Temporal keeps every state snapshot, Jev answer, action result, pending timer
 and Signal in history. Kill the worker at any point; the loop resumes there.
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
