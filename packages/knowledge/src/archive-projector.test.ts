import {
  OperationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  type KnowledgeEntryId,
} from "@hunter/domain";
import { describe, expect, it } from "vitest";

import {
  ArchiveKnowledgeProjector,
  type ArchiveKnowledgeProjectionCommit,
  type ArchiveKnowledgeProjectionCommitResult,
  type ArchiveKnowledgeProjectionJob,
  type DurableKnowledgeProjectionStore,
  type KnowledgeEntry,
  type VerifiedArchiveReceipt,
} from "./index.js";

const projectId = ProjectIdSchema.parse("prj_projection_a");
const runId = RunIdSchema.parse("run_projection_a");
const manifestHash = "a".repeat(64);

function receipt(
  override: Partial<VerifiedArchiveReceipt> = {},
): VerifiedArchiveReceipt {
  return {
    receiptSchemaVersion: 1,
    projectId,
    runId,
    outcome: "failed",
    manifestSchemaVersion: 1,
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
    leaseGeneration: 1,
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
      readonly attempt: number;
      readonly leaseGeneration: number;
      readonly leaseTokenHash: string;
    }
  >();

  setCurrentLease(job: ArchiveKnowledgeProjectionJob): void {
    this.currentLeases.set(job.jobId, {
      attempt: job.attempt,
      leaseGeneration: job.leaseGeneration,
      leaseTokenHash: job.leaseTokenHash,
    });
  }

  async commitArchiveProjection(
    commit: ArchiveKnowledgeProjectionCommit,
  ): Promise<ArchiveKnowledgeProjectionCommitResult> {
    const currentLease = this.currentLeases.get(commit.jobId);
    if (
      currentLease === undefined ||
      currentLease.attempt !== commit.attempt ||
      currentLease.leaseGeneration !== commit.leaseGeneration ||
      currentLease.leaseTokenHash !== commit.leaseTokenHash
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

    const sourceEntryId = this.idBySource.get(commit.sourceKey);
    const manifestEntryId = this.idByManifest.get(commit.manifestKey);
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
    this.idBySource.set(commit.sourceKey, commit.entry.entryId);
    this.idByManifest.set(commit.manifestKey, commit.entry.entryId);
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
    ["lease generation", { leaseGeneration: 2 }],
    ["lease proof hash", { leaseTokenHash: "e".repeat(64) }],
  ])("fails closed for a stale %s", async (_label, currentOverride) => {
    const store = new TestOnlyDurableKnowledgeProjectionStore();
    const submittedJob = leasedJob(receipt(), "projection_stale");
    store.setCurrentLease({ ...submittedJob, ...currentOverride });

    await expect(
      new ArchiveKnowledgeProjector(store).project(submittedJob),
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
