import { createHash } from "node:crypto";

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";

import { KnowledgePipelineError } from "../src/knowledge-pipeline/errors.js";
import { validateCoreV1ArchivePackage } from "../src/knowledge-pipeline/index.js";

/**
 * The production archiver (harness/scripts/harness_archive.py) emits a core-v1
 * package. Before this seam existed the knowledge queue's v2 validator rejected
 * it at the first gate, the enqueue in app.ts swallowed the error as a warning,
 * and no change-projection or extraction job was ever created — which is why
 * knowledge_pipeline_change_documents and _results were empty in production.
 *
 * Identity (project_id / archive_id / project_version) is supplied by the route,
 * not read from the manifest: a client cannot know server-minted ids, and making
 * it invent them would fabricate provenance.
 */

const IDENTITY = {
  project_id: "prj_core_v1",
  change_key: "usage-stats-cli-reporting",
  archive_id: "arc_core_v1",
  project_version: "pv_core_v1"
};

const LIMITS = {
  max_package_bytes: 50_000_000,
  max_file_count: 501,
  max_file_bytes: 10_000_000,
  max_uncompressed_bytes: 50_000_000,
  max_compression_ratio: 100
};

const CANDIDATES = [
  {
    schema_version: 1,
    candidate_id: "kc_3f66a23f5838a9fcd2f39f17152298e6",
    source_change_key: IDENTITY.change_key,
    // Repository provenance, not a package path: the spec wants findings to stay
    // locatable in the codebase (path + line), which is the point of the entry.
    source_refs: ["packages/contracts/src/content-sync.ts#L1051"],
    summary: "nonScannablePathPrefixes rejects the whole archive tree",
    reusability_scope: "packages",
    content_hash: `sha256:${"a".repeat(64)}`,
    confidence: 0.95,
    status: "pending",
    entry_type: "pitfall",
    body: "nonScannablePathPrefixes rejects the whole archive tree",
    keywords: ["content-sync.ts", "RED", "FIXED"],
    provenance: {
      source_kind: "review",
      source_ref: `archive:${IDENTITY.change_key}#F-001`,
      producer: "harness-archive",
      producer_version: "2.3",
      created_at: "2026-08-18T12:00:00.000Z"
    }
  }
];

type Spec = { path: string; role: string; media: string; body: string };

function productionFiles(overrides: Spec[] = []): Spec[] {
  const base: Spec[] = [
    { path: "archive-meta.md", role: "archive_meta", media: "text/markdown", body: "# meta\n" },
    { path: "candidates/knowledge.json", role: "knowledge_candidates", media: "application/json", body: `${JSON.stringify(CANDIDATES)}\n` },
    { path: "change-context.json", role: "change_context", media: "application/json", body: "{}\n" },
    { path: "plans/plan.md", role: "plan", media: "text/markdown", body: "# plan\n" },
    { path: "reports/final/summary-data.json", role: "summary", media: "application/json", body: '{"changeName":"usage-stats-cli-reporting"}\n' },
    { path: "spec/design.md", role: "spec", media: "text/markdown", body: "# design\n" }
  ];
  return [...base.filter((file) => !overrides.some((o) => o.path === file.path)), ...overrides]
    .sort((left, right) => (left.path < right.path ? -1 : 1));
}

