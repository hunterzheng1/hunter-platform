import { describe, expect, it } from "vitest";
import {
  ReliabilityEvidenceEnvelopeSchema,
  executeReliabilityScenarios,
  planReliabilityScenarios,
  resolveObservableState,
} from "./scenario.js";

describe("runtime reliability scenario planning", () => {
  it("plans every required boundary with an observable state and cleanup target", () => {
    const scenarios = planReliabilityScenarios();

    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      "unicode_space_workspace",
      "child_process_tree",
      "forced_provider_exit",
      "stale_session_reference",
      "duplicate_command_idempotency",
      "denied_permission_request",
    ]);
    expect(
      scenarios.every(
        (scenario) =>
          scenario.expectedObservableState.length > 0 &&
          scenario.cleanupTarget.length > 0,
      ),
    ).toBe(true);
  });
});

describe("runtime reliability state resolution", () => {
  it("never treats provider loss, a stale session, or denied permission as success", () => {
    expect(resolveObservableState({ kind: "provider_exit", exitCode: 23 })).toBe(
      "needs_attention",
    );
    expect(resolveObservableState({ kind: "session_missing" })).toBe(
      "needs_attention",
    );
    expect(resolveObservableState({ kind: "permission_denied" })).toBe(
      "waiting_approval",
    );
    expect(resolveObservableState({ kind: "verifier_receipt", passed: true })).toBe(
      "succeeded",
    );
  });
});

describe("bounded runtime reliability execution", () => {
  it("executes every scenario inside a temporary Unicode-and-space Git fixture", async () => {
    const evidence = await executeReliabilityScenarios({
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });

    expect(() => ReliabilityEvidenceEnvelopeSchema.parse(evidence)).not.toThrow();
    expect(evidence.proofScope).toBe("hunter_contract_fixture");
    expect(evidence.host.nodeVersion).toBe(process.version);
    expect(evidence.fixture.workspaceShape).toBe("unicode_and_spaces");
    expect(
      Object.fromEntries(
        evidence.scenarios.map((scenario) => [scenario.id, scenario.observedState]),
      ),
    ).toEqual({
      unicode_space_workspace: "succeeded",
      child_process_tree: "succeeded",
      forced_provider_exit: "needs_attention",
      stale_session_reference: "needs_attention",
      duplicate_command_idempotency: "succeeded",
      denied_permission_request: "waiting_approval",
    });
    expect(evidence.scenarios.every((scenario) => scenario.verdict === "PASS")).toBe(
      true,
    );
    expect(
      evidence.scenarios.every((scenario) => scenario.cleanup.outcome === "PASS"),
    ).toBe(true);
    expect(
      evidence.scenarios.every(
        (scenario) => scenario.cleanup.remainingResources === 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(evidence)).not.toMatch(/hunter-phase0-/u);
  }, 20_000);

  it("cleans the exact process tree when the fixture fails after spawning", async () => {
    const evidence = await executeReliabilityScenarios({
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      processTreeFault: "after_child_spawn",
    });
    const processTree = evidence.scenarios.find(
      (scenario) => scenario.id === "child_process_tree",
    );

    expect(processTree).toMatchObject({
      observedState: "needs_attention",
      verdict: "FAIL",
      cleanup: { outcome: "PASS" },
    });
  }, 20_000);

  it("rejects duplicate scenarios, inconsistent summaries, and a tampered fingerprint", async () => {
    const evidence = await executeReliabilityScenarios({
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });
    const firstScenario = evidence.scenarios[0];
    if (firstScenario === undefined) throw new Error("MISSING_RELIABILITY_SCENARIO");

    const duplicateScenario = {
      ...evidence,
      scenarios: [...evidence.scenarios.slice(0, 5), firstScenario],
    };
    const inconsistentSummary = {
      ...evidence,
      summary: { ...evidence.summary, passed: evidence.summary.passed + 1 },
    };
    const tamperedFingerprint = {
      ...evidence,
      contentFingerprint: "0".repeat(64),
    };

    expect(ReliabilityEvidenceEnvelopeSchema.safeParse(duplicateScenario).success).toBe(
      false,
    );
    expect(
      ReliabilityEvidenceEnvelopeSchema.safeParse(inconsistentSummary).success,
    ).toBe(false);
    expect(
      ReliabilityEvidenceEnvelopeSchema.safeParse(tamperedFingerprint).success,
    ).toBe(false);
  }, 20_000);
});
