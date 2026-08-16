import type {
  KnowledgeExtractionRetryIntentHashPort,
  PlatformInformationCursorVerifierPort
} from "@hunter-harness/contracts";

import type {
  ProjectKnowledgeDetailSourceRequest,
  ProjectKnowledgePageSourceRequest,
  ProjectKnowledgeRetryAuthorityRequest
} from "./types.js";

/** Read-only storage seam. Implementations return bounded serialized snapshots. */
export interface ProjectKnowledgeQuerySourcePort {
  listPage(input: ProjectKnowledgePageSourceRequest): Promise<string>;
  getDetail(input: ProjectKnowledgeDetailSourceRequest): Promise<string | null>;
}

/** Read-only authority seam over the canonical extraction job/task snapshot. */
export interface KnowledgeRetryAuthorityPort {
  lookup(input: ProjectKnowledgeRetryAuthorityRequest): Promise<string>;
}

export interface ProjectKnowledgeQueryAdapterDependencies {
  readonly source_port: ProjectKnowledgeQuerySourcePort;
  readonly cursor_verifier: PlatformInformationCursorVerifierPort;
  readonly retry_intent_hash_port: KnowledgeExtractionRetryIntentHashPort;
  readonly retry_authority_port: KnowledgeRetryAuthorityPort;
}
