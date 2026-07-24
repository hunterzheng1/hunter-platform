import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AgentProfileIdSchema,
  ArtifactIdSchema,
  AttemptIdSchema,
  ChangeIdSchema,
  ChangeRevisionIdSchema,
  ControllerLeaseIdSchema,
  DeviceBindingIdSchema,
  EvidenceIdSchema,
  ExecutionPlanIdSchema,
  LeaseOwnerIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
  StepIdSchema,
  StepRunIdSchema,
  TaskIdSchema,
  WorkflowRevisionIdSchema,
  WorkspaceLeaseIdSchema,
  WriterLeaseIdSchema,
} from "@hunter/domain";
import { SqliteOperationJournal } from "@hunter/storage";
import { afterEach, describe, expect, it } from "vitest";

import {
  ArchiveJobWorker,
  ArchiveManifestSchema,
  ArchiveWriter,
  SqliteArchiveJobStore,
  SqliteKnowledgeCatalog,
  createArchiveManifest,
  verifyArchiveManifest,
  type ArchiveJobFaultPoint,
  type ArchiveManifestInput,
} from "./index.js";

const projectId = ProjectIdSchema.parse("prj_archive_fault");
const runId = RunIdSchema.parse("run_archive_fault");
const ownerId = LeaseOwnerIdSchema.parse("own_archive_fault");
const contentHash = "a".repeat(64);
const capabilityDigest = "b".repeat(64);
const sessionHash = "c".repeat(64);
const receiptHash = "d".repeat(64);

function manifestInput(outcome: "succeeded" | "failed" | "canceled" = "failed"): ArchiveManifestInput {
  return {
    schemaVersion: 1,
    projectId,
    repositories: [{
      repositoryId: RepositoryIdSchema.parse("rep_archive_fault"),
      deviceBindingId: DeviceBindingIdSchema.parse("dev_archive_fault"),
      gitHead: "1".repeat(40),
    }],
    requirementRevisionIds: [
      RequirementRevisionIdSchema.parse("rrv_archive_fault"),
    ],
    change: {
      changeId: ChangeIdSchema.parse("chg_archive_fault"),
      changeRevisionId: ChangeRevisionIdSchema.parse("crv_archive_fault"),
    },
    executionPlanId: ExecutionPlanIdSchema.parse("epl_archive_fault"),
    workflowRevisionId: WorkflowRevisionIdSchema.parse("wfr_archive_fault"),
    runGraph: {
      rootRunId: runId,
      runs: [
        {
          runId,
          parentRunId: null,
          taskId: null,
          outcome,
          steps: [{
            stepRunId: StepRunIdSchema.parse("spr_archive_root"),
            stepId: StepIdSchema.parse("stp_archive_root"),
            attempts: [{
              attemptId: AttemptIdSchema.parse("att_archive_root"),
              agentProfileId: AgentProfileIdSchema.parse("apr_archive_fault"),
              capabilityProbeDigest: capabilityDigest,
              nativeSessionReferenceHash: sessionHash,
              artifacts: [{
                artifactId: ArtifactIdSchema.parse("art_archive_root"),
                contentRef: `cas:sha256:${contentHash}`,
                contentHash,
              }],
              evidence: [{
                evidenceId: EvidenceIdSchema.parse("evd_archive_root"),
                contentRef: `cas:sha256:${contentHash}`,
                contentHash,
              }],
            }],
          }],
        },
        {
          runId: RunIdSchema.parse("run_archive_child"),
          parentRunId: runId,
          taskId: TaskIdSchema.parse("tsk_archive_child"),
          outcome,
          steps: [{
            stepRunId: StepRunIdSchema.parse("spr_archive_child"),
            stepId: StepIdSchema.parse("stp_archive_child"),
            attempts: [{
              attemptId: AttemptIdSchema.parse("att_archive_child"),
              agentProfileId: AgentProfileIdSchema.parse("apr_archive_fault"),
              capabilityProbeDigest: capabilityDigest,
              nativeSessionReferenceHash: sessionHash,
              artifacts: [{
                artifactId: ArtifactIdSchema.parse("art_archive_child"),
                contentRef: `cas:sha256:${contentHash}`,
                contentHash,
              }],
              evidence: [{
                evidenceId: EvidenceIdSchema.parse("evd_archive_child"),
                contentRef: `cas:sha256:${contentHash}`,
                contentHash,
              }],
            }],
          }],
        },
      ],
    },
    leases: {
      workspace: [{
        leaseId: WorkspaceLeaseIdSchema.parse("wsl_archive_fault"),
        repositoryId: RepositoryIdSchema.parse("rep_archive_fault"),
        deviceBindingId: DeviceBindingIdSchema.parse("dev_archive_fault"),
        gitHead: "1".repeat(40),
        receiptHash,
      }],
      writer: [{
        leaseId: WriterLeaseIdSchema.parse("wrl_archive_fault"),
        repositoryId: RepositoryIdSchema.parse("rep_archive_fault"),
        deviceBindingId: DeviceBindingIdSchema.parse("dev_archive_fault"),
        gitHead: "1".repeat(40),
        receiptHash,
      }],
      controller: [{
        leaseId: ControllerLeaseIdSchema.parse("ctl_archive_fault"),
        repositoryId: RepositoryIdSchema.parse("rep_archive_fault"),
        deviceBindingId: DeviceBindingIdSchema.parse("dev_archive_fault"),
        gitHead: "1".repeat(40),
        receiptHash,
      }],
    },
    ledger: { firstPosition: 1, lastPosition: 24 },
    actor: {
      actorId: "archive-test",
      correlationId: "archive-fault",
    },
    timestamps: {
      occurredAt: "2026-07-24T00:00:00.000Z",
      archivedAt: "2026-07-24T00:01:00.000Z",
    },
    outcome,
  };
}

