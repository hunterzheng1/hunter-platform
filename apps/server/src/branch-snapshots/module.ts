import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { types as nodeTypes } from "node:util";
import { z } from "zod";
import { canonicalJson, restoreBranchFilesIntentSchema, restoreBranchFilesPreviewReceiptSchema } from "@hunter-harness/contracts";
import type { BlobReadPort, BranchSnapshotRepositoryPort, CursorCapability, CursorVerifierPort, RestoreConflictReadPort } from "./ports.js";
import type { AuthorizedProjectScope, BranchSnapshotModule, BranchSnapshotReadResult, BranchSnapshotRecord, SnapshotIdentity } from "./types.js";

const controlFree = (value: string): boolean => value === value.trim() && value === value.normalize("NFC") && !Array.from(value).some((c) => (c.codePointAt(0) ?? 0) < 32);
const id = z.string().min(1).max(160).refine(controlFree);
const projectId = z.string().regex(/^prj_[A-Za-z0-9_-]{1,156}$/u);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const path = z.string().min(1).max(1024).refine((v) => controlFree(v) && !v.startsWith("/") && !v.includes("\\") && v.split("/").every((s) => s !== "" && s !== "." && s !== ".."));
const identitySchema = z.object({ project_id: projectId, branch_name: id, commit_sha: z.string().regex(/^[a-f0-9]{40,64}$/u), project_version: id, artifact_id: id, manifest_hash: hash }).strict();
const fileRefSchema = z.object({ path, content_kind: z.enum(["config", "rule", "architecture", "instruction", "branch_file", "change_document", "archive_package", "knowledge_entry", "knowledge_candidate", "project_content_candidate"]), size: z.number().int().nonnegative().max(10_485_760), content_hash: hash, media_type: z.enum(["text/plain", "text/markdown", "application/json", "application/yaml"]), action: z.enum(["add", "modify", "delete", "restore", "rename", "no_change"]).optional() }).strict();
export const branchSnapshotRecordSchema = identitySchema.extend({ schema_version: z.literal(1), file_count: z.number().int().nonnegative().max(100_000), changed_file_count: z.number().int().nonnegative().max(100_000), uploaded_at: z.iso.datetime({ offset: true }), diff_ref: id, files: z.array(fileRefSchema).max(100_000), changed_paths: z.array(path).max(100_000) }).strict().superRefine((v, context) => { if (v.file_count !== v.files.length || v.changed_file_count !== v.changed_paths.length || new Set(v.files.map((f) => f.path)).size !== v.files.length || new Set(v.changed_paths).size !== v.changed_paths.length) context.addIssue({ code: "custom", message: "snapshot counts or paths are inconsistent" }); });
const legacySchema = z.object({ schemaVersion: z.literal(0), projectId, projectVersion: id, artifactId: id, commitSha: z.string().regex(/^[a-f0-9]{40,64}$/u), uploadedAt: z.iso.datetime({ offset: true }), files: z.array(z.object({ path, contentHash: hash, size: z.number().int().nonnegative() }).strict()).max(100_000) }).strict();
const scopeSchema = z.object({ schema_version: z.literal(1), actor_id: id, project_id: projectId, accessible_project_ids: z.array(projectId).min(1).max(100) }).strict();
const pageSchema = scopeSchema.extend({ cursor: z.string().regex(/^[A-Za-z0-9_-]{16,512}$/u).nullable(), limit: z.number().int().min(1).max(100) }).strict();
const pageEnvelopeSchema = (item: z.ZodType) => z.object({ actor_id: id, project_id: projectId, query_kind: z.enum(["branches", "project_versions", "versions", "files"]), cursor_offset: z.number().int().nonnegative(), next_offset: z.number().nullable(), items: z.array(item).max(100) }).strict();

