import {
  AgentProfileIdSchema,
  ChangeIdSchema,
  EvidenceIdSchema,
  OperationIdSchema,
  canonicalSha256,
} from "@hunter/domain";
import {
  ArchiveManifestInputSchema,
  type ArchiveManifestSource,
  type LeasedArchiveJob,
} from "@hunter/knowledge";
import type { Lease } from "@hunter/runtime-contracts";

import type { createApplicationComposition } from "./composition-root.js";

type CompositionServices = ReturnType<
  typeof createApplicationComposition
>["services"];

export class SqliteArchiveManifestSource implements ArchiveManifestSource {
  public constructor(
    private readonly services: CompositionServices,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public build(job: LeasedArchiveJob) {
    const root = this.services.flowStore.loadRun(job.runId);
    if (root === null) throw new Error("ARCHIVE_RUN_MISSING");
    if (root.binding.projectId !== job.projectId) {
      throw new Error("ARCHIVE_RUN_PROJECT_MISMATCH");
    }
    const runs = [root];
    for (let index = 0; index < runs.length; index += 1) {
      for (const child of this.services.flowStore.childRuns(
        runs[index]!.binding.runId,
      )) {
        if (!runs.some(({ binding }) =>
          binding.runId === child.binding.runId
        )) {
          runs.push(child);
        }
      }
    }
    const runIds = new Set(runs.map(({ binding }) => binding.runId));
    const leases = this.services.leaseService.listRecorded().filter(
      (lease) =>
        lease.projectId === job.projectId
        && runIds.has(lease.ownerRunId),
    );
    const workspace = leases.filter(
      (lease): lease is Extract<Lease, { kind: "workspace" }> =>
        lease.kind === "workspace",
    ).map((lease) => ({ ...lease, receiptHash: canonicalSha256(lease) }));
    const writer = leases.filter(
      (lease): lease is Extract<Lease, { kind: "writer" }> =>
        lease.kind === "writer",
    ).map((lease) => ({ ...lease, receiptHash: canonicalSha256(lease) }));
    const controller = leases.filter(
      (lease): lease is Extract<Lease, { kind: "controller" }> =>
        lease.kind === "controller",
    ).map((lease) => ({ ...lease, receiptHash: canonicalSha256(lease) }));
    if (
      workspace.length === 0
      || writer.length === 0
      || controller.length === 0
    ) {
      throw new Error("ARCHIVE_LEASE_PROVENANCE_MISSING");
    }
    const project = this.services.repositories.getProject(job.projectId);
    if (project === null) throw new Error("ARCHIVE_PROJECT_MISSING");
    const change = this.services.repositories.getChangeRevision(
      root.binding.changeRevisionId,
    );
    if (change === null) throw new Error("ARCHIVE_CHANGE_MISSING");
    const workflow = this.services.repositories.getWorkflowRevision(
      root.binding.workflowRevisionId,
    );
    if (workflow === null) throw new Error("ARCHIVE_WORKFLOW_MISSING");

    return ArchiveManifestInputSchema.parse({
      schemaVersion: 2,
      projectId: job.projectId,
      repositories: workspace.map((lease) => ({
        repositoryId: lease.repositoryId,
        deviceBindingId: lease.deviceBindingId,
        gitHead: lease.gitHead,
      })).filter((repository, index, all) =>
        all.findIndex(({ repositoryId }) =>
          repositoryId === repository.repositoryId
        ) === index
      ),
      requirementRevisionIds: [...root.binding.requirementRevisionIds],
      change: {
        changeId: ChangeIdSchema.parse(change.changeId),
        changeRevisionId: root.binding.changeRevisionId,
      },
      executionPlanId: root.binding.executionPlanId,
      workflowId: workflow.workflowId,
      workflowRevisionId: root.binding.workflowRevisionId,
      runGraph: {
        rootRunId: job.runId,
        runs: runs.map((state) => ({
          runId: state.binding.runId,
          parentRunId: state.binding.parentRunId,
          taskId: state.binding.subjectKind === "task"
            ? state.binding.taskId
            : null,
          outcome: state.status,
          steps: state.steps.map((step) => {
            const stepDefinition = this.services.repositories
              .getWorkflowRevision(state.binding.workflowRevisionId)
              ?.steps.find(({ stepId }) => stepId === step.stepId);
            const agentProfileId = AgentProfileIdSchema.parse(
              stepDefinition?.agentProfileSelector?.agentProfileIds[0],
            );
            return {
              stepRunId: step.stepRunId,
              stepId: step.stepId,
              attempts: step.attempts.map((attempt) => {
                if (attempt.assignment === undefined) {
                  throw new Error("ARCHIVE_ATTEMPT_ASSIGNMENT_MISSING");
                }
                if (
                  attempt.verificationEvidenceFingerprint === undefined
                ) {
                  throw new Error(
                    "ARCHIVE_VERIFICATION_EVIDENCE_MISSING",
                  );
                }
                const operation = this.services.journal.findOperation(
                  OperationIdSchema.parse(attempt.assignment.operationId),
                );
                if (operation === null) {
                  throw new Error("ARCHIVE_OPERATION_MISSING");
                }
                const receipt = this.services.operationWorker.resolveReceipt(
                  operation.operation,
                );
                if (
                  receipt === null
                  || receipt.operationStatus !== "completed"
                ) {
                  throw new Error("ARCHIVE_OPERATION_RECEIPT_NOT_PROVEN");
                }
                const nativeReference = receipt.nativeReferences.find(
                  ({ kind }) => kind === "session",
                );
                return {
                  attemptId: attempt.attemptId,
                  agentProfileId,
                  capabilityProbeDigest: canonicalSha256({
                    capabilityProbeReceiptId:
                      attempt.assignment.capabilityProbeReceiptId,
                  }),
                  nativeSessionReferenceHash: canonicalSha256(
                    nativeReference?.referenceId
                      ?? operation.operation.operationId,
                  ),
                  artifacts: [],
                  evidence: [{
                    evidenceId: EvidenceIdSchema.parse(
                      `evd_${canonicalSha256({
                        attemptId: attempt.attemptId,
                        verificationEvidenceFingerprint:
                          attempt.verificationEvidenceFingerprint,
                      }).slice(0, 24)}`,
                    ),
                    contentRef:
                      `cas:sha256:${attempt.verificationEvidenceFingerprint}`,
                    contentHash:
                      attempt.verificationEvidenceFingerprint,
                  }],
                };
              }),
            };
          }),
        })),
      },
      leases: { workspace, writer, controller },
      ledger: {
        firstPosition: job.firstPosition,
        lastPosition: job.lastPosition,
      },
      actor: {
        actorId: job.actorId,
        correlationId: job.correlationId,
      },
      timestamps: {
        occurredAt: job.occurredAt,
        archivedAt: this.now().toISOString(),
      },
      outcome: job.outcome,
    });
  }
}
