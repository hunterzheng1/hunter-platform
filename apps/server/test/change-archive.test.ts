import { describe, expect, it } from "vitest";

import {
  buildChangeArchive,
  deriveArchiveKind,
  deriveArchiveTier,
  resolveArchiveContentPath
} from "../src/archive/change-archive.js";

describe("change archive mapping (S3)", () => {
  it("filters project files under the change archive prefix", () => {
    const archive = buildChangeArchive({
      changeKey: "auth-change",
      files: [
        {
          path: ".harness/archive/auth-change/reports/final/summary-data.json",
          sizeBytes: 100,
          updatedAt: "2026-08-01T00:00:00Z"
        },
        {
          path: ".harness/archive/other/reports/final/summary-data.json",
          sizeBytes: 50,
          updatedAt: "2026-08-01T00:00:00Z"
        },
        {
          path: ".harness/archive/auth-change/spec/auth-change-design.md",
          sizeBytes: 200,
          updatedAt: "2026-08-02T00:00:00Z"
        }
      ]
    });
    expect(archive.files).toHaveLength(2);
    expect(archive.archivedAt).toBe("2026-08-02T00:00:00Z");
    expect(archive.files[0]?.kind).toBe("report");
    expect(archive.files[1]?.kind).toBe("design");
  });

  it("derives kind/tier from relative paths", () => {
    expect(deriveArchiveKind("plans/x-plan.md")).toBe("plan");
    expect(deriveArchiveTier("reports/final/summary-data.json", "report")).toBe("core");
    expect(deriveArchiveTier("reports/review/findings.json", "report")).toBe("supporting");
    expect(deriveArchiveTier("events.ndjson", "log")).toBe("diagnostic");
  });

  it("rejects path traversal for content reads", () => {
    expect(() => resolveArchiveContentPath("auth-change", "../secret")).toThrow();
    expect(resolveArchiveContentPath("auth-change", "reports/final/summary-data.json"))
      .toBe(".harness/archive/auth-change/reports/final/summary-data.json");
  });
});
