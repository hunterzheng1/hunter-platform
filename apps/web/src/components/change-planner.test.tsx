// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  AgentProfileIdSchema,
  ChangeIdSchema,
  ChangeRevisionIdSchema,
  ExecutionPlanIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RequirementRevisionIdSchema,
  WorkflowRevisionIdSchema,
} from "@hunter/domain";
import { afterEach, expect, it, vi } from "vitest";

import { ChangePlanner, type ChangePlanDraft } from "./change-planner.js";

afterEach(cleanup);

const ids = {
  project: ProjectIdSchema.parse("prj_task3000001"),
  change: ChangeIdSchema.parse("chg_task3000001"),
  changeRevision: ChangeRevisionIdSchema.parse("crv_task3000001"),
  executionPlan: ExecutionPlanIdSchema.parse("epl_task3000001"),
  requirementRevision: RequirementRevisionIdSchema.parse("rrv_task3000001"),
  repository: RepositoryIdSchema.parse("rep_task3000001"),
  workflowRevision: WorkflowRevisionIdSchema.parse("wfr_task3000001"),
  agentProfile: AgentProfileIdSchema.parse("apr_task3000001"),
};

const planningDefaults = {
  repositoryIds: [ids.repository],
  workflowRevisionId: ids.workflowRevision,
  defaultAgentProfileId: ids.agentProfile,
  sessionPolicy: "new" as const,
  workspacePolicy: { mode: "write" as const, isolation: "worktree" as const, reuse: false },
};

const idFactory = {
  changeId: () => ids.change,
  changeRevisionId: () => ids.changeRevision,
  executionPlanId: () => ids.executionPlan,
  taskId: (role: "api" | "ui" | "integration") => ({
    api: "tsk_task300api1",
    ui: "tsk_task300ui01",
    integration: "tsk_task300int1",
  })[role],
};

it("publishes two parallel write Tasks and one dependent integration Task", async () => {
  const publish = vi.fn(async () => ({
    projectId: ids.project,
    changeId: ids.change,
    changeRevisionId: ids.changeRevision,
    executionPlanId: ids.executionPlan,
    status: "published" as const,
    taskGraphFingerprint: "a".repeat(64),
  }));
  render(
    <ChangePlanner
      requirementRevisionIds={[ids.requirementRevision]}
      planningDefaults={planningDefaults}
      idFactory={idFactory}
      onPublish={publish}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "使用并行交付模板" }));
  const graph = screen.getByRole("list", { name: "任务依赖图" });
  expect(within(graph).getAllByText("可并行（无依赖）")).toHaveLength(2);
  expect(within(graph).getByText(/依赖：控制 API、客户端界面/u)).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "确认执行计划" }));

  await waitFor(() => expect(publish).toHaveBeenCalledOnce());
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({
    changeId: "chg_task3000001",
    changeRevisionId: "crv_task3000001",
    executionPlanId: "epl_task3000001",
    requirementRevisionIds: ["rrv_task3000001"],
    repositoryIds: ["rep_task3000001"],
    tasks: [
      expect.objectContaining({ taskId: "tsk_task300api1", access: "write", dependsOn: [] }),
      expect.objectContaining({ taskId: "tsk_task300ui01", access: "write", dependsOn: [] }),
      expect.objectContaining({
        taskId: "tsk_task300int1",
        access: "write",
        dependsOn: ["tsk_task300api1", "tsk_task300ui01"],
      }),
    ],
  }));
});

it("shows busy and recoverable error states without regenerating the selected plan", async () => {
  let reject: ((reason?: unknown) => void) | undefined;
  const pending = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const publish = vi.fn((input: ChangePlanDraft) => {
    void input;
    return pending;
  });
  render(
    <ChangePlanner
      requirementRevisionIds={[ids.requirementRevision]}
      planningDefaults={planningDefaults}
      idFactory={idFactory}
      onPublish={publish}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "使用并行交付模板" }));
  fireEvent.click(screen.getByRole("button", { name: "确认执行计划" }));
  expect(screen.getByRole("button", { name: "正在确认…" }).hasAttribute("disabled")).toBe(true);
  reject?.(new Error("response lost"));

  expect((await screen.findByRole("alert")).textContent).toContain("重试会复用同一组标识");
  fireEvent.click(screen.getByRole("button", { name: "确认执行计划" }));
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish.mock.calls[1]?.[0]).toEqual(publish.mock.calls[0]?.[0]);
});
