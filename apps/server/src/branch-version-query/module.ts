import {
  platformInformationBranchFilesPageSchema,
  platformInformationDetailResponseSchema,
  platformInformationPageSchema,
  readPlatformInformationContract,
  restoreBranchFilesIntentSchema,
  restoreBranchFilesPreviewReceiptSchema,
  validateBranchFilesPullConfirmation
} from "@hunter-harness/contracts";
import { createHash } from "node:crypto";
import { z } from "zod";

import { snapshotPlain, type BranchSnapshotModule } from "../branch-snapshots/index.js";
import type { BranchVersionQueryAdapter, BranchVersionQueryResult } from "./types.js";

function sortKey(uploadedAt: string, projectVersion: string): string {
  return `${uploadedAt}|${projectVersion}`;
}

const id = z.string().min(1).max(160);
const projectId = z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const path = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") &&
  value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."));
const identitySchema = z.object({
  project_id: projectId,
  branch_name: id,
  commit_sha: z.string().regex(/^[a-f0-9]{40,64}$/u),
  project_version: id,
  artifact_id: id,
  manifest_hash: hash
}).strict();
const fileSummarySchema = z.object({
  path,
  content_kind: z.enum(["config", "rule", "architecture", "instruction", "branch_file", "change_document", "archive_package", "knowledge_entry", "knowledge_candidate", "project_content_candidate"]),
  size: z.number().int().nonnegative().max(10_485_760),
  content_hash: hash,
  action: z.enum(["add", "modify", "delete", "restore", "rename", "no_change"]).optional()
}).strict();
const filePageSchema = z.object({
  items: z.array(fileSummarySchema).max(100),
  next_cursor: z.string().min(16).max(512).nullable()
}).strict();
const snapshotSummarySchema = identitySchema.extend({
  schema_version: z.literal(1),
  file_count: z.number().int().nonnegative().max(100_000),
  changed_file_count: z.number().int().nonnegative().max(100_000),
  uploaded_at: z.iso.datetime({ offset: true }),
  diff_ref: id
}).strict();
const snapshotPageSchema = z.object({
  items: z.array(snapshotSummarySchema).max(100),
  next_cursor: z.string().min(16).max(512).nullable()
}).strict();
const fileLocatorSchema = z.object({
  detail_id: id,
  identity: identitySchema,
  path
}).strict();
const diffLocatorSchema = z.object({
  detail_id: id,
  from: identitySchema.nullable(),
  to: identitySchema
}).strict();
const restoreEnvelopeSchema = z.object({
  actor_id: id,
  accessible_project_ids: z.array(projectId).min(1).max(100),
  client_id: id,
  intent: restoreBranchFilesIntentSchema
}).strict().superRefine((value, context) => {
  if (new Set(value.accessible_project_ids).size !== value.accessible_project_ids.length ||
      !value.accessible_project_ids.includes(value.intent.project_id)) {
    context.addIssue({ code: "custom", message: "restore project is outside actor allowlist" });
  }
});

