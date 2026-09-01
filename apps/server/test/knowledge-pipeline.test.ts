import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import {
  archiveIngestReceiptSchema,
  classifyContentPath,
  getLegacyArchiveCompatibilityResult,
  type KnowledgeCandidate,
  type ProjectContentCandidate
} from "@hunter-harness/contracts";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";

import {
  MemoryArchiveStore,
  MemoryChangeDocumentIndex,
  MemoryChangeProjectionCommitPort,
  MemoryJobRepository,
  MemoryKnowledgeCommitPort,
  MemoryKnowledgeIndex,
  KnowledgePipelineError,
  archiveUploadIdempotencyKey,
  changeDocumentIdentity,
  changeProjectionInputHash,
  changeProjectionOutputHash,
  createKnowledgePipeline,
  memoryArchiveValidationEvidence,
  validateArchivePackage,
  type AcceptArchiveInput,
  type ChangeDocument,
  type ChangeProjectionJob,
  type KnowledgeResultDraft
} from "../src/knowledge-pipeline/index.js";

const digestHex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const hash = (value: string): string => `sha256:${digestHex(value)}`;
const archiveRequestId = (value: string): string =>
  `archive_request:${digestHex(value)}`;
const now = "2026-08-13T01:00:00.000Z";

function knowledgeCandidate(
  id: string,
  contentHash = hash("c")
): KnowledgeCandidate {
  return {
    schema_version: 1,
    candidate_id: `kc_${id}`,
    source_change_key: `change-${id}`,
    content_hash: contentHash,
    confidence: 0.9,
    provenance: {
      source_kind: "archive",
      source_ref: `arc_${id}`,
      producer: "archive-engine",
      producer_version: "2",
      created_at: now
    },
    source_refs: [`summary/change-summary.json#${id}`],
    summary: `Reusable conclusion ${id}`,
    reusability_scope: "server indexing",
    status: "pending"
  };
}

function projectCandidate(
  id: string,
  candidateType: ProjectContentCandidate["candidate_type"] = "rule"
): ProjectContentCandidate {
  return {
    schema_version: 1,
    candidate_id: `pcc_${id}`,
    source_change_key: `change-${id}`,
    content_hash: hash(`project-${id}`),
    confidence: 0.8,
    provenance: {
      source_kind: "archive",
      source_ref: `arc_${id}`,
      producer: "archive-engine",
      producer_version: "2",
      created_at: now
    },
    candidate_type: candidateType,
    evidence_refs: [`attestations/verification.json#${id}`],
    rationale: `Rationale ${id}`,
    proposed_content: `Proposal ${id}`,
    status: "pending"
  };
}

interface ArchiveInputOverrides {
  request_id?: string;
  project_id?: string;
  change_key?: string;
  archive_id?: string;
  project_version?: string;
  package_schema_version?: number;
  archive_schema_version?: number;
  extractor_version?: string;
  prompt_version?: string;
  index_schema_version?: string;
  knowledge_candidates?: KnowledgeCandidate[];
  project_content_candidates?: ProjectContentCandidate[];
  expected_change_projection?: {
    schema_version: 1;
    status: "queued";
    attempt: 1;
    project_generation?: 1;
    generation?: 1;
  };
}

const defaultLimits = {
  max_package_bytes: 1024 * 1024,
  max_file_count: 16,
  max_file_bytes: 256 * 1024,
  max_uncompressed_bytes: 1024 * 1024,
  max_compression_ratio: 100
};

