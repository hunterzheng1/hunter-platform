import { RuntimeProviderIdSchema } from "@hunter/domain";
import { FakeRuntime } from "@hunter/testkit";

export interface VerticalSliceVerificationEvidence {
  readonly kind: "test";
  readonly command: "npm test";
  readonly exitCode: 0 | 1;
  readonly proofScope: "hunter_contract_only";
}

export interface VerticalSliceVerificationResult {
  readonly status: "failed" | "passed";
  readonly evidence: readonly VerticalSliceVerificationEvidence[];
}

export interface VerticalSliceVerifierPort {
  verify(): Promise<VerticalSliceVerificationResult>;
}

export class DeterministicFailureThenPassVerifier
  implements VerticalSliceVerifierPort
{
  #verificationCount = 0;

  public async verify(): Promise<VerticalSliceVerificationResult> {
    this.#verificationCount += 1;
    const failed = this.#verificationCount === 1;
    return Object.freeze({
      status: failed ? "failed" : "passed",
      evidence: Object.freeze([
        Object.freeze({
          kind: "test",
          command: "npm test",
          exitCode: failed ? 1 : 0,
          proofScope: "hunter_contract_only",
        }),
      ]),
    });
  }
}

export class VerticalSliceFixture {
  public readonly proofScope = "hunter_contract_only" as const;
  public readonly runtimeProviderId =
    RuntimeProviderIdSchema.parse("rtp_e2econtract01");

  public constructor(
    public readonly runtime: FakeRuntime,
    public readonly verifier: VerticalSliceVerifierPort,
  ) {}
}

export function createVerticalSliceFixture(): VerticalSliceFixture {
  const providerId = RuntimeProviderIdSchema.parse("rtp_e2econtract01");
  return new VerticalSliceFixture(
    new FakeRuntime({
      providerId,
      implementationVersion: "deterministic-contract-fixture-v1",
      observedAt: "2026-07-23T00:00:00.000Z",
    }),
    new DeterministicFailureThenPassVerifier(),
  );
}
