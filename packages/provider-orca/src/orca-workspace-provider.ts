import { createHash } from "node:crypto";
import {
  EvidenceIdSchema,
  ExternalReferenceIdSchema,
  OperationIdSchema,
  RepositoryIdSchema,
  RuntimeProviderIdSchema,
  WorktreeIdSchema,
  type RepositoryId,
} from "@hunter/domain";
import {
  ExternalOperationSchema,
  WorkspaceRefSchema,
  type ExternalOperation,
  type ExternalOperationHandler,
  type ExternalOperationReceipt,
  type ExternalOperationReconciler,
  type VerifiedWorkspacePath,
  type WorkspacePathBoundary,
} from "@hunter/runtime-contracts";
import { z } from "zod";
import {
  OrcaAbsolutePathSchema,
  OrcaClient,
  OrcaTerminalIdSchema,
  OrcaWorktreeIdSchema,
} from "./orca-client.js";

const AbsoluteReportedPathSchema = OrcaAbsolutePathSchema;

function externalText(value: string): string {
  return value;
}

const WorkspaceCandidateInputSchema = z.strictObject({
  operationId: OperationIdSchema,
  repositoryId: RepositoryIdSchema,
  repositoryPath: AbsoluteReportedPathSchema,
  mode: z.enum(["read_only", "write"]),
});
export type WorkspaceCandidateInput = z.infer<typeof WorkspaceCandidateInputSchema>;

/**
 * This candidate schema checks receipt structure, deterministic label and
 * private workspace consistency. Its fingerprint field is format-only here:
 * durable operation input binding belongs to Task 14's journal and receipts.
 */
export const OrcaWorkspaceCandidateReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    operationId: OperationIdSchema,
    operationLabel: z.string().regex(/^hunter-opn_[a-z0-9][a-z0-9_-]{7,91}$/u),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    proofScope: z.literal("contract_only"),
    providerValidationStatus: z.literal("NOT_PROVEN"),
    retrySafety: z.literal("NOT_PROVEN"),
    privateWorkspace: z.strictObject({
      worktreeId: OrcaWorktreeIdSchema,
      workspaceRef: WorkspaceRefSchema,
      verifiedWorkspacePath: AbsoluteReportedPathSchema,
      // Provider-private native observation only. This is not a Hunter
      // session, capability receipt, verifier result, or Step success.
      startupTerminalId: OrcaTerminalIdSchema.nullable(),
    }),
  })
  .superRefine((receipt, context) => {
    if (receipt.operationLabel !== `hunter-${receipt.operationId}`) {
      context.addIssue({
        code: "custom",
        path: ["operationLabel"],
        message: "ORCA_OPERATION_LABEL_MISMATCH",
      });
    }
    if (
      externalText(receipt.privateWorkspace.workspaceRef)
      !== externalText(receipt.privateWorkspace.worktreeId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["privateWorkspace"],
        message: "ORCA_WORKSPACE_REF_MISMATCH",
      });
    }
  });
export type OrcaWorkspaceCandidateReceipt = z.infer<
  typeof OrcaWorkspaceCandidateReceiptSchema
> & {
  readonly privateWorkspace: z.infer<
    typeof OrcaWorkspaceCandidateReceiptSchema
  >["privateWorkspace"] & {
    readonly verifiedWorkspacePath: VerifiedWorkspacePath;
  };
};

function fingerprint(input: WorkspaceCandidateInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        mode: input.mode,
        operationId: input.operationId,
        repositoryId: input.repositoryId,
        repositoryPath: input.repositoryPath,
        schemaVersion: 1,
      }),
    )
    .digest("hex");
}

/**
 * Contract-only candidate adapter. It is intentionally not a RuntimeProvider,
 * WorkspaceProvider, ExternalOperationHandler, or Foundation lease service.
 *
 * Task 14 must provide a verified DeviceBinding, durable outbox and side-effect
 * receipts, and Foundation-owned leases before any production composition may
 * dispatch this candidate. Repeating this method is not asserted to be safe.
 */