/** Manifest shape copied verbatim from harness_archive.py's `manifest = {...}`. */
function build(files: Spec[]): { bytes: Uint8Array; manifest: Uint8Array } {
  const manifest = {
    schema_version: 1,
    profile: "core-v1",
    change_key: IDENTITY.change_key,
    created_at: "2026-08-18T00:00:00.000Z",
    source: { commit: "a".repeat(40), tree: "b".repeat(40) },
    files: files.map((file) => ({
      path: file.path,
      role: file.role,
      media_type: file.media,
      content_sha256: `sha256:${createHash("sha256").update(Buffer.from(file.body, "utf8")).digest("hex")}`,
      size_bytes: Buffer.byteLength(file.body, "utf8")
    }))
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  const zip = new AdmZip();
  zip.addFile("archive-manifest.json", manifestBytes);
  for (const file of files) zip.addFile(file.path, Buffer.from(file.body, "utf8"));
  return { bytes: new Uint8Array(zip.toBuffer()), manifest: new Uint8Array(manifestBytes) };
}

function validate(files: Spec[], identity = IDENTITY) {
  const pkg = build(files);
  return validateCoreV1ArchivePackage({
    package_bytes: pkg.bytes,
    manifest_bytes: pkg.manifest,
    identity,
    limits: LIMITS,
    validated_at: "2026-08-18T12:00:00.000Z"
  });
}

/** Force a raw entry name into the ZIP, bypassing the helper's normalisation. */
function scanUnsafe(rawPath: string) {
  const pkg = build(productionFiles());
  const zip = new AdmZip(Buffer.from(pkg.bytes));
  zip.addFile("placeholder", Buffer.from("x", "utf8"));
  const entry = zip.getEntry("placeholder");
  if (entry !== null) entry.entryName = rawPath;
  return validateCoreV1ArchivePackage({
    package_bytes: new Uint8Array(zip.toBuffer()),
    manifest_bytes: pkg.manifest,
    identity: IDENTITY,
    limits: LIMITS,
    validated_at: "2026-08-18T12:00:00.000Z"
  });
}

function reasonCode(run: () => unknown): string {
  try {
    run();
    return "ACCEPTED";
  } catch (error) {
    if (error instanceof KnowledgePipelineError) return error.reason_code;
    throw error;
  }
}

describe("core-v1 archive package validation", () => {
  it("accepts the package the production archiver actually produces", () => {
    const validated = validate(productionFiles());

    expect(validated.project_id).toBe(IDENTITY.project_id);
    expect(validated.change_key).toBe(IDENTITY.change_key);
    expect(validated.archive_id).toBe(IDENTITY.archive_id);
    expect(validated.project_version).toBe(IDENTITY.project_version);
    expect(validated.knowledge_candidates).toHaveLength(1);
    expect(validated.knowledge_candidates[0]?.entry_type).toBe("pitfall");
    // core-v1 has no project-content candidate file at all.
    expect(validated.project_content_candidates).toEqual([]);
    expect(validated.validation_receipt.declared_files_verified).toBe(true);
    expect(validated.validation_receipt.content_hashes_verified).toBe(true);
    expect(validated.validation_receipt.candidate_sources_bound).toBe(true);
  });

  it("accepts an archive built before the candidate generator existed", () => {
    const withoutCandidates = productionFiles()
      .filter((file) => file.path !== "candidates/knowledge.json");
    const validated = validate(withoutCandidates);
    expect(validated.knowledge_candidates).toEqual([]);
  });

  it("keeps every structural safety check the v2 validator enforces", () => {
    // undeclared file
    const pkg = build(productionFiles());
    const zip = new AdmZip(Buffer.from(pkg.bytes));
    zip.addFile("spec/sneaked.md", Buffer.from("# sneaked\n", "utf8"));
    expect(reasonCode(() => validateCoreV1ArchivePackage({
      package_bytes: new Uint8Array(zip.toBuffer()),
      manifest_bytes: pkg.manifest,
      identity: IDENTITY,
      limits: LIMITS,
      validated_at: "2026-08-18T12:00:00.000Z"
    }))).toBe("ARCHIVE_UNDECLARED_FILE");

    // content that does not match its declared hash
    const tampered = build(productionFiles());
    const tamperedZip = new AdmZip(Buffer.from(tampered.bytes));
    tamperedZip.updateFile("spec/design.md", Buffer.from("# tampered\n", "utf8"));
    expect(reasonCode(() => validateCoreV1ArchivePackage({
      package_bytes: new Uint8Array(tamperedZip.toBuffer()),
      manifest_bytes: tampered.manifest,
      identity: IDENTITY,
      limits: LIMITS,
      validated_at: "2026-08-18T12:00:00.000Z"
    }))).toBe("ARCHIVE_MANIFEST_CONTENT_MISMATCH");

    // path outside the core-v1 allowlist
    expect(reasonCode(() => validate(productionFiles([
      { path: "state/runtime.json", role: "change_context", media: "application/json", body: "{}\n" }
    ])))).toBe("ARCHIVE_CORE_PATH_FORBIDDEN");

    // traversal — rejected either as unsafe or as off-allowlist depending on
    // whether the ZIP writer normalised the name first; what matters is that it
    // never reaches the pipeline.
    expect(["ARCHIVE_PATH_UNSAFE", "ARCHIVE_CORE_PATH_FORBIDDEN"]).toContain(
      reasonCode(() => validate(productionFiles([
        { path: "spec/../../escape.md", role: "spec", media: "text/markdown", body: "# x\n" }
      ])))
    );
    // a path that survives ZIP normalisation with traversal intact
    expect(reasonCode(() => scanUnsafe("spec/../secret.md"))).toBe("ARCHIVE_PATH_UNSAFE");
  });

  it("rejects a manifest that is not the core-v1 profile", () => {
    const pkg = build(productionFiles());
    const v2Manifest = Buffer.from(`${JSON.stringify({
      schema_version: 2, project_id: "prj_x", change_key: IDENTITY.change_key,
      archive_id: "arc_x", project_version: "pv_x", package_schema_version: 2,
      archive_schema_version: 2, file_count: 0, files: []
    })}\n`, "utf8");
    expect(reasonCode(() => validateCoreV1ArchivePackage({
      package_bytes: pkg.bytes,
      manifest_bytes: new Uint8Array(v2Manifest),
      identity: IDENTITY,
      limits: LIMITS,
      validated_at: "2026-08-18T12:00:00.000Z"
    }))).toBe("ARCHIVE_MANIFEST_MISMATCH");
  });

  it("refuses candidates bound to a different change", () => {
    const foreign = [{ ...CANDIDATES[0], source_change_key: "some-other-change" }];
    expect(reasonCode(() => validate(productionFiles([{
      path: "candidates/knowledge.json",
      role: "knowledge_candidates",
      media: "application/json",
      body: `${JSON.stringify(foreign)}\n`
    }])))).toBe("ARCHIVE_CANDIDATE_SOURCE_UNBOUND");
  });

  it("refuses candidate source refs that escape the repository", () => {
    for (const reference of ["../../etc/passwd", "/etc/passwd", "C:\\secrets.txt"]) {
      const escaping = [{ ...CANDIDATES[0], source_refs: [reference] }];
      expect(reasonCode(() => validate(productionFiles([{
        path: "candidates/knowledge.json",
        role: "knowledge_candidates",
        media: "application/json",
        body: `${JSON.stringify(escaping)}\n`
      }]))), reference).toBe("ARCHIVE_CANDIDATE_SOURCE_UNBOUND");
    }
  });

  it("rejects a manifest that disagrees with the route's change key", () => {
    expect(reasonCode(() => validate(productionFiles(), {
      ...IDENTITY,
      change_key: "a-different-change"
    }))).toBe("ARCHIVE_MANIFEST_IDENTITY_MISMATCH");
  });

  it("rejects malformed identity rather than filing jobs under a bogus project", () => {
    for (const identity of [
      { ...IDENTITY, project_id: "" },
      { ...IDENTITY, archive_id: "" },
      { ...IDENTITY, project_version: "" }
    ]) {
      expect(reasonCode(() => validate(productionFiles(), identity)))
        .toBe("ARCHIVE_IDENTITY_INVALID");
    }
  });
});
