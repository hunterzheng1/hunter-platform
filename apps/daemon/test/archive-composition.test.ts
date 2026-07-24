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
  NativeSessionIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
  StepIdSchema,
  StepRunIdSchema,
  WorkflowIdSchema,
  WorkflowRevisionIdSchema,
  WorkspaceIdSchema,
  WorkspaceLeaseIdSchema,
  WorktreeIdSchema,
  WriterLeaseIdSchema,
  canonicalSha256,
} from "@hunter/domain";
import { CanonicalWorkspaceKeySchema } from "@hunter/runtime-contracts";
import {
  SqliteArchiveJobStore,
  type ArchiveManifestSource,
} from "@hunter/knowledge";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteApplicationServices } from "../src/services/sqlite-application-services.js";

const projectId = ProjectIdSchema.parse("prj_archive_composition");
const runId = RunIdSchema.parse("run_archive_composition");
const ownerId = LeaseOwnerIdSchema.parse("own_archive_composition");
const now = new Date("2026-07-24T02:00:00.000Z");
const contentHash = "a".repeat(64);

const temporaryRoots = new Set<string>();
const temporaryDatabases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of temporaryDatabases) database.close();
  temporaryDatabases.clear();
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

function fixtureSource(): ArchiveManifestSource {
  const repositoryId = RepositoryIdSchema.parse("rep_archive_composition");
  const deviceBindingId = DeviceBindingIdSchema.parse("dev_archive_composition");
  const attemptId = AttemptIdSchema.parse("att_archive_composition");
  const workspaceId = WorkspaceIdSchema.parse("wsp_archive_composition");
  const worktreeId = WorktreeIdSchema.parse("wtr_archive_composition");
  const lease = {
    schemaVersion: 2 as const,
    projectId,
    repositoryId,
    deviceBindingId,
    canonicalWorkspaceKey: CanonicalWorkspaceKeySchema.parse(
      "win32:c:\\hunter\\archive-composition",
    ),
    gitHead: "1".repeat(40),
    branch: "codex/archive-composition",
    ownerRunId: runId,
    ownerAttemptId: attemptId,
    ownerId,
    generation: 1,
    mode: "write" as const,
    acquiredAt: "2026-07-24T01:55:00.000Z",
    expiresAt: "2026-07-24T02:10:00.000Z",
    revokedAt: null,
    revocationReason: null,
    receiptHash: "d".repeat(64),
  };
  return {
    build: (job) => ({
      schemaVersion: 2,
      projectId: job.projectId,
      repositories: [{
        repositoryId,
        deviceBindingId,
        gitHead: "1".repeat(40),
      }],
      requirementRevisionIds: [
        RequirementRevisionIdSchema.parse("rrv_archive_composition"),
      ],
      change: {
        changeId: ChangeIdSchema.parse("chg_archive_composition"),
        changeRevisionId: ChangeRevisionIdSchema.parse("crv_archive_composition"),
      },
      executionPlanId: ExecutionPlanIdSchema.parse("epl_archive_composition"),
      workflowId: WorkflowIdSchema.parse("wfl_archive_composition"),
      workflowRevisionId: WorkflowRevisionIdSchema.parse("wfr_archive_composition"),
      runGraph: {
        rootRunId: job.runId,
        runs: [{
          runId: job.runId,
          parentRunId: null,
          taskId: null,
          outcome: job.outcome,
          steps: [{
            stepRunId: StepRunIdSchema.parse("spr_archive_composition"),
            stepId: StepIdSchema.parse("stp_archive_composition"),
            attempts: [{
              attemptId,
              agentProfileId: AgentProfileIdSchema.parse("apr_archive_composition"),
              capabilityProbeDigest: "b".repeat(64),
              nativeSessionReferenceHash: "c".repeat(64),
              artifacts: [{
                artifactId: ArtifactIdSchema.parse("art_archive_composition"),
                contentRef: `cas:sha256:${contentHash}`,
                contentHash,
              }],
              evidence: [{
                evidenceId: EvidenceIdSchema.parse("evd_archive_composition"),
                contentRef: `cas:sha256:${contentHash}`,
                contentHash,
              }],
            }],
          }],
        }],
      },
      leases: {
        workspace: [{
          ...lease,
          kind: "workspace",
          leaseId: WorkspaceLeaseIdSchema.parse("wsl_archive_composition"),
          scope: { workspaceId },
        }],
        writer: [{
          ...lease,
          kind: "writer",
          leaseId: WriterLeaseIdSchema.parse("wrl_archive_composition"),
          scope: { workspaceId, worktreeId },
        }],
        controller: [{
          ...lease,
          kind: "controller",
          leaseId: ControllerLeaseIdSchema.parse("ctl_archive_composition"),
          scope: {
            workspaceId,
            worktreeId,
            nativeSessionId: NativeSessionIdSchema.parse(
              "ses_archive_composition",
            ),
          },
        }],
      },
      ledger: {
        firstPosition: job.firstPosition,
        lastPosition: job.lastPosition,
      },
      actor: {
        actorId: job.actorId,
        correlationId: job.correlationId,
      },
      timestamps: {
        occurredAt: job.occurredAt,
        archivedAt: now.toISOString(),
      },
      outcome: job.outcome,
    }),
  };
}

