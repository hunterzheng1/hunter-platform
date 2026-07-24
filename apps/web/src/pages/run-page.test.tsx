// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunIdSchema } from "@hunter/domain/ids";
import {
  ArtifactPageHttpResponseSchema,
  RunViewHttpResponseSchema,
} from "@hunter/api-contracts";

import { RunPage } from "./run-page.js";
import type { RunEventStreamHandlers } from "../hooks/use-run-events.js";

const runA = RunIdSchema.parse("run_task400001");
const runB = RunIdSchema.parse("run_task400002");

const runView = RunViewHttpResponseSchema.parse({
  runId: runA,
  projectionPosition: 3,
  aggregateVersion: 4,
  status: "running",
  steps: [
    {
      stepRunId: "spr_task400001",
      title: "计划",
      conclusion: "succeeded",
      attempts: [{
        attemptId: "att_task400001",
        attemptNumber: 1,
        executionStatus: "returned",
        verificationStatus: "passed",
        artifactIds: [],
        evidenceIds: ["evd_task400001"],
      }],
    },
    {
      stepRunId: "spr_task400002",
      title: "测试",
      conclusion: "active",
      attempts: [
        {
          attemptId: "att_task400002",
          attemptNumber: 1,
          executionStatus: "returned",
        verificationStatus: "failed",
        agentProfileId: "apr_task400001",
        nativeSessionId: "ses_task400001",
        artifactIds: ["art_task400001"],
        evidenceIds: ["evd_task400002"],
        attention: {
          reasonCode: "verifier_failed",
          requiredActor: "hunter_verifier",
          inputRevision: {
            changeRevisionId: "crv_task400001",
            workflowRevisionId: "wfr_task400001",
            requirementRevisionIds: ["rrv_task400001"],
            fixedContentHash: "b".repeat(64),
          },
          evidence: [{
            evidenceId: "evd_task400002",
            contentHash: "b".repeat(64),
          }],
          actions: [{ action: "create_new_attempt", enabled: true }],
        },
        },
        {
          attemptId: "att_task400003",
          attemptNumber: 2,
          isCurrent: true,
          executionStatus: "running",
          verificationStatus: "needs_human",
          waitingReason: { code: "human_verification_required" },
          artifactIds: [],
          evidenceIds: ["evd_task400003"],
          attention: {
            reasonCode: "human_verification_required",
            requiredActor: "human_operator",
            inputRevision: {
              changeRevisionId: "crv_task400001",
              workflowRevisionId: "wfr_task400001",
              requirementRevisionIds: ["rrv_task400001"],
              fixedContentHash: "c".repeat(64),
            },
            evidence: [{
              evidenceId: "evd_task400003",
              contentHash: "c".repeat(64),
            }],
            actions: [{ action: "record_human_receipt", enabled: true }],
          },
        },
      ],
    },
  ],
});
const failedAgentProfileId = runView.steps.find(({ title }) => title === "测试")
  ?.attempts.find(({ attemptNumber }) => attemptNumber === 1)?.agentProfileId;
