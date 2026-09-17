import { banner, kv, section } from "./console";

// Workflow ids this worker process has already handled an event for.
// The first observation of a workflowId that isn't that workflow's own
// `incident_started` event means Temporal replayed history from a dead worker.
const seenWorkflows = new Set<string>();

/**
 * Record a sighting of workflowId. Returns true exactly once per process, the
 * first time a workflow is seen via a non-start observation — i.e. a resume.
 */
export function noteWorkflowSeen(workflowId: string, isStart: boolean): boolean {
  const resumed = !isStart && !seenWorkflows.has(workflowId);
  seenWorkflows.add(workflowId);
  return resumed;
}

/** Prints the WORKFLOW RESUMED banner the first time a resumed workflow is observed. */
export function announceIfResumed(workflowId: string, isStart: boolean): void {
  if (!noteWorkflowSeen(workflowId, isStart)) return;
  banner("WORKFLOW RESUMED");
  section(
    "RECOVERED",
    kv("id", workflowId),
    "recovered from Temporal history — Jev decisions, completed actions and pending timer intact",
  );
}
