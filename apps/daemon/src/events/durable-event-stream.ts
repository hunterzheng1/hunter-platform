import type { ProjectId } from "@hunter/domain";
import type { EventLedgerReader, LedgerEvent } from "@hunter/storage";
import type { FastifyInstance } from "fastify";

import { requirePrincipal } from "../http/security-hooks.js";

export type ReplayResult =
  | { readonly status: "ok"; readonly retentionFloor: number; readonly highWaterPosition: number; readonly events: readonly LedgerEvent[] }
  | { readonly status: "resync_required"; readonly code: "EVENT_CURSOR_RESYNC_REQUIRED"; readonly retentionFloor: number; readonly highWaterPosition: number; readonly snapshotUrl: string };

function parseCursor(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error("EVENT_CURSOR_INVALID");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new Error("EVENT_CURSOR_INVALID");
  return cursor;
}

export class DurableEventStream {
  private activeConnections = 0;
  private readonly activeByPrincipal: Record<string, number> = {};

  public constructor(
    private readonly reader: EventLedgerReader,
    private readonly limits: { readonly global: number; readonly perPrincipal: number } = { global: 32, perPrincipal: 4 },
  ) {}

  public replay(input: { readonly headerCursor?: string | undefined; readonly queryCursor?: string | undefined; readonly authorizedProjectIds: readonly ProjectId[]; readonly limit?: number | undefined }): ReplayResult {
    if (input.headerCursor !== undefined && input.queryCursor !== undefined && input.headerCursor !== input.queryCursor) {
      throw new Error("EVENT_CURSOR_CONFLICT");
    }
    const position = parseCursor(input.headerCursor ?? input.queryCursor);
    const highWaterPosition = this.reader.highWaterPosition();
    if (position > highWaterPosition) throw new Error("EVENT_CURSOR_INVALID");
    const page = this.reader.readAfter({ position, authorizedProjectIds: input.authorizedProjectIds, limit: input.limit ?? 100 });
    if (page.status === "resync_required") {
      return { status: "resync_required", code: "EVENT_CURSOR_RESYNC_REQUIRED", retentionFloor: page.retentionFloor, highWaterPosition: page.highWaterPosition, snapshotUrl: "/events/snapshot" };
    }
    return page;
  }

  public format(events: readonly LedgerEvent[]): string {
    return events.map((event) => `id: ${event.position}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  }

  public readerTail(input: { readonly position: number; readonly authorizedProjectIds: readonly ProjectId[]; readonly signal: AbortSignal }) {
    return this.reader.tail({ ...input, pollIntervalMs: 100 });
  }

  public snapshot(authorizedProjectIds: readonly ProjectId[]) {
    return { projectionVersion: 1, cursor: this.reader.highWaterPosition(), authorizedProjectIds };
  }

  public acquire(principalId: string): () => void {
    const principalCount = this.activeByPrincipal[principalId] ?? 0;
    if (this.activeConnections >= this.limits.global || principalCount >= this.limits.perPrincipal) {
      throw new Error("SSE_CONNECTION_LIMIT");
    }
    this.activeConnections += 1;
    this.activeByPrincipal[principalId] = principalCount + 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeConnections -= 1;
      const next = (this.activeByPrincipal[principalId] ?? 1) - 1;
      if (next === 0) delete this.activeByPrincipal[principalId];
      else this.activeByPrincipal[principalId] = next;
    };
  }
}

export function registerDurableEventRoutes(app: FastifyInstance, stream: DurableEventStream): void {
  app.get("/events", async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as { cursor?: string | undefined; once?: string | undefined };
    try {
      const result = stream.replay({
        headerCursor: typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined,
        queryCursor: query.cursor,
        authorizedProjectIds: principal.authorizedProjectIds,
      });
      if (result.status === "resync_required") return await reply.code(409).send(result);
      if (query.once === "1") {
        reply.header("content-type", "text/event-stream; charset=utf-8");
        return stream.format(result.events);
      }
      const release = stream.acquire(principal.principalId);
      const abort = new AbortController();
      request.raw.once("close", () => abort.abort());
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
      });
      reply.raw.write(stream.format(result.events));
      const lastPosition = result.events.at(-1)?.position ?? parseCursor(
        typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : query.cursor,
      );
      try {
        for await (const event of stream.readerTail({
          position: lastPosition,
          authorizedProjectIds: principal.authorizedProjectIds,
          signal: abort.signal,
        })) {
          reply.raw.write(stream.format([event]));
        }
      } finally {
        release();
        if (!reply.raw.writableEnded) reply.raw.end();
      }
      return;
    } catch (error) {
      const code = error instanceof Error ? error.message : "EVENT_CURSOR_INVALID";
      return await reply.code(400).send({ code });
    }
  });
  app.get("/events/snapshot", async (request) => {
    const principal = requirePrincipal(request);
    return stream.snapshot(principal.authorizedProjectIds);
  });
}
