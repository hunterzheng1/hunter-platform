// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentProfileIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RequirementIdSchema,
  RequirementRevisionIdSchema,
  WorkflowRevisionIdSchema,
} from "@hunter/domain";

import type { PublishChangeDraftInput } from "../api/client.js";
import { ProjectPage } from "./project-page.js";

const projectId = ProjectIdSchema.parse("prj_task2000001");
const requirementId = RequirementIdSchema.parse("req_task2000001");
const revisionId = RequirementRevisionIdSchema.parse("rrv_task2000001");
const reviewRevisionId = RequirementRevisionIdSchema.parse("rrv_task2000002");
const supersededRevisionId = RequirementRevisionIdSchema.parse("rrv_task2000003");
const withdrawnRevisionId = RequirementRevisionIdSchema.parse("rrv_task2000004");
const draft = {
  projectId,
  requirementId,
  revisionId,
  aggregateVersion: 0,
  title: "移动审批",
  body: "允许所有者审批需求。",
  acceptanceCriteria: ["审批后恢复同一个运行"],
  constraints: ["保持本地认证边界"],
  status: "draft" as const,
};

afterEach(cleanup);

function deferred<T>() {
  const handlers: { resolve?: (value: T) => void; reject?: (reason: unknown) => void } = {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    handlers.resolve = promiseResolve;
    handlers.reject = promiseReject;
  });
  return {
    promise,
    resolve: (value: T) => {
      if (handlers.resolve === undefined) throw new Error("DEFERRED_NOT_READY");
      handlers.resolve(value);
    },
    reject: (reason: unknown) => {
      if (handlers.reject === undefined) throw new Error("DEFERRED_NOT_READY");
      handlers.reject(reason);
    },
  };
}

