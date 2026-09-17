import { Context } from "@temporalio/activity";
import {
  DefaultLogger,
  NativeConnection,
  Runtime,
  Worker,
  type ActivityInboundCallsInterceptor,
  type ActivityExecuteInput,
} from "@temporalio/worker";
import * as infra from "./activities/infrastructure";
import * as jev from "./activities/jev";
import * as human from "./activities/human";
import { banner, kv, section } from "./shared/console";
import { announceIfResumed } from "./shared/resume-tracker";
import { loadEnv } from "./shared/env";
import type { IncidentWorkflowInput } from "./shared/types";

loadEnv();
Runtime.install({ logger: new DefaultLogger("ERROR") });

export const TASK_QUEUE = "incident-response";

// Prints the WORKFLOW RESUMED banner before the first activity execution of a
// workflow this worker process hasn't seen — beats the sink to it on resumes.
class ResumeAnnounceInterceptor implements ActivityInboundCallsInterceptor {
  async execute(input: ActivityExecuteInput, next: (input: ActivityExecuteInput) => Promise<unknown>) {
    const wfId = Context.current().info.workflowExecution?.workflowId;
    if (wfId) announceIfResumed(wfId, false);
    return next(input);
  }
}

async function run(): Promise<void> {
  const connection = await NativeConnection.connect({ address: "localhost:7233" });

  const worker = await Worker.create({
    connection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("./workflows/incident-response"),
    activities: { ...infra, ...jev, ...human },
    interceptors: {
      activityInbound: [() => new ResumeAnnounceInterceptor()],
    },
    sinks: {
      demo: {
        event: {
          fn(info: { workflowId: string }, kind: string, payload: unknown): void {
            const p = payload as Record<string, unknown>;
            announceIfResumed(info.workflowId, kind === "incident_started");
            switch (kind) {
              case "incident_started":
                banner(`INCIDENT ${p.incidentId}`);
                section(
                  "INCIDENT",
                  kv("scenario", String(p.scenario)),
                  kv("symptoms", (p.symptoms as string[]).join(", ")),
                );
                break;
              case "decision":
                section("POLICY", kv("route", `${p.route} (${p.reason})`));
                break;
              case "executing":
                section("TEMPORAL", `→ executing ${p.action}`);
                break;
              case "action_done":
                section(
                  "RESULT",
                  kv("action", String(p.action)),
                  kv("result", String(p.result)),
                  kv("error_rate", `${((p.error_rate as number) * 100).toFixed(1)}%`),
                );
                break;
              case "human_approved":
                section("HUMAN", `approved ${p.action} — resuming`);
                break;
              case "human_rejected":
                section("HUMAN", `rejected ${p.action} — asking Jev again`);
                break;
              case "incident_resolved":
                banner(`INCIDENT RESOLVED in ${p.steps} steps`, "green");
                break;
            }
          },
          callDuringReplay: false,
        },
      },
    },
  });

  console.log(
    `\nWORKER STARTED  task queue: ${TASK_QUEUE}  (pid ${process.pid})` +
      (process.env.JEV_MOCK === "1" || !process.env.TYPESAFE_API_KEY ? "  [JEV_MOCK]" : "  [JEV LIVE]") +
      "\n",
  );

  const shutdown = () => {
    banner("WORKER TERMINATED", "red");
    worker.shutdown();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await worker.run();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

export type { IncidentWorkflowInput };
