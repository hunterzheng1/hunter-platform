import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  PgArchiveStore,
  PgChangeProjectionCommitPort,
  PgJobRepository,
  PgKnowledgeCommitPort,
  PgKnowledgeIndex
} from "../src/knowledge-pipeline/pg.js";
import {
  changeDocumentIdentity,
  changeDocumentVersion,
  changeProjectionOutputHash
} from "../src/knowledge-pipeline/change-projection.js";

const now = "2026-08-13T01:00:00.000Z";
const hash = (value: Uint8Array | string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function archiveRow() {
  const packageBytes = Buffer.from("package-v1", "utf8");
  const manifestBytes = Buffer.from("manifest-v1", "utf8");
  const packageSha = hash(packageBytes);
  const manifestSha = hash(manifestBytes);
  return {
    archive_id: "arc_pg_fixture",
    project_id: "prj_pg_fixture",
    change_key: "change-pg-fixture",
    package_sha256: packageSha,
    manifest_sha256: manifestSha,
    project_version: "pv_pg_fixture",
    package_schema_version: 2,
    archive_schema_version: 2,
    package_bytes: packageBytes,
    manifest_bytes: manifestBytes,
    knowledge_candidates: [],
    project_content_candidates: [],
    validation_receipt: {
      schema_version: 1,
      package_sha256: packageSha,
      manifest_sha256: manifestSha,
      package_schema_version: 2,
      archive_schema_version: 2,
      safe_paths: true,
      no_symlinks: true,
      no_encrypted_entries: true,
      declared_files_verified: true,
      content_hashes_verified: true,
      candidate_sources_bound: true,
      file_count: 1,
      compressed_bytes: packageBytes.byteLength,
      uncompressed_bytes: packageBytes.byteLength,
      validated_at: now
    },
    stored_at: now
  };
}

function knowledgeJobRow() {
  return {
    job_id: "job_knowledge_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    idempotency_key: hash("idempotency"),
    project_id: "prj_pg_fixture",
    change_key: "change-pg-fixture",
    archive_id: "arc_pg_fixture",
    package_sha256: archiveRow().package_sha256,
    extractor_version: "extractor-v1",
    prompt_version: "prompt-v1",
    index_schema_version: "knowledge-index-v1",
    status: "queued",
    attempt: 1,
    generation: "1",
    input_hash: hash("input"),
    output_hash: null,
    result_count: null,
    retryable: true,
    reason_code: null,
    knowledge_candidates: [],
    created_at: now,
    updated_at: now
  };
}

function knowledgeResultRow() {
  return {
    project_id: "prj_pg_fixture",
    knowledge_id: "kn_pg_fixture",
    content_kind: "knowledge_entry",
    status: "active",
    content_hash: hash("knowledge-content"),
    display_title: "Durable generation fence",
    summary: "A durable generation fence protects retries.",
    reusability_scope: "server",
    confidence: 0.9,
    source_archive_ids: ["arc_pg_fixture"],
    source_change_keys: ["change-pg-fixture"],
    source_candidate_ids: ["candidate-pg-fixture"],
    source_refs: ["summary/change-summary.json#fence"],
    extractor_version: "extractor-v1",
    prompt_version: "prompt-v1",
    index_schema_version: "knowledge-index-v1",
    generation: "1",
    created_at: now,
    updated_at: now
  };
}

function knowledgeResultInput(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    ...knowledgeResultRow(),
    ...overrides
  };
}

function changeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    job_id: "job_change_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    project_id: "prj_pg_fixture",
    change_key: "change-pg-fixture",
    archive_id: "arc_pg_fixture",
    package_sha256: archiveRow().package_sha256,
    manifest_sha256: archiveRow().manifest_sha256,
    project_version: "pv_pg_fixture",
    package_schema_version: 2,
    archive_schema_version: 2,
    status: "projecting",
    attempt: 1,
    project_generation: "1",
    generation: "1",
    input_hash: hash("change-input"),
    owner_id: "worker-pg",
    lease_token: "lease-pg",
    lease_expires_at: "2026-08-13T01:30:00.000Z",
    output_hash: null,
    document_count: null,
    retryable: true,
    reason_code: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function projectCandidateRow(overrides: Record<string, unknown> = {}) {
  const candidate = {
    schema_version: 1,
    candidate_id: "pcc_pg_fixture",
    source_change_key: "change-pg-fixture",
    content_hash: hash("project-candidate"),
    confidence: 0.8,
    provenance: {
      source_kind: "archive",
      source_ref: "arc_pg_fixture",
      producer: "archive-engine",
      producer_version: "2",
      created_at: now
    },
    candidate_type: "rule",
    evidence_refs: ["attestations/verification.json#pg"],
    rationale: "A durable project rule.",
    proposed_content: "Use the durable project rule.",
    status: "pending"
  };
  return {
    project_id: "prj_pg_fixture",
    candidate_type: "rule",
    content_hash: candidate.content_hash,
    candidate_id: candidate.candidate_id,
    status: "pending",
    candidate,
    created_at: now,
    ...overrides
  };
}

