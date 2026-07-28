import { createHash } from "node:crypto";
import {
  EvidenceIdSchema,
  ExternalReferenceIdSchema,
  RuntimeProviderIdSchema,
  WorktreeIdSchema,
  type RepositoryId,
  type WorkspaceId,
} from "@hunter/domain";
import {
  ExternalBoundaryError,
  ExternalOperationSchema,
  WorkspaceRefSchema,
  fingerprintExternalOperation,
  type ExternalOperation,
  type ExternalOperationHandler,
  type ExternalOperationReceipt,
  type ExternalOperationReconciler,
  type VerifiedWorkspacePath,
  type WorkspacePathBoundary,
} from "@hunter/runtime-contracts";
import type { HerdrPublicClient } from "./public-client.js";
import {
  HERDR_EXECUTABLE_IDENTITY,
  HerdrAdapterError,
} from "./command-runner.js";

interface ExecutedOperation {
  readonly fingerprint: string;
  readonly promise: Promise<ExternalOperationReceipt>;
}

interface AttachedWorkspace {
  readonly providerWorkspaceId: string;
  readonly verifiedPath: VerifiedWorkspacePath;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class HerdrPublicAdapter
  implements ExternalOperationHandler, ExternalOperationReconciler
{
  readonly #executions = new Map<string, ExecutedOperation>();
  readonly #workspaces = new Map<WorkspaceId, AttachedWorkspace>();

  constructor(
    private readonly client: HerdrPublicClient,
    private readonly workspacePathBoundary: WorkspacePathBoundary,
    private readonly options: {
      readonly repositoryPathFor: (repositoryId: RepositoryId) => string | null;
      readonly repositorySourcePathFor: (
        repositoryId: RepositoryId,
      ) => string | null;
      readonly observedAt?: (() => string) | undefined;
    },
  ) {}

  async execute(input: ExternalOperation): Promise<ExternalOperationReceipt> {
    const operation = ExternalOperationSchema.parse(input);
    if (fingerprintExternalOperation(operation) !== operation.fingerprint) {
      throw new Error("OPERATION_FINGERPRINT_MISMATCH");
    }
    const existing = this.#executions.get(operation.operationId);
    if (existing !== undefined) {
      if (existing.fingerprint !== operation.fingerprint) {
        throw new Error("OPERATION_ID_REUSED_WITH_DIFFERENT_PAYLOAD");
      }
      return await existing.promise;
    }

    const promise = this.#executeNew(operation);
    const execution = {
      fingerprint: operation.fingerprint,
      promise,
    };
    this.#executions.set(operation.operationId, execution);
    try {
      return await promise;
    } catch (error) {
      if (this.#executions.get(operation.operationId) === execution) {
        this.#executions.delete(operation.operationId);
      }
      throw error;
    }
  }

  async #executeNew(
    operation: ExternalOperation,
  ): Promise<ExternalOperationReceipt> {
    const receipt =
      operation.operationType === "workspace.prepare"
        ? await this.#prepare(operation)
        : operation.operationType === "workspace.release"
          ? await this.#release(operation)
          : null;
    if (receipt === null) {
      throw new Error("HERDR_OPERATION_UNSUPPORTED");
    }
    return receipt;
  }

  async reconcile(): Promise<{ readonly outcome: "unknown" }> {
    return { outcome: "unknown" };
  }

