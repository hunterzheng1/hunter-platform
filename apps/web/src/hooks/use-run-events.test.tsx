// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunIdSchema } from "@hunter/domain/ids";

import {
  useRunEvents,
  type AuthorizedRunEventStream,
  type RunEventStreamHandlers,
} from "./use-run-events.js";

const runA = RunIdSchema.parse("run_task400001");
const runB = RunIdSchema.parse("run_task400002");

interface Subscription {
  readonly input: { readonly runId: typeof runA; readonly after: number };
  readonly handlers: RunEventStreamHandlers;
  readonly cleanup: ReturnType<typeof vi.fn>;
}

function createStream(): { readonly stream: AuthorizedRunEventStream; readonly subscriptions: Subscription[] } {
  const subscriptions: Subscription[] = [];
  const stream: AuthorizedRunEventStream = {
    subscribe(input, handlers) {
      const cleanupSubscription = vi.fn();
      subscriptions.push({ input, handlers, cleanup: cleanupSubscription });
      return cleanupSubscription;
    },
  };
  return { stream, subscriptions };
}

function Harness({ runId, initialPosition = 0, stream, onChange }: {
  readonly runId: typeof runA;
  readonly initialPosition?: number;
  readonly stream: AuthorizedRunEventStream;
  readonly onChange: () => number | Promise<number>;
}) {
  const connection = useRunEvents(runId, initialPosition, onChange, stream);
  const retry = connection.status === "gap_error" || connection.status === "refresh_error" ? connection.retry : undefined;
  return <><output>{connection.status}</output>{retry === undefined ? null : <button type="button" onClick={retry}>重试</button>}</>;
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.useRealTimers();
});