function changeDocumentInput(overrides: Record<string, unknown> = {}) {
  const content = typeof overrides.content === "string" ? overrides.content : "# Durable design";
  const identity = {
    project_id: "prj_pg_fixture",
    change_key: "change-pg-fixture",
    document_type: "design",
    source_path: "spec/design.md"
  };
  const contentHash = hash(content);
  return {
    schema_version: 1,
    document_id: changeDocumentIdentity(identity),
    document_version: changeDocumentVersion(contentHash),
    project_id: identity.project_id,
    change_key: identity.change_key,
    archive_id: "arc_pg_fixture",
    package_sha256: archiveRow().package_sha256,
    project_version: "pv_pg_fixture",
    document_type: identity.document_type,
    source_path: identity.source_path,
    content_hash: contentHash,
    content,
    generation: 1,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function result(rows: readonly Record<string, unknown>[]) {
  return { rows: [...rows], rowCount: rows.length };
}

function readOnlyPool(handler: (text: string, values: unknown[] | undefined) => unknown): Pool {
  return { query: async (text: string, values?: unknown[]) => handler(text, values) } as unknown as Pool;
}

function scriptedPool(rows: readonly Record<string, unknown>[]): { pool: Pool; queries: string[] } {
  const queries: string[] = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return result([]);
      return result(rows);
    },
    release() { /* test client */ }
  };
  return { pool: { connect: async () => client } as unknown as Pool, queries };
}

function transactionPool(
  handler: (text: string, values: unknown[] | undefined) => { rows: Record<string, unknown>[]; rowCount: number }
): { pool: Pool; queries: string[] } {
  const queries: string[] = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      queries.push(text);
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return result([]);
      return handler(text, values);
    },
    release() { /* test client */ }
  };
  return { pool: { connect: async () => client } as unknown as Pool, queries };
}

function archiveInput(row: ReturnType<typeof archiveRow>) {
  return {
    schema_version: 1,
    project_id: row.project_id,
    change_key: row.change_key,
    archive_id: row.archive_id,
    package_sha256: row.package_sha256,
    manifest_sha256: row.manifest_sha256,
    project_version: row.project_version,
    package_schema_version: row.package_schema_version,
    archive_schema_version: row.archive_schema_version,
    package_bytes: row.package_bytes,
    manifest_bytes: row.manifest_bytes,
    knowledge_candidates: [],
    project_content_candidates: row.project_content_candidates,
    validation_receipt: row.validation_receipt,
    stored_at: row.stored_at
  };
}

function concurrentCapacityPool(rows: readonly Record<string, unknown>[]): {
  pool: Pool;
  firstCapacityLocked: Promise<void>;
  releaseFirstCapacity: () => void;
} {
  let active = 0;
  let owner: object | undefined;
  let firstSeen = false;
  let firstCapacityResolve: (() => void) | undefined;
  let releaseFirstResolve: (() => void) | undefined;
  const firstCapacityLocked = new Promise<void>((resolve) => { firstCapacityResolve = resolve; });
  const firstRelease = new Promise<void>((resolve) => { releaseFirstResolve = resolve; });
  const waiters: Array<() => void> = [];
  const acquire = async (client: object): Promise<void> => {
    if (owner !== undefined) await new Promise<void>((resolve) => waiters.push(resolve));
    owner = client;
    if (!firstSeen) {
      firstSeen = true;
      firstCapacityResolve?.();
      await firstRelease;
    }
  };
  const release = (client: object): void => {
    if (owner !== client) return;
    owner = undefined;
    waiters.shift()?.();
  };
  const makeClient = () => {
    const client: {
      query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
      release: () => void;
    } = {
      async query(text, values) {
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          if (text !== "BEGIN") release(client);
          return result([]);
        }
        if (text.startsWith("INSERT INTO knowledge_pipeline_project_fences")) return result([]);
        if (text.includes("knowledge_generation, change_projection_generation")) {
          return result([{ knowledge_generation: "0", change_projection_generation: "0" }]);
        }
        if (text.includes("FROM knowledge_pipeline_archives WHERE archive_id")) {
          const archiveId = String(values?.[0] ?? "");
          return result(rows.filter((row) => row.archive_id === archiveId));
        }
        if (text.includes("FROM knowledge_pipeline_knowledge_jobs") && text.includes("idempotency_key")) {
          return result([]);
        }
        if (text.startsWith("INSERT INTO knowledge_pipeline_capacity_fence")) return result([]);
        if (text.includes("FROM knowledge_pipeline_capacity_fence")) {
          await acquire(client);
          return result([{ fence_id: 1 }]);
        }
        if (text.startsWith("SELECT count(*)::int AS count FROM knowledge_pipeline_knowledge_jobs")) {
          return result([{ count: active }]);
        }
        if (text.startsWith("UPDATE knowledge_pipeline_project_fences")) {
          return result([{ knowledge_generation: 1 }]);
        }
        if (text.startsWith("INSERT INTO knowledge_pipeline_knowledge_jobs")) {
          active += 1;
          const projectId = String(values?.[2] ?? "");
          const archive = rows.find((row) => row.project_id === projectId) ?? rows[0];
          return result([{
            ...knowledgeJobRow(),
            project_id: projectId,
            change_key: archive?.change_key ?? "change-pg-fixture",
            archive_id: archive?.archive_id ?? "arc_pg_fixture",
            idempotency_key: String(values?.[1] ?? hash("idempotency")),
            input_hash: String(values?.[10] ?? hash("input")),
            generation: "1"
          }]);
        }
        throw new Error(`unexpected query: ${text}`);
      },
      release() { release(client); }
    };
    return client;
  };
  return {
    pool: { connect: async () => makeClient() } as unknown as Pool,
    firstCapacityLocked,
    releaseFirstCapacity: () => releaseFirstResolve?.()
  };
}

