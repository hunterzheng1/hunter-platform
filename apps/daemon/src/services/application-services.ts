import type { ExternalOperationHandler } from "@hunter/runtime-contracts";

export interface VerificationEvidence {
  readonly kind: string;
  readonly command: string;
  readonly exitCode: number;
  readonly proofScope: "hunter_contract_only";
}

export interface VerificationResult {
  readonly status: "failed" | "passed";
  readonly evidence: readonly VerificationEvidence[];
}

export interface CompletionVerifierPort {
  verify(): Promise<VerificationResult>;
}

/**
 * Constructor-injected ports used by the real composition root. A fixture can
 * implement them, but the composition never imports an E2E or Provider module.
 */
export interface VerticalSliceRuntimeFixture {
  readonly proofScope: "hunter_contract_only";
  readonly runtime: ExternalOperationHandler;
  readonly verifier: CompletionVerifierPort;
}
