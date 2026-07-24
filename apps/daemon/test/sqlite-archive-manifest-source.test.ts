import {
  AttemptIdSchema,
  CapabilityProbeReceiptIdSchema,
  ControllerLeaseIdSchema,
  DeviceBindingIdSchema,
  DeviceIdSchema,
  EvidenceIdSchema,
  ExecutionPlanIdSchema,
  LeaseOwnerIdSchema,
  NativeSessionIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
  RuntimeProviderIdSchema,
  StepIdSchema,
  StepRunIdSchema,
  WorkflowIdSchema,
  WorkflowRevisionIdSchema,
  WorkspaceIdSchema,
  WorkspaceLeaseIdSchema,
  WorktreeIdSchema,
  WriterLeaseIdSchema,
} from "@hunter/domain";
import {
  ExternalOperationReceiptSchema,
  LeaseSchema,
  createExternalOperation,
} from "@hunter/runtime-contracts";
import { describe, expect, it } from "vitest";

import { SqliteArchiveManifestSource } from "../src/services/sqlite-archive-manifest-source.js";

const ids = {
  project: ProjectIdSchema.parse("prj_archive_source"),
  run: RunIdSchema.parse("run_archive_source"),
  repository: RepositoryIdSchema.parse("rep_archive_source"),
  deviceBinding: DeviceBindingIdSchema.parse("dev_archive_source"),
  device: DeviceIdSchema.parse("dvc_archive_source"),
  workflow: WorkflowIdSchema.parse("wfl_archive_source"),
  workflowRevision: WorkflowRevisionIdSchema.parse("wfr_archive_source"),
  requirement: RequirementRevisionIdSchema.parse("rrv_archive_source"),
  plan: ExecutionPlanIdSchema.parse("epl_archive_source"),
  step: StepIdSchema.parse("stp_archive_source"),
  stepRun: StepRunIdSchema.parse("spr_archive_source"),
  owner: LeaseOwnerIdSchema.parse("own_archive_source"),
  workspace: WorkspaceIdSchema.parse("wsp_archive_source"),
  worktree: WorktreeIdSchema.parse("wtr_archive_source"),
};

function attempt(index: number, verificationEvidenceFingerprint?: string) {
  const attemptId = AttemptIdSchema.parse(`att_archive_source${index}`);
  const operation = createExternalOperation({
    schemaVersion: 1,
    operationId: OperationIdSchema.parse(`opn_archive_source${index}`),
    projectId: ids.project,
    runId: ids.run,
    attemptId,
    operationVersion: 1,
    operationType: "session.launch",
    requestedCapabilities: ["launch"],
    payload: {
      agentProfileId: "apr_archive_source",
      workspaceId: ids.workspace,
    },
  });
  const launchEvidenceHash = String(index).repeat(64);
  const receipt = ExternalOperationReceiptSchema.parse({
    schemaVersion: 1,
    operationId: operation.operationId,
    fingerprint: operation.fingerprint,
    operationStatus: "completed",
    subject: {
      kind: "provider",
      providerId: RuntimeProviderIdSchema.parse("rtp_archive_source"),
      implementationVersion: "test",
    },
    nativeReferences: [{
      kind: "session",
      referenceId: NativeSessionIdSchema.parse(
        `ses_archive_source${index}`,
      ),
    }],
    facts: [{ kind: "operation_accepted" }],
    evidence: {
      evidenceId: EvidenceIdSchema.parse(`evd_archive_launch${index}`),
      evidenceHash: launchEvidenceHash,
      proofScope: "local_observation",
    },
    observedAt: "2026-07-24T04:00:00.000Z",
  });
  return {
    state: {
      attemptId,
      attemptNumber: index,
      executionStatus: "returned",
      verificationStatus: index === 1 ? "failed" : "passed",
      ...(verificationEvidenceFingerprint === undefined
        ? {}
        : { verificationEvidenceFingerprint }),
      assignment: {
        operationId: operation.operationId,
        capabilityProbeReceiptId:
          CapabilityProbeReceiptIdSchema.parse(
            `cpr_archive_source${index}`,
          ),
        leaseIds: [],
      },
    },
    operation,
    receipt,
    launchEvidenceHash,
  };
}

function lease(kind: "workspace" | "writer" | "controller") {
  const common = {
    schemaVersion: 2,
    projectId: ids.project,
    repositoryId: ids.repository,
    deviceBindingId: ids.deviceBinding,
    canonicalWorkspaceKey: "win32:c:\\hunter\\archive-source",
    gitHead: "a".repeat(40),
    branch: "codex/archive-source",
    ownerRunId: ids.run,
    ownerAttemptId: AttemptIdSchema.parse("att_archive_source2"),
    ownerId: ids.owner,
    generation: 1,
    mode: "write",
    acquiredAt: "2026-07-24T03:00:00.000Z",
    expiresAt: "2026-07-24T05:00:00.000Z",
    revokedAt: null,
    revocationReason: null,
  };
  return LeaseSchema.parse(kind === "workspace"
    ? {
        ...common,
        kind,
        leaseId: WorkspaceLeaseIdSchema.parse("wsl_archive_source"),
        scope: { workspaceId: ids.workspace },
      }
    : kind === "writer"
      ? {
          ...common,
          kind,
          leaseId: WriterLeaseIdSchema.parse("wrl_archive_source"),
          scope: {
            workspaceId: ids.workspace,
            worktreeId: ids.worktree,
          },
        }
      : {
          ...common,
          kind,
          leaseId: ControllerLeaseIdSchema.parse("ctl_archive_source"),
          scope: {
            workspaceId: ids.workspace,
            worktreeId: ids.worktree,
            nativeSessionId:
              NativeSessionIdSchema.parse("ses_archive_source2"),
          },
        });
}

