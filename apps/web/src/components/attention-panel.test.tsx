// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  AttentionItemHttpSchema,
  type AttentionActionHttpResponse,
} from "@hunter/api-contracts";
import { AttemptIdSchema, canonicalSha256 } from "@hunter/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AttentionPanel } from "./attention-panel.js";

const attemptId = AttemptIdSchema.parse("att_attentionpanel01");
const attention = AttentionItemHttpSchema.parse({
  reasonCode: "external_operation_indeterminate",
  requiredActor: "human_operator",
  inputRevision: {
    changeRevisionId: "crv_attentionpanel01",
    workflowRevisionId: "wfr_attentionpanel01",
    requirementRevisionIds: ["rrv_attentionpanel01"],
    fixedContentHash: "f".repeat(64),
  },
  evidence: [{
    evidenceId: "evd_attentionpanel01",
    contentHash: "a".repeat(64),
  }],
  actions: [
    {
      action: "retry_external_check",
      enabled: true,
      capability: {
        probeReceiptId: "cpr_attentionpanel01",
        status: "supported",
        reasonCode: "capability_supported",
      },
    },
    {
      action: "create_new_attempt",
      enabled: false,
      disabledReasonCode: "action_not_available",
    },
  ],
});

afterEach(cleanup);

describe("AttentionPanel", () => {
  it("explains why, actor, input revision, evidence, and receipt-derived actions", async () => {
    const onAction = vi.fn(async (): Promise<AttentionActionHttpResponse> => ({
      runId: "run_attentionpanel01" as never,
      attemptId,
      action: "retry_external_check",
      status: "recorded",
      effect: "recheck_requested",
      stepCompletion: "verifier_required",
    }));
    render(
      <AttentionPanel
        attemptId={attemptId}
        attention={attention}
        onAction={onAction}
      />,
    );

    expect(screen.getByRole("heading", { name: "需要处理" })).not.toBeNull();
    expect(screen.getByText("外部操作结果尚未证明")).not.toBeNull();
    expect(screen.getByText("处理人：人工操作员")).not.toBeNull();
    expect(screen.getByText("crv_attentionpanel01")).not.toBeNull();
    expect(screen.getByText("wfr_attentionpanel01")).not.toBeNull();
    expect(screen.getByText("rrv_attentionpanel01")).not.toBeNull();
    expect(screen.getAllByText("evd_attentionpanel01")).toHaveLength(2);
    expect(
      (screen.getByRole("button", {
        name: "重新检查外部状态",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", {
        name: "创建新的 Attempt",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/能力已证明/)).not.toBeNull();
    expect(screen.getByText("cpr_attentionpanel01")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "重新检查外部状态" }),
    );
    expect(onAction).toHaveBeenCalledWith({
      action: "retry_external_check",
      capabilityProbeReceiptId: "cpr_attentionpanel01",
    });
  });

  it("constructs canonical submit-input and evidence-bound confirmation drafts", async () => {
    const submitAction = vi.fn(async (): Promise<AttentionActionHttpResponse> => ({
      runId: "run_attentionpanel01" as never,
      attemptId,
      action: "submit_input",
      status: "accepted",
      effect: "input_recorded",
      stepCompletion: "unchanged",
    }));
    const { rerender } = render(
      <AttentionPanel
        attemptId={attemptId}
        attention={AttentionItemHttpSchema.parse({
          ...attention,
          reasonCode: "input_required",
          actions: [{ action: "submit_input", enabled: true }],
        })}
        onAction={submitAction}
      />,
    );
    fireEvent.change(screen.getByLabelText("补充输入内容"), {
      target: { value: "  请检查测试失败  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "补充输入" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledWith({
      action: "submit_input",
      input: {
        text: "请检查测试失败",
        contentHash: canonicalSha256("请检查测试失败"),
      },
    }));

    const confirmAction = vi.fn(async (): Promise<AttentionActionHttpResponse> => ({
      runId: "run_attentionpanel01" as never,
      attemptId,
      action: "confirm_external_result",
      status: "recorded",
      effect: "observation_recorded",
      stepCompletion: "verifier_required",
    }));
    rerender(
      <AttentionPanel
        attemptId={attemptId}
        attention={AttentionItemHttpSchema.parse({
          ...attention,
          actions: [{ action: "confirm_external_result", enabled: true }],
        })}
        onAction={confirmAction}
      />,
    );
    fireEvent.change(screen.getByLabelText("外部观察事实"), {
      target: { value: "agent_returned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认外部观察" }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalledWith({
      action: "confirm_external_result",
      observation: {
        fact: "agent_returned",
        evidenceId: "evd_attentionpanel01",
        contentHash: "a".repeat(64),
      },
    }));
  });

  it("binds a human verification receipt to the displayed durable evidence", async () => {
    const onAction = vi.fn(async (): Promise<AttentionActionHttpResponse> => ({
      runId: "run_attentionpanel01" as never,
      attemptId,
      action: "record_human_receipt",
      status: "recorded",
      effect: "human_receipt_recorded",
      stepCompletion: "human_verified",
    }));
    render(
      <AttentionPanel
        attemptId={attemptId}
        attention={AttentionItemHttpSchema.parse({
          ...attention,
          reasonCode: "human_verification_required",
          actions: [{ action: "record_human_receipt", enabled: true }],
        })}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "记录人工验证" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({
      action: "record_human_receipt",
      receipt: {
        evidenceRef: {
          evidenceId: "evd_attentionpanel01",
          contentHash: "a".repeat(64),
        },
        acknowledgedInputHash: "f".repeat(64),
      },
    }));
  });
});
