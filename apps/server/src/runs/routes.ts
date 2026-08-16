import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { planEventSchema } from "@hunter-harness/contracts";

import type { Actor, ProjectKeyScope, ServerRepository } from "../repositories/interfaces.js";
import { ServerDomainError } from "../repositories/interfaces.js";
import {
  aggregateRunPhases,
  publicEvent,
  publicRun,
  sanitizeEventPayload,
  type RunRecord,
  type RunStore
} from "./store.js";

export interface RunRoutesOptions {
  repository: ServerRepository;
  runStore: RunStore;
  authenticated: (
    request: FastifyRequest,
    repository: ServerRepository,
    projectScope?: ProjectKeyScope
  ) => Promise<{ actor: Actor; requestId: string }>;
}

const batchSchema = z.object({
  protocol_version: z.literal("hunter-progress-sync/v1"),
  run_id: z.string().min(1),
  change_key: z.string().min(1),
  lifecycle_kind: z.literal("change").optional(),
  branch_name: z.string().min(1).max(512).optional(),
  source_version: z.literal("plan-event-bundle/v1").optional(),
  title: z.string().min(1).max(200).optional(),
  events: z.array(z.object({
    event_id: z.string().min(1),
    producer_seq: z.number().int().min(1),
    event_type: z.string().min(1),
    phase: z.string().optional(),
    occurred_at: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).default({}),
    attempt: z.number().int().min(1).max(1_000_000).optional(),
    idempotency_key: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
    summary_zh: z.string().min(1).max(2048).optional(),
    detail_ref: z.string().min(1).max(512).optional(),
    receipt_ref: z.string().min(1).max(512).optional()
  }).strict()).max(500)
}).strict().superRefine((value, context) => {
  const marked = value.lifecycle_kind === "change";
  if (marked !== (value.branch_name !== undefined && value.source_version !== undefined)) {
    context.addIssue({ code: "custom", message: "change lifecycle identity must be complete" });
  }
  if (marked && value.events.some((event) => event.attempt === undefined ||
      event.idempotency_key === undefined || event.phase === undefined)) {
    context.addIssue({ code: "custom", message: "change events require Stage 12 identity" });
  }
});

const heartbeatSchema = z.object({
  protocol_version: z.literal("hunter-progress-sync/v1"),
  run_id: z.string().min(1),
  change_key: z.string().min(1),
  lifecycle_kind: z.literal("change").optional(),
  branch_name: z.string().min(1).max(512).optional(),
  source_version: z.literal("plan-event-bundle/v1").optional(),
  client_time: z.string().min(1),
  title: z.string().min(1).max(200).optional()
}).strict().superRefine((value, context) => {
  const marked = value.lifecycle_kind === "change";
  if (marked !== (value.branch_name !== undefined && value.source_version !== undefined)) {
    context.addIssue({ code: "custom", message: "change lifecycle identity must be complete" });
  }
});

async function publicRunWithPhases(
  runStore: RunStore,
  run: RunRecord
): Promise<Record<string, unknown>> {
  const events = await runStore.listEvents(run.runId, { afterCursor: 0, limit: 2000 });
  return publicRun(run, aggregateRunPhases(events), events);
}

async function ensureRunIdentity(
  runStore: RunStore,
  input: Parameters<RunStore["ensureRun"]>[0]
): Promise<RunRecord> {
  try {
    return await runStore.ensureRun(input);
  } catch (error) {
    if (error instanceof Error && error.message === "RUN_IDENTITY_CONFLICT") {
      throw new ServerDomainError(409, "RUN_IDENTITY_CONFLICT", "run identity is immutable");
    }
    throw error;
  }
}

