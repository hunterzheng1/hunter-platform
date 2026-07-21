import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertProbeWorkspace,
  createEvidenceEnvelope,
  redact,
  withTemporaryGitFixture,
} from "./index.js";

describe("phase 0 evidence", () => {
  it("redacts credentials and absolute private paths", () => {
    const input = [
      "Authorization: Bearer abc123",
      "CODEBUDDY_API_KEY=secret",
      "Cookie: session=private",
      "C:\\Users\\hunter\\repo\\file.ts",
      "/home/hunter/repo/file.ts",
    ].join("\n");

    const output = redact(input);

    expect(output).not.toContain("abc123");
    expect(output).not.toContain("secret");
    expect(output).not.toContain("private");
    expect(output).not.toContain("hunter\\repo");
    expect(output).not.toContain("/home/hunter");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("[PRIVATE_PATH]");
  });

  it("creates a strict versioned envelope with a stable content fingerprint", () => {
    const input = {
      evidenceType: "phase0_environment_inventory" as const,
      generatedAt: "2026-07-21T00:00:00.000Z",
      host: { platform: "win32", architecture: "x64", release: "10.0" },
      probes: [],
    };

    const first = createEvidenceEnvelope(input);
    const second = createEvidenceEnvelope({
      ...input,
      generatedAt: "2026-07-21T01:00:00.000Z",
    });

    expect(first.schemaVersion).toBe(1);
    expect(first.redaction).toEqual({ applied: true, schemaVersion: 1 });
    expect(first.contentFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.contentFingerprint).toBe(second.contentFingerprint);
  });

  it("rejects repository mutations outside a generated fixture", () => {
    expect(() =>
      assertProbeWorkspace({
        mutation: "repository",
        cwd: "C:\\source\\hunter-platform",
      }),
    ).toThrowError("MUTATING_PROBE_REQUIRES_TEMP_GIT_FIXTURE");
  });

  it("creates and cleans an isolated temporary Git fixture", async () => {
    let fixturePath = "";

    await withTemporaryGitFixture(async (fixture) => {
      fixturePath = fixture.path;
      assertProbeWorkspace({ mutation: "repository", cwd: fixture.path, fixture });
      await access(join(fixture.path, ".git"));
      expect(await readFile(join(fixture.path, "README.md"), "utf8")).toContain(
        "Hunter Phase 0 fixture",
      );
      expect(fixture.baselineCommit).toMatch(/^[a-f0-9]{40,64}$/u);
    });

    await expect(access(fixturePath)).rejects.toThrow();
  });
});