if (failedAgentProfileId === undefined) throw new Error("RUN_VIEW_FIXTURE_AGENT_PROFILE_MISSING");

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value: T) {
      if (resolvePromise === undefined) throw new Error("DEFERRED_NOT_READY");
      resolvePromise(value);
    },
    reject(reason: unknown) {
      if (rejectPromise === undefined) throw new Error("DEFERRED_NOT_READY");
      rejectPromise(reason);
    },
  };
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("RunPage", () => {
  it("separates execution from verification, retains failed Attempts, and selects every Step", async () => {
    const api = { getRun: vi.fn(async () => runView) };
    render(<RunPage runId={runA} api={api} />);

    expect(await screen.findByRole("heading", { name: `Run ${runA}` })).not.toBeNull();
    expect(screen.getByText("运行中")).not.toBeNull();
    expect(screen.queryByText("running")).toBeNull();
    expect(screen.getByRole("button", { name: "计划 · 成功" }).getAttribute("aria-current")).toBe("step");
    const testStep = screen.getByRole("button", { name: "测试 · 进行中" });
    expect(testStep.textContent).not.toContain("成功");
    fireEvent.click(testStep);

    expect(screen.getByRole("heading", { name: "测试详情" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "第 1 次尝试 · 已返回" })).not.toBeNull();
    expect(screen.getByText("执行：已返回 · 验证：失败")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "第 2 次尝试 · 执行中" })).not.toBeNull();
    expect(screen.getByText("执行：执行中 · 验证：等待人工确认")).not.toBeNull();
    expect(screen.getAllByText("等待人工验证")).toHaveLength(2);
    expect(screen.getByText(failedAgentProfileId).closest("p")?.textContent)
      .toBe(`Agent Profile：${failedAgentProfileId}`);
    expect(screen.getByText("ses_task400001")).not.toBeNull();
    expect(screen.getByText("art_task400001")).not.toBeNull();
    expect(screen.getAllByText("evd_task400002")).toHaveLength(3);
    expect(
      (screen.getByRole("button", {
        name: "创建新的 Attempt",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/历史 Attempt 只读/)).not.toBeNull();
  });

  it("loads only a requested bounded Artifact page through the shared API client", async () => {
    const artifactPage = ArtifactPageHttpResponseSchema.parse({
      schemaVersion: 1,
      status: "ok",
      artifact: {
        artifactId: "art_task400001",
        projectId: "prj_task400001",
        attemptId: "att_task400002",
        kind: "log",
        retentionClass: "standard",
        summary: "bounded run log",
        byteLength: 4,
        entryCount: 1,
      },
      cursor: 0,
      nextCursor: 1,
      retentionFloor: 0,
      highWaterCursor: 1,
      complete: true,
      responseBytes: 4,
      entries: [{
        cursor: 1,
        stream: "stdout",
        content: "page",
        contentHash: "a".repeat(64),
        byteLength: 4,
        occurredAt: "2026-07-24T12:00:00.000Z",
      }],
    });
    const api = {
      getRun: vi.fn(async () => runView),
      getArtifactPage: vi.fn(async () => artifactPage),
    };
    render(<RunPage runId={runA} api={api} />);

    await screen.findByRole("heading", { name: `Run ${runA}` });
    fireEvent.click(screen.getByRole("button", { name: "测试 · 进行中" }));
    expect(api.getArtifactPage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {
      name: "加载产物 art_task400001",
    }));

    expect(await screen.findByText("page")).not.toBeNull();
    expect(api.getArtifactPage).toHaveBeenCalledWith(
      "art_task400001",
      { cursor: 0, limit: 20 },
    );
  });

  it("executes a receipt-derived recovery action with the current aggregate version without claiming Step success", async () => {
    const planStep = runView.steps[0];
    const testStep = runView.steps[1];
    const priorAttempt = testStep?.attempts[0];
    if (
      planStep === undefined
      || testStep === undefined
      || priorAttempt === undefined
      || priorAttempt.attention === undefined
    ) {
      throw new Error("RUN_VIEW_ATTENTION_FIXTURE_MISSING");
    }
    const actionableRun = RunViewHttpResponseSchema.parse({
      ...runView,
      steps: [
        planStep,
        {
          ...testStep,
          attempts: [
            {
              ...priorAttempt,
              isCurrent: true,
              executionStatus: "stale",
              verificationStatus: "pending",
              attention: {
                ...priorAttempt.attention,
                reasonCode: "external_operation_indeterminate",
                requiredActor: "human_operator",
                actions: [{
                  action: "retry_external_check",
                  enabled: true,
                  capability: {
                    probeReceiptId: "cpr_task400001",
                    status: "supported",
                    reasonCode: "capability_supported",
                  },
                }],
              },
            },
          ],
        },
      ],
    });
    const actionableAttempt = actionableRun.steps[1]?.attempts[0];
    if (actionableAttempt === undefined) {
      throw new Error("RUN_VIEW_ACTIONABLE_ATTEMPT_MISSING");
    }
    const executeAttentionAction = vi.fn(async () => ({
      runId: runA,
      attemptId: actionableAttempt.attemptId,
      action: "retry_external_check" as const,
      status: "recorded" as const,
      effect: "recheck_requested" as const,
      stepCompletion: "verifier_required" as const,
    }));
    const api = {
      getRun: vi.fn(async () => actionableRun),
      executeAttentionAction,
    };
    render(<RunPage runId={runA} api={api} />);
    await screen.findByRole("heading", { name: `Run ${runA}` });
    fireEvent.click(screen.getByRole("button", { name: "测试 · 进行中" }));
    fireEvent.click(
      screen.getByRole("button", { name: "重新检查外部状态" }),
    );

    await waitFor(() => expect(executeAttentionAction).toHaveBeenCalledWith(
      runA,
      {
        attemptId: actionableAttempt.attemptId,
        action: "retry_external_check",
        capabilityProbeReceiptId: "cpr_task400001",
        expectedVersion: actionableRun.aggregateVersion,
      },
    ));
    expect(await screen.findByRole("status")).not.toBeNull();
    expect(screen.getByText(/Step 仍需 verifier 结果/)).not.toBeNull();
    expect(screen.queryByText(/Step 已成功/)).toBeNull();
  });

  it("keeps the last Attempt of a concluded prior Step read-only", async () => {
    const planStep = runView.steps[0];
    const testStep = runView.steps[1];
    const recoveryAttention = testStep?.attempts[0]?.attention;
    if (
      planStep === undefined
      || testStep === undefined
      || recoveryAttention === undefined
    ) {
      throw new Error("RUN_VIEW_HISTORICAL_STEP_FIXTURE_MISSING");
    }
    const historicalRun = RunViewHttpResponseSchema.parse({
      ...runView,
      steps: [{
        ...planStep,
        conclusion: "failed",
        attempts: [{
          ...planStep.attempts[0],
          executionStatus: "failed",
          verificationStatus: "pending",
          attention: {
            ...recoveryAttention,
            reasonCode: "recovery_attention_required",
            requiredActor: "hunter_runtime",
            actions: [{
              action: "create_new_attempt",
              enabled: true,
            }],
          },
        }],
      }, testStep],
    });
    render(
      <RunPage
        runId={runA}
        api={{
          getRun: vi.fn(async () => historicalRun),
          executeAttentionAction: vi.fn(),
        }}
      />,
    );
    await screen.findByRole("heading", { name: `Run ${runA}` });
    fireEvent.click(screen.getByRole("button", { name: "计划 · 失败" }));
    expect(
      (screen.getByRole("button", {
        name: "创建新的 Attempt",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/历史 Attempt 只读/)).not.toBeNull();
  });

  it("allows append-only recovery on the current concluded Step of a failed Run", async () => {
    const testStep = runView.steps[1];
    const recoveryAttention = testStep?.attempts[0]?.attention;
    if (testStep === undefined || recoveryAttention === undefined) {
      throw new Error("RUN_VIEW_FAILED_RECOVERY_FIXTURE_MISSING");
    }
    const failedRun = RunViewHttpResponseSchema.parse({
      ...runView,
      status: "failed",
      steps: [{
        ...testStep,
        conclusion: "failed",
        attempts: [{
          ...testStep.attempts[0],
          isCurrent: true,
          executionStatus: "failed",
          verificationStatus: "pending",
          attention: {
            ...recoveryAttention,
            reasonCode: "recovery_attention_required",
            requiredActor: "hunter_runtime",
            actions: [{
              action: "create_new_attempt",
              enabled: true,
            }],
          },
        }],
      }],
    });
    const executeAttentionAction = vi.fn(async () => ({
      runId: runA,
      attemptId: failedRun.steps[0]!.attempts[0]!.attemptId,
      action: "create_new_attempt" as const,
      status: "accepted" as const,
      effect: "new_attempt_requested" as const,
      stepCompletion: "unchanged" as const,
    }));
    render(
      <RunPage
        runId={runA}
        api={{ getRun: vi.fn(async () => failedRun), executeAttentionAction }}
      />,
    );
    await screen.findByRole("heading", { name: `Run ${runA}` });
    const button = screen.getByRole("button", {
      name: "创建新的 Attempt",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(executeAttentionAction).toHaveBeenCalledOnce());
  });

  it("announces loading, empty, and failure states without inventing a successful conclusion", async () => {
    const pending = deferred<typeof runView>();
    const first = render(<RunPage runId={runA} api={{ getRun: () => pending.promise }} />);
    expect(screen.getByRole("status").textContent).toContain("正在加载 Run");
    first.unmount();
    pending.resolve(runView);

    const empty = RunViewHttpResponseSchema.parse({ runId: runA, projectionPosition: 0, aggregateVersion: 0, status: "created", steps: [] });
    const second = render(<RunPage runId={runA} api={{ getRun: async () => empty }} />);
    expect(await screen.findByText("还没有 Step 运行记录")).not.toBeNull();
    second.unmount();

    render(<RunPage runId={runA} api={{ getRun: async () => { throw new Error("private failure"); } }} />);
    expect((await screen.findByRole("alert")).textContent).toContain("无法加载 Run");
    expect(screen.queryByText("private failure")).toBeNull();
  });

  it("prevents a stale A refresh and a post-unmount request from updating the current page", async () => {
    const requestA = deferred<typeof runView>();
    const responseB = RunViewHttpResponseSchema.parse({
      ...runView,
      runId: runB,
      steps: [{ ...runView.steps[0], title: "B 计划" }],
    });
    const requestB = deferred<typeof responseB>();
    const api = {
      getRun: vi.fn((runId: typeof runA | typeof runB) => runId === runA ? requestA.promise : requestB.promise),
    };
    const rendered = render(<RunPage runId={runA} api={api} />);
    rendered.rerender(<RunPage runId={runB} api={api} />);
    requestB.resolve(responseB);
    expect(await screen.findByRole("heading", { name: `Run ${runB}` })).not.toBeNull();
    requestA.resolve(runView);
    expect(screen.queryByRole("heading", { name: `Run ${runA}` })).toBeNull();

    rendered.unmount();
    const afterUnmount = deferred<typeof responseB>();
    const unmounted = render(<RunPage runId={runB} api={{ getRun: () => afterUnmount.promise }} />);
    unmounted.unmount();
    expect(() => afterUnmount.resolve(responseB)).not.toThrow();
  });

  it("fails closed for a malformed Run route instead of throwing during render", () => {
    expect(() => render(<RunPage runId="private-path" api={{ getRun: vi.fn() }} />)).not.toThrow();
    expect(screen.getByRole("alert").textContent).toContain("Run 标识无效");
  });

  it("shows live-stream reconnect, resync, and invalid-event states explicitly", async () => {
    let handlers: RunEventStreamHandlers | undefined;
    const stream = {
      subscribe: vi.fn((_input, nextHandlers: RunEventStreamHandlers) => {
        handlers = nextHandlers;
        return vi.fn();
      }),
    };
    const rendered = render(<RunPage runId={runA} api={{ getRun: async () => runView }} eventStream={stream} />);
    await screen.findByRole("heading", { name: `Run ${runA}` });
    expect((await screen.findByRole("status", { name: "实时更新状态" })).textContent).toContain("实时更新已连接");

    act(() => handlers?.onError());
    expect(screen.getByRole("status", { name: "实时更新状态" }).textContent).toContain("正在重新连接");
    rendered.unmount();

    handlers = undefined;
    const gapReload = deferred<typeof runView>();
    const gapApi = { getRun: vi.fn().mockResolvedValueOnce(runView).mockReturnValueOnce(gapReload.promise) };
    render(<RunPage runId={runA} api={gapApi} eventStream={stream} />);
    await screen.findByRole("heading", { name: `Run ${runA}` });
    await screen.findByRole("status", { name: "实时更新状态" });
    act(() => handlers?.onCursorGap({
      schemaVersion: 1,
      runId: runA,
      code: "EVENT_CURSOR_GAP",
      retentionFloor: 4,
      highWaterPosition: 9,
      instructions: { snapshot: "reload_run_snapshot", rebuild: "replace_run_projection_from_snapshot", resume: "subscribe_after_high_water_position" },
    }));
    expect(screen.getByRole("status", { name: "实时更新状态" }).textContent).toContain("正在重新同步");
    gapReload.resolve({ ...runView, projectionPosition: 9 });
    expect(await screen.findByText("实时更新已连接")).not.toBeNull();
  });

  it("does not subscribe before the initial Run snapshot is authorized and loaded", async () => {
    const initial = deferred<typeof runView>();
    const stream = { subscribe: vi.fn(() => vi.fn()) };
    render(<RunPage runId={runA} api={{ getRun: () => initial.promise }} eventStream={stream} />);
    expect(screen.getByRole("status").textContent).toContain("正在加载 Run");
    expect(stream.subscribe).not.toHaveBeenCalled();
    initial.resolve(runView);
    await screen.findByRole("heading", { name: `Run ${runA}` });
    await waitFor(() => expect(stream.subscribe).toHaveBeenCalledTimes(1));
  });

  it("keeps an event refresh failure visible and retries without discarding the prior snapshot", async () => {
    let handlers: RunEventStreamHandlers | undefined;
    const stream = { subscribe: vi.fn((_input, next: RunEventStreamHandlers) => { handlers = next; return vi.fn(); }) };
    const api = { getRun: vi.fn()
      .mockResolvedValueOnce(runView)
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce({ ...runView, projectionPosition: 5 }) };
    render(<RunPage runId={runA} api={api} eventStream={stream} />);
    await screen.findByRole("heading", { name: `Run ${runA}` });
    await screen.findByRole("status", { name: "实时更新状态" });
    await act(async () => handlers?.onEvent({ schemaVersion: 1, position: 5, runId: runA, eventType: "run_projection_changed" }));
    expect(screen.getByRole("alert").textContent).toContain("快照刷新失败");
    expect(screen.getByRole("heading", { name: `Run ${runA}` })).not.toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试快照刷新" })));
    expect(await screen.findByText("实时更新已连接")).not.toBeNull();
    expect(api.getRun).toHaveBeenCalledTimes(3);
    expect(stream.subscribe).toHaveBeenCalledTimes(2);
  });

  it("shows a malformed live event as a fail-closed page alert", async () => {
    let handlers: RunEventStreamHandlers | undefined;
    const stream = {
      subscribe: vi.fn((_input, nextHandlers: RunEventStreamHandlers) => {
        handlers = nextHandlers;
        return vi.fn();
      }),
    };
    render(<RunPage runId={runA} api={{ getRun: async () => runView }} eventStream={stream} />);
    await screen.findByRole("heading", { name: `Run ${runA}` });
    await screen.findByRole("status", { name: "实时更新状态" });
    act(() => handlers?.onEvent({ runId: runA, position: "bad" }));
    expect(screen.getByRole("alert").textContent).toContain("收到无效事件");
  });
});