export function snapshotPlain(value: unknown, depth = 0): unknown { if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value; if (typeof value !== "object" || nodeTypes.isProxy(value) || depth > 32) throw new Error("BRANCH_SNAPSHOT_INPUT_INVALID"); const array = Array.isArray(value); const prototype = Object.getPrototypeOf(value); if (array ? prototype !== Array.prototype : prototype !== Object.prototype) throw new Error("BRANCH_SNAPSHOT_INPUT_INVALID"); const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors); if (keys.some((key) => typeof key === "symbol")) throw new Error("BRANCH_SNAPSHOT_INPUT_INVALID"); for (const key of keys as string[]) { const descriptor = descriptors[key]; if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || (key !== "length" && descriptor.enumerable !== true)) throw new Error("BRANCH_SNAPSHOT_INPUT_INVALID"); } if (array) { if (keys.some((key) => typeof key === "string" && key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))) throw new Error("BRANCH_SNAPSHOT_INPUT_INVALID"); const length = descriptors.length?.value; if (!Number.isSafeInteger(length)) throw new Error("BRANCH_SNAPSHOT_INPUT_INVALID"); return Array.from({ length: length as number }, (_, index) => { const descriptor = descriptors[String(index)]; if (descriptor === undefined || !("value" in descriptor)) throw new Error("BRANCH_SNAPSHOT_INPUT_INVALID"); return snapshotPlain(descriptor.value, depth + 1); }); } const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>; for (const key of keys as string[]) { if (key === "__proto__") throw new Error("BRANCH_SNAPSHOT_INPUT_INVALID"); const descriptor = descriptors[key]; if (descriptor === undefined || !("value" in descriptor)) throw new Error("BRANCH_SNAPSHOT_INPUT_INVALID"); output[key] = snapshotPlain(descriptor.value, depth + 1); } return output; }
export function readBranchSnapshot(value: unknown): BranchSnapshotReadResult { if (typeof value !== "string") return { ok: false, reason_code: "BRANCH_SNAPSHOT_SERIALIZED_JSON_REQUIRED" }; if (value.length > 2_000_000) return { ok: false, reason_code: "BRANCH_SNAPSHOT_SERIALIZED_JSON_TOO_LARGE" }; let parsed: unknown; try { parsed = JSON.parse(value) as unknown; } catch { return { ok: false, reason_code: "BRANCH_SNAPSHOT_INVALID" }; } if (parsed !== null && typeof parsed === "object" && ((Object.hasOwn(parsed, "schema_version") && (parsed as { schema_version?: unknown }).schema_version !== 1) || (Object.hasOwn(parsed, "schemaVersion") && (parsed as { schemaVersion?: unknown }).schemaVersion !== 0))) return { ok: false, reason_code: "BRANCH_SNAPSHOT_VERSION_UNSUPPORTED" }; const current = branchSnapshotRecordSchema.safeParse(parsed); if (current.success) { try { return { ok: true, mode: "current", value: validateSnapshotManifest(current.data) }; } catch { return { ok: false, reason_code: "BRANCH_SNAPSHOT_INVALID" }; } } const legacy = legacySchema.safeParse(parsed); if (legacy.success) return { ok: true, mode: "legacy_read_only", value: { ...legacy.data, branch_name: "unmarked" } }; return { ok: false, reason_code: "BRANCH_SNAPSHOT_INVALID" }; }

