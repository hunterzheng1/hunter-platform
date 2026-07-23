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

  async commitArchiveProjection(
    commit: ArchiveKnowledgeProjectionCommit,
  ): Promise<ArchiveKnowledgeProjectionCommitResult> {
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
      return { outcome: "existing", entry: existing };
    }

    this.byId.set(commit.entry.entryId, commit.entry);
    this.idBySource.set(commit.sourceKey, commit.entry.entryId);
    this.idByManifest.set(commit.manifestKey, commit.entry.entryId);
    return { outcome: "inserted", entry: commit.entry };
  }
}

describe("ArchiveKnowledgeProjector", () => {
  it.each(["succeeded", "failed", "canceled"] as const)(
    "projects a verified %s Run as historical knowledge",
    async (outcome) => {
      const store = new TestOnlyDurableKnowledgeProjectionStore();
      const result = await new ArchiveKnowledgeProjector(store).project(
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

  it("returns the original entry for the same Project, source, and verified manifest", async () => {
    const store = new TestOnlyDurableKnowledgeProjectionStore();
    const firstProjector = new ArchiveKnowledgeProjector(store);
    const first = await firstProjector.project(leasedJob(receipt()));

    const reconstructedProjector = new ArchiveKnowledgeProjector(store);
    const duplicate = await reconstructedProjector.project(
      leasedJob(
        receipt({ verifiedAt: "2026-07-23T02:03:04.000Z" }),
        "projection_retry",
      ),
    );

    expect(duplicate).toEqual({ outcome: "existing", entry: first.entry });
    expect(store.byId).toHaveLength(1);
  });

  it("fails closed when the same Project and source present a different manifest hash", async () => {
    const store = new TestOnlyDurableKnowledgeProjectionStore();
    const projector = new ArchiveKnowledgeProjector(store);
    await projector.project(leasedJob(receipt()));

    const conflictingHash = "b".repeat(64);
    await expect(
      projector.project(
        leasedJob(
          receipt({
            manifestHash: conflictingHash,
            manifestRef: `cas:sha256:${conflictingHash}`,
          }),
          "projection_conflict",
        ),
      ),
    ).rejects.toThrow("KNOWLEDGE_PROJECTION_SOURCE_CONFLICT");
  });

  it("fails closed when a durable store returns a mismatched projection", async () => {
    const badStore: DurableKnowledgeProjectionStore = {
      async commitArchiveProjection(commit) {
        return {
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
        return { outcome: "upserted", entry: commit.entry };
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