function createServices(database: DatabaseSync, root: string) {
  return createSqliteApplicationServices({
    database,
    externalHandler: {
      execute: async () => {
        throw new Error("EXTERNAL_OPERATION_NOT_EXPECTED");
      },
    },
    installSecret: "archive-composition-test",
    allowedHosts: ["hunter-test.localhost"],
    allowedOrigins: ["app://hunter"],
    now: () => now,
    archive: {
      root,
      source: fixtureSource(),
      ownerId,
      leaseDurationMs: 30_000,
    },
  });
}

function commitFlowEvent(
  services: ReturnType<typeof createServices>,
  input: {
    readonly commandId: string;
    readonly expectedVersion: number;
    readonly eventId: string;
    readonly flowEvent: unknown;
  },
) {
  return services.journal.commitCommand({
    commandId: input.commandId,
    requestFingerprint: canonicalSha256(input),
    projectId,
    aggregateId: `run:${runId}`,
    expectedVersion: input.expectedVersion,
    actor: {
      actorId: "archive-composition-test",
      correlationId: "archive-composition",
    },
    events: [{
      eventId: input.eventId,
      eventType: "FlowEvent",
      eventData: { flowEvent: input.flowEvent },
      schemaVersion: 1,
      occurredAt: now.toISOString(),
    }],
    operations: [],
    response: {},
  });
}

describe("archive application composition", () => {
  it("atomically schedules a terminal Run and resumes to one manifest and one Knowledge entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-archive-composition-"));
    temporaryRoots.add(root);
    const databasePath = join(root, "hunter.sqlite");
    let database = new DatabaseSync(databasePath);
    temporaryDatabases.add(database);
    let services = createServices(database, root);

    commitFlowEvent(services, {
      commandId: "archive-start",
      expectedVersion: 0,
      eventId: "evt_archive_start",
      flowEvent: { type: "RunStarted" },
    });
    const terminal = commitFlowEvent(services, {
      commandId: "archive-terminal",
      expectedVersion: 1,
      eventId: "evt_archive_terminal",
      flowEvent: { type: "RunConcluded", status: "failed" },
    });

    expect(database.prepare(
      "SELECT status, first_position, last_position FROM archive_jobs WHERE project_id = ? AND run_id = ?",
    ).get(projectId, runId)).toEqual({
      status: "pending",
      first_position: 1,
      last_position: 2,
    });
    expect(terminal).toMatchObject({ firstPosition: 2, lastPosition: 2 });

    database.close();
    temporaryDatabases.delete(database);
    database = new DatabaseSync(databasePath);
    temporaryDatabases.add(database);
    services = createServices(database, root);

    await expect(services.archiveWorker?.runOnce()).resolves.toBe("completed");
    await expect(services.archiveWorker?.runOnce()).resolves.toBe("idle");
    expect(readdirSync(join(root, "archives")).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    await expect(services.knowledgeCatalog?.listByProject(projectId)).resolves.toHaveLength(1);
    expect(database.prepare(
      "SELECT status, attempt_count FROM archive_jobs WHERE project_id = ? AND run_id = ?",
    ).get(projectId, runId)).toEqual({ status: "completed", attempt_count: 1 });
  });

  it("rolls back the terminal event when the archive schedule conflicts", () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-archive-atomic-"));
    temporaryRoots.add(root);
    const database = new DatabaseSync(join(root, "hunter.sqlite"));
    temporaryDatabases.add(database);
    const services = createServices(database, root);

    commitFlowEvent(services, {
      commandId: "atomic-start",
      expectedVersion: 0,
      eventId: "evt_atomic_start",
      flowEvent: { type: "RunStarted" },
    });
    new SqliteArchiveJobStore(database).schedule({
      projectId,
      runId,
      outcome: "failed",
      firstPosition: 1,
      lastPosition: 99,
      actorId: "conflicting-writer",
      correlationId: "conflicting-schedule",
      occurredAt: now.toISOString(),
    });

    expect(() => commitFlowEvent(services, {
      commandId: "atomic-terminal",
      expectedVersion: 1,
      eventId: "evt_atomic_terminal",
      flowEvent: { type: "RunConcluded", status: "failed" },
    })).toThrow("ARCHIVE_JOB_INPUT_CONFLICT");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE aggregate_id = ?",
    ).get(`run:${runId}`)).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM command_receipts WHERE command_id = ?",
    ).get("atomic-terminal")).toEqual({ count: 0 });
  });

  it("does not archive a needs_attention observation as a terminal outcome", () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-archive-attention-"));
    temporaryRoots.add(root);
    const database = new DatabaseSync(join(root, "hunter.sqlite"));
    temporaryDatabases.add(database);
    const services = createServices(database, root);

    commitFlowEvent(services, {
      commandId: "attention-conclusion",
      expectedVersion: 0,
      eventId: "evt_attention_conclusion",
      flowEvent: { type: "RunConcluded", status: "needs_attention" },
    });

    expect(database.prepare("SELECT COUNT(*) AS count FROM archive_jobs").get()).toEqual({ count: 0 });
  });
});
