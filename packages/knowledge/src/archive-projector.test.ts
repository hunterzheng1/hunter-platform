import {
  LeaseOwnerIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  type KnowledgeEntryId,
} from "@hunter/domain";
import { describe, expect, it } from "vitest";

import {
  ArchiveKnowledgeProjector,
  validateArchiveKnowledgeProjectionCommit,
  type ArchiveKnowledgeProjectionCommit,
  type ArchiveKnowledgeProjectionCommitResult,
  type ArchiveKnowledgeProjectionJob,
  type DurableKnowledgeProjectionStore,
  type KnowledgeEntry,
  type VerifiedArchiveReceipt,
} from "./index.js";

const projectId = ProjectIdSchema.parse("prj_projection_a");
const otherProjectId = ProjectIdSchema.parse("prj_projection_b");
const runId = RunIdSchema.parse("run_projection_a");
const otherRunId = RunIdSchema.parse("run_projection_b");
const ownerId = LeaseOwnerIdSchema.parse("own_projection_a");
const otherOwnerId = LeaseOwnerIdSchema.parse("own_projection_b");
const manifestHash = "a".repeat(64);
const activeLeaseNow = new Date("2026-07-23T01:30:00.000Z");

function receipt(
  override: Partial<VerifiedArchiveReceipt> = {},
): VerifiedArchiveReceipt {
  return {
    receiptSchemaVersion: 1,
    projectId,
    runId,
    outcome: "failed",
    manifestSchemaVersion: 2,
    manifestHash,
    manifestRef: `cas:sha256:${manifestHash}`,
    verifiedAt: "2026-07-23T01:02:03.000Z",
    ...override,
  };
}

function leasedJob(
  verifiedReceipt: VerifiedArchiveReceipt,
  suffix = "projection_a",
) {
  return {
    schemaVersion: 1 as const,
    jobId: OperationIdSchema.parse(`opn_${suffix}`),
    state: "leased" as const,
    attempt: 1,
    ownerId,
    generation: 1,
    acquiredAt: "2026-07-23T01:00:00.000Z",
    expiresAt: "2026-07-23T02:00:00.000Z",
    leaseTokenHash: "f".repeat(64),
    receipt: verifiedReceipt,
  };
}

