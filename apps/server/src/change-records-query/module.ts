import { createHash } from "node:crypto";

import {
  classifyContentPath,
  platformInformationDetailRequestSchema,
  platformInformationDetailResponseSchema,
  platformInformationPageSchema,
  readPlatformInformationContract
} from "@hunter-harness/contracts";
import { z } from "zod";

import { changeDocumentIdentity } from "../knowledge-pipeline/index.js";

import type { ChangeRecordsQueryAdapterDependencies } from "./ports.js";
import type {
  ChangeRecordsDetailResult,
  ChangeRecordsDetailSourceRequest,
  ChangeRecordsPageResult,
  ChangeRecordsPageSourceRequest
} from "./types.js";

const MAX_SERIALIZED_BYTES = 2_000_000;
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const idSchema = z.string().min(1).max(160);
const changeKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u);
const changeDocumentIdSchema = z.string().regex(/^doc_[a-f0-9]{32}$/u);
const documentSnapshotSchema = z.object({
  document_id: changeDocumentIdSchema,
  content_hash: hashSchema
}).strict();
const timestampSchema = z.iso.datetime({ offset: true });
const pathSchema = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
);

const rawRecordSchema = z.object({
  change_key: changeKeySchema,
  title: z.string().min(1).max(240),
  archived_at: timestampSchema,
  archive_status: z.enum(["absent", "uploading", "durable", "failed"]),
  archive_id: idSchema.nullable(),
  package_sha256: hashSchema.nullable(),
  knowledge_extraction_status: z.enum([
    "not_scheduled", "queued", "extracting", "ready", "failed"
  ]),
  projection_status: z.enum(["queued", "projecting", "ready", "failed"]),
  document_refs: z.array(changeDocumentIdSchema).max(20),
  document_snapshots: z.array(documentSnapshotSchema).max(20),
  candidate_refs: z.array(idSchema).max(100)
}).strict().superRefine((value, context) => {
  const hasArchive = value.archive_id !== null && value.package_sha256 !== null;
  if ((value.archive_status === "durable") !== hasArchive ||
      new Set(value.document_refs).size !== value.document_refs.length ||
      value.document_snapshots.length !== value.document_refs.length ||
      value.document_snapshots.some((snapshot, index) => snapshot.document_id !== value.document_refs[index]) ||
      new Set(value.candidate_refs).size !== value.candidate_refs.length) {
    context.addIssue({ code: "custom", message: "change record identity is inconsistent" });
  }
});

const failureSchema = z.object({
  reason_code: z.enum(["PROJECT_INFORMATION_FORBIDDEN", "PROJECTION_PARTIAL_FAILURE"]),
  retryable: z.boolean()
}).strict();

const rawPageSchema = z.object({
  schema_version: z.literal(1),
  source_kind: z.literal("change_records_page"),
  actor_id: idSchema,
  project_id: z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u),
  accessible_project_ids: z.array(z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u)).min(1).max(100),
  content_types: z.tuple([
    z.literal("change_document"), z.literal("archive_package"),
    z.literal("project_content_candidate")
  ]),
  sort: z.literal("archived_at_desc_change_key_asc"),
  request_cursor: z.string().regex(/^[A-Za-z0-9_-]{16,512}$/u).nullable(),
  page_state: z.enum(["ready", "empty", "processing", "partial_failure", "forbidden"]),
  records: z.array(rawRecordSchema).max(100),
  next_cursor: z.string().regex(/^[A-Za-z0-9_-]{16,512}$/u).nullable(),
  failures: z.array(failureSchema).max(10)
}).strict();

const rawRecordDetailSchema = z.object({
  schema_version: z.literal(1),
  source_kind: z.literal("change_record_detail"),
  actor_id: idSchema,
  project_id: z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u),
  accessible_project_ids: z.array(z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u)).min(1).max(100),
  content_types: z.tuple([
    z.literal("change_document"), z.literal("archive_package"),
    z.literal("project_content_candidate")
  ]),
  detail_id: idSchema,
  sort: z.literal("archived_at_desc_change_key_asc"),
  request_cursor: z.null(),
  change_key: changeKeySchema,
  document_refs: z.array(changeDocumentIdSchema).max(20),
  document_snapshots: z.array(documentSnapshotSchema).max(20),
  candidate_refs: z.array(idSchema).max(100),
  archive_id: idSchema.nullable(),
  package_sha256: hashSchema.nullable()
}).strict().superRefine((value, context) => {
  if ((value.archive_id === null) !== (value.package_sha256 === null) ||
      new Set(value.document_refs).size !== value.document_refs.length ||
      value.document_snapshots.length !== value.document_refs.length ||
      value.document_snapshots.some((snapshot, index) => snapshot.document_id !== value.document_refs[index]) ||
      new Set(value.candidate_refs).size !== value.candidate_refs.length) {
    context.addIssue({ code: "custom", message: "change detail identity is inconsistent" });
  }
});

