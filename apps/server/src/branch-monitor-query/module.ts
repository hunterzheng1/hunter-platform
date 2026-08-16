import { createHash } from "node:crypto";

import {
  platformInformationDetailRequestSchema,
  platformInformationDetailResponseSchema,
  platformInformationPageSchema,
  platformInformationPlanPhaseSchema,
  readPlatformInformationContract
} from "@hunter-harness/contracts";
import { z } from "zod";

import type { BranchMonitorQueryAdapterDependencies } from "./ports.js";
import type {
  BranchMonitorDetailResult,
  BranchMonitorDetailSourceRequest,
  BranchMonitorPageResult,
  BranchMonitorPageSourceRequest,
  Stage12MonitorVerifierRequest
} from "./types.js";

const MAX_SERIALIZED_BYTES = 2_000_000;
const MAX_BUNDLE_BYTES = 1_000_000;
const idSchema = z.string().min(1).max(160);
const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u);
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const cursorSchema = z.string().regex(/^[A-Za-z0-9_-]{16,512}$/u).nullable();
const serializedBundleSchema = z.string().min(2).max(MAX_BUNDLE_BYTES);

const failureSchema = z.object({
  reason_code: z.enum(["PROJECT_INFORMATION_FORBIDDEN", "PROJECTION_PARTIAL_FAILURE"]),
  retryable: z.boolean()
}).strict();

const sourceIdentity = {
  schema_version: z.literal(1),
  actor_id: idSchema,
  project_id: projectIdSchema,
  accessible_project_ids: z.array(projectIdSchema).min(1).max(100),
  content_types: z.tuple([z.literal("run_event")]),
  sort: z.literal("last_event_at_desc_run_id_asc"),
  request_cursor: cursorSchema
} as const;

const sourcePageSchema = z.object({
  ...sourceIdentity,
  source_kind: z.literal("branch_monitor_page"),
  page_state: z.enum(["ready", "empty", "processing", "partial_failure", "forbidden"]),
  stage12_bundles: z.array(serializedBundleSchema).max(100),
  next_cursor: cursorSchema,
  failures: z.array(failureSchema).max(10)
}).strict();

const sourceDetailSchema = z.object({
  ...sourceIdentity,
  source_kind: z.literal("branch_monitor_detail"),
  request_cursor: z.null(),
  detail_id: idSchema,
  stage12_bundle: serializedBundleSchema
}).strict();

const planEventTypeSchema = z.enum([
  "phase_started",
  "decision_recorded",
  "risk_found",
  "artifact_published",
  "validation_failed",
  "phase_ended"
]);

const monitorEventSchema = z.object({
  event_id: idSchema,
  idempotency_key: hashSchema,
  type: planEventTypeSchema,
  phase: platformInformationPlanPhaseSchema,
  attempt: z.number().int().positive(),
  producer_seq: z.number().int().positive(),
  occurred_at: timestampSchema,
  display_summary_zh: z.string().min(1).max(2048),
  technical_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u).nullable(),
  detail_ref: z.string().min(1).max(512).nullable(),
  receipt_ref: z.string().min(1).max(512).nullable()
}).strict();

const monitorProjectionSchema = z.object({
  schema_version: z.literal(1),
  anchor_kind: z.literal("stage12_monitor_projection"),
  bundle_sha256: hashSchema,
  project_id: projectIdSchema,
  lifecycle_kind: z.literal("change"),
  run_id: idSchema,
  branch_name: z.string().min(1).max(512),
  change_key: idSchema,
  run_status: z.enum(["running", "succeeded", "failed", "partial"]),
  current_phase: platformInformationPlanPhaseSchema.nullable(),
  started_at: timestampSchema,
  ended_at: timestampSchema.nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  last_event_at: timestampSchema,
  events: z.array(monitorEventSchema).max(100)
}).strict().superRefine((value, context) => {
  if (new Set(value.events.map((event) => event.event_id)).size !== value.events.length ||
      new Set(value.events.map((event) => event.idempotency_key)).size !== value.events.length) {
    context.addIssue({ code: "custom", message: "event identities must be unique" });
  }
  for (let index = 1; index < value.events.length; index += 1) {
    const previous = value.events[index - 1];
    const current = value.events[index];
    if (previous === undefined || current === undefined || previous.attempt > current.attempt ||
        (previous.attempt === current.attempt && previous.producer_seq >= current.producer_seq)) {
      context.addIssue({ code: "custom", message: "events must preserve Stage 12 producer order" });
      break;
    }
  }
});

type SourcePage = z.infer<typeof sourcePageSchema>;
type SourceDetail = z.infer<typeof sourceDetailSchema>;
type MonitorProjection = z.infer<typeof monitorProjectionSchema>;

