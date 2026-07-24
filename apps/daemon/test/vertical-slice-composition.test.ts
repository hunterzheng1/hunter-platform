import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AgentProfileIdSchema,
  ChangeIdSchema,
  ChangeRevisionIdSchema,
  ExecutionPlanIdSchema,
  NativeSessionIdSchema,
  ProjectIdSchema,
  RequirementIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
  RuntimeProviderIdSchema,
  TaskIdSchema,
  WorkflowRevisionIdSchema,
} from "@hunter/domain";
import { FakeRuntime } from "@hunter/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { createE2eDaemonComposition } from "./fixtures/e2e-application.js";

const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

describe("production vertical-slice composition", () => {
  it("drives authenticated domain APIs through Flow, Fake Runtime, verification, Archive, Knowledge, and replay", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "hunter-vertical-composition-"));
    temporaryRoots.add(dataDirectory);
    const workspaceDirectory = join(dataDirectory, "workspace");
    mkdirSync(workspaceDirectory);
    execFileSync("git", ["-C", workspaceDirectory, "init", "--quiet"]);
    execFileSync("git", ["-C", workspaceDirectory, "config", "user.name", "Hunter Test"]);
    execFileSync("git", ["-C", workspaceDirectory, "config", "user.email", "hunter-test@example.invalid"]);
    execFileSync("git", ["-C", workspaceDirectory, "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
    const workspaceGitHead = execFileSync(
      "git",
      ["-C", workspaceDirectory, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const workspaceIdentity = {
      path: workspaceDirectory,
      gitHead: workspaceGitHead,
    };
    const databasePath = join(dataDirectory, "hunter.sqlite");
    const fixtures: Array<{
      readonly proofScope: "hunter_contract_only";
      readonly runtime: FakeRuntime;
      readonly verifier: {
        verify(): Promise<{
          readonly status: "failed" | "passed";
          readonly evidence: readonly [{
            readonly kind: "test";
            readonly command: "npm test";
            readonly exitCode: 0 | 1;
            readonly proofScope: "hunter_contract_only";
          }];
        }>;
      };
    }> = [];
    const createFixture = () => {
      let verificationCount = 0;
      const fixture = {
        proofScope: "hunter_contract_only" as const,
        runtime: new FakeRuntime({
          providerId: RuntimeProviderIdSchema.parse("rtp_e2econtract01"),
          implementationVersion: "deterministic-contract-fixture-v1",
          observedAt: "2026-07-23T00:00:00.000Z",
        }),
        verifier: {
          verify: async () => {
            verificationCount += 1;
            const failed = verificationCount === 1;
            return {
              status: failed ? "failed" as const : "passed" as const,
              evidence: [{
                kind: "test" as const,
                command: "npm test" as const,
                exitCode: failed ? 1 as const : 0 as const,
                proofScope: "hunter_contract_only" as const,
              }] as const,
            };
          },
        },
      };
      fixtures.push(fixture);
      return fixture;
    };
    let database = new DatabaseSync(databasePath);
    const projectId = ProjectIdSchema.parse("prj_vertical_slice");
    const requirementId = RequirementIdSchema.parse("req_vertical_slice");
    const revisionId = RequirementRevisionIdSchema.parse("rrv_vertical_slice");
    const changeId = ChangeIdSchema.parse("chg_vertical_slice");
    const changeRevisionId = ChangeRevisionIdSchema.parse("crv_vertical_slice");
    const executionPlanId = ExecutionPlanIdSchema.parse("epl_vertical_slice");
    const taskId = TaskIdSchema.parse("tsk_vertical_slice");
    const secondTaskId = TaskIdSchema.parse("tsk_vertical_second");
    const rootRunId = RunIdSchema.parse("run_vertical_slice");
    const workflowRevisionId = WorkflowRevisionIdSchema.parse("wfr_e2econtract01");
    let composition = createE2eDaemonComposition({
      database,
      fixture: createFixture(),
      installSecret: "vertical-composition-only",
      dataDirectory,
      workspaceIdentity,
      allowedHosts: ["hunter-e2e.localhost"],
      allowedOrigins: ["http://127.0.0.1:4173"],
    });
    const headersFor = (projectIds: readonly typeof projectId[]) => ({
      host: "hunter-e2e.localhost",
      origin: "http://127.0.0.1:4173",
      authorization: `Bearer ${composition.issueSession(projectIds)}`,
      "x-csrf-token": composition.daemonCsrf,
      "content-type": "application/json",
    });

    try {
      expect((await composition.app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: headersFor([]),
        payload: {
          projectId,
          name: "Vertical Slice",
          expectedVersion: 0,
          idempotencyKey: "vertical-project",
        },
      })).statusCode).toBe(201);
      const headers = headersFor([projectId]);
      expect((await composition.app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/requirements`,
        headers,
        payload: {
          requirementId,
          revisionId,
          title: "Durable vertical slice",
          body: "Run through every production boundary.",
          acceptanceCriteria: ["Failed verification is retained before retry."],
          constraints: ["Fake proves Hunter contracts only."],
          expectedVersion: 0,
          idempotencyKey: "vertical-requirement",
        },
      })).statusCode).toBe(201);
      expect((await composition.app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/requirement-revisions/${revisionId}/approve`,
        headers,
        payload: {
          expectedVersion: 0,
          idempotencyKey: "vertical-approve",
        },
      })).statusCode).toBe(200);
      expect((await composition.app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/changes`,
        headers,
        payload: {
          changeId,
          changeRevisionId,
          executionPlanId,
          title: "Deliver vertical slice",
          goal: "Prove production composition.",
          nonGoals: ["Real Provider validation."],
          requirementRevisionIds: [revisionId],
          repositoryIds: [composition.catalog.repositoryId],
          acceptanceCriteria: ["Archive and Knowledge survive restart."],
          constraints: ["Project scope is mandatory."],
          risks: ["Crash between durable stages."],
          dependsOnChangeRevisionIds: [],
          tasks: [
            {
              taskId,
              title: "Execute fake contract",
              objective: "Fail verification once, then pass.",
              acceptanceCriteria: ["Two Attempts are retained."],
              repositoryIds: [composition.catalog.repositoryId],
              moduleScopes: ["vertical-slice"],
              dependsOn: [],
              readSet: ["contract"],
              writeSet: ["contract-output"],
              access: "write",
              workflowRevisionId,
              defaultAgentProfileId: AgentProfileIdSchema.parse("apr_e2econtract01"),
              sessionPolicy: "new",
              workspacePolicy: {
                mode: "write",
                isolation: "worktree",
                reuse: false,
              },
            },
            {
              taskId: secondTaskId,
              title: "Execute dependent fake contract",
              objective: "Pass after the first task.",
              acceptanceCriteria: ["One verified Attempt is retained."],
              repositoryIds: [composition.catalog.repositoryId],
              moduleScopes: ["vertical-slice-dependent"],
              dependsOn: [taskId],
              readSet: ["contract-output"],
              writeSet: ["dependent-output"],
              access: "write",
              workflowRevisionId,
              defaultAgentProfileId: AgentProfileIdSchema.parse("apr_e2econtract01"),
              sessionPolicy: "new",
              workspacePolicy: {
                mode: "write",
                isolation: "worktree",
                reuse: false,
              },
            },
          ],
          expectedVersion: 0,
          idempotencyKey: "vertical-change",
        },
      })).statusCode).toBe(201);

      const cursor = composition.services.eventReader.highWaterPosition();
      const started = await composition.app.inject({
        method: "POST",
        url: "/runs",
        headers,
        payload: {
          runId: rootRunId,
          executionPlanId,
          workflowRevisionId,
          expectedVersion: 0,
          idempotencyKey: "vertical-run",
        },
      });
      expect(started.statusCode).toBe(200);

      const launchCheckpoint = await composition.runUntilLaunchReceipt();
      expect(launchCheckpoint.operationId).toMatch(/^opn_/u);
      expect(launchCheckpoint.operationIds).toHaveLength(1);
      expect(fixtures[0]?.runtime.nativeEffectCount).toBe(1);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM side_effect_receipts WHERE operation_id = ?",
      ).get(launchCheckpoint.operationId)).toEqual({ count: 1 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM lease_records WHERE lease_kind = 'controller'",
      ).get()).toEqual({ count: 1 });
      const launchReceipt = JSON.parse((
        database.prepare(
          "SELECT provider_receipt_json FROM side_effect_receipts WHERE operation_id = ?",
        ).get(launchCheckpoint.operationId) as { provider_receipt_json: string }
      ).provider_receipt_json) as {
        nativeReferences: Array<{ kind: string; referenceId: string }>;
      };
      const nativeSessionId = launchReceipt.nativeReferences.find(
        ({ kind }) => kind === "session",
      )?.referenceId;
      if (nativeSessionId === undefined) throw new Error("TEST_SESSION_ID_MISSING");
      const parsedNativeSessionId = NativeSessionIdSchema.parse(nativeSessionId);
      expect(
        await composition.services.leaseService.findActiveController(
          projectId,
          parsedNativeSessionId,
        ),
      ).not.toBeNull();

      await composition.app.close();
      database.close();
      database = new DatabaseSync(databasePath);
      let archiveCrashPending = true;
      composition = createE2eDaemonComposition({
        database,
        fixture: createFixture(),
        installSecret: "vertical-composition-only",
        dataDirectory,
        workspaceIdentity,
        allowedHosts: ["hunter-e2e.localhost"],
        allowedOrigins: ["http://127.0.0.1:4173"],
        archiveFault: (point) => {
          if (point === "after_archive_receipt" && archiveCrashPending) {
            archiveCrashPending = false;
            throw new Error("INJECTED_AFTER_ARCHIVE_RECEIPT");
          }
        },
      });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM lease_records WHERE lease_kind = 'controller'",
      ).get()).toEqual({ count: 1 });
      expect(
        await composition.services.leaseService.findActiveController(
          projectId,
          parsedNativeSessionId,
        ),
      ).not.toBeNull();
      await composition.services.recovery.run();
      const recoveryFacts = composition.services.flowStore
        .loadRun(launchCheckpoint.childRunId)
        ?.recoveryFacts ?? [];
      expect(recoveryFacts.length).toBeGreaterThan(0);
      expect(recoveryFacts.every(({ status }) => status === "observed")).toBe(true);
      await expect(composition.runUntilSettled()).rejects.toThrow(
        "INJECTED_AFTER_ARCHIVE_RECEIPT",
      );
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM side_effect_receipts",
      ).get()).toEqual({ count: 4 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM archive_jobs WHERE archive_receipt_json IS NOT NULL",
      ).get()).toEqual({ count: 1 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM knowledge_entries",
      ).get()).toEqual({ count: 0 });

      await composition.app.close();
      database.close();
      database = new DatabaseSync(databasePath);
      composition = createE2eDaemonComposition({
        database,
        fixture: createFixture(),
        installSecret: "vertical-composition-only",
        dataDirectory,
        workspaceIdentity,
        allowedHosts: ["hunter-e2e.localhost"],
        allowedOrigins: ["http://127.0.0.1:4173"],
        now: () => new Date("2026-07-23T00:00:31.000Z"),
      });
      await composition.services.recovery.run();
      await composition.drainArchiveAndKnowledge();
      const resumedHeaders = headersFor([projectId]);

      const states = composition.services.flowStore.allRuns();
      expect(states).toHaveLength(3);
      expect(states.every(({ status }) => status === "succeeded")).toBe(true);
      const attemptsPerChild = states
        .filter(({ binding }) => binding.subjectKind === "task")
        .map(({ steps }) => steps[0]?.attempts.length)
        .sort();
      expect(attemptsPerChild).toEqual([1, 2]);
      expect(
        database.prepare(
          "SELECT COUNT(*) AS count FROM outbox WHERE json_extract(operation_json, '$.operationType') = 'session.launch'",
        ).get(),
      ).toEqual({ count: 3 });
      expect(fixtures[1]?.runtime.nativeEffectCount).toBe(3);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM archive_jobs WHERE status = 'completed'",
      ).get()).toEqual({ count: 3 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM knowledge_entries WHERE project_id = ?",
      ).get(projectId)).toEqual({ count: 3 });
      const knowledge = await composition.app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/knowledge?includeHistorical=true`,
        headers: resumedHeaders,
      });
      expect(knowledge.statusCode).toBe(200);
      expect(knowledge.json()).toMatchObject({
        projectId,
        entries: [
          { level: "historical" },
          { level: "historical" },
          { level: "historical" },
        ],
      });

      const replay = await composition.app.inject({
        method: "GET",
        url: `/events?once=1&cursor=${cursor}`,
        headers: resumedHeaders,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.body).toContain("RunConcluded");
    } finally {
      await composition.app.close();
      database.close();
    }
  }, 20_000);
});
