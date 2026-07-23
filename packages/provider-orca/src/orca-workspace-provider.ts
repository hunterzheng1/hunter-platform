import { createHash } from "node:crypto";
import { OperationIdSchema } from "@hunter/domain";
import { z } from "zod";
import {
  OrcaAbsolutePathSchema,
  OrcaClient,
  OrcaWorktreeIdSchema,
} from "./orca-client.js";

const AbsoluteReportedPathSchema = OrcaAbsolutePathSchema;

const WorkspaceCandidateInputSchema = z.strictObject({
  operationId: OperationIdSchema,
  repositoryPath: AbsoluteReportedPathSchema,
  mode: z.enum(["read_only", "write"]),
});
export type WorkspaceCandidateInput = z.infer<typeof WorkspaceCandidateInputSchema>;

export const OrcaWorkspaceCandidateReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    operationId: OperationIdSchema,
    operationLabel: z.string().regex(/^hunter-opn_[a-z0-9][a-z0-9_-]{7,63}$/u),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    proofScope: z.literal("contract_only"),
    providerValidationStatus: z.literal("NOT_PROVEN"),
    retrySafety: z.literal("NOT_PROVEN"),
    privateWorkspace: z.strictObject({
      worktreeId: OrcaWorktreeIdSchema,
      reportedAbsolutePath: AbsoluteReportedPathSchema,
    }),
  })
  .superRefine((receipt, context) => {
    const separator = receipt.privateWorkspace.worktreeId.indexOf("::");
    if (
      receipt.privateWorkspace.worktreeId.slice(separator + 2) !==
      receipt.privateWorkspace.reportedAbsolutePath
    ) {
      context.addIssue({
        code: "custom",
        path: ["privateWorkspace"],
        message: "ORCA_WORKTREE_PATH_MISMATCH",
      });
    }
  });
export type OrcaWorkspaceCandidateReceipt = z.infer<
  typeof OrcaWorkspaceCandidateReceiptSchema
>;

function fingerprint(input: WorkspaceCandidateInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        mode: input.mode,
        operationId: input.operationId,
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
export class OrcaWorkspaceProvider {
  constructor(private readonly client: OrcaClient) {}

  async dispatchUnverifiedWorkspaceCandidateOnce(
    inputValue: WorkspaceCandidateInput,
  ): Promise<OrcaWorkspaceCandidateReceipt> {
    const input = WorkspaceCandidateInputSchema.parse(inputValue);
    const repository = await this.client.addRepository(input.repositoryPath);
    const worktree = await this.client.createWorktree(repository.repoId, input.operationId);

    return OrcaWorkspaceCandidateReceiptSchema.parse({
      schemaVersion: 1,
      operationId: input.operationId,
      operationLabel: `hunter-${input.operationId}`,
      fingerprint: fingerprint(input),
      proofScope: "contract_only",
      providerValidationStatus: "NOT_PROVEN",
      retrySafety: "NOT_PROVEN",
      privateWorkspace: worktree,
    });
  }
}