describe("ProjectPage", () => {
  it("creates and approves the exact requirement revision without replacing it", async () => {
    const api = {
      getProject: vi.fn(async () => ({ projectId, name: "Hunter", requirements: [] })),
      createRequirement: vi.fn(async () => draft),
      approveRequirement: vi.fn(async () => ({
        ...draft,
        aggregateVersion: 1,
        status: "approved" as const,
        approvedAt: "2026-07-23T01:00:00.000Z",
      })),
    };
    render(<ProjectPage projectId={projectId} api={api} onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "Hunter" });
    fireEvent.change(screen.getByLabelText("需求标题"), { target: { value: draft.title } });
    fireEvent.change(screen.getByLabelText("需求正文"), { target: { value: draft.body } });
    fireEvent.change(screen.getByLabelText("验收标准"), { target: { value: draft.acceptanceCriteria[0] } });
    fireEvent.change(screen.getByLabelText("约束条件"), { target: { value: draft.constraints[0] } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));

    expect(await screen.findByText(revisionId)).not.toBeNull();
    expect(api.createRequirement).toHaveBeenCalledWith(projectId, {
      title: draft.title,
      body: draft.body,
      acceptanceCriteria: draft.acceptanceCriteria,
      constraints: draft.constraints,
    });
    fireEvent.click(screen.getByRole("button", { name: "批准此版本" }));
    expect(api.approveRequirement).toHaveBeenCalledWith(projectId, revisionId, draft.aggregateVersion);
    expect(await screen.findByText("此版本已批准且不可修改")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "批准此版本" })).toBeNull();
  });

  it("shows an accessible project loading error", async () => {
    const api = {
      getProject: vi.fn(async () => { throw new Error("offline"); }),
      createRequirement: vi.fn(),
      approveRequirement: vi.fn(),
    };
    render(<ProjectPage projectId={projectId} api={api} onBack={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toContain("无法加载项目");
  });

  it("labels every non-approved state and only offers approval for reviewable revisions", async () => {
    const api = {
      getProject: vi.fn(async () => ({
        projectId,
        name: "Hunter",
        requirements: [
          { ...draft, revisionId: reviewRevisionId, status: "in_review" as const },
          { ...draft, revisionId: supersededRevisionId, status: "superseded" as const },
          { ...draft, revisionId: withdrawnRevisionId, status: "withdrawn" as const },
        ],
      })),
      createRequirement: vi.fn(async () => draft),
      approveRequirement: vi.fn(),
    };
    render(<ProjectPage projectId={projectId} api={api} onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "Hunter" });
    expect(screen.getByText("评审中")).not.toBeNull();
    expect(screen.getByText("已被取代")).not.toBeNull();
    expect(screen.getByText("已撤回")).not.toBeNull();

    const reviewCard = screen.getByText(reviewRevisionId).closest("article");
    const supersededCard = screen.getByText(supersededRevisionId).closest("article");
    const withdrawnCard = screen.getByText(withdrawnRevisionId).closest("article");
    if (reviewCard === null || supersededCard === null || withdrawnCard === null) {
      throw new Error("REVISION_CARD_MISSING");
    }
    expect(within(reviewCard).getByRole("button", { name: "批准此版本" })).not.toBeNull();
    expect(within(supersededCard).queryByRole("button", { name: "批准此版本" })).toBeNull();
    expect(within(withdrawnCard).queryByRole("button", { name: "批准此版本" })).toBeNull();
    expect(within(supersededCard).getByText("此版本已被取代，不能再批准或修改")).not.toBeNull();
    expect(within(withdrawnCard).getByText("此版本已撤回，不能再批准或修改")).not.toBeNull();
  });

  it("clears project A immediately and ignores its late load after switching to project B", async () => {
    const projectB = ProjectIdSchema.parse("prj_task2000002");
    const loadB = deferred<{ projectId: typeof projectB; name: string; requirements: never[] }>();
    const api = {
      getProject: vi.fn(async (id: string) => id === projectId
        ? { projectId, name: "Project A", requirements: [] }
        : loadB.promise),
      createRequirement: vi.fn(),
      approveRequirement: vi.fn(),
    };
    const view = render(<ProjectPage projectId={projectId} api={api} onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: "Project A" });

    view.rerender(<ProjectPage projectId={projectB} api={api} onBack={vi.fn()} />);
    expect(screen.queryByRole("heading", { name: "Project A" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("正在加载项目");
    loadB.resolve({ projectId: projectB, name: "Project B", requirements: [] });
    expect(await screen.findByRole("heading", { name: "Project B" })).not.toBeNull();
  });

  it("does not append a late project A draft after switching to project B", async () => {
    const projectB = ProjectIdSchema.parse("prj_task2000002");
    const createdA = deferred<typeof draft>();
    const api = {
      getProject: vi.fn(async (id: string) => id === projectId
        ? { projectId, name: "Project A", requirements: [] }
        : { projectId: projectB, name: "Project B", requirements: [] }),
      createRequirement: vi.fn(async () => createdA.promise),
      approveRequirement: vi.fn(),
    };
    const view = render(<ProjectPage projectId={projectId} api={api} onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: "Project A" });
    fireEvent.change(screen.getByLabelText("需求标题"), { target: { value: draft.title } });
    fireEvent.change(screen.getByLabelText("需求正文"), { target: { value: draft.body } });
    fireEvent.change(screen.getByLabelText("验收标准"), { target: { value: draft.acceptanceCriteria[0] } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));

    view.rerender(<ProjectPage projectId={projectB} api={api} onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: "Project B" });
    createdA.resolve(draft);
    await Promise.resolve();
    expect(screen.queryByText(revisionId)).toBeNull();
    expect(screen.getByRole("heading", { name: "Project B" })).not.toBeNull();
  });

  it("clears approval busy state and ignores a late project A failure after switching to B", async () => {
    const projectB = ProjectIdSchema.parse("prj_task2000002");
    const approvalA = deferred<never>();
    const api = {
      getProject: vi.fn(async (id: string) => id === projectId
        ? { projectId, name: "Project A", requirements: [draft] }
        : { projectId: projectB, name: "Project B", requirements: [] }),
      createRequirement: vi.fn(),
      approveRequirement: vi.fn(async () => approvalA.promise),
    };
    const view = render(<ProjectPage projectId={projectId} api={api} onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: "Project A" });
    fireEvent.click(screen.getByRole("button", { name: "批准此版本" }));

    view.rerender(<ProjectPage projectId={projectB} api={api} onBack={vi.fn()} />);
    await screen.findByRole("heading", { name: "Project B" });
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("false");
    approvalA.reject(new Error("late failure"));
    await Promise.resolve();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("plans only approved revisions with host-provided provider-neutral defaults", async () => {
    const approvedRevisionId = RequirementRevisionIdSchema.parse("rrv_task3000001");
    const publishChange = vi.fn(async function (this: { readonly owner: string }, _projectId: string, input: PublishChangeDraftInput) {
      if (this.owner !== "trusted-host") throw new Error("PUBLISH_CHANGE_RECEIVER_LOST");
      return {
      projectId,
      changeId: input.changeId,
      changeRevisionId: input.changeRevisionId,
      executionPlanId: input.executionPlanId,
      status: "published" as const,
      taskGraphFingerprint: "a".repeat(64),
      };
    });
    const api = {
      owner: "trusted-host",
      getProject: vi.fn(async () => ({
        projectId,
        name: "Hunter",
        requirements: [
          draft,
          { ...draft, revisionId: approvedRevisionId, status: "approved" as const, approvedAt: "2026-07-23T01:00:00.000Z" },
        ],
        planningDefaults: {
          repositoryIds: [RepositoryIdSchema.parse("rep_task3000001")],
          workflowRevisionId: WorkflowRevisionIdSchema.parse("wfr_task3000001"),
          defaultAgentProfileId: AgentProfileIdSchema.parse("apr_task3000001"),
          sessionPolicy: "new" as const,
          workspacePolicy: { mode: "write" as const, isolation: "worktree" as const, reuse: false },
        },
      })),
      createRequirement: vi.fn(),
      approveRequirement: vi.fn(),
      publishChange,
    };
    render(<ProjectPage projectId={projectId} api={api} onBack={vi.fn()} />);

    await screen.findByRole("heading", { name: "执行规划" });
    fireEvent.click(screen.getByRole("button", { name: "使用并行交付模板" }));
    fireEvent.click(screen.getByRole("button", { name: "确认执行计划" }));
    await waitFor(() => expect(publishChange).toHaveBeenCalledOnce());
    expect(await screen.findByText(/执行计划已发布/u)).not.toBeNull();
    expect(publishChange.mock.calls[0]?.[0]).toBe(projectId);
    expect(publishChange.mock.calls[0]?.[1].requirementRevisionIds).toEqual([approvedRevisionId]);
    expect(publishChange.mock.calls[0]?.[1].requirementRevisionIds).not.toContain(revisionId);
  });

  it("fails closed with an explicit prompt when planning defaults are unavailable", async () => {
    const api = {
      getProject: vi.fn(async () => ({
        projectId,
        name: "Hunter",
        requirements: [{ ...draft, status: "approved" as const, approvedAt: "2026-07-23T01:00:00.000Z" }],
      })),
      createRequirement: vi.fn(),
      approveRequirement: vi.fn(),
      publishChange: vi.fn(),
    };
    render(<ProjectPage projectId={projectId} api={api} onBack={vi.fn()} />);

    expect((await screen.findByText(/执行规划上下文尚未配置/u)).textContent).toContain("执行规划上下文尚未配置");
    expect(screen.queryByRole("button", { name: "使用并行交付模板" })).toBeNull();
  });
});
