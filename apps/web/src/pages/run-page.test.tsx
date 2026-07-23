// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunIdSchema } from "@hunter/domain/ids";
import { RunViewHttpResponseSchema } from "@hunter/api-contracts";

import { RunPage } from "./run-page.js";
import type { RunEventStreamHandlers } from "../hooks/use-run-events.js";

const runA = RunIdSchema.parse("run_task400001");
const runB = RunIdSchema.parse("run_task400002");

const runView = RunViewHttpResponseSchema.parse({
  runId: runA,
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
          evidenceIds: ["evd_task400002"],
        },
        {
          attemptId: "att_task400003",
          attemptNumber: 2,
          executionStatus: "running",
          verificationStatus: "pending",
          evidenceIds: [],
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

afterEach(cleanup);

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
    expect(screen.getByText("执行：执行中 · 验证：待验证")).not.toBeNull();
    expect(screen.getByText(failedAgentProfileId).closest("p")?.textContent)
      .toBe(`Agent Profile：${failedAgentProfileId}`);
    expect(screen.getByText("证据：1 项")).not.toBeNull();
  });

  it("announces loading, empty, and failure states without inventing a successful conclusion", async () => {
    const pending = deferred<typeof runView>();
    const first = render(<RunPage runId={runA} api={{ getRun: () => pending.promise }} />);
    expect(screen.getByRole("status").textContent).toContain("正在加载 Run");
    first.unmount();
    pending.resolve(runView);

    const empty = RunViewHttpResponseSchema.parse({ runId: runA, status: "created", steps: [] });
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
    expect(screen.getByRole("status", { name: "实时更新状态" }).textContent).toContain("实时更新已连接");

    act(() => handlers?.onError());
    expect(screen.getByRole("status", { name: "实时更新状态" }).textContent).toContain("正在重新连接");
    rendered.unmount();

    handlers = undefined;
    render(<RunPage runId={runA} api={{ getRun: async () => runView }} eventStream={stream} />);
    await screen.findByRole("heading", { name: `Run ${runA}` });
    act(() => handlers?.onResyncRequired({
      schemaVersion: 1,
      runId: runA,
      code: "EVENT_CURSOR_RESYNC_REQUIRED",
      retentionFloor: 4,
      highWaterPosition: 9,
    }));
    expect(screen.getByRole("alert").textContent).toContain("需要重新同步");
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
    act(() => handlers?.onEvent({ runId: runA, position: "bad" }));
    expect(screen.getByRole("alert").textContent).toContain("收到无效事件");
  });
});
