import { createHash } from "node:crypto";

import {
  canonicalJson,
  platformInformationDetailRequestSchema,
  platformInformationDetailResponseSchema,
  platformInformationPageSchema,
  readPlatformInformationContract,
  verifyKnowledgeExtractionRetryIntent
} from "@hunter-harness/contracts";
import { z } from "zod";

import type { ProjectKnowledgeQueryAdapterDependencies } from "./ports.js";
import type {
  ProjectKnowledgeDetailResult,
  ProjectKnowledgeDetailSourceRequest,
  ProjectKnowledgePageResult,
  ProjectKnowledgePageSourceRequest,
  ProjectKnowledgeRetryIntentResult
} from "./types.js";

const MAX_SERIALIZED_BYTES = 2_000_000;
const idSchema = z.string().min(1).max(160);
const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u);
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const cursorSchema = z.string().regex(/^[A-Za-z0-9_-]{16,512}$/u).nullable();

const sourceEntrySchema = z.object({
  entry_origin: z.literal("explicit"),
  knowledge_id: idSchema,
  display_title: z.string().min(1).max(240),
  lifecycle_status: z.enum([
    "candidate", "active", "stale", "deprecated", "superseded", "conflicted"
  ]),
  source_change_key: idSchema,
  source_refs: z.array(idSchema).min(1).max(100),
  extracted_at: timestampSchema,
  relationship_refs: z.array(idSchema).max(100)
}).strict().superRefine((value, context) => {
  if (new Set(value.source_refs).size !== value.source_refs.length ||
      new Set(value.relationship_refs).size !== value.relationship_refs.length) {
    context.addIssue({ code: "custom", message: "knowledge references must be unique" });
  }
});

const failureSchema = z.object({
  reason_code: z.enum([
    "PROJECT_INFORMATION_FORBIDDEN",
    "KNOWLEDGE_EXTRACTION_FAILED",
    "PROJECTION_PARTIAL_FAILURE"
  ]),
  retryable: z.boolean()
}).strict();

const sourcePageSchema = z.object({
  schema_version: z.literal(1),
  source_kind: z.literal("project_knowledge_page"),
  actor_id: idSchema,
  project_id: projectIdSchema,
  accessible_project_ids: z.array(projectIdSchema).min(1).max(100),
  content_types: z.tuple([z.literal("knowledge_entry")]),
  sort: z.literal("extracted_at_desc_knowledge_id_asc"),
  request_cursor: cursorSchema,
  page_state: z.enum([
    "ready", "empty", "processing", "partial_failure", "failed", "forbidden"
  ]),
  entries: z.array(sourceEntrySchema).max(100),
  next_cursor: cursorSchema,
  failures: z.array(failureSchema).max(1)
}).strict();

const sourceDetailSchema = z.object({
  schema_version: z.literal(1),
  source_kind: z.literal("project_knowledge_detail"),
  actor_id: idSchema,
  project_id: projectIdSchema,
  accessible_project_ids: z.array(projectIdSchema).min(1).max(100),
  content_types: z.tuple([z.literal("knowledge_entry")]),
  sort: z.literal("extracted_at_desc_knowledge_id_asc"),
  request_cursor: z.null(),
  detail_id: idSchema,
  entry_origin: z.literal("explicit"),
  knowledge_id: idSchema,
  display_title: z.string().min(1).max(240),
  source_change_key: idSchema,
  source_refs: z.array(idSchema).min(1).max(100),
  content: z.string().max(MAX_SERIALIZED_BYTES),
  content_hash: hashSchema,
  media_type: z.enum(["text/plain", "text/markdown", "application/json", "application/yaml"])
}).strict().superRefine((value, context) => {
  if (new Set(value.source_refs).size !== value.source_refs.length) {
    context.addIssue({ code: "custom", message: "knowledge source refs must be unique" });
  }
});

const retryRequestSchema = z.object({
  schema_version: z.literal(1),
  contract_kind: z.literal("knowledge_extraction_retry_request"),
  actor_id: idSchema,
  project_id: projectIdSchema,
  job_id: z.string().regex(/^job_knowledge_[A-Za-z0-9._:-]{1,146}$/u),
  expected_generation: z.number().int().nonnegative()
}).strict();

