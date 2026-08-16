import { createHash } from "node:crypto";

import { canonicalJson, PLAN_EVENT_PHASES } from "@hunter-harness/contracts";

import type {
  BranchMonitorDetailSourceRequest,
  BranchMonitorPageSourceRequest,
  BranchMonitorSourcePort
} from "../branch-monitor-query/index.js";
import type { RunRecord, RunStore, StoredPlanEvent } from "./store.js";
import { decodeRunCursor, encodeRunCursor } from "./store.js";
import type { BranchMonitorCursorPort } from "./branch-monitor-cursor.js";

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

type EventBundleResult =
  | { readonly kind: "ready"; readonly serialized: string }
  | { readonly kind: "not_ready" }
  | { readonly kind: "invalid"; readonly reason: string };

async function eventBundle(store: RunStore, run: RunRecord): Promise<EventBundleResult> {
  const stored = await store.listEvents(run.runId, { afterCursor: 0, limit: 4097 });
  if (stored.length > 4096) return { kind: "invalid", reason: "BRANCH_MONITOR_EVENT_LIMIT_EXCEEDED" };
  if (stored.length === 0) return { kind: "not_ready" };
  const projected = stored.filter((event) => event.planEvent !== null)
    .sort((left, right) => {
      const leftEvent = left.planEvent;
      const rightEvent = right.planEvent;
      if (leftEvent === null || rightEvent === null) return 0;
      return PLAN_EVENT_PHASES.indexOf(leftEvent.phase) - PLAN_EVENT_PHASES.indexOf(rightEvent.phase) ||
        leftEvent.attempt - rightEvent.attempt || leftEvent.producer_seq - rightEvent.producer_seq;
    });
  if (projected.length !== stored.length) {
    return { kind: "invalid", reason: "BRANCH_MONITOR_EVENT_IDENTITY_INVALID" };
  }
  const events: StoredPlanEvent[] = [];
  const sequences = new Set<string>();
  const eventIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const [index, row] of projected.entries()) {
    const event = row.planEvent;
    if (event === null || event.run_id !== run.runId || event.change_key !== run.changeKey ||
        event.lifecycle_kind !== "change" || row.eventId !== event.event_id ||
        row.producerSeq !== event.producer_seq || row.eventType !== event.type ||
        row.phase !== event.phase || row.occurredAt !== event.occurred_at ||
        sequences.has(`${event.phase}:${event.attempt}:${event.producer_seq}`) || eventIds.has(event.event_id) ||
        idempotencyKeys.has(event.idempotency_key) ||
        (index > 0 && event.phase === events[index - 1]?.phase && event.attempt === events[index - 1]?.attempt &&
          event.producer_seq <= (events[index - 1]?.producer_seq ?? 0))) {
      return { kind: "invalid", reason: "BRANCH_MONITOR_EVENT_IDENTITY_INVALID" };
    }
    sequences.add(`${event.phase}:${event.attempt}:${event.producer_seq}`);
    eventIds.add(event.event_id); idempotencyKeys.add(event.idempotency_key);
    events.push(event);
  }
  const body = {
    schema_version: 1 as const,
    lifecycle_kind: "change" as const,
    run_id: run.runId,
    change_key: run.changeKey,
    events
  };
  const serialized = JSON.stringify({ ...body, bundle_hash: hash(body) });
  return serialized.length <= 1_000_000
    ? { kind: "ready", serialized }
    : { kind: "invalid", reason: "BRANCH_MONITOR_BUNDLE_TOO_LARGE" };
}

function assertScope(input: BranchMonitorPageSourceRequest | BranchMonitorDetailSourceRequest): void {
  if (!input.accessible_project_ids.includes(input.project_id) ||
      input.content_types.length !== 1 || input.content_types[0] !== "run_event" ||
      input.sort !== "last_event_at_desc_run_id_asc") {
    throw new Error("BRANCH_MONITOR_FORBIDDEN");
  }
}

