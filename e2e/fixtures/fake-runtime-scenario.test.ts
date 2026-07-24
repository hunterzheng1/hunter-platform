import { RuntimeProviderIdSchema } from "@hunter/domain";
import { FakeRuntime } from "@hunter/testkit";
import { describe, expect, it } from "vitest";

import {
  DeterministicFailureThenPassVerifier,
  createVerticalSliceFixture,
} from "./fake-runtime-scenario.js";

describe("vertical slice fake fixture", () => {
  it("composes the Fake Runtime and verifier as independent constructor ports", async () => {
    const fixture = createVerticalSliceFixture();

    expect(fixture.runtime).toBeInstanceOf(FakeRuntime);
    expect(fixture.runtimeProviderId).toBe(
      RuntimeProviderIdSchema.parse("rtp_e2econtract01"),
    );
    expect(fixture.verifier).toBeInstanceOf(
      DeterministicFailureThenPassVerifier,
    );
    expect(fixture.proofScope).toBe("hunter_contract_only");
  });

  it("fails verification once and then passes without changing the runtime object", async () => {
    const fixture = createVerticalSliceFixture();
    const runtime = fixture.runtime;

    await expect(fixture.verifier.verify()).resolves.toMatchObject({
      status: "failed",
      evidence: [{ kind: "test", exitCode: 1 }],
    });
    await expect(fixture.verifier.verify()).resolves.toMatchObject({
      status: "passed",
      evidence: [{ kind: "test", exitCode: 0 }],
    });
    expect(fixture.runtime).toBe(runtime);
  });
});
