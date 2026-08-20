import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";

import {
  MemoryArchiveStore,
  MemoryChangeDocumentIndex,
  MemoryChangeProjectionCommitPort,
  MemoryJobRepository,
  MemoryKnowledgeCommitPort,
  MemoryKnowledgeIndex,
  changeProjectionInputHash,
  createKnowledgePipeline,
  memoryArchiveValidationEvidence,
  validateArchivePackage,
  validateCoreV1ArchivePackage
} from "../src/knowledge-pipeline/index.js";
import { KnowledgePipelineError } from "../src/knowledge-pipeline/errors.js";
import {
  createArchivePackageVerifier,
  createChangeProjectionWorker,
  type ChangeProjectionWorkerResult
} from "../src/change-projection-worker/index.js";

const now = "2026-08-13T01:00:00.000Z";
const verificationLimits = {
  max_package_bytes: 1024 * 1024,
  max_file_count: 32,
  max_file_bytes: 256 * 1024,
  max_uncompressed_bytes: 1024 * 1024,
  max_compression_ratio: 100
};
const hash = (value: Uint8Array | string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
}

function archiveInput(id: string, options: { packageSchema?: number; corruptAfterValidation?: boolean } = {}) {
  const projectId = "prj_worker";
  const changeKey = `change-${id}`;
  const archiveId = `arc_${id}`;
  const files = new Map<string, Buffer>([
    ["summary/change-summary.json", Buffer.from(JSON.stringify({ outcome: "completed" }))],
    ["spec/design.md", Buffer.from("# Design\n")],
    ["plans/implementation.md", Buffer.from("# Plan\n")],
    [`plans/${changeKey}-test-scenarios.md`, Buffer.from("# Test scenarios\n")],
    ["attestations/verification.json", Buffer.from("{\"verified\":true}")],
    ["candidates/knowledge.json", Buffer.from("[]")],
    ["candidates/project-content.json", Buffer.from("[]")]
  ]);
  const manifest = {
    schema_version: 2,
    project_id: projectId,
    change_key: changeKey,
    archive_id: archiveId,
    project_version: `pv_${id}`,
    package_schema_version: options.packageSchema ?? 2,
    archive_schema_version: 2,
    file_count: files.size,
    files: [...files].map(([path, content]) => ({
      path,
      content_sha256: hash(content),
      size_bytes: content.byteLength
    }))
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const zip = new AdmZip();
  for (const [path, content] of files) zip.addFile(path, content);
  zip.addFile("archive-manifest.json", manifestBytes);
  const validated = validateArchivePackage({
    package_bytes: zip.toBuffer(),
    manifest_bytes: manifestBytes,
    limits: {
      max_package_bytes: 1024 * 1024,
      max_file_count: 32,
      max_file_bytes: 256 * 1024,
      max_uncompressed_bytes: 1024 * 1024,
      max_compression_ratio: 100
    },
    validated_at: now
  });
  if (options.corruptAfterValidation) validated.package_bytes[0] = 0;
  return {
    schema_version: 1 as const,
    request_id: `archive_request:${createHash("sha256").update(id).digest("hex")}`,
    validated_package: validated,
    extractor_version: "extractor-v1",
    prompt_version: "prompt-v1",
    index_schema_version: "index-v1"
  };
}

/** A package shaped exactly like harness_archive.py's output. */
async function setupCoreV1(validatedAt = now) {
  const identity = {
    project_id: "prj_worker",
    change_key: "change-core-v1",
    archive_id: "arc_core_v1",
    project_version: "pv_core_v1"
  };
  const files = new Map<string, Buffer>([
    ["archive-meta.md", Buffer.from("# meta\n")],
    ["candidates/knowledge.json", Buffer.from("[]")],
    ["change-context.json", Buffer.from("{}")],
    ["plans/implementation.md", Buffer.from("# Plan\n")],
    ["reports/final/summary-data.json", Buffer.from(JSON.stringify({
      changeName: "change-core-v1",
      baseCommit: "54a1f26fb33695d2d0e6c06e9d1743bd17115169",
      finalStatus: "WARN"
    }))],
    ["spec/design.md", Buffer.from("# Design\n")]
  ]);
  const manifest = {
    schema_version: 1,
    profile: "core-v1",
    change_key: identity.change_key,
    created_at: "2026-08-18T00:00:00.000Z",
    source: { commit: "a".repeat(40), tree: "b".repeat(40) },
    files: [...files].map(([path, content]) => ({
      path,
      role: path === "reports/final/summary-data.json" ? "summary"
        : path === "candidates/knowledge.json" ? "knowledge_candidates"
        : path === "archive-meta.md" ? "archive_meta"
        : path === "change-context.json" ? "change_context"
        : path.startsWith("spec/") ? "spec" : "plan",
      media_type: path.endsWith(".json") ? "application/json" : "text/markdown",
      content_sha256: hash(content),
      size_bytes: content.byteLength
    }))
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const zip = new AdmZip();
  for (const [path, content] of files) zip.addFile(path, content);
  zip.addFile("archive-manifest.json", manifestBytes);
  const validated = validateCoreV1ArchivePackage({
    package_bytes: zip.toBuffer(),
    manifest_bytes: manifestBytes,
    identity,
    limits: {
      max_package_bytes: 1024 * 1024,
      max_file_count: 32,
      max_file_bytes: 256 * 1024,
      max_uncompressed_bytes: 1024 * 1024,
      max_compression_ratio: 100
    },
    validated_at: validatedAt
  });

  const archiveStore = new MemoryArchiveStore();
  const taskPort = new MemoryJobRepository();
  const stored = {
    ...validated,
    package_bytes: validated.package_bytes.slice(),
    manifest_bytes: validated.manifest_bytes.slice(),
    stored_at: now
  };
  await archiveStore.putIfAbsent(stored);
  const planned = await taskPort.planArchiveTasks({
    archive: stored,
    idempotency_key: hash("worker:core-v1"),
    extractor_version: "extractor-v1",
    prompt_version: "prompt-v1",
    index_schema_version: "index-v1",
    change_projection_input_hash: changeProjectionInputHash({
      schema_version: stored.schema_version,
      project_id: stored.project_id,
      change_key: stored.change_key,
      archive_id: stored.archive_id,
      package_sha256: stored.package_sha256,
      manifest_sha256: stored.manifest_sha256,
      project_version: stored.project_version,
      package_schema_version: stored.package_schema_version,
      archive_schema_version: stored.archive_schema_version
    }),
    input_hash: hash("knowledge:core-v1"),
    now
  });
  const documents = new MemoryChangeDocumentIndex();
  const worker = createChangeProjectionWorker({
    task_port: taskPort,
    archive_store: archiveStore,
    commit_port: new MemoryChangeProjectionCommitPort(taskPort, documents),
    archive_verifier: createArchivePackageVerifier(),
    verification_limits: verificationLimits,
    clock: () => now,
    lease_duration_ms: 300_000
  });
  return {
    worker,
    documents,
    receipt: {
      change_projection_job_id: planned.change_projection_job_id,
      project_id: stored.project_id
    }
  };
}

async function setup(id: string, options: { packageSchema?: number } = {}) {
  const archiveStore = new MemoryArchiveStore();
  const taskPort = new MemoryJobRepository();
  const accepted = archiveInput(id, options).validated_package;
  const stored = {
    ...accepted,
    package_bytes: accepted.package_bytes.slice(),
    manifest_bytes: accepted.manifest_bytes.slice(),
    stored_at: now
  };
  await archiveStore.putIfAbsent(stored);
  const projectionInput = {
    schema_version: stored.schema_version,
    project_id: stored.project_id,
    change_key: stored.change_key,
    archive_id: stored.archive_id,
    package_sha256: stored.package_sha256,
    manifest_sha256: stored.manifest_sha256,
    project_version: stored.project_version,
    package_schema_version: stored.package_schema_version,
    archive_schema_version: stored.archive_schema_version
  };
  const planned = await taskPort.planArchiveTasks({
    archive: stored,
    idempotency_key: hash(`worker:${id}`),
    extractor_version: "extractor-v1",
    prompt_version: "prompt-v1",
    index_schema_version: "index-v1",
    change_projection_input_hash: changeProjectionInputHash(projectionInput),
    input_hash: hash(`knowledge:${id}`),
    now
  });
  const receipt = {
    change_projection_job_id: planned.change_projection_job_id,
    project_id: stored.project_id,
    archive_id: stored.archive_id,
    package_sha256: stored.package_sha256
  };
  const documents = new MemoryChangeDocumentIndex();
  const commitPort = new MemoryChangeProjectionCommitPort(taskPort, documents);
  const worker = createChangeProjectionWorker({
    task_port: taskPort,
    archive_store: archiveStore,
    commit_port: commitPort,
    archive_verifier: createArchivePackageVerifier(),
    verification_limits: verificationLimits,
    clock: () => now,
    lease_duration_ms: 300_000
  });
  return { worker, receipt, taskPort, documents, archiveStore, commitPort };
}

describe("ChangeProjectionWorker", () => {
  it("projects only canonical change documents with stable identities", async () => {
    const { worker, receipt, documents, taskPort } = await setup("current");
    expect(await taskPort.listQueuedKnowledgeJobs(10)).toHaveLength(0);
    const result = await worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" });
    expect(await taskPort.listQueuedKnowledgeJobs(10)).toHaveLength(1);
    const expected = await fixture("change-projection-worker-v1-current.json");
    expect(result).toMatchObject<Partial<ChangeProjectionWorkerResult>>({ status: "ready", document_count: 4 });
    expect(documents.snapshot(receipt.project_id).map(({ source_path, document_type }) => ({ source_path, document_type }))
      .sort((left, right) => left.source_path < right.source_path ? -1 : 1))
      .toEqual(expected.documents);
  });

  it("projects the core-v1 package the production archiver emits", async () => {
    // 端到端回归：生产归档包此前在 v2 校验器第一道闸就被拒，队列从未收到作业。
    // 这条测试从"包字节"一路走到"change document 落库"。
    const { worker, receipt, documents } = await setupCoreV1();
    const result = await worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" });

    expect(result).toMatchObject<Partial<ChangeProjectionWorkerResult>>({ status: "ready" });
    const projected = documents.snapshot(receipt.project_id)
      .map(({ source_path, document_type }) => ({ source_path, document_type }))
      .sort((left, right) => (left.source_path < right.source_path ? -1 : 1));
    expect(projected).toEqual([
      { source_path: "plans/implementation.md", document_type: "plan" },
      // 入库桥要靠这份文档取溯源；core-v1 把它放在 reports/final 下。
      { source_path: "reports/final/summary-data.json", document_type: "change_summary" },
      { source_path: "spec/design.md", document_type: "design" }
    ]);
  });

  it("accepts fresh revalidation evidence when the worker runs after archive upload", async () => {
    const { worker, receipt } = await setupCoreV1("2026-08-18T00:00:00.000Z");
    await expect(worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" }))
      .resolves.toMatchObject({ status: "ready" });
  });

  it("replays a ready output without reading or publishing again", async () => {
    const { worker, receipt, documents } = await setup("replay");
    const first = await worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" });
    const second = await worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" });
    expect(second).toEqual(first);
    expect(documents.snapshot(receipt.project_id)).toHaveLength(4);
  });

  it("fails legacy packages read-only and preserves the durable archive", async () => {
    const legacy = await fixture("change-projection-worker-v0-legacy.json");
    const { worker, receipt, taskPort, archiveStore } = await setup("legacy", { packageSchema: 1 });
    const result = await worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" });
    expect(result).toMatchObject({ status: "failed", reason_code: legacy.reason_code, retryable: false });
    expect(await archiveStore.getByArchiveId(receipt.archive_id)).not.toBeNull();
    expect(await taskPort.getChangeProjectionJob(receipt.change_projection_job_id)).toMatchObject({ status: "failed" });
  });

  it("rejects hostile run input and an invalid clock without invoking ports", async () => {
    let calls = 0;
    const port = new Proxy({}, { get() { calls += 1; throw new Error("executed"); } });
    const worker = createChangeProjectionWorker({
      task_port: port as never,
      archive_store: port as never,
      commit_port: port as never,
      archive_verifier: createArchivePackageVerifier(),
      verification_limits: verificationLimits,
      clock: () => "2026-02-30T01:00:00.000Z",
      lease_duration_ms: 1
    });
    const hostile = new Proxy({}, { get() { calls += 1; throw new Error("executed"); } });
    await expect(worker.run(hostile as never)).rejects.toMatchObject({ reason_code: "CHANGE_PROJECTION_WORKER_INPUT_INVALID" });
    await expect(worker.run({ job_id: "job", owner_id: "owner" })).rejects.toMatchObject({ reason_code: "CHANGE_PROJECTION_CLOCK_INVALID" });
    expect(calls).toBe(0);
  });

  it("fails closed when the stored package no longer matches its validated identity", async () => {
    const { receipt, archiveStore, taskPort, commitPort, documents } = await setup("tamper");
    const archive = await archiveStore.getByArchiveId(receipt.archive_id);
    if (archive === null) throw new Error("archive missing");
    archive.package_bytes[0] = 0;
    const worker = createChangeProjectionWorker({
      task_port: taskPort,
      archive_store: {
        putIfAbsent: (value) => archiveStore.putIfAbsent(value),
        getByArchiveId: async () => archive
      },
      commit_port: commitPort,
      archive_verifier: createArchivePackageVerifier(),
      verification_limits: verificationLimits,
      clock: () => now,
      lease_duration_ms: 300_000
    });
    expect(await worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" }))
      .toMatchObject({ status: "failed", reason_code: "CHANGE_PROJECTION_PACKAGE_VERIFICATION_FAILED" });
    expect(documents.snapshot(receipt.project_id)).toEqual([]);
    expect(await archiveStore.getByArchiveId(receipt.archive_id)).not.toBeNull();
  });

  it("retries a transient atomic commit failure without changing archive identity", async () => {
    const { receipt, archiveStore, taskPort, documents } = await setup("retry-worker");
    const realCommit = new MemoryChangeProjectionCommitPort(taskPort, documents);
    let attempts = 0;
    const worker = createChangeProjectionWorker({
      task_port: taskPort,
      archive_store: archiveStore,
      commit_port: {
        async commitChangeProjection(input) {
          attempts += 1;
          if (attempts === 1) {
            throw new KnowledgePipelineError("CHANGE_DOCUMENT_STORE_UNAVAILABLE", true);
          }
          return realCommit.commitChangeProjection(input);
        }
      },
      archive_verifier: createArchivePackageVerifier(),
      verification_limits: verificationLimits,
      clock: () => now,
      lease_duration_ms: 300_000
    });
    expect(await worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" }))
      .toMatchObject({ status: "failed", retryable: true });
    expect(await worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-b" }))
      .toMatchObject({ status: "ready", document_count: 4 });
    expect(documents.snapshot(receipt.project_id)).toHaveLength(4);
    expect((await archiveStore.getByArchiveId(receipt.archive_id))?.package_sha256)
      .toBe(receipt.package_sha256);
  });

  it("fences an old archive after a newer project generation is planned", async () => {
    const { receipt, taskPort, documents, archiveStore, commitPort } = await setup("old-generation");
    const knowledgeIndex = new MemoryKnowledgeIndex();
    const pipeline = createKnowledgePipeline({
      archive_store: archiveStore,
      archive_validation: memoryArchiveValidationEvidence,
      job_repository: taskPort,
      knowledge_index: knowledgeIndex,
      knowledge_commit: new MemoryKnowledgeCommitPort(taskPort, knowledgeIndex),
      clock: () => now
    });
    let plannedNewer = false;
    const worker = createChangeProjectionWorker({
      task_port: taskPort,
      archive_store: {
        putIfAbsent: (value) => archiveStore.putIfAbsent(value),
        async getByArchiveId(archiveId) {
          const archive = await archiveStore.getByArchiveId(archiveId);
          if (!plannedNewer) {
            plannedNewer = true;
            await pipeline.acceptArchive(archiveInput("new-generation"));
          }
          return archive;
        }
      },
      commit_port: commitPort,
      archive_verifier: createArchivePackageVerifier(),
      verification_limits: verificationLimits,
      clock: () => now,
      lease_duration_ms: 300_000
    });
    await expect(worker.run({ job_id: receipt.change_projection_job_id, owner_id: "old-worker" }))
      .rejects.toMatchObject({ reason_code: "CHANGE_PROJECTION_PROJECT_GENERATION_STALE" });
    expect(documents.snapshot(receipt.project_id)).toEqual([]);
  });

  it("does not execute hostile archive objects returned by a port", async () => {
    const { receipt, taskPort, commitPort, documents, archiveStore } = await setup("hostile-archive");
    let traps = 0;
    const hostile = await archiveStore.getByArchiveId(receipt.archive_id);
    if (hostile === null) throw new Error("archive missing");
    Object.defineProperty(hostile, "validation_receipt", {
      enumerable: true,
      get() { traps += 1; throw new Error("executed"); }
    });
    const worker = createChangeProjectionWorker({
      task_port: taskPort,
      archive_store: { putIfAbsent: async () => { throw new Error("unused"); }, getByArchiveId: async () => hostile as never },
      commit_port: commitPort,
      archive_verifier: createArchivePackageVerifier(),
      verification_limits: verificationLimits,
      clock: () => now,
      lease_duration_ms: 300_000
    });
    expect(await worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" }))
      .toMatchObject({ status: "failed", reason_code: "CHANGE_PROJECTION_ARCHIVE_INVALID" });
    expect(traps).toBe(0);
    expect(documents.snapshot(receipt.project_id)).toEqual([]);
  });

  it("rejects hostile Task Port jobs without coercion or trap execution", async () => {
    const { receipt, taskPort, archiveStore, commitPort } = await setup("hostile-task");
    const ordinary = await taskPort.getChangeProjectionJob(receipt.change_projection_job_id);
    if (ordinary === null) throw new Error("job missing");
    let traps = 0;
    const hostileJobs: unknown[] = [
      { ...ordinary, status: new Proxy({}, { get() { traps += 1; throw new Error("executed"); } }) },
      Object.defineProperty({ ...ordinary }, "status", {
        enumerable: true,
        get() { traps += 1; return "queued"; }
      }),
      { ...ordinary, status: Symbol("queued") },
      Object.assign(Object.create(null), ordinary)
    ];
    for (const hostile of hostileJobs) {
      const worker = createChangeProjectionWorker({
        task_port: { ...taskPort, getChangeProjectionJob: async () => hostile as never } as never,
        archive_store: archiveStore,
        commit_port: commitPort,
        archive_verifier: createArchivePackageVerifier(),
        verification_limits: verificationLimits,
        clock: () => now,
        lease_duration_ms: 300_000
      });
      await expect(worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" }))
        .rejects.toMatchObject({ reason_code: "CHANGE_PROJECTION_PORT_INVALID" });
    }
    expect(traps).toBe(0);
  });

  it("uses fixed verifier limits and fails closed on verifier reject or receipt drift", async () => {
    for (const mode of ["reject", "drift"] as const) {
      const { receipt, taskPort, archiveStore, commitPort, documents } = await setup(`verifier-${mode}`);
      const realVerifier = createArchivePackageVerifier();
      let observedLimits: unknown;
      const worker = createChangeProjectionWorker({
        task_port: taskPort,
        archive_store: archiveStore,
        commit_port: commitPort,
        archive_verifier: {
          async verify(input) {
            observedLimits = input.limits;
            if (mode === "reject") throw new Error("rejected");
            const verified = await realVerifier.verify(input);
            return {
              ...verified,
              validation_receipt: {
                ...verified.validation_receipt,
                uncompressed_bytes: verified.validation_receipt.uncompressed_bytes + 1
              }
            };
          },
          isTrusted: () => true
        },
        verification_limits: verificationLimits,
        clock: () => now,
        lease_duration_ms: 300_000
      });
      expect(await worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" }))
        .toMatchObject({
          status: "failed",
          reason_code: "CHANGE_PROJECTION_PACKAGE_VERIFICATION_FAILED"
        });
      expect(observedLimits).toEqual(verificationLimits);
      expect(documents.snapshot(receipt.project_id)).toEqual([]);
    }
  });

  it("does not widen configured limits from persisted receipt sizes", async () => {
    const { receipt, taskPort, archiveStore, commitPort, documents } = await setup("resource-limit");
    const worker = createChangeProjectionWorker({
      task_port: taskPort,
      archive_store: archiveStore,
      commit_port: commitPort,
      archive_verifier: createArchivePackageVerifier(),
      verification_limits: { ...verificationLimits, max_package_bytes: 1 },
      clock: () => now,
      lease_duration_ms: 300_000
    });
    expect(await worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" }))
      .toMatchObject({
        status: "failed",
        reason_code: "CHANGE_PROJECTION_PACKAGE_VERIFICATION_FAILED"
      });
    expect(documents.snapshot(receipt.project_id)).toEqual([]);
  });

  it("rejects non-scalar and inconsistent persisted validation receipts", async () => {
    for (const [index, [drift, reasonCode]] of ([
      [{ file_count: -1 }, "CHANGE_PROJECTION_ARCHIVE_INVALID"],
      [{ file_count: 1 }, "CHANGE_PROJECTION_PACKAGE_VERIFICATION_FAILED"],
      [{ compressed_bytes: Number.MAX_SAFE_INTEGER + 1 }, "CHANGE_PROJECTION_ARCHIVE_INVALID"],
      [{ uncompressed_bytes: 0 }, "CHANGE_PROJECTION_ARCHIVE_INVALID"],
      [{ safe_paths: "true" }, "CHANGE_PROJECTION_ARCHIVE_INVALID"],
      [{ validated_at: "2026-02-30T01:00:00.000Z" }, "CHANGE_PROJECTION_ARCHIVE_INVALID"]
    ] as const).entries()) {
      const { receipt, taskPort, archiveStore, commitPort, documents } = await setup(
        `receipt-${index}`
      );
      const archive = await archiveStore.getByArchiveId(receipt.archive_id);
      if (archive === null) throw new Error("archive missing");
      const hostile = {
        ...archive,
        validation_receipt: { ...archive.validation_receipt, ...drift }
      };
      const worker = createChangeProjectionWorker({
        task_port: taskPort,
        archive_store: { putIfAbsent: (value) => archiveStore.putIfAbsent(value), getByArchiveId: async () => hostile as never },
        commit_port: commitPort,
        archive_verifier: createArchivePackageVerifier(),
        verification_limits: verificationLimits,
        clock: () => now,
        lease_duration_ms: 300_000
      });
      expect(await worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" }))
        .toMatchObject({ status: "failed", reason_code: reasonCode });
      expect(documents.snapshot(receipt.project_id)).toEqual([]);
    }
  });

  it("rejects semantic transition drift from every mutating Task/Commit Port", async () => {
    for (const operation of ["reap", "retry", "claim", "renew", "commit", "fail"] as const) {
      const { receipt, taskPort, archiveStore, commitPort, documents } = await setup(`transition-${operation}`);
      let laterSideEffects = 0;
      const mutate = (job: Awaited<ReturnType<typeof taskPort.getChangeProjectionJob>>) => {
        if (job === null) throw new Error("job missing");
        return { ...job, project_generation: job.project_generation + 1 };
      };
      if (operation === "reap" || operation === "retry") {
        const claimed = await taskPort.claimChangeProjectionJob({
          job_id: receipt.change_projection_job_id, owner_id: "expired", now,
          lease_expires_at: "2026-08-13T01:00:01.000Z"
        });
        await taskPort.reapExpiredChangeProjectionLease({
          job_id: claimed.job_id, generation: claimed.generation, now: "2026-08-13T01:00:01.000Z"
        });
        if (operation === "reap") {
          await taskPort.retryChangeProjectionJob({
            job_id: claimed.job_id, expected_generation: claimed.generation,
            expected_status: "failed", now
          });
          await taskPort.claimChangeProjectionJob({
            job_id: claimed.job_id, owner_id: "expired-again", now,
            lease_expires_at: "2026-08-13T01:00:01.000Z"
          });
        }
      }
      const wrappedTask = {
        getChangeProjectionJob: (id: string) => taskPort.getChangeProjectionJob(id),
        async reapExpiredChangeProjectionLease(input: never) {
          const value = await taskPort.reapExpiredChangeProjectionLease(input);
          return operation === "reap" ? mutate(value) : value;
        },
        async retryChangeProjectionJob(input: never) {
          const value = await taskPort.retryChangeProjectionJob(input);
          return operation === "retry" ? mutate(value) : value;
        },
        async claimChangeProjectionJob(input: never) {
          const value = await taskPort.claimChangeProjectionJob(input);
          return operation === "claim" ? mutate(value) : value;
        },
        async renewChangeProjectionLease(input: never) {
          const value = await taskPort.renewChangeProjectionLease(input);
          return operation === "renew" ? mutate(value) : value;
        },
        async failChangeProjectionJob(input: never) {
          laterSideEffects += 1;
          const value = await taskPort.failChangeProjectionJob(input);
          return operation === "fail" ? mutate(value) : value;
        }
      };
      const wrappedCommit = {
        async commitChangeProjection(input: never) {
          if (operation === "commit") {
            const current = await taskPort.getChangeProjectionJob((input as { job_id: string }).job_id);
            if (current === null) throw new Error("job missing");
            return mutate({
              ...current,
              status: "ready",
              output_hash: (input as { output_hash: string }).output_hash,
              document_count: (input as { documents: unknown[] }).documents.length,
              retryable: false,
              updated_at: (input as { now: string }).now
            });
          }
          return commitPort.commitChangeProjection(input);
        }
      };
      const verifier = operation === "fail"
        ? { verify: async () => { throw new Error("force fail"); }, isTrusted: () => false }
        : createArchivePackageVerifier();
      const worker = createChangeProjectionWorker({
        task_port: wrappedTask as never,
        archive_store: archiveStore,
        commit_port: wrappedCommit as never,
        archive_verifier: verifier as never,
        verification_limits: verificationLimits,
        clock: () => operation === "reap" ? "2026-08-13T01:00:01.000Z" : now,
        lease_duration_ms: 300_000
      });
      await expect(worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" }))
        .rejects.toMatchObject({ reason_code: "CHANGE_PROJECTION_PORT_INVALID" });
      if (operation !== "fail") expect(laterSideEffects).toBe(0);
      expect(documents.snapshot(receipt.project_id)).toEqual([]);
    }
  });

  it("rejects malformed jobs across all four states before later Port calls", async () => {
    const { receipt, taskPort } = await setup("state-matrix");
    const base = await taskPort.getChangeProjectionJob(receipt.change_projection_job_id);
    if (base === null) throw new Error("job missing");
    let getterCalls = 0;
    for (const malformed of [
      { ...base, status: "queued", owner_id: "owner", lease_token: "token", lease_expires_at: "2026-08-13T01:05:00.000Z" },
      { ...base, status: "projecting" },
      { ...base, status: "ready", retryable: false },
      { ...base, status: "failed", retryable: true },
      { ...base, status: "queued", output_hash: hash("forbidden"), document_count: 1 },
      { ...base, status: "ready", retryable: false, output_hash: hash("ready"), document_count: -1 },
      { ...base, status: "failed", reason_code: Symbol("bad") },
      Object.defineProperty({ ...base }, "reason_code", {
        enumerable: true,
        get() { getterCalls += 1; return "BAD"; }
      })
    ]) {
      let laterCalls = 0;
      const worker = createChangeProjectionWorker({
        task_port: {
          getChangeProjectionJob: async () => malformed as never,
          claimChangeProjectionJob: async () => { laterCalls += 1; throw new Error("called"); },
          renewChangeProjectionLease: async () => { laterCalls += 1; throw new Error("called"); },
          failChangeProjectionJob: async () => { laterCalls += 1; throw new Error("called"); },
          reapExpiredChangeProjectionLease: async () => { laterCalls += 1; throw new Error("called"); },
          retryChangeProjectionJob: async () => { laterCalls += 1; throw new Error("called"); }
        },
        archive_store: { putIfAbsent: async () => { throw new Error("unused"); }, getByArchiveId: async () => { laterCalls += 1; throw new Error("called"); } },
        commit_port: { commitChangeProjection: async () => { laterCalls += 1; throw new Error("called"); } },
        archive_verifier: createArchivePackageVerifier(),
        verification_limits: verificationLimits,
        clock: () => now,
        lease_duration_ms: 300_000
      });
      await expect(worker.run({ job_id: receipt.change_projection_job_id, owner_id: "worker-a" }))
        .rejects.toMatchObject({ reason_code: "CHANGE_PROJECTION_PORT_INVALID" });
      expect(laterCalls).toBe(0);
    }
    expect(getterCalls).toBe(0);
  });
});
