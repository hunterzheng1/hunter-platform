import { createHash } from "node:crypto";

import {
  platformInformationDetailResponseSchema,
  platformInformationPageSchema,
  readPlatformInformationContract,
  type LegacyPlatformInformation,
  type PlatformInformationCursorVerifierPort,
  type PlatformInformationDetailResponse,
  type PlatformInformationPage
} from "@hunter-harness/contracts";
import { z } from "zod";

const maxSerializedBytes = 2_000_000;
const contentTypes = Object.freeze([
  "config", "rule", "architecture", "instruction"
] as const);
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const idSchema = z.string().min(1).max(160);
const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const cursorSchema = z.string().regex(/^[A-Za-z0-9_-]{16,512}$/u).nullable();
const pathSchema = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") &&
  value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
);
const categorySchema = z.enum([
  "config", "rule", "architecture_map", "architecture_constraint", "instruction"
]);
const sourceContentTypeSchema = z.enum(contentTypes);
const mediaTypeSchema = z.enum([
  "text/plain", "text/markdown", "application/json", "application/yaml"
]);

const materialIdentityFields = {
  material_id: idSchema,
  content_type: sourceContentTypeSchema,
  category: categorySchema,
  path: pathSchema,
  blob_hash: hashSchema,
  snapshot_version: idSchema,
  source_branch_name: idSchema,
  source_commit_sha: commitSchema
};

const sourceItemSchema = z.object({
  ...materialIdentityFields,
  sort_key: z.string().min(1).max(512)
}).strict();

const sourceFailureSchema = z.object({
  reason_code: z.enum(["PROJECT_INFORMATION_FORBIDDEN", "PROJECTION_PARTIAL_FAILURE"]),
  retryable: z.boolean()
}).strict();

const sourcePageSchema = z.object({
  schema_version: z.literal(1),
  project_id: projectIdSchema,
  page_state: z.enum(["ready", "empty", "processing", "partial_failure", "forbidden"]),
  items: z.array(sourceItemSchema).max(100),
  next_cursor: cursorSchema,
  failures: z.array(sourceFailureSchema).max(10)
}).strict();

const sourceDetailSchema = z.object({
  schema_version: z.literal(1),
  project_id: projectIdSchema,
  ...materialIdentityFields,
  content: z.string().max(maxSerializedBytes),
  content_hash: hashSchema,
  media_type: mediaTypeSchema
}).strict();

export interface ProjectMaterialsSourceQuery {
  readonly actor_id: string;
  readonly accessible_project_ids: readonly string[];
  readonly project_id: string;
  readonly content_types: typeof contentTypes;
  readonly sort: "category_asc_path_asc_version_desc";
  readonly limit: number;
  readonly cursor: string | null;
}

export interface ProjectMaterialsSourceDetailQuery {
  readonly actor_id: string;
  readonly accessible_project_ids: readonly string[];
  readonly project_id: string;
  readonly content_types: typeof contentTypes;
  readonly material_id: string;
}

export interface ProjectMaterialsSourcePort {
  list(input: ProjectMaterialsSourceQuery): Promise<string>;
  detail(input: ProjectMaterialsSourceDetailQuery): Promise<string | null>;
}

export type ProjectMaterialsQueryResult =
  | { ok: true; mode: "current"; value: PlatformInformationPage }
  | { ok: true; mode: "legacy_read_only"; value: LegacyPlatformInformation }
  | { ok: false; reason_code:
      | "PROJECT_MATERIALS_QUERY_INVALID"
      | "PROJECT_MATERIALS_CURSOR_INVALID"
      | "PROJECT_MATERIALS_SOURCE_INVALID" };

export type ProjectMaterialsDetailResult =
  | { ok: true; mode: "current"; value: PlatformInformationDetailResponse }
  | { ok: true; mode: "legacy_read_only"; value: LegacyPlatformInformation }
  | { ok: false; reason_code:
      | "PROJECT_MATERIALS_DETAIL_INVALID"
      | "PROJECT_MATERIALS_NOT_FOUND"
      | "PROJECT_MATERIALS_SOURCE_INVALID" };

export interface ProjectMaterialsQueryAdapter {
  query(serialized: unknown): Promise<ProjectMaterialsQueryResult>;
  detail(serialized: unknown): Promise<ProjectMaterialsDetailResult>;
}