export function canonicalSnapshotFileRefs(files: readonly z.infer<typeof fileRefSchema>[]): string { return JSON.stringify([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map((file) => ({ path: file.path, content_kind: file.content_kind, size: file.size, content_hash: file.content_hash, media_type: file.media_type, ...(file.action === undefined ? {} : { action: file.action }) }))); }
/**
 * CLI 兼容的简版 manifest 哈希（remote-sync 端点 files 形状 {path, content_hash,
 * size, content_kind?}，与 Hunter-Harness `manifestHashEntries` 同 canonicalization）。
 * 880ed52 起 remote-sync commit 路径按此形状落库；branch-snapshots 存量记录仍是
 * 富字段形状，两种 canonicalization 都视为有效内容绑定。
 */
export function remoteSyncManifestHash(files: readonly z.infer<typeof fileRefSchema>[]): string {
  const projected = [...files]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map((file) => ({
      path: file.path,
      content_hash: file.content_hash,
      size: file.size,
      ...(file.content_kind === undefined ? {} : { content_kind: file.content_kind })
    }));
  return `sha256:${createHash("sha256").update(canonicalJson(projected), "utf8").digest("hex")}`;
}

export function validateSnapshotManifest(record: BranchSnapshotRecord): BranchSnapshotRecord {
  const rich = `sha256:${createHash("sha256").update(canonicalSnapshotFileRefs(record.files)).digest("hex")}`;
  if (record.manifest_hash !== rich && record.manifest_hash !== remoteSyncManifestHash(record.files)) {
    throw new Error("BRANCH_SNAPSHOT_MANIFEST_HASH_MISMATCH");
  }
  return record;
}

const identity = (record: BranchSnapshotRecord): SnapshotIdentity => ({ project_id: record.project_id, branch_name: record.branch_name, commit_sha: record.commit_sha, project_version: record.project_version, artifact_id: record.artifact_id, manifest_hash: record.manifest_hash });
const summary = (record: BranchSnapshotRecord) => ({ schema_version: record.schema_version, project_id: record.project_id, branch_name: record.branch_name, commit_sha: record.commit_sha, project_version: record.project_version, artifact_id: record.artifact_id, manifest_hash: record.manifest_hash, file_count: record.file_count, changed_file_count: record.changed_file_count, uploaded_at: record.uploaded_at, diff_ref: record.diff_ref });
const fileSummary = (ref: z.infer<typeof fileRefSchema>) => ({ path: ref.path, content_kind: ref.content_kind, size: ref.size, content_hash: ref.content_hash, ...(ref.action === undefined ? {} : { action: ref.action }) });
const sameIdentity = (a: SnapshotIdentity, b: SnapshotIdentity): boolean => JSON.stringify(a) === JSON.stringify(b);
function authorize(value: AuthorizedProjectScope): void { if (new Set(value.accessible_project_ids).size !== value.accessible_project_ids.length || !value.accessible_project_ids.includes(value.project_id)) throw new Error("BRANCH_SNAPSHOT_FORBIDDEN"); }
function validateRecord(record: unknown, request: { project_id: string; branch_name?: string }): BranchSnapshotRecord { const parsed = validateSnapshotManifest(branchSnapshotRecordSchema.parse(structuredClone(record))); if (parsed.project_id !== request.project_id || (request.branch_name !== undefined && parsed.branch_name !== request.branch_name)) throw new Error("BRANCH_SNAPSHOT_PORT_IDENTITY_MISMATCH"); return parsed; }
async function cursorOffset(port: CursorVerifierPort, cursor: string | null, expected: Omit<CursorCapability, "offset">): Promise<number> { return cursor === null ? 0 : port.verify(cursor, expected); }
function assertPageProgress(itemsLength: number, nextOffset: number | null, limit: number, offset: number): void { if (itemsLength > limit || !Number.isSafeInteger(offset) || offset < 0 || (nextOffset !== null && (!Number.isSafeInteger(nextOffset) || itemsLength === 0 || nextOffset !== offset + itemsLength))) throw new Error("BRANCH_SNAPSHOT_PORT_PAGE_INVALID"); }
async function finishPage<T>(items: T[], nextOffset: number | null, request: { limit: number }, port: CursorVerifierPort, capability: Omit<CursorCapability, "offset">, offset: number): Promise<{ items: T[]; next_cursor: string | null }> { assertPageProgress(items.length, nextOffset, request.limit, offset); const next = nextOffset === null ? null : await port.issue({ ...capability, offset: nextOffset }); return { items, next_cursor: next }; }
function assertEnvelope(value: { actor_id: string; project_id: string; query_kind: string; cursor_offset: number }, request: { actor_id: string; project_id: string }, kind: string, offset: number): void { if (value.actor_id !== request.actor_id || value.project_id !== request.project_id || value.query_kind !== kind || value.cursor_offset !== offset) throw new Error("BRANCH_SNAPSHOT_PORT_IDENTITY_MISMATCH"); }

export function createBranchSnapshotModule(ports: { repository_port: BranchSnapshotRepositoryPort; blob_read_port: BlobReadPort; cursor_verifier_port: CursorVerifierPort; restore_conflict_port: RestoreConflictReadPort }): BranchSnapshotModule {
  return {
    async listBranches(raw) { const request = pageSchema.parse(snapshotPlain(raw)); authorize(request); const capability = { actor_id: request.actor_id, project_id: request.project_id, query_kind: "branches" as const }; const offset = await cursorOffset(ports.cursor_verifier_port, request.cursor, capability); const result = pageEnvelopeSchema(z.unknown()).parse(snapshotPlain(await ports.repository_port.listLatestBranches({ actor_id: request.actor_id, allowed_project_ids: request.accessible_project_ids, project_id: request.project_id, cursor_offset: offset, limit: request.limit }))); assertEnvelope(result, request, "branches", offset); const records = result.items.map((v) => validateRecord(v, request)); return finishPage(records.map(summary), result.next_offset, request, ports.cursor_verifier_port, capability, offset); },
    async listProjectSnapshotVersions(raw) { const request = pageSchema.parse(snapshotPlain(raw)); authorize(request); const capability = { actor_id: request.actor_id, project_id: request.project_id, query_kind: "project_versions" as const }; const offset = await cursorOffset(ports.cursor_verifier_port, request.cursor, capability); const result = pageEnvelopeSchema(z.unknown()).parse(snapshotPlain(await ports.repository_port.listProjectVersions({ actor_id: request.actor_id, allowed_project_ids: request.accessible_project_ids, project_id: request.project_id, cursor_offset: offset, limit: request.limit }))); assertEnvelope(result, request, "project_versions", offset); const records = result.items.map((v) => validateRecord(v, request)); return finishPage(records.map(summary), result.next_offset, request, ports.cursor_verifier_port, capability, offset); },
    async listSnapshotVersions(raw) { const request = pageSchema.extend({ branch_name: id }).strict().parse(snapshotPlain(raw)); authorize(request); const capability = { actor_id: request.actor_id, project_id: request.project_id, query_kind: "versions" as const, branch_name: request.branch_name }; const offset = await cursorOffset(ports.cursor_verifier_port, request.cursor, capability); const result = pageEnvelopeSchema(z.unknown()).parse(snapshotPlain(await ports.repository_port.listVersions({ actor_id: request.actor_id, allowed_project_ids: request.accessible_project_ids, project_id: request.project_id, branch_name: request.branch_name, cursor_offset: offset, limit: request.limit }))); assertEnvelope(result, request, "versions", offset); const records = result.items.map((v) => validateRecord(v, request)); return finishPage(records.map(summary), result.next_offset, request, ports.cursor_verifier_port, capability, offset); },
    async listSnapshotFiles(raw) { const request = pageSchema.extend({ identity: identitySchema }).strict().parse(snapshotPlain(raw)); authorize(request); if (request.identity.project_id !== request.project_id) throw new Error("BRANCH_SNAPSHOT_IDENTITY_MISMATCH"); const capability = { actor_id: request.actor_id, project_id: request.project_id, query_kind: "files" as const, identity: request.identity }; const offset = await cursorOffset(ports.cursor_verifier_port, request.cursor, capability); const result = z.object({ actor_id: id, project_id: projectId, query_kind: z.literal("files"), cursor_offset: z.number().int().nonnegative(), next_offset: z.number().nullable(), items: z.array(fileRefSchema).max(request.limit), identity: identitySchema }).strict().parse(snapshotPlain(await ports.repository_port.listFiles({ actor_id: request.actor_id, allowed_project_ids: request.accessible_project_ids, project_id: request.project_id, identity: request.identity, cursor_offset: offset, limit: request.limit }))); assertEnvelope(result, request, "files", offset); if (!sameIdentity(result.identity, request.identity)) throw new Error("BRANCH_SNAPSHOT_PORT_IDENTITY_MISMATCH"); return finishPage(result.items.map(fileSummary), result.next_offset, request, ports.cursor_verifier_port, capability, offset); },
    async getSnapshotFile(raw) { const request = scopeSchema.extend({ identity: identitySchema, path }).strict().parse(snapshotPlain(raw)); authorize(request); if (request.identity.project_id !== request.project_id) throw new Error("BRANCH_SNAPSHOT_IDENTITY_MISMATCH"); const response = z.object({ actor_id: id, identity: identitySchema, file: fileRefSchema }).strict().nullable().parse(snapshotPlain(await ports.repository_port.getFile({ actor_id: request.actor_id, allowed_project_ids: request.accessible_project_ids, identity: request.identity, path: request.path }))); if (response === null) throw new Error("BRANCH_SNAPSHOT_FILE_NOT_FOUND"); if (response.actor_id !== request.actor_id || !sameIdentity(response.identity, request.identity) || response.file.path !== request.path) throw new Error("BRANCH_SNAPSHOT_PORT_IDENTITY_MISMATCH"); const ref = response.file; const bytes = await ports.blob_read_port.readBlob(ref.content_hash); if (bytes === null || bytes.byteLength !== ref.size || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== ref.content_hash) throw new Error("BRANCH_SNAPSHOT_BLOB_INVALID"); let content: string; try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("BRANCH_SNAPSHOT_BLOB_INVALID"); } return { ...request.identity, ...ref, content }; },
    async getSnapshotDiff(raw) {
      const request = scopeSchema.extend({ from: identitySchema.nullable(), to: identitySchema })
        .strict().parse(snapshotPlain(raw));
      authorize(request);
      if (request.to.project_id !== request.project_id ||
          (request.from !== null && (request.from.project_id !== request.project_id ||
            request.from.branch_name !== request.to.branch_name))) {
        throw new Error("BRANCH_SNAPSHOT_IDENTITY_MISMATCH");
      }
      const toResponse = snapshotPlain(await ports.repository_port.getSnapshot({ actor_id: request.actor_id, allowed_project_ids: request.accessible_project_ids, identity: request.to }));
      const fromSnapshot = request.from === null
        ? null
        : snapshotPlain(await ports.repository_port.getSnapshot({ actor_id: request.actor_id, allowed_project_ids: request.accessible_project_ids, identity: request.from }));
      const responseSchema = z.object({ actor_id: id, identity: identitySchema, record: branchSnapshotRecordSchema }).strict();
      const toEnvelope = toResponse === null ? null : responseSchema.parse(toResponse);
      const fromEnvelope = fromSnapshot === null ? null : responseSchema.parse(fromSnapshot);
      if (toEnvelope === null || (request.from !== null && fromEnvelope === null)) {
        throw new Error("BRANCH_SNAPSHOT_PORT_IDENTITY_MISMATCH");
      }
      const toRecord = validateRecord(toEnvelope.record, request);
      const fromRecord = fromEnvelope === null ? null : validateRecord(fromEnvelope.record, request);
      if (toEnvelope.actor_id !== request.actor_id || !sameIdentity(toEnvelope.identity, request.to) || !sameIdentity(identity(toRecord), request.to) ||
          (request.from !== null && (fromRecord === null ||
            fromEnvelope?.actor_id !== request.actor_id || !sameIdentity(fromEnvelope.identity, request.from) ||
            !sameIdentity(identity(fromRecord), request.from)))) {
        throw new Error("BRANCH_SNAPSHOT_PORT_IDENTITY_MISMATCH");
      }
      return {
        project_id: request.project_id,
        from: request.from,
        to: request.to,
        diff_ref: toRecord.diff_ref,
        changed_paths: [...toRecord.changed_paths].sort()
      };
    },
    async getSnapshotByVersionRef(raw) {
      const request = scopeSchema.extend({ branch_name: id, project_version: id }).strict().parse(snapshotPlain(raw));
      authorize(request);
      const response = z.object({ actor_id: id, identity: identitySchema, record: branchSnapshotRecordSchema }).strict().nullable()
        .parse(snapshotPlain(await ports.repository_port.getSnapshotByVersionRef({
          actor_id: request.actor_id, allowed_project_ids: request.accessible_project_ids,
          project_id: request.project_id, branch_name: request.branch_name, project_version: request.project_version
        })));
      if (response === null) return null;
      if (response.actor_id !== request.actor_id || response.identity.project_id !== request.project_id ||
          response.identity.branch_name !== request.branch_name || response.identity.project_version !== request.project_version) {
        throw new Error("BRANCH_SNAPSHOT_PORT_IDENTITY_MISMATCH");
      }
      return { identity: response.identity, record: validateRecord(response.record, request) };
    },
    async getSnapshotPredecessor(raw) {
      const request = scopeSchema.extend({ identity: identitySchema }).strict().parse(snapshotPlain(raw));
      authorize(request);
      if (request.identity.project_id !== request.project_id) throw new Error("BRANCH_SNAPSHOT_IDENTITY_MISMATCH");
      const response = z.object({ actor_id: id, identity: identitySchema, record: branchSnapshotRecordSchema }).strict().nullable()
        .parse(snapshotPlain(await ports.repository_port.getSnapshotPredecessor({
          actor_id: request.actor_id, allowed_project_ids: request.accessible_project_ids, identity: request.identity
        })));
      if (response === null) return null;
      if (response.actor_id !== request.actor_id || response.identity.project_id !== request.project_id ||
          response.identity.branch_name !== request.identity.branch_name) {
        throw new Error("BRANCH_SNAPSHOT_PORT_IDENTITY_MISMATCH");
      }
      return { identity: response.identity, record: validateRecord(response.record, request) };
    },
    async previewRestore(raw) {
      const request = scopeSchema.extend({ client_id: id, intent: restoreBranchFilesIntentSchema }).strict().parse(snapshotPlain(raw)); authorize(request); const intent = request.intent;
      if (intent.project_id !== request.project_id) throw new Error("BRANCH_SNAPSHOT_IDENTITY_MISMATCH");
      let offset = 0; let record: BranchSnapshotRecord | undefined; const visited = new Set<number>();
      for (let pageIndex = 0; pageIndex < 100 && record === undefined; pageIndex += 1) {
        if (visited.has(offset)) throw new Error("BRANCH_SNAPSHOT_PORT_PAGE_INVALID"); visited.add(offset);
        const page = pageEnvelopeSchema(z.unknown()).parse(snapshotPlain(await ports.repository_port.listVersions({ actor_id: request.actor_id, allowed_project_ids: request.accessible_project_ids, project_id: request.project_id, branch_name: intent.source_branch_name, cursor_offset: offset, limit: 100 })));
        assertEnvelope(page, request, "versions", offset);
        const records = page.items.map((value) => validateRecord(value, { ...request, branch_name: intent.source_branch_name }));
        assertPageProgress(records.length, page.next_offset, 100, offset);
        record = records.find((value) => value.project_version === intent.source_project_version && value.artifact_id === intent.source_artifact_id && value.commit_sha === intent.source_commit_sha);
        if (record !== undefined || page.next_offset === null) break;
        offset = page.next_offset;
      }
      if (record === undefined) throw new Error("BRANCH_SNAPSHOT_RESTORE_SOURCE_INVALID"); const source = identity(record);
      if (intent.selected_paths.some((selected) => !record.files.some((file) => file.path === selected))) throw new Error("BRANCH_SNAPSHOT_RESTORE_SOURCE_INVALID");
      const conflictResponse = z.object({ actor_id: id, identity: identitySchema, conflicts: z.array(z.object({ path, reason_code: z.enum(["SYNC_CONTENT_CONFLICT", "SYNC_RENAME_TARGET_CONFLICT"]) }).strict()).max(1000) }).strict().parse(snapshotPlain(await ports.restore_conflict_port.listConflicts({ actor_id: request.actor_id, identity: source, selected_paths: intent.selected_paths })));
      const canonicalConflicts = conflictResponse.conflicts;
      if (conflictResponse.actor_id !== request.actor_id || !sameIdentity(conflictResponse.identity, source) || canonicalConflicts.some((conflict) => !intent.selected_paths.includes(conflict.path)) || new Set(canonicalConflicts.map((v) => v.path)).size !== canonicalConflicts.length) throw new Error("BRANCH_SNAPSHOT_PORT_IDENTITY_MISMATCH");
      const body = { actor_id: request.actor_id, project_id: request.project_id, source, client_id: request.client_id, scopes: intent.scopes, selected_paths: intent.selected_paths, conflicts: canonicalConflicts };
      return restoreBranchFilesPreviewReceiptSchema.parse({ schema_version: 1, contract_kind: "branch_files_pull_preview_receipt", project_id: request.project_id, source_ref: { project_id: request.project_id, branch_name: source.branch_name, commit_sha: source.commit_sha, client_id: request.client_id }, source_version: { branch_name: source.branch_name, commit_sha: source.commit_sha, artifact_id: source.artifact_id, project_version: source.project_version }, scopes: ["branch_files"], selected_paths: intent.selected_paths, preview_hash: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`, conflicts: canonicalConflicts });
    }
  };
}
