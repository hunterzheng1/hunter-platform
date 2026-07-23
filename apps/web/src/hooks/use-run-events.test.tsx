// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
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

function Harness({ runId, stream, onChange }: {
  readonly runId: typeof runA;
  readonly stream: AuthorizedRunEventStream;
  readonly onChange: () => void;
}) {
  const connection = useRunEvents(runId, onChange, stream);
  return <output>{connection.status}</output>;
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.useRealTimers();
});

describe("useRunEvents", () => {
  it("advances a scoped monotonic cursor and ignores replayed, out-of-order, and cross-Run events", () => {
    const { stream, subscriptions } = createStream();
    const onChange = vi.fn();
    sessionStorage.setItem(`hunter-run-event:${runA}`, "3");
    render(<Harness runId={runA} stream={stream} onChange={onChange} />);
    expect(subscriptions[0]?.input).toEqual({ runId: runA, after: 3 });

    act(() => subscriptions[0]?.handlers.onEvent({ schemaVersion: 1, position: 5, runId: runA, eventType: "run_projection_changed" }));
    act(() => subscriptions[0]?.handlers.onEvent({ schemaVersion: 1, position: 4, runId: runA, eventType: "run_projection_changed" }));
    act(() => subscriptions[0]?.handlers.onEvent({ schemaVersion: 1, position: 8, runId: runB, eventType: "run_projection_changed" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(`hunter-run-event:${runA}`)).toBe("5");
    expect(screen.getByText("live")).not.toBeNull();
  });

  it("fails closed for malformed envelopes and corrupt saved cursors", () => {
    const { stream, subscriptions } = createStream();
    const onChange = vi.fn();
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
    const rendered = render(<Harness runId={runA} stream={stream} onChange={vi.fn()} />);
    act(() => subscriptions[0]?.handlers.onEvent({ schemaVersion: 1, position: 6, runId: runA, eventType: "run_projection_changed" }));
    act(() => subscriptions[0]?.handlers.onError());
    expect(screen.getByText("reconnecting")).not.toBeNull();
    expect(subscriptions[0]?.cleanup).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(250));
    expect(subscriptions[1]?.input).toEqual({ runId: runA, after: 6 });
    rendered.unmount();
    expect(subscriptions[1]?.cleanup).toHaveBeenCalledTimes(1);
  });

  it("reports an authorized resync requirement without refreshing or reconnecting", () => {
    vi.useFakeTimers();
    const { stream, subscriptions } = createStream();
    const onChange = vi.fn();
    render(<Harness runId={runA} stream={stream} onChange={onChange} />);
    act(() => subscriptions[0]?.handlers.onResyncRequired({
      schemaVersion: 1,
      runId: runA,
      code: "EVENT_CURSOR_RESYNC_REQUIRED",
      retentionFloor: 4,
      highWaterPosition: 9,
    }));

    expect(screen.getByText("resync_required")).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(subscriptions).toHaveLength(1);
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
    const rendered = render(<Harness runId={runA} stream={stream} onChange={vi.fn()} />);
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

    expect(() => render(<Harness runId={runA} stream={stream} onChange={vi.fn()} />)).not.toThrow();
    expect(screen.getByText("reconnecting")).not.toBeNull();
    act(() => vi.advanceTimersByTime(250));
    expect(subscribe).toHaveBeenCalledTimes(2);
    cleanup();
    expect(finalCleanup).toHaveBeenCalledTimes(1);
  });
});