describe("useRunEvents", () => {
  it("advances a scoped monotonic cursor, refreshes the snapshot, and resumes after the cursor", async () => {
    const { stream, subscriptions } = createStream();
    const onChange = vi.fn(async () => 5);
    sessionStorage.setItem(`hunter-run-event:${runA}`, "9");
    render(<Harness runId={runA} initialPosition={3} stream={stream} onChange={onChange} />);
    expect(subscriptions[0]?.input).toEqual({ runId: runA, after: 3 });

    await act(async () => subscriptions[0]?.handlers.onEvent({ schemaVersion: 1, position: 5, runId: runA, eventType: "run_projection_changed" }));
    act(() => subscriptions[0]?.handlers.onEvent({ schemaVersion: 1, position: 4, runId: runA, eventType: "run_projection_changed" }));
    act(() => subscriptions[0]?.handlers.onEvent({ schemaVersion: 1, position: 8, runId: runB, eventType: "run_projection_changed" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(`hunter-run-event:${runA}`)).toBe("5");
    expect(subscriptions[0]?.cleanup).toHaveBeenCalledTimes(1);
    expect(subscriptions[1]?.input).toEqual({ runId: runA, after: 5 });
    expect(screen.getByText("live")).not.toBeNull();
  });

  it("fails closed for malformed envelopes and corrupt saved cursors", () => {
    const { stream, subscriptions } = createStream();
    const onChange = vi.fn(() => 0);
    sessionStorage.setItem(`hunter-run-event:${runA}`, "NaN");
    render(<Harness runId={runA} stream={stream} onChange={onChange} />);
    expect(subscriptions[0]?.input.after).toBe(0);

    act(() => subscriptions[0]?.handlers.onEvent({ position: 1, runId: runA }));
    expect(screen.getByText("invalid_event")).not.toBeNull();
    expect(subscriptions[0]?.cleanup).toHaveBeenCalledTimes(1);
    act(() => subscriptions[0]?.handlers.onEvent({ schemaVersion: 1, position: 2, runId: runA, eventType: "run_projection_changed" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("invalid_event")).not.toBeNull();
  });

  it("reconnects from the last committed cursor and cleans up every subscription", () => {
    vi.useFakeTimers();
    const { stream, subscriptions } = createStream();
    const rendered = render(<Harness runId={runA} initialPosition={6} stream={stream} onChange={() => 6} />);
    expect(subscriptions[0]?.input).toEqual({ runId: runA, after: 6 });
    act(() => subscriptions[0]?.handlers.onError());
    expect(screen.getByText("reconnecting")).not.toBeNull();
    expect(subscriptions[0]?.cleanup).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(250));
    expect(subscriptions[1]?.input).toEqual({ runId: runA, after: 6 });
    rendered.unmount();
    expect(subscriptions[1]?.cleanup).toHaveBeenCalledTimes(1);
  });

  it("recovers an EVENT_CURSOR_GAP through snapshot refresh and resumes after the high-water cursor", async () => {
    const { stream, subscriptions } = createStream();
    let finishReload: (() => void) | undefined;
    const onChange = vi.fn(() => new Promise<number>((resolve) => { finishReload = () => resolve(11); }));
    render(<Harness runId={runA} initialPosition={3} stream={stream} onChange={onChange} />);
    act(() => subscriptions[0]?.handlers.onCursorGap({
      schemaVersion: 1,
      runId: runA,
      code: "EVENT_CURSOR_GAP",
      retentionFloor: 4,
      highWaterPosition: 9,
      instructions: { snapshot: "reload_run_snapshot", rebuild: "replace_run_projection_from_snapshot", resume: "subscribe_after_high_water_position" },
    }));

    expect(screen.getByText("resyncing")).not.toBeNull();
    expect(subscriptions[0]?.cleanup).toHaveBeenCalledTimes(1);
    await act(async () => finishReload?.());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(`hunter-run-event:${runA}`)).toBe("11");
    expect(subscriptions[1]?.input).toEqual({ runId: runA, after: 11 });
    expect(screen.getByText("live")).not.toBeNull();
  });

  it("keeps a failed gap recovery explicit and retries without claiming live", async () => {
    const { stream, subscriptions } = createStream();
    const onChange = vi.fn()
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(9);
    render(<Harness runId={runA} initialPosition={3} stream={stream} onChange={onChange} />);
    await act(async () => subscriptions[0]?.handlers.onCursorGap({
      schemaVersion: 1,
      runId: runA,
      code: "EVENT_CURSOR_GAP",
      retentionFloor: 4,
      highWaterPosition: 9,
      instructions: { snapshot: "reload_run_snapshot", rebuild: "replace_run_projection_from_snapshot", resume: "subscribe_after_high_water_position" },
    }));

    expect(screen.getByText("gap_error")).not.toBeNull();
    expect(subscriptions).toHaveLength(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试" })));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(subscriptions[1]?.input).toEqual({ runId: runA, after: 9 });
  });

  it("rejects a lagging ordinary-event snapshot and retries without advancing the cursor", async () => {
    const { stream, subscriptions } = createStream();
    const onChange = vi.fn()
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5);
    render(<Harness runId={runA} initialPosition={3} stream={stream} onChange={onChange} />);
    await act(async () => subscriptions[0]?.handlers.onEvent({ schemaVersion: 1, position: 5, runId: runA, eventType: "run_projection_changed" }));

    expect(screen.getByText("refresh_error")).not.toBeNull();
    expect(subscriptions).toHaveLength(1);
    expect(sessionStorage.getItem(`hunter-run-event:${runA}`)).toBe("3");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试" })));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(subscriptions[1]?.input).toEqual({ runId: runA, after: 5 });
    expect(screen.getByText("live")).not.toBeNull();
  });

  it("does not advance or resubscribe an old Run when gap recovery resolves after switching Runs", async () => {
    const { stream, subscriptions } = createStream();
    let finishReload: (() => void) | undefined;
    const onChange = vi.fn(() => new Promise<number>((resolve) => { finishReload = () => resolve(9); }));
    const rendered = render(<Harness runId={runA} stream={stream} onChange={onChange} />);
    act(() => subscriptions[0]?.handlers.onCursorGap({
      schemaVersion: 1,
      runId: runA,
      code: "EVENT_CURSOR_GAP",
      retentionFloor: 4,
      highWaterPosition: 9,
      instructions: { snapshot: "reload_run_snapshot", rebuild: "replace_run_projection_from_snapshot", resume: "subscribe_after_high_water_position" },
    }));
    rendered.rerender(<Harness runId={runB} stream={stream} onChange={() => 0} />);
    expect(subscriptions[1]?.input).toEqual({ runId: runB, after: 0 });
    await act(async () => finishReload?.());
    expect(sessionStorage.getItem(`hunter-run-event:${runA}`)).toBeNull();
    expect(subscriptions).toHaveLength(2);
  });

  it("cleans a subscription that synchronously reports an error before returning its cleanup", () => {
    vi.useFakeTimers();
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    let subscriptionCount = 0;
    const stream: AuthorizedRunEventStream = {
      subscribe(_input, handlers) {
        subscriptionCount += 1;
        if (subscriptionCount === 1) {
          handlers.onError();
          return firstCleanup;
        }
        return secondCleanup;
      },
    };
    const rendered = render(<Harness runId={runA} stream={stream} onChange={() => 0} />);
    expect(screen.getByText("reconnecting")).not.toBeNull();
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(250));
    expect(subscriptionCount).toBe(2);
    rendered.unmount();
    expect(secondCleanup).toHaveBeenCalledTimes(1);
  });

  it("turns a synchronous subscribe failure into an explicit reconnect without escaping render", () => {
    vi.useFakeTimers();
    const finalCleanup = vi.fn();
    const subscribe = vi.fn()
      .mockImplementationOnce(() => { throw new Error("host stream unavailable"); })
      .mockImplementationOnce(() => finalCleanup);
    const stream: AuthorizedRunEventStream = { subscribe };

    expect(() => render(<Harness runId={runA} stream={stream} onChange={() => 0} />)).not.toThrow();
    expect(screen.getByText("reconnecting")).not.toBeNull();
    act(() => vi.advanceTimersByTime(250));
    expect(subscribe).toHaveBeenCalledTimes(2);
    cleanup();
    expect(finalCleanup).toHaveBeenCalledTimes(1);
  });
});