function planInput(row: ReturnType<typeof archiveRow>, idempotency: string) {
  return {
    archive: archiveInput(row),
    idempotency_key: hash(`plan-${idempotency}`),
    extractor_version: "extractor-v1",
    prompt_version: "prompt-v1",
    index_schema_version: "knowledge-index-v1",
    change_projection_input_hash: hash(`change-plan-${idempotency}`),
    input_hash: hash(`knowledge-plan-${idempotency}`),
    now
  };
}

function projectContentPlanPool(rows: readonly Record<string, unknown>[]): Pool {
  const contentJobIds = new Set<string>();
  const taskPlans = new Map<string, Record<string, unknown>>();
  return {
    connect: async () => {
      const client = {
        async query(text: string, values?: unknown[]) {
          if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return result([]);
          if (text.startsWith("INSERT INTO knowledge_pipeline_project_fences")) return result([]);
          if (text.includes("knowledge_generation, change_projection_generation")) return result([{ knowledge_generation: "0", change_projection_generation: "0" }]);
          if (text.startsWith("INSERT INTO knowledge_pipeline_capacity_fence")) return result([]);
          if (text.includes("FROM knowledge_pipeline_capacity_fence")) return result([{ fence_id: 1 }]);
          if (text.includes("FROM knowledge_pipeline_archives WHERE archive_id")) {
            const archiveId = String(values?.[0] ?? "");
            return result(rows.filter((row) => row.archive_id === archiveId));
          }
          if (text.startsWith("SELECT project_id, idempotency_key, change_projection_job_id")) {
            const key = `${String(values?.[0] ?? "")}\0${String(values?.[1] ?? "")}`;
            const plan = taskPlans.get(key);
            return plan === undefined ? result([]) : result([plan]);
          }
          if (text.includes("FROM knowledge_pipeline_change_jobs") && text.includes("input_hash")) return result([]);
          if (text.includes("FROM knowledge_pipeline_knowledge_jobs") && text.includes("idempotency_key")) return result([]);
          if (text.startsWith("SELECT count(*)::int AS count FROM knowledge_pipeline_change_jobs")) return result([{ count: 0 }]);
          if (text.startsWith("SELECT count(*)::int AS count FROM knowledge_pipeline_knowledge_jobs")) return result([{ count: 0 }]);
          if (text.includes("project_content_job_id") && text.includes("count")) {
            const projectContentJobId = String(values?.[0] ?? "");
            return result([{
              count: contentJobIds.size,
              existing_count: contentJobIds.has(projectContentJobId) ? 1 : 0
            }]);
          }
          if (text.startsWith("UPDATE knowledge_pipeline_project_fences") && text.includes("change_projection_generation")) {
            return result([{ change_projection_generation: 1 }]);
          }
          if (text.startsWith("INSERT INTO knowledge_pipeline_change_jobs")) {
            const projectId = String(values?.[1] ?? "");
            const row = rows.find((candidate) => candidate.project_id === projectId) ?? rows[0];
            return result([{
              ...changeJobRow(),
              job_id: String(values?.[0] ?? changeJobRow().job_id),
              project_id: projectId,
              change_key: row?.change_key ?? "change-pg-fixture",
              archive_id: row?.archive_id ?? "arc_pg_fixture",
              package_sha256: row?.package_sha256 ?? archiveRow().package_sha256,
              manifest_sha256: row?.manifest_sha256 ?? archiveRow().manifest_sha256,
              status: "queued",
              owner_id: null,
              lease_token: null,
              lease_expires_at: null,
              output_hash: null,
              document_count: null,
              reason_code: null,
              retryable: true,
              project_generation: "1",
              generation: "1",
              input_hash: String(values?.[10] ?? hash("change-input"))
            }]);
          }
          if (text.startsWith("UPDATE knowledge_pipeline_project_fences") && text.includes("knowledge_generation")) {
            return result([{ knowledge_generation: 1 }]);
          }
          if (text.startsWith("INSERT INTO knowledge_pipeline_knowledge_jobs")) {
            const projectId = String(values?.[2] ?? "");
            const row = rows.find((candidate) => candidate.project_id === projectId) ?? rows[0];
            return result([{
              ...knowledgeJobRow(),
              job_id: String(values?.[0] ?? knowledgeJobRow().job_id),
              idempotency_key: String(values?.[1] ?? hash("idempotency")),
              project_id: projectId,
              change_key: row?.change_key ?? "change-pg-fixture",
              archive_id: row?.archive_id ?? "arc_pg_fixture",
              package_sha256: row?.package_sha256 ?? archiveRow().package_sha256,
              status: "queued",
              output_hash: null,
              result_count: null,
              reason_code: null,
              retryable: true,
              generation: "1",
              input_hash: String(values?.[10] ?? hash("input"))
            }]);
          }
          if (text.startsWith("INSERT INTO knowledge_pipeline_project_candidates")) return result([]);
          if (text.startsWith("INSERT INTO knowledge_pipeline_task_plans")) {
            const projectId = String(values?.[0] ?? "");
            const idempotencyKey = String(values?.[1] ?? "");
            const contentJobId = values?.[4] === null ? undefined : String(values?.[4] ?? "");
            if (contentJobId !== undefined) contentJobIds.add(contentJobId);
            taskPlans.set(`${projectId}\0${idempotencyKey}`, {
              project_id: projectId,
              idempotency_key: idempotencyKey,
              change_projection_job_id: String(values?.[2] ?? ""),
              knowledge_job_id: String(values?.[3] ?? ""),
              project_content_job_id: contentJobId ?? null
            });
            return result([]);
          }
          throw new Error(`unexpected query: ${text}`);
        },
        release() { /* test client */ }
      };
      return client;
    }
  } as unknown as Pool;
}

