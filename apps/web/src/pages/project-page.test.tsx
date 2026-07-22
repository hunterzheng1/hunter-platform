// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectIdSchema, RequirementIdSchema, RequirementRevisionIdSchema } from "@hunter/domain";

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
  title: "移动审批",
  body: "允许所有者审批需求。",
  acceptanceCriteria: ["审批后恢复同一个运行"],
  constraints: ["保持本地认证边界"],
  status: "draft" as const,
};

describe("ProjectPage", () => {
  it("creates and approves the exact requirement revision without replacing it", async () => {
    const api = {
      getProject: vi.fn(async () => ({ projectId, name: "Hunter", requirements: [] })),
      createRequirement: vi.fn(async () => draft),
      approveRequirement: vi.fn(async () => ({
        ...draft,
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
    expect(api.approveRequirement).toHaveBeenCalledWith(projectId, revisionId);
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
});
