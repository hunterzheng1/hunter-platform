import type {
  LegacyPlatformInformation,
  PlatformInformationDetailResponse,
  PlatformInformationPage,
  RestoreBranchFilesConfirmationIntent,
  RestoreBranchFilesPreviewReceipt
} from "@hunter-harness/contracts";
import type {
  SnapshotFileSummary,
  SnapshotIdentity
} from "../branch-snapshots/index.js";

export type BranchVersionQueryResult =
  | { ok: true; mode: "current"; value: PlatformInformationPage }
  | { ok: true; mode: "legacy_read_only"; value: LegacyPlatformInformation }
  | { ok: false; reason_code: "BRANCH_VERSION_QUERY_INVALID" | "BRANCH_VERSION_SOURCE_INVALID" };

export type BranchVersionDetailResult =
  | { ok: true; mode: "current"; value: PlatformInformationDetailResponse }
  | { ok: true; mode: "legacy_read_only"; value: LegacyPlatformInformation }
  | { ok: false; reason_code: "BRANCH_VERSION_DETAIL_INVALID" | "BRANCH_VERSION_SOURCE_INVALID" | "BRANCH_VERSION_NOT_FOUND" };

export interface ConfirmedBranchFilesPullIntent {
  readonly schema_version: 1;
  readonly contract_kind: "branch_files_pull_confirmed_intent";
  readonly project_id: string;
  readonly source_ref: RestoreBranchFilesPreviewReceipt["source_ref"];
  readonly source_version: RestoreBranchFilesPreviewReceipt["source_version"];
  readonly scopes: readonly ["branch_files"];
  readonly selected_paths: readonly string[];
  readonly preview_hash: string;
  readonly idempotency_key: string;
  readonly conflict_decisions: ReadonlyArray<Readonly<RestoreBranchFilesConfirmationIntent["conflict_decisions"][number]>>;
  readonly request_only: true;
}

export type BranchFilesPullConfirmationResult =
  | { ok: true; value: ConfirmedBranchFilesPullIntent }
  | { ok: false; reason_code: "BRANCH_FILES_PULL_CONFIRMATION_INVALID" | "BRANCH_FILES_PULL_CONFIRMATION_MISMATCH" };

export interface BranchVersionQueryAdapter {
  query(serialized: unknown): Promise<BranchVersionQueryResult>;
  listFiles(serializedQuery: unknown, serializedIdentity: unknown): Promise<
    | { ok: true; value: { schema_version: 1; project_id: string; identity: SnapshotIdentity; items: SnapshotFileSummary[]; next_cursor: string | null } }
    | { ok: false; reason_code: "BRANCH_FILES_QUERY_INVALID" | "BRANCH_VERSION_SOURCE_INVALID" }
  >;
  detail(serializedRequest: unknown, serializedLocator: unknown): Promise<BranchVersionDetailResult>;
  diff(serializedRequest: unknown, serializedLocator: unknown): Promise<BranchVersionDetailResult>;
  previewRestore(serialized: unknown): Promise<
    | { ok: true; value: RestoreBranchFilesPreviewReceipt }
    | { ok: false; reason_code: "BRANCH_FILES_RESTORE_PREVIEW_INVALID" | "BRANCH_VERSION_SOURCE_INVALID" }
  >;
  confirmRestore(previewJson: unknown, confirmationJson: unknown): BranchFilesPullConfirmationResult;
}
