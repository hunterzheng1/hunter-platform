import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AgentProfileIdSchema,
  AttemptIdSchema,
  CapabilityProbeReceiptIdSchema,
  ConnectorIdSchema,
  ControllerLeaseIdSchema,
  DeviceBindingIdSchema,
  EvidenceIdSchema,
  LeaseOwnerIdSchema,
  NativeSessionIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
  WorkspaceIdSchema,
  WorkspaceLeaseIdSchema,
  WorktreeIdSchema,
  WriterLeaseIdSchema,
} from "@hunter/domain";
import {
  CanonicalWorkspaceKeySchema,
  CapabilityProbeReceiptSchema,
  ControllerLeaseSchema,
  WorkspaceLeaseSchema,
  WriterLeaseSchema,
  createExternalOperation,
  deriveCapabilityLevel,
  runtimeFactCanCompleteStep,
} from "./index.js";

const ids = {
  projectId: ProjectIdSchema.parse("prj_00000001"),
  runId: RunIdSchema.parse("run_00000001"),
  attemptId: AttemptIdSchema.parse("att_00000001"),
  operationId: OperationIdSchema.parse("opn_00000001"),
  evidenceId: EvidenceIdSchema.parse("evd_00000001"),
};

const levelThreeCapabilities = [
  "discover",
  "workspace_targeting",
  "native_surface",
  "observe",
  "artifact_export",
  "launch",
  "send",
  "interrupt",
  "structured_events",
  "permission_events",
  "resume",
  "completion_receipt",
] as const;

function capabilityReceipt(implementationId: string) {
  return CapabilityProbeReceiptSchema.parse({
    schemaVersion: 1,
    probeReceiptId: CapabilityProbeReceiptIdSchema.parse("cpr_00000001"),
    subject: {
      kind: "connector",
      connectorId: ConnectorIdSchema.parse(implementationId),
      implementationVersion: "1.0.0",
    },
    platform: "windows",
    observedAt: "2026-07-21T00:00:00.000Z",
    validUntil: "2026-07-22T00:00:00.000Z",
    results: levelThreeCapabilities.map((capability, index) => ({
      capability,
      status: "SUPPORTED",
      evidenceId: EvidenceIdSchema.parse(`evd_0000000${(index % 9) + 1}`),
      evidenceHash: "a".repeat(64),
    })),
  });
}