function parseSerialized<T>(serialized: unknown, schema: z.ZodType<T>): T | null {
  if (typeof serialized !== "string" || serialized.length > MAX_SERIALIZED_BYTES) return null;
  try {
    const result = schema.safeParse(JSON.parse(serialized) as unknown);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function sha256(serialized: string): string {
  return `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function pageRequest(value: {
  project_id: string;
  query_scope: { actor_id: string; accessible_project_ids: string[] };
  limit: number;
  cursor: string | null;
}): BranchMonitorPageSourceRequest {
  return {
    project_id: value.project_id,
    actor_id: value.query_scope.actor_id,
    accessible_project_ids: value.query_scope.accessible_project_ids,
    content_types: ["run_event"],
    sort: "last_event_at_desc_run_id_asc",
    request_cursor: value.cursor,
    limit: value.limit,
    cursor: value.cursor
  };
}

function detailRequest(value: {
  project_id: string;
  query_scope: { actor_id: string; accessible_project_ids: string[] };
  detail_id: string;
}): BranchMonitorDetailSourceRequest {
  return {
    project_id: value.project_id,
    actor_id: value.query_scope.actor_id,
    accessible_project_ids: value.query_scope.accessible_project_ids,
    content_types: ["run_event"],
    sort: "last_event_at_desc_run_id_asc",
    request_cursor: null,
    detail_id: value.detail_id
  };
}

function sourceEchoMatches(
  source: SourcePage | SourceDetail,
  request: BranchMonitorPageSourceRequest | BranchMonitorDetailSourceRequest
): boolean {
  return source.actor_id === request.actor_id && source.project_id === request.project_id &&
    sameStrings(source.accessible_project_ids, request.accessible_project_ids) &&
    sameStrings(source.content_types, request.content_types) && source.sort === request.sort &&
    source.request_cursor === request.request_cursor;
}

function pageStateIsConsistent(source: SourcePage): boolean {
  if (source.page_state === "ready") {
    return source.stage12_bundles.length > 0 && source.failures.length === 0;
  }
  if (source.page_state === "partial_failure") {
    return source.stage12_bundles.length > 0 && source.failures.length > 0 &&
      source.failures.every((failure) => failure.reason_code === "PROJECTION_PARTIAL_FAILURE");
  }
  if (source.page_state === "forbidden") {
    return source.stage12_bundles.length === 0 && source.next_cursor === null &&
      source.failures.length === 1 &&
      source.failures[0]?.reason_code === "PROJECT_INFORMATION_FORBIDDEN" &&
      source.failures[0].retryable === false;
  }
  return source.stage12_bundles.length === 0 && source.next_cursor === null && source.failures.length === 0;
}

function compareProjection(left: MonitorProjection, right: MonitorProjection): number {
  const timeDifference = Date.parse(right.last_event_at) - Date.parse(left.last_event_at);
  if (timeDifference !== 0) return timeDifference;
  return left.run_id < right.run_id ? -1 : left.run_id > right.run_id ? 1 : 0;
}

async function verifyBundle(
  dependencies: BranchMonitorQueryAdapterDependencies,
  serializedBundle: string,
  projectId: string
): Promise<MonitorProjection | null> {
  const request: Stage12MonitorVerifierRequest = {
    serialized_bundle: serializedBundle,
    bundle_sha256: sha256(serializedBundle),
    project_id: projectId
  };
  let serializedProjection: string;
  try {
    serializedProjection = await dependencies.stage12_verifier_port.verify(request);
  } catch {
    return null;
  }
  const projection = parseSerialized(serializedProjection, monitorProjectionSchema);
  return projection !== null && projection.project_id === projectId &&
    projection.bundle_sha256 === request.bundle_sha256 ? projection : null;
}

export interface BranchMonitorQueryAdapter {
  queryPage(serializedRequest: unknown): Promise<BranchMonitorPageResult>;
  queryDetail(serializedRequest: unknown): Promise<BranchMonitorDetailResult>;
}

export function createBranchMonitorQueryAdapter(
  dependencies: BranchMonitorQueryAdapterDependencies
): BranchMonitorQueryAdapter {
  return {
    async queryPage(serializedRequest) {
      const read = readPlatformInformationContract(serializedRequest);
      if (read.ok && read.mode === "legacy_read_only") {
        return { ok: false, reason_code: "BRANCH_MONITOR_LEGACY_READ_ONLY" };
      }
      if (!read.ok || read.mode !== "current" || read.value.contract_kind !== "query" ||
          read.value.view !== "branch_monitor") {
        return { ok: false, reason_code: "BRANCH_MONITOR_QUERY_INVALID" };
      }
      const request = read.value;
      if (request.cursor !== null) {
        let cursorValid: unknown;
        try {
          cursorValid = await dependencies.cursor_verifier.verify({
            cursor: request.cursor,
            project_id: request.project_id,
            actor_id: request.query_scope.actor_id,
            view: "branch_monitor",
            sort: "last_event_at_desc_run_id_asc"
          });
        } catch {
          return { ok: false, reason_code: "BRANCH_MONITOR_CURSOR_INVALID" };
        }
        if (cursorValid !== true) {
          return { ok: false, reason_code: "BRANCH_MONITOR_CURSOR_INVALID" };
        }
      }
      const sourceRequest = pageRequest(request);
      let serializedSource: string;
      try {
        serializedSource = await dependencies.source_port.listPage(sourceRequest);
      } catch {
        return { ok: false, reason_code: "BRANCH_MONITOR_SOURCE_INVALID" };
      }
      const source = parseSerialized(serializedSource, sourcePageSchema);
      if (source === null || !sourceEchoMatches(source, sourceRequest) ||
          source.stage12_bundles.length > request.limit || !pageStateIsConsistent(source)) {
        return { ok: false, reason_code: "BRANCH_MONITOR_SOURCE_INVALID" };
      }
      const projections = await Promise.all(source.stage12_bundles.map((serializedBundle) =>
        verifyBundle(dependencies, serializedBundle, request.project_id)));
      if (projections.some((projection) => projection === null)) {
        return { ok: false, reason_code: "BRANCH_MONITOR_SOURCE_INVALID" };
      }
      const trusted = projections as MonitorProjection[];
      if (new Set(trusted.map((projection) => projection.run_id)).size !== trusted.length) {
        return { ok: false, reason_code: "BRANCH_MONITOR_SOURCE_INVALID" };
      }
      for (let index = 1; index < trusted.length; index += 1) {
        const previous = trusted[index - 1];
        const current = trusted[index];
        if (previous === undefined || current === undefined || compareProjection(previous, current) >= 0) {
          return { ok: false, reason_code: "BRANCH_MONITOR_SOURCE_INVALID" };
        }
      }
      const output = platformInformationPageSchema.safeParse({
        schema_version: 1,
        contract_kind: "page",
        view: "branch_monitor",
        project_id: request.project_id,
        page_state: source.page_state,
        sort: "last_event_at_desc_run_id_asc",
        items: trusted.map((projection) => ({
          item_kind: "branch_monitor",
          lifecycle_kind: projection.lifecycle_kind,
          run_id: projection.run_id,
          branch_name: projection.branch_name,
          change_key: projection.change_key,
          run_status: projection.run_status,
          current_phase: projection.current_phase,
          started_at: projection.started_at,
          ended_at: projection.ended_at,
          duration_ms: projection.duration_ms,
          last_event_at: projection.last_event_at,
          sort_key: `${projection.last_event_at}|${projection.run_id}`
        })),
        next_cursor: source.next_cursor,
        failures: source.failures
      });
      return output.success
        ? { ok: true, value: output.data }
        : { ok: false, reason_code: "BRANCH_MONITOR_SOURCE_INVALID" };
    },

    async queryDetail(serializedRequest) {
      const read = readPlatformInformationContract(serializedRequest);
      if (read.ok && read.mode === "legacy_read_only") {
        return { ok: false, reason_code: "BRANCH_MONITOR_LEGACY_READ_ONLY" };
      }
      if (!read.ok || read.mode !== "current" || read.value.contract_kind !== "detail_request") {
        return { ok: false, reason_code: "BRANCH_MONITOR_QUERY_INVALID" };
      }
      const parsedRequest = platformInformationDetailRequestSchema.safeParse(read.value);
      if (!parsedRequest.success || parsedRequest.data.view !== "branch_monitor") {
        return { ok: false, reason_code: "BRANCH_MONITOR_QUERY_INVALID" };
      }
      const request = parsedRequest.data;
      const sourceRequest = detailRequest(request);
      let serializedSource: string;
      try {
        serializedSource = await dependencies.source_port.getDetail(sourceRequest);
      } catch {
        return { ok: false, reason_code: "BRANCH_MONITOR_SOURCE_INVALID" };
      }
      const source = parseSerialized(serializedSource, sourceDetailSchema);
      if (source === null || !sourceEchoMatches(source, sourceRequest) || source.detail_id !== request.detail_id) {
        return { ok: false, reason_code: "BRANCH_MONITOR_SOURCE_INVALID" };
      }
      const projection = await verifyBundle(dependencies, source.stage12_bundle, request.project_id);
      if (projection === null || projection.run_id !== request.detail_id) {
        return { ok: false, reason_code: "BRANCH_MONITOR_SOURCE_INVALID" };
      }
      const output = platformInformationDetailResponseSchema.safeParse({
        schema_version: 1,
        contract_kind: "detail_response",
        view: "branch_monitor",
        project_id: request.project_id,
        detail_id: request.detail_id,
        detail: {
          detail_kind: "branch_monitor",
          lifecycle_kind: "change",
          event_refs: projection.events.map((event) => event.event_id)
        }
      });
      return output.success
        ? { ok: true, value: output.data }
        : { ok: false, reason_code: "BRANCH_MONITOR_SOURCE_INVALID" };
    }
  };
}
