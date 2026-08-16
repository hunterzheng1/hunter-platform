import type { RestoreBranchFilesIntent, RestoreBranchFilesPreviewReceipt } from "@hunter-harness/contracts";

export const BRANCH_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export type SnapshotContentKind = "config" | "rule" | "architecture" | "instruction" | "branch_file" | "change_document" | "archive_package" | "knowledge_entry" | "knowledge_candidate" | "project_content_candidate";
export type SnapshotAction = "add" | "modify" | "delete" | "restore" | "rename" | "no_change";
export type SnapshotMediaType = "text/plain" | "text/markdown" | "application/json" | "application/yaml";

export interface SnapshotIdentity {
  project_id: string; branch_name: string; commit_sha: string; project_version: string;
  artifact_id: string; manifest_hash: string;
}
export interface SnapshotFileRef { path: string; content_kind: SnapshotContentKind; size: number; content_hash: string; media_type: SnapshotMediaType; action?: SnapshotAction | undefined; }
export interface BranchSnapshotRecord extends SnapshotIdentity { schema_version: 1; file_count: number; changed_file_count: number; uploaded_at: string; diff_ref: string; files: SnapshotFileRef[]; changed_paths: string[]; }
/** Test/ingest input only. Repository records never contain this content. */
export interface BranchSnapshotSeed extends Omit<BranchSnapshotRecord, "files"> { files: Array<SnapshotFileRef & { content: string }>; }
export type BranchSnapshotSummary = Omit<BranchSnapshotRecord, "files" | "changed_paths">;
export type SnapshotVersionSummary = BranchSnapshotSummary;
export type SnapshotFileSummary = Omit<SnapshotFileRef, "media_type">;
export interface SnapshotFileDetail extends SnapshotFileRef, SnapshotIdentity { content: string; }
export interface SnapshotDiff { project_id: string; from: SnapshotIdentity | null; to: SnapshotIdentity; diff_ref: string; changed_paths: string[]; }
export interface SnapshotPage<T> { items: T[]; next_cursor: string | null; }
export interface AuthorizedProjectScope { schema_version: 1; actor_id: string; project_id: string; accessible_project_ids: string[]; }
export interface PageRequest extends AuthorizedProjectScope { cursor: string | null; limit: number; }
export interface BranchPageRequest extends PageRequest { branch_name: string; }
export interface SnapshotPageRequest extends PageRequest { identity: SnapshotIdentity; }
export interface SnapshotFileRequest extends AuthorizedProjectScope { identity: SnapshotIdentity; path: string; }
export interface SnapshotDiffRequest extends AuthorizedProjectScope { from: SnapshotIdentity | null; to: SnapshotIdentity; }
export interface RestorePreviewRequest extends AuthorizedProjectScope { client_id: string; intent: RestoreBranchFilesIntent; }
export interface SnapshotVersionRefRequest extends AuthorizedProjectScope { branch_name: string; project_version: string; }
export interface SnapshotIdentityRequest extends AuthorizedProjectScope { identity: SnapshotIdentity; }
export interface SnapshotRecordEnvelope { identity: SnapshotIdentity; record: BranchSnapshotRecord; }
export interface BranchSnapshotModule {
  listBranches(input: PageRequest): Promise<SnapshotPage<BranchSnapshotSummary>>;
  listProjectSnapshotVersions(input: PageRequest): Promise<SnapshotPage<SnapshotVersionSummary>>;
  listSnapshotVersions(input: BranchPageRequest): Promise<SnapshotPage<SnapshotVersionSummary>>;
  listSnapshotFiles(input: SnapshotPageRequest): Promise<SnapshotPage<SnapshotFileSummary>>;
  getSnapshotFile(input: SnapshotFileRequest): Promise<SnapshotFileDetail>;
  getSnapshotDiff(input: SnapshotDiffRequest): Promise<SnapshotDiff>;
  /** 按 (branch_name, project_version) 唯一版本引用反查快照（详情定位符解析）。 */
  getSnapshotByVersionRef(input: SnapshotVersionRefRequest): Promise<SnapshotRecordEnvelope | null>;
  /** 同分支列表排序中严格位于目标之前的第一条快照（diff 的 from 端）。 */
  getSnapshotPredecessor(input: SnapshotIdentityRequest): Promise<SnapshotRecordEnvelope | null>;
  previewRestore(input: RestorePreviewRequest): Promise<RestoreBranchFilesPreviewReceipt>;
}
export interface LegacyBranchSnapshot { schemaVersion: 0; projectId: string; projectVersion: string; artifactId: string; commitSha: string; uploadedAt: string; files: Array<{ path: string; contentHash: string; size: number }>; }
export type BranchSnapshotReadResult =
  | { ok: true; mode: "current"; value: BranchSnapshotRecord }
  | { ok: true; mode: "legacy_read_only"; value: LegacyBranchSnapshot & { branch_name: "unmarked" } }
  | { ok: false; reason_code: "BRANCH_SNAPSHOT_INVALID" | "BRANCH_SNAPSHOT_VERSION_UNSUPPORTED" | "BRANCH_SNAPSHOT_SERIALIZED_JSON_REQUIRED" | "BRANCH_SNAPSHOT_SERIALIZED_JSON_TOO_LARGE" };