function parseSerialized<T>(serialized: unknown, schema: z.ZodType<T>): T | undefined {
  if (typeof serialized !== "string" || serialized.length > maxSerializedBytes) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(serialized) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function categoryMatchesPath(item: z.infer<typeof sourceItemSchema>): boolean {
  if (item.category === "config") {
    return item.content_type === "config" &&
      (item.path === ".harness/project.yaml" || item.path.startsWith(".harness/config/"));
  }
  if (item.category === "architecture_map") {
    return item.content_type === "architecture" &&
      (item.path === ".harness/codebase/map-manifest.json" ||
       item.path.startsWith(".harness/codebase/map/"));
  }
  if (item.category === "architecture_constraint") {
    return item.content_type === "rule" && item.path === ".harness/rules/architecture.md";
  }
  if (item.category === "rule") {
    return item.content_type === "rule" && item.path.startsWith(".harness/rules/") &&
      item.path !== ".harness/rules/architecture.md";
  }
  return item.content_type === "instruction" &&
    (item.path === "AGENTS.md" || item.path === "CLAUDE.md" || item.path === "CODEBUDDY.md");
}

function canonicalSortKey(item: z.infer<typeof sourceItemSchema>): string {
  return `${item.category}|${item.path}|${item.snapshot_version}`;
}

function sha256Utf8(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareMaterialIdentity(
  left: z.infer<typeof sourceItemSchema>,
  right: z.infer<typeof sourceItemSchema>
): number {
  const category = compareText(left.category, right.category);
  if (category !== 0) return category;
  const path = compareText(left.path, right.path);
  if (path !== 0) return path;
  return -compareText(left.snapshot_version, right.snapshot_version);
}

function sourcePageIsBound(page: z.infer<typeof sourcePageSchema>, projectId: string, limit: number): boolean {
  if (page.project_id !== projectId || page.items.length > limit ||
      page.items.some((item) => !categoryMatchesPath(item) ||
        item.sort_key !== canonicalSortKey(item))) return false;
  const keys = page.items.map((item) => item.sort_key);
  if (new Set(keys).size !== keys.length || page.items.some((item, index) => index > 0 &&
      compareMaterialIdentity(page.items[index - 1] ?? item, item) >= 0)) return false;
  if ((page.page_state === "empty" || page.page_state === "processing") &&
      (page.items.length !== 0 || page.next_cursor !== null || page.failures.length !== 0)) return false;
  if (page.page_state === "ready" && (page.items.length === 0 || page.failures.length !== 0)) return false;
  if (page.page_state === "partial_failure" && (page.items.length === 0 || page.failures.length === 0 ||
      page.failures.some((failure) => failure.reason_code !== "PROJECTION_PARTIAL_FAILURE"))) return false;
  return page.page_state !== "forbidden" ||
    (page.items.length === 0 && page.next_cursor === null && page.failures.length === 1 &&
     page.failures[0]?.reason_code === "PROJECT_INFORMATION_FORBIDDEN");
}

function sourceQuery(value: {
  project_id: string;
  query_scope: { actor_id: string; accessible_project_ids: string[] };
  limit: number;
  cursor: string | null;
}): ProjectMaterialsSourceQuery {
  return Object.freeze({
    actor_id: value.query_scope.actor_id,
    accessible_project_ids: Object.freeze([...value.query_scope.accessible_project_ids]),
    project_id: value.project_id,
    content_types: contentTypes,
    sort: "category_asc_path_asc_version_desc" as const,
    limit: value.limit,
    cursor: value.cursor
  });
}

export function createProjectMaterialsQueryAdapter(dependencies: {
  readonly source: ProjectMaterialsSourcePort;
  readonly cursor_verifier: PlatformInformationCursorVerifierPort;
}): ProjectMaterialsQueryAdapter {
  return Object.freeze({
    async query(serialized: unknown): Promise<ProjectMaterialsQueryResult> {
      const read = readPlatformInformationContract(serialized);
      if (!read.ok) return { ok: false, reason_code: "PROJECT_MATERIALS_QUERY_INVALID" };
      if (read.mode === "legacy_read_only") return { ok: true, mode: read.mode, value: read.value };
      const query = read.value;
      if (query.contract_kind !== "query" || query.view !== "project_materials") {
        return { ok: false, reason_code: "PROJECT_MATERIALS_QUERY_INVALID" };
      }
      if (query.cursor !== null) {
        let verified: boolean;
        try {
          verified = await dependencies.cursor_verifier.verify({
            cursor: query.cursor,
            project_id: query.project_id,
            actor_id: query.query_scope.actor_id,
            view: query.view,
            sort: query.sort
          });
        } catch {
          return { ok: false, reason_code: "PROJECT_MATERIALS_CURSOR_INVALID" };
        }
        if (!verified) return { ok: false, reason_code: "PROJECT_MATERIALS_CURSOR_INVALID" };
      }
      let sourcePage: string;
      try {
        sourcePage = await dependencies.source.list(sourceQuery(query));
      } catch {
        return { ok: false, reason_code: "PROJECT_MATERIALS_SOURCE_INVALID" };
      }
      const page = parseSerialized(sourcePage, sourcePageSchema);
      if (page === undefined || !sourcePageIsBound(page, query.project_id, query.limit)) {
        return { ok: false, reason_code: "PROJECT_MATERIALS_SOURCE_INVALID" };
      }
      const projected = platformInformationPageSchema.safeParse({
        schema_version: 1,
        contract_kind: "page",
        view: "project_materials",
        project_id: query.project_id,
        page_state: page.page_state,
        sort: query.sort,
        items: page.items.map((item) => ({
          item_kind: "project_material",
          material_id: item.material_id,
          category: item.category,
          path: item.path,
          blob_ref: { blob_hash: item.blob_hash, snapshot_version: item.snapshot_version },
          source_branch_name: item.source_branch_name,
          source_commit_sha: item.source_commit_sha,
          sort_key: item.sort_key
        })),
        next_cursor: page.next_cursor,
        failures: page.failures
      });
      return projected.success
        ? { ok: true, mode: "current", value: projected.data }
        : { ok: false, reason_code: "PROJECT_MATERIALS_SOURCE_INVALID" };
    },

    async detail(serialized: unknown): Promise<ProjectMaterialsDetailResult> {
      const read = readPlatformInformationContract(serialized);
      if (!read.ok) return { ok: false, reason_code: "PROJECT_MATERIALS_DETAIL_INVALID" };
      if (read.mode === "legacy_read_only") return { ok: true, mode: read.mode, value: read.value };
      const request = read.value;
      if (request.contract_kind !== "detail_request" || request.view !== "project_materials") {
        return { ok: false, reason_code: "PROJECT_MATERIALS_DETAIL_INVALID" };
      }
      let sourceValue: string | null;
      try {
        sourceValue = await dependencies.source.detail(Object.freeze({
          actor_id: request.query_scope.actor_id,
          accessible_project_ids: Object.freeze([...request.query_scope.accessible_project_ids]),
          project_id: request.project_id,
          content_types: contentTypes,
          material_id: request.detail_id
        }));
      } catch {
        return { ok: false, reason_code: "PROJECT_MATERIALS_SOURCE_INVALID" };
      }
      if (sourceValue === null) return { ok: false, reason_code: "PROJECT_MATERIALS_NOT_FOUND" };
      const item = parseSerialized(sourceValue, sourceDetailSchema);
      if (item === undefined || item.project_id !== request.project_id ||
          item.material_id !== request.detail_id || !categoryMatchesPath({ ...item, sort_key: "detail" }) ||
          item.content_hash !== item.blob_hash || item.content_hash !== sha256Utf8(item.content)) {
        return { ok: false, reason_code: "PROJECT_MATERIALS_SOURCE_INVALID" };
      }
      const projected = platformInformationDetailResponseSchema.safeParse({
        schema_version: 1,
        contract_kind: "detail_response",
        view: "project_materials",
        project_id: request.project_id,
        detail_id: request.detail_id,
        detail: {
          detail_kind: "project_material",
          content: item.content,
          content_hash: item.content_hash,
          media_type: item.media_type
        }
      });
      return projected.success
        ? { ok: true, mode: "current", value: projected.data }
        : { ok: false, reason_code: "PROJECT_MATERIALS_SOURCE_INVALID" };
    }
  });
}
