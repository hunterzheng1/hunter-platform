import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  LeaseOwnerIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  type LeaseOwnerId,
  type ProjectId,
  type RunId,
} from "@hunter/domain";
import { z } from "zod";

import {
  ArchiveKnowledgeProjector,
  type ArchiveKnowledgeProjectionJob,
} from "./archive-projector.js";
import {
  createArchiveManifest,
  type ArchiveManifestInput,
} from "./archive-manifest.js";
import type { ArchiveWriter } from "./archive-writer.js";
import {
  VerifiedArchiveReceiptSchema,
  type VerifiedArchiveReceipt,
} from "./contracts.js";
import type { SqliteKnowledgeCatalog } from "./knowledge-catalog.js";

const OutcomeSchema = z.enum(["succeeded", "failed", "canceled"]);
const ScheduleInputSchema = z
  .object({
    projectId: ProjectIdSchema,
    runId: RunIdSchema,
    outcome: OutcomeSchema,
    firstPosition: z.number().int().positive(),
    lastPosition: z.number().int().positive(),
    actorId: z.string().trim().min(1).max(256),
    correlationId: z.string().trim().min(1).max(256),
    occurredAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    ({ firstPosition, lastPosition }) => lastPosition >= firstPosition,
    "ARCHIVE_JOB_LEDGER_RANGE_INVALID",
  );
export type ArchiveJobScheduleInput = z.infer<typeof ScheduleInputSchema>;

interface ArchiveJobRow {
  readonly job_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly outcome: "succeeded" | "failed" | "canceled";
  readonly status: "pending" | "leased" | "completed" | "needs_attention";
  readonly attempt_count: number;
  readonly lease_owner: string | null;
  readonly lease_generation: number;
  readonly lease_token_hash: string | null;
  readonly lease_acquired_at: string | null;
  readonly lease_expires_at: string | null;
  readonly input_fingerprint: string;
  readonly first_position: number;
  readonly last_position: number;
  readonly actor_id: string;
  readonly correlation_id: string;
  readonly occurred_at: string;
  readonly archive_receipt_json: string | null;
}

export interface LeasedArchiveJob {
  readonly jobId: ReturnType<typeof OperationIdSchema.parse>;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly outcome: "succeeded" | "failed" | "canceled";
  readonly attempt: number;
  readonly ownerId: LeaseOwnerId;
  readonly generation: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly leaseTokenHash: string;
  readonly inputFingerprint: string;
  readonly firstPosition: number;
  readonly lastPosition: number;
  readonly actorId: string;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly receipt: VerifiedArchiveReceipt | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jobIdFor(projectId: ProjectId, runId: RunId): ReturnType<typeof OperationIdSchema.parse> {
  return OperationIdSchema.parse(
    `opn_${sha256(`${projectId}\u0000${runId}`).slice(0, 24)}`,
  );
}

function fingerprintSchedule(input: ArchiveJobScheduleInput): string {
  return sha256(JSON.stringify(ScheduleInputSchema.parse(input)));
}

function toLease(row: ArchiveJobRow): LeasedArchiveJob {
  if (
    row.status !== "leased" ||
    row.lease_owner === null ||
    row.lease_token_hash === null ||
    row.lease_acquired_at === null ||
    row.lease_expires_at === null
  ) {
    throw new Error("ARCHIVE_JOB_LEASE_CORRUPT");
  }
  return {
    jobId: OperationIdSchema.parse(row.job_id),
    projectId: ProjectIdSchema.parse(row.project_id),
    runId: RunIdSchema.parse(row.run_id),
    outcome: row.outcome,
    attempt: row.attempt_count,
    ownerId: LeaseOwnerIdSchema.parse(row.lease_owner),
    generation: row.lease_generation,
    acquiredAt: row.lease_acquired_at,
    expiresAt: row.lease_expires_at,
    leaseTokenHash: row.lease_token_hash,
    inputFingerprint: row.input_fingerprint,
    firstPosition: row.first_position,
    lastPosition: row.last_position,
    actorId: row.actor_id,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
    receipt:
      row.archive_receipt_json === null
        ? null
        : VerifiedArchiveReceiptSchema.parse(
            JSON.parse(row.archive_receipt_json) as unknown,
          ),
  };
}

export class SqliteArchiveJobStore {
  public constructor(private readonly database: DatabaseSync) {}

  public schedule(inputValue: ArchiveJobScheduleInput): {
    readonly jobId: ReturnType<typeof OperationIdSchema.parse>;
    readonly outcome: "scheduled" | "existing";
  } {
    const input = ScheduleInputSchema.parse(inputValue);
    const jobId = jobIdFor(input.projectId, input.runId);
    const fingerprint = fingerprintSchedule(input);
    const existing = this.database.prepare(
      "SELECT input_fingerprint FROM archive_jobs WHERE job_id = ?",
    ).get(jobId) as unknown as { input_fingerprint: string } | undefined;
    if (existing !== undefined) {
      if (existing.input_fingerprint !== fingerprint) {
        throw new Error("ARCHIVE_JOB_INPUT_CONFLICT");
      }
      return { jobId, outcome: "existing" };
    }
    const timestamp = new Date().toISOString();
    this.database.prepare(
      `INSERT INTO archive_jobs(
         job_id, project_id, run_id, outcome, status, attempt_count,
         lease_owner, lease_generation, lease_token_hash, lease_acquired_at,
         lease_expires_at, input_fingerprint, first_position, last_position,
         actor_id, correlation_id, occurred_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, 0, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      input.projectId,
      input.runId,
      input.outcome,
      fingerprint,
      input.firstPosition,
      input.lastPosition,
      input.actorId,
      input.correlationId,
      input.occurredAt,
      timestamp,
      timestamp,
    );
    return { jobId, outcome: "scheduled" };
  }

  public claim(input: {
    readonly ownerId: LeaseOwnerId;
    readonly now: Date;
    readonly leaseDurationMs: number;
  }): LeasedArchiveJob | "needs_attention" | null {
    if (
      !Number.isSafeInteger(input.leaseDurationMs) ||
      input.leaseDurationMs <= 0
    ) {
      throw new Error("ARCHIVE_JOB_LEASE_DURATION_INVALID");
    }
    const now = input.now.toISOString();
    const expiresAt = new Date(
      input.now.getTime() + input.leaseDurationMs,
    ).toISOString();
    const leaseTokenHash = sha256(randomBytes(32).toString("hex"));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.database.prepare(
        `SELECT job_id FROM archive_jobs
          WHERE status = 'pending'
             OR (status = 'leased' AND lease_expires_at <= ?)
          ORDER BY created_at, job_id
          LIMIT 1`,
      ).get(now) as unknown as { job_id: string } | undefined;
      if (candidate === undefined) {
        this.database.exec("COMMIT");
        return null;
      }
      this.database.prepare(
        `UPDATE archive_jobs
            SET status = 'leased',
                attempt_count = attempt_count + 1,
                lease_owner = ?,
                lease_generation = lease_generation + 1,
                lease_token_hash = ?,
                lease_acquired_at = ?,
                lease_expires_at = ?,
                updated_at = ?
          WHERE job_id = ?`,
      ).run(
        input.ownerId,
        leaseTokenHash,
        now,
        expiresAt,
        now,
        candidate.job_id,
      );
      const row = this.row(candidate.job_id);
      if (row === undefined) {
        throw new Error("ARCHIVE_JOB_CLAIM_DISAPPEARED");
      }
      let lease: LeasedArchiveJob;
      try {
        lease = toLease(row);
      } catch (error) {
        const message = error instanceof Error
          ? `ARCHIVE_JOB_RECEIPT_INVALID: ${error.message}`.slice(0, 1_000)
          : "ARCHIVE_JOB_RECEIPT_INVALID";
        this.database.prepare(
          `UPDATE archive_jobs
              SET status = 'needs_attention', last_error = ?, updated_at = ?
            WHERE job_id = ?`,
        ).run(message, now, candidate.job_id);
        this.database.exec("COMMIT");
        return "needs_attention";
      }
      this.database.exec("COMMIT");
      return lease;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public recordReceipt(
    job: LeasedArchiveJob,
    receiptInput: unknown,
    now: Date,
  ): VerifiedArchiveReceipt {
    const receipt = VerifiedArchiveReceiptSchema.parse(receiptInput);
    if (
      receipt.projectId !== job.projectId ||
      receipt.runId !== job.runId ||
      receipt.outcome !== job.outcome
    ) {
      throw new Error("ARCHIVE_RECEIPT_JOB_MISMATCH");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.row(job.jobId);
      this.assertCurrentLease(current, job, now);
      if (current === undefined) throw new Error("ARCHIVE_JOB_LEASE_NOT_CURRENT");
      if (current.archive_receipt_json !== null) {
        const existing = VerifiedArchiveReceiptSchema.parse(
          JSON.parse(current.archive_receipt_json) as unknown,
        );
        if (JSON.stringify(existing) !== JSON.stringify(receipt)) {
          throw new Error("ARCHIVE_RECEIPT_CONFLICT");
        }
        this.database.exec("COMMIT");
        return existing;
      }
      this.database.prepare(
        `UPDATE archive_jobs
            SET manifest_hash = ?, manifest_ref = ?,
                archive_receipt_json = ?, updated_at = ?
          WHERE job_id = ?`,
      ).run(
        receipt.manifestHash,
        receipt.manifestRef,
        JSON.stringify(receipt),
        now.toISOString(),
        job.jobId,
      );
      this.database.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public markNeedsAttention(
    job: LeasedArchiveJob,
    error: unknown,
    now = new Date(),
  ): void {
    const message =
      error instanceof Error ? error.message.slice(0, 1_000) : "ARCHIVE_JOB_FAILED";
    const result = this.database.prepare(
      `UPDATE archive_jobs
          SET status = 'needs_attention', last_error = ?, updated_at = ?
        WHERE job_id = ?
          AND status = 'leased'
          AND attempt_count = ?
          AND lease_owner = ?
          AND lease_generation = ?
          AND lease_token_hash = ?
          AND lease_acquired_at = ?
          AND lease_expires_at = ?
          AND lease_expires_at > ?`,
    ).run(
      message,
      now.toISOString(),
      job.jobId,
      job.attempt,
      job.ownerId,
      job.generation,
      job.leaseTokenHash,
      job.acquiredAt,
      job.expiresAt,
      now.toISOString(),
    );
    if (result.changes !== 1) {
      throw new Error("ARCHIVE_JOB_LEASE_NOT_CURRENT");
    }
  }

  private row(jobId: string): ArchiveJobRow | undefined {
    return this.database.prepare(
      `SELECT job_id, project_id, run_id, outcome, status, attempt_count,
              lease_owner, lease_generation, lease_token_hash, lease_acquired_at,
              lease_expires_at, input_fingerprint, first_position, last_position,
              actor_id, correlation_id, occurred_at, archive_receipt_json
         FROM archive_jobs WHERE job_id = ?`,
    ).get(jobId) as unknown as ArchiveJobRow | undefined;
  }

  private assertCurrentLease(
    current: ArchiveJobRow | undefined,
    job: LeasedArchiveJob,
    now: Date,
  ): void {
    if (
      current === undefined ||
      current.status !== "leased" ||
      current.attempt_count !== job.attempt ||
      current.lease_owner !== job.ownerId ||
      current.lease_generation !== job.generation ||
      current.lease_token_hash !== job.leaseTokenHash ||
      current.lease_acquired_at !== job.acquiredAt ||
      current.lease_expires_at !== job.expiresAt ||
      Date.parse(job.expiresAt) <= now.getTime()
    ) {
      throw new Error("ARCHIVE_JOB_LEASE_NOT_CURRENT");
    }
  }
}

export type ArchiveJobFaultPoint =
  | "before_manifest_publication"
  | "after_manifest_publication"
  | "after_archive_receipt";

export interface ArchiveManifestSource {
  build(job: LeasedArchiveJob): ArchiveManifestInput | Promise<ArchiveManifestInput>;
}

export class ArchiveJobWorker {
  private readonly projector: ArchiveKnowledgeProjector;

  public constructor(
    private readonly options: {
      readonly store: SqliteArchiveJobStore;
      readonly writer: ArchiveWriter;
      readonly catalog: SqliteKnowledgeCatalog;
      readonly source: ArchiveManifestSource;
      readonly ownerId: LeaseOwnerId;
      readonly now?: () => Date;
      readonly leaseDurationMs?: number;
      readonly fault?: (point: ArchiveJobFaultPoint) => void;
    },
  ) {
    this.projector = new ArchiveKnowledgeProjector(options.catalog);
  }

  public async runOnce(): Promise<"idle" | "completed" | "needs_attention"> {
    const now = this.options.now?.() ?? new Date();
    const job = this.options.store.claim({
      ownerId: this.options.ownerId,
      now,
      leaseDurationMs: this.options.leaseDurationMs ?? 30_000,
    });
    if (job === null) return "idle";
    if (job === "needs_attention") return "needs_attention";
    try {
      let receipt = job.receipt;
      if (receipt === null) {
        this.options.fault?.("before_manifest_publication");
        const input = await this.options.source.build(job);
        const manifest = createArchiveManifest(input);
        if (
          manifest.projectId !== job.projectId ||
          manifest.runGraph.rootRunId !== job.runId ||
          manifest.outcome !== job.outcome ||
          manifest.ledger.firstPosition !== job.firstPosition ||
          manifest.ledger.lastPosition !== job.lastPosition
        ) {
          throw new Error("ARCHIVE_MANIFEST_JOB_MISMATCH");
        }
        receipt = this.options.writer.publish(manifest, this.currentTime().toISOString());
        this.options.fault?.("after_manifest_publication");
        receipt = this.options.store.recordReceipt(
          job,
          receipt,
          this.currentTime(),
        );
      }
      this.options.fault?.("after_archive_receipt");
      const projectionJob: ArchiveKnowledgeProjectionJob = {
        schemaVersion: 1,
        jobId: job.jobId,
        state: "leased",
        attempt: job.attempt,
        ownerId: job.ownerId,
        generation: job.generation,
        acquiredAt: job.acquiredAt,
        expiresAt: job.expiresAt,
        leaseTokenHash: job.leaseTokenHash,
        receipt,
      };
      await this.projector.project(projectionJob);
      return "completed";
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("INJECTED_") ||
          error.message === "ARCHIVE_JOB_LEASE_NOT_CURRENT" ||
          error.message === "KNOWLEDGE_PROJECTION_LEASE_NOT_CURRENT")
      ) {
        throw error;
      }
      this.options.store.markNeedsAttention(job, error, this.currentTime());
      return "needs_attention";
    }
  }

  private currentTime(): Date {
    return this.options.now?.() ?? new Date();
  }
}
