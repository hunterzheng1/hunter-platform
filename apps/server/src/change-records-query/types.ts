import type {
  PlatformInformationDetailResponse,
  PlatformInformationPage
} from "@hunter-harness/contracts";

export type ChangeRecordsQueryReasonCode =
  | "CHANGE_RECORDS_QUERY_INVALID"
  | "CHANGE_RECORDS_LEGACY_READ_ONLY"
  | "CHANGE_RECORDS_CURSOR_INVALID"
  | "CHANGE_RECORDS_DETAIL_NOT_FOUND"
  | "CHANGE_RECORDS_SOURCE_INVALID";

export type ChangeRecordsPageResult =
  | { ok: true; value: PlatformInformationPage }
  | { ok: false; reason_code: ChangeRecordsQueryReasonCode };

export type ChangeRecordsDetailResult =
  | { ok: true; value: PlatformInformationDetailResponse }
  | { ok: false; reason_code: ChangeRecordsQueryReasonCode };

export interface ChangeRecordsSourceRequest {
  readonly project_id: string;
  readonly actor_id: string;
  readonly accessible_project_ids: readonly string[];
  readonly content_types: readonly [
    "change_document", "archive_package", "project_content_candidate"
  ];
  readonly sort: "archived_at_desc_change_key_asc";
  readonly request_cursor: string | null;
}

export interface ChangeRecordsPageSourceRequest extends ChangeRecordsSourceRequest {
  readonly limit: number;
  readonly cursor: string | null;
}

export interface ChangeRecordsDetailSourceRequest extends ChangeRecordsSourceRequest {
  readonly detail_id: string;
}
