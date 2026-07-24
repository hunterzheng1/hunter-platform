import { createHash } from "node:crypto";

import {
  KnowledgeEntryIdSchema,
  LeaseOwnerIdSchema,
  OperationIdSchema,
  type KnowledgeEntryId,
} from "@hunter/domain";
import { z } from "zod";

import {
  KnowledgeEntrySchema,
  VerifiedArchiveReceiptSchema,
  type KnowledgeEntry,
  type VerifiedArchiveReceipt,
} from "./contracts.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

/**
 * A projection job is accepted only after a durable Task 18 worker has leased
 * it. This is deliberately not a write-and-ingest convenience API.
 */
export const ArchiveKnowledgeProjectionJobSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: OperationIdSchema,
    state: z.literal("leased"),
    attempt: z.number().int().positive(),
    ownerId: LeaseOwnerIdSchema,
    generation: z.number().int().positive(),
    acquiredAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    leaseTokenHash: Sha256Schema,
    receipt: VerifiedArchiveReceiptSchema,
  })
  .strict()
  .superRefine((job, context) => {
    if (Date.parse(job.expiresAt) <= Date.parse(job.acquiredAt)) {
      context.addIssue({ code: "custom", message: "LEASE_WINDOW_INVALID" });
    }
  });
export type ArchiveKnowledgeProjectionJob = z.infer<
  typeof ArchiveKnowledgeProjectionJobSchema
>;

export const ArchiveKnowledgeProjectionCommitSchema = z
  .object({
    jobId: OperationIdSchema,
    inputFingerprint: Sha256Schema,
    attempt: z.number().int().positive(),
    ownerId: LeaseOwnerIdSchema,
    generation: z.number().int().positive(),
    acquiredAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    leaseTokenHash: Sha256Schema,
    expectedEntryFingerprint: Sha256Schema,
    receipt: VerifiedArchiveReceiptSchema,
    entry: KnowledgeEntrySchema,
  })
  .strict()
  .superRefine((commit, context) => {
    if (Date.parse(commit.expiresAt) <= Date.parse(commit.acquiredAt)) {
      context.addIssue({ code: "custom", message: "LEASE_WINDOW_INVALID" });
    }
    const expectedEntry = historicalKnowledgeEntryFor(commit.receipt);
    const expectedInputFingerprint = fingerprintInput(commit.receipt);
    const expectedEntryFingerprint = fingerprintEntry(expectedEntry);
    if (
      commit.inputFingerprint !== expectedInputFingerprint ||
      commit.expectedEntryFingerprint !== expectedEntryFingerprint ||
      fingerprintEntry(commit.entry) !== expectedEntryFingerprint
    ) {
      context.addIssue({
        code: "custom",
        message: "KNOWLEDGE_PROJECTION_BINDING_INVALID",
      });
    }
  });
export type ArchiveKnowledgeProjectionCommit = z.infer<
  typeof ArchiveKnowledgeProjectionCommitSchema
>;

export function validateArchiveKnowledgeProjectionCommit(
  input: unknown,
): ArchiveKnowledgeProjectionCommit {
  return ArchiveKnowledgeProjectionCommitSchema.parse(input);
}

export const ArchiveKnowledgeProjectionCommitResultSchema = z
  .object({
    jobId: OperationIdSchema,
    inputFingerprint: Sha256Schema,
    outcome: z.enum(["inserted", "existing"]),
    entry: KnowledgeEntrySchema,
  })
  .strict();
export type ArchiveKnowledgeProjectionCommitResult = z.infer<
  typeof ArchiveKnowledgeProjectionCommitResultSchema
>;

export interface ArchiveKnowledgeProjectionResult {
  readonly outcome: "inserted" | "existing";
  readonly entry: KnowledgeEntry;
}

/**
 * Task 18 must implement this port with one durable atomic transaction. That
 * transaction validates the leased state, current owner, attempt, generation,
 * lease proof hash, and expiry using the store-owned clock; binds jobId to
 * inputFingerprint; and derives source/manifest uniqueness keys only from the
 * validated receipt. It never stores or returns a raw lease token. An in-memory
 * implementation proves only this contract and must remain test-only.
 */
export interface DurableKnowledgeProjectionStore {
  commitArchiveProjection(
    commit: ArchiveKnowledgeProjectionCommit,
  ): Promise<ArchiveKnowledgeProjectionCommitResult>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function entryIdFor(receipt: VerifiedArchiveReceipt): KnowledgeEntryId {
  return KnowledgeEntryIdSchema.parse(
    `kne_${sha256(
      [
        receipt.projectId,
        receipt.runId,
        receipt.outcome,
        receipt.manifestSchemaVersion,
        receipt.manifestHash,
        receipt.manifestRef,
      ].join("\u0000"),
    )}`,
  );
}

export function historicalKnowledgeEntryFor(
  receipt: VerifiedArchiveReceipt,
): KnowledgeEntry {
  return KnowledgeEntrySchema.parse({
    schemaVersion: 1,
    entryId: entryIdFor(receipt),
    level: "historical",
    status: "active",
    source: {
      type: "archive",
      projectId: receipt.projectId,
      runId: receipt.runId,
      outcome: receipt.outcome,
      manifestSchemaVersion: receipt.manifestSchemaVersion,
      manifestHash: receipt.manifestHash,
      manifestRef: receipt.manifestRef,
    },
    scope: { projectId: receipt.projectId },
    summary: `Archived ${receipt.outcome} Run.`,
    body: `Archived ${receipt.outcome} Run ${receipt.runId}; verified manifest sha256 ${receipt.manifestHash}.`,
  });
}

function fingerprintEntry(entry: KnowledgeEntry): string {
  return sha256(JSON.stringify(KnowledgeEntrySchema.parse(entry)));
}

function fingerprintInput(receipt: VerifiedArchiveReceipt): string {
  return sha256(JSON.stringify(VerifiedArchiveReceiptSchema.parse(receipt)));
}

export class ArchiveKnowledgeProjector {
  constructor(private readonly store: DurableKnowledgeProjectionStore) {}

  async project(input: unknown): Promise<ArchiveKnowledgeProjectionResult> {
    const job = ArchiveKnowledgeProjectionJobSchema.parse(input);
    const entry = historicalKnowledgeEntryFor(job.receipt);
    const inputFingerprint = fingerprintInput(job.receipt);
    const expectedEntryFingerprint = fingerprintEntry(entry);
    const commit = validateArchiveKnowledgeProjectionCommit({
      jobId: job.jobId,
      inputFingerprint,
      attempt: job.attempt,
      ownerId: job.ownerId,
      generation: job.generation,
      acquiredAt: job.acquiredAt,
      expiresAt: job.expiresAt,
      leaseTokenHash: job.leaseTokenHash,
      expectedEntryFingerprint,
      receipt: job.receipt,
      entry,
    });
    const result = ArchiveKnowledgeProjectionCommitResultSchema.parse(
      await this.store.commitArchiveProjection(commit),
    );
    const persistedEntry = result.entry;

    if (
      result.jobId !== job.jobId ||
      result.inputFingerprint !== inputFingerprint ||
      persistedEntry.entryId !== entry.entryId ||
      fingerprintEntry(persistedEntry) !== expectedEntryFingerprint
    ) {
      throw new Error("KNOWLEDGE_PROJECTION_RECEIPT_MISMATCH");
    }

    return { outcome: result.outcome, entry: persistedEntry };
  }
}