const rawDocumentDetailSchema = z.object({
  schema_version: z.literal(1),
  source_kind: z.literal("change_document_detail"),
  actor_id: idSchema,
  accessible_project_ids: z.array(z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u)).min(1).max(100),
  content_types: z.tuple([
    z.literal("change_document"), z.literal("archive_package"),
    z.literal("project_content_candidate")
  ]),
  detail_id: idSchema,
  sort: z.literal("archived_at_desc_change_key_asc"),
  request_cursor: z.null(),
  document_id: idSchema,
  project_id: z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u),
  change_key: changeKeySchema,
  document_type: z.enum(["design", "plan", "test_scenarios", "change_summary"]),
  source_path: pathSchema,
  content_hash: hashSchema,
  archive_id: idSchema,
  package_sha256: hashSchema,
  media_type: z.enum(["text/plain", "text/markdown", "application/json", "application/yaml"]),
  content: z.string().min(1).max(MAX_SERIALIZED_BYTES)
}).strict();

const documentDescriptorSchema = z.object({
  document_id: changeDocumentIdSchema,
  project_id: z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u),
  change_key: changeKeySchema,
  document_type: z.enum(["design", "plan", "test_scenarios", "change_summary"]),
  source_path: pathSchema,
  content_hash: hashSchema,
  source_archive_id: idSchema,
  source_package_sha256: hashSchema
}).strict();

const referenceRequestSchema = z.array(z.object({
  change_key: changeKeySchema,
  document_ids: z.array(changeDocumentIdSchema).max(20)
}).strict()).max(100);

const referenceResolutionSchema = z.object({
  schema_version: z.literal(1),
  source_kind: z.literal("change_document_reference_resolution"),
  actor_id: idSchema,
  project_id: z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u),
  references: referenceRequestSchema,
  descriptors: z.array(documentDescriptorSchema).max(2_000)
}).strict();

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
}): ChangeRecordsPageSourceRequest {
  return {
    project_id: value.project_id,
    actor_id: value.query_scope.actor_id,
    accessible_project_ids: value.query_scope.accessible_project_ids,
    content_types: ["change_document", "archive_package", "project_content_candidate"],
    limit: value.limit,
    cursor: value.cursor,
    sort: "archived_at_desc_change_key_asc",
    request_cursor: value.cursor
  };
}

function detailSourceRequest(value: {
  project_id: string;
  query_scope: { actor_id: string; accessible_project_ids: string[] };
  detail_id: string;
}): ChangeRecordsDetailSourceRequest {
  return {
    project_id: value.project_id,
    actor_id: value.query_scope.actor_id,
    accessible_project_ids: value.query_scope.accessible_project_ids,
    content_types: ["change_document", "archive_package", "project_content_candidate"],
    detail_id: value.detail_id,
    sort: "archived_at_desc_change_key_asc",
    request_cursor: null
  };
}

function compareRecords(left: z.infer<typeof rawRecordSchema>, right: z.infer<typeof rawRecordSchema>): number {
  const timeDifference = Date.parse(right.archived_at) - Date.parse(left.archived_at);
  if (timeDifference !== 0) {
    return timeDifference;
  }
  return left.change_key < right.change_key ? -1 : left.change_key > right.change_key ? 1 : 0;
}