describe("PostgreSQL knowledge pipeline ports", () => {
  it("exports the durable ports required by the frozen pipeline contract", () => {
    expect(PgArchiveStore).toBeTypeOf("function");
    expect(PgJobRepository).toBeTypeOf("function");
    expect(PgKnowledgeIndex).toBeTypeOf("function");
    expect(PgKnowledgeCommitPort).toBeTypeOf("function");
    expect(PgChangeProjectionCommitPort).toBeTypeOf("function");
  });

  it("stores and reads a complete immutable archive through the new CAS table", async () => {
    const row = archiveRow();
    const scripted = scriptedPool([row]);
    const port = new PgArchiveStore(scripted.pool);
    const value = await port.putIfAbsent({
      schema_version: 1,
      project_id: row.project_id,
      change_key: row.change_key,
      archive_id: row.archive_id,
      package_sha256: row.package_sha256,
      manifest_sha256: row.manifest_sha256,
      project_version: row.project_version,
      package_schema_version: row.package_schema_version,
      archive_schema_version: row.archive_schema_version,
      package_bytes: row.package_bytes,
      manifest_bytes: row.manifest_bytes,
      knowledge_candidates: [],
      project_content_candidates: [],
      validation_receipt: row.validation_receipt,
      stored_at: row.stored_at
    });
    expect(value.disposition).toBe("stored");
    expect(value.archive.package_bytes).toEqual(new Uint8Array(row.package_bytes));
    expect(scripted.queries.some((query) => query.includes("knowledge_pipeline_archives"))).toBe(true);
    expect(scripted.queries.some((query) => query.includes("knowledge_ingest_entries"))).toBe(false);
  });

  it("replays an identical archive CAS without overwriting immutable bytes", async () => {
    const row = archiveRow();
    const scripted = transactionPool((text) => {
      if (text.includes("INSERT INTO knowledge_pipeline_archives")) return result([]);
      if (text.includes("WHERE archive_id = $1 FOR SHARE")) return result([row]);
      throw new Error(`unexpected query: ${text}`);
    });
    const port = new PgArchiveStore(scripted.pool);
    const value = await port.putIfAbsent({
      schema_version: 1,
      project_id: row.project_id,
      change_key: row.change_key,
      archive_id: row.archive_id,
      package_sha256: row.package_sha256,
      manifest_sha256: row.manifest_sha256,
      project_version: row.project_version,
      package_schema_version: row.package_schema_version,
      archive_schema_version: row.archive_schema_version,
      package_bytes: row.package_bytes,
      manifest_bytes: row.manifest_bytes,
      knowledge_candidates: [],
      project_content_candidates: [],
      validation_receipt: row.validation_receipt,
      stored_at: row.stored_at
    });
    expect(value.disposition).toBe("existing");
    expect(value.archive.archive_id).toBe(row.archive_id);
    expect(scripted.queries).toContain("COMMIT");
    expect(scripted.queries).not.toContain("ROLLBACK");
  });

  it("maps durable result rows and applies query filtering in the PG result index", async () => {
    const queries: string[] = [];
    const port = new PgKnowledgeIndex(readOnlyPool((text) => {
      queries.push(text);
      return result([knowledgeResultRow()]);
    }));
    await expect(port.query({
      project_id: "prj_pg_fixture",
      content_kind: "knowledge_entry",
      status: "active",
      query: "generation",
      limit: 5
    })).resolves.toEqual([expect.objectContaining({
      knowledge_id: "kn_pg_fixture",
      project_id: "prj_pg_fixture",
      source_archive_ids: ["arc_pg_fixture"]
    })]);
    expect(queries[0]).toContain("knowledge_pipeline_results");
    expect(queries[0]).not.toContain("semantic_documents");
  });

  it("reads the complete job descriptor without falling back to legacy 022 rows", async () => {
    const queries: string[] = [];
    const port = new PgJobRepository(readOnlyPool((text) => {
      queries.push(text);
      return result([knowledgeJobRow()]);
    }));
    await expect(port.getKnowledgeJob("job_knowledge_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
      .resolves.toMatchObject({
        project_id: "prj_pg_fixture",
        generation: 1,
        status: "queued",
        knowledge_candidates: []
      });
    expect(queries[0]).toContain("knowledge_pipeline_knowledge_jobs");
    expect(queries[0]).not.toContain("knowledge_extraction_jobs");
  });

  it("dequeues knowledge only after the matching change projection is ready", async () => {
    const queries: string[] = [];
    const port = new PgJobRepository(readOnlyPool((text) => {
      queries.push(text);
      return result([knowledgeJobRow()]);
    }));
    await expect(port.listQueuedKnowledgeJobs(10)).resolves.toHaveLength(1);
    expect(queries[0]).toContain("FROM knowledge_pipeline_change_jobs change_job");
    expect(queries[0]).toContain("change_job.status = 'ready'");
    expect(queries[0]).toContain("change_job.archive_id = knowledge_job.archive_id");
  });

  it("serializes knowledge capacity across concurrent projects", async () => {
    const first = { ...archiveRow(), project_id: "prj_pg_first", archive_id: "arc_pg_first", change_key: "change-pg-first" };
    const second = { ...archiveRow(), project_id: "prj_pg_second", archive_id: "arc_pg_second", change_key: "change-pg-second" };
    const scripted = concurrentCapacityPool([first, second]);
    const repository = new PgJobRepository(scripted.pool, { max_queued_knowledge_jobs: 1 });
    const enqueue = (row: ReturnType<typeof archiveRow>) => repository.enqueueKnowledgeJob({
      archive: archiveInput(row),
      idempotency_key: hash(`idempotency-${row.project_id}`),
      extractor_version: "extractor-v1",
      prompt_version: "prompt-v1",
      index_schema_version: "knowledge-index-v1",
      input_hash: hash(`input-${row.project_id}`),
      now
    });
    const firstAttempt = enqueue(first);
    const secondAttempt = enqueue(second);
    await scripted.firstCapacityLocked;
    scripted.releaseFirstCapacity();
    const outcomes = await Promise.allSettled([firstAttempt, secondAttempt]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toMatchObject({
      reason_code: "KNOWLEDGE_QUEUE_CAPACITY_EXCEEDED"
    });
  });

  it("orders retry change locks as project fence, capacity fence, then job row", async () => {
    const row = changeJobRow({
      status: "failed",
      owner_id: null,
      lease_token: null,
      lease_expires_at: null,
      output_hash: null,
      document_count: null,
      reason_code: "PROJECTION_FAILED",
      retryable: true
    });
    const scripted = transactionPool((text) => {
      if (text.startsWith("SELECT * FROM knowledge_pipeline_change_jobs WHERE job_id=$1")) return result([row]);
      if (text.startsWith("INSERT INTO knowledge_pipeline_project_fences")) return result([]);
      if (text.includes("knowledge_generation, change_projection_generation")) return result([{ knowledge_generation: "0", change_projection_generation: "1" }]);
      if (text.startsWith("INSERT INTO knowledge_pipeline_capacity_fence")) return result([]);
      if (text.includes("FROM knowledge_pipeline_capacity_fence")) return result([{ fence_id: 1 }]);
      if (text.startsWith("SELECT count(*)::int AS count FROM knowledge_pipeline_change_jobs")) return result([{ count: 1 }]);
      throw new Error(`unexpected query: ${text}`);
    });
    const repository = new PgJobRepository(scripted.pool, { max_queued_change_projection_jobs: 1 });
    await expect(repository.retryChangeProjectionJob({
      job_id: row.job_id,
      expected_generation: 1,
      expected_status: "failed",
      now
    })).rejects.toMatchObject({ reason_code: "CHANGE_PROJECTION_QUEUE_CAPACITY_EXCEEDED" });
    const projectFenceIndex = scripted.queries.findIndex((query) => query.includes("FROM knowledge_pipeline_project_fences"));
    const capacityFenceIndex = scripted.queries.findIndex((query) => query.includes("FROM knowledge_pipeline_capacity_fence"));
    const jobLockIndex = scripted.queries.findIndex((query) => query.includes("FROM knowledge_pipeline_change_jobs") && query.includes("FOR UPDATE"));
    const initialJobReadIndex = scripted.queries.findIndex((query) => query.includes("FROM knowledge_pipeline_change_jobs") && !query.includes("FOR UPDATE"));
    expect(initialJobReadIndex).toBeGreaterThan(-1);
    expect(projectFenceIndex).toBeGreaterThan(initialJobReadIndex);
    expect(capacityFenceIndex).toBeGreaterThan(projectFenceIndex);
    expect(jobLockIndex).toBeGreaterThan(capacityFenceIndex);
  });

  it("admits project-content jobs globally and counts the same project/package once", async () => {
    const candidate = projectCandidateRow().candidate;
    const first = {
      ...archiveRow(),
      project_id: "prj_pg_first",
      archive_id: "arc_pg_first",
      change_key: "change-pg-first",
      project_content_candidates: [candidate]
    };
    const second = {
      ...archiveRow(),
      project_id: "prj_pg_second",
      archive_id: "arc_pg_second",
      change_key: "change-pg-second",
      project_content_candidates: [candidate]
    };
    const repository = new PgJobRepository(projectContentPlanPool([first, second]), {
      max_queued_project_content_jobs: 1
    });
    await expect(repository.planArchiveTasks(planInput(first, "first"))).resolves.toBeDefined();
    await expect(repository.planArchiveTasks(planInput(second, "second"))).rejects.toMatchObject({
      reason_code: "PIPELINE_QUEUE_CAPACITY_EXCEEDED"
    });
    await expect(repository.planArchiveTasks(planInput(first, "same-archive-second-idempotency"))).resolves.toBeDefined();
  });

  it.each([
    ["queued output", { output_hash: hash("unexpected") }],
    ["extracting reason", { status: "extracting", reason_code: "EXTRACTOR_FAILED" }],
    ["ready missing output", { status: "ready", retryable: false }],
    ["failed missing reason", { status: "failed", retryable: true }]
  ])("rejects a malformed knowledge job state union: %s", async (_label, overrides) => {
    const row = { ...knowledgeJobRow(), ...overrides };
    const port = new PgJobRepository(readOnlyPool(() => result([row])));
    await expect(port.getKnowledgeJob(row.job_id)).rejects.toMatchObject({
      reason_code: "KNOWLEDGE_JOB_CORRUPT"
    });
  });

  it.each([
    ["queued lease", { status: "queued" }],
    ["projecting missing lease", { owner_id: null, lease_token: null, lease_expires_at: null }],
    ["ready missing output", { status: "ready", owner_id: null, lease_token: null, lease_expires_at: null, retryable: false }],
    ["failed missing reason", { status: "failed", owner_id: null, lease_token: null, lease_expires_at: null, retryable: true }]
  ])("rejects a malformed change job state union: %s", async (_label, overrides) => {
    const row = {
      ...changeJobRow(),
      ...overrides,
      ...(overrides.status === "queued"
        ? { owner_id: "worker-pg", lease_token: "lease-pg", lease_expires_at: "2026-08-13T01:30:00.000Z" }
        : {}),
      ...(overrides.status === "ready"
        ? { output_hash: null, document_count: null }
        : {}),
      ...(overrides.status === "failed"
        ? { output_hash: null, document_count: null, reason_code: null }
        : {})
    };
    const port = new PgJobRepository(readOnlyPool(() => result([row])));
    await expect(port.getChangeProjectionJob(row.job_id)).rejects.toMatchObject({
      reason_code: "CHANGE_PROJECTION_JOB_CORRUPT"
    });
  });

  it("binds candidate pagination cursors to query scope and checks denormalized identity", async () => {
    const first = projectCandidateRow();
    const second = projectCandidateRow({
      candidate_id: "pcc_pg_fixture_2",
      content_hash: hash("project-candidate-2"),
      candidate: {
        ...first.candidate,
        candidate_id: "pcc_pg_fixture_2",
        content_hash: hash("project-candidate-2")
      }
    });
    const queries: string[] = [];
    const port = new PgJobRepository(readOnlyPool((text) => {
      queries.push(text);
      return result([first, second]);
    }));
    const page = await port.listProjectContentCandidates({
      project_id: "prj_pg_fixture",
      candidate_type: "rule",
      status: "pending",
      limit: 1
    });
    expect(page.next_cursor).toBeDefined();
    const cursor = JSON.parse(Buffer.from(page.next_cursor ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    expect(cursor).toMatchObject({
      project_id: "prj_pg_fixture",
      candidate_type: "rule",
      status: "pending"
    });
    expect(queries[0]).toContain("candidate_type");

    const corruptPort = new PgJobRepository(readOnlyPool(() => result([{
      ...first,
      status: "accepted"
    }])));
    await expect(corruptPort.listProjectContentCandidates({
      project_id: "prj_pg_fixture",
      candidate_type: "rule",
      status: "pending",
      limit: 1
    })).rejects.toMatchObject({ reason_code: "PROJECT_CANDIDATE_CORRUPT" });
  });

  it("rejects a candidate cursor whose descriptor tuple is absent from the scoped result", async () => {
    const port = new PgJobRepository(readOnlyPool((text) => {
      if (text.includes("candidate_id=$5")) return result([]);
      return result([projectCandidateRow()]);
    }));
    const cursor = Buffer.from(JSON.stringify({
      project_id: "prj_pg_fixture",
      candidate_type: "rule",
      status: "pending",
      created_at: now,
      candidate_id: "pcc_missing"
    })).toString("base64url");
    await expect(port.listProjectContentCandidates({
      project_id: "prj_pg_fixture",
      candidate_type: "rule",
      status: "pending",
      cursor,
      limit: 1
    })).rejects.toMatchObject({ reason_code: "CANDIDATE_CURSOR_INVALID" });
  });

  it("rejects accessor-backed candidate queries before opening storage", async () => {
    let calls = 0;
    const port = new PgJobRepository(readOnlyPool(() => {
      calls += 1;
      return result([]);
    }));
    const query: Record<string, unknown> = {
      candidate_type: "rule",
      status: "pending",
      limit: 1
    };
    Object.defineProperty(query, "project_id", {
      enumerable: true,
      get: () => { throw new Error("project secret"); }
    });
    await expect(port.listProjectContentCandidates(query as never)).rejects.toMatchObject({
      reason_code: "CANDIDATE_QUERY_INVALID"
    });
    expect(calls).toBe(0);
  });

  it("rejects malformed archive bytes before opening a database transaction", async () => {
    let calls = 0;
    const port = new PgArchiveStore(readOnlyPool(() => {
      calls += 1;
      return result([]);
    }));
    const row = archiveRow();
    await expect(port.putIfAbsent({
      schema_version: 1,
      project_id: row.project_id,
      change_key: row.change_key,
      archive_id: row.archive_id,
      package_sha256: hash("wrong"),
      manifest_sha256: row.manifest_sha256,
      project_version: row.project_version,
      package_schema_version: row.package_schema_version,
      archive_schema_version: row.archive_schema_version,
      package_bytes: row.package_bytes,
      manifest_bytes: row.manifest_bytes,
      knowledge_candidates: [],
      project_content_candidates: [],
      validation_receipt: row.validation_receipt,
      stored_at: row.stored_at
    })).rejects.toMatchObject({ reason_code: "ARCHIVE_HASH_MISMATCH" });
    expect(calls).toBe(0);
  });

  it("rolls back a knowledge commit for a stale project generation", async () => {
    const row = knowledgeJobRow();
    const scripted = transactionPool((text) => {
      if (text.startsWith("SELECT project_id FROM knowledge_pipeline_knowledge_jobs")) {
        return result([{ project_id: row.project_id }]);
      }
      if (text.startsWith("INSERT INTO knowledge_pipeline_project_fences")) return result([]);
      if (text.includes("knowledge_generation, change_projection_generation")) {
        return result([{ knowledge_generation: "2", change_projection_generation: "0" }]);
      }
      if (text.startsWith("SELECT * FROM knowledge_pipeline_knowledge_jobs")) {
        return result([{ ...row, status: "extracting", generation: "1" }]);
      }
      throw new Error(`unexpected query: ${text}`);
    });
    const port = new PgKnowledgeCommitPort(scripted.pool);
    await expect(port.commitKnowledgeResults({
      job_id: row.job_id,
      generation: 1,
      output_hash: hash("output"),
      results: [],
      now
    })).rejects.toMatchObject({ reason_code: "KNOWLEDGE_PROJECT_GENERATION_STALE" });
    expect(scripted.queries).toContain("ROLLBACK");
    expect(scripted.queries).not.toContain("COMMIT");
  });

  it("rejects more than five knowledge results before opening a transaction", async () => {
    let connects = 0;
    const port = new PgKnowledgeCommitPort({
      connect: async () => {
        connects += 1;
        throw new Error("database should not be reached");
      }
    } as unknown as Pool);
    const results = Array.from({ length: 6 }, (_, index) => knowledgeResultInput({
      knowledge_id: `kn_pg_fixture_${index}`,
      content_hash: hash(`knowledge-content-${index}`)
    }));
    await expect(port.commitKnowledgeResults({
      job_id: knowledgeJobRow().job_id,
      generation: 1,
      output_hash: hash("output"),
      results: results as never,
      now
    })).rejects.toMatchObject({ reason_code: "KNOWLEDGE_RESULT_LIMIT_EXCEEDED" });
    expect(connects).toBe(0);
  });

  it("checks stored knowledge results before accepting a ready replay", async () => {
    const row = knowledgeJobRow();
    const contentHash = hash("knowledge-content-ready");
    const replayResult = knowledgeResultInput({
      knowledge_id: `kn_${createHash("sha256").update(`${row.project_id}\0${contentHash}`).digest("hex")}`,
      content_hash: contentHash,
      source_candidate_ids: []
    });
    const ready = { ...row, status: "ready", output_hash: hash("output"), result_count: 1, retryable: false };
    const scripted = transactionPool((text) => {
      if (text.startsWith("SELECT project_id FROM knowledge_pipeline_knowledge_jobs")) return result([{ project_id: row.project_id }]);
      if (text.startsWith("INSERT INTO knowledge_pipeline_project_fences")) return result([]);
      if (text.includes("knowledge_generation, change_projection_generation")) return result([{ knowledge_generation: "1", change_projection_generation: "0" }]);
      if (text.startsWith("SELECT * FROM knowledge_pipeline_knowledge_jobs")) return result([ready]);
      if (text.includes("FROM knowledge_pipeline_results")) return result([]);
      throw new Error(`unexpected query: ${text}`);
    });
    const port = new PgKnowledgeCommitPort(scripted.pool);
    await expect(port.commitKnowledgeResults({
      job_id: row.job_id,
      generation: 1,
      output_hash: ready.output_hash,
      results: [replayResult as never],
      now
    })).rejects.toMatchObject({ reason_code: "KNOWLEDGE_READY_STATE_INVALID" });
    expect(scripted.queries.some((query) => query.includes("FROM knowledge_pipeline_results"))).toBe(true);
    expect(scripted.queries).toContain("ROLLBACK");
  });

  it("rejects and rolls back a knowledge result from another project", async () => {
    const row = knowledgeJobRow();
    const scripted = transactionPool((text) => {
      if (text.startsWith("SELECT project_id FROM knowledge_pipeline_knowledge_jobs")) {
        return result([{ project_id: row.project_id }]);
      }
      if (text.startsWith("INSERT INTO knowledge_pipeline_project_fences")) return result([]);
      if (text.includes("knowledge_generation, change_projection_generation")) {
        return result([{ knowledge_generation: "1", change_projection_generation: "0" }]);
      }
      if (text.startsWith("SELECT * FROM knowledge_pipeline_knowledge_jobs")) {
        return result([{ ...row, status: "extracting", generation: "1" }]);
      }
      throw new Error(`unexpected query: ${text}`);
    });
    const port = new PgKnowledgeCommitPort(scripted.pool);
    await expect(port.commitKnowledgeResults({
      job_id: row.job_id,
      generation: 1,
      output_hash: hash("output"),
      results: [knowledgeResultInput({ project_id: "prj_pg_other" }) as never],
      now
    })).rejects.toMatchObject({ reason_code: "KNOWLEDGE_RESULT_INVALID" });
    expect(scripted.queries).toContain("ROLLBACK");
    expect(scripted.queries.some((query) => query.includes("INSERT INTO knowledge_pipeline_results"))).toBe(false);
  });

  it("replays a ready knowledge generation idempotently", async () => {
    const row = knowledgeJobRow();
    const ready = { ...row, status: "ready", output_hash: hash("output"), result_count: 0, retryable: false };
    const scripted = transactionPool((text) => {
      if (text.startsWith("SELECT project_id FROM knowledge_pipeline_knowledge_jobs")) {
        return result([{ project_id: row.project_id }]);
      }
      if (text.startsWith("INSERT INTO knowledge_pipeline_project_fences")) return result([]);
      if (text.includes("knowledge_generation, change_projection_generation")) {
        return result([{ knowledge_generation: "1", change_projection_generation: "0" }]);
      }
      if (text.startsWith("SELECT * FROM knowledge_pipeline_knowledge_jobs")) return result([ready]);
      if (text.includes("FROM knowledge_pipeline_results")) return result([]);
      throw new Error(`unexpected query: ${text}`);
    });
    const port = new PgKnowledgeCommitPort(scripted.pool);
    await expect(port.commitKnowledgeResults({
      job_id: row.job_id,
      generation: 1,
      output_hash: hash("output"),
      results: [],
      now
    })).resolves.toMatchObject({ status: "ready", output_hash: hash("output") });
    expect(scripted.queries).toContain("COMMIT");
    expect(scripted.queries).not.toContain("ROLLBACK");
    expect(scripted.queries.some((query) => query.includes("INSERT INTO knowledge_pipeline_results"))).toBe(false);
  });

  it("rolls back a change projection commit with a stale lease", async () => {
    const row = changeJobRow({ lease_expires_at: "2026-08-13T00:59:00.000Z" });
    const scripted = transactionPool((text) => {
      if (text.startsWith("SELECT project_id FROM knowledge_pipeline_change_jobs")) {
        return result([{ project_id: row.project_id }]);
      }
      if (text.startsWith("INSERT INTO knowledge_pipeline_project_fences")) return result([]);
      if (text.includes("knowledge_generation, change_projection_generation")) {
        return result([{ knowledge_generation: "0", change_projection_generation: "1" }]);
      }
      if (text.startsWith("SELECT * FROM knowledge_pipeline_change_jobs")) return result([row]);
      throw new Error(`unexpected query: ${text}`);
    });
    const port = new PgChangeProjectionCommitPort(scripted.pool);
    await expect(port.commitChangeProjection({
      job_id: row.job_id,
      generation: 1,
      owner_id: "worker-pg",
      lease_token: "lease-pg",
      output_hash: changeProjectionOutputHash([]),
      documents: [],
      now
    })).rejects.toMatchObject({ reason_code: "CHANGE_PROJECTION_LEASE_EXPIRED" });
    expect(scripted.queries).toContain("ROLLBACK");
    expect(scripted.queries.some((query) => query.includes("DELETE FROM knowledge_pipeline_change_documents"))).toBe(false);
  });

  it("rejects a change job from a stale project generation before snapshot replacement", async () => {
    const row = changeJobRow({ project_generation: "2" });
    const scripted = transactionPool((text) => {
      if (text.startsWith("SELECT project_id FROM knowledge_pipeline_change_jobs")) {
        return result([{ project_id: row.project_id }]);
      }
      if (text.startsWith("INSERT INTO knowledge_pipeline_project_fences")) return result([]);
      if (text.includes("knowledge_generation, change_projection_generation")) {
        return result([{ knowledge_generation: "0", change_projection_generation: "1" }]);
      }
      if (text.startsWith("SELECT * FROM knowledge_pipeline_change_jobs")) return result([row]);
      throw new Error(`unexpected query: ${text}`);
    });
    const port = new PgChangeProjectionCommitPort(scripted.pool);
    await expect(port.commitChangeProjection({
      job_id: row.job_id,
      generation: 1,
      owner_id: "worker-pg",
      lease_token: "lease-pg",
      output_hash: changeProjectionOutputHash([]),
      documents: [],
      now
    })).rejects.toMatchObject({ reason_code: "CHANGE_PROJECTION_PROJECT_GENERATION_STALE" });
    expect(scripted.queries).toContain("ROLLBACK");
    expect(scripted.queries.some((query) => query.includes("DELETE FROM knowledge_pipeline_change_documents"))).toBe(false);
  });

  it("checks stored change documents before accepting a ready replay", async () => {
    const row = changeJobRow({
      status: "ready",
      owner_id: null,
      lease_token: null,
      lease_expires_at: null,
      output_hash: changeProjectionOutputHash([changeDocumentInput()]),
      document_count: 1,
      retryable: false
    });
    const document = changeDocumentInput({ content: "# Durable design\n\n- preserves Markdown structure\n" });
    const scripted = transactionPool((text) => {
      if (text.startsWith("SELECT project_id FROM knowledge_pipeline_change_jobs")) return result([{ project_id: row.project_id }]);
      if (text.startsWith("INSERT INTO knowledge_pipeline_project_fences")) return result([]);
      if (text.includes("knowledge_generation, change_projection_generation")) return result([{ knowledge_generation: "0", change_projection_generation: "1" }]);
      if (text.startsWith("SELECT * FROM knowledge_pipeline_change_jobs")) return result([row]);
      if (text.includes("FROM knowledge_pipeline_change_documents")) return result([]);
      throw new Error(`unexpected query: ${text}`);
    });
    const port = new PgChangeProjectionCommitPort(scripted.pool);
    await expect(port.commitChangeProjection({
      job_id: row.job_id,
      generation: 1,
      owner_id: "worker-pg",
      lease_token: "lease-pg",
      output_hash: row.output_hash,
      documents: [document as never],
      now
    })).rejects.toMatchObject({ reason_code: "CHANGE_PROJECTION_READY_STATE_INVALID" });
    expect(scripted.queries.some((query) => query.includes("FROM knowledge_pipeline_change_documents"))).toBe(true);
    expect(scripted.queries).toContain("ROLLBACK");
  });

  it("keeps the migration at the next number and declares separate durable tables", async () => {
    const migration = await readFile(fileURLToPath(new URL("../migrations/023_knowledge_pipeline_pg.sql", import.meta.url)), "utf8");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS knowledge_pipeline_archives");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS knowledge_pipeline_change_jobs");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS knowledge_pipeline_results");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS knowledge_pipeline_capacity_fence");
    expect(migration).toContain("FOREIGN KEY (project_id, archive_id)");
    expect(migration).toContain("UNIQUE (project_id, job_id)");
    expect(migration).toContain("FOREIGN KEY (project_id, change_projection_job_id)");
    expect(migration).toContain("FOREIGN KEY (project_id, knowledge_job_id)");
    expect(migration).toContain("project_id, package_sha256, manifest_sha256");
    expect(migration.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(migration.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(migration).not.toMatch(/(?:FROM|INTO|TABLE)\s+(?:knowledge_ingest_entries|semantic_documents)\b/i);
  });
});
