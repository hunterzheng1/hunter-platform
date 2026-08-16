import type {
  KnowledgeExtractionRetryIntent,
  PlatformInformationDetailResponse,
  PlatformInformationPage
} from "@hunter-harness/contracts";

export type ProjectKnowledgeQueryReasonCode =
  | "PROJECT_KNOWLEDGE_QUERY_INVALID"
  | "PROJECT_KNOWLEDGE_LEGACY_READ_ONLY"
  | "PROJECT_KNOWLEDGE_CURSOR_INVALID"
  | "PROJECT_KNOWLEDGE_DETAIL_NOT_FOUND"
  | "PROJECT_KNOWLEDGE_SOURCE_INVALID"
  | "PROJECT_KNOWLEDGE_RETRY_REQUEST_INVALID"
  | "PROJECT_KNOWLEDGE_RETRY_JOB_NOT_FOUND"
  | "PROJECT_KNOWLEDGE_RETRY_GENERATION_CONFLICT"
  | "PROJECT_KNOWLEDGE_RETRY_AUTHORITY_INVALID"
  | "PROJECT_KNOWLEDGE_RETRY_INTENT_INVALID";

export type ProjectKnowledgePageResult =
  | { ok: true; value: PlatformInformationPage }
  | { ok: false; reason_code: ProjectKnowledgeQueryReasonCode };

export type ProjectKnowledgeDetailResult =
  | { ok: true; value: PlatformInformationDetailResponse }
  | { ok: false; reason_code: ProjectKnowledgeQueryReasonCode };

export type ProjectKnowledgeRetryIntentResult =
  | { ok: true; value: KnowledgeExtractionRetryIntent }
  | { ok: false; reason_code: ProjectKnowledgeQueryReasonCode };

export interface ProjectKnowledgeSourceRequest {
  readonly project_id: string;
  readonly actor_id: string;
  readonly accessible_project_ids: readonly string[];
  readonly content_types: readonly ["knowledge_entry"];
  readonly sort: "extracted_at_desc_knowledge_id_asc";
  readonly request_cursor: string | null;
}

export interface ProjectKnowledgePageSourceRequest extends ProjectKnowledgeSourceRequest {
  readonly limit: number;
  readonly cursor: string | null;
}

export interface ProjectKnowledgeDetailSourceRequest extends ProjectKnowledgeSourceRequest {
  readonly detail_id: string;
}

export interface ProjectKnowledgeRetryAuthorityRequest {
  readonly actor_id: string;
  readonly project_id: string;
  readonly job_id: string;
  readonly expected_generation: number;
}
