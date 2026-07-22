import type { ExternalObservation } from "./commands.js";
import type { ExecutionStatus, RunStatus } from "./events.js";

const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  assigned: ["running", "returned", "failed", "canceled", "stale"],
  running: ["waiting_input", "returned", "failed", "canceled", "stale"],
  waiting_input: ["running", "returned", "failed", "canceled", "stale"],
  returned: [],
  failed: [],
  canceled: [],
  stale: ["running", "needs_attention"],
  needs_attention: [],
};

export function canTransitionExecution(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return from === to || EXECUTION_TRANSITIONS[from].includes(to);
}

export function externalObservationCanSucceed(fact: ExternalObservation): false {
  void fact;
  return false;
}

export function isTerminalRun(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}