export function registerRunRoutes(app: FastifyInstance, options: RunRoutesOptions): void {
  const { repository, runStore, authenticated } = options;

  app.post("/api/v1/projects/:projectId/runs/events:batch", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "progress:write");
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    const body = batchSchema.parse(request.body);
    await ensureRunIdentity(runStore, {
      runId: body.run_id,
      projectId,
      changeKey: body.change_key,
      lifecycleKind: body.lifecycle_kind ?? "legacy_unmarked",
      branchName: body.branch_name ?? null,
      sourceVersion: body.source_version ?? null,
      ...(body.title === undefined ? {} : { title: body.title })
    });
    const result = await runStore.ingestBatch({
      projectId,
      runId: body.run_id,
      events: body.events.map((event) => ({
        eventId: event.event_id,
        producerSeq: event.producer_seq,
        eventType: event.event_type,
        ...(event.phase === undefined ? {} : { phase: event.phase }),
        occurredAt: event.occurred_at,
        payload: sanitizeEventPayload(event.payload),
        ...(body.lifecycle_kind === "change" ? { planEvent: planEventSchema.parse({
          schema_version: 1 as const,
          event_id: event.event_id,
          lifecycle_kind: "change" as const,
          run_id: body.run_id,
          change_key: body.change_key,
          phase: event.phase ?? "",
          attempt: event.attempt ?? 0,
          type: event.event_type,
          producer_seq: event.producer_seq,
          occurred_at: event.occurred_at,
          idempotency_key: event.idempotency_key ?? "",
          ...(event.summary_zh === undefined ? {} : { summary_zh: event.summary_zh }),
          ...(event.detail_ref === undefined ? {} : { detail_ref: event.detail_ref }),
          ...(event.receipt_ref === undefined ? {} : { receipt_ref: event.receipt_ref })
        }) } : {})
      }))
    });
    reply.header("X-Request-Id", requestId);
    return {
      server_time: new Date().toISOString(),
      items: result.items,
      run: await publicRunWithPhases(runStore, result.run),
      request_id: requestId
    };
  });

  app.post("/api/v1/projects/:projectId/runs/heartbeats", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository, "progress:write");
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    const body = heartbeatSchema.parse(request.body);
    await ensureRunIdentity(runStore, {
      runId: body.run_id,
      projectId,
      changeKey: body.change_key,
      lifecycleKind: body.lifecycle_kind ?? "legacy_unmarked",
      branchName: body.branch_name ?? null,
      sourceVersion: body.source_version ?? null,
      ...(body.title === undefined ? {} : { title: body.title })
    });
    const run = await runStore.heartbeat({
      projectId,
      runId: body.run_id,
      // Connection freshness is a server observation. A skewed or malicious
      // client clock must not keep a disconnected run online indefinitely.
      clientTime: new Date(Date.now()).toISOString()
    });
    if (run === null) {
      throw new ServerDomainError(404, "RUN_NOT_FOUND", "run not found");
    }
    reply.header("X-Request-Id", requestId);
    return { run: await publicRunWithPhases(runStore, run), request_id: requestId };
  });

  app.get("/api/v1/projects/:projectId/runs", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(actor.actorId, projectId);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().min(1).optional(),
      status: z.string().min(1).optional()
    }).strict().parse(request.query);
    const listed = await runStore.listRuns(projectId, {
      limit: query.limit,
      cursor: query.cursor ?? null,
      ...(query.status === undefined ? {} : { status: query.status })
    });
    const items = await Promise.all(
      listed.items.map((run) => publicRunWithPhases(runStore, run))
    );
    reply.header("X-Request-Id", requestId);
    return {
      items,
      total: listed.total,
      next_cursor: listed.nextCursor,
      request_id: requestId
    };
  });

  app.get("/api/v1/projects/:projectId/runs/:runId", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId, runId } = request.params as { projectId: string; runId: string };
    await repository.getProject(actor.actorId, projectId);
    const run = await runStore.getRun(projectId, runId);
    if (run === null) {
      throw new ServerDomainError(404, "RUN_NOT_FOUND", "run not found");
    }
    reply.header("X-Request-Id", requestId);
    return { run: await publicRunWithPhases(runStore, run), request_id: requestId };
  });

  app.get("/api/v1/projects/:projectId/runs/:runId/events", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId, runId } = request.params as { projectId: string; runId: string };
    await repository.getProject(actor.actorId, projectId);
    const run = await runStore.getRun(projectId, runId);
    if (run === null) {
      throw new ServerDomainError(404, "RUN_NOT_FOUND", "run not found");
    }
    const query = z.object({
      after_cursor: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(500).default(200)
    }).strict().parse(request.query);
    const items = await runStore.listEvents(runId, {
      afterCursor: query.after_cursor,
      limit: query.limit
    });
    reply.header("X-Request-Id", requestId);
    return {
      items: items.map(publicEvent),
      next_cursor: items.length === 0
        ? query.after_cursor
        : items[items.length - 1]?.serverCursor ?? query.after_cursor,
      request_id: requestId
    };
  });

  // SSE: poll the store and emit newly arrived events (simple v1 stream).
  app.get("/api/v1/projects/:projectId/runs/:runId/stream", async (request, reply) => {
    const { actor, requestId } = await authenticated(request, repository);
    const { projectId, runId } = request.params as { projectId: string; runId: string };
    await repository.getProject(actor.actorId, projectId);
    const run = await runStore.getRun(projectId, runId);
    if (run === null) {
      throw new ServerDomainError(404, "RUN_NOT_FOUND", "run not found");
    }
    const query = z.object({
      after_cursor: z.coerce.number().int().min(0).optional()
    }).strict().parse(request.query);
    const lastEventIdHeader = request.headers["last-event-id"];
    const lastEventId = typeof lastEventIdHeader === "string"
      ? Number.parseInt(lastEventIdHeader, 10)
      : Number.NaN;
    const afterCursor = query.after_cursor !== undefined
      ? query.after_cursor
      : (Number.isFinite(lastEventId) && lastEventId >= 0 ? lastEventId : 0);

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Request-Id": requestId
    });

    let cursor = afterCursor;
    let closed = false;
    const send = (event: string, data: unknown, id?: number): void => {
      if (closed) return;
      const idLine = id === undefined ? "" : `id: ${id}\n`;
      reply.raw.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("snapshot", await publicRunWithPhases(runStore, run));

    const tick = async (): Promise<void> => {
      if (closed) return;
      try {
        const events = await runStore.listEvents(runId, { afterCursor: cursor, limit: 50 });
        for (const event of events) {
          send("event", publicEvent(event), event.serverCursor);
          cursor = event.serverCursor;
        }
        const latest = await runStore.getRun(projectId, runId);
        if (latest !== null) send("run", await publicRunWithPhases(runStore, latest));
      } catch {
        // ignore transient read errors during stream
      }
    };

    const interval = setInterval(() => {
      void tick();
    }, 2000);
    await tick();

    request.raw.on("close", () => {
      closed = true;
      clearInterval(interval);
      reply.raw.end();
    });
  });
}
