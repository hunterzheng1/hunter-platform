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
  public constructor(private readonly reader: EventLedgerReader) {}

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

  public snapshot(authorizedProjectIds: readonly ProjectId[]) {
    return { projectionVersion: 1, cursor: this.reader.highWaterPosition(), authorizedProjectIds };
  }
}

export function registerDurableEventRoutes(app: FastifyInstance, stream: DurableEventStream): void {
  app.get("/events", async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as { cursor?: string | undefined };
    try {
      const result = stream.replay({
        headerCursor: typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined,
        queryCursor: query.cursor,
        authorizedProjectIds: principal.authorizedProjectIds,
      });
      if (result.status === "resync_required") return await reply.code(409).send(result);
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.header("connection", "close");
      return stream.format(result.events);
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
