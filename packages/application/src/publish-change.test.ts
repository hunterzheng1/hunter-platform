import { DatabaseSync } from "node:sqlite";

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
  createProject,
  createRequirementRevision,
  createWorkflowRevision,
  type ChangeRevision,
  type ExecutionPlan,
  type TaskDefinition,
} from "@hunter/domain";
import { afterEach, describe, expect, it } from "vitest";

import { validWorkflowInput } from "../../domain/src/workflow-test-fixtures.js";
import { SqliteOperationJournal } from "../../storage/src/sqlite-operation-journal.js";
import { PublishChangeService } from "./publish-change.js";

const ids = {
  project: ProjectIdSchema.parse("prj_platform01"),
  otherProject: ProjectIdSchema.parse("prj_platform02"),
  repository: RepositoryIdSchema.parse("rep_primary01"),
  otherRepository: RepositoryIdSchema.parse("rep_outside001"),
  requirement: RequirementIdSchema.parse("req_requirement01"),
  requirementRevision: RequirementRevisionIdSchema.parse("rrv_revision01"),
  change: ChangeIdSchema.parse("chg_change001"),
  changeRevision: ChangeRevisionIdSchema.parse("crv_revision01"),
  executionPlan: ExecutionPlanIdSchema.parse("epl_plan0001"),
  workflowRevision: WorkflowRevisionIdSchema.parse("wfr_workflow01"),
  agentProfile: AgentProfileIdSchema.parse("apr_profile01"),
  task: TaskIdSchema.parse("tsk_task0001"),
};

function project(projectId = ids.project) {
  return createProject({
    projectId,
    name: "Hunter",
    repositoryBindings: [{ repositoryId: ids.repository, role: "primary" }],
    deviceBindings: [
      {
        deviceBindingId: DeviceBindingIdSchema.parse("dev_binding01"),
        deviceId: DeviceIdSchema.parse("dvc_windows01"),
        repositoryId: ids.repository,
        localPath: "E:/work/hunter",
        availability: "available",
      },
    ],
  });
}

function requirement(
  status: "approved" | "draft" = "approved",
  projectId = ids.project,
) {
  return createRequirementRevision({
    requirementId: ids.requirement,
    revisionId: ids.requirementRevision,
    projectId,
    title: "Foundation",
    body: "Build the Foundation",
    acceptanceCriteria: ["verified"],
    constraints: ["provider-neutral"],
    status,
    ...(status === "approved" ? { approvedAt: "2026-07-22T00:00:00.000Z" } : {}),
  });
}

function draftChange(overrides: Partial<ChangeRevision> = {}) {
  return createChangeRevision({
    changeId: ids.change,
    revisionId: ids.changeRevision,
    projectId: ids.project,
    title: "Publish Foundation",
    goal: "Publish atomically",
    nonGoals: ["No real Provider"],
    requirementRevisionIds: [ids.requirementRevision],
    repositoryIds: [ids.repository],
    acceptanceCriteria: ["one transaction"],
    constraints: ["strict"],
    risks: ["partial publish"],
    dependsOnChangeRevisionIds: [],
    status: "draft",
    ...overrides,
  });
}

function task(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    taskId: ids.task,
    title: "Publish",
    objective: "Publish change and plan",
    acceptanceCriteria: ["atomic"],
    repositoryIds: [ids.repository],
    moduleScopes: ["packages/application"],
    dependsOn: [],
    readSet: ["packages/domain"],
    writeSet: ["packages/application"],
    access: "write",
    workflowRevisionId: ids.workflowRevision,
    defaultAgentProfileId: ids.agentProfile,
    sessionPolicy: "new",
    workspacePolicy: { mode: "write", isolation: "worktree", reuse: false },
    ...overrides,
  };
}

function workflow() {
  return createWorkflowRevision({ ...validWorkflowInput(), workflowRevisionId: ids.workflowRevision });
}

