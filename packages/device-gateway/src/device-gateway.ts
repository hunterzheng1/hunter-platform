import {
  canonicalSha256,
  type DeviceId,
  type ProjectId,
} from "@hunter/domain";
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
  readonly authorization: DeviceCommandAuthorization;
}

export interface DeviceCommandAuthorization {
  authorize(
    command: MobileCommandEnvelope,
    principal: DeviceCommandPrincipal,
  ): void;
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
    try {
      return this.options.journal.runInImmediateTransaction(() => {
        authorize(command, principal);
        this.options.authorization.authorize(command, principal);
        return {
          status: "accepted",
          receipt: this.options.commands.handle(translate(command, principal)),
        };
      });
    } catch (error) {
      if (
        error instanceof Error
        && [
          "DEVICE_PROJECT_FORBIDDEN",
          "DEVICE_SCOPE_FORBIDDEN",
          "DEVICE_GATE_FORBIDDEN",
        ].includes(error.message)
      ) {
        this.recordAuthorizationDenial(command, principal, error.message);
      }
      throw error;
    }
  }

  private recordAuthorizationDenial(
    command: MobileCommandEnvelope,
    principal: DeviceCommandPrincipal,
    reasonCode: string,
  ): void {
    const decision = {
      schemaVersion: 1,
      decision: "deny" as const,
      reasonCode,
      action: command.action,
      deviceId: principal.deviceId,
      projectId: command.projectId,
      runId: command.runId,
      targetKind: "gateId" in command ? "gate" as const : "step" as const,
    };
    const fingerprint = canonicalSha256({
      ...decision,
      idempotencyKey: command.idempotencyKey,
      expectedVersion: command.expectedVersion,
    });
    const aggregateId = `device-permission-audit:${command.projectId}`;
    const occurredAt = new Date().toISOString();
    this.options.journal.commitCommand({
      commandId: `DevicePermissionDecision:${fingerprint}`,
      requestFingerprint: fingerprint,
      projectId: command.projectId,
      aggregateId,
      expectedVersion: this.options.journal.aggregateVersion(aggregateId),
      actor: {
        actorId: `device:${principal.deviceId}`,
        correlationId: command.idempotencyKey,
      },
      events: [{
        eventId: `evt_device_permission_${fingerprint.slice(0, 24)}`,
        eventType: "DevicePermissionDecisionRecorded",
        eventData: decision,
        schemaVersion: 1,
        occurredAt,
      }],
      operations: [],
      response: {
        status: "denied",
        reasonCode,
      },
    });
  }
}
