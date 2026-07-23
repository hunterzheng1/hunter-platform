import { useEffect, useState } from "react";
import {
  RunEventEnvelopeHttpSchema,
  RunEventResyncHttpSchema,
} from "@hunter/api-contracts";
import type { RunId } from "@hunter/domain/ids";

export interface RunEventStreamHandlers {
  readonly onEvent: (event: unknown) => void;
  readonly onError: () => void;
  readonly onResyncRequired: (signal: unknown) => void;
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
  | { readonly status: "resync_required"; readonly retentionFloor: number; readonly highWaterPosition: number }
  | { readonly status: "invalid_event" };

const RECONNECT_DELAY_MS = 250;

function storageKey(runId: RunId): string {
  return `hunter-run-event:${runId}`;
}

function readCursor(runId: RunId): number {
  try {
    const value = globalThis.sessionStorage?.getItem(storageKey(runId));
    if (value === null || !/^(0|[1-9][0-9]*)$/u.test(value)) return 0;
    const cursor = Number(value);
    return Number.isSafeInteger(cursor) ? cursor : 0;
  } catch {
    return 0;
  }
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
  onChange: () => void,
  stream: AuthorizedRunEventStream | undefined,
): RunEventConnection {
  const [connection, setConnection] = useState<RunEventConnection>(
    stream === undefined ? { status: "unavailable" } : { status: "live" },
  );

  useEffect(() => {
    if (stream === undefined) {
      setConnection({ status: "unavailable" });
      return;
    }
    let active = true;
    let cursor = readCursor(runId);
    let generation = 0;
    let disconnect: (() => void) | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

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
            cursor = event.position;
            writeCursor(runId, cursor);
            setConnection({ status: "live" });
            onChange();
          },
          onError: scheduleReconnect,
          onResyncRequired(value) {
            if (!active || generation !== token) return;
            const parsed = RunEventResyncHttpSchema.safeParse(value);
            if (!parsed.success || parsed.data.runId !== runId) {
              terminate(token, { status: "invalid_event" });
              return;
            }
            terminate(token, {
              status: "resync_required",
              retentionFloor: parsed.data.retentionFloor,
              highWaterPosition: parsed.data.highWaterPosition,
            });
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