describe("PublishChangeService", () => {
  let database: DatabaseSync | undefined;
  afterEach(() => database?.close());

  function setup(options: {
    change?: ChangeRevision;
    requirement?: ReturnType<typeof requirement> | null;
    dependency?: ChangeRevision | null;
    existingPlan?: ExecutionPlan | null;
    includeWorkflow?: boolean;
    includeProfile?: boolean;
  } = {}) {
    database = new DatabaseSync(":memory:");
    const target = options.change ?? draftChange();
    const requirementRevision = options.requirement === undefined ? requirement() : options.requirement;
    const dependencies = new Map<string, ChangeRevision>();
    if (options.dependency !== undefined && options.dependency !== null) {
      dependencies.set(options.dependency.revisionId, options.dependency);
    }
    const repositories = {
      getProject: (projectId: string) => (projectId === ids.project ? project() : null),
      getChangeRevision: (revisionId: string) =>
        revisionId === target.revisionId ? target : (dependencies.get(revisionId) ?? null),
      getRequirementRevision: (revisionId: string) =>
        revisionId === ids.requirementRevision ? requirementRevision : null,
      getExecutionPlanForChangeRevision: (revisionId: string) =>
        revisionId === target.revisionId ? (options.existingPlan ?? null) : null,
      getWorkflowRevision: (revisionId: string) =>
        options.includeWorkflow === false || revisionId !== ids.workflowRevision ? null : workflow(),
      getAgentProfile: (profileId: string) =>
        options.includeProfile === false || profileId !== ids.agentProfile
          ? null
          : { agentProfileId: ids.agentProfile, projectId: ids.project, status: "active" as const },
    };
    const service = new PublishChangeService(
      repositories,
      new SqliteOperationJournal(database),
      () => new Date("2026-07-22T01:00:00.000Z"),
    );
    const command = {
      changeRevisionId: ids.changeRevision,
      executionPlanId: ids.executionPlan,
      tasks: [task()],
      expectedVersion: 0,
      idempotencyKey: "publish-change-0001",
    };
    return { database, service, command };
  }

  it("loads references and publishes ChangeRevision plus ExecutionPlan in one journal command", () => {
    const { database: db, service, command } = setup();
    const result = service.execute(command, {
      actorId: "local-user",
      correlationId: "publish-change",
    });

    expect(result.changeRevision.status).toBe("published");
    expect(result.executionPlan.changeRevisionId).toBe(ids.changeRevision);
    expect(result.executionPlan.planFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get()).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT GROUP_CONCAT(event_type, ',') AS types FROM events ORDER BY position").get(),
    ).toEqual({ types: "ChangePublished,ExecutionPlanPublished" });
  });

  it.each([
    ["missing", null],
    ["unapproved", requirement("draft")],
    ["cross-project", requirement("approved", ids.otherProject)],
  ])("rejects a %s RequirementRevision", (_label, requirementRevision) => {
    const { service, command } = setup({ requirement: requirementRevision });
    expect(() => service.execute(command, { actorId: "user", correlationId: "test" })).toThrow(
      /REQUIREMENT/u,
    );
  });

  it("rejects a Task Repository outside the Project/Change scope", () => {
    const { service, command } = setup();
    expect(() =>
      service.execute(
        { ...command, tasks: [task({ repositoryIds: [ids.otherRepository] })] },
        { actorId: "user", correlationId: "test" },
      ),
    ).toThrow(/REPOSITORY/u);
  });

  it("rejects a Change Repository that is not bound to its Project", () => {
    const { service, command } = setup({
      change: draftChange({ repositoryIds: [ids.otherRepository] }),
    });
    expect(() => service.execute(command, { actorId: "user", correlationId: "test" })).toThrow(
      /CHANGE_REPOSITORY_NOT_BOUND/u,
    );
  });

  it("rejects caller-supplied prevalidated aggregate objects", () => {
    const { service, command } = setup();
    expect(() =>
      service.execute(
        { ...command, changeRevision: draftChange() },
        { actorId: "user", correlationId: "test" },
      ),
    ).toThrow();
  });

  it.each(["missing", "unpublished", "cross-project"])(
    "rejects a %s Change dependency",
    (mode) => {
      const dependencyId = ChangeRevisionIdSchema.parse("crv_dependency1");
      const dependency =
        mode === "missing"
          ? null
          : createChangeRevision({
              ...draftChange(),
              changeId: ChangeIdSchema.parse("chg_dependency1"),
              revisionId: dependencyId,
              projectId: mode === "cross-project" ? ids.otherProject : ids.project,
              status: mode === "unpublished" ? "draft" : "published",
              ...(mode === "unpublished" ? {} : { publishedAt: "2026-07-22T00:00:00.000Z" }),
            });
      const { service, command } = setup({
        change: draftChange({ dependsOnChangeRevisionIds: [dependencyId] }),
        dependency,
      });
      expect(() => service.execute(command, { actorId: "user", correlationId: "test" })).toThrow(
        /CHANGE_DEPENDENCY/u,
      );
    },
  );

  it.each([
    ["duplicate IDs", [task(), task()]],
    ["unknown dependency", [task({ dependsOn: [TaskIdSchema.parse("tsk_unknown01")] })]],
    [
      "cycle",
      [
        task({ dependsOn: [TaskIdSchema.parse("tsk_task0002")] }),
        task({ taskId: TaskIdSchema.parse("tsk_task0002"), dependsOn: [ids.task] }),
      ],
    ],
  ])("rejects an invalid TaskGraph with %s", (_label, tasks) => {
    const { service, command } = setup();
    expect(() => service.execute({ ...command, tasks }, { actorId: "user", correlationId: "test" })).toThrow();
  });

  it("rejects missing WorkflowRevision and AgentProfile references", () => {
    const missingWorkflow = setup({ includeWorkflow: false });
    expect(() =>
      missingWorkflow.service.execute(missingWorkflow.command, { actorId: "user", correlationId: "test" }),
    ).toThrow(/WORKFLOW/u);

    database?.close();
    database = undefined;
    const missingProfile = setup({ includeProfile: false });
    expect(() =>
      missingProfile.service.execute(missingProfile.command, { actorId: "user", correlationId: "test" }),
    ).toThrow(/AGENT_PROFILE/u);
  });

  it("returns the original receipt for an exact replay and rejects changed content under the same key", () => {
    const { database: db, service, command } = setup();
    const actor = { actorId: "user", correlationId: "test" };
    const first = service.execute(command, actor);
    expect(service.execute(command, actor)).toEqual(first);
    expect(() =>
      service.execute(
        { ...command, tasks: [task({ acceptanceCriteria: ["changed"] })] },
        actor,
      ),
    ).toThrow(/IDEMPOTENCY_KEY_REUSED/u);
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });
  });

  it("rejects changed Task content for an already published Revision/Plan", () => {
    const initial = setup();
    const published = initial.service.execute(initial.command, {
      actorId: "user",
      correlationId: "initial",
    });
    database?.close();
    database = undefined;
    const existing = setup({
      change: published.changeRevision,
      existingPlan: published.executionPlan,
    });
    expect(() =>
      existing.service.execute(
        { ...existing.command, tasks: [task({ acceptanceCriteria: ["changed"] })] },
        { actorId: "user", correlationId: "changed" },
      ),
    ).toThrow(/PUBLISHED_CONTENT_MISMATCH/u);
  });
});
