import { describe, expect, it } from "vitest";
import {
  GateRRuntimeEvidenceSchema,
  createOrcaLauncherAttemptEvidence,
  createGateRRuntimeEvidence,
} from "./gate-r-runtime-evidence.js";

const digest = (character: string): string => character.repeat(64);

function inventory() {
  return {
    schemaVersion: 1,
    evidenceType: "phase0_environment_inventory",
    generatedAt: "2026-07-26T15:00:00.000Z",
    generator: { name: "hunter-phase0-doctor", version: "0.1.0" },
    host: { platform: "win32", architecture: "x64", release: "10.0.26200" },
    probes: [
      {
        id: "codebuddy",
        displayName: "CodeBuddy Code",
        category: "agent",
        status: "BLOCKED",
        version: null,
        helpHash: null,
        availability: {
          status: "BLOCKED",
          reason: "executable_missing_or_unusable",
        },
        authentication: {
          required: true,
          status: "BLOCKED",
          method: "codebuddy auth status",
          reason: "executable_not_available",
        },
        commands: [],
      },
      {
        id: "cursor",
        displayName: "Cursor",
        category: "agent",
        status: "BLOCKED",
        version: null,
        helpHash: null,
        availability: {
          status: "BLOCKED",
          reason: "executable_missing_or_unusable",
        },
        authentication: {
          required: true,
          status: "BLOCKED",
          method: "no_safe_noninteractive_probe",
          reason: "executable_not_available",
        },
        commands: [],
      },
    ],
    summary: { detected: 0, blocked: 2, notProven: 0 },
    redaction: { applied: true, schemaVersion: 1 },
    contentFingerprint: digest("a"),
  } as const;
}

function codexEvidence() {
  return {
    schemaVersion: 1,
    evidenceType: "phase0_direct_codex_runtime",
    generatedAt: "2026-07-26T14:57:43.507Z",
    generator: { name: "hunter-phase0-direct-codex", version: "0.1.0" },
    host: {
      platform: "win32",
      architecture: "x64",
      release: "10.0.26200",
      nodeVersion: "v24.14.0",
    },
    connector: "direct_codex_cli",
    installedVersion: "0.144.6",
    helpHashes: {
      exec: digest("b"),
      resume: digest("c"),
      appServer: digest("d"),
    },
    loginAvailable: true,
    connectorVerdict: "NOT_PROVEN",
    proofScope: "local_typed_scenario",
    modelServiceCallAttempted: true,
    remoteRepositoryWriteAttempted: false,
    realCallCount: 3,
    fixture: {
      cwdScope: "temporary_git_fixture",
      remotePresent: false,
      repositoryCleanAfterScenario: true,
      cleanup: "verified_by_fixture_return",
    },
    commands: [],
    capabilities: [
      { id: "discover", outcome: "PASS", reason: "fixed_cli_and_login_available" },
      { id: "workspace_targeting", outcome: "PASS", reason: "temporary_fixture_bound" },
      { id: "launch", outcome: "NOT_PROVEN", reason: "session_identity_missing" },
      { id: "send", outcome: "NOT_PROVEN", reason: "prompt_acceptance_not_proven" },
      { id: "observe", outcome: "PASS", reason: "structured_events_observed" },
      { id: "structured_events", outcome: "PASS", reason: "jsonl_parsed" },
      { id: "permission_events", outcome: "NOT_PROVEN", reason: "not_exercised" },
      { id: "resume", outcome: "PASS", reason: "same_identity" },
      { id: "interrupt", outcome: "NOT_PROVEN", reason: "no_structured_receipt" },
      { id: "completion_receipt", outcome: "NOT_PROVEN", reason: "terminal_missing" },
      { id: "headless", outcome: "NOT_PROVEN", reason: "not_completed" },
      { id: "artifact_export", outcome: "NOT_PROVEN", reason: "not_exercised" },
    ],
    redaction: { applied: true, schemaVersion: 1 },
    contentFingerprint: digest("e"),
  } as const;
}

function orcaEvidence() {
  return {
    schemaVersion: 1,
    evidenceType: "phase0_orca_windows_provider_preflight",
    generatedAt: "2026-07-26T14:50:00.000Z",
    generator: { name: "hunter-phase0-orca-preflight", version: "0.1.0" },
    host: { platform: "win32", architecture: "x64", release: "10.0.26200" },
    provider: "orca",
    candidateVersion: null,
    providerVerdict: "NOT_PROVEN",
    proofScope: "local_preflight_only",
    mutationAttempted: false,
    commands: [],
    capabilities: [
      {
        id: "discover_runtime",
        outcome: "PASS",
        reason: "status_json_reports_running_reachable_runtime",
      },
      {
        id: "fixed_version",
        outcome: "NOT_PROVEN",
        reason: "numeric_version_missing",
      },
    ],
    redaction: { applied: true, schemaVersion: 1 },
    contentFingerprint: digest("f"),
  } as const;
}