  async #prepare(
    operation: Extract<ExternalOperation, { operationType: "workspace.prepare" }>,
  ): Promise<ExternalOperationReceipt> {
    const reportedPath = this.options.repositoryPathFor(
      operation.payload.repositoryId,
    );
    if (reportedPath === null) {
      throw new Error("HERDR_REPOSITORY_BINDING_NOT_FOUND");
    }
    const expectedPath = this.workspacePathBoundary.verify(
      operation.payload.repositoryId,
      reportedPath,
    );
    const reportedSourcePath = this.options.repositorySourcePathFor(
      operation.payload.repositoryId,
    );
    if (reportedSourcePath === null) {
      throw new Error("HERDR_REPOSITORY_SOURCE_BINDING_NOT_FOUND");
    }
    const sourcePath = this.workspacePathBoundary.verify(
      operation.payload.repositoryId,
      reportedSourcePath,
    );
    let opened: Awaited<
      ReturnType<HerdrPublicClient["openExistingWorktree"]>
    >;
    let verifiedPath: VerifiedWorkspacePath;
    try {
      opened = await this.client.openExistingWorktree({
        sourcePath,
        path: expectedPath,
        operationLabel: `hunter-${operation.operationId}`,
      });
      verifiedPath = this.workspacePathBoundary.verify(
        operation.payload.repositoryId,
        opened.reportedPath,
      );
      if (
        this.workspacePathBoundary.canonicalKey(expectedPath)
        !== this.workspacePathBoundary.canonicalKey(verifiedPath)
      ) {
        throw new ExternalBoundaryError("PATH_SCOPE_VIOLATION");
      }
    } catch (error) {
      if (error instanceof HerdrAdapterError && !error.effectPossible) {
        throw error;
      }
      return this.#needsAttentionReceipt(
        operation,
        error instanceof HerdrAdapterError
          ? error.code
          : error instanceof ExternalBoundaryError
            ? error.code
            : "HERDR_POST_IO_UNCERTAIN",
      );
    }
    this.#workspaces.set(operation.payload.workspaceId, {
      providerWorkspaceId: opened.workspaceId,
      verifiedPath,
    });
    const evidenceHash = sha256({
      alreadyOpen: opened.alreadyOpen,
      executableIdentityFingerprint:
        HERDR_EXECUTABLE_IDENTITY.fingerprint,
      fingerprint: operation.fingerprint,
      providerWorkspaceId: opened.workspaceId,
      verifiedPath,
    });
    return {
      schemaVersion: 1,
      operationId: operation.operationId,
      fingerprint: operation.fingerprint,
      operationStatus: "completed",
      subject: {
        kind: "provider",
        providerId: RuntimeProviderIdSchema.parse("rtp_herdr_public_cli"),
        implementationVersion:
          HERDR_EXECUTABLE_IDENTITY.version,
      },
      nativeReferences: [
        {
          kind: "workspace",
          referenceId: ExternalReferenceIdSchema.parse(
            `xrf_${evidenceHash.slice(0, 24)}`,
          ),
        },
      ],
      facts: [{ kind: "operation_accepted" }],
      evidence: {
        evidenceId: EvidenceIdSchema.parse(
          `evd_${evidenceHash.slice(0, 24)}`,
        ),
        evidenceHash,
        proofScope: "local_observation",
      },
      workspaceResult: {
        workspaceRef: WorkspaceRefSchema.parse(opened.workspaceId),
        worktreeId: WorktreeIdSchema.parse(
          `wtr_${evidenceHash.slice(0, 24)}`,
        ),
        reportedWorkspacePath: verifiedPath,
      },
      observedAt: this.options.observedAt?.() ?? new Date().toISOString(),
    };
  }

  async #release(
    operation: Extract<ExternalOperation, { operationType: "workspace.release" }>,
  ): Promise<ExternalOperationReceipt> {
    const attached = this.#workspaces.get(operation.payload.workspaceId);
    if (attached === undefined) {
      throw new Error("HERDR_WORKSPACE_BINDING_NOT_FOUND");
    }
    try {
      await this.client.closeWorkspace(attached.providerWorkspaceId);
    } catch (error) {
      if (error instanceof HerdrAdapterError && !error.effectPossible) {
        throw error;
      }
      return this.#needsAttentionReceipt(
        operation,
        error instanceof HerdrAdapterError
          ? error.code
          : "HERDR_POST_IO_UNCERTAIN",
      );
    }
    const evidenceHash = sha256({
      fingerprint: operation.fingerprint,
      executableIdentityFingerprint:
        HERDR_EXECUTABLE_IDENTITY.fingerprint,
      providerWorkspaceId: attached.providerWorkspaceId,
      stateOnlyClose: true,
      verifiedPath: attached.verifiedPath,
    });
    this.#workspaces.delete(operation.payload.workspaceId);
    return {
      schemaVersion: 1,
      operationId: operation.operationId,
      fingerprint: operation.fingerprint,
      operationStatus: "completed",
      subject: {
        kind: "provider",
        providerId: RuntimeProviderIdSchema.parse("rtp_herdr_public_cli"),
        implementationVersion:
          HERDR_EXECUTABLE_IDENTITY.version,
      },
      nativeReferences: [
        {
          kind: "workspace",
          referenceId: ExternalReferenceIdSchema.parse(
            `xrf_${evidenceHash.slice(0, 24)}`,
          ),
        },
      ],
      facts: [{ kind: "operation_accepted" }],
      evidence: {
        evidenceId: EvidenceIdSchema.parse(
          `evd_${evidenceHash.slice(0, 24)}`,
        ),
        evidenceHash,
        proofScope: "local_observation",
      },
      observedAt: this.options.observedAt?.() ?? new Date().toISOString(),
    };
  }

  #needsAttentionReceipt(
    operation: ExternalOperation,
    reason:
      | HerdrAdapterError["code"]
      | ExternalBoundaryError["code"]
      | "HERDR_POST_IO_UNCERTAIN",
  ): ExternalOperationReceipt {
    const evidenceHash = sha256({
      executableIdentityFingerprint:
        HERDR_EXECUTABLE_IDENTITY.fingerprint,
      fingerprint: operation.fingerprint,
      operationType: operation.operationType,
      reason,
    });
    return {
      schemaVersion: 1,
      operationId: operation.operationId,
      fingerprint: operation.fingerprint,
      operationStatus: "needs_attention",
      subject: {
        kind: "provider",
        providerId: RuntimeProviderIdSchema.parse("rtp_herdr_public_cli"),
        implementationVersion:
          HERDR_EXECUTABLE_IDENTITY.version,
      },
      nativeReferences: [],
      facts: [],
      evidence: {
        evidenceId: EvidenceIdSchema.parse(
          `evd_${evidenceHash.slice(0, 24)}`,
        ),
        evidenceHash,
        proofScope: "local_observation",
      },
      observedAt: this.options.observedAt?.() ?? new Date().toISOString(),
    };
  }
}
