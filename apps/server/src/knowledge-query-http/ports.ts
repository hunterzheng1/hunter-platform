import type {
  KnowledgeQueryHttpRequest,
  KnowledgeQueryHttpResponse
} from "@hunter-harness/contracts";

export type KnowledgeQueryHttpIdempotencyResult =
  | { readonly outcome: "new" | "replay"; readonly value: KnowledgeQueryHttpResponse }
  | { readonly outcome: "conflict"; readonly error: { readonly code: "KNOWLEDGE_QUERY_IDEMPOTENCY_CONFLICT"; readonly retryable: boolean } };

/**
 * Server-side authority for the Stage 09 remote query endpoint.  The actor and
 * idempotency key come from the authenticated HTTP boundary, never from the
 * query body.  A production implementation must persist the receipt before
 * returning `new`; the route does not fall back to local semantic search.
 */
export interface KnowledgeQueryHttpServicePort {
  execute(input: {
    readonly request: KnowledgeQueryHttpRequest;
    readonly actor_id: string;
    readonly idempotency_key: string;
    readonly signal?: AbortSignal;
  }): Promise<KnowledgeQueryHttpIdempotencyResult>;
}
