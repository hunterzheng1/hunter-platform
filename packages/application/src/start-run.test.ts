import {
  ChangeIdSchema,
  ChangeRevisionIdSchema,
  DeviceBindingIdSchema,
  DeviceIdSchema,
  ExecutionPlanIdSchema,
  ProjectIdSchema,
  RequirementIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
  RepositoryIdSchema,
  WorkflowRevisionIdSchema,
  createChangeRevision,
  createExecutionPlan,
  createProject,
  createRequirementRevision,
  createWorkflowRevision,
} from "@hunter/domain";
import { describe, expect, it, vi } from "vitest";

import { validWorkflowInput } from "../../domain/src/workflow-test-fixtures.js";
import { StartRunService } from "./start-run.js";

const projectId = ProjectIdSchema.parse("prj_platform01");
const executionPlanId = ExecutionPlanIdSchema.parse("epl_plan0001");
const workflowRevisionId = WorkflowRevisionIdSchema.parse("wfr_workflow01");
const requirementRevisionId = RequirementRevisionIdSchema.parse("rrv_revision01");
const changeRevisionId = ChangeRevisionIdSchema.parse("crv_revision01");

function fixtures() {
  const project = createProject({
    projectId,
    name: "Hunter",
    repositoryBindings: [
      { repositoryId: RepositoryIdSchema.parse("rep_primary01"), role: "primary" },
    ],
    deviceBindings: [
      {
        deviceBindingId: DeviceBindingIdSchema.parse("dev_binding01"),
        deviceId: DeviceIdSchema.parse("dvc_windows01"),
        repositoryId: RepositoryIdSchema.parse("rep_primary01"),
        localPath: "E:/work/hunter",
        availability: "available",
      },
    ],
  });
  const requirement = createRequirementRevision({
    requirementId: RequirementIdSchema.parse("req_requirement01"),
    revisionId: requirementRevisionId,
    projectId,
    title: "Foundation",
    body: "Build it",
    acceptanceCriteria: ["verified"],
    constraints: [],
    status: "approved",
    approvedAt: "2026-07-22T00:00:00.000Z",
  });
  const change = createChangeRevision({
    changeId: ChangeIdSchema.parse("chg_change001"),
    revisionId: changeRevisionId,
    projectId,
    title: "Foundation",
    goal: "Run it",
    nonGoals: [],
    requirementRevisionIds: [requirementRevisionId],
    repositoryIds: ["rep_primary01"],
    acceptanceCriteria: ["verified"],
    constraints: [],
    risks: [],
    dependsOnChangeRevisionIds: [],
    status: "published",
    publishedAt: "2026-07-22T01:00:00.000Z",
  });
  const workflow = createWorkflowRevision({
    ...validWorkflowInput(),
    workflowRevisionId,
  });
  const plan = createExecutionPlan({
    executionPlanId,
    projectId,
    changeRevisionId,
    requirementRevisionIds: [requirementRevisionId],
    tasks: [
      {
        taskId: "tsk_task0001",
        title: "Task",
        objective: "Implement",
        acceptanceCriteria: ["verified"],
        repositoryIds: ["rep_primary01"],
        moduleScopes: ["packages/flow-engine"],
        dependsOn: [],
        readSet: [],
        writeSet: ["packages/flow-engine"],
        access: "write",
        workflowRevisionId,
        defaultAgentProfileId: "apr_profile01",
        sessionPolicy: "new",
        workspacePolicy: { mode: "write", isolation: "worktree", reuse: false },
      },
    ],
    publishedAt: "2026-07-22T01:00:00.000Z",
  });
  return { project, requirement, change, workflow, plan };
}

