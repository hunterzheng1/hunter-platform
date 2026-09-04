// Batch 1 冒烟辅助：构造一个最小合法归档 ZIP（与 change-archive-package-api.test.ts
// 的 archiveZip 同构），供 harness CLI `archive upload` 对本地平台实例测试。
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";

const changeKey = process.argv[2] ?? "smoke-batch1-deadcode";
const outPath = process.argv[3] ?? "smoke-archive.zip";

const sha256Bytes = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const files = [
  {
    path: "reports/final/summary-data.json",
    role: "summary",
    content: JSON.stringify({
      schemaVersion: "2.3",
      changeName: changeKey,
      businessGoal: "Batch 1 dead-code deletion smoke test",
      finalStatus: "OK",
      finalCommit: "0123456789abcdef",
      stageStatus: { plan: "OK", run: "OK", test: "OK", review: "OK", submit: "OK", archive: "OK" },
      verification: {
        unitTests: { passed: 1, failed: 0 },
        apiTests: { passed: 1, failed: 0 },
        dbCompatibility: "ok",
        coverageDisplay: "n/a"
      },
      changedFiles: [],
      artifacts: [],
      archiveManifest: { movedFiles: 0, generatedFiles: 0, totalArchiveFiles: 3, checksumStatus: "ok" },
      reportPipeline: {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        event_count: 0,
        sources: [],
        phases: {},
        commands: [],
        verificationChecks: [],
        artifacts: [],
        validationIssues: [],
        sourceConsistency: { ok: true, issues: [] }
      }
    })
  },
  {
    path: "spec/smoke-notes.md",
    role: "spec",
    content: "# smoke\n\nBatch 1 archive upload smoke test.\n"
  }
];

const zip = new AdmZip();
const declared = files.map((file) => {
  const bytes = Buffer.from(file.content, "utf8");
  zip.addFile(file.path, bytes);
  return {
    path: file.path,
    role: file.role,
    media_type: file.path.endsWith(".json") ? "application/json" : "text/markdown",
    content_sha256: sha256Bytes(bytes),
    size_bytes: bytes.byteLength
  };
});
zip.addFile("archive-manifest.json", Buffer.from(JSON.stringify({
  schema_version: 1,
  profile: "core-v1",
  change_key: changeKey,
  created_at: new Date().toISOString(),
  source: { commit: "0123456789abcdef", tree: null },
  files: declared
}), "utf8"));

import { writeFile } from "node:fs/promises";
await writeFile(outPath, zip.toBuffer());
console.log(`wrote ${outPath} (change=${changeKey}, files=${declared.length + 1}, idem=${randomUUID()})`);