describe("provider-neutral runtime contracts", () => {
  it("derives levels only from valid atomic probe receipts", () => {
    const first = capabilityReceipt("con_00000001");
    const second = capabilityReceipt("con_00000002");

    expect(deriveCapabilityLevel(first, new Date("2026-07-21T12:00:00.000Z"))).toBe(
      "L3",
    );
    expect(deriveCapabilityLevel(second, new Date("2026-07-21T12:00:00.000Z"))).toBe(
      "L3",
    );
    expect(deriveCapabilityLevel(first, new Date("2026-07-23T00:00:00.000Z"))).toBe(
      "NONE",
    );
  });

  it("creates a strict versioned operation without arbitrary private fields", () => {
    const operation = createExternalOperation({
      schemaVersion: 1,
      operationId: ids.operationId,
      projectId: ids.projectId,
      runId: ids.runId,
      attemptId: ids.attemptId,
      operationVersion: 1,
      operationType: "session.launch",
      requestedCapabilities: ["launch", "structured_events"],
      payload: {
        agentProfileId: AgentProfileIdSchema.parse("apr_00000001"),
        workspaceId: WorkspaceIdSchema.parse("wsp_00000001"),
      },
    });

    expect(operation.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      createExternalOperation({
        ...Object.fromEntries(
          Object.entries(operation).filter(([key]) => key !== "fingerprint"),
        ),
        payload: { ...operation.payload, terminalWindowTitle: "private" },
      }),
    ).toThrow();
  });

  it("binds every session control operation to an exact ControllerLease generation", () => {
    const common = {
      schemaVersion: 1 as const,
      projectId: ids.projectId,
      runId: ids.runId,
      attemptId: ids.attemptId,
      operationVersion: 2 as const,
      requestedCapabilities: ["interrupt"] as const,
      operationType: "session.interrupt" as const,
    };
    const payload = {
      nativeSessionId: NativeSessionIdSchema.parse("ses_00000001"),
      reason: "cancel requested",
      controllerLeaseId: ControllerLeaseIdSchema.parse("ctl_00000001"),
      controllerLeaseOwnerId: LeaseOwnerIdSchema.parse("own_00000001"),
      controllerLeaseGeneration: 3,
    };
    expect(createExternalOperation({ ...common, operationId: OperationIdSchema.parse("opn_control001"), payload }).payload).toEqual(payload);
    expect(() => createExternalOperation({ ...common, operationId: OperationIdSchema.parse("opn_control002"), payload: { nativeSessionId: payload.nativeSessionId, reason: payload.reason } })).toThrow();
    expect(createExternalOperation({ ...common, operationVersion: 1, operationId: OperationIdSchema.parse("opn_control003"), payload: { nativeSessionId: payload.nativeSessionId, reason: payload.reason } }).operationVersion).toBe(1);
  });

  it("freezes workspace, writer, and controller lease scopes", () => {
    const common = {
      schemaVersion: 2,
      projectId: ids.projectId,
      repositoryId: RepositoryIdSchema.parse("rep_00000001"),
      deviceBindingId: DeviceBindingIdSchema.parse("dev_00000001"),
      canonicalWorkspaceKey: CanonicalWorkspaceKeySchema.parse("posix:/fixtures/worktree"),
      gitHead: "a".repeat(40),
      branch: "codex/task14-contracts",
      ownerRunId: ids.runId,
      ownerAttemptId: ids.attemptId,
      ownerId: LeaseOwnerIdSchema.parse("own_00000001"),
      generation: 1,
      mode: "write",
      acquiredAt: "2026-07-21T00:00:00.000Z",
      expiresAt: "2026-07-21T00:05:00.000Z",
      revokedAt: null,
      revocationReason: null,
    };

    expect(
      WorkspaceLeaseSchema.parse({
        ...common,
        kind: "workspace",
        leaseId: WorkspaceLeaseIdSchema.parse("wsl_00000001"),
        scope: {
          workspaceId: WorkspaceIdSchema.parse("wsp_00000001"),
        },
      }).kind,
    ).toBe("workspace");
    expect(
      WriterLeaseSchema.parse({
        ...common,
        kind: "writer",
        leaseId: WriterLeaseIdSchema.parse("wrl_00000001"),
        scope: {
          workspaceId: WorkspaceIdSchema.parse("wsp_00000001"),
          worktreeId: WorktreeIdSchema.parse("wtr_00000001"),
        },
      }).kind,
    ).toBe("writer");
    expect(
      ControllerLeaseSchema.parse({
        ...common,
        kind: "controller",
        leaseId: ControllerLeaseIdSchema.parse("ctl_00000001"),
        scope: {
          workspaceId: WorkspaceIdSchema.parse("wsp_00000001"),
          worktreeId: WorktreeIdSchema.parse("wtr_00000001"),
          nativeSessionId: NativeSessionIdSchema.parse("ses_00000001"),
        },
      }).kind,
    ).toBe("controller");
  });

  it("never treats external observations as step success", () => {
    expect(runtimeFactCanCompleteStep({ kind: "agent_returned" })).toBe(false);
    expect(runtimeFactCanCompleteStep({ kind: "process_exited", exitCode: 0 })).toBe(false);
    expect(runtimeFactCanCompleteStep({ kind: "terminal_idle" })).toBe(false);
    expect(runtimeFactCanCompleteStep({ kind: "native_surface_opened" })).toBe(false);
  });

  it("keeps product-specific vocabulary out of public source contracts", async () => {
    const sourceDirectory = dirname(fileURLToPath(import.meta.url));
    const files = (await readdir(sourceDirectory)).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );
    const source = (
      await Promise.all(files.map(async (file) => await readFile(join(sourceDirectory, file), "utf8")))
    ).join("\n");

    expect(source).not.toMatch(/orca|codex|codebuddy|cursor|goose/iu);
  });
});
