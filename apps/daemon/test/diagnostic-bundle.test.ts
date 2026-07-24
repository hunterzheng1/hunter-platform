import { describe, expect, it } from "vitest";

import { assertNoSensitiveMaterial } from "@hunter/policy";

import {
  DiagnosticBundleSchema,
  createDiagnosticBundle,
} from "../src/services/diagnostic-bundle.js";

describe("diagnostic bundle", () => {
  it("emits deterministic allowlisted bytes with every source canary removed", () => {
    const canaries = {
      token: "tok_diagnostic_canary_01",
      cookie: "hunter_session=diagnostic_cookie_02",
      apiKey: "diagnostic_api_key_03",
      prompt: "PROMPT_DIAGNOSTIC_CANARY_04",
      privatePath: String.raw`C:\Users\Private User\hunter\source\secret.ts`,
    };
    const input = {
      generatedAt: "2026-07-24T13:00:00.000Z",
      hunterVersion: "0.0.0",
      host: {
        platform: "win32",
        architecture: "x64",
        nodeVersion: "24.18.0",
      },
      sources: [
        {
          kind: "database" as const,
          count: 4,
          errorCodes: ["STORAGE_HEALTH_FAILED"],
          summary: {
            health: "failed" as const,
            tableCount: 12,
            detail:
              `Authorization: Bearer ${canaries.token} at ${canaries.privatePath}`,
          },
        },
        {
          kind: "logs" as const,
          count: 2,
          errorCodes: ["RUNTIME_OBSERVATION_INVALID"],
          summary: {
            health: "degraded" as const,
            eventCount: 2,
            detail: `Cookie: ${canaries.cookie}`,
          },
        },
        {
          kind: "exports" as const,
          count: 1,
          errorCodes: [],
          summary: {
            health: "healthy" as const,
            artifactCount: 1,
            detail: `HUNTER_API_KEY=${canaries.apiKey}`,
          },
        },
        {
          kind: "prompts" as const,
          count: 1,
          errorCodes: ["PROMPT_REJECTED"],
          summary: {
            health: "failed" as const,
            promptCount: 1,
          },
        },
      ],
      redaction: {
        registeredSecrets: Object.values(canaries),
        privatePathRoots: [String.raw`C:\Users\Private User`],
      },
    };

    const first = createDiagnosticBundle(input);
    const second = createDiagnosticBundle({
      ...input,
      sources: [...input.sources].reverse(),
    });
    const serialized = new TextDecoder().decode(first.bytes);
    const parsed = DiagnosticBundleSchema.parse(JSON.parse(serialized));

    expect(first.bytes).toEqual(second.bytes);
    expect(parsed.excludedByDefault).toEqual([
      "credentials",
      "environment",
      "raw_agent_events",
      "source_code",
      "sqlite",
    ]);
    expect(parsed.sources.map(({ kind }) => kind)).toEqual([
      "database",
      "logs",
      "exports",
      "prompts",
    ]);
    expect(parsed.redaction).toMatchObject({
      applied: true,
      schemaVersion: 1,
    });
    expect(parsed.contentFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    for (const canary of Object.values(canaries)) {
      expect(serialized).not.toContain(canary);
    }
    expect(() => assertNoSensitiveMaterial(
      first.bytes,
      Object.values(canaries),
    )).not.toThrow();
  });

  it("rejects non-allowlisted source fields and unbounded error codes", () => {
    const base = {
      generatedAt: "2026-07-24T13:00:00.000Z",
      hunterVersion: "0.0.0",
      host: {
        platform: "win32",
        architecture: "x64",
        nodeVersion: "24.18.0",
      },
      redaction: {},
    };

    expect(() => createDiagnosticBundle({
      ...base,
      sources: [{
        kind: "database",
        count: 1,
        errorCodes: [],
        summary: {
          health: "healthy",
          tableCount: 1,
          environment: { HUNTER_SECRET: "must-not-be-accepted" },
        },
      }],
    })).toThrow();
    expect(() => createDiagnosticBundle({
      ...base,
      sources: [{
        kind: "logs",
        count: 1,
        errorCodes: Array.from(
          { length: 65 },
          () => "RUNTIME_OBSERVATION_INVALID",
        ),
        summary: {
          health: "healthy",
          eventCount: 1,
        },
      }],
    })).toThrow();
    expect(() => createDiagnosticBundle({
      ...base,
      hunterVersion: "token-shaped-private-label",
      sources: [{
        kind: "database",
        count: 1,
        errorCodes: ["UNRECOGNIZED_SECRET_SHAPED_CODE"],
        summary: {
          health: "healthy",
          tableCount: 1,
        },
      }],
    })).toThrow();
    expect(() => createDiagnosticBundle({
      ...base,
      hunterVersion: `${"1".repeat(65)}.0.0`,
      host: {
        ...base.host,
        nodeVersion: `${"1".repeat(33)}.0.0`,
      },
      sources: [{
        kind: "database",
        count: 1,
        errorCodes: [],
        summary: {
          health: "healthy",
          tableCount: 1,
        },
      }],
    })).toThrow();
    expect(() => createDiagnosticBundle({
      ...base,
      generatedAt: `2026-07-24T13:00:00.${"1".repeat(100)}Z`,
      sources: [{
        kind: "database",
        count: 1,
        errorCodes: [],
        summary: {
          health: "healthy",
          tableCount: 1,
        },
      }],
    })).toThrow();
    expect(() => createDiagnosticBundle({
      ...base,
      sources: [{
        kind: "prompts",
        count: 1,
        errorCodes: ["PROMPT_REJECTED"],
        summary: {
          health: "failed",
          promptCount: 1,
          detail: "UNREGISTERED_PRIVATE_PROMPT_TEXT",
        },
      }],
    })).toThrow();
  });

  it("validates output summary kinds and error-code bounds", () => {
    const valid = createDiagnosticBundle({
      generatedAt: "2026-07-24T13:00:00.000Z",
      hunterVersion: "0.0.0",
      host: {
        platform: "win32",
        architecture: "x64",
        nodeVersion: "24.18.0",
      },
      sources: [{
        kind: "database",
        count: 1,
        errorCodes: [],
        summary: {
          health: "healthy",
          tableCount: 1,
        },
      }],
    }).manifest;
    const source = valid.sources[0];
    if (source === undefined) throw new Error("TEST_SOURCE_MISSING");

    expect(() => DiagnosticBundleSchema.parse({
      ...valid,
      sources: [{
        ...source,
        errorCodes: Array.from(
          { length: 65 },
          () => "STORAGE_HEALTH_FAILED",
        ),
      }],
    })).toThrow();
    expect(() => DiagnosticBundleSchema.parse({
      ...valid,
      sources: [{
        ...source,
        redactedSummary: {
          health: "healthy",
          eventCount: 1,
        },
      }],
    })).toThrow();
  });
});