class TestOnlyDurableKnowledgeProjectionStore
  implements DurableKnowledgeProjectionStore
{
  readonly byId = new Map<KnowledgeEntryId, KnowledgeEntry>();
  readonly idBySource = new Map<string, KnowledgeEntryId>();
  readonly idByManifest = new Map<string, KnowledgeEntryId>();
  readonly byJob = new Map<
    string,
    { readonly inputFingerprint: string; readonly entryId: KnowledgeEntryId }
  >();
  readonly currentLeases = new Map<
    string,
    {
      readonly state: "leased" | "pending";
      readonly attempt: number;
      readonly ownerId: string;
      readonly generation: number;
      readonly acquiredAt: string;
      readonly expiresAt: string;
      readonly leaseTokenHash: string;
    }
  >();

  constructor(private readonly now: () => Date = () => activeLeaseNow) {}

  setCurrentLease(job: ArchiveKnowledgeProjectionJob): void {
    this.currentLeases.set(job.jobId, {
      state: "leased",
      attempt: job.attempt,
      ownerId: job.ownerId,
      generation: job.generation,
      acquiredAt: job.acquiredAt,
      expiresAt: job.expiresAt,
      leaseTokenHash: job.leaseTokenHash,
    });
  }

  setCurrentLeaseState(
    job: ArchiveKnowledgeProjectionJob,
    override: Partial<{
      readonly state: "leased" | "pending";
      readonly attempt: number;
      readonly ownerId: string;
      readonly generation: number;
      readonly acquiredAt: string;
      readonly expiresAt: string;
      readonly leaseTokenHash: string;
    }>,
  ): void {
    this.setCurrentLease(job);
    const current = this.currentLeases.get(job.jobId);
    if (current === undefined) throw new Error("TEST_LEASE_SETUP_FAILED");
    this.currentLeases.set(job.jobId, { ...current, ...override });
  }

  async commitArchiveProjection(
    input: ArchiveKnowledgeProjectionCommit,
  ): Promise<ArchiveKnowledgeProjectionCommitResult> {
    const commit = validateArchiveKnowledgeProjectionCommit(input);
    const currentLease = this.currentLeases.get(commit.jobId);
    if (
      currentLease === undefined ||
      currentLease.state !== "leased" ||
      currentLease.attempt !== commit.attempt ||
      currentLease.ownerId !== commit.ownerId ||
      currentLease.generation !== commit.generation ||
      currentLease.acquiredAt !== commit.acquiredAt ||
      currentLease.expiresAt !== commit.expiresAt ||
      currentLease.leaseTokenHash !== commit.leaseTokenHash ||
      Date.parse(currentLease.expiresAt) <= this.now().getTime()
    ) {
      throw new Error("KNOWLEDGE_PROJECTION_LEASE_NOT_CURRENT");
    }

    const jobBinding = this.byJob.get(commit.jobId);
    if (jobBinding !== undefined) {
      if (jobBinding.inputFingerprint !== commit.inputFingerprint) {
        throw new Error("KNOWLEDGE_PROJECTION_INPUT_CONFLICT");
      }
      const existing = this.byId.get(jobBinding.entryId);
      if (existing === undefined) {
        throw new Error("KNOWLEDGE_PROJECTION_JOB_RECEIPT_MISSING");
      }
      return {
        jobId: commit.jobId,
        inputFingerprint: commit.inputFingerprint,
        outcome: "existing",
        entry: existing,
      };
    }

    const sourceKey = `${commit.receipt.projectId}\u0000${commit.receipt.runId}`;
    const manifestKey = `${commit.receipt.projectId}\u0000${commit.receipt.manifestHash}`;
    const sourceEntryId = this.idBySource.get(sourceKey);
    const manifestEntryId = this.idByManifest.get(manifestKey);
    const existingId = sourceEntryId ?? manifestEntryId;

    if (
      sourceEntryId !== undefined &&
      manifestEntryId !== undefined &&
      sourceEntryId !== manifestEntryId
    ) {
      throw new Error("KNOWLEDGE_PROJECTION_INDEX_CONFLICT");
    }
    if (existingId !== undefined) {
      const existing = this.byId.get(existingId);
      if (existing === undefined || existing.entryId !== commit.entry.entryId) {
        throw new Error("KNOWLEDGE_PROJECTION_SOURCE_CONFLICT");
      }
      this.byJob.set(commit.jobId, {
        inputFingerprint: commit.inputFingerprint,
        entryId: existing.entryId,
      });
      return {
        jobId: commit.jobId,
        inputFingerprint: commit.inputFingerprint,
        outcome: "existing",
        entry: existing,
      };
    }

    this.byId.set(commit.entry.entryId, commit.entry);
    this.idBySource.set(sourceKey, commit.entry.entryId);
    this.idByManifest.set(manifestKey, commit.entry.entryId);
    this.byJob.set(commit.jobId, {
      inputFingerprint: commit.inputFingerprint,
      entryId: commit.entry.entryId,
    });
    return {
      jobId: commit.jobId,
      inputFingerprint: commit.inputFingerprint,
      outcome: "inserted",
      entry: commit.entry,
    };
  }
}

async function projectWithCurrentLease(
  store: TestOnlyDurableKnowledgeProjectionStore,
  job: ArchiveKnowledgeProjectionJob,
  projector = new ArchiveKnowledgeProjector(store),
) {
  store.setCurrentLease(job);
  return projector.project(job);
}

async function captureProjectionCommit(
  job: ArchiveKnowledgeProjectionJob,
): Promise<ArchiveKnowledgeProjectionCommit> {
  let captured: ArchiveKnowledgeProjectionCommit | undefined;
  const store: DurableKnowledgeProjectionStore = {
    async commitArchiveProjection(commit) {
      captured = commit;
      return {
        jobId: commit.jobId,
        inputFingerprint: commit.inputFingerprint,
        outcome: "inserted",
        entry: commit.entry,
      };
    },
  };
  await new ArchiveKnowledgeProjector(store).project(job);
  if (captured === undefined) throw new Error("TEST_COMMIT_CAPTURE_FAILED");
  return captured;
}