function sourcePageIsConsistent(page: z.infer<typeof rawPageSchema>, limit: number): boolean {
  if (page.records.length > limit) return false;
  if (new Set(page.records.map((record) => record.change_key)).size !== page.records.length) return false;
  for (let index = 1; index < page.records.length; index += 1) {
    const previous = page.records[index - 1];
    const current = page.records[index];
    if (previous === undefined || current === undefined || compareRecords(previous, current) >= 0) {
      return false;
    }
  }
  if (page.page_state === "ready") {
    return page.records.length > 0 && page.failures.length === 0;
  }
  if (page.page_state === "partial_failure") {
    return page.records.length > 0 && page.failures.length > 0 &&
      page.failures.every((failure) => failure.reason_code === "PROJECTION_PARTIAL_FAILURE");
  }
  if (page.page_state === "forbidden") {
    return page.records.length === 0 && page.next_cursor === null && page.failures.length === 1 &&
      page.failures[0]?.reason_code === "PROJECT_INFORMATION_FORBIDDEN";
  }
  return page.records.length === 0 && page.next_cursor === null && page.failures.length === 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function pageEchoMatches(
  page: z.infer<typeof rawPageSchema>,
  request: ChangeRecordsPageSourceRequest
): boolean {
  return page.actor_id === request.actor_id && page.project_id === request.project_id &&
    sameStrings(page.accessible_project_ids, request.accessible_project_ids) &&
    sameStrings(page.content_types, request.content_types) && page.sort === request.sort &&
    page.request_cursor === request.cursor;
}

function detailEchoMatches(
  detail: z.infer<typeof rawRecordDetailSchema> | z.infer<typeof rawDocumentDetailSchema>,
  request: ChangeRecordsDetailSourceRequest
): boolean {
  return detail.actor_id === request.actor_id && detail.project_id === request.project_id &&
    sameStrings(detail.accessible_project_ids, request.accessible_project_ids) &&
    sameStrings(detail.content_types, request.content_types) && detail.detail_id === request.detail_id &&
    detail.sort === request.sort && detail.request_cursor === request.request_cursor;
}

export function sourcePathDocumentType(
  path: string,
  changeKey: string
): "design" | "plan" | "test_scenarios" | "change_summary" | null {
  if (!changeKeySchema.safeParse(changeKey).success) return null;
  if (path === "summary/change-summary.json") return "change_summary";
  if (path === "reports/final/summary-data.json") return "change_summary";
  if (path === `plans/${changeKey}-test-scenarios.md`) return "test_scenarios";
  if (path.endsWith("-test-scenarios.md")) return null;
  if (/^spec\/.+\.md$/u.test(path)) return "design";
  if (/^plans\/.+\.md$/u.test(path)) return "plan";
  return null;
}

function documentEvidenceMatches(
  document: z.infer<typeof rawDocumentDetailSchema>,
  request: ChangeRecordsDetailSourceRequest
): boolean {
  const classification = classifyContentPath({
    schema_version: 1,
    path: document.source_path,
    source_kind: "branch_file"
  });
  const expectedId = changeDocumentIdentity({
    project_id: document.project_id,
    change_key: document.change_key,
    document_type: document.document_type,
    source_path: document.source_path
  });
  const actualHash = `sha256:${createHash("sha256")
    .update(document.content, "utf8").digest("hex")}`;
  return document.source_path.normalize("NFC") === document.source_path &&
    "content_kind" in classification && classification.content_kind === "branch_file" &&
    sourcePathDocumentType(document.source_path, document.change_key) === document.document_type &&
    expectedId === document.document_id && document.document_id === request.detail_id &&
    document.content_hash === actualHash;
}

async function resolveDocumentReferences(
  dependencies: ChangeRecordsQueryAdapterDependencies,
  input: { actor_id: string; project_id: string; references: Array<{
    change_key: string; document_ids: string[];
  }> }
): Promise<Map<string, z.infer<typeof documentDescriptorSchema>> | null> {
  if (!referenceRequestSchema.safeParse(input.references).success ||
      input.references.some((reference) =>
        new Set(reference.document_ids).size !== reference.document_ids.length)) return null;
  let serialized: string;
  try {
    serialized = await dependencies.reference_port.resolve(input);
  } catch {
    return null;
  }
  const resolution = parseSerialized(serialized, referenceResolutionSchema);
  if (resolution === null || resolution.actor_id !== input.actor_id ||
      resolution.project_id !== input.project_id ||
      JSON.stringify(resolution.references) !== JSON.stringify(input.references)) return null;
  const expected = input.references.flatMap((reference) =>
    reference.document_ids.map((document_id) => ({ document_id, change_key: reference.change_key })));
  if (resolution.descriptors.length !== expected.length ||
      new Set(resolution.descriptors.map((descriptor) => descriptor.document_id)).size !==
        resolution.descriptors.length) return null;
  const byId = new Map(resolution.descriptors.map((descriptor) => [descriptor.document_id, descriptor]));
  for (const reference of expected) {
    const descriptor = byId.get(reference.document_id);
    if (descriptor === undefined || descriptor.project_id !== input.project_id ||
        descriptor.change_key !== reference.change_key ||
        descriptor.source_path.normalize("NFC") !== descriptor.source_path ||
        sourcePathDocumentType(descriptor.source_path, descriptor.change_key) !== descriptor.document_type ||
        changeDocumentIdentity({
          project_id: descriptor.project_id, change_key: descriptor.change_key,
          document_type: descriptor.document_type, source_path: descriptor.source_path
        }) !== descriptor.document_id) return null;
  }
  return byId;
}

function resolvedReferencesMatchSnapshot(
  resolved: ReadonlyMap<string, z.infer<typeof documentDescriptorSchema>>,
  record: {
    document_refs: string[];
    document_snapshots: Array<{ document_id: string; content_hash: string }>;
    archive_id: string | null;
    package_sha256: string | null;
  }
): boolean {
  if (record.document_refs.length === 0) return record.document_snapshots.length === 0;
  if (record.archive_id === null || record.package_sha256 === null) return false;
  return record.document_snapshots.every((snapshot) => {
    const descriptor = resolved.get(snapshot.document_id);
    return descriptor !== undefined && descriptor.content_hash === snapshot.content_hash &&
      descriptor.source_archive_id === record.archive_id &&
      descriptor.source_package_sha256 === record.package_sha256;
  });
}

export interface ChangeRecordsQueryAdapter {
  queryPage(serializedRequest: unknown): Promise<ChangeRecordsPageResult>;
  queryDetail(serializedRequest: unknown): Promise<ChangeRecordsDetailResult>;
}

export function createChangeRecordsQueryAdapter(
  dependencies: ChangeRecordsQueryAdapterDependencies
): ChangeRecordsQueryAdapter {
  return {
    async queryPage(serializedRequest) {
      const read = readPlatformInformationContract(serializedRequest);
      if (read.ok && read.mode === "legacy_read_only") {
        return { ok: false, reason_code: "CHANGE_RECORDS_LEGACY_READ_ONLY" };
      }
      if (!read.ok || read.mode !== "current") {
        return { ok: false, reason_code: "CHANGE_RECORDS_QUERY_INVALID" };
      }
      const parsed = read.value;
      if (parsed.contract_kind !== "query" || parsed.view !== "change_records") {
        return { ok: false, reason_code: "CHANGE_RECORDS_QUERY_INVALID" };
      }
      if (parsed.cursor !== null) {
        let valid: boolean;
        try {
          valid = await dependencies.cursor_verifier.verify({
            cursor: parsed.cursor,
            project_id: parsed.project_id,
            actor_id: parsed.query_scope.actor_id,
            view: "change_records",
            sort: "archived_at_desc_change_key_asc"
          });
        } catch {
          valid = false;
        }
        if (!valid) return { ok: false, reason_code: "CHANGE_RECORDS_CURSOR_INVALID" };
      }
      const sourceRequest = pageSourceRequest(parsed);
      let serializedSource: string;
      try {
        serializedSource = await dependencies.source_port.listPage(sourceRequest);
      } catch {
        return { ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" };
      }
      const sourcePage = parseSerialized(serializedSource, rawPageSchema);
      if (sourcePage === null || !pageEchoMatches(sourcePage, sourceRequest) ||
          !sourcePageIsConsistent(sourcePage, parsed.limit)) {
        return { ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" };
      }
      const resolvedPageReferences = await resolveDocumentReferences(dependencies, {
        actor_id: parsed.query_scope.actor_id,
        project_id: parsed.project_id,
        references: sourcePage.records.map((record) => ({
          change_key: record.change_key,
          document_ids: record.document_refs
        }))
      });
      if (resolvedPageReferences === null) {
        return { ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" };
      }
      if (sourcePage.records.some((record) =>
        !resolvedReferencesMatchSnapshot(resolvedPageReferences, record))) {
        return { ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" };
      }
      const candidate = {
        schema_version: 1 as const,
        contract_kind: "page" as const,
        view: "change_records" as const,
        project_id: parsed.project_id,
        page_state: sourcePage.page_state,
        sort: "archived_at_desc_change_key_asc" as const,
        items: sourcePage.records.map((record) => ({
          item_kind: "change_record" as const,
          change_key: record.change_key,
          title: record.title,
          archived_at: record.archived_at,
          archive_status: record.archive_status === "durable" ? "stored" as const : record.archive_status,
          knowledge_extraction_status: record.knowledge_extraction_status,
          document_refs: record.document_refs,
          candidate_count: record.candidate_refs.length,
          archive_download_ref: record.archive_id === null || record.package_sha256 === null
            ? null
            : { archive_id: record.archive_id, package_hash: record.package_sha256 },
          sort_key: `${record.archived_at}|${record.change_key}`
        })),
        next_cursor: sourcePage.next_cursor,
        failures: sourcePage.failures
      };
      const output = platformInformationPageSchema.safeParse(candidate);
      return output.success
        ? { ok: true, value: output.data }
        : { ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" };
    },

    async queryDetail(serializedRequest) {
      const read = readPlatformInformationContract(serializedRequest);
      if (read.ok && read.mode === "legacy_read_only") {
        return { ok: false, reason_code: "CHANGE_RECORDS_LEGACY_READ_ONLY" };
      }
      if (!read.ok || read.mode !== "current" ||
          read.value.contract_kind !== "detail_request") {
        return { ok: false, reason_code: "CHANGE_RECORDS_QUERY_INVALID" };
      }
      const request = platformInformationDetailRequestSchema.safeParse(read.value);
      if (!request.success || request.data.view !== "change_records") {
        return { ok: false, reason_code: "CHANGE_RECORDS_QUERY_INVALID" };
      }
      if (!changeKeySchema.safeParse(request.data.detail_id).success &&
          !changeDocumentIdSchema.safeParse(request.data.detail_id).success) {
        return { ok: false, reason_code: "CHANGE_RECORDS_QUERY_INVALID" };
      }
      const sourceRequest = detailSourceRequest(request.data);
      let serializedSource: string | null;
      try {
        serializedSource = await dependencies.source_port.getDetail(sourceRequest);
      } catch {
        return { ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" };
      }
      if (serializedSource === null) {
        return { ok: false, reason_code: "CHANGE_RECORDS_DETAIL_NOT_FOUND" };
      }
      const record = parseSerialized(serializedSource, rawRecordDetailSchema);
      const document = record === null ? parseSerialized(serializedSource, rawDocumentDetailSchema) : null;
      if (record === null && document === null) {
        return { ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" };
      }
      const detailSource = record ?? document;
      if (detailSource === null || !detailEchoMatches(detailSource, sourceRequest) ||
          (record !== null && record.change_key !== request.data.detail_id) ||
          (document !== null && !documentEvidenceMatches(document, sourceRequest))) {
        return { ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" };
      }
      let detailReferences: Array<{ change_key: string; document_ids: string[] }>;
      if (record !== null) {
        detailReferences = [{ change_key: record.change_key, document_ids: record.document_refs }];
      } else if (document !== null) {
        detailReferences = [{ change_key: document.change_key, document_ids: [document.document_id] }];
      } else {
        return { ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" };
      }
      const resolvedDetailReferences = await resolveDocumentReferences(dependencies, {
        actor_id: request.data.query_scope.actor_id,
        project_id: request.data.project_id,
        references: detailReferences
      });
      if (resolvedDetailReferences === null || (document !== null && (() => {
        const descriptor = resolvedDetailReferences.get(document.document_id);
        return descriptor === undefined || descriptor.document_type !== document.document_type ||
          descriptor.source_path !== document.source_path || descriptor.content_hash !== document.content_hash ||
          descriptor.source_archive_id !== document.archive_id ||
          descriptor.source_package_sha256 !== document.package_sha256;
      })())) {
        return { ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" };
      }
      if (record !== null && !resolvedReferencesMatchSnapshot(resolvedDetailReferences, record)) {
        return { ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" };
      }
      let detail: {
        detail_kind: "change_record";
        document_refs: string[];
        candidate_refs: string[];
        archive_download_ref: { archive_id: string; package_hash: string } | null;
      } | {
        detail_kind: "change_document";
        content: string;
        content_hash: string;
        media_type: "text/plain" | "text/markdown" | "application/json" | "application/yaml";
      };
      if (record !== null) {
        detail = {
        detail_kind: "change_record" as const,
        document_refs: record.document_refs,
        candidate_refs: record.candidate_refs,
          archive_download_ref: record.archive_id === null || record.package_sha256 === null
            ? null
            : { archive_id: record.archive_id, package_hash: record.package_sha256 }
        };
      } else if (document !== null) {
        detail = {
          detail_kind: "change_document",
          content: document.content,
          content_hash: document.content_hash,
          media_type: document.media_type
        };
      } else {
        return { ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" };
      }
      const output = platformInformationDetailResponseSchema.safeParse({
        schema_version: 1,
        contract_kind: "detail_response",
        view: "change_records",
        project_id: request.data.project_id,
        detail_id: request.data.detail_id,
        detail
      });
      return output.success
        ? { ok: true, value: output.data }
        : { ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" };
    }
  };
}
