import type { RunId } from "@hunter/domain";
import type { ExternalOperation } from "@hunter/runtime-contracts";

import type { WorkflowRunBinding } from "./run-binding.js";

export interface FlowActorContext {
  readonly actorId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly roles?: readonly string[] | undefined;
}

export interface StartRunCommand {
  readonly type: "StartRun";
  readonly binding: WorkflowRunBinding;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly actor: FlowActorContext;
}

export interface ExistingRunCommand {
  readonly runId: RunId;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly actor: FlowActorContext;
}

export type ExternalObservation =
  | "agent_returned"
  | "process_exited"
  | "terminal_idle"
  | "native_surface_opened";

export interface RecordExternalObservationCommand extends ExistingRunCommand {
  readonly type: "RecordExternalObservation";
  readonly fact: ExternalObservation;
}

export interface RecordVerifierResultCommand extends ExistingRunCommand {
  readonly type: "RecordVerifierResult";
  readonly outcome: "passed" | "failed" | "error" | "needs_human";
  readonly evidenceFingerprint: string;
  readonly failureFingerprint?: string | undefined;
  readonly diffFingerprint?: string | undefined;
  readonly humanReceipt?:
    | {
        readonly contentHash: string;
        readonly actorId: string;
      }
    | undefined;
}

export interface RecordTimeoutCommand extends ExistingRunCommand {
  readonly type: "RecordTimeout";
}

export interface CancelRunCommand extends ExistingRunCommand {
  readonly type: "CancelRun";
}

export interface RecordRecoveryFactsCommand extends ExistingRunCommand {
  readonly type: "RecordRecoveryFacts";
  readonly facts: readonly {
    readonly kind: string;
    readonly status: "indeterminate" | "needs_attention";
    readonly reason: string;
  }[];
}

export interface AssignAttemptCommand extends ExistingRunCommand {
  readonly type: "AssignAttempt";
  readonly operation: ExternalOperation;
  readonly capabilityProbeReceiptId: string;
  readonly leaseIds: readonly string[];
}

export type FlowCommand =
  | StartRunCommand
  | RecordExternalObservationCommand
  | RecordVerifierResultCommand
  | RecordTimeoutCommand
  | CancelRunCommand
  | RecordRecoveryFactsCommand
  | AssignAttemptCommand;

export interface FlowCommandReceipt {
  readonly commandId: string;
  readonly response: unknown;
}

export interface FlowCommandHandler {
  handle(command: FlowCommand): FlowCommandReceipt;
}