export function createRunStoreBranchMonitorSource(
  store: RunStore,
  cursorPort: BranchMonitorCursorPort
): BranchMonitorSourcePort {
  return {
    async listPage(input) {
      assertScope(input);
      const offset = input.cursor === null ? 0 : await cursorPort.decode({
        cursor: input.cursor, actor_id: input.actor_id, project_id: input.project_id,
        view: "branch_monitor", sort: input.sort
      });
      if (offset === null) throw new Error("BRANCH_MONITOR_CURSOR_INVALID");
      const bundles: string[] = [];
      const visited = new Set<number>();
      let rawOffset = offset;
      let nextOffset: number | null = offset;
      let scannedRows = 0;
      let invalidRows = 0;
      let firstInvalidReason: string | null = null;
      let notReadyRows = 0;
      for (let page = 0; page < 100 && bundles.length < input.limit && nextOffset !== null; page += 1) {
        if (visited.has(rawOffset)) throw new Error("BRANCH_MONITOR_CURSOR_CYCLE");
        visited.add(rawOffset);
        const remaining = input.limit - bundles.length;
        const listed = await store.listRuns(input.project_id, {
          limit: remaining, cursor: encodeRunCursor(rawOffset), lifecycleKind: "change"
        });
        scannedRows += listed.items.length;
        for (const run of listed.items) {
          const result = await eventBundle(store, run);
          if (result.kind === "ready") bundles.push(result.serialized);
          else if (result.kind === "not_ready") notReadyRows += 1;
          else { invalidRows += 1; firstInvalidReason ??= result.reason; }
        }
        if (listed.nextCursor === null) {
          nextOffset = null;
        } else {
          const candidate = decodeRunCursor(listed.nextCursor);
          if (candidate <= rawOffset) throw new Error("BRANCH_MONITOR_CURSOR_NO_PROGRESS");
          rawOffset = candidate;
          nextOffset = candidate;
        }
      }
      const hitScanLimit = nextOffset !== null && bundles.length < input.limit;
      if (invalidRows > 0 && bundles.length === 0) {
        throw new Error(firstInvalidReason ?? "BRANCH_MONITOR_EVENT_IDENTITY_INVALID");
      }
      if (hitScanLimit && bundles.length === 0) throw new Error("BRANCH_MONITOR_SCAN_LIMIT_EXCEEDED");
      const hasPartial = invalidRows > 0 || notReadyRows > 0 || hitScanLimit;
      return JSON.stringify({
        schema_version: 1,
        source_kind: "branch_monitor_page",
        actor_id: input.actor_id,
        project_id: input.project_id,
        accessible_project_ids: [...input.accessible_project_ids],
        content_types: ["run_event"],
        sort: input.sort,
        request_cursor: input.request_cursor,
        page_state: bundles.length === 0
          ? (scannedRows > 0 ? "processing" : "empty")
          : (hasPartial ? "partial_failure" : "ready"),
        stage12_bundles: bundles,
        next_cursor: nextOffset === null ? null : await cursorPort.issue({
          actor_id: input.actor_id, project_id: input.project_id,
          view: "branch_monitor", sort: input.sort,
          offset: nextOffset
        }),
        failures: hasPartial && bundles.length > 0
          ? [{ reason_code: "PROJECTION_PARTIAL_FAILURE", retryable: true }]
          : []
      });
    },
    async getDetail(input) {
      assertScope(input);
      const run = await store.getRun(input.project_id, input.detail_id);
      if (run === null || run.lifecycleKind !== "change") throw new Error("RUN_NOT_FOUND");
      const bundle = await eventBundle(store, run);
      if (bundle.kind === "not_ready") throw new Error("RUN_EVENTS_NOT_READY");
      if (bundle.kind === "invalid") throw new Error(bundle.reason);
      return JSON.stringify({
        schema_version: 1,
        source_kind: "branch_monitor_detail",
        actor_id: input.actor_id,
        project_id: input.project_id,
        accessible_project_ids: [...input.accessible_project_ids],
        content_types: ["run_event"],
        sort: input.sort,
        request_cursor: null,
        detail_id: input.detail_id,
        stage12_bundle: bundle.serialized
      });
    }
  };
}