function sourceFor(
  outcome: "succeeded" | "failed",
  attempts: readonly ReturnType<typeof attempt>[],
) {
  const run = {
    binding: {
      runId: ids.run,
      projectId: ids.project,
      changeRevisionId: "crv_archive_source",
      requirementRevisionIds: [ids.requirement],
      workflowRevisionId: ids.workflowRevision,
      executionPlanId: ids.plan,
      subjectKind: "change",
      parentRunId: null,
      taskId: null,
    },
    status: outcome,
    steps: [{
      stepRunId: ids.stepRun,
      stepId: ids.step,
      attempts: attempts.map(({ state }) => state),
    }],
  };
  const operations = new Map(attempts.map(({ operation, receipt }) => [
    operation.operationId,
    { operation, receipt },
  ]));
  const services = {
    flowStore: {
      loadRun: () => run,
      childRuns: () => [],
    },
    leaseService: {
      listRecorded: () => [
        lease("workspace"),
        lease("writer"),
        lease("controller"),
      ],
    },
    repositories: {
      getProject: () => ({
        projectId: ids.project,
        name: "Archive",
        repositoryBindings: [{
          repositoryId: ids.repository,
          role: "primary",
        }],
        deviceBindings: [{
          deviceBindingId: ids.deviceBinding,
          deviceId: ids.device,
          repositoryId: ids.repository,
          localPath: "C:\\hunter\\archive-source",
          availability: "available",
        }],
      }),
      getChangeRevision: () => ({
        changeId: "chg_archive_source",
        revisionId: "crv_archive_source",
      }),
      getWorkflowRevision: () => ({
        workflowId: ids.workflow,
        workflowRevisionId: ids.workflowRevision,
        steps: [{
          stepId: ids.step,
          agentProfileSelector: {
            agentProfileIds: ["apr_archive_source"],
          },
        }],
      }),
    },
    journal: {
      findOperation: (operationId: string) => {
        const record = operations.get(OperationIdSchema.parse(operationId));
        return record === undefined
          ? null
          : { operation: record.operation, status: "completed" };
      },
    },
    operationWorker: {
      resolveReceipt: (operation: { readonly operationId: string }) =>
        operations.get(
          OperationIdSchema.parse(operation.operationId),
        )?.receipt ?? null,
    },
  };
  return new SqliteArchiveManifestSource(
    services as unknown as ConstructorParameters<
      typeof SqliteArchiveManifestSource
    >[0],
    () => new Date("2026-07-24T04:30:00.000Z"),
  );
}

function job(outcome: "succeeded" | "failed") {
  return {
    jobId: OperationIdSchema.parse("opn_archive_jobsource"),
    projectId: ids.project,
    runId: ids.run,
    outcome,
    attempt: 1,
    ownerId: ids.owner,
    generation: 1,
    acquiredAt: "2026-07-24T04:00:00.000Z",
    expiresAt: "2026-07-24T05:00:00.000Z",
    leaseTokenHash: "b".repeat(64),
    inputFingerprint: "c".repeat(64),
    firstPosition: 1,
    lastPosition: 10,
    actorId: "archive-test",
    correlationId: "archive-test",
    occurredAt: "2026-07-24T04:00:00.000Z",
    receipt: null,
  };
}

describe("SQLite Archive manifest source", () => {
  it.each(["succeeded", "failed"] as const)(
    "archives verifier evidence for a %s Run and preserves retry history",
    (outcome) => {
      const firstVerifierHash = "e".repeat(64);
      const finalVerifierHash = "f".repeat(64);
      const first = attempt(1, firstVerifierHash);
      const final = attempt(2, finalVerifierHash);

      const manifest = sourceFor(outcome, [first, final]).build(job(outcome));
      const archivedAttempts = manifest.runGraph.runs[0]!.steps[0]!.attempts;

      expect(archivedAttempts.map(({ evidence }) =>
        evidence[0]!.contentHash
      )).toEqual([firstVerifierHash, finalVerifierHash]);
      expect(JSON.stringify(manifest)).not.toContain(
        first.launchEvidenceHash,
      );
      expect(JSON.stringify(manifest)).not.toContain(
        final.launchEvidenceHash,
      );
    },
  );

  it("fails closed when durable verifier evidence is missing", () => {
    const unverified = attempt(1);

    expect(() => sourceFor("succeeded", [unverified]).build(
      job("succeeded"),
    )).toThrow("ARCHIVE_VERIFICATION_EVIDENCE_MISSING");
  });
});
