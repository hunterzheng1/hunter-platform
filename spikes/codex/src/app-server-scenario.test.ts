import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "@hunter/spike-testkit";
import {
  AppServerEvidenceSchema,
  collectAppServerEvidence,
  executeAppServerScenario,
  requireSupportedCodexVersion,
  validateAppServerSchemaArtifacts,
} from "./app-server-scenario.js";

const hash = "a".repeat(64);

describe("Codex app-server evidence", () => {
  it("blocks version drift before a real app-server turn", () => {
    expect(requireSupportedCodexVersion("0.144.6")).toBe("0.144.6");
    expect(() => requireSupportedCodexVersion("9.9.9")).toThrow("APP_SERVER_VERSION_MISMATCH");
  });

  it("applies one scenario deadline before any preflight or model turn", async () => {
    const runner: CommandRunner = {
      run: async () => {
        throw new Error("RUNNER_MUST_NOT_BE_CALLED");
      },
    };
    await expect(
      executeAppServerScenario({
        runner,
        executable: "codex",
        now: () => new Date("2026-07-23T00:00:00Z"),
        host: { platform: "win32", architecture: "x64", release: "10.0", nodeVersion: "v24" },
        timeoutMs: 0,
      }),
    ).rejects.toThrow("APP_SERVER_SCENARIO_TIMEOUT");
  });

  it("fails closed when the fixed generated schema misses a required protocol marker", () => {
    const valid = {
      protocol: JSON.stringify([
        "thread/start",
        "turn/start",
        "turn/interrupt",
        "turn/started",
        "turn/completed",
        "approvalsReviewer",
        "sandboxPolicy",
        "ephemeral",
      ]),
      serverRequests: JSON.stringify([
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
      ]),
      commandApprovalResponse: JSON.stringify(["decline", "cancel"]),
      fileApprovalResponse: JSON.stringify(["decline", "cancel"]),
      permissionsApprovalResponse: JSON.stringify(["permissions", "strictAutoReview"]),
    };
    expect(validateAppServerSchemaArtifacts(valid)).toBe(true);
    expect(() =>
      validateAppServerSchemaArtifacts({ ...valid, protocol: JSON.stringify(["turn/start"]) }),
    ).toThrow("APP_SERVER_SCHEMA_REQUIRED_MARKER_MISSING");
  });

  it("validates the committed redacted evidence envelope", () => {
    const path = resolve("docs/validation/evidence/codex/app-server-runtime.json");
    const evidence = JSON.parse(readFileSync(path, "utf8")) as unknown;
    expect(() => AppServerEvidenceSchema.parse(evidence)).not.toThrow();
  });

  it("rejects duplicate or reordered atomic capability slots", () => {
    const path = resolve("docs/validation/evidence/codex/app-server-runtime.json");
    const evidence = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const duplicate = {
      ...evidence,
      capabilities: [
        { id: "permission_events", outcome: "PASS", reason: "observed" },
        { id: "permission_events", outcome: "PASS", reason: "observed_again" },
      ],
    };
    const result = AppServerEvidenceSchema.safeParse(duplicate);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "capabilities")).toBe(true);
    }
  });

  it("rejects an attempt ledger whose conformance contradicts its counts", () => {
    const path = resolve("docs/validation/evidence/codex/app-server-runtime.json");
    const evidence = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const attempts = evidence.attempts as Record<string, unknown>;
    const result = AppServerEvidenceSchema.safeParse({
      ...evidence,
      attempts: { ...attempts, conformance: "PASS", reason: "within_real_call_limit" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "attempts")).toBe(true);
    }
  });

  it("records approval and structured interrupt without private protocol identities", () => {
    const evidence = collectAppServerEvidence({
      now: () => new Date("2026-07-23T00:00:00.000Z"),
      host: {
        platform: "win32",
        architecture: "x64",
        release: "10.0",
        nodeVersion: "v24.14.0",
      },
      installedVersion: "0.144.6",
      helpHash: hash,
      schemaBundleHash: hash,
      schemaCanonicalHash: "b".repeat(64),
      schemaValidated: true as const,
      receipt: {
        summary: {
          initialized: true,
          ephemeralThread: true,
          approvalRequestMethods: ["item/commandExecution/requestApproval"],
          approvalDenialMethods: ["item/commandExecution/requestApproval"],
          approvalContextMatched: true,
          interruptAccepted: true,
          interruptTerminalStatus: "interrupted",
          protocolErrors: 0,
          stepSuccess: false,
        },
        cleanup: "process_tree_terminated",
        realTurnCount: 2,
      },
      fixture: {
        remotePresent: false,
        repositoryCleanAfterScenario: true,
      },
      attempts: {
        plannedRealCallLimit: 2,
        actualRealScenarioRuns: 1,
        actualRealTurnCount: 2,
      },
    });

    expect(() => AppServerEvidenceSchema.parse(evidence)).not.toThrow();
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      evidenceType: "phase0_codex_app_server_runtime",
      installedVersion: "0.144.6",
      transport: "stdio",
      proofScope: "local_ephemeral_typed_scenario",
      providerVerdict: "NOT_PROVEN",
      realTurnCount: 2,
      schemaCanonicalHash: "b".repeat(64),
      attempts: { conformance: "PASS" },
      fixture: { remotePresent: false, repositoryCleanAfterScenario: true },
      capabilities: [
        { id: "permission_events", outcome: "PASS" },
        { id: "interrupt", outcome: "PASS" },
      ],
    });
    expect(JSON.stringify(evidence)).not.toMatch(/thread-private|turn-private|fixed prompt/iu);
    const wrongVersion = AppServerEvidenceSchema.safeParse({ ...evidence, installedVersion: "9.9.9" });
    expect(wrongVersion.success).toBe(false);
    if (!wrongVersion.success) {
      expect(wrongVersion.error.issues.some((issue) => issue.path[0] === "installedVersion")).toBe(true);
    }
  });

  it("keeps missing approval and incomplete interruption NOT_PROVEN", () => {
    const evidence = collectAppServerEvidence({
      now: () => new Date("2026-07-23T00:00:00.000Z"),
      host: { platform: "win32", architecture: "x64", release: "10.0", nodeVersion: "v24" },
      installedVersion: "0.144.6",
      helpHash: hash,
      schemaBundleHash: hash,
      schemaCanonicalHash: "b".repeat(64),
      schemaValidated: true as const,
      receipt: {
        summary: {
          initialized: true,
          ephemeralThread: true,
          approvalRequestMethods: [],
          approvalDenialMethods: [],
          approvalContextMatched: false,
          interruptAccepted: true,
          interruptTerminalStatus: "completed",
          protocolErrors: 0,
          stepSuccess: false,
        },
        cleanup: "not_proven",
        realTurnCount: 2,
      },
      fixture: { remotePresent: false, repositoryCleanAfterScenario: true },
      attempts: { plannedRealCallLimit: 2, actualRealScenarioRuns: 1, actualRealTurnCount: 2 },
    });

    expect(evidence.capabilities).toEqual([
      { id: "permission_events", outcome: "NOT_PROVEN", reason: "no_approval_request_observed" },
      { id: "interrupt", outcome: "NOT_PROVEN", reason: "matching_interrupted_terminal_not_observed" },
    ]);
  });

  it("requires a matching denial, a clean fixture, and attempt conformance before PASS", () => {
    const base = {
      now: () => new Date("2026-07-23T00:00:00.000Z"),
      host: { platform: "win32", architecture: "x64", release: "10.0", nodeVersion: "v24" },
      installedVersion: "0.144.6",
      helpHash: hash,
      schemaBundleHash: hash,
      schemaCanonicalHash: "b".repeat(64),
      schemaValidated: true as const,
      receipt: {
        summary: {
          initialized: true,
          ephemeralThread: true,
          approvalRequestMethods: ["item/commandExecution/requestApproval"],
          approvalDenialMethods: [] as string[],
          approvalContextMatched: true,
          interruptAccepted: true,
          interruptTerminalStatus: "interrupted" as const,
          protocolErrors: 0,
          stepSuccess: false as const,
        },
        cleanup: "process_tree_terminated" as const,
        realTurnCount: 2 as const,
      },
    };

    const unhandled = collectAppServerEvidence({
      ...base,
      fixture: { remotePresent: false, repositoryCleanAfterScenario: true },
      attempts: { plannedRealCallLimit: 2, actualRealScenarioRuns: 1, actualRealTurnCount: 2 },
    });
    expect(unhandled.capabilities[0].outcome).toBe("NOT_PROVEN");

    const partiallyHandled = collectAppServerEvidence({
      ...base,
      receipt: {
        ...base.receipt,
        summary: {
          ...base.receipt.summary,
          approvalRequestMethods: [
            "item/commandExecution/requestApproval",
            "item/commandExecution/requestApproval",
          ],
          approvalDenialMethods: ["item/commandExecution/requestApproval"],
        },
      },
      fixture: { remotePresent: false, repositoryCleanAfterScenario: true },
      attempts: { plannedRealCallLimit: 2, actualRealScenarioRuns: 1, actualRealTurnCount: 2 },
    });
    expect(partiallyHandled.capabilities[0].outcome).toBe("NOT_PROVEN");

    const dirty = collectAppServerEvidence({
      ...base,
      receipt: {
        ...base.receipt,
        summary: {
          ...base.receipt.summary,
          approvalDenialMethods: ["item/commandExecution/requestApproval"],
        },
      },
      fixture: { remotePresent: false, repositoryCleanAfterScenario: false },
      attempts: { plannedRealCallLimit: 2, actualRealScenarioRuns: 1, actualRealTurnCount: 2 },
    });
    expect(dirty.capabilities.map((capability) => capability.outcome)).toEqual([
      "NOT_PROVEN",
      "NOT_PROVEN",
    ]);

    const exceeded = collectAppServerEvidence({
      ...base,
      receipt: {
        ...base.receipt,
        summary: {
          ...base.receipt.summary,
          approvalDenialMethods: ["item/commandExecution/requestApproval"],
        },
      },
      fixture: { remotePresent: false, repositoryCleanAfterScenario: true },
      attempts: { plannedRealCallLimit: 2, actualRealScenarioRuns: 3, actualRealTurnCount: 6 },
    });
    expect(exceeded.attempts.conformance).toBe("FAIL");
    expect(exceeded.capabilities.map((capability) => capability.outcome)).toEqual([
      "NOT_PROVEN",
      "NOT_PROVEN",
    ]);
  });

  it("keeps the fingerprint stable across generation time", () => {
    const input = {
      host: { platform: "win32", architecture: "x64", release: "10.0", nodeVersion: "v24" },
      installedVersion: "0.144.6",
      helpHash: hash,
      schemaBundleHash: hash,
      schemaCanonicalHash: "b".repeat(64),
      schemaValidated: true as const,
      receipt: {
        summary: {
          initialized: true,
          ephemeralThread: true,
          approvalRequestMethods: [],
          approvalDenialMethods: [],
          approvalContextMatched: false,
          interruptAccepted: false,
          interruptTerminalStatus: "not_observed" as const,
          protocolErrors: 0,
          stepSuccess: false as const,
        },
        cleanup: "direct_process_exit" as const,
        realTurnCount: 2 as const,
      },
      fixture: { remotePresent: false as const, repositoryCleanAfterScenario: true },
      attempts: {
        plannedRealCallLimit: 2 as const,
        actualRealScenarioRuns: 1,
        actualRealTurnCount: 2,
      },
    };
    const first = collectAppServerEvidence({ ...input, now: () => new Date("2026-07-23T00:00:00Z") });
    const second = collectAppServerEvidence({ ...input, now: () => new Date("2026-07-24T00:00:00Z") });
    expect(first.contentFingerprint).toBe(second.contentFingerprint);
  });
});