export class OrcaWorkspaceProvider
  implements ExternalOperationHandler, ExternalOperationReconciler
{
  constructor(
    private readonly client: OrcaClient,
    private readonly workspacePathBoundary: WorkspacePathBoundary,
    private readonly options: {
      readonly repositoryPathFor: (repositoryId: RepositoryId) => string | null;
      readonly observedAt?: (() => string) | undefined;
    },
  ) {}

  async execute(input: ExternalOperation): Promise<ExternalOperationReceipt> {
    const operation = ExternalOperationSchema.parse(input);
    if (operation.operationType !== "workspace.prepare") {
      throw new Error("ORCA_WORKSPACE_OPERATION_UNSUPPORTED");
    }
    const repositoryPath = this.options.repositoryPathFor(
      operation.payload.repositoryId,
    );
    if (repositoryPath === null) {
      throw new Error("ORCA_REPOSITORY_BINDING_NOT_FOUND");
    }
    const candidate = await this.dispatchCandidate({
      operationId: operation.operationId,
      repositoryId: operation.payload.repositoryId,
      repositoryPath,
      mode: operation.payload.mode,
    });
    const candidateHash = createHash("sha256")
      .update(JSON.stringify(candidate))
      .digest("hex");
    return {
      schemaVersion: 1,
      operationId: operation.operationId,
      fingerprint: operation.fingerprint,
      operationStatus: "completed",
      subject: {
        kind: "provider",
        providerId: RuntimeProviderIdSchema.parse("rtp_orca_public_cli"),
        implementationVersion: "contract-fixture",
      },
      nativeReferences: [{
        kind: "workspace",
        referenceId: ExternalReferenceIdSchema.parse(
          `xrf_${candidateHash.slice(0, 24)}`,
        ),
      }],
      facts: [{ kind: "operation_accepted" }],
      evidence: {
        evidenceId: EvidenceIdSchema.parse(`evd_${candidateHash.slice(0, 24)}`),
        evidenceHash: candidateHash,
        proofScope: "contract_only",
      },
      workspaceResult: {
        workspaceRef: candidate.privateWorkspace.workspaceRef,
        worktreeId: WorktreeIdSchema.parse(
          `wtr_${candidateHash.slice(0, 24)}`,
        ),
        reportedWorkspacePath:
          candidate.privateWorkspace.verifiedWorkspacePath,
      },
      observedAt: this.options.observedAt?.() ?? new Date().toISOString(),
    };
  }

  async reconcile(): Promise<{ readonly outcome: "unknown" }> {
    return { outcome: "unknown" };
  }

  private async dispatchCandidate(
    inputValue: WorkspaceCandidateInput,
  ): Promise<OrcaWorkspaceCandidateReceipt> {
    const input = WorkspaceCandidateInputSchema.parse(inputValue);
    const repositoryPath = this.workspacePathBoundary.verify(
      input.repositoryId,
      input.repositoryPath,
    );
    const repository = await this.client.addRepository(repositoryPath);
    const worktree = await this.client.createWorktree(repository.repoId, input.operationId);
    const verifiedWorkspacePath = this.workspacePathBoundary.verify(
      input.repositoryId,
      worktree.reportedAbsolutePath,
    );

    return OrcaWorkspaceCandidateReceiptSchema.parse({
      schemaVersion: 1,
      operationId: input.operationId,
      operationLabel: `hunter-${input.operationId}`,
      fingerprint: fingerprint({ ...input, repositoryPath }),
      proofScope: "contract_only",
      providerValidationStatus: "NOT_PROVEN",
      retrySafety: "NOT_PROVEN",
      privateWorkspace: {
        worktreeId: worktree.worktreeId,
        workspaceRef: WorkspaceRefSchema.parse(worktree.worktreeId),
        verifiedWorkspacePath,
        startupTerminalId: worktree.startupTerminalId,
      },
    }) as OrcaWorkspaceCandidateReceipt;
  }
}
