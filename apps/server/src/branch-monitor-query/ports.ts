import type { PlatformInformationCursorVerifierPort } from "@hunter-harness/contracts";

import type {
  BranchMonitorDetailSourceRequest,
  BranchMonitorPageSourceRequest,
  Stage12MonitorVerifierRequest
} from "./types.js";

/** Read-only RunStore projection seam. Implementations return bounded serialized snapshots. */
export interface BranchMonitorSourcePort {
  listPage(input: BranchMonitorPageSourceRequest): Promise<string>;
  getDetail(input: BranchMonitorDetailSourceRequest): Promise<string>;
}

/**
 * Stage 12 trust seam. A production adapter must delegate to the frozen plan-quality
 * public verifier and return its bounded, normalized monitor projection.
 */
export interface Stage12MonitorVerifierPort {
  verify(input: Stage12MonitorVerifierRequest): Promise<string>;
}

export interface BranchMonitorQueryAdapterDependencies {
  readonly source_port: BranchMonitorSourcePort;
  readonly stage12_verifier_port: Stage12MonitorVerifierPort;
  readonly cursor_verifier: PlatformInformationCursorVerifierPort;
}