const temporaryRoots = new Set<string>();
const temporaryDatabases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of temporaryDatabases) database.close();
  temporaryDatabases.clear();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

describe("Archive manifest boundary", () => {
  it.each(["succeeded", "failed", "canceled"] as const)(
    "creates and verifies a complete immutable %s manifest",
    (outcome) => {
      const manifest = createArchiveManifest(manifestInput(outcome));

      expect(verifyArchiveManifest(manifest)).toEqual(manifest);
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        projectId,
        outcome,
        runGraph: { rootRunId: runId },
      });
      expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/u);
    },
  );

  it("preserves the parent and Task identity when a child Run is the archive root", () => {
    const input = manifestInput();
    const childRunId = RunIdSchema.parse("run_archive_child_root");
    const manifest = createArchiveManifest({
      ...input,
      runGraph: {
        rootRunId: childRunId,
        runs: [{
          ...input.runGraph.runs[1]!,
          runId: childRunId,
          parentRunId: runId,
        }],
      },
    });

    expect(manifest.runGraph.runs[0]).toMatchObject({
      runId: childRunId,
      parentRunId: runId,
      taskId: TaskIdSchema.parse("tsk_archive_child"),
    });
  });

  it.each([
    ["Project", (manifest: Record<string, unknown>) => {
      const rest = { ...manifest };
      Reflect.deleteProperty(rest, "projectId");
      return rest;
    }],
    ["Attempt edge", (manifest: Record<string, unknown>) => ({
      ...manifest,
      runGraph: {
        ...(manifest.runGraph as object),
        runs: [{
          ...((manifest.runGraph as { runs: Array<Record<string, unknown>> }).runs[0]),
          steps: [{
            ...((manifest.runGraph as { runs: Array<{ steps: Array<Record<string, unknown>> }> }).runs[0]!.steps[0]),
            attempts: [],
          }],
        }],
      },
    })],
    ["Evidence edge", (manifest: Record<string, unknown>) => {
      const runGraph = manifest.runGraph as { runs: Array<{ steps: Array<{ attempts: Array<Record<string, unknown>> }> }> };
      return {
        ...manifest,
        runGraph: {
          ...runGraph,
          runs: [{
            ...runGraph.runs[0],
            steps: [{
              ...runGraph.runs[0]!.steps[0],
              attempts: [{
                ...runGraph.runs[0]!.steps[0]!.attempts[0],
                evidence: [],
              }],
            }],
          }],
        },
      };
    }],
    ["unknown schema", (manifest: Record<string, unknown>) => ({
      ...manifest,
      schemaVersion: 99,
    })],
  ])("rejects a missing or invalid %s", (_label, mutate) => {
    const manifest = createArchiveManifest(manifestInput());
    expect(ArchiveManifestSchema.safeParse(mutate(manifest)).success).toBe(false);
  });

  it("rejects any payload change under the original manifest hash", () => {
    const manifest = createArchiveManifest(manifestInput());
    expect(() => verifyArchiveManifest({
      ...manifest,
      actor: { ...manifest.actor, actorId: "tampered" },
    })).toThrow("ARCHIVE_MANIFEST_HASH_MISMATCH");
  });
});

