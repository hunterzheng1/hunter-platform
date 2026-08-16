import type {
  PlatformInformationDetailResponse,
  PlatformInformationPage
} from "@hunter-harness/contracts";

export type BranchMonitorQueryReasonCode =
  | "BRANCH_MONITOR_QUERY_INVALID"
  | "BRANCH_MONITOR_LEGACY_READ_ONLY"
  | "BRANCH_MONITOR_CURSOR_INVALID"
  | "BRANCH_MONITOR_SOURCE_INVALID";

export type BranchMonitorPageResult =
  | { ok: true; value: PlatformInformationPage }
  | { ok: false; reason_code: BranchMonitorQueryReasonCode };

export type BranchMonitorDetailResult =
  | { ok: true; value: PlatformInformationDetailResponse }
  | { ok: false; reason_code: BranchMonitorQueryReasonCode };

export interface BranchMonitorSourceRequest {
  readonly project_id: string;
  readonly actor_id: string;
  readonly accessible_project_ids: readonly string[];
  readonly content_types: readonly ["run_event"];
  readonly sort: "last_event_at_desc_run_id_asc";
  readonly request_cursor: string | null;
}

export interface BranchMonitorPageSourceRequest extends BranchMonitorSourceRequest {
  readonly limit: number;
  readonly cursor: string | null;
}

export interface BranchMonitorDetailSourceRequest extends BranchMonitorSourceRequest {
  readonly detail_id: string;
}

export interface Stage12MonitorVerifierRequest {
  readonly serialized_bundle: string;
  readonly bundle_sha256: string;
  readonly project_id: string;
}
