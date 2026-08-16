import type { PlatformInformationCursorVerifierPort } from "@hunter-harness/contracts";

import type {
  ChangeRecordsDetailSourceRequest,
  ChangeRecordsPageSourceRequest
} from "./types.js";

/**
 * Storage-facing read seam. Implementations must apply actor/project/content filters and
 * bounded cursor pagination before returning a serialized snapshot.
 */
export interface ChangeRecordsQuerySourcePort {
  listPage(input: ChangeRecordsPageSourceRequest): Promise<string>;
  getDetail(input: ChangeRecordsDetailSourceRequest): Promise<string | null>;
}

export interface ChangeDocumentReferencePort {
  resolve(input: {
    readonly actor_id: string;
    readonly project_id: string;
    readonly references: readonly {
      readonly change_key: string;
      readonly document_ids: readonly string[];
    }[];
  }): Promise<string>;
}

export interface ChangeRecordsQueryAdapterDependencies {
  readonly source_port: ChangeRecordsQuerySourcePort;
  readonly reference_port: ChangeDocumentReferencePort;
  readonly cursor_verifier: PlatformInformationCursorVerifierPort;
}
