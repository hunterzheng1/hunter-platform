import {
  deriveRunStatus,
  type IngestEventInput,
  type IngestItemResult,
  type RunEventRecord,
  type RunRecord,
  type RunStore
} from "./store.js";

export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly events: RunEventRecord[] = [];
  private cursor = 0;

  async ensureRun(input: {
    runId: string;
    projectId: string;
    changeKey: string;
    title?: string;
  }): Promise<RunRecord> {
    const existing = this.runs.get(input.runId);
    if (existing !== undefined) return existing;
    const now = new Date().toISOString();
    const record: RunRecord = {
      runId: input.runId,
      projectId: input.projectId,
      changeKey: input.changeKey,
      title: input.title ?? input.changeKey,
      runStatus: "running",
      connectionStatus: "offline",
      syncCompleteness: "pending",
      currentPhase: null,
      startedAt: now,
      endedAt: null,
      lastEventAt: null,
      lastHeartbeatAt: null,
      serverCursor: 0,
      createdAt: now,
      updatedAt: now
    };
    this.runs.set(input.runId, record);
    return record;
  }

  async ingestBatch(input: {
    projectId: string;
    runId: string;
    events: IngestEventInput[];
  }): Promise<{ items: IngestItemResult[]; run: RunRecord }> {
    const run = this.runs.get(input.runId);
    if (run === undefined || run.projectId !== input.projectId) {
      throw new Error("RUN_NOT_FOUND");
    }
    const items: IngestItemResult[] = [];
    const now = new Date().toISOString();
    for (const event of input.events) {
      if (!event.eventId || !event.eventType || event.producerSeq < 1) {
        items.push({
          id: event.eventId || "",
          status: "rejected_schema",
          server_cursor: null,
          error_code: "INVALID_EVENT"
        });
        continue;
      }
      const byId = this.events.find(
        (row) => row.projectId === input.projectId && row.eventId === event.eventId
      );
      if (byId !== undefined) {
        const same =
          byId.producerSeq === event.producerSeq &&
          byId.eventType === event.eventType;
        items.push({
          id: event.eventId,
          status: same ? "duplicate_accepted" : "id_conflict",
          server_cursor: same ? byId.serverCursor : null,
          error_code: same ? null : "ID_CONFLICT"
        });
        continue;
      }
      const bySeq = this.events.find(
        (row) => row.runId === input.runId && row.producerSeq === event.producerSeq
      );
      if (bySeq !== undefined) {
        items.push({
          id: event.eventId,
          status: "id_conflict",
          server_cursor: null,
          error_code: "SEQ_CONFLICT"
        });
        continue;
      }
      this.cursor += 1;
      const record: RunEventRecord = {
        serverCursor: this.cursor,
        projectId: input.projectId,
        runId: input.runId,
        eventId: event.eventId,
        producerSeq: event.producerSeq,
        eventType: event.eventType,
        phase: event.phase ?? null,
        occurredAt: event.occurredAt,
        payload: event.payload,
        receivedAt: now
      };
      this.events.push(record);
      run.serverCursor = this.cursor;
      run.lastEventAt = event.occurredAt;
      run.currentPhase = event.phase ?? run.currentPhase;
      run.runStatus = deriveRunStatus(run.runStatus, event.eventType, {
        ...event.payload,
        phase: event.phase
      });
      if (run.runStatus !== "running" && run.endedAt === null) {
        run.endedAt = event.occurredAt;
      }
      run.connectionStatus = "online";
      run.syncCompleteness = "pending";
      run.updatedAt = now;
      items.push({
        id: event.eventId,
        status: "accepted",
        server_cursor: this.cursor,
        error_code: null
      });
    }
    // Contiguous seq from 1 ⇒ complete; otherwise pending/gapped.
    const seqs = this.events
      .filter((row) => row.runId === input.runId)
      .map((row) => row.producerSeq)
      .sort((a, b) => a - b);
    run.syncCompleteness = isContiguous(seqs) ? "complete" : "gapped";
    return { items, run };
  }

  async heartbeat(input: {
    projectId: string;
    runId: string;
    clientTime: string;
  }): Promise<RunRecord | null> {
    const run = this.runs.get(input.runId);
    if (run === undefined || run.projectId !== input.projectId) return null;
    run.lastHeartbeatAt = input.clientTime;
    run.connectionStatus = "online";
    run.updatedAt = new Date().toISOString();
    return run;
  }

  async listRuns(projectId: string, options: {
    limit?: number;
    cursor?: string | null;
    status?: string;
  } = {}): Promise<{ items: RunRecord[]; nextCursor: string | null; total: number }> {
    const limit = options.limit ?? 50;
    const offset = options.cursor === null || options.cursor === undefined || options.cursor === ""
      ? 0
      : Number.parseInt(Buffer.from(options.cursor, "base64url").toString("utf8"), 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("INVALID_CURSOR");
    }
    const filtered = [...this.runs.values()]
      .filter((run) => run.projectId === projectId)
      .filter((run) => options.status === undefined || run.runStatus === options.status)
      .sort((a, b) => {
        const left = a.startedAt ?? a.lastEventAt ?? a.createdAt;
        const right = b.startedAt ?? b.lastEventAt ?? b.createdAt;
        return right.localeCompare(left) || b.runId.localeCompare(a.runId);
      });
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return {
      items,
      total: filtered.length,
      nextCursor: nextOffset < filtered.length
        ? Buffer.from(String(nextOffset)).toString("base64url")
        : null
    };
  }

  async getRun(projectId: string, runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    if (run === undefined || run.projectId !== projectId) return null;
    return run;
  }

  async listEvents(
    runId: string,
    options: { afterCursor?: number; limit?: number } = {}
  ): Promise<RunEventRecord[]> {
    const after = options.afterCursor ?? 0;
    const limit = options.limit ?? 200;
    return this.events
      .filter((row) => row.runId === runId && row.serverCursor > after)
      .sort((a, b) => a.serverCursor - b.serverCursor)
      .slice(0, limit);
  }
}

function isContiguous(seqs: number[]): boolean {
  if (seqs.length === 0) return true;
  if (seqs[0] !== 1) return false;
  for (let i = 1; i < seqs.length; i += 1) {
    if ((seqs[i] ?? 0) !== (seqs[i - 1] ?? 0) + 1) return false;
  }
  return true;
}