function rawPackage(id: string, overrides: ArchiveInputOverrides = {}) {
  const projectId = overrides.project_id ?? "prj_06a";
  const changeKey = overrides.change_key ?? `change-${id}`;
  const archiveId = overrides.archive_id ?? `arc_${id}`;
  const bindKnowledge = (overrides.knowledge_candidates ?? [knowledgeCandidate(id)])
    .map((candidate) => ({
      ...candidate,
      source_change_key: changeKey,
      provenance: { ...candidate.provenance, source_ref: archiveId }
    }));
  const bindProjectContent = (
    overrides.project_content_candidates ?? [projectCandidate(id)]
  ).map((candidate) => ({
    ...candidate,
    source_change_key: changeKey,
    provenance: { ...candidate.provenance, source_ref: archiveId }
  }));
  const fileContents = new Map<string, Uint8Array>([
    ["summary/change-summary.json", Buffer.from(JSON.stringify({ summary: id }))],
    ["attestations/verification.json", Buffer.from(JSON.stringify({ verified: true }))],
    ["candidates/knowledge.json", Buffer.from(JSON.stringify(bindKnowledge))],
    ["candidates/project-content.json", Buffer.from(JSON.stringify(bindProjectContent))]
  ]);
  const manifest = {
    schema_version: 2,
    project_id: projectId,
    change_key: changeKey,
    archive_id: archiveId,
    project_version: overrides.project_version ?? `pv_${id}`,
    package_schema_version: overrides.package_schema_version ?? 2,
    archive_schema_version: overrides.archive_schema_version ?? 2,
    file_count: fileContents.size,
    files: [...fileContents.entries()].map(([path, content]) => ({
      path,
      content_sha256: hash(Buffer.from(content).toString("utf8")),
      size_bytes: content.byteLength
    }))
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const zip = new AdmZip();
  for (const [path, content] of fileContents) zip.addFile(path, Buffer.from(content));
  zip.addFile("archive-manifest.json", manifestBytes);
  for (const entry of zip.getEntries()) {
    entry.header.time = new Date("1980-01-01T00:00:00.000Z");
  }
  return {
    package_bytes: zip.toBuffer(),
    manifest_bytes: manifestBytes,
    zip,
    manifest,
    file_contents: fileContents
  };
}

function withDeclaredFiles(
  raw: ReturnType<typeof rawPackage>,
  paths: readonly string[]
): { package_bytes: Uint8Array; manifest_bytes: Uint8Array } {
  for (const path of paths) {
    const content = Buffer.from(`content:${path}`);
    raw.file_contents.set(path, content);
    raw.manifest.files.push({
      path,
      content_sha256: hash(content.toString("utf8")),
      size_bytes: content.byteLength
    });
    raw.zip.addFile(path, content);
  }
  raw.manifest.file_count = raw.manifest.files.length;
  const manifestBytes = Buffer.from(JSON.stringify(raw.manifest));
  raw.zip.updateFile("archive-manifest.json", manifestBytes);
  return { package_bytes: raw.zip.toBuffer(), manifest_bytes: manifestBytes };
}

function input(id: string, overrides: ArchiveInputOverrides = {}): AcceptArchiveInput {
  const raw = rawPackage(id, overrides);
  const validatedPackage = validateArchivePackage({
    package_bytes: raw.package_bytes,
    manifest_bytes: raw.manifest_bytes,
    limits: defaultLimits,
    validated_at: now
  });
  return {
    schema_version: 1,
    request_id: overrides.request_id ?? archiveRequestId(id),
    validated_package: validatedPackage,
    extractor_version: overrides.extractor_version ?? "extractor-v1",
    prompt_version: overrides.prompt_version ?? "prompt-v1",
    index_schema_version: overrides.index_schema_version ?? "knowledge-index-v1"
  };
}

function setup(options: ConstructorParameters<typeof MemoryJobRepository>[0] = {}) {
  const archiveStore = new MemoryArchiveStore();
  const jobRepository = new MemoryJobRepository(options);
  const knowledgeIndex = new MemoryKnowledgeIndex();
  const knowledgeCommit = new MemoryKnowledgeCommitPort(jobRepository, knowledgeIndex);
  const pipeline = createKnowledgePipeline({
    archive_store: archiveStore,
    archive_validation: memoryArchiveValidationEvidence,
    job_repository: jobRepository,
    knowledge_index: knowledgeIndex,
    knowledge_commit: knowledgeCommit,
    clock: () => now
  });
  return { pipeline, archiveStore, jobRepository, knowledgeIndex, knowledgeCommit };
}

function resultDraft(
  candidate: KnowledgeCandidate,
  overrides: Partial<KnowledgeResultDraft> = {}
): KnowledgeResultDraft {
  return {
    source_candidate_id: candidate.candidate_id,
    content_hash: candidate.content_hash,
    display_title: `Knowledge ${candidate.candidate_id}`,
    summary: candidate.summary,
    reusability_scope: candidate.reusability_scope,
    source_refs: candidate.source_refs,
    confidence: candidate.confidence,
    ...overrides
  };
}

function changeDocument(
  job: { project_id: string; change_key: string; archive_id: string; package_sha256: string; project_version: string; project_generation: number },
  overrides: Partial<ChangeDocument> = {}
): ChangeDocument {
  const content = overrides.content ?? "# Approved design";
  const contentHash = hash(content);
  return {
    schema_version: 1,
    document_id: changeDocumentIdentity({
      project_id: job.project_id,
      change_key: job.change_key,
      document_type: overrides.document_type ?? "design",
      source_path: overrides.source_path ?? "spec/design.md"
    }),
    document_version: contentHash,
    project_id: job.project_id,
    change_key: job.change_key,
    archive_id: job.archive_id,
    package_sha256: job.package_sha256,
    project_version: job.project_version,
    document_type: "design",
    source_path: "spec/design.md",
    content_hash: contentHash,
    content,
    generation: job.project_generation,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

async function claimProjection(
  repository: MemoryJobRepository,
  jobId: string,
  ownerId = "worker-1"
): Promise<ChangeProjectionJob> {
  return repository.claimChangeProjectionJob({
    job_id: jobId,
    owner_id: ownerId,
    now,
    lease_expires_at: "2026-08-13T01:05:00.000Z"
  });
}

function projectionLease(job: ChangeProjectionJob) {
  return {
    owner_id: job.owner_id as string,
    lease_token: job.lease_token as string
  };
}

describe("knowledge pipeline v1", () => {
  it("matches the frozen Harness ArchiveOutbox upload identity fixture", () => {
    expect(archiveUploadIdempotencyKey({
      project_id: "prj_parity",
      change_key: "change-parity",
      archive_schema_version: 2,
      package_sha256: `sha256:${"a".repeat(64)}`
    })).toBe("sha256:14101e922b79e2c84d3cce9c533eb2390f5c367e43df49c5eeaf575f1e929311");
  });

  it("rejects unsafe or non-canonical accept inputs before CAS or task planning", async () => {
    const hostileCases: unknown[] = [];
    let trapCalls = 0;
    hostileCases.push(new Proxy({}, {
      get() { trapCalls += 1; throw new Error("accept proxy executed"); },
      getOwnPropertyDescriptor() { trapCalls += 1; throw new Error("descriptor trap executed"); }
    }));
    hostileCases.push(Object.defineProperty({}, "schema_version", {
      enumerable: true,
      get() { trapCalls += 1; return 1; }
    }));
    hostileCases.push(Object.assign(Object.create({ inherited: true }), input("custom-proto")));
    hostileCases.push({ ...input("symbol"), [Symbol("hostile")]: true });
    const nestedProxy = input("nested-proxy");
    hostileCases.push({
      ...nestedProxy,
      validated_package: new Proxy(nestedProxy.validated_package, {
        get() { trapCalls += 1; throw new Error("nested proxy executed"); }
      })
    });
    const nestedGetter = input("nested-getter");
    hostileCases.push({
      ...nestedGetter,
      validated_package: Object.defineProperty(
        { ...nestedGetter.validated_package },
        "archive_id",
        { enumerable: true, get() { trapCalls += 1; return "arc_nested-getter"; } }
      )
    });
    const nestedSymbol = input("nested-symbol");
    hostileCases.push({
      ...nestedSymbol,
      validated_package: { ...nestedSymbol.validated_package, [Symbol("hostile")]: true }
    });
    hostileCases.push(input("bad-request", { request_id: "req_bad-request" }));
    const invalidPackageFields = [
      ["project_id", "project_bad"],
      ["change_key", " change-bad"],
      ["archive_id", "archive_bad"],
      ["package_sha256", "sha256:BAD"],
      ["manifest_sha256", "sha256:BAD"],
      ["project_version", "version_bad"],
      ["package_schema_version", 0],
      ["archive_schema_version", 0]
    ] as const;
    for (const [field, value] of invalidPackageFields) {
      const invalid = input(`bad-${field}`);
      hostileCases.push({
        ...invalid,
        validated_package: { ...invalid.validated_package, [field]: value }
      });
    }

    for (const hostile of hostileCases) {
      const { pipeline, archiveStore, jobRepository } = setup();
      await expect(pipeline.acceptArchive(hostile as AcceptArchiveInput))
        .rejects.toMatchObject({ reason_code: "ARCHIVE_INPUT_INVALID", retryable: false });
      expect(archiveStore.recordCount()).toBe(0);
      expect(jobRepository.plannedArchiveAttempts()).toBe(0);
      expect(jobRepository.counts()).toEqual({
        change_projection: 0,
        knowledge_extraction: 0,
        project_content_governance: 0,
        project_content_candidates: 0
      });
    }
    expect(trapCalls).toBe(0);
  });

  it("withholds queued knowledge until its change projection is ready", async () => {
    const { pipeline, jobRepository } = setup();
    await pipeline.acceptArchive(input("dequeue-first"));
    await pipeline.acceptArchive(input("dequeue-second"));

    const knowledgeJobs = await jobRepository.listQueuedKnowledgeJobs(10);
    const changeJobs = await jobRepository.listQueuedChangeProjectionJobs(10);

    expect(knowledgeJobs).toHaveLength(0);
    expect(changeJobs).toHaveLength(2);
    expect(changeJobs.every((job) => job.status === "queued")).toBe(true);
    expect(await jobRepository.listQueuedKnowledgeJobs(1)).toHaveLength(0);
    await expect(jobRepository.listQueuedKnowledgeJobs(0)).rejects.toMatchObject({
      reason_code: "KNOWLEDGE_DEQUEUE_INVALID"
    });
  });

  it("keeps upload idempotency stable when only knowledge protocol versions change", async () => {
    const { pipeline } = setup();
    const first = await pipeline.acceptArchive(input("upload-identity"));
    const changed = await pipeline.acceptArchive(input("upload-identity", {
      extractor_version: "extractor-v2",
      prompt_version: "prompt-v2",
      index_schema_version: "knowledge-index-v2"
    }));

    expect(changed.idempotency_key).toBe(first.idempotency_key);
    expect(first.idempotency_key).toBe(archiveUploadIdempotencyKey({
      project_id: first.project_id,
      change_key: first.change_key,
      archive_schema_version: 2,
      package_sha256: first.package_sha256
    }));
    expect(changed.knowledge_extraction_job_id).not.toBe(first.knowledge_extraction_job_id);
  });

  it("plans a complete canonical change projection job alongside knowledge work", async () => {
    const { pipeline, jobRepository } = setup();
    const receipt = await pipeline.acceptArchive(input("projection-plan"));
    const job = await jobRepository.getChangeProjectionJob(receipt.change_projection_job_id);

    expect(job).toMatchObject({
      schema_version: 1,
      job_id: receipt.change_projection_job_id,
      project_id: receipt.project_id,
      change_key: receipt.change_key,
      archive_id: receipt.archive_id,
      package_sha256: receipt.package_sha256,
      project_version: receipt.project_version,
      status: "queued",
      attempt: 1,
      project_generation: 1,
      generation: 1,
      retryable: true
    });
    expect(job?.manifest_sha256).toMatch(/^sha256:/u);
    expect(job?.input_hash).toMatch(/^sha256:/u);

    const duplicate = await pipeline.acceptArchive(input("projection-plan"));
    expect(await jobRepository.getChangeProjectionJob(duplicate.change_projection_job_id))
      .toEqual(job);

    const changedKnowledgeVersion = await pipeline.acceptArchive(input("projection-plan", {
      extractor_version: "extractor-v2"
    }));
    expect(changedKnowledgeVersion.change_projection_job_id).toBe(job?.job_id);
    expect(await jobRepository.getChangeProjectionJob(changedKnowledgeVersion.change_projection_job_id))
      .toEqual(job);
    expect(job?.input_hash).toBe(
      (await jobRepository.getChangeProjectionJob(
        changedKnowledgeVersion.change_projection_job_id
      ))?.input_hash
    );
  });

  it("renews, expires and reaps projection leases while fencing stale owners", async () => {
    const { pipeline, jobRepository } = setup();
    const receipt = await pipeline.acceptArchive(input("projection-lease"));
    const first = await claimProjection(jobRepository, receipt.change_projection_job_id, "owner-a");
    const renewed = await jobRepository.renewChangeProjectionLease({
      job_id: first.job_id,
      generation: first.generation,
      ...projectionLease(first),
      now: "2026-08-13T01:01:00.000Z",
      lease_expires_at: "2026-08-13T01:10:00.000Z"
    });
    expect(renewed.lease_expires_at).toBe("2026-08-13T01:10:00.000Z");
    await expect(jobRepository.reapExpiredChangeProjectionLease({
      job_id: first.job_id,
      generation: first.generation,
      now: "2026-08-13T01:09:59.999Z"
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "CHANGE_PROJECTION_REAP_STATE_INVALID"
    });
    const reaped = await jobRepository.reapExpiredChangeProjectionLease({
      job_id: first.job_id,
      generation: first.generation,
      now: "2026-08-13T01:10:00.000Z"
    });
    expect(reaped).toMatchObject({ status: "failed", retryable: true });
    const retried = await jobRepository.retryChangeProjectionJob({
      job_id: first.job_id,
      expected_generation: first.generation,
      expected_status: "failed",
      now
    });
    const second = await claimProjection(jobRepository, retried.job_id, "owner-b");
    await expect(jobRepository.failChangeProjectionJob({
      job_id: first.job_id,
      generation: first.generation,
      ...projectionLease(first),
      reason_code: "STALE_OWNER",
      retryable: true,
      now
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "CHANGE_PROJECTION_JOB_GENERATION_STALE"
    });
    expect(second.owner_id).toBe("owner-b");
  });

  it("rejects hostile projection retry capabilities before reading or mutating the job", async () => {
    const { pipeline, jobRepository } = setup();
    const receipt = await pipeline.acceptArchive(input("projection-retry-capability"));
    const claimed = await claimProjection(jobRepository, receipt.change_projection_job_id);
    await jobRepository.failChangeProjectionJob({
      job_id: claimed.job_id,
      generation: claimed.generation,
      ...projectionLease(claimed),
      reason_code: "RETRYABLE_FAILURE",
      retryable: true,
      now
    });
    const before = await jobRepository.getChangeProjectionJob(claimed.job_id);
    let trapCalls = 0;
    const hostileInputs: unknown[] = [
      new Proxy({}, { get() { trapCalls += 1; throw new Error("retry proxy executed"); } }),
      Object.defineProperty({}, "job_id", {
        enumerable: true,
        get() { trapCalls += 1; return claimed.job_id; }
      }),
      { job_id: claimed.job_id, expected_generation: claimed.generation,
        expected_status: "failed", now: "2026-02-30T01:00:00.000Z" },
      Object.assign(Object.create(null), { job_id: claimed.job_id,
        expected_generation: claimed.generation, expected_status: "failed", now }),
      { job_id: claimed.job_id, expected_generation: claimed.generation,
        expected_status: "failed", now, [Symbol("hostile")]: true }
    ];
    for (const hostile of hostileInputs) {
      await expect(jobRepository.retryChangeProjectionJob(hostile as never))
        .rejects.toMatchObject<Partial<KnowledgePipelineError>>({
          reason_code: "CHANGE_PROJECTION_RETRY_INVALID",
          retryable: false
        });
      expect(await jobRepository.getChangeProjectionJob(claimed.job_id)).toEqual(before);
    }
    expect(trapCalls).toBe(0);
  });

  it("atomically commits a change document snapshot and makes exact replay idempotent", async () => {
    const { pipeline, jobRepository } = setup();
    const documentIndex = new MemoryChangeDocumentIndex();
    const commit = new MemoryChangeProjectionCommitPort(jobRepository, documentIndex);
    const receipt = await pipeline.acceptArchive(input("projection-commit"));
    const job = await claimProjection(jobRepository, receipt.change_projection_job_id);
    const document = changeDocument(job);
    const completion = {
      job_id: job.job_id,
      generation: job.generation,
      ...projectionLease(job),
      output_hash: changeProjectionOutputHash([document]),
      documents: [document],
      now
    } as const;

    const first = await commit.commitChangeProjection(completion);
    const replay = await commit.commitChangeProjection(completion);
    const expectedReady = structuredClone(job);
    expectedReady.status = "ready";
    expectedReady.output_hash = completion.output_hash;
    expectedReady.document_count = 1;
    expectedReady.retryable = false;
    expectedReady.updated_at = now;
    delete expectedReady.owner_id;
    delete expectedReady.lease_token;
    delete expectedReady.lease_expires_at;
    for (const completed of [
      first,
      replay,
      await jobRepository.getChangeProjectionJob(job.job_id)
    ]) {
      expect(completed).toEqual(expectedReady);
    }
    expect(documentIndex.snapshot(job.project_id)).toEqual([document]);

    const conflictingDocument = changeDocument(job, { content: "# Different design" });
    await expect(commit.commitChangeProjection({
      ...completion,
      output_hash: changeProjectionOutputHash([conflictingDocument]),
      documents: [conflictingDocument]
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "CHANGE_PROJECTION_COMPLETE_CONFLICT",
      retryable: false
    });
    expect(documentIndex.snapshot(job.project_id)).toEqual([document]);
  });

  it("replaces only the matching change snapshot and keeps stable document ordering", async () => {
    const { pipeline, jobRepository } = setup();
    const documentIndex = new MemoryChangeDocumentIndex();
    const commit = new MemoryChangeProjectionCommitPort(jobRepository, documentIndex);
    const firstReceipt = await pipeline.acceptArchive(input("snapshot-first"));
    const firstJob = await claimProjection(jobRepository, firstReceipt.change_projection_job_id);
    const firstDocuments = [
      changeDocument(firstJob, { document_type: "plan", source_path: "plans/plan.md" }),
      changeDocument(firstJob, { document_type: "design", source_path: "spec/design.md" })
    ].sort((left, right) => left.document_id < right.document_id ? -1 : 1);
    await commit.commitChangeProjection({
      job_id: firstJob.job_id,
      generation: firstJob.generation,
      ...projectionLease(firstJob),
      output_hash: changeProjectionOutputHash(firstDocuments),
      documents: firstDocuments,
      now
    });
    const secondReceipt = await pipeline.acceptArchive(input("snapshot-second"));
    const secondJob = await claimProjection(jobRepository, secondReceipt.change_projection_job_id);
    const secondDocument = changeDocument(secondJob);
    await commit.commitChangeProjection({
      job_id: secondJob.job_id,
      generation: secondJob.generation,
      ...projectionLease(secondJob),
      output_hash: changeProjectionOutputHash([secondDocument]),
      documents: [secondDocument],
      now
    });
    const snapshot = documentIndex.snapshot(firstJob.project_id);
    expect(snapshot.map((document) => document.document_id)).toEqual(
      snapshot.map((document) => document.document_id).sort()
    );
    expect(snapshot.filter((document) => document.change_key === firstJob.change_key))
      .toHaveLength(2);
    expect(snapshot.filter((document) => document.change_key === secondJob.change_key))
      .toHaveLength(1);
  });

  it("fences an older project generation without exposing its document", async () => {
    const { pipeline, jobRepository } = setup();
    const documentIndex = new MemoryChangeDocumentIndex();
    const commit = new MemoryChangeProjectionCommitPort(jobRepository, documentIndex);
    const oldReceipt = await pipeline.acceptArchive(input("projection-old"));
    const oldJob = await claimProjection(jobRepository, oldReceipt.change_projection_job_id);
    const newReceipt = await pipeline.acceptArchive(input("projection-new"));

    await expect(commit.commitChangeProjection({
      job_id: oldJob.job_id,
      generation: oldJob.generation,
      ...projectionLease(oldJob),
      output_hash: changeProjectionOutputHash([changeDocument(oldJob)]),
      documents: [changeDocument(oldJob)],
      now
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "CHANGE_PROJECTION_PROJECT_GENERATION_STALE",
      retryable: false
    });
    expect(documentIndex.snapshot(oldJob.project_id)).toEqual([]);
    expect(await jobRepository.getChangeProjectionJob(oldJob.job_id)).toMatchObject({
      status: "projecting"
    });
    expect(newReceipt.change_projection_job_id).not.toBe(oldJob.job_id);
  });

  it("does not let a failed older archive retry supersede a newer projection", async () => {
    const { pipeline, jobRepository } = setup();
    const documentIndex = new MemoryChangeDocumentIndex();
    const commit = new MemoryChangeProjectionCommitPort(jobRepository, documentIndex);
    const oldReceipt = await pipeline.acceptArchive(input("projection-retry-old"));
    const oldClaim = await claimProjection(jobRepository, oldReceipt.change_projection_job_id);
    await jobRepository.failChangeProjectionJob({
      job_id: oldClaim.job_id,
      generation: oldClaim.generation,
      ...projectionLease(oldClaim),
      reason_code: "CHANGE_DOCUMENT_STORE_UNAVAILABLE",
      retryable: true,
      now
    });
    const newerReceipt = await pipeline.acceptArchive(input("projection-retry-newer"));
    const newerClaim = await claimProjection(jobRepository, newerReceipt.change_projection_job_id);
    const retriedOld = await jobRepository.retryChangeProjectionJob({
      job_id: oldClaim.job_id,
      expected_generation: oldClaim.generation,
      expected_status: "failed",
      now
    });
    const reclaimedOld = await claimProjection(jobRepository, retriedOld.job_id);

    await expect(commit.commitChangeProjection({
      job_id: reclaimedOld.job_id,
      generation: reclaimedOld.generation,
      ...projectionLease(reclaimedOld),
      output_hash: changeProjectionOutputHash([changeDocument(reclaimedOld)]),
      documents: [changeDocument(reclaimedOld)],
      now
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "CHANGE_PROJECTION_PROJECT_GENERATION_STALE"
    });

    const newerDocument = changeDocument(newerClaim);
    await expect(commit.commitChangeProjection({
      job_id: newerClaim.job_id,
      generation: newerClaim.generation,
      ...projectionLease(newerClaim),
      output_hash: changeProjectionOutputHash([newerDocument]),
      documents: [newerDocument],
      now
    })).resolves.toMatchObject({ status: "ready" });
  });

  it("keeps the durable archive and document snapshot unchanged across projection failure and retry", async () => {
    const { pipeline, archiveStore, jobRepository } = setup();
    const documentIndex = new MemoryChangeDocumentIndex();
    const commit = new MemoryChangeProjectionCommitPort(jobRepository, documentIndex, {
      fail_next_commit_reason_code: "CHANGE_DOCUMENT_STORE_UNAVAILABLE"
    });
    const receipt = await pipeline.acceptArchive(input("projection-retry"));
    const claimed = await claimProjection(jobRepository, receipt.change_projection_job_id);
    const completion = {
      job_id: claimed.job_id,
      generation: claimed.generation,
      ...projectionLease(claimed),
      output_hash: changeProjectionOutputHash([changeDocument(claimed)]),
      documents: [changeDocument(claimed)],
      now
    };

    await expect(commit.commitChangeProjection(completion)).rejects.toMatchObject<
      Partial<KnowledgePipelineError>
    >({ reason_code: "CHANGE_DOCUMENT_STORE_UNAVAILABLE", retryable: true });
    expect(documentIndex.snapshot(claimed.project_id)).toEqual([]);
    expect(await jobRepository.getChangeProjectionJob(claimed.job_id)).toEqual(claimed);

    const failed = await jobRepository.failChangeProjectionJob({
      job_id: claimed.job_id,
      generation: claimed.generation,
      ...projectionLease(claimed),
      reason_code: "CHANGE_DOCUMENT_STORE_UNAVAILABLE",
      retryable: true,
      now
    });
    const retried = await jobRepository.retryChangeProjectionJob({
      job_id: failed.job_id,
      expected_generation: failed.generation,
      expected_status: "failed",
      now
    });
    expect(retried).toMatchObject({ status: "queued", attempt: 2, generation: 2 });
    expect(await archiveStore.getByArchiveId(receipt.archive_id)).toMatchObject({
      archive_id: receipt.archive_id,
      package_sha256: receipt.package_sha256
    });
    await expect(commit.commitChangeProjection(completion)).rejects.toMatchObject<
      Partial<KnowledgePipelineError>
    >({ reason_code: "CHANGE_PROJECTION_JOB_GENERATION_STALE", retryable: false });
  });

  it("rejects getters and proxies at the change document commit seam without executing them", async () => {
    const { pipeline, jobRepository } = setup();
    const documentIndex = new MemoryChangeDocumentIndex();
    const commit = new MemoryChangeProjectionCommitPort(jobRepository, documentIndex);
    const receipt = await pipeline.acceptArchive(input("projection-hostile"));
    const job = await claimProjection(jobRepository, receipt.change_projection_job_id);
    let getterCalls = 0;
    const getterDocument = changeDocument(job);
    Object.defineProperty(getterDocument, "content", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "hostile";
      }
    });

    await expect(commit.commitChangeProjection({
      job_id: job.job_id,
      generation: job.generation,
      ...projectionLease(job),
      output_hash: hash("getter"),
      documents: [getterDocument],
      now
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "CHANGE_DOCUMENT_INVALID",
      retryable: false
    });
    expect(getterCalls).toBe(0);

    const proxy = new Proxy(changeDocument(job), {
      get() {
        throw new Error("proxy executed");
      }
    });
    await expect(commit.commitChangeProjection({
      job_id: job.job_id,
      generation: job.generation,
      ...projectionLease(job),
      output_hash: hash("proxy"),
      documents: [proxy],
      now
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "CHANGE_DOCUMENT_INVALID",
      retryable: false
    });

    let outerTrapCalls = 0;
    const hostileInput = new Proxy({}, {
      get() {
        outerTrapCalls += 1;
        throw new Error("outer proxy executed");
      }
    });
    await expect(commit.commitChangeProjection(
      hostileInput as never
    )).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "CHANGE_PROJECTION_COMMIT_INVALID",
      retryable: false
    });
    expect(outerTrapCalls).toBe(0);
  });

  it("rejects unsafe source paths and non-Gregorian timestamps before publishing documents", async () => {
    const { pipeline, jobRepository } = setup();
    const documentIndex = new MemoryChangeDocumentIndex();
    const commit = new MemoryChangeProjectionCommitPort(jobRepository, documentIndex);
    const receipt = await pipeline.acceptArchive(input("projection-invalid-document"));
    const job = await claimProjection(jobRepository, receipt.change_projection_job_id);
    for (const document of [
      changeDocument(job, { source_path: "../escape" }),
      changeDocument(job, { created_at: "2026-02-30T01:00:00.000Z" })
    ]) {
      await expect(commit.commitChangeProjection({
        job_id: job.job_id,
        generation: job.generation,
        ...projectionLease(job),
        output_hash: changeProjectionOutputHash([document]),
        documents: [document],
        now
      })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
        reason_code: "CHANGE_DOCUMENT_INVALID",
        retryable: false
      });
    }
    expect(documentIndex.snapshot(job.project_id)).toEqual([]);
  });

  it("binds test scenarios to the canonical change-key plan path", async () => {
    const job: ChangeProjectionJob = {
      schema_version: 1,
      job_id: "change_projection_job:test-scenarios",
      project_id: "prj_06a",
      change_key: "change-test-scenarios",
      archive_id: "arc_test_scenarios",
      package_sha256: hash("package-test-scenarios"),
      manifest_sha256: hash("manifest-test-scenarios"),
      project_version: "pv_test_scenarios",
      package_schema_version: 2,
      archive_schema_version: 2,
      status: "projecting",
      attempt: 1,
      project_generation: 1,
      generation: 1,
      input_hash: hash("input-test-scenarios"),
      owner_id: "worker-1",
      lease_token: "lease:test-scenarios",
      lease_expires_at: "2026-08-13T01:05:00.000Z",
      retryable: false,
      created_at: now,
      updated_at: now
    };
    const canonicalDocument = changeDocument(job, {
      document_type: "test_scenarios",
      source_path: `plans/${job.change_key}-test-scenarios.md`
    });
    let repositoryCalls = 0;
    const commit = new MemoryChangeProjectionCommitPort({
      prepareChangeProjectionCommit() {
        repositoryCalls += 1;
        throw new Error("document validation passed");
      }
    } as never, new MemoryChangeDocumentIndex());
    await expect(commit.commitChangeProjection({
      job_id: job.job_id,
      generation: job.generation,
      owner_id: job.owner_id as string,
      lease_token: job.lease_token as string,
      output_hash: changeProjectionOutputHash([canonicalDocument]),
      documents: [canonicalDocument],
      now
    })).rejects.toThrow("document validation passed");
    expect(repositoryCalls).toBe(1);

    const ordinaryPlan = changeDocument(job, {
      document_type: "plan",
      source_path: "plans/implementation.md"
    });
    await expect(commit.commitChangeProjection({
      job_id: job.job_id,
      generation: job.generation,
      owner_id: job.owner_id as string,
      lease_token: job.lease_token as string,
      output_hash: changeProjectionOutputHash([ordinaryPlan]),
      documents: [ordinaryPlan],
      now
    })).rejects.toThrow("document validation passed");
    expect(repositoryCalls).toBe(2);

    for (const invalidDocument of [
      changeDocument(job, {
        document_type: "test_scenarios",
        source_path: "spec/test-scenarios.md"
      }),
      changeDocument(job, {
        document_type: "test_scenarios",
        source_path: `plans/nested/${job.change_key}-test-scenarios.md`
      }),
      changeDocument(job, {
        document_type: "test_scenarios",
        source_path: "plans/other-change-test-scenarios.md"
      }),
      changeDocument(job, {
        document_type: "plan",
        source_path: `plans/${job.change_key}-test-scenarios.md`
      })
    ]) {
      await expect(commit.commitChangeProjection({
        job_id: job.job_id,
        generation: job.generation,
        owner_id: job.owner_id as string,
        lease_token: job.lease_token as string,
        output_hash: changeProjectionOutputHash([invalidDocument]),
        documents: [invalidDocument],
        now
      })).rejects.toMatchObject({ reason_code: "CHANGE_DOCUMENT_INVALID" });
    }

    await expect(commit.commitChangeProjection({
      job_id: job.job_id,
      generation: job.generation,
      owner_id: job.owner_id as string,
      lease_token: job.lease_token as string,
      output_hash: changeProjectionOutputHash([canonicalDocument, canonicalDocument]),
      documents: [canonicalDocument, canonicalDocument],
      now
    })).rejects.toMatchObject({ reason_code: "CHANGE_DOCUMENT_INVALID" });
    expect(repositoryCalls).toBe(2);
  });

  it("keeps all exported change projection identity helpers inert on hostile objects", () => {
    for (const invoke of [
      (value: unknown) => changeDocumentIdentity(value as never),
      (value: unknown) => changeProjectionOutputHash(value as never),
      (value: unknown) => changeProjectionInputHash(value as never)
    ]) {
      let trapCalls = 0;
      const proxy = new Proxy({}, {
        get() { trapCalls += 1; throw new Error("helper proxy executed"); }
      });
      expect(() => invoke(proxy)).toThrowError(KnowledgePipelineError);
      expect(trapCalls).toBe(0);
      const accessor = {};
      Object.defineProperty(accessor, "project_id", {
        enumerable: true,
        get() { trapCalls += 1; return "prj_hostile"; }
      });
      expect(() => invoke(accessor)).toThrowError(KnowledgePipelineError);
      expect(trapCalls).toBe(0);
      expect(() => invoke(Object.assign(Object.create(null), { project_id: "prj_hostile" })))
        .toThrowError(KnowledgePipelineError);
      expect(() => invoke({ project_id: "prj_hostile", [Symbol("hostile")]: true }))
        .toThrowError(KnowledgePipelineError);
    }
  });

  it("reuses Stage 01 path classification and closes the change-document path allowlist", async () => {
    const { pipeline, jobRepository } = setup();
    const documentIndex = new MemoryChangeDocumentIndex();
    const commit = new MemoryChangeProjectionCommitPort(jobRepository, documentIndex);
    const receipt = await pipeline.acceptArchive(input("projection-path-matrix"));
    const job = await claimProjection(jobRepository, receipt.change_projection_job_id);
    for (const source_path of [
      "spec/CON.md", "plans/COM\u00b9.md", "spec/file:stream.md", "spec/bad?.md",
      "spec/trailing. /x.md", "other/design.md", "summary/other.json"
    ]) {
      const document = changeDocument(job, { source_path });
      await expect(commit.commitChangeProjection({
        job_id: job.job_id,
        generation: job.generation,
        ...projectionLease(job),
        output_hash: changeProjectionOutputHash([document]),
        documents: [document],
        now
      })).rejects.toMatchObject({ reason_code: "CHANGE_DOCUMENT_INVALID" });
    }
    const collision = [
      changeDocument(job, { source_path: "spec/Nested/design.md" }),
      changeDocument(job, { source_path: "spec/nested/DESIGN.md" })
    ].sort((left, right) => left.document_id < right.document_id ? -1 : 1);
    await expect(commit.commitChangeProjection({
      job_id: job.job_id,
      generation: job.generation,
      ...projectionLease(job),
      output_hash: changeProjectionOutputHash(collision),
      documents: collision,
      now
    })).rejects.toMatchObject({ reason_code: "CHANGE_DOCUMENT_INVALID" });
  });
  it("keeps the in-memory validation evidence authority immutable", () => {
    expect(Object.isFrozen(memoryArchiveValidationEvidence)).toBe(true);
  });

  it("rejects self-consistent bytes that are not a validated ZIP and JSON manifest", async () => {
    const { pipeline, archiveStore, jobRepository } = setup();
    const packageBytes = new TextEncoder().encode("not-a-zip");
    const manifestBytes = new TextEncoder().encode("not-json-manifest");
    const invalid = {
      schema_version: 1,
      request_id: archiveRequestId("not-an-archive"),
      extractor_version: "extractor-v1",
      prompt_version: "prompt-v1",
      index_schema_version: "knowledge-index-v1",
      validated_package: {
        schema_version: 1,
        project_id: "prj_06a",
        change_key: "change-not-an-archive",
        archive_id: "arc_not-an-archive",
        package_sha256: hash("not-a-zip"),
        manifest_sha256: hash("not-json-manifest"),
        project_version: "pv_not-an-archive",
        package_schema_version: 2,
        archive_schema_version: 2,
        package_bytes: packageBytes,
        manifest_bytes: manifestBytes,
        knowledge_candidates: [],
        project_content_candidates: [],
        validation_receipt: {}
      }
    } as unknown as AcceptArchiveInput;

    await expect(pipeline.acceptArchive(invalid)).rejects.toMatchObject<
      Partial<KnowledgePipelineError>
    >({ reason_code: "ARCHIVE_VALIDATION_REQUIRED" });
    expect(archiveStore.recordCount()).toBe(0);
    expect(jobRepository.counts()).toMatchObject({ knowledge_extraction: 0 });
  });

  it("rejects malformed ZIP and manifest JSON before CAS or task planning", () => {
    const { archiveStore, jobRepository } = setup();
    expect(() => validateArchivePackage({
      package_bytes: Buffer.from("not-a-zip"),
      manifest_bytes: Buffer.from("not-json"),
      limits: defaultLimits,
      validated_at: now
    })).toThrow(expect.objectContaining({ reason_code: "ARCHIVE_ZIP_INVALID" }));

    const raw = rawPackage("bad-json");
    raw.zip.updateFile("archive-manifest.json", Buffer.from("not-json"));
    expect(() => validateArchivePackage({
      package_bytes: raw.zip.toBuffer(),
      manifest_bytes: Buffer.from("not-json"),
      limits: defaultLimits,
      validated_at: now
    })).toThrow(expect.objectContaining({
      reason_code: "ARCHIVE_MANIFEST_JSON_INVALID"
    }));
    expect(archiveStore.recordCount()).toBe(0);
    expect(jobRepository.counts().knowledge_extraction).toBe(0);
  });

  it("rejects traversal, symlink and encrypted entries before CAS", () => {
    const { archiveStore, jobRepository } = setup();
    const traversal = rawPackage("traversal");
    traversal.zip.addFile("aa/escape.txt", Buffer.from("escape"));
    const traversalBytes = traversal.zip.toBuffer();
    const safeName = Buffer.from("aa/escape.txt");
    const unsafeName = Buffer.from("../escape.txt");
    let nameOffset = traversalBytes.indexOf(safeName);
    while (nameOffset >= 0) {
      unsafeName.copy(traversalBytes, nameOffset);
      nameOffset = traversalBytes.indexOf(safeName, nameOffset + safeName.byteLength);
    }
    expect(() => validateArchivePackage({
      package_bytes: traversalBytes,
      manifest_bytes: traversal.manifest_bytes,
      limits: defaultLimits,
      validated_at: now
    })).toThrow(expect.objectContaining({ reason_code: "ARCHIVE_PATH_UNSAFE" }));

    const symlink = rawPackage("symlink");
    const symlinkBytes = symlink.zip.toBuffer();
    const symlinkCentralHeader = symlinkBytes.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02])
    );
    if (symlinkCentralHeader < 0) throw new Error("missing symlink central header");
    symlinkBytes.writeUInt32LE(0xa0000000, symlinkCentralHeader + 38);
    expect(() => validateArchivePackage({
      package_bytes: symlinkBytes,
      manifest_bytes: symlink.manifest_bytes,
      limits: defaultLimits,
      validated_at: now
    })).toThrow(expect.objectContaining({ reason_code: "ARCHIVE_SYMLINK_FORBIDDEN" }));

    const encrypted = rawPackage("encrypted");
    const encryptedBytes = encrypted.zip.toBuffer();
    encryptedBytes.writeUInt16LE(encryptedBytes.readUInt16LE(6) | 0x1, 6);
    const centralHeader = encryptedBytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    if (centralHeader < 0) throw new Error("missing central ZIP header");
    encryptedBytes.writeUInt16LE(
      encryptedBytes.readUInt16LE(centralHeader + 8) | 0x1,
      centralHeader + 8
    );
    expect(() => validateArchivePackage({
      package_bytes: encryptedBytes,
      manifest_bytes: encrypted.manifest_bytes,
      limits: defaultLimits,
      validated_at: now
    })).toThrow(expect.objectContaining({
      reason_code: "ARCHIVE_ENCRYPTED_ENTRY_FORBIDDEN"
    }));
    expect(archiveStore.recordCount()).toBe(0);
    expect(jobRepository.counts().knowledge_extraction).toBe(0);
  });

  it("rejects expansion bounds, manifest mismatch and unbound candidate sources", () => {
    const { archiveStore, jobRepository } = setup();
    const expansion = rawPackage("expansion");
    expect(() => validateArchivePackage({
      package_bytes: expansion.package_bytes,
      manifest_bytes: expansion.manifest_bytes,
      limits: { ...defaultLimits, max_package_bytes: Number.NaN },
      validated_at: now
    })).toThrow(expect.objectContaining({
      reason_code: "ARCHIVE_PACKAGE_LIMIT_INVALID"
    }));
    expect(() => validateArchivePackage({
      package_bytes: expansion.package_bytes,
      manifest_bytes: expansion.manifest_bytes,
      limits: { ...defaultLimits, max_uncompressed_bytes: 8 },
      validated_at: now
    })).toThrow(expect.objectContaining({
      reason_code: "ARCHIVE_UNCOMPRESSED_SIZE_EXCEEDED"
    }));

    const mismatch = rawPackage("manifest-mismatch");
    expect(() => validateArchivePackage({
      package_bytes: mismatch.package_bytes,
      manifest_bytes: Buffer.from("different-manifest"),
      limits: defaultLimits,
      validated_at: now
    })).toThrow(expect.objectContaining({ reason_code: "ARCHIVE_MANIFEST_MISMATCH" }));

    const contentMismatch = rawPackage("content-mismatch");
    contentMismatch.zip.updateFile(
      "summary/change-summary.json",
      Buffer.from(JSON.stringify({ summary: "tampered" }))
    );
    expect(() => validateArchivePackage({
      package_bytes: contentMismatch.zip.toBuffer(),
      manifest_bytes: contentMismatch.manifest_bytes,
      limits: defaultLimits,
      validated_at: now
    })).toThrow(expect.objectContaining({
      reason_code: "ARCHIVE_MANIFEST_CONTENT_MISMATCH"
    }));

    const unboundCandidate = knowledgeCandidate("unbound");
    unboundCandidate.source_refs = ["missing/not-declared.json#decision"];
    const unbound = rawPackage("unbound", {
      knowledge_candidates: [unboundCandidate],
      project_content_candidates: []
    });
    expect(() => validateArchivePackage({
      package_bytes: unbound.package_bytes,
      manifest_bytes: unbound.manifest_bytes,
      limits: defaultLimits,
      validated_at: now
    })).toThrow(expect.objectContaining({
      reason_code: "ARCHIVE_CANDIDATE_SOURCE_UNBOUND"
    }));
    expect(archiveStore.recordCount()).toBe(0);
    expect(jobRepository.counts().knowledge_extraction).toBe(0);
  });

  it("allows only frozen core-v2 archive paths", () => {
    const forbiddenPaths = [
      ".env",
      ".env.production",
      "credentials.local.json",
      ".npmrc",
      "id_rsa",
      "logs/worker.log",
      "reports/verification.md",
      "cache/index.bin",
      "unknown/data.json"
    ];
    for (const [index, path] of forbiddenPaths.entries()) {
      const raw = rawPackage(`forbidden-${index}`);
      const archive = withDeclaredFiles(raw, [path]);
      expect(() => validateArchivePackage({
        ...archive,
        limits: defaultLimits,
        validated_at: now
      }), path).toThrow(expect.objectContaining({
        reason_code: "ARCHIVE_CORE_PATH_FORBIDDEN"
      }));
    }

    const valid = rawPackage("nested-core-paths");
    const archive = withDeclaredFiles(valid, [
      "spec/decisions/auth/session.md",
      "plans/releases/next.md",
      "archive-meta.md",
      "change-context.json"
    ]);
    expect(() => validateArchivePackage({
      ...archive,
      limits: defaultLimits,
      validated_at: now
    })).not.toThrow();

    const wrongCase = withDeclaredFiles(rawPackage("wrong-case"), ["Spec/decision.md"]);
    expect(() => validateArchivePackage({
      ...wrongCase,
      limits: defaultLimits,
      validated_at: now
    })).toThrow(expect.objectContaining({ reason_code: "ARCHIVE_CORE_PATH_FORBIDDEN" }));

    const collision = withDeclaredFiles(rawPackage("case-collision"), [
      "spec/decision.md",
      "spec/DECISION.md"
    ]);
    expect(() => validateArchivePackage({
      ...collision,
      limits: defaultLimits,
      validated_at: now
    })).toThrow(expect.objectContaining({ reason_code: "ARCHIVE_PATH_DUPLICATE" }));

    for (const unsafePath of [
      "spec/../file.md",
      "spec//a/file.md",
      "spec\\aa\\file.md"
    ]) {
      const unsafe = rawPackage(`unsafe-${unsafePath.length}`);
      const safePath = "spec/aa/file.md";
      const unsafeArchive = withDeclaredFiles(unsafe, [safePath]);
      const packageBytes = Buffer.from(unsafeArchive.package_bytes);
      const safeName = Buffer.from(safePath);
      const unsafeName = Buffer.from(unsafePath);
      let nameOffset = packageBytes.indexOf(safeName);
      while (nameOffset >= 0) {
        unsafeName.copy(packageBytes, nameOffset);
        nameOffset = packageBytes.indexOf(safeName, nameOffset + safeName.byteLength);
      }
      expect(() => validateArchivePackage({
        package_bytes: packageBytes,
        manifest_bytes: unsafeArchive.manifest_bytes,
        limits: defaultLimits,
        validated_at: now
      }), unsafePath).toThrow(expect.objectContaining({ reason_code: "ARCHIVE_PATH_UNSAFE" }));
    }
  });

  it("projects the stage-01 canonical path safety matrix before core-v2 reads", () => {
    const reviewerPaths = [
      "spec/decisions/CON/session.md",
      "spec/decisions/prn/session.md",
      "plans/devices/AUX.md",
      "spec/devices/NUL.txt/note.md",
      "spec/devices/COM1/note.md",
      "plans/devices/LPT9/note.md",
      "spec/devices/com¹/note.md",
      "plans/devices/lpt³/note.md",
      "spec/auth/session:token.md",
      "plans/auth/<private>.md",
      "spec/auth/session|token.md",
      "plans/auth/session?.md",
      "spec/auth/session*.md",
      "spec/auth/control\u0001/note.md",
      "spec/nested/.env.production/note.md",
      "plans/nested/CREDENTIALS.LOCAL.prod/note.md"
    ];
    for (const [index, path] of reviewerPaths.entries()) {
      expect(classifyContentPath({
        schema_version: 1,
        path,
        source_kind: "branch_file"
      }), path).toHaveProperty("reason_code");
      const archive = withDeclaredFiles(rawPackage(`canonical-${index}`), [path]);
      expect(() => validateArchivePackage({
        ...archive,
        limits: defaultLimits,
        validated_at: now
      }), path).toThrow(expect.objectContaining({
        reason_code: expect.stringMatching(
          /^ARCHIVE_(?:PATH_UNSAFE|CORE_PATH_FORBIDDEN)$/u
        )
      }));
    }

    const decomposed = "spec/decisions/cafe\u0301/session.md";
    expect(decomposed).not.toBe(decomposed.normalize("NFC"));
    const nfcArchive = withDeclaredFiles(rawPackage("nfc-collision"), [
      "spec/decisions/café/session.md",
      decomposed
    ]);
    expect(() => validateArchivePackage({
      ...nfcArchive,
      limits: defaultLimits,
      validated_at: now
    })).toThrow(expect.objectContaining({ reason_code: "ARCHIVE_PATH_UNSAFE" }));

    for (const path of [
      "spec/decisions/auth/session.md",
      "plans/releases/next/migration.md",
      "summary/change-summary.json",
      "attestations/verification.json",
      "candidates/knowledge.json",
      "candidates/project-content.json",
      "archive-meta.md",
      "change-context.json",
      "archive-manifest.json"
    ]) {
      expect(classifyContentPath({
        schema_version: 1,
        path,
        source_kind: "branch_file"
      }), path).not.toHaveProperty("reason_code");
    }
  });

  it("does not expose index writes when completing the job transaction fails", async () => {
    const archiveStore = new MemoryArchiveStore();
    const jobRepository = new MemoryJobRepository();
    const knowledgeIndex = new MemoryKnowledgeIndex();
    const knowledgeCommit = new MemoryKnowledgeCommitPort(
      jobRepository,
      knowledgeIndex,
      { fail_next_commit_reason_code: "SIMULATED_COMMIT_FAILURE" }
    );
    const pipeline = createKnowledgePipeline({
      archive_store: archiveStore,
      archive_validation: memoryArchiveValidationEvidence,
      job_repository: jobRepository,
      knowledge_index: knowledgeIndex,
      knowledge_commit: knowledgeCommit,
      clock: () => now
    });
    const candidate = knowledgeCandidate("atomic-commit");
    const receipt = await pipeline.acceptArchive(input("atomic-commit", {
      knowledge_candidates: [candidate],
      project_content_candidates: []
    }));
    const job = await pipeline.worker.startKnowledgeExtraction(
      receipt.knowledge_extraction_job_id
    );

    await expect(pipeline.worker.completeKnowledgeExtraction({
      job_id: job.job_id,
      generation: job.generation,
      results: [resultDraft(candidate)]
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "SIMULATED_COMMIT_FAILURE"
    });
    await expect(pipeline.queryKnowledge({
      project_id: "prj_06a",
      query: "Reusable",
      limit: 10
    })).resolves.toEqual([]);
    await expect(jobRepository.getKnowledgeJob(job.job_id)).resolves.toMatchObject({
      status: "extracting",
      generation: job.generation
    });

    await pipeline.worker.failKnowledgeExtraction({
      job_id: job.job_id,
      generation: job.generation,
      reason_code: "KNOWLEDGE_COMMIT_RETRY",
      retryable: true
    });
    const retried = await pipeline.retryKnowledgeExtraction(job.job_id);
    const generationTwo = await pipeline.worker.startKnowledgeExtraction(retried.job_id);
    await expect(pipeline.worker.completeKnowledgeExtraction({
      job_id: job.job_id,
      generation: job.generation,
      results: [resultDraft(candidate, { summary: "stale generation" })]
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "KNOWLEDGE_JOB_GENERATION_STALE"
    });
    await expect(pipeline.queryKnowledge({
      project_id: "prj_06a",
      query: "generation",
      limit: 10
    })).resolves.toEqual([]);
    await pipeline.worker.completeKnowledgeExtraction({
      job_id: generationTwo.job_id,
      generation: generationTwo.generation,
      results: [resultDraft(candidate, { summary: "current generation" })]
    });
    await expect(pipeline.queryKnowledge({
      project_id: "prj_06a",
      query: "current generation",
      limit: 10
    })).resolves.toHaveLength(1);
  });

  it("persists entry_type / body / keywords onto the knowledge result", async () => {
    // 这三个字段是 knowledgeIngestEntrySchema 要求、reusability_scope 无法映射的。
    // 任何一层把它们丢掉，入库桥就只能凭空造一个 type，或写出 safeParse 不过、
    // 在语义投影处被静默跳过的残缺 payload。
    const { pipeline } = setup();
    const candidate = knowledgeCandidate("entry-projection");
    const receipt = await pipeline.acceptArchive(input("entry-projection", {
      knowledge_candidates: [candidate],
      project_content_candidates: []
    }));
    const job = await pipeline.worker.startKnowledgeExtraction(
      receipt.knowledge_extraction_job_id
    );
    await pipeline.worker.completeKnowledgeExtraction({
      job_id: job.job_id,
      generation: job.generation,
      results: [resultDraft(candidate, {
        entry_type: "pitfall",
        body: "nonScannablePathPrefixes rejects the whole archive tree",
        keywords: ["content-sync.ts", "RED", "FIXED"]
      })]
    });

    const [stored] = await pipeline.queryKnowledge({
      project_id: "prj_06a",
      query: candidate.summary,
      limit: 10
    });
    expect(stored).toBeDefined();
    expect(stored?.entry_type).toBe("pitfall");
    expect(stored?.body).toBe("nonScannablePathPrefixes rejects the whole archive tree");
    expect(stored?.keywords).toEqual(["content-sync.ts", "RED", "FIXED"]);
  });

  it("keeps the result bare when the archive predates the candidate generator", async () => {
    const { pipeline } = setup();
    const candidate = knowledgeCandidate("entry-projection-legacy");
    const receipt = await pipeline.acceptArchive(input("entry-projection-legacy", {
      knowledge_candidates: [candidate],
      project_content_candidates: []
    }));
    const job = await pipeline.worker.startKnowledgeExtraction(
      receipt.knowledge_extraction_job_id
    );
    await pipeline.worker.completeKnowledgeExtraction({
      job_id: job.job_id,
      generation: job.generation,
      results: [resultDraft(candidate)]
    });

    const [stored] = await pipeline.queryKnowledge({
      project_id: "prj_06a",
      query: candidate.summary,
      limit: 10
    });
    expect(stored).toBeDefined();
    // 降级而不是发明：桥自己决定怎么处理一条没有分类的结果。
    expect(stored?.entry_type).toBeUndefined();
    expect(stored?.body).toBeUndefined();
    expect(stored?.keywords).toBeUndefined();
  });

  it("rejects conflicting metadata for one canonical immutable package", async () => {
    const { pipeline, archiveStore, jobRepository } = setup();
    const first = input("canonical-a", {
      archive_id: "arc_a",
      change_key: "change-a",
      project_version: "pv_a",
      knowledge_candidates: [],
      project_content_candidates: []
    });
    const firstReceipt = await pipeline.acceptArchive(first);
    const canonical = await archiveStore.getByArchiveId(firstReceipt.archive_id);
    expect(canonical).not.toBeNull();
    if (canonical === null) throw new Error("expected canonical archive");
    const conflicting = {
      ...canonical,
      archive_id: "arc_b",
      change_key: "change-b",
      project_version: "pv_b"
    };

    await expect(archiveStore.putIfAbsent(conflicting)).rejects.toMatchObject<
      Partial<KnowledgePipelineError>
    >({ reason_code: "ARCHIVE_CANONICAL_IDENTITY_CONFLICT", retryable: false });
    expect(archiveStore.recordCount()).toBe(1);
    expect(jobRepository.counts()).toMatchObject({ knowledge_extraction: 1 });
    const canonicalJob = await jobRepository.getKnowledgeJob(
      firstReceipt.knowledge_extraction_job_id
    );
    expect(canonicalJob).toMatchObject({
      project_id: canonical.project_id,
      change_key: canonical.change_key,
      archive_id: canonical.archive_id,
      package_sha256: canonical.package_sha256
    });
    expect(firstReceipt).toMatchObject({
      project_id: canonical.project_id,
      change_key: canonical.change_key,
      archive_id: canonical.archive_id,
      package_sha256: canonical.package_sha256
    });
  });

  it("uses the same canonical input hash for accept and planning recovery", async () => {
    const archiveStore = new MemoryArchiveStore();
    const firstRepository = new MemoryJobRepository();
    const knowledgeIndex = new MemoryKnowledgeIndex();
    const firstCommit = new MemoryKnowledgeCommitPort(firstRepository, knowledgeIndex);
    const firstPipeline = createKnowledgePipeline({
      archive_store: archiveStore,
      archive_validation: memoryArchiveValidationEvidence,
      job_repository: firstRepository,
      knowledge_index: knowledgeIndex,
      knowledge_commit: firstCommit,
      clock: () => now
    });
    const archive = input("input-hash", { project_content_candidates: [] });
    const accepted = await firstPipeline.acceptArchive(archive);
    const acceptedJob = await firstRepository.getKnowledgeJob(
      accepted.knowledge_extraction_job_id
    );

    const recoveredRepository = new MemoryJobRepository();
    const recoveredCommit = new MemoryKnowledgeCommitPort(
      recoveredRepository,
      knowledgeIndex
    );
    const recoveredPipeline = createKnowledgePipeline({
      archive_store: archiveStore,
      archive_validation: memoryArchiveValidationEvidence,
      job_repository: recoveredRepository,
      knowledge_index: knowledgeIndex,
      knowledge_commit: recoveredCommit,
      clock: () => now
    });
    const recovered = await recoveredPipeline.retryArchiveTaskPlanning({
      request_id: archiveRequestId("input-hash-recovery"),
      archive_id: archive.validated_package.archive_id,
      extractor_version: archive.extractor_version,
      prompt_version: archive.prompt_version,
      index_schema_version: archive.index_schema_version
    });
    const recoveredJob = await recoveredRepository.getKnowledgeJob(
      recovered.knowledge_extraction_job_id
    );

    expect(recoveredJob?.input_hash).toBe(acceptedJob?.input_hash);
  });

  it("loads the current fixture and returns durable archive plus queued split status", async () => {
    const fixture = JSON.parse(await readFile(
      new URL("./fixtures/knowledge-pipeline-v1-current.json", import.meta.url),
      "utf8"
    )) as ArchiveInputOverrides;
    const { pipeline, jobRepository } = setup();

    const receipt = await pipeline.acceptArchive(input("fixture", fixture));
    expect(archiveIngestReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(receipt.request_id).toBe(fixture.request_id);
    expect(receipt.idempotency_key).toBe(archiveUploadIdempotencyKey({
      project_id: receipt.project_id,
      change_key: receipt.change_key,
      archive_schema_version: 2,
      package_sha256: receipt.package_sha256
    }));
    const projection = await jobRepository.getChangeProjectionJob(
      receipt.change_projection_job_id
    );

    expect(receipt.archive_status).toEqual({
      status: "stored",
      updated_at: now,
      retryable: false
    });
    expect(receipt.knowledge_extraction_status).toEqual({
      status: "queued",
      updated_at: now,
      retryable: true
    });
    expect(receipt.change_projection_job_id).toMatch(/^job_change_/u);
    expect(projection).toMatchObject(fixture.expected_change_projection ?? {});
    expect(receipt.knowledge_extraction_job_id).toMatch(/^job_knowledge_/u);
    expect(receipt.project_content_job_id).toMatch(/^job_content_/u);
  });

  it("deduplicates an identical upload, task plan, and project candidate", async () => {
    const { pipeline, archiveStore, jobRepository } = setup();
    const archive = input("a");

    const first = await pipeline.acceptArchive(archive);
    const duplicate = await pipeline.acceptArchive(archive);

    expect(duplicate).toEqual(first);
    expect(archiveStore.recordCount()).toBe(1);
    expect(jobRepository.counts()).toEqual({
      change_projection: 1,
      knowledge_extraction: 1,
      project_content_governance: 1,
      project_content_candidates: 1
    });
  });

  it("uses package and all extractor protocol versions as the enqueue identity", async () => {
    const { pipeline, jobRepository } = setup();
    const receipt = await pipeline.acceptArchive(input("versions", {
      project_content_candidates: []
    }));

    const same = await pipeline.enqueueKnowledgeExtraction({
      archive_id: receipt.archive_id,
      extractor_version: "extractor-v1",
      prompt_version: "prompt-v1",
      index_schema_version: "knowledge-index-v1"
    });
    const upgraded = await pipeline.enqueueKnowledgeExtraction({
      archive_id: receipt.archive_id,
      extractor_version: "extractor-v1",
      prompt_version: "prompt-v1",
      index_schema_version: "knowledge-index-v2"
    });

    expect(same.job_id).toBe(receipt.knowledge_extraction_job_id);
    expect(upgraded.job_id).not.toBe(same.job_id);
    expect(upgraded.generation).toBeGreaterThan(same.generation);
    expect(upgraded.package_sha256).toBe(same.package_sha256);
    expect(jobRepository.counts()).toMatchObject({
      change_projection: 1,
      knowledge_extraction: 2,
      project_content_governance: 0
    });
  });

  it("binds package and task identities to the manifest project", async () => {
    const { pipeline, jobRepository } = setup();
    const first = input("tenant-a", {
      project_id: "prj_tenant_a",
      knowledge_candidates: [],
      project_content_candidates: []
    });
    const second = input("tenant-b", {
      project_id: "prj_tenant_b",
      knowledge_candidates: [],
      project_content_candidates: []
    });

    const firstReceipt = await pipeline.acceptArchive(first);
    const secondReceipt = await pipeline.acceptArchive(second);

    expect(firstReceipt.idempotency_key).not.toBe(secondReceipt.idempotency_key);
    expect(firstReceipt.knowledge_extraction_job_id).not.toBe(
      secondReceipt.knowledge_extraction_job_id
    );
    expect(jobRepository.counts()).toMatchObject({
      change_projection: 2,
      knowledge_extraction: 2
    });
  });

  it("keeps archive durable and exposes failed knowledge status when atomic planning is full", async () => {
    const { pipeline, archiveStore, jobRepository } = setup({
      max_queued_project_content_jobs: 0
    });

    const receipt = await pipeline.acceptArchive(input("b"));
    expect(archiveIngestReceiptSchema.parse(receipt)).toEqual(receipt);

    expect(receipt.archive_status.status).toBe("stored");
    expect(receipt.change_index_status).toEqual({
      status: "failed",
      updated_at: now,
      retryable: true,
      reason_code: "PIPELINE_QUEUE_CAPACITY_EXCEEDED"
    });
    expect(receipt.knowledge_extraction_status).toEqual({
      status: "failed",
      updated_at: now,
      retryable: true,
      reason_code: "PIPELINE_QUEUE_CAPACITY_EXCEEDED"
    });
    expect(receipt).not.toHaveProperty("knowledge_extraction_job_id");
    expect(archiveStore.recordCount()).toBe(1);
    expect(jobRepository.counts()).toEqual({
      change_projection: 0,
      knowledge_extraction: 0,
      project_content_governance: 0,
      project_content_candidates: 0
    });
  });

  it("retries a failed atomic plan from the durable CAS without storing the package again", async () => {
    const archiveStore = new MemoryArchiveStore();
    const fullRepository = new MemoryJobRepository({ max_queued_knowledge_jobs: 0 });
    const knowledgeIndex = new MemoryKnowledgeIndex();
    const firstCommit = new MemoryKnowledgeCommitPort(fullRepository, knowledgeIndex);
    const firstPipeline = createKnowledgePipeline({
      archive_store: archiveStore,
      archive_validation: memoryArchiveValidationEvidence,
      job_repository: fullRepository,
      knowledge_index: knowledgeIndex,
      knowledge_commit: firstCommit,
      clock: () => now
    });
    const failed = await firstPipeline.acceptArchive(input("plan-retry", {
      project_content_candidates: []
    }));
    expect(failed.knowledge_extraction_status.status).toBe("failed");

    const recoveredRepository = new MemoryJobRepository();
    const recoveredCommit = new MemoryKnowledgeCommitPort(
      recoveredRepository,
      knowledgeIndex
    );
    const recoveredPipeline = createKnowledgePipeline({
      archive_store: archiveStore,
      archive_validation: memoryArchiveValidationEvidence,
      job_repository: recoveredRepository,
      knowledge_index: knowledgeIndex,
      knowledge_commit: recoveredCommit,
      clock: () => now
    });
    const recovered = await recoveredPipeline.retryArchiveTaskPlanning({
      request_id: archiveRequestId("plan-retry-2"),
      archive_id: "arc_plan-retry",
      extractor_version: "extractor-v1",
      prompt_version: "prompt-v1",
      index_schema_version: "knowledge-index-v1"
    });

    expect(recovered.archive_status.status).toBe("stored");
    expect(recovered.knowledge_extraction_status.status).toBe("queued");
    expect(archiveStore.recordCount()).toBe(1);
    expect(recoveredRepository.plannedArchiveAttempts()).toBe(1);
  });

  it("rejects a reused archive identity when package metadata conflicts", async () => {
    const { pipeline, archiveStore } = setup();
    const original = input("identity-conflict");
    await pipeline.acceptArchive(original);

    await expect(pipeline.acceptArchive(input("identity-conflict-other", {
      archive_id: "arc_identity-conflict"
    }))).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "ARCHIVE_IDENTITY_CONFLICT",
      retryable: false
    });
    expect(archiveStore.recordCount()).toBe(1);
  });

  it("rejects package or manifest bytes that do not match their declared hash", async () => {
    const { pipeline, archiveStore } = setup();
    const archive = input("hash-mismatch");
    archive.validated_package.package_bytes[0] =
      (archive.validated_package.package_bytes[0] ?? 0) ^ 0xff;

    await expect(pipeline.acceptArchive(archive)).rejects.toMatchObject<
      Partial<KnowledgePipelineError>
    >({
      reason_code: "ARCHIVE_HASH_MISMATCH",
      retryable: false
    });
    expect(archiveStore.recordCount()).toBe(0);
  });

  it("strictly separates knowledge candidates from governed project content", async () => {
    const { pipeline } = setup();
    const knowledge = knowledgeCandidate("split");
    const rule = projectCandidate("rule", "rule");
    const architecture = projectCandidate("architecture", "architecture-decision");
    const receipt = await pipeline.acceptArchive(input("split", {
      knowledge_candidates: [{ ...knowledge, source_change_key: "change-split" }],
      project_content_candidates: [
        { ...rule, source_change_key: "change-split" },
        { ...architecture, source_change_key: "change-split" }
      ]
    }));

    const job = await pipeline.worker.startKnowledgeExtraction(
      receipt.knowledge_extraction_job_id
    );
    expect(job.knowledge_candidates).toEqual([
      { ...knowledge, source_change_key: "change-split" }
    ]);

    const page = await pipeline.listRuleCandidates({
      project_id: "prj_06a",
      limit: 10
    });
    expect(page.items).toEqual([{
      ...rule,
      source_change_key: "change-split",
      provenance: { ...rule.provenance, source_ref: "arc_split" }
    }]);
  });

  it("queries only active knowledge entries through a bounded index query", async () => {
    const { pipeline, knowledgeIndex } = setup();
    await pipeline.queryKnowledge({ project_id: "prj_06a", query: "fence", limit: 7 });

    expect(knowledgeIndex.lastQuery()).toEqual({
      project_id: "prj_06a",
      content_kind: "knowledge_entry",
      status: "active",
      query: "fence",
      limit: 7
    });
    expect(knowledgeIndex.queryCount()).toBe(1);
  });

  it("allows a successful extraction with zero results", async () => {
    const { pipeline } = setup();
    const archive = input("zero", {
      knowledge_candidates: []
    });
    const receipt = await pipeline.acceptArchive(archive);
    const job = await pipeline.worker.startKnowledgeExtraction(
      receipt.knowledge_extraction_job_id
    );

    const completed = await pipeline.worker.completeKnowledgeExtraction({
      job_id: receipt.knowledge_extraction_job_id,
      generation: job.generation,
      results: []
    });

    expect(completed.status).toBe("ready");
    expect(completed.result_count).toBe(0);
    const replay = await pipeline.acceptArchive(archive);
    expect(archiveIngestReceiptSchema.parse(replay)).toEqual(replay);
    expect(replay.knowledge_extraction_status.status).toBe("ready");
  });

  it("accepts one to twenty quality results and rejects a twenty-first", async () => {
    const { pipeline } = setup();
    const candidates = Array.from({ length: 21 }, (_, index) =>
      ({
        ...knowledgeCandidate(`quality-${index}`, hash(String(index))),
        source_change_key: "change-quality"
      })
    );
    const receipt = await pipeline.acceptArchive(input("quality", {
      knowledge_candidates: candidates
    }));
    const job = await pipeline.worker.startKnowledgeExtraction(
      receipt.knowledge_extraction_job_id
    );

    await expect(pipeline.worker.completeKnowledgeExtraction({
      job_id: receipt.knowledge_extraction_job_id,
      generation: job.generation,
      results: candidates.map((candidate) => resultDraft(candidate))
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "KNOWLEDGE_RESULT_LIMIT_EXCEEDED",
      retryable: false
    });

    const failed = await pipeline.worker.failKnowledgeExtraction({
      job_id: receipt.knowledge_extraction_job_id,
      generation: job.generation,
      reason_code: "KNOWLEDGE_QUALITY_GATE_FAILED",
      retryable: true
    });
    expect(failed.status).toBe("failed");

    const fiveCandidates = candidates.slice(0, 5).map((candidate) => ({
      ...candidate,
      source_change_key: "change-quality-five"
    }));
    const fiveReceipt = await pipeline.acceptArchive(input("quality-five", {
      knowledge_candidates: fiveCandidates,
      project_content_candidates: []
    }));
    const fiveJob = await pipeline.worker.startKnowledgeExtraction(
      fiveReceipt.knowledge_extraction_job_id
    );
    const ready = await pipeline.worker.completeKnowledgeExtraction({
      job_id: fiveJob.job_id,
      generation: fiveJob.generation,
      results: fiveCandidates.map((candidate) => resultDraft(candidate))
    });
    expect(ready).toMatchObject({ status: "ready", result_count: 5 });
  });

  it("does not allow a worker to convert a project-content candidate into knowledge", async () => {
    const { pipeline } = setup();
    const receipt = await pipeline.acceptArchive(input("no-convert", {
      knowledge_candidates: [],
      project_content_candidates: [projectCandidate("no-convert")]
    }));
    const job = await pipeline.worker.startKnowledgeExtraction(
      receipt.knowledge_extraction_job_id
    );

    await expect(pipeline.worker.completeKnowledgeExtraction({
      job_id: receipt.knowledge_extraction_job_id,
      generation: job.generation,
      results: [{
        source_candidate_id: "pcc_no-convert",
        content_hash: hash("e"),
        display_title: "Not reusable knowledge",
        summary: "A rule is not knowledge",
        reusability_scope: "none",
        source_refs: ["candidates/project-content.json"],
        confidence: 1
      }]
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "KNOWLEDGE_SOURCE_CANDIDATE_INVALID"
    });
  });

  it("deduplicates equal knowledge content and merges its source identities", async () => {
    const { pipeline } = setup();
    const sharedHash = hash("7");
    const firstCandidate = knowledgeCandidate("dedupe-a", sharedHash);
    const secondCandidate = knowledgeCandidate("dedupe-b", sharedHash);

    for (const [id, candidate] of [["dedupe-a", firstCandidate], ["dedupe-b", secondCandidate]] as const) {
      const receipt = await pipeline.acceptArchive(input(id, {
        knowledge_candidates: [candidate],
        project_content_candidates: []
      }));
      const job = await pipeline.worker.startKnowledgeExtraction(
        receipt.knowledge_extraction_job_id
      );
      await pipeline.worker.completeKnowledgeExtraction({
        job_id: receipt.knowledge_extraction_job_id,
        generation: job.generation,
        results: [resultDraft(candidate)]
      });
    }

    const results = await pipeline.queryKnowledge({
      project_id: "prj_06a",
      query: "Reusable",
      limit: 10
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.display_title).toBe("Knowledge kc_dedupe-b");
    expect(results[0]?.source_archive_ids).toEqual(["arc_dedupe-a", "arc_dedupe-b"]);
    expect(results[0]?.source_candidate_ids).toEqual(["kc_dedupe-a", "kc_dedupe-b"]);
  });

  it("prevents an older generation from overwriting newer indexed content", async () => {
    const { pipeline } = setup();
    const sharedHash = hash("6");
    const oldCandidate = knowledgeCandidate("old", sharedHash);
    const newCandidate = knowledgeCandidate("new", sharedHash);
    const oldReceipt = await pipeline.acceptArchive(input("old", {
      knowledge_candidates: [oldCandidate],
      project_content_candidates: []
    }));
    const newReceipt = await pipeline.acceptArchive(input("new", {
      knowledge_candidates: [newCandidate],
      project_content_candidates: []
    }));
    const oldJob = await pipeline.worker.startKnowledgeExtraction(
      oldReceipt.knowledge_extraction_job_id
    );
    const newJob = await pipeline.worker.startKnowledgeExtraction(
      newReceipt.knowledge_extraction_job_id
    );
    await pipeline.worker.completeKnowledgeExtraction({
      job_id: newReceipt.knowledge_extraction_job_id,
      generation: newJob.generation,
      results: [resultDraft(newCandidate, { summary: "new generation" })]
    });
    await expect(pipeline.worker.completeKnowledgeExtraction({
      job_id: oldReceipt.knowledge_extraction_job_id,
      generation: oldJob.generation,
      results: [resultDraft(oldCandidate, { summary: "old generation" })]
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "KNOWLEDGE_PROJECT_GENERATION_STALE"
    });

    const results = await pipeline.queryKnowledge({
      project_id: "prj_06a",
      query: "generation",
      limit: 10
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.summary).toBe("new generation");
    expect(results[0]?.generation).toBeGreaterThan(1);
  });

  it("rejects any older project generation before index mutation", async () => {
    const { pipeline, jobRepository } = setup();
    const oldCandidate = knowledgeCandidate("project-fence-old", hash("project-fence-old"));
    const newCandidate = knowledgeCandidate("project-fence-new", hash("project-fence-new"));
    const oldReceipt = await pipeline.acceptArchive(input("project-fence-old", {
      knowledge_candidates: [oldCandidate],
      project_content_candidates: []
    }));
    const oldJob = await pipeline.worker.startKnowledgeExtraction(
      oldReceipt.knowledge_extraction_job_id
    );
    const newReceipt = await pipeline.acceptArchive(input("project-fence-new", {
      knowledge_candidates: [newCandidate],
      project_content_candidates: []
    }));

    await expect(pipeline.worker.completeKnowledgeExtraction({
      job_id: oldJob.job_id,
      generation: oldJob.generation,
      results: [resultDraft(oldCandidate)]
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "KNOWLEDGE_PROJECT_GENERATION_STALE"
    });
    await expect(pipeline.queryKnowledge({
      project_id: "prj_06a",
      query: "project-fence-old",
      limit: 10
    })).resolves.toEqual([]);
    await expect(jobRepository.getKnowledgeJob(oldJob.job_id)).resolves.toMatchObject({
      status: "extracting",
      generation: oldJob.generation
    });

    const newJob = await pipeline.worker.startKnowledgeExtraction(
      newReceipt.knowledge_extraction_job_id
    );
    await pipeline.worker.completeKnowledgeExtraction({
      job_id: newJob.job_id,
      generation: newJob.generation,
      results: [resultDraft(newCandidate)]
    });
    await expect(pipeline.queryKnowledge({
      project_id: "prj_06a",
      query: "project-fence-new",
      limit: 10
    })).resolves.toHaveLength(1);

    const otherCandidate = knowledgeCandidate("other-project", hash("other-project"));
    const otherReceipt = await pipeline.acceptArchive(input("other-project", {
      project_id: "prj_other",
      knowledge_candidates: [otherCandidate],
      project_content_candidates: []
    }));
    const otherJob = await pipeline.worker.startKnowledgeExtraction(
      otherReceipt.knowledge_extraction_job_id
    );
    await pipeline.worker.completeKnowledgeExtraction({
      job_id: otherJob.job_id,
      generation: otherJob.generation,
      results: [resultDraft(otherCandidate)]
    });
    await expect(pipeline.queryKnowledge({
      project_id: "prj_other",
      query: "other-project",
      limit: 10
    })).resolves.toHaveLength(1);
  });

  it("retries only retryable failed jobs without changing archive or package identity", async () => {
    const { pipeline, archiveStore } = setup();
    const receipt = await pipeline.acceptArchive(input("retry", {
      project_content_candidates: []
    }));

    await expect(pipeline.retryKnowledgeExtraction(
      receipt.knowledge_extraction_job_id
    )).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "KNOWLEDGE_RETRY_STATE_INVALID"
    });

    const job = await pipeline.worker.startKnowledgeExtraction(
      receipt.knowledge_extraction_job_id
    );
    await pipeline.worker.failKnowledgeExtraction({
      job_id: receipt.knowledge_extraction_job_id,
      generation: job.generation,
      reason_code: "KNOWLEDGE_MODEL_UNAVAILABLE",
      retryable: true
    });
    const retried = await pipeline.retryKnowledgeExtraction(
      receipt.knowledge_extraction_job_id
    );
    expect(retried).toMatchObject({
      archive_id: "arc_retry",
      package_sha256: receipt.package_sha256,
      status: "queued",
      attempt: 2,
      retryable: true
    });
    expect(await archiveStore.getByArchiveId("arc_retry")).toMatchObject({
      archive_id: "arc_retry",
      package_sha256: receipt.package_sha256
    });

    await pipeline.worker.startKnowledgeExtraction(retried.job_id);
    await expect(pipeline.worker.completeKnowledgeExtraction({
      job_id: retried.job_id,
      generation: job.generation,
      results: []
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "KNOWLEDGE_JOB_GENERATION_STALE"
    });
  });

  it("allows idempotent duplicate worker completion only for the same generation and output", async () => {
    const { pipeline } = setup();
    const candidate = knowledgeCandidate("complete-replay");
    const receipt = await pipeline.acceptArchive(input("complete-replay", {
      knowledge_candidates: [candidate],
      project_content_candidates: []
    }));
    const job = await pipeline.worker.startKnowledgeExtraction(receipt.knowledge_extraction_job_id);
    const completion = {
      job_id: job.job_id,
      generation: job.generation,
      results: [resultDraft(candidate)]
    };

    const [first, duplicate] = await Promise.all([
      pipeline.worker.completeKnowledgeExtraction(completion),
      pipeline.worker.completeKnowledgeExtraction(completion)
    ]);
    expect(duplicate).toEqual(first);

    await expect(pipeline.worker.completeKnowledgeExtraction({
      ...completion,
      results: [resultDraft(candidate, { summary: "different output" })]
    })).rejects.toMatchObject<Partial<KnowledgePipelineError>>({
      reason_code: "KNOWLEDGE_COMPLETE_CONFLICT"
    });
  });

  it("uses stable opaque pagination with storage-level rule/status filtering and limit", async () => {
    const { pipeline, jobRepository } = setup();
    for (const id of ["page-a", "page-b", "page-c"]) {
      await pipeline.acceptArchive(input(id, {
        knowledge_candidates: [],
        project_content_candidates: [projectCandidate(id)]
      }));
    }

    const first = await pipeline.listRuleCandidates({ project_id: "prj_06a", limit: 2 });
    const second = await pipeline.listRuleCandidates({
      project_id: "prj_06a",
      cursor: first.next_cursor,
      limit: 2
    });

    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((item) => item.candidate_id)).size).toBe(3);
    expect(jobRepository.lastCandidateQuery()).toMatchObject({
      project_id: "prj_06a",
      candidate_type: "rule",
      status: "pending",
      limit: 2
    });
  });

  it("does not infer split knowledge status from the legacy receipt", async () => {
    const legacy = JSON.parse(await readFile(
      new URL("./fixtures/knowledge-pipeline-v0-legacy.json", import.meta.url),
      "utf8"
    ));

    const compatibility = getLegacyArchiveCompatibilityResult(legacy);
    expect(compatibility.archive_status.value.status).toBe("stored");
    expect(compatibility.knowledge_extraction_status).toEqual({
      availability: "unavailable",
      reason_code: "LEGACY_KNOWLEDGE_EXTRACTION_STATUS_UNAVAILABLE"
    });
  });
});
