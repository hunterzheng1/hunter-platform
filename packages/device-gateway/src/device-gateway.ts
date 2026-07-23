import type { DeviceId, ProjectId } from "@hunter/domain";
import type {
  ApplyRunControlCommand,
  FlowCommandHandler,
} from "@hunter/flow-engine";
import type { SqliteOperationJournal } from "@hunter/storage";

import {
  MobileCommandEnvelopeSchema,
  type MobileCommandAction,
  type MobileCommandEnvelope,
  type MobileCommandResult,
  type MobileScope,
} from "./mobile-contracts.js";

export interface DeviceCommandPrincipal {
  readonly deviceId: DeviceId;
  readonly scopes: readonly MobileScope[];
  readonly projectIds: readonly ProjectId[];
  readonly roles?: readonly string[] | undefined;
}

export interface DeviceGatewayOptions {
  readonly journal: SqliteOperationJournal;
  readonly commands: FlowCommandHandler;
}

const REQUIRED_SCOPE: Readonly<Record<MobileCommandAction, MobileScope>> = {
  approve_gate: "gates:approve",
  reject_gate: "gates:approve",
  supplement_input: "runs:control",
  pause_run: "runs:control",
  resume_run: "runs:control",
  terminate_run: "runs:control",
};

function authorize(command: MobileCommandEnvelope, principal: DeviceCommandPrincipal): void {
  if (!principal.projectIds.includes(command.projectId)) {
    throw new Error("DEVICE_PROJECT_FORBIDDEN");
  }
  if (!principal.scopes.includes(REQUIRED_SCOPE[command.action])) {
    throw new Error("DEVICE_SCOPE_FORBIDDEN");
  }
}

function translate(
  command: MobileCommandEnvelope,
  principal: DeviceCommandPrincipal,
): ApplyRunControlCommand {
  const actor = {
    actorId: `device:${principal.deviceId}`,
    correlationId: command.idempotencyKey,
    roles: principal.roles
      ?? (principal.scopes.includes("gates:approve") ? ["project-approver"] : []),
  };
  const common = {
    type: "ApplyRunControl" as const,
    projectId: command.projectId,
    runId: command.runId,
    expectedVersion: command.expectedVersion,
    idempotencyKey: command.idempotencyKey,
    actor,
  };
  switch (command.action) {
    case "approve_gate":
      return {
        ...common,
        target: { kind: "gate", gateId: command.gateId },
        action: "approve",
        payload: command.payload,
      };
    case "reject_gate":
      return {
        ...common,
        target: { kind: "gate", gateId: command.gateId },
        action: "reject",
        payload: command.payload,
      };
    case "supplement_input":
      return {
        ...common,
        target: { kind: "step", stepRunId: command.stepRunId },
        action: "supplement",
        payload: command.payload,
      };
    case "pause_run":
      return {
        ...common,
        target: { kind: "step", stepRunId: command.stepRunId },
        action: "pause",
        payload: command.payload,
      };
    case "resume_run":
      return {
        ...common,
        target: { kind: "step", stepRunId: command.stepRunId },
        action: "resume",
        payload: command.payload,
      };
    case "terminate_run":
      return {
        ...common,
        target: { kind: "step", stepRunId: command.stepRunId },
        action: "terminate",
        payload: command.payload,
      };
  }
}

export class DeviceGateway {
  public constructor(private readonly options: DeviceGatewayOptions) {}

  public execute(candidate: unknown, principal: DeviceCommandPrincipal): MobileCommandResult {
    const command = MobileCommandEnvelopeSchema.parse(candidate);
    return this.options.journal.runInImmediateTransaction(() => {
      authorize(command, principal);
      return {
        status: "accepted",
        receipt: this.options.commands.handle(translate(command, principal)),
      };
    });
  }
}
