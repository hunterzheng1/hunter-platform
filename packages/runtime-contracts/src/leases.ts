import {
  ControllerLeaseIdSchema,
  DeviceBindingIdSchema,
  LeaseOwnerIdSchema,
  NativeSessionIdSchema,
  RepositoryIdSchema,
  WorkspaceIdSchema,
  WorkspaceLeaseIdSchema,
  WorktreeIdSchema,
  WriterLeaseIdSchema,
} from "@hunter/domain";
import { z } from "zod";

const leaseFields = {
  schemaVersion: z.literal(1),
  ownerId: LeaseOwnerIdSchema,
  generation: z.number().int().positive(),
  acquiredAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
};

function validateLeaseWindow(
  lease: { acquiredAt: string; expiresAt: string },
  context: z.core.$RefinementCtx,
): void {
  if (Date.parse(lease.expiresAt) <= Date.parse(lease.acquiredAt)) {
    context.addIssue({ code: "custom", message: "LEASE_WINDOW_INVALID" });
  }
}

export const WorkspaceLeaseSchema = z
  .strictObject({
    ...leaseFields,
    kind: z.literal("workspace"),
    leaseId: WorkspaceLeaseIdSchema,
    scope: z.strictObject({
      workspaceId: WorkspaceIdSchema,
      deviceBindingId: DeviceBindingIdSchema,
      repositoryId: RepositoryIdSchema,
      mode: z.enum(["read_only", "write"]),
      baselineRevision: z.string().min(7).max(128),
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
      worktreeId: WorktreeIdSchema.nullable(),
    }),
  })
  .superRefine(validateLeaseWindow);
export type WriterLease = z.infer<typeof WriterLeaseSchema>;

export const ControllerLeaseSchema = z
  .strictObject({
    ...leaseFields,
    kind: z.literal("controller"),
    leaseId: ControllerLeaseIdSchema,
    scope: z.strictObject({ nativeSessionId: NativeSessionIdSchema }),
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
