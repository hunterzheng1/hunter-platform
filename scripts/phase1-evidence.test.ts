import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Phase1BuildIdentitySchema,
  Phase1FailureEnvelopeSchema,
} from "@hunter/testkit";
import { describe, expect, it } from "vitest";

import {
  phase1BuildIdentity,
  preparePhase1EvidenceOutput,
  renamePhase1FileWithRetry,
  safePhase1ErrorCode,
  writePhase1JsonAtomic,
} from "./phase1-evidence.js";

describe("Phase 1 evidence I/O", () => {
  it("identifies the exact local source state without recording paths", () => {
    const identity = phase1BuildIdentity();

    expect(Phase1BuildIdentitySchema.parse(identity)).toEqual(identity);
    expect(JSON.stringify(identity)).not.toMatch(
      /(?:[A-Z]:\\|\/(?:home|Users|tmp)\/|token|cookie)/iu,
    );
  });

  it("maps known failures and rejects arbitrary path or credential text", () => {
    expect(safePhase1ErrorCode(new Error("SQLITE_FULL"))).toBe("SQLITE_FULL");
    expect(
      safePhase1ErrorCode(new Error("SOAK_RESUME_CHECKPOINT_INVALID")),
    ).toBe("SOAK_RESUME_CHECKPOINT_INVALID");
    expect(
      safePhase1ErrorCode(
        new Error("token=secret C:\\Users\\private\\workspace"),
      ),
    ).toBe("UNKNOWN_PHASE1_FAILURE");
  });

  it("archives every prior envelope before publishing a new latest result", () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-phase1-evidence-"));
    const target = join(root, "performance.json");
    const first = Phase1FailureEnvelopeSchema.parse({
      schemaVersion: 1,
      proofScope: "contract_only",
      build: {
        productVersion: "0.0.0",
        baseRevision: "1".repeat(40),
        sourceDigest: "2".repeat(64),
      },
      command: "benchmark",
      status: "FAIL",
      observedAt: "2026-07-25T00:00:00.000Z",
      errorCode: "PHASE1_BENCHMARK_FAILED",
    });
    try {
      writePhase1JsonAtomic(target, first);
      preparePhase1EvidenceOutput(target);

      expect(existsSync(target)).toBe(false);
      const archived = readdirSync(join(root, "performance.attempts"));
      expect(archived).toHaveLength(1);
      expect(
        JSON.parse(
          readFileSync(
            join(root, "performance.attempts", archived[0] ?? ""),
            "utf8",
          ),
        ),
      ).toEqual(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries transient Windows rename failures and fails closed after the bound", () => {
    let attempts = 0;
    renamePhase1FileWithRetry("source.tmp", "target.json", {
      maxAttempts: 3,
      rename() {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("transient lock"), { code: "EPERM" });
        }
      },
      wait: () => undefined,
    });
    expect(attempts).toBe(3);

    expect(() =>
      renamePhase1FileWithRetry("source.tmp", "target.json", {
        maxAttempts: 2,
        rename() {
          throw Object.assign(new Error("still locked"), { code: "EBUSY" });
        },
        wait: () => undefined,
      }),
    ).toThrow("PHASE1_EVIDENCE_RENAME_FAILED");
  });
});
