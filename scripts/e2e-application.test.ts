import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentProfileIdSchema,
  ChangeIdSchema,
  ChangeRevisionIdSchema,
  ExecutionPlanIdSchema,
  ProjectIdSchema,
  RequirementIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
  TaskIdSchema,
  WorkflowRevisionIdSchema,
} from "@hunter/domain";
import { describe, expect, it } from "vitest";

import { createVerticalSliceFixture } from "../e2e/fixtures/fake-runtime-scenario.js";
import { createE2eDaemonComposition } from "../apps/daemon/test/fixtures/e2e-application.js";
import { assertOwnedTemporaryDirectory } from "./e2e-runtime.js";

describe("Task 19 authenticated daemon composition", () => {
  it("commits Project and approved Requirement before driving the wired Run", async () => {
    const database = new DatabaseSync(":memory:");
    const temporaryPrefix = join(tmpdir(), "hunter-e2e-application-unit-");
    const dataDirectory = await mkdtemp(temporaryPrefix);
    const projectId = ProjectIdSchema.parse("prj_e2econtract01");
    const requirementId = RequirementIdSchema.parse("req_e2econtract01");
    const revisionId =
      RequirementRevisionIdSchema.parse("rrv_e2econtract01");
    const workflowRevisionId =
      WorkflowRevisionIdSchema.parse("wfr_e2econtract01");
    const composition = createE2eDaemonComposition({
      database,
      fixture: createVerticalSliceFixture(),
      installSecret: "e2e-composition-secret-only",
      dataDirectory,
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
      const createdProject = await composition.app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: headersFor([]),
        payload: {
          projectId,
          name: "Hunter E2E",
          expectedVersion: 0,
          idempotencyKey: "create-project-e2e",
        },
      });
      expect(createdProject.statusCode).toBe(201);

      const projectHeaders = headersFor([projectId]);
      const draft = await composition.app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/requirements`,
        headers: projectHeaders,
        payload: {
          requirementId,
          revisionId,
          title: "移动审批",
          body: "可信设备批准后恢复同一 Run",
          acceptanceCriteria: ["手机批准后恢复 Run"],
          constraints: ["测试壳不接真实 Provider"],
          expectedVersion: 0,
          idempotencyKey: "create-requirement-e2e",
        },
      });
      expect(draft.statusCode).toBe(201);
      const approved = await composition.app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/requirement-revisions/${revisionId}/approve`,
        headers: projectHeaders,
        payload: {
          expectedVersion: 0,
          idempotencyKey: "approve-requirement-e2e",
        },
      });
      expect(approved.statusCode).toBe(200);

      const changeId = ChangeIdSchema.parse("chg_e2econtract01");
      const changeRevisionId =
        ChangeRevisionIdSchema.parse("crv_e2econtract01");
      const executionPlanId =
        ExecutionPlanIdSchema.parse("epl_e2econtract01");
      const taskId = TaskIdSchema.parse("tsk_e2econtract01");
      const published = await composition.app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/changes`,
        headers: projectHeaders,
        payload: {
          changeId,
          changeRevisionId,
          executionPlanId,
          title: "交付移动审批",
          goal: "验证控制面纵向切片",
          nonGoals: ["真实 Provider"],
          requirementRevisionIds: [revisionId],
          repositoryIds: [composition.catalog.repositoryId],
          acceptanceCriteria: ["控制面契约可验证"],
          constraints: ["仅测试壳"],
          risks: ["组合尚未接线"],
          dependsOnChangeRevisionIds: [],
          tasks: [
            {
              taskId,
              title: "控制面契约",
              objective: "验证计划进入 Run 边界",
              acceptanceCriteria: ["到达未接线错误"],
              repositoryIds: [composition.catalog.repositoryId],
              moduleScopes: ["e2e-contract"],
              dependsOn: [],
              readSet: ["contract"],
              writeSet: ["contract-output"],
              access: "write",
              workflowRevisionId,
              defaultAgentProfileId: AgentProfileIdSchema.parse(
                "apr_e2econtract01",
              ),
              sessionPolicy: "new",
              workspacePolicy: {
                mode: "write",
                isolation: "worktree",
                reuse: false,
              },
            },
          ],
          expectedVersion: 0,
          idempotencyKey: "publish-change-e2e",
        },
      });
      expect(published.statusCode).toBe(201);

      const run = await composition.app.inject({
        method: "POST",
        url: "/runs",
        headers: projectHeaders,
        payload: {
          runId: RunIdSchema.parse("run_e2econtract01"),
          executionPlanId,
          workflowRevisionId,
          expectedVersion: 0,
          idempotencyKey: "start-run-e2e-contract",
        },
      });
      expect(run.statusCode).toBe(200);
      await composition.runUntilSettled();
      expect(
        composition.services.flowStore.allRuns().every(
          ({ status }) => status === "succeeded",
        ),
      ).toBe(true);
      expect(
        database
          .prepare(
            "SELECT GROUP_CONCAT(event_type, ',') AS types FROM events WHERE event_type IN ('ProjectCreated','RequirementRevisionApproved') ORDER BY position",
          )
          .get(),
      ).toEqual({
        types: "ProjectCreated,RequirementRevisionApproved",
      });
    } finally {
      await composition.app.close();
      database.close();
      assertOwnedTemporaryDirectory(temporaryPrefix, dataDirectory);
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