function orcaLauncherEvidence() {
  return createOrcaLauncherAttemptEvidence({
    recordedAt: new Date("2026-07-26T15:00:30.000Z"),
    durationLowerBoundMs: 90_000,
    sourceOrcaDigest: digest("f"),
  });
}

describe("Gate R runtime evidence", () => {
  it("computes connector levels only from atomic receipts", () => {
    const evidence = createGateRRuntimeEvidence({
      inventory: inventory(),
      codex: codexEvidence(),
      orca: orcaEvidence(),
      orcaLauncher: orcaLauncherEvidence(),
      generatedAt: new Date("2026-07-26T15:01:00.000Z"),
    });

    expect(evidence.provider.verdict).toBe("NOT_PROVEN");
    expect(evidence.provider.capabilities.find(
      ({ id }) => id === "discover_runtime",
    )?.outcome).toBe("PASS");
    expect(evidence.connectors.map(({ connector, manifest }) => ({
      connector,
      level: manifest.level,
    }))).toEqual([
      { connector: "codex", level: "NONE" },
      { connector: "codebuddy", level: "NONE" },
      { connector: "cursor", level: "NONE" },
    ]);
  });

  it("never upgrades not-proven or blocked outcomes to supported", () => {
    const evidence = createGateRRuntimeEvidence({
      inventory: inventory(),
      codex: codexEvidence(),
      orca: orcaEvidence(),
      orcaLauncher: orcaLauncherEvidence(),
      generatedAt: new Date("2026-07-26T15:01:00.000Z"),
    });
    const codex = evidence.connectors.find(({ connector }) => connector === "codex");
    if (codex?.receipt.schemaVersion !== 2) {
      throw new Error("EXPECTED_CURRENT_CODEX_RECEIPT");
    }

    expect(codex.receipt.results.find(
      ({ capability }) => capability === "launch",
    )?.status).toBe("unknown");
    expect(codex.receipt.results.find(
      ({ capability }) => capability === "observe",
    )?.status).toBe("supported");
    expect(codex.receipt.productVersion.supported).not.toContain("0.144.6");
    expect(codex.receipt.protocol).toMatchObject({
      observedVersion: null,
      schemaVersion: null,
      schemaDigest: null,
    });
    expect(evidence.overallVerdict).toBe("NOT_PROVEN");
  });

  it("keeps the content fingerprint stable for the same source receipts", () => {
    const first = createGateRRuntimeEvidence({
      inventory: inventory(),
      codex: codexEvidence(),
      orca: orcaEvidence(),
      orcaLauncher: orcaLauncherEvidence(),
      generatedAt: new Date("2026-07-26T15:01:00.000Z"),
    });
    const second = createGateRRuntimeEvidence({
      inventory: inventory(),
      codex: codexEvidence(),
      orca: orcaEvidence(),
      orcaLauncher: orcaLauncherEvidence(),
      generatedAt: new Date("2026-07-26T15:02:00.000Z"),
    });

    expect(second.contentFingerprint).toBe(first.contentFingerprint);
  });

  it("rejects an envelope whose content fingerprint was altered", () => {
    const evidence = createGateRRuntimeEvidence({
      inventory: inventory(),
      codex: codexEvidence(),
      orca: orcaEvidence(),
      orcaLauncher: orcaLauncherEvidence(),
      generatedAt: new Date("2026-07-26T15:01:00.000Z"),
    });

    expect(GateRRuntimeEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(() => GateRRuntimeEvidenceSchema.parse({
      ...evidence,
      contentFingerprint: digest("0"),
    })).toThrow();
  });

  it("preserves the Orca launcher timeout as a fail receipt", () => {
    const attempt = orcaLauncherEvidence();

    expect(attempt.launcher).toEqual({
      outcome: "FAIL",
      timedOut: true,
      exitCode: null,
      outputCaptured: false,
      cleanup: "exact_launcher_terminated",
    });
    expect(attempt.runtimeAfterLauncher.status).toBe("ready");
    expect(attempt.stepSuccessInferred).toBe(false);
  });
});
