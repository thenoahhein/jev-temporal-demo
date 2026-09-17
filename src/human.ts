import { Connection, Client } from "@temporalio/client";
import { readFileSync } from "fs";
import { resolve } from "path";
import { humanDecisionSignal, statusQuery } from "./workflows/incident-response";
import { kv, section } from "./shared/console";
import { loadEnv } from "./shared/env";

loadEnv();

function lastId(): string {
  try {
    return readFileSync(resolve(process.cwd(), ".demo/last-workflow-id"), "utf8").trim();
  } catch {
    console.error("no .demo/last-workflow-id — pass a workflow id explicitly");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const [cmd, idArg, ...rest] = process.argv.slice(2);
  const workflowId = idArg || lastId();
  const note = rest.join(" ") || undefined;

  const connection = await Connection.connect({ address: "localhost:7233" });
  const client = new Client({ connection });
  const handle = client.workflow.getHandle(workflowId);

  switch (cmd) {
    case "approve":
      await handle.signal(humanDecisionSignal, { approved: true, note });
      section("SIGNAL SENT", kv("workflow", workflowId), kv("decision", "APPROVED"));
      break;
    case "reject":
      await handle.signal(humanDecisionSignal, { approved: false, note });
      section("SIGNAL SENT", kv("workflow", workflowId), kv("decision", "REJECTED"));
      break;
    case "status": {
      const s = await handle.query(statusQuery);
      section(
        "STATUS",
        kv("phase", s.phase),
        kv("step", String(s.step)),
        kv("pending action", s.pendingAction ?? "—"),
        kv("error rate", s.state.metrics ? `${(s.state.metrics.error_rate * 100).toFixed(1)}%` : "unknown"),
      );
      for (const d of s.decisions) {
        section(
          `STEP ${d.step}`,
          kv("action", d.judgment.next_action.choice),
          kv("confidence", `${Math.round(d.judgment.next_action.confidence * 100)}%`),
          kv("route", `${d.route} — ${d.reason}`),
        );
      }
      break;
    }
    default:
      console.error("usage: human.ts approve|reject|status [workflowId] [note]");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