const retryAuthorityBase = {
  schema_version: z.literal(1),
  authority_kind: z.literal("knowledge_retry_authority"),
  actor_id: idSchema,
  project_id: projectIdSchema,
  job_id: z.string().regex(/^job_knowledge_[A-Za-z0-9._:-]{1,146}$/u),
  expected_generation: z.number().int().nonnegative()
} as const;

const retryAuthoritySchema = z.discriminatedUnion("decision", [
  z.object({
    ...retryAuthorityBase,
    decision: z.literal("authorized"),
    accessible_project_ids: z.array(projectIdSchema).min(1).max(100),
    job_status: z.literal("failed"),
    retryable: z.literal(true)
  }).strict().superRefine((value, context) => {
    if (new Set(value.accessible_project_ids).size !== value.accessible_project_ids.length ||
        !value.accessible_project_ids.includes(value.project_id)) {
      context.addIssue({ code: "custom", message: "retry authority project allowlist is invalid" });
    }
  }),
  z.object({ ...retryAuthorityBase, decision: z.literal("forbidden") }).strict(),
  z.object({ ...retryAuthorityBase, decision: z.literal("not_found") }).strict()
]);

function parseSerialized<T>(serialized: unknown, schema: z.ZodType<T>): T | null {
  if (typeof serialized !== "string" || serialized.length > MAX_SERIALIZED_BYTES) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(serialized) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function pageSourceRequest(value: {
  project_id: string;
  query_scope: { actor_id: string; accessible_project_ids: string[] };
  limit: number;
  cursor: string | null;
}): ProjectKnowledgePageSourceRequest {
  return {
    project_id: value.project_id,
    actor_id: value.query_scope.actor_id,
    accessible_project_ids: value.query_scope.accessible_project_ids,
    content_types: ["knowledge_entry"],
    limit: value.limit,
    cursor: value.cursor,
    sort: "extracted_at_desc_knowledge_id_asc",
    request_cursor: value.cursor
  };
}

function detailSourceRequest(value: {
  project_id: string;
  query_scope: { actor_id: string; accessible_project_ids: string[] };
  detail_id: string;
}): ProjectKnowledgeDetailSourceRequest {
  return {
    project_id: value.project_id,
    actor_id: value.query_scope.actor_id,
    accessible_project_ids: value.query_scope.accessible_project_ids,
    content_types: ["knowledge_entry"],
    detail_id: value.detail_id,
    sort: "extracted_at_desc_knowledge_id_asc",
    request_cursor: null
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function pageEchoMatches(
  page: z.infer<typeof sourcePageSchema>,
  request: ProjectKnowledgePageSourceRequest
): boolean {
  return page.actor_id === request.actor_id && page.project_id === request.project_id &&
    sameStrings(page.accessible_project_ids, request.accessible_project_ids) &&
    sameStrings(page.content_types, request.content_types) && page.sort === request.sort &&
    page.request_cursor === request.cursor;
}

function detailEchoMatches(
  detail: z.infer<typeof sourceDetailSchema>,
  request: ProjectKnowledgeDetailSourceRequest
): boolean {
  return detail.actor_id === request.actor_id && detail.project_id === request.project_id &&
    sameStrings(detail.accessible_project_ids, request.accessible_project_ids) &&
    sameStrings(detail.content_types, request.content_types) && detail.sort === request.sort &&
    detail.request_cursor === null && detail.detail_id === request.detail_id;
}

function compareEntries(
  left: z.infer<typeof sourceEntrySchema>,
  right: z.infer<typeof sourceEntrySchema>
): number {
  const timeDifference = Date.parse(right.extracted_at) - Date.parse(left.extracted_at);
  if (timeDifference !== 0) return timeDifference;
  return left.knowledge_id < right.knowledge_id ? -1 : left.knowledge_id > right.knowledge_id ? 1 : 0;
}

function pageIsConsistent(page: z.infer<typeof sourcePageSchema>, limit: number): boolean {
  if (page.entries.length > limit ||
      new Set(page.entries.map((entry) => entry.knowledge_id)).size !== page.entries.length) return false;
  for (let index = 1; index < page.entries.length; index += 1) {
    const previous = page.entries[index - 1];
    const current = page.entries[index];
    if (previous === undefined || current === undefined || compareEntries(previous, current) >= 0) {
      return false;
    }
  }
  if (page.page_state === "ready") {
    return page.entries.length > 0 && page.failures.length === 0;
  }
  if (page.page_state === "partial_failure") {
    return page.entries.length > 0 && page.failures.length > 0 &&
      page.failures.every((failure) => failure.reason_code === "PROJECTION_PARTIAL_FAILURE");
  }
  if (page.page_state === "failed") {
    return page.entries.length === 0 && page.next_cursor === null && page.failures.length === 1 &&
      page.failures[0]?.reason_code === "KNOWLEDGE_EXTRACTION_FAILED" &&
      page.failures[0]?.retryable === true;
  }
  if (page.page_state === "forbidden") {
    return page.entries.length === 0 && page.next_cursor === null && page.failures.length === 1 &&
      page.failures[0]?.reason_code === "PROJECT_INFORMATION_FORBIDDEN" &&
      page.failures[0]?.retryable === false;
  }
  return page.entries.length === 0 && page.next_cursor === null && page.failures.length === 0;
}

export interface ProjectKnowledgeQueryAdapter {
  queryPage(serializedRequest: unknown): Promise<ProjectKnowledgePageResult>;
  queryDetail(serializedRequest: unknown): Promise<ProjectKnowledgeDetailResult>;
  createRetryIntent(serializedRequest: unknown): Promise<ProjectKnowledgeRetryIntentResult>;
}

export function createProjectKnowledgeQueryAdapter(
  dependencies: ProjectKnowledgeQueryAdapterDependencies
): ProjectKnowledgeQueryAdapter {
  return {
    async queryPage(serializedRequest) {
      const read = readPlatformInformationContract(serializedRequest);
      if (read.ok && read.mode === "legacy_read_only") {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_LEGACY_READ_ONLY" };
      }
      if (!read.ok || read.mode !== "current" || read.value.contract_kind !== "query" ||
          read.value.view !== "project_knowledge") {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_QUERY_INVALID" };
      }
      const request = read.value;
      if (request.cursor !== null) {
        let valid: boolean;
        try {
          valid = await dependencies.cursor_verifier.verify({
            cursor: request.cursor,
            project_id: request.project_id,
            actor_id: request.query_scope.actor_id,
            view: "project_knowledge",
            sort: "extracted_at_desc_knowledge_id_asc"
          });
        } catch {
          return { ok: false, reason_code: "PROJECT_KNOWLEDGE_CURSOR_INVALID" };
        }
        if (valid !== true) {
          return { ok: false, reason_code: "PROJECT_KNOWLEDGE_CURSOR_INVALID" };
        }
      }
      const sourceRequest = pageSourceRequest(request);
      let serializedSource: string;
      try {
        serializedSource = await dependencies.source_port.listPage(sourceRequest);
      } catch {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_SOURCE_INVALID" };
      }
      const source = parseSerialized(serializedSource, sourcePageSchema);
      if (source === null || !pageEchoMatches(source, sourceRequest) ||
          !pageIsConsistent(source, request.limit)) {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_SOURCE_INVALID" };
      }
      const output = platformInformationPageSchema.safeParse({
        schema_version: 1,
        contract_kind: "page",
        view: "project_knowledge",
        project_id: request.project_id,
        page_state: source.page_state,
        sort: "extracted_at_desc_knowledge_id_asc",
        items: source.entries.map((entry) => ({
          item_kind: "knowledge_entry",
          knowledge_id: entry.knowledge_id,
          display_title: entry.display_title,
          lifecycle_status: entry.lifecycle_status,
          source_change_key: entry.source_change_key,
          extracted_at: entry.extracted_at,
          relationship_count: entry.relationship_refs.length,
          sort_key: `${entry.extracted_at}|${entry.knowledge_id}`
        })),
        next_cursor: source.next_cursor,
        failures: source.failures
      });
      return output.success
        ? { ok: true, value: output.data }
        : { ok: false, reason_code: "PROJECT_KNOWLEDGE_SOURCE_INVALID" };
    },

    async queryDetail(serializedRequest) {
      const read = readPlatformInformationContract(serializedRequest);
      if (read.ok && read.mode === "legacy_read_only") {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_LEGACY_READ_ONLY" };
      }
      if (!read.ok || read.mode !== "current" || read.value.contract_kind !== "detail_request") {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_QUERY_INVALID" };
      }
      const request = platformInformationDetailRequestSchema.safeParse(read.value);
      if (!request.success || request.data.view !== "project_knowledge") {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_QUERY_INVALID" };
      }
      const sourceRequest = detailSourceRequest(request.data);
      let serializedSource: string | null;
      try {
        serializedSource = await dependencies.source_port.getDetail(sourceRequest);
      } catch {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_SOURCE_INVALID" };
      }
      if (serializedSource === null) {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_DETAIL_NOT_FOUND" };
      }
      const source = parseSerialized(serializedSource, sourceDetailSchema);
      const contentHash = source === null ? null : `sha256:${createHash("sha256")
        .update(source.content, "utf8").digest("hex")}`;
      if (source === null || !detailEchoMatches(source, sourceRequest) ||
          source.knowledge_id !== request.data.detail_id || source.content_hash !== contentHash) {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_SOURCE_INVALID" };
      }
      const output = platformInformationDetailResponseSchema.safeParse({
        schema_version: 1,
        contract_kind: "detail_response",
        view: "project_knowledge",
        project_id: request.data.project_id,
        detail_id: request.data.detail_id,
        detail: {
          detail_kind: "knowledge_entry",
          content: source.content,
          content_hash: source.content_hash,
          media_type: source.media_type
        }
      });
      return output.success
        ? { ok: true, value: output.data }
        : { ok: false, reason_code: "PROJECT_KNOWLEDGE_SOURCE_INVALID" };
    },

    async createRetryIntent(serializedRequest) {
      const request = parseSerialized(serializedRequest, retryRequestSchema);
      if (request === null) {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_REQUEST_INVALID" };
      }
      let serializedAuthority: string;
      try {
        serializedAuthority = await dependencies.retry_authority_port.lookup({
          actor_id: request.actor_id,
          project_id: request.project_id,
          job_id: request.job_id,
          expected_generation: request.expected_generation
        });
      } catch {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_AUTHORITY_INVALID" };
      }
      const authority = parseSerialized(serializedAuthority, retryAuthoritySchema);
      if (authority === null || authority.actor_id !== request.actor_id ||
          authority.project_id !== request.project_id || authority.job_id !== request.job_id) {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_AUTHORITY_INVALID" };
      }
      if (authority.decision === "not_found") {
        return authority.expected_generation === request.expected_generation
          ? { ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_JOB_NOT_FOUND" }
          : { ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_AUTHORITY_INVALID" };
      }
      if (authority.decision !== "authorized") {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_AUTHORITY_INVALID" };
      }
      if (authority.expected_generation !== request.expected_generation) {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_GENERATION_CONFLICT" };
      }
      const identity = {
        schema_version: 1 as const,
        contract_kind: "knowledge_extraction_retry_intent" as const,
        actor_id: authority.actor_id,
        project_id: authority.project_id,
        job_id: authority.job_id,
        expected_generation: authority.expected_generation,
        retryable: true as const,
        request_only: true as const
      };
      let intentHash: string;
      try {
        intentHash = await dependencies.retry_intent_hash_port.sha256(canonicalJson(identity));
      } catch {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_INTENT_INVALID" };
      }
      if (!hashSchema.safeParse(intentHash).success) {
        return { ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_INTENT_INVALID" };
      }
      const candidate = { ...identity, intent_hash: intentHash };
      const verified = await verifyKnowledgeExtractionRetryIntent(
        JSON.stringify(candidate),
        {
          actor_id: authority.actor_id,
          project_id: authority.project_id,
          job_id: authority.job_id,
          expected_generation: authority.expected_generation
        },
        dependencies.retry_intent_hash_port
      );
      return verified.ok
        ? { ok: true, value: verified.value }
        : { ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_INTENT_INVALID" };
    }
  };
}
