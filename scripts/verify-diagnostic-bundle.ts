import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DiagnosticBundleSchema,
  createDiagnosticBundle,
} from "../apps/daemon/src/services/diagnostic-bundle.js";
import {
  assertNoSensitiveMaterial,
  redactDiagnosticValue,
} from "../packages/policy/src/index.js";

const root = mkdtempSync(join(tmpdir(), "hunter-diagnostic-verification-"));
const outputRoot = join(root, "outputs");
mkdirSync(outputRoot);

const canaries = {
  token: "tok_verify_diagnostic_01",
  cookie: "hunter_session=verify_diagnostic_02",
  apiKey: "verify_diagnostic_api_key_03",
  prompt: "PROMPT_VERIFY_DIAGNOSTIC_04",
  privatePath: String.raw`C:\Users\Private User\hunter\private\source.ts`,
};
const canaryValues = Object.values(canaries);
const redaction = {
  registeredSecrets: canaryValues,
  privatePathRoots: [String.raw`C:\Users\Private User`],
};
const sources = [
  {
    kind: "database" as const,
    count: 2,
    errorCodes: ["STORAGE_HEALTH_FAILED"],
    summary: {
      health: "failed" as const,
      tableCount: 2,
      detail:
        `Authorization: Bearer ${canaries.token} at ${canaries.privatePath}`,
    },
  },
  {
    kind: "logs" as const,
    count: 3,
    errorCodes: ["RUNTIME_OBSERVATION_INVALID"],
    summary: {
      health: "degraded" as const,
      eventCount: 3,
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
];

try {
  let unregisteredPromptRejected = false;
  try {
    createDiagnosticBundle({
      generatedAt: "2026-07-24T13:00:00.000Z",
      hunterVersion: "0.0.0",
      host: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.versions.node,
      },
      sources: [{
        kind: "prompts",
        count: 1,
        errorCodes: ["PROMPT_REJECTED"],
        summary: {
          health: "failed",
          promptCount: 1,
          detail: canaries.prompt,
        },
      }],
      redaction: {
        registeredSecrets: canaryValues.filter(
          (value) => value !== canaries.prompt,
        ),
      },
    });
  } catch {
    unregisteredPromptRejected = true;
  }
  if (!unregisteredPromptRejected) {
    throw new Error("DIAGNOSTIC_UNREGISTERED_PROMPT_NOT_REJECTED");
  }

  const outputPaths: string[] = [];
  for (const source of sources) {
    const result = redactDiagnosticValue(source.summary, redaction);
    const path = join(outputRoot, `${source.kind}-summary.json`);
    writeFileSync(path, `${JSON.stringify(result)}\n`, "utf8");
    outputPaths.push(path);
  }
  const bundle = createDiagnosticBundle({
    generatedAt: "2026-07-24T13:00:00.000Z",
    hunterVersion: "0.0.0",
    host: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.versions.node,
    },
    sources,
    redaction,
  });
  const bundlePath = join(outputRoot, "diagnostic-bundle.json");
  writeFileSync(bundlePath, bundle.bytes);
  outputPaths.push(bundlePath);

  for (const outputPath of outputPaths) {
    assertNoSensitiveMaterial(readFileSync(outputPath), canaryValues);
  }
  const parsed = DiagnosticBundleSchema.parse(
    JSON.parse(readFileSync(bundlePath, "utf8")) as unknown,
  );
  if (
    parsed.excludedByDefault.join(",")
      !== "credentials,environment,raw_agent_events,source_code,sqlite"
  ) {
    throw new Error("DIAGNOSTIC_DEFAULT_EXCLUSIONS_INVALID");
  }

  console.log(JSON.stringify({
    status: "PASS",
    schemaVersion: parsed.schemaVersion,
    sourceCount: parsed.sources.length,
    scannedOutputCount: outputPaths.length,
    byteCount: bundle.bytes.byteLength,
    contentFingerprint: parsed.contentFingerprint,
    redaction: {
      schemaVersion: parsed.redaction.schemaVersion,
      replacementCount: parsed.redaction.replacements.total,
    },
    excludedByDefault: parsed.excludedByDefault,
  }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