describe("StartRunService", () => {
  it("derives the immutable root binding and delegates only to FlowEngine", () => {
    const { project, requirement, change, workflow, plan } = fixtures();
    const handle = vi.fn((command: unknown) => {
      void command;
      return {
        commandId: "start:one",
        response: { started: true },
      };
    });
    const service = new StartRunService(
      {
        getProject: () => project,
        getExecutionPlan: () => plan,
        getChangeRevision: () => change,
        getRequirementRevision: () => requirement,
        getWorkflowRevision: () => workflow,
        getEffectivePolicySnapshot: () => ({ snapshotHash: "a".repeat(64), policyVersion: 1 }),
        getRunBudgetLimit: () => ({
          maxAttempts: 5,
          maxElapsedMs: 60_000,
          maxCost: 100,
          maxTokens: 10_000,
          maxLoopIterations: 3,
        }),
      },
      { handle },
    );
    const command = {
      runId: RunIdSchema.parse("run_root00001"),
      executionPlanId,
      workflowRevisionId,
      expectedVersion: 0,
      idempotencyKey: "start-run-0001",
    };

    service.execute(command, { actorId: "user", correlationId: "start" });
    expect(handle).toHaveBeenCalledOnce();
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      type: "StartRun",
      expectedVersion: 0,
      idempotencyKey: "start-run-0001",
      binding: {
        subjectKind: "change",
        projectId,
        changeRevisionId,
        requirementRevisionIds: [requirementRevisionId],
        executionPlanId,
        taskGraphFingerprint: plan.taskGraphFingerprint,
      },
    });
  });

  it("rejects caller-authored Project, Requirement, Change, policy, budget, or path fields", () => {
    const { project, requirement, change, workflow, plan } = fixtures();
    const handle = vi.fn();
    const service = new StartRunService(
      {
        getProject: () => project,
        getExecutionPlan: () => plan,
        getChangeRevision: () => change,
        getRequirementRevision: () => requirement,
        getWorkflowRevision: () => workflow,
        getEffectivePolicySnapshot: () => ({ snapshotHash: "a".repeat(64), policyVersion: 1 }),
        getRunBudgetLimit: () => ({
          maxAttempts: 5,
          maxElapsedMs: 60_000,
          maxCost: 100,
          maxTokens: 10_000,
          maxLoopIterations: 3,
        }),
      },
      { handle },
    );
    expect(() =>
      service.execute(
        {
          runId: "run_root00001",
          executionPlanId,
          workflowRevisionId,
          expectedVersion: 0,
          idempotencyKey: "start-run-0001",
          projectId,
          requirementRevisionIds: [requirementRevisionId],
          policySnapshot: { snapshotHash: "fake" },
          initialBudget: { maxAttempts: 999 },
          absolutePath: "C:/outside",
        },
        { actorId: "user", correlationId: "start" },
      ),
    ).toThrow();
    expect(handle).not.toHaveBeenCalled();
  });

  it("fails closed when published/approved references do not match the plan", () => {
    const { project, requirement, change, workflow, plan } = fixtures();
    const handle = vi.fn();
    const service = new StartRunService(
      {
        getProject: () => project,
        getExecutionPlan: () => plan,
        getChangeRevision: () => change,
        getRequirementRevision: () => ({ ...requirement, status: "withdrawn" as const }),
        getWorkflowRevision: () => workflow,
        getEffectivePolicySnapshot: () => ({ snapshotHash: "a".repeat(64), policyVersion: 1 }),
        getRunBudgetLimit: () => ({
          maxAttempts: 5,
          maxElapsedMs: 60_000,
          maxCost: 100,
          maxTokens: 10_000,
          maxLoopIterations: 3,
        }),
      },
      { handle },
    );
    expect(() =>
      service.execute(
        {
          runId: "run_root00001",
          executionPlanId,
          workflowRevisionId,
          expectedVersion: 0,
          idempotencyKey: "start-run-0001",
        },
        { actorId: "user", correlationId: "start" },
      ),
    ).toThrow(/REQUIREMENT/u);
    expect(handle).not.toHaveBeenCalled();
  });
});