describe("ArchiveJobWorker crash recovery", () => {
  it.each([
    "before_manifest_publication",
    "after_manifest_publication",
    "after_archive_receipt",
  ] as const)(
    "recovers exactly once after %s",
    async (faultPoint: ArchiveJobFaultPoint) => {
      const root = mkdtempSync(join(tmpdir(), "hunter-archive-fault-"));
      temporaryRoots.add(root);
      const database = new DatabaseSync(join(root, "hunter.sqlite"));
      temporaryDatabases.add(database);
      new SqliteOperationJournal(database);
      const store = new SqliteArchiveJobStore(database);
      const writer = new ArchiveWriter(join(root, "archives"));
      const catalog = new SqliteKnowledgeCatalog(database, () =>
        new Date("2026-07-24T00:02:00.000Z"));
      store.schedule({
        projectId,
        runId,
        outcome: "failed",
        firstPosition: 1,
        lastPosition: 24,
        actorId: "archive-test",
        correlationId: "archive-fault",
        occurredAt: "2026-07-24T00:00:00.000Z",
      });
      const source = { build: () => manifestInput() };
      let injected = false;
      const crashing = new ArchiveJobWorker({
        store,
        writer,
        catalog,
        source,
        ownerId,
        now: () => new Date("2026-07-24T00:01:00.000Z"),
        leaseDurationMs: 1_000,
        fault: (point) => {
          if (!injected && point === faultPoint) {
            injected = true;
            throw new Error(`INJECTED_${faultPoint}`);
          }
        },
      });

      await expect(crashing.runOnce()).rejects.toThrow(`INJECTED_${faultPoint}`);
      const reconstructed = new ArchiveJobWorker({
        store: new SqliteArchiveJobStore(database),
        writer: new ArchiveWriter(join(root, "archives")),
        catalog: new SqliteKnowledgeCatalog(database, () =>
          new Date("2026-07-24T00:03:00.000Z")),
        source,
        ownerId,
        now: () => new Date("2026-07-24T00:03:00.000Z"),
        leaseDurationMs: 1_000,
      });

      await expect(reconstructed.runOnce()).resolves.toBe("completed");
      await expect(reconstructed.runOnce()).resolves.toBe("idle");
      expect(readdirSync(join(root, "archives")).filter((name) =>
        name.endsWith(".json"))).toHaveLength(1);
      expect(database.prepare(
        "SELECT status, attempt_count FROM archive_jobs WHERE project_id = ? AND run_id = ?",
      ).get(projectId, runId)).toEqual({
        status: "completed",
        attempt_count: 2,
      });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM knowledge_entries WHERE project_id = ?",
      ).get(projectId)).toEqual({ count: 1 });
      database.close();
      temporaryDatabases.delete(database);
    },
  );

  it("fails a corrupt durable receipt closed as needs_attention", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-archive-corrupt-"));
    temporaryRoots.add(root);
    const database = new DatabaseSync(join(root, "hunter.sqlite"));
    temporaryDatabases.add(database);
    new SqliteOperationJournal(database);
    const store = new SqliteArchiveJobStore(database);
    const scheduled = store.schedule({
      projectId,
      runId,
      outcome: "failed",
      firstPosition: 1,
      lastPosition: 24,
      actorId: "archive-test",
      correlationId: "archive-corrupt",
      occurredAt: "2026-07-24T00:00:00.000Z",
    });
    database.prepare(
      "UPDATE archive_jobs SET archive_receipt_json = ? WHERE job_id = ?",
    ).run(JSON.stringify({ receiptSchemaVersion: 99 }), scheduled.jobId);
    const worker = new ArchiveJobWorker({
      store,
      writer: new ArchiveWriter(join(root, "archives")),
      catalog: new SqliteKnowledgeCatalog(database),
      source: { build: () => manifestInput() },
      ownerId,
      now: () => new Date("2026-07-24T00:01:00.000Z"),
    });

    await expect(worker.runOnce()).resolves.toBe("needs_attention");
    expect(database.prepare(
      "SELECT status, last_error FROM archive_jobs WHERE job_id = ?",
    ).get(scheduled.jobId)).toMatchObject({
      status: "needs_attention",
      last_error: expect.stringContaining("ARCHIVE_JOB_RECEIPT_INVALID"),
    });
  });
});
