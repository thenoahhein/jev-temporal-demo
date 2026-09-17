import { Connection, Client } from "@temporalio/client";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { incidentResponseAgent } from "./workflows/incident-response";
import { banner, kv, section } from "./shared/console";
import { loadEnv } from "./shared/env";
import type { Action, IncidentWorkflowInput } from "./shared/types";

loadEnv();

function parseArgs(): IncidentWorkflowInput & { workflowId?: string } {
  const args = process.argv.slice(2);
  const input: IncidentWorkflowInput & { workflowId?: string } = {
    incidentId: "",
    scenario: "deploy_regression",
    policy: {},
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--scenario":
        input.scenario = args[++i] as IncidentWorkflowInput["scenario"];
        break;
      case "--require-approval":
        input.policy!.alwaysRequireApproval = args[++i].split(",") as Action[];
        break;
      case "--id":
        input.workflowId = args[++i];
        break;
      case "--incident":
        input.incidentId = args[++i];
        break;
    }
  }
  return input;
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

async function main(): Promise<void> {
  const input = parseArgs();
  const workflowId = input.workflowId ?? `incident-checkout-api-${stamp()}`;
  input.incidentId = input.incidentId || `INC-${stamp()}`;
  delete input.workflowId;

  const connection = await Connection.connect({ address: "localhost:7233" });
  const client = new Client({ connection });

  const handle = await client.workflow.start(incidentResponseAgent, {
    taskQueue: "incident-response",
    workflowId,
    args: [input],
  });

  mkdirSync(resolve(process.cwd(), ".demo"), { recursive: true });
  writeFileSync(resolve(process.cwd(), ".demo/last-workflow-id"), workflowId);

  section(
    "WORKFLOW STARTED",
    kv("id", workflowId),
    kv("scenario", input.scenario),
    kv("ui", `http://localhost:8233/namespaces/default/workflows/${workflowId}`),
  );

  const status = await handle.result();
  if (status.phase === "resolved") {
    banner(`INCIDENT RESOLVED in ${status.step} steps`, "green");
  } else {
    banner(`WORKFLOW ENDED: ${status.phase.toUpperCase()} after ${status.step} steps`);
  }
  console.log(
    "actions taken:",
    status.state.actions_taken.map((a) => a.action).join(" → "),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
