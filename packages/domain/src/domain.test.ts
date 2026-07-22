import { describe, expect, it } from "vitest";

import {
  AgentProfileIdSchema,
  ChangeIdSchema,
  ChangeRevisionIdSchema,
  DeviceBindingIdSchema,
  DeviceIdSchema,
  ExecutionPlanIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RequirementIdSchema,
  RequirementRevisionIdSchema,
  TaskIdSchema,
  WorkflowRevisionIdSchema,
  createChangeRevision,
  createExecutionPlan,
  createProject,
  createRequirementRevision,
  validateTaskGraph,
} from "./index.js";

const ids = {
  project: ProjectIdSchema.parse("prj_platform01"),
  repository: RepositoryIdSchema.parse("rep_primary01"),
  secondaryRepository: RepositoryIdSchema.parse("rep_secondary01"),
  deviceBinding: DeviceBindingIdSchema.parse("dev_binding01"),
  device: DeviceIdSchema.parse("dvc_windows01"),
  requirement: RequirementIdSchema.parse("req_requirement01"),
  requirementRevision: RequirementRevisionIdSchema.parse("rrv_revision01"),
  change: ChangeIdSchema.parse("chg_change001"),
  changeRevision: ChangeRevisionIdSchema.parse("crv_revision01"),
  executionPlan: ExecutionPlanIdSchema.parse("epl_plan0001"),
  task: TaskIdSchema.parse("tsk_task0001"),
  workflowRevision: WorkflowRevisionIdSchema.parse("wfr_workflow01"),
  agentProfile: AgentProfileIdSchema.parse("apr_profile01"),
};

function validTask() {
  return {
    taskId: ids.task,
    title: "实现领域模型",
    objective: "冻结公共领域契约",
    acceptanceCriteria: ["精确测试通过"],
    repositoryIds: [ids.repository],
    moduleScopes: ["packages/domain"],
    dependsOn: [],
    readSet: ["docs/plans"],
    writeSet: ["packages/domain"],
    access: "write" as const,
    workflowRevisionId: ids.workflowRevision,
    defaultAgentProfileId: ids.agentProfile,
    sessionPolicy: "new" as const,
    workspacePolicy: {
      mode: "write" as const,
      isolation: "worktree" as const,
      reuse: false,
    },
  };
}

describe("canonical Foundation domain", () => {
  it("keeps Project identity independent from paths and confines paths to DeviceBinding", () => {
    const project = createProject({
      projectId: ids.project,
      name: "Hunter Platform",
      repositoryBindings: [
        { repositoryId: ids.repository, role: "primary" },
        { repositoryId: ids.secondaryRepository, role: "secondary" },
      ],
      deviceBindings: [
        {
          deviceBindingId: ids.deviceBinding,
          deviceId: ids.device,
          repositoryId: ids.repository,
          localPath: "E:/work/hunter-platform",
          availability: "available",
          lastVerifiedAt: "2026-07-22T00:00:00.000Z",
        },
      ],
    });

    expect(project.projectId).toBe(ids.project);
    expect(project.repositoryBindings.map(({ role }) => role)).toEqual(["primary", "secondary"]);
    expect(project.deviceBindings[0]?.localPath).toBe("E:/work/hunter-platform");
    expect(JSON.stringify(project.repositoryBindings)).not.toContain("E:/work");

    expect(() =>
      createProject({
        projectId: ids.project,
        name: "invalid",
        repositoryBindings: [
          { repositoryId: ids.repository, role: "primary", localPath: "C:/leak" },
        ],
        deviceBindings: [],
      }),
    ).toThrow();
  });

  it("deeply freezes approved requirements and published changes", () => {
    const requirement = createRequirementRevision({
      requirementId: ids.requirement,
      revisionId: ids.requirementRevision,
      projectId: ids.project,
      title: "可恢复 Foundation",
      body: "崩溃后安全恢复。",
      acceptanceCriteria: ["重启不推断成功"],
      constraints: ["provider-neutral"],
      status: "approved",
      approvedAt: "2026-07-22T00:00:00.000Z",
    });
    const change = createChangeRevision({
      changeId: ids.change,
      revisionId: ids.changeRevision,
      projectId: ids.project,
      title: "领域模型",
      goal: "建立规范模型",
      nonGoals: ["不接入真实 Provider"],
      requirementRevisionIds: [ids.requirementRevision],
      repositoryIds: [ids.repository],
      acceptanceCriteria: ["domain tests pass"],
      constraints: ["strict ESM"],
      risks: ["契约漂移"],
      dependsOnChangeRevisionIds: [],
      status: "published",
      publishedAt: "2026-07-22T00:00:00.000Z",
    });

    expect(Object.isFrozen(requirement)).toBe(true);
    expect(Object.isFrozen(requirement.acceptanceCriteria)).toBe(true);
    expect(Object.isFrozen(change)).toBe(true);
    expect(Object.isFrozen(change.nonGoals)).toBe(true);
    expect(JSON.parse(JSON.stringify(change))).toEqual({
      changeId: ids.change,
      revisionId: ids.changeRevision,
      projectId: ids.project,
      title: "领域模型",
      goal: "建立规范模型",
      nonGoals: ["不接入真实 Provider"],
      requirementRevisionIds: [ids.requirementRevision],
      repositoryIds: [ids.repository],
      acceptanceCriteria: ["domain tests pass"],
      constraints: ["strict ESM"],
      risks: ["契约漂移"],
      dependsOnChangeRevisionIds: [],
      status: "published",
      publishedAt: "2026-07-22T00:00:00.000Z",
    });
  });

  it("creates a deeply frozen ExecutionPlan with canonical fingerprints", () => {
    const plan = createExecutionPlan({
      executionPlanId: ids.executionPlan,
      projectId: ids.project,
      changeRevisionId: ids.changeRevision,
      requirementRevisionIds: [ids.requirementRevision],
      tasks: [validTask()],
      publishedAt: "2026-07-22T00:00:00.000Z",
    });

    expect(plan.taskGraphFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.planFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.tasks)).toBe(true);
    expect(Object.isFrozen(plan.tasks[0]?.workspacePolicy)).toBe(true);
    expect(Object.keys(plan)).toEqual([
      "executionPlanId",
      "projectId",
      "changeRevisionId",
      "requirementRevisionIds",
      "tasks",
      "taskGraphFingerprint",
      "planFingerprint",
      "publishedAt",
    ]);
  });

  it.each([
    ["duplicate Task IDs", [validTask(), validTask()]],
    [
      "unknown dependency",
      [{ ...validTask(), dependsOn: [TaskIdSchema.parse("tsk_unknown01")] }],
    ],
    ["empty acceptance criteria", [{ ...validTask(), acceptanceCriteria: [] }]],
    ["write Task with empty writeSet", [{ ...validTask(), writeSet: [] }]],
  ])("rejects %s", (_label, tasks) => {
    expect(() => validateTaskGraph(tasks)).toThrow();
  });

  it("rejects Task cycles", () => {
    const secondId = TaskIdSchema.parse("tsk_task0002");
    expect(() =>
      validateTaskGraph([
        { ...validTask(), dependsOn: [secondId] },
        { ...validTask(), taskId: secondId, dependsOn: [ids.task] },
      ]),
    ).toThrow(/cycle/iu);
  });
});
