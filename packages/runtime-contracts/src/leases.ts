import {
  AttemptIdSchema,
  ControllerLeaseIdSchema,
  DeviceBindingIdSchema,
  LeaseOwnerIdSchema,
  NativeSessionIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
  WorkspaceIdSchema,
  WorkspaceLeaseIdSchema,
  WorktreeIdSchema,
  WriterLeaseIdSchema,
} from "@hunter/domain";
import { z } from "zod";
import { CanonicalWorkspaceKeySchema } from "./external-boundary.js";

function containsForbiddenBranchCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31
      || codePoint === 127
      || "~^:?*[\\".includes(character);
  });
}

const leaseFields = {
  schemaVersion: z.literal(2),
  projectId: ProjectIdSchema,
  repositoryId: RepositoryIdSchema,
  deviceBindingId: DeviceBindingIdSchema,
  canonicalWorkspaceKey: CanonicalWorkspaceKeySchema,
  gitHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  branch: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (value) =>
        !value.startsWith("-") &&
        !value.endsWith("/") &&
        !value.includes("..") &&
        !containsForbiddenBranchCharacter(value),
      "LEASE_BRANCH_INVALID",
    ),
  ownerRunId: RunIdSchema,
  ownerAttemptId: AttemptIdSchema,
  ownerId: LeaseOwnerIdSchema,
  generation: z.number().int().positive(),
  mode: z.enum(["read_only", "write"]),
  acquiredAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  revocationReason: z.string().min(1).max(512).nullable(),
};

function validateLeaseWindow(
  lease: {
    acquiredAt: string;
    expiresAt: string;
    revokedAt: string | null;
    revocationReason: string | null;
  },
  context: z.core.$RefinementCtx,
): void {
  if (Date.parse(lease.expiresAt) <= Date.parse(lease.acquiredAt)) {
    context.addIssue({ code: "custom", message: "LEASE_WINDOW_INVALID" });
  }
  if ((lease.revokedAt === null) !== (lease.revocationReason === null)) {
    context.addIssue({ code: "custom", message: "LEASE_REVOCATION_INVALID" });
  }
}

export const WorkspaceLeaseSchema = z
  .strictObject({
    ...leaseFields,
    kind: z.literal("workspace"),
    leaseId: WorkspaceLeaseIdSchema,
    scope: z.strictObject({
      workspaceId: WorkspaceIdSchema,
    }),
  })
  .superRefine(validateLeaseWindow);
export type WorkspaceLease = z.infer<typeof WorkspaceLeaseSchema>;

export const WriterLeaseSchema = z
  .strictObject({
    ...leaseFields,
    kind: z.literal("writer"),
    leaseId: WriterLeaseIdSchema,
    scope: z.strictObject({
      workspaceId: WorkspaceIdSchema,
      worktreeId: WorktreeIdSchema,
    }),
  })
  .superRefine((lease, context) => {
    validateLeaseWindow(lease, context);
    if (lease.mode !== "write") {
      context.addIssue({ code: "custom", message: "WRITER_LEASE_REQUIRES_WRITE_MODE" });
    }
  });
export type WriterLease = z.infer<typeof WriterLeaseSchema>;

export const ControllerLeaseSchema = z
  .strictObject({
    ...leaseFields,
    kind: z.literal("controller"),
    leaseId: ControllerLeaseIdSchema,
    scope: z.strictObject({
      workspaceId: WorkspaceIdSchema,
      worktreeId: WorktreeIdSchema,
      nativeSessionId: NativeSessionIdSchema,
    }),
  })
  .superRefine(validateLeaseWindow);
export type ControllerLease = z.infer<typeof ControllerLeaseSchema>;

export const LeaseSchema = z.union([
  WorkspaceLeaseSchema,
  WriterLeaseSchema,
  ControllerLeaseSchema,
]);
export type Lease = z.infer<typeof LeaseSchema>;

export const LeaseRenewRequestSchema = z.strictObject({
  leaseId: z.union([WorkspaceLeaseIdSchema, WriterLeaseIdSchema, ControllerLeaseIdSchema]),
  ownerId: LeaseOwnerIdSchema,
  generation: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
});
export type LeaseRenewRequest = z.infer<typeof LeaseRenewRequestSchema>;

export const LeaseReleaseRequestSchema = z.strictObject({
  leaseId: z.union([WorkspaceLeaseIdSchema, WriterLeaseIdSchema, ControllerLeaseIdSchema]),
  ownerId: LeaseOwnerIdSchema,
  generation: z.number().int().positive(),
});
export type LeaseReleaseRequest = z.infer<typeof LeaseReleaseRequestSchema>;

export interface LeaseBoundary {
  acquire(lease: Lease): Promise<Lease>;
  renew(request: LeaseRenewRequest): Promise<Lease>;
  release(request: LeaseReleaseRequest): Promise<void>;
  inspect(leaseId: Lease["leaseId"]): Promise<Lease | null>;
}
