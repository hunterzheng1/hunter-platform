import { createHash } from "node:crypto";

import {
  KnowledgeEntryIdSchema,
  OperationIdSchema,
  type KnowledgeEntryId,
  type OperationId,
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
    leaseTokenHash: Sha256Schema,
    receipt: VerifiedArchiveReceiptSchema,
  })
  .strict();
export type ArchiveKnowledgeProjectionJob = z.infer<
  typeof ArchiveKnowledgeProjectionJobSchema
>;

export interface ArchiveKnowledgeProjectionCommit {
  readonly jobId: OperationId;
  readonly sourceKey: string;
  readonly manifestKey: string;
  readonly expectedEntryFingerprint: string;
  readonly entry: KnowledgeEntry;
}

export const ArchiveKnowledgeProjectionCommitResultSchema = z
  .object({
    outcome: z.enum(["inserted", "existing"]),
    entry: KnowledgeEntrySchema,
  })
  .strict();
export type ArchiveKnowledgeProjectionCommitResult = z.infer<
  typeof ArchiveKnowledgeProjectionCommitResultSchema
>;

/**
 * Task 18 must implement this port with one durable atomic transaction across
 * both source and manifest uniqueness keys. An in-memory implementation proves
 * only this contract and must remain test-only.
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

function historicalEntryFor(receipt: VerifiedArchiveReceipt): KnowledgeEntry {
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

export class ArchiveKnowledgeProjector {
  constructor(private readonly store: DurableKnowledgeProjectionStore) {}

  async project(input: unknown): Promise<ArchiveKnowledgeProjectionCommitResult> {
    const job = ArchiveKnowledgeProjectionJobSchema.parse(input);
    const entry = historicalEntryFor(job.receipt);
    const expectedEntryFingerprint = fingerprintEntry(entry);
    const result = ArchiveKnowledgeProjectionCommitResultSchema.parse(
      await this.store.commitArchiveProjection({
        jobId: job.jobId,
        sourceKey: `${job.receipt.projectId}\u0000${job.receipt.runId}`,
        manifestKey: `${job.receipt.projectId}\u0000${job.receipt.manifestHash}`,
        expectedEntryFingerprint,
        entry,
      }),
    );
    const persistedEntry = result.entry;

    if (
      persistedEntry.entryId !== entry.entryId ||
      fingerprintEntry(persistedEntry) !== expectedEntryFingerprint
    ) {
      throw new Error("KNOWLEDGE_PROJECTION_RECEIPT_MISMATCH");
    }

    return { outcome: result.outcome, entry: persistedEntry };
  }
}