function parseSerialized<T>(serialized: unknown, schema: z.ZodType<T>): T | undefined {
  if (typeof serialized !== "string" || serialized.length > 2_000_000) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(serialized) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * version_records 详情定位符编码：`vr_<branch>~<project_version>`
 * （"~" 是 git 引用名的非法字符，不会出现在分支名中；两段分别 encodeURIComponent）。
 */
function encodeVersionDetailId(branchName: string, projectVersion: string): string {
  return `vr_${encodeURIComponent(branchName)}~${encodeURIComponent(projectVersion)}`;
}

function decodeVersionDetailId(detailId: string): { branch_name: string; project_version: string } | null {
  const match = /^vr_([^~]+)~(.+)$/u.exec(detailId);
  if (match === null) return null;
  try {
    const branchName = decodeURIComponent(match[1] ?? "");
    const projectVersion = decodeURIComponent(match[2] ?? "");
    if (branchName.length < 1 || branchName.length > 160 || projectVersion.length < 1 || projectVersion.length > 160) {
      return null;
    }
    return { branch_name: branchName, project_version: projectVersion };
  } catch {
    return null;
  }
}

/** 分支文件：快照文件清单定位符 `bf_<branch>~<project_version>`。 */
function encodeBranchFilesDetailId(branchName: string, projectVersion: string): string {
  return `bf_${encodeURIComponent(branchName)}~${encodeURIComponent(projectVersion)}`;
}

function decodeBranchFilesDetailId(detailId: string): { branch_name: string; project_version: string } | null {
  const match = /^bf_([^~]+)~(.+)$/u.exec(detailId);
  if (match === null) return null;
  try {
    const branchName = decodeURIComponent(match[1] ?? "");
    const projectVersion = decodeURIComponent(match[2] ?? "");
    if (branchName.length < 1 || branchName.length > 160 || projectVersion.length < 1 || projectVersion.length > 160) {
      return null;
    }
    return { branch_name: branchName, project_version: projectVersion };
  } catch {
    return null;
  }
}

/** 分支文件：文件内容定位符 `bff_<branch>~<project_version>~<path>`（path 段为剩余整体，允许含 "~"）。 */
function encodeBranchFileDetailId(branchName: string, projectVersion: string, path: string): string {
  return `bff_${encodeURIComponent(branchName)}~${encodeURIComponent(projectVersion)}~${encodeURIComponent(path)}`;
}

function decodeBranchFileDetailId(detailId: string): { branch_name: string; project_version: string; path: string } | null {
  const match = /^bff_([^~]+)~([^~]+)~(.+)$/u.exec(detailId);
  if (match === null) return null;
  try {
    const branchName = decodeURIComponent(match[1] ?? "");
    const projectVersion = decodeURIComponent(match[2] ?? "");
    const path = decodeURIComponent(match[3] ?? "");
    if (branchName.length < 1 || branchName.length > 160 || projectVersion.length < 1 || projectVersion.length > 160 ||
        path.length < 1 || path.length > 1024) {
      return null;
    }
    return { branch_name: branchName, project_version: projectVersion, path };
  } catch {
    return null;
  }
}

function compareSummary(left: z.infer<typeof snapshotSummarySchema>, right: z.infer<typeof snapshotSummarySchema>): number {
  const uploaded = Date.parse(right.uploaded_at) - Date.parse(left.uploaded_at);
  if (uploaded !== 0) return uploaded;
  if (left.project_version !== right.project_version) return left.project_version < right.project_version ? -1 : 1;
  if (left.branch_name !== right.branch_name) return left.branch_name < right.branch_name ? -1 : 1;
  return left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0;
}

function validSummaryPage(
  page: z.infer<typeof snapshotPageSchema>, project: string, limit: number
): boolean {
  if (page.items.length > limit || page.items.some((item) => item.project_id !== project)) return false;
  const identities = page.items.map((item) => JSON.stringify([
    item.project_id, item.branch_name, item.commit_sha, item.project_version,
    item.artifact_id, item.manifest_hash
  ]));
  return new Set(identities).size === identities.length &&
    page.items.every((item, index) => {
      const previous = page.items[index - 1];
      return index === 0 || (previous !== undefined && compareSummary(previous, item) < 0);
    });
}

function restorePreviewMatchesEnvelope(
  preview: z.infer<typeof restoreBranchFilesPreviewReceiptSchema>,
  envelope: z.infer<typeof restoreEnvelopeSchema>
): boolean {
  const intent = envelope.intent;
  return preview.project_id === intent.project_id &&
    preview.source_ref.project_id === intent.project_id &&
    preview.source_ref.branch_name === intent.source_branch_name &&
    preview.source_ref.commit_sha === intent.source_commit_sha &&
    preview.source_ref.client_id === envelope.client_id &&
    preview.source_version.branch_name === intent.source_branch_name &&
    preview.source_version.commit_sha === intent.source_commit_sha &&
    preview.source_version.artifact_id === intent.source_artifact_id &&
    preview.source_version.project_version === intent.source_project_version &&
    JSON.stringify(preview.scopes) === JSON.stringify(intent.scopes) &&
    JSON.stringify(preview.selected_paths) === JSON.stringify(intent.selected_paths) &&
    preview.conflicts.every((conflict) => intent.selected_paths.includes(conflict.path));
}

export function createBranchVersionQueryAdapter(source: BranchSnapshotModule): BranchVersionQueryAdapter {
  const adapter: BranchVersionQueryAdapter = {
    async query(serialized: unknown): Promise<BranchVersionQueryResult> {
      const read = readPlatformInformationContract(serialized);
      if (!read.ok) return { ok: false, reason_code: "BRANCH_VERSION_QUERY_INVALID" };
      if (read.mode === "legacy_read_only") return { ok: true, mode: read.mode, value: read.value };
      const query = read.value;
      if (query.contract_kind !== "query" ||
          (query.view !== "branch_files" && query.view !== "version_records")) {
        return { ok: false, reason_code: "BRANCH_VERSION_QUERY_INVALID" };
      }
      let page;
      try {
        const input = {
          schema_version: 1 as const,
          actor_id: query.query_scope.actor_id,
          project_id: query.project_id,
          accessible_project_ids: [...query.query_scope.accessible_project_ids],
          limit: query.limit,
          cursor: query.cursor
        };
        page = query.view === "branch_files"
          ? await source.listBranches(input)
          : await source.listProjectSnapshotVersions(input);
      } catch {
        return { ok: false, reason_code: "BRANCH_VERSION_SOURCE_INVALID" };
      }
      let safePage: z.infer<typeof snapshotPageSchema>;
      try {
        const parsed = snapshotPageSchema.safeParse(snapshotPlain(page));
        if (!parsed.success || !validSummaryPage(parsed.data, query.project_id, query.limit)) {
          throw new Error("invalid source page");
        }
        safePage = parsed.data;
      } catch {
        return { ok: false, reason_code: "BRANCH_VERSION_SOURCE_INVALID" };
      }
      const items = safePage.items.map((item) => query.view === "branch_files" ? {
        item_kind: "branch_snapshot" as const,
        branch_name: item.branch_name,
        snapshot_version: item.project_version,
        commit_sha: item.commit_sha,
        uploaded_at: item.uploaded_at,
        file_count: item.file_count,
        changed_file_count: item.changed_file_count,
        detail_id: encodeBranchFilesDetailId(item.branch_name, item.project_version),
        sort_key: `${sortKey(item.uploaded_at, item.project_version)}|${item.branch_name}|${item.artifact_id}`
      } : {
        item_kind: "version_record" as const,
        snapshot_version: item.project_version,
        branch_name: item.branch_name,
        commit_sha: item.commit_sha,
        uploaded_at: item.uploaded_at,
        file_count: item.file_count,
        changed_file_count: item.changed_file_count,
        diff_ref: item.diff_ref,
        detail_id: encodeVersionDetailId(item.branch_name, item.project_version),
        sort_key: `${sortKey(item.uploaded_at, item.project_version)}|${item.branch_name}|${item.artifact_id}`
      });
      const projected = platformInformationPageSchema.safeParse({
        schema_version: 1,
        contract_kind: "page",
        view: query.view,
        project_id: query.project_id,
        page_state: items.length === 0 ? "empty" : "ready",
        sort: query.sort,
        items,
        next_cursor: safePage.next_cursor,
        failures: []
      });
      return projected.success
        ? { ok: true, mode: "current", value: projected.data }
        : { ok: false, reason_code: "BRANCH_VERSION_SOURCE_INVALID" };
    },

    async listFiles(serializedQuery: unknown, serializedIdentity: unknown) {
      const read = readPlatformInformationContract(serializedQuery);
      const identity = parseSerialized(serializedIdentity, identitySchema);
      if (!read.ok || read.mode !== "current" || read.value.contract_kind !== "query" ||
          read.value.view !== "branch_files" || identity === undefined ||
          identity.project_id !== read.value.project_id) {
        return { ok: false as const, reason_code: "BRANCH_FILES_QUERY_INVALID" as const };
      }
      const query = read.value;
      try {
        const raw = await source.listSnapshotFiles({
          schema_version: 1,
          actor_id: query.query_scope.actor_id,
          project_id: query.project_id,
          accessible_project_ids: [...query.query_scope.accessible_project_ids],
          identity,
          limit: query.limit,
          cursor: query.cursor
        });
        const page = filePageSchema.safeParse(snapshotPlain(raw));
        if (!page.success || page.data.items.length > query.limit ||
            new Set(page.data.items.map((item) => item.path)).size !== page.data.items.length ||
            page.data.items.some((item, index) => {
              const previous = page.data.items[index - 1];
              return index > 0 && (previous === undefined || previous.path >= item.path);
            })) {
          throw new Error("invalid source page");
        }
        return { ok: true as const, value: {
          schema_version: 1 as const,
          project_id: query.project_id,
          identity,
          items: page.data.items,
          next_cursor: page.data.next_cursor
        } };
      } catch {
        return { ok: false as const, reason_code: "BRANCH_VERSION_SOURCE_INVALID" as const };
      }
    },

    async detail(serializedRequest: unknown, serializedLocator: unknown) {
      const read = readPlatformInformationContract(serializedRequest);
      if (!read.ok) return { ok: false as const, reason_code: "BRANCH_VERSION_DETAIL_INVALID" as const };
      if (read.mode === "legacy_read_only") return { ok: true as const, mode: read.mode, value: read.value };
      const request = read.value;
      const locator = parseSerialized(serializedLocator, fileLocatorSchema);
      if (request.contract_kind !== "detail_request" || request.view !== "branch_files" ||
          locator === undefined || locator.detail_id !== request.detail_id ||
          locator.identity.project_id !== request.project_id) {
        return { ok: false as const, reason_code: "BRANCH_VERSION_DETAIL_INVALID" as const };
      }
      try {
        const raw = await source.getSnapshotFile({
          schema_version: 1,
          actor_id: request.query_scope.actor_id,
          project_id: request.project_id,
          accessible_project_ids: [...request.query_scope.accessible_project_ids],
          identity: locator.identity,
          path: locator.path
        });
        const file = snapshotPlain(raw) as typeof raw;
        if (file.project_id !== request.project_id || file.path !== locator.path ||
            JSON.stringify({ project_id: file.project_id, branch_name: file.branch_name,
              commit_sha: file.commit_sha, project_version: file.project_version,
              artifact_id: file.artifact_id, manifest_hash: file.manifest_hash }) !== JSON.stringify(locator.identity)) {
          throw new Error("source identity mismatch");
        }
        const actualHash = `sha256:${createHash("sha256").update(file.content, "utf8").digest("hex")}`;
        if (actualHash !== file.content_hash || Buffer.byteLength(file.content, "utf8") !== file.size) {
          throw new Error("source content mismatch");
        }
        const projected = platformInformationDetailResponseSchema.safeParse({
          schema_version: 1,
          contract_kind: "detail_response",
          view: "branch_files",
          project_id: request.project_id,
          detail_id: request.detail_id,
          detail: { detail_kind: "branch_file", content: file.content,
            content_hash: file.content_hash, media_type: file.media_type }
        });
        if (!projected.success) throw new Error("invalid detail");
        return { ok: true as const, mode: "current" as const, value: projected.data };
      } catch (error) {
        if (error instanceof Error && error.message === "BRANCH_SNAPSHOT_FILE_NOT_FOUND") {
          return { ok: false as const, reason_code: "BRANCH_VERSION_NOT_FOUND" as const };
        }
        return { ok: false as const, reason_code: "BRANCH_VERSION_SOURCE_INVALID" as const };
      }
    },

    async diff(serializedRequest: unknown, serializedLocator: unknown) {
      const read = readPlatformInformationContract(serializedRequest);
      if (!read.ok) return { ok: false as const, reason_code: "BRANCH_VERSION_DETAIL_INVALID" as const };
      if (read.mode === "legacy_read_only") return { ok: true as const, mode: read.mode, value: read.value };
      const request = read.value;
      const locator = parseSerialized(serializedLocator, diffLocatorSchema);
      if (request.contract_kind !== "detail_request" || request.view !== "version_records" ||
          locator === undefined || locator.detail_id !== request.detail_id ||
          locator.to.project_id !== request.project_id ||
          (locator.from !== null && locator.from.project_id !== request.project_id)) {
        return { ok: false as const, reason_code: "BRANCH_VERSION_DETAIL_INVALID" as const };
      }
      try {
        const raw = snapshotPlain(await source.getSnapshotDiff({
          schema_version: 1,
          actor_id: request.query_scope.actor_id,
          project_id: request.project_id,
          accessible_project_ids: [...request.query_scope.accessible_project_ids],
          from: locator.from,
          to: locator.to
        })) as Awaited<ReturnType<BranchSnapshotModule["getSnapshotDiff"]>>;
        if (raw.project_id !== request.project_id || raw.diff_ref !== locator.detail_id ||
            JSON.stringify(raw.from) !== JSON.stringify(locator.from) ||
            JSON.stringify(raw.to) !== JSON.stringify(locator.to)) throw new Error("source identity mismatch");
        const projected = platformInformationDetailResponseSchema.safeParse({
          schema_version: 1,
          contract_kind: "detail_response",
          view: "version_records",
          project_id: request.project_id,
          detail_id: request.detail_id,
          detail: {
            detail_kind: "version_diff",
            from_version: raw.from?.project_version ?? raw.to.project_version,
            to_version: raw.to.project_version,
            changed_paths: raw.changed_paths
          }
        });
        if (!projected.success) throw new Error("invalid diff");
        return { ok: true as const, mode: "current" as const, value: projected.data };
      } catch {
        return { ok: false as const, reason_code: "BRANCH_VERSION_SOURCE_INVALID" as const };
      }
    },

    async queryDetail(serializedRequest: unknown) {
      const read = readPlatformInformationContract(serializedRequest);
      if (!read.ok) return { ok: false as const, reason_code: "BRANCH_VERSION_DETAIL_INVALID" as const };
      if (read.mode === "legacy_read_only") return { ok: true as const, mode: read.mode, value: read.value };
      const request = read.value;
      if (request.contract_kind !== "detail_request") {
        return { ok: false as const, reason_code: "BRANCH_VERSION_DETAIL_INVALID" as const };
      }
      const scope = {
        schema_version: 1 as const,
        actor_id: request.query_scope.actor_id,
        project_id: request.project_id,
        accessible_project_ids: [...request.query_scope.accessible_project_ids]
      };
      if (request.view === "branch_files") {
        const fileRef = decodeBranchFileDetailId(request.detail_id);
        if (fileRef === null) return { ok: false as const, reason_code: "BRANCH_VERSION_DETAIL_INVALID" as const };
        try {
          const found = await source.getSnapshotByVersionRef({
            ...scope, branch_name: fileRef.branch_name, project_version: fileRef.project_version
          });
          if (found === null) return { ok: false as const, reason_code: "BRANCH_VERSION_NOT_FOUND" as const };
          return await adapter.detail(serializedRequest, JSON.stringify({
            detail_id: request.detail_id, identity: found.identity, path: fileRef.path
          }));
        } catch {
          return { ok: false as const, reason_code: "BRANCH_VERSION_SOURCE_INVALID" as const };
        }
      }
      if (request.view !== "version_records") {
        return { ok: false as const, reason_code: "BRANCH_VERSION_DETAIL_INVALID" as const };
      }
      const ref = decodeVersionDetailId(request.detail_id);
      if (ref === null) return { ok: false as const, reason_code: "BRANCH_VERSION_DETAIL_INVALID" as const };
      try {
        const found = await source.getSnapshotByVersionRef({
          ...scope, branch_name: ref.branch_name, project_version: ref.project_version
        });
        if (found === null) return { ok: false as const, reason_code: "BRANCH_VERSION_NOT_FOUND" as const };
        const predecessor = await source.getSnapshotPredecessor({ ...scope, identity: found.identity });
        const raw = snapshotPlain(await source.getSnapshotDiff({
          ...scope, from: predecessor?.identity ?? null, to: found.identity
        })) as Awaited<ReturnType<BranchSnapshotModule["getSnapshotDiff"]>>;
        if (raw.project_id !== request.project_id || raw.diff_ref !== found.record.diff_ref ||
            JSON.stringify(raw.to) !== JSON.stringify(found.identity) ||
            JSON.stringify(raw.from) !== JSON.stringify(predecessor?.identity ?? null)) {
          throw new Error("source identity mismatch");
        }
        const projected = platformInformationDetailResponseSchema.safeParse({
          schema_version: 1,
          contract_kind: "detail_response",
          view: "version_records",
          project_id: request.project_id,
          detail_id: request.detail_id,
          detail: {
            detail_kind: "version_diff",
            from_version: raw.from?.project_version ?? raw.to.project_version,
            to_version: raw.to.project_version,
            changed_paths: raw.changed_paths
          }
        });
        if (!projected.success) throw new Error("invalid diff");
        return { ok: true as const, mode: "current" as const, value: projected.data };
      } catch {
        return { ok: false as const, reason_code: "BRANCH_VERSION_SOURCE_INVALID" as const };
      }
    },

    async listFilesByDetailId(serializedQuery: unknown, detailIdValue: unknown) {
      const read = readPlatformInformationContract(serializedQuery);
      if (!read.ok || read.mode !== "current" || read.value.contract_kind !== "query" ||
          read.value.view !== "branch_files" || typeof detailIdValue !== "string") {
        return { ok: false as const, reason_code: "BRANCH_FILES_QUERY_INVALID" as const };
      }
      const query = read.value;
      const ref = decodeBranchFilesDetailId(detailIdValue);
      if (ref === null) return { ok: false as const, reason_code: "BRANCH_FILES_QUERY_INVALID" as const };
      try {
        const found = await source.getSnapshotByVersionRef({
          schema_version: 1,
          actor_id: query.query_scope.actor_id,
          project_id: query.project_id,
          accessible_project_ids: [...query.query_scope.accessible_project_ids],
          branch_name: ref.branch_name,
          project_version: ref.project_version
        });
        if (found === null) return { ok: false as const, reason_code: "BRANCH_VERSION_NOT_FOUND" as const };
        const raw = await source.listSnapshotFiles({
          schema_version: 1,
          actor_id: query.query_scope.actor_id,
          project_id: query.project_id,
          accessible_project_ids: [...query.query_scope.accessible_project_ids],
          identity: found.identity,
          limit: query.limit,
          cursor: query.cursor
        });
        const page = filePageSchema.safeParse(snapshotPlain(raw));
        if (!page.success || page.data.items.length > query.limit ||
            new Set(page.data.items.map((item) => item.path)).size !== page.data.items.length ||
            page.data.items.some((item, index) => {
              const previous = page.data.items[index - 1];
              return index > 0 && (previous === undefined || previous.path >= item.path);
            })) {
          throw new Error("invalid source page");
        }
        const projected = platformInformationBranchFilesPageSchema.safeParse({
          schema_version: 1,
          contract_kind: "branch_files_page",
          project_id: query.project_id,
          detail_id: detailIdValue,
          items: page.data.items.map((file) => ({
            path: file.path,
            size: file.size,
            content_hash: file.content_hash,
            detail_id: encodeBranchFileDetailId(ref.branch_name, ref.project_version, file.path)
          })),
          next_cursor: page.data.next_cursor
        });
        if (!projected.success) throw new Error("invalid files page");
        return { ok: true as const, value: projected.data };
      } catch {
        return { ok: false as const, reason_code: "BRANCH_VERSION_SOURCE_INVALID" as const };
      }
    },

    async previewRestore(serialized: unknown) {
      const envelope = parseSerialized(serialized, restoreEnvelopeSchema);
      if (envelope === undefined) {
        return { ok: false as const, reason_code: "BRANCH_FILES_RESTORE_PREVIEW_INVALID" as const };
      }
      try {
        const raw = snapshotPlain(await source.previewRestore({
          schema_version: 1,
          actor_id: envelope.actor_id,
          project_id: envelope.intent.project_id,
          accessible_project_ids: [...envelope.accessible_project_ids],
          client_id: envelope.client_id,
          intent: envelope.intent
        })) as unknown;
        const preview = restoreBranchFilesPreviewReceiptSchema.safeParse(raw);
        if (!preview.success || !restorePreviewMatchesEnvelope(preview.data, envelope)) {
          throw new Error("invalid preview");
        }
        return { ok: true as const, value: preview.data };
      } catch {
        return { ok: false as const, reason_code: "BRANCH_VERSION_SOURCE_INVALID" as const };
      }
    },

    confirmRestore(previewJson: unknown, confirmationJson: unknown) {
      if (typeof previewJson !== "string" || typeof confirmationJson !== "string") {
        return { ok: false as const, reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" as const };
      }
      const validation = validateBranchFilesPullConfirmation(previewJson, confirmationJson);
      if (!validation.ok) return validation;
      return { ok: true as const, value: Object.freeze({
        schema_version: 1 as const,
        contract_kind: "branch_files_pull_confirmed_intent" as const,
        project_id: validation.preview.project_id,
        source_ref: Object.freeze({ ...validation.preview.source_ref }),
        source_version: Object.freeze({ ...validation.preview.source_version }),
        scopes: Object.freeze(["branch_files"] as const),
        selected_paths: Object.freeze([...validation.preview.selected_paths]),
        preview_hash: validation.preview.preview_hash,
        idempotency_key: validation.confirmation.idempotency_key,
        conflict_decisions: Object.freeze(validation.confirmation.conflict_decisions.map((decision) => Object.freeze({ ...decision }))),
        request_only: true as const
      }) };
    }
  };
  return Object.freeze(adapter);
}
