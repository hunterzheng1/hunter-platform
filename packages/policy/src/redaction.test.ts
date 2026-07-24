import { describe, expect, it } from "vitest";

import {
  assertNoSensitiveMaterial,
  redactDiagnosticValue,
  type DiagnosticRedactionOptions,
} from "./redaction.js";

describe("diagnostic redaction", () => {
  it("removes registered and common credential, path, and Prompt canaries", () => {
    const canaries = {
      token: "tok_canary_4F0A2E7C",
      cookie: "hunter_session=cookie_canary_9B11",
      apiKey: "api_key_canary_7D52",
      prompt: "PROMPT_CANARY_DO_NOT_EXPORT_81AC",
      privatePath: String.raw`C:\Users\Private User\hunter\secret-prompt.md`,
    };

    const result = redactDiagnosticValue({
      authorization: `Bearer ${canaries.token}`,
      cookie: canaries.cookie,
      providerApiKey: canaries.apiKey,
      prompt: canaries.prompt,
      workspacePath: canaries.privatePath,
      nested: {
        message: `Authorization: Bearer ${canaries.token}`,
      },
    }, {
      registeredSecrets: [
        canaries.token,
        canaries.cookie,
        canaries.apiKey,
        canaries.prompt,
      ],
      privatePathRoots: [String.raw`C:\Users\Private User`],
    });
    const serialized = JSON.stringify(result);

    expect(result.schemaVersion).toBe(1);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[PRIVATE_PATH]");
    expect(result.replacements.total).toBeGreaterThanOrEqual(6);
    for (const canary of Object.values(canaries)) {
      expect(serialized).not.toContain(canary);
    }
    expect(() => assertNoSensitiveMaterial(
      serialized,
      Object.values(canaries),
    )).not.toThrow();
  });

  it.each([
    {
      label: "an unknown object prototype",
      value: new Date("2026-07-24T00:00:00.000Z"),
      options: {},
      code: "REDACTION_UNKNOWN_OBJECT",
    },
    {
      label: "binary bytes",
      value: new Uint8Array([1, 2, 3]),
      options: {},
      code: "REDACTION_BINARY_FORBIDDEN",
    },
    {
      label: "an oversized string",
      value: "x".repeat(33),
      options: { maxStringBytes: 32 },
      code: "REDACTION_STRING_LIMIT_EXCEEDED",
    },
    {
      label: "an oversized collection",
      value: [1, 2, 3],
      options: { maxCollectionItems: 2 },
      code: "REDACTION_COLLECTION_LIMIT_EXCEEDED",
    },
    {
      label: "an aggregate node budget breach",
      value: { first: [1, 2], second: true },
      options: { maxTotalNodes: 4 },
      code: "REDACTION_TOTAL_NODE_LIMIT_EXCEEDED",
    },
    {
      label: "an aggregate byte budget breach",
      value: { first: "1234", second: "5678" },
      options: { maxTotalBytes: 7 },
      code: "REDACTION_TOTAL_BYTE_LIMIT_EXCEEDED",
    },
  ])("fails closed for $label", ({ value, options, code }) => {
    expect(() => redactDiagnosticValue(value, options)).toThrow(code);
  });

  it("bounds registered Secret and private path option collections", () => {
    expect(() => redactDiagnosticValue(null, {
      registeredSecrets: Array.from({ length: 257 }, (_, index) =>
        `secret-${index}`
      ),
    })).toThrow("REDACTION_OPTIONS_LIMIT_EXCEEDED");
    expect(() => redactDiagnosticValue(null, {
      privatePathRoots: Array.from({ length: 65 }, (_, index) =>
        String.raw`D:\private-${index}`
      ),
    })).toThrow("REDACTION_OPTIONS_LIMIT_EXCEEDED");
  });

  it.each([
    "maxDepth",
    "maxStringBytes",
    "maxCollectionItems",
    "maxTotalNodes",
    "maxTotalBytes",
  ] as const)("does not allow callers to raise the hard %s cap", (limit) => {
    const options = {
      [limit]: Number.MAX_SAFE_INTEGER,
    } satisfies DiagnosticRedactionOptions;

    expect(() => redactDiagnosticValue(null, options)).toThrow(
      "REDACTION_OPTIONS_LIMIT_EXCEEDED",
    );
  });

  it("bounds explicit canaries supplied to the byte scanner", () => {
    expect(() => assertNoSensitiveMaterial(
      "{}",
      Array.from({ length: 257 }, (_, index) => `canary-${index}`),
    )).toThrow("DIAGNOSTIC_SCAN_INPUT_LIMIT_EXCEEDED");
  });

  it("bounds the byte scanner input before decoding or normalization", () => {
    expect(() => assertNoSensitiveMaterial(
      "x".repeat(2 * 1024 * 1024 + 1),
    )).toThrow("DIAGNOSTIC_SCAN_INPUT_LIMIT_EXCEEDED");
  });

  it("fails closed for cyclic input", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => redactDiagnosticValue(cyclic)).toThrow(
      "REDACTION_CIRCULAR_REFERENCE",
    );
  });

  it("fails closed without evaluating accessors or ignoring symbol keys", () => {
    const accessor = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get() {
        throw new Error("ACCESSOR_MUST_NOT_RUN");
      },
    });
    const symbolKeyed = {
      [Symbol("secret")]: "hidden",
    };

    expect(() => redactDiagnosticValue(accessor)).toThrow(
      "REDACTION_ACCESSOR_FORBIDDEN",
    );
    expect(() => redactDiagnosticValue(symbolKeyed)).toThrow(
      "REDACTION_SYMBOL_KEY_FORBIDDEN",
    );
  });

  it("fails closed when a registered Secret or private path appears as a key", () => {
    const secret = "secret-key-canary";
    const privatePath = String.raw`D:\Private Root`;

    expect(() => redactDiagnosticValue({
      [secret]: "value",
    }, {
      registeredSecrets: [secret],
    })).toThrow("REDACTION_SENSITIVE_KEY_FORBIDDEN");
    expect(() => redactDiagnosticValue({
      [privatePath]: "value",
    }, {
      privatePathRoots: [privatePath],
    })).toThrow("REDACTION_SENSITIVE_KEY_FORBIDDEN");
  });

  it("redacts unregistered Windows, UNC, and Unix absolute paths", () => {
    const paths = [
      String.raw`D:\Company Private\repo\source.ts`,
      "C:/Users/Private User/repo/source.ts",
      String.raw`\\server\private-share\artifact.log`,
      "/srv/hunter/private/source.ts",
      "/secret",
    ];
    const result = redactDiagnosticValue({
      message: paths.join(" | "),
    });
    const serialized = JSON.stringify(result);

    expect(result.replacements.path).toBe(5);
    expect(serialized.match(/\[PRIVATE_PATH\]/gu)).toHaveLength(5);
    for (const path of paths) expect(serialized).not.toContain(path);
    expect(() => assertNoSensitiveMaterial(serialized, paths)).not.toThrow();
  });

  it("redacts credential fields embedded in structured log strings", () => {
    const values = [
      "Bearer unregistered-auth-token",
      "session=unregistered-cookie",
      "unregistered-api-key",
      "unregistered-provider-api-key",
      "unregistered-header-api-key",
      "session=unregistered-set-cookie",
    ];
    const result = redactDiagnosticValue({
      detail: JSON.stringify({
        authorization: values[0],
        cookie: values[1],
        apiKey: values[2],
        providerApiKey: values[3],
        "x-api-key": values[4],
        "set-cookie": values[5],
      }),
    });
    const serialized = JSON.stringify(result);

    for (const value of values) expect(serialized).not.toContain(value);
    expect(() => assertNoSensitiveMaterial(serialized, values)).not.toThrow();
  });
});
