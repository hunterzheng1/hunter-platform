import { useEffect, useRef, useState } from "react";
import {
  RunEventEnvelopeHttpSchema,
  RunEventGapHttpSchema,
} from "@hunter/api-contracts";
import type { RunId } from "@hunter/domain/ids";

export interface RunEventStreamHandlers {
  readonly onEvent: (event: unknown) => void;
  readonly onError: () => void;
  readonly onCursorGap: (signal: unknown) => void;
}

export interface AuthorizedRunEventStream {
  subscribe(
    input: { readonly runId: RunId; readonly after: number },
    handlers: RunEventStreamHandlers,
  ): () => void;
}

export type RunEventConnection =
  | { readonly status: "unavailable" }
  | { readonly status: "live" }
  | { readonly status: "reconnecting" }
  | { readonly status: "refreshing" }
  | { readonly status: "refresh_error"; readonly retry: () => void }
  | { readonly status: "resyncing" }
  | { readonly status: "gap_error"; readonly retry: () => void }
  | { readonly status: "invalid_event" };

const RECONNECT_DELAY_MS = 250;

function storageKey(runId: RunId): string {
  return `hunter-run-event:${runId}`;
}

function writeCursor(runId: RunId, cursor: number): void {
  try {
    globalThis.sessionStorage?.setItem(storageKey(runId), String(cursor));
  } catch {
    // Storage may be unavailable in a hardened renderer. The in-memory cursor remains authoritative.
  }
}

export function useRunEvents(
  runId: RunId,
  initialPosition: number,
  onChange: () => number | Promise<number>,
  stream: AuthorizedRunEventStream | undefined,
): RunEventConnection {
  const initialPositionRef = useRef(initialPosition);
  initialPositionRef.current = initialPosition;
  const [connection, setConnection] = useState<RunEventConnection>(
    stream === undefined ? { status: "unavailable" } : { status: "live" },
  );

  useEffect(() => {
    if (stream === undefined) {
      setConnection({ status: "unavailable" });
      return;
    }
    let active = true;
    const snapshotPosition = initialPositionRef.current;
    let cursor = Number.isSafeInteger(snapshotPosition) && snapshotPosition >= 0 ? snapshotPosition : 0;
    let generation = 0;
    let disconnect: (() => void) | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      if (cursor > 0 || globalThis.sessionStorage?.getItem(storageKey(runId)) !== null) {
        writeCursor(runId, cursor);
      }
    } catch {
      // Storage is optional; the validated snapshot position remains authoritative in memory.
    }

    const stopCurrentSubscription = () => {
      const current = disconnect;
      disconnect = undefined;
      current?.();
    };

    const clearReconnectTimer = () => {
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    };

    const terminate = (token: number, next: RunEventConnection) => {
      if (!active || generation !== token) return;
      generation += 1;
      clearReconnectTimer();
      stopCurrentSubscription();
      setConnection(next);
    };

    const beginGapRecovery = (
      signal: import("@hunter/api-contracts").RunEventGapHttp,
      expectedGeneration: number,
    ) => {
      if (!active || generation !== expectedGeneration) return;
      generation += 1;
      const recoveryGeneration = generation;
      clearReconnectTimer();
      stopCurrentSubscription();
      setConnection({ status: "resyncing" });
      let reload: number | Promise<number>;
      try {
        reload = onChange();
      } catch (caught) {
        reload = Promise.reject(caught);
      }
      void Promise.resolve(reload)
        .then((snapshotPosition) => {
          if (!active || generation !== recoveryGeneration) return;
          if (!Number.isSafeInteger(snapshotPosition) || snapshotPosition < signal.highWaterPosition) {
            throw new Error("RUN_SNAPSHOT_BEHIND_EVENT_GAP");
          }
          cursor = snapshotPosition;
          writeCursor(runId, cursor);
          connect();
        })
        .catch(() => {
          if (!active || generation !== recoveryGeneration) return;
          setConnection({
            status: "gap_error",
            retry: () => beginGapRecovery(signal, recoveryGeneration),
          });
        });
    };

    const beginEventRefresh = (requiredPosition: number, expectedGeneration: number) => {
      if (!active || generation !== expectedGeneration) return;
      generation += 1;
      const refreshGeneration = generation;
      clearReconnectTimer();
      stopCurrentSubscription();
      setConnection({ status: "refreshing" });
      let refresh: number | Promise<number>;
      try {
        refresh = onChange();
      } catch (caught) {
        refresh = Promise.reject(caught);
      }
      void Promise.resolve(refresh)
        .then((snapshotPosition) => {
          if (!active || generation !== refreshGeneration) return;
          if (!Number.isSafeInteger(snapshotPosition) || snapshotPosition < requiredPosition) {
            throw new Error("RUN_SNAPSHOT_BEHIND_EVENT");
          }
          cursor = snapshotPosition;
          writeCursor(runId, cursor);
          connect();
        })
        .catch(() => {
          if (!active || generation !== refreshGeneration) return;
          setConnection({
            status: "refresh_error",
            retry: () => beginEventRefresh(requiredPosition, refreshGeneration),
          });
        });
    };

    const connect = () => {
      if (!active) return;
      const token = generation + 1;
      generation = token;
      setConnection({ status: "live" });

      const scheduleReconnect = () => {
        if (!active || generation !== token) return;
        generation += 1;
        clearReconnectTimer();
        stopCurrentSubscription();
        setConnection({ status: "reconnecting" });
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          connect();
        }, RECONNECT_DELAY_MS);
      };

      let returnedDisconnect: (() => void) | undefined;
      try {
        returnedDisconnect = stream.subscribe({ runId, after: cursor }, {
          onEvent(value) {
            if (!active || generation !== token) return;
            const parsed = RunEventEnvelopeHttpSchema.safeParse(value);
            if (!parsed.success) {
              terminate(token, { status: "invalid_event" });
              return;
            }
            const event = parsed.data;
            if (event.runId !== runId || event.position <= cursor) return;
            beginEventRefresh(event.position, token);
          },
          onError: scheduleReconnect,
          onCursorGap(value) {
            if (!active || generation !== token) return;
            const parsed = RunEventGapHttpSchema.safeParse(value);
            if (!parsed.success || parsed.data.runId !== runId) {
              terminate(token, { status: "invalid_event" });
              return;
            }
            beginGapRecovery(parsed.data, token);
          },
        });
      } catch {
        scheduleReconnect();
        return;
      }
      if (!active || generation !== token) {
        returnedDisconnect();
        return;
      }
      disconnect = returnedDisconnect;
    };

    connect();
    return () => {
      active = false;
      generation += 1;
      clearReconnectTimer();
      stopCurrentSubscription();
    };
  }, [onChange, runId, stream]);

  return connection;
}