describe("ArchiveKnowledgeProjector", () => {
  it.each(["succeeded", "failed", "canceled"] as const)(
    "projects a verified %s Run as historical knowledge",
    async (outcome) => {
      const store = new TestOnlyDurableKnowledgeProjectionStore();
      const result = await projectWithCurrentLease(
        store,
        leasedJob(receipt({ outcome }), `projection_${outcome}`),
      );

      expect(result).toMatchObject({
        outcome: "inserted",
        entry: {
          level: "historical",
          status: "active",
          scope: { projectId },
          source: {
            type: "archive",
            projectId,
            runId,
            outcome,
            manifestHash,
          },
        },
      });
    },
  );

  it("returns the original entry when a reconstructed worker retries the same job and fingerprint", async () => {
    const store = new TestOnlyDurableKnowledgeProjectionStore();
    const job = leasedJob(receipt());
    const firstProjector = new ArchiveKnowledgeProjector(store);
    const first = await projectWithCurrentLease(store, job, firstProjector);

    const reconstructedProjector = new ArchiveKnowledgeProjector(store);
    const duplicate = await projectWithCurrentLease(
      store,
      job,
      reconstructedProjector,
    );

    expect(duplicate).toEqual({ outcome: "existing", entry: first.entry });
    expect(store.byId).toHaveLength(1);
  });

  it("returns the original source entry for a different valid job carrying the same manifest", async () => {
    const store = new TestOnlyDurableKnowledgeProjectionStore();
    const first = await projectWithCurrentLease(store, leasedJob(receipt()));
    const duplicate = await projectWithCurrentLease(
      store,
      leasedJob(
        receipt({ verifiedAt: "2026-07-23T02:03:04.000Z" }),
        "projection_retry",
      ),
    );

    expect(duplicate).toEqual({ outcome: "existing", entry: first.entry });
    expect(store.byId).toHaveLength(1);
  });

  it("fails closed when the same jobId carries a different verified payload", async () => {
    const store = new TestOnlyDurableKnowledgeProjectionStore();
    const originalJob = leasedJob(receipt());
    await projectWithCurrentLease(store, originalJob);
    const conflictingHash = "b".repeat(64);
    const conflictingJob = leasedJob(
      receipt({
        manifestHash: conflictingHash,
        manifestRef: `cas:sha256:${conflictingHash}`,
      }),
    );

    await expect(
      projectWithCurrentLease(store, conflictingJob),
    ).rejects.toThrow("KNOWLEDGE_PROJECTION_INPUT_CONFLICT");
    expect(store.byId).toHaveLength(1);
  });

  it.each([
    ["attempt", { attempt: 2 }],
    ["lease generation", { generation: 2 }],
    ["lease proof hash", { leaseTokenHash: "e".repeat(64) }],
    ["lease owner takeover", { ownerId: otherOwnerId }],
    ["lease status", { state: "pending" as const }],
  ])("fails closed for a stale %s", async (_label, currentOverride) => {
    const store = new TestOnlyDurableKnowledgeProjectionStore();
    const submittedJob = leasedJob(receipt(), "projection_stale");
    store.setCurrentLeaseState(submittedJob, currentOverride);

    await expect(
      new ArchiveKnowledgeProjector(store).project(submittedJob),
    ).rejects.toThrow("KNOWLEDGE_PROJECTION_LEASE_NOT_CURRENT");
    expect(store.byId).toHaveLength(0);
  });

  it("fails closed when the store-owned clock observes an expired lease", async () => {
    const store = new TestOnlyDurableKnowledgeProjectionStore(
      () => new Date("2026-07-23T02:00:00.000Z"),
    );
    const job = leasedJob(receipt(), "projection_expired");
    store.setCurrentLease(job);

    await expect(
      new ArchiveKnowledgeProjector(store).project(job),
    ).rejects.toThrow("KNOWLEDGE_PROJECTION_LEASE_NOT_CURRENT");
    expect(store.byId).toHaveLength(0);
  });

  it("fails closed when the same Project and source present a different manifest hash", async () => {
    const store = new TestOnlyDurableKnowledgeProjectionStore();
    const projector = new ArchiveKnowledgeProjector(store);
    await projectWithCurrentLease(store, leasedJob(receipt()), projector);

    const conflictingHash = "b".repeat(64);
    await expect(
      projectWithCurrentLease(
        store,
        leasedJob(
          receipt({
            manifestHash: conflictingHash,
            manifestRef: `cas:sha256:${conflictingHash}`,
          }),
          "projection_conflict",
        ),
        projector,
      ),
    ).rejects.toThrow("KNOWLEDGE_PROJECTION_SOURCE_CONFLICT");
  });

  it("fails closed when a durable store returns a mismatched projection", async () => {
    const badStore: DurableKnowledgeProjectionStore = {
      async commitArchiveProjection(commit) {
        return {
          jobId: commit.jobId,
          inputFingerprint: commit.inputFingerprint,
          outcome: "existing",
          entry: {
            ...commit.entry,
            body: "A mismatched persisted projection.",
          },
        };
      },
    };

    await expect(
      new ArchiveKnowledgeProjector(badStore).project(leasedJob(receipt())),
    ).rejects.toThrow("KNOWLEDGE_PROJECTION_RECEIPT_MISMATCH");
  });

  it("fails closed when a durable store returns an invalid commit receipt", async () => {
    const badStore = {
      async commitArchiveProjection(commit: ArchiveKnowledgeProjectionCommit) {
        return {
          jobId: commit.jobId,
          inputFingerprint: commit.inputFingerprint,
          outcome: "upserted",
          entry: commit.entry,
        };
      },
    } as unknown as DurableKnowledgeProjectionStore;

    await expect(
      new ArchiveKnowledgeProjector(badStore).project(leasedJob(receipt())),
    ).rejects.toThrow();
  });

  it.each([
    [
      "receipt Project",
      (commit: ArchiveKnowledgeProjectionCommit) => ({
        ...commit,
        receipt: { ...commit.receipt, projectId: otherProjectId },
      }),
    ],
    [
      "receipt Run",
      (commit: ArchiveKnowledgeProjectionCommit) => ({
        ...commit,
        receipt: { ...commit.receipt, runId: otherRunId },
      }),
    ],
    [
      "manifest hash",
      (commit: ArchiveKnowledgeProjectionCommit) => ({
        ...commit,
        receipt: {
          ...commit.receipt,
          manifestHash: "b".repeat(64),
          manifestRef: `cas:sha256:${"b".repeat(64)}`,
        },
      }),
    ],
    [
      "manifest reference",
      (commit: ArchiveKnowledgeProjectionCommit) => ({
        ...commit,
        receipt: {
          ...commit.receipt,
          manifestRef: `cas:sha256:${"c".repeat(64)}`,
        },
      }),
    ],
    [
      "input fingerprint",
      (commit: ArchiveKnowledgeProjectionCommit) => ({
        ...commit,
        inputFingerprint: "d".repeat(64),
      }),
    ],
    [
      "entry fingerprint",
      (commit: ArchiveKnowledgeProjectionCommit) => ({
        ...commit,
        expectedEntryFingerprint: "e".repeat(64),
      }),
    ],
    [
      "historical entry scope and source",
      (commit: ArchiveKnowledgeProjectionCommit) => ({
        ...commit,
        entry: {
          ...commit.entry,
          scope: { projectId: otherProjectId },
          source: { ...commit.entry.source, projectId: otherProjectId },
        },
      }),
    ],
    [
      "historical entry outcome",
      (commit: ArchiveKnowledgeProjectionCommit) => ({
        ...commit,
        entry:
          commit.entry.level === "historical"
            ? {
                ...commit.entry,
                source: { ...commit.entry.source, outcome: "succeeded" as const },
              }
            : commit.entry,
      }),
    ],
  ])("rejects a tampered %s before any write", async (_label, tamper) => {
    const job = leasedJob(receipt(), "projection_tampered");
    const commit = await captureProjectionCommit(job);
    const store = new TestOnlyDurableKnowledgeProjectionStore();
    store.setCurrentLease(job);

    await expect(
      store.commitArchiveProjection(
        tamper(commit) as ArchiveKnowledgeProjectionCommit,
      ),
    ).rejects.toThrow();
    expect(store.byId).toHaveLength(0);
    expect(store.byJob).toHaveLength(0);
  });

  it("rejects an invalid lease window at the strict commit boundary", async () => {
    const commit = await captureProjectionCommit(
      leasedJob(receipt(), "projection_window"),
    );

    expect(() =>
      validateArchiveKnowledgeProjectionCommit({
        ...commit,
        acquiredAt: "2026-07-23T03:00:00.000Z",
        expiresAt: "2026-07-23T02:00:00.000Z",
      }),
    ).toThrow("LEASE_WINDOW_INVALID");
  });

  it("rejects an unleased, raw, or path-bearing job before the durable store", async () => {
    const store = new TestOnlyDurableKnowledgeProjectionStore();
    const projector = new ArchiveKnowledgeProjector(store);

    await expect(
      projector.project({
        ...leasedJob(receipt()),
        state: "pending",
        receipt: {
          ...receipt(),
          manifestPath: "C:\\private\\manifest.json",
        },
      }),
    ).rejects.toThrow();
    expect(store.byId).toHaveLength(0);
  });
});
