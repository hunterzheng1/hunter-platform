import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createChangeRecordsQueryAdapter as createRawChangeRecordsQueryAdapter,
  sourcePathDocumentType,
  type ChangeRecordsQueryAdapterDependencies,
  type ChangeRecordsQuerySourcePort
} from "../src/change-records-query/index.js";
import { changeDocumentIdentity } from "../src/knowledge-pipeline/index.js";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const utf8Hash = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const documentDefinitions = [
  { document_type: "design", source_path: "spec/change-a-design.md" },
  { document_type: "plan", source_path: "plans/change-a-plan.md" },
  { document_type: "test_scenarios", source_path: "plans/change-a-test-scenarios.md" },
  { document_type: "change_summary", source_path: "summary/change-summary.json" }
] as const;
const documentRefs = documentDefinitions.map((document) => changeDocumentIdentity({
  project_id: "prj_change_records", change_key: "change-a", ...document
}));
const documentContents = ["# 设计", "content-1", "content-2", "content-3"] as const;

function documentContentAt(index: number): string {
  const content = documentContents[index];
  if (content === undefined) throw new Error(`Missing test document content at index ${index}`);
  return content;
}

function referencePort(): ChangeRecordsQueryAdapterDependencies["reference_port"] {
  return {
    async resolve(input) {
      const descriptors = input.references.flatMap((reference) => reference.document_ids.map((documentId) => {
        const index = documentRefs.indexOf(documentId);
        const definition = documentDefinitions[index];
        const content = documentContents[index];
        if (reference.change_key !== "change-a" || definition === undefined || content === undefined) return null;
        return {
          document_id: documentId, project_id: input.project_id, change_key: reference.change_key,
          document_type: definition.document_type, source_path: definition.source_path,
          content_hash: utf8Hash(content), source_archive_id: "archive_a",
          source_package_sha256: hash("a")
        };
      }).filter((value) => value !== null));
      return JSON.stringify({
        schema_version: 1, source_kind: "change_document_reference_resolution",
        actor_id: input.actor_id, project_id: input.project_id,
        references: input.references, descriptors
      });
    }
  };
}

function createChangeRecordsQueryAdapter(
  dependencies: Omit<ChangeRecordsQueryAdapterDependencies, "reference_port"> &
    Partial<Pick<ChangeRecordsQueryAdapterDependencies, "reference_port">>
) {
  return createRawChangeRecordsQueryAdapter({
    ...dependencies,
    reference_port: dependencies.reference_port ?? referencePort()
  });
}

function source(overrides: Partial<ChangeRecordsQuerySourcePort> = {}): ChangeRecordsQuerySourcePort {
  return {
    async listPage(input) {
      return JSON.stringify({
        schema_version: 1,
        source_kind: "change_records_page",
        actor_id: input.actor_id,
        project_id: input.project_id,
        accessible_project_ids: input.accessible_project_ids,
        content_types: input.content_types,
        sort: input.sort,
        request_cursor: input.cursor,
        page_state: "ready",
        records: [
          {
            change_key: "change-a",
            title: "变更 A",
            archived_at: "2026-08-13T03:00:00.000Z",
            archive_status: "durable",
            archive_id: "archive_a",
            package_sha256: hash("a"),
            knowledge_extraction_status: "ready",
            projection_status: "ready",
            document_refs: documentRefs,
            document_snapshots: documentRefs.map((document_id, index) => ({
              document_id, content_hash: utf8Hash(documentContentAt(index))
            })),
            candidate_refs: ["candidate_1"]
          },
          {
            change_key: "change-b",
            title: "变更 B",
            archived_at: "2026-08-12T03:00:00.000Z",
            archive_status: "absent",
            archive_id: null,
            package_sha256: null,
            knowledge_extraction_status: "not_scheduled",
            projection_status: "queued",
            document_refs: [],
            document_snapshots: [],
            candidate_refs: []
          }
        ],
        next_cursor: "cursor_token_123456",
        failures: []
      });
    },
    async getDetail(input) {
      return JSON.stringify({
        schema_version: 1,
        source_kind: "change_record_detail",
        actor_id: input.actor_id,
        project_id: input.project_id,
        accessible_project_ids: input.accessible_project_ids,
        content_types: input.content_types,
        sort: input.sort,
        request_cursor: input.request_cursor,
        detail_id: input.detail_id,
        change_key: "change-a",
        document_refs: documentRefs,
        document_snapshots: documentRefs.map((document_id, index) => ({
          document_id, content_hash: utf8Hash(documentContentAt(index))
        })),
        candidate_refs: ["candidate_1"],
        archive_id: "archive_a",
        package_sha256: hash("a")
      });
    },
    ...overrides
  };
}

describe("Change records query adapter", () => {
  it("projects bounded summaries and refs without document bodies", async () => {
    const calls: unknown[] = [];
    const adapter = createChangeRecordsQueryAdapter({
      source_port: source({
        async listPage(input) {
          calls.push(input);
          return source().listPage(input);
        }
      }),
      cursor_verifier: { verify: () => true }
    });

    const result = await adapter.queryPage(await fixture("change-records-query-v1-current.json"));

    expect(result).toMatchObject({ ok: true, value: {
      page_state: "ready",
      next_cursor: "cursor_token_123456",
      items: [
        {
          item_kind: "change_record",
          change_key: "change-a",
          archive_status: "stored",
          knowledge_extraction_status: "ready",
          candidate_count: 1,
          archive_download_ref: { archive_id: "archive_a", package_hash: hash("a") }
        },
        {
          change_key: "change-b",
          archive_status: "absent",
          knowledge_extraction_status: "not_scheduled",
          archive_download_ref: null
        }
      ]
    }});
    expect(JSON.stringify(result)).not.toContain("content");
    expect(calls).toEqual([{
      project_id: "prj_change_records",
      actor_id: "actor_owner",
      accessible_project_ids: ["prj_change_records"],
      content_types: ["change_document", "archive_package", "project_content_candidate"],
      limit: 2,
      cursor: null,
      sort: "archived_at_desc_change_key_asc",
      request_cursor: null
    }]);
  });

  it("verifies an opaque cursor before touching the source", async () => {
    let sourceCalls = 0;
    let verifierInput: unknown;
    const request = JSON.parse(await fixture("change-records-query-v1-current.json"));
    request.cursor = "opaque_cursor_123456";
    const adapter = createChangeRecordsQueryAdapter({
      source_port: source({ async listPage() { sourceCalls += 1; throw new Error("called"); } }),
      cursor_verifier: { verify(input) { verifierInput = input; return false; } }
    });
    expect(await adapter.queryPage(JSON.stringify(request))).toEqual({
      ok: false, reason_code: "CHANGE_RECORDS_CURSOR_INVALID"
    });
    expect(sourceCalls).toBe(0);
    expect(verifierInput).toEqual({
      cursor: "opaque_cursor_123456", project_id: "prj_change_records",
      actor_id: "actor_owner", view: "change_records",
      sort: "archived_at_desc_change_key_asc"
    });
  });

  it.each(["empty", "processing", "forbidden"] as const)("projects the %s page state", async (pageState) => {
    const adapter = createChangeRecordsQueryAdapter({
      source_port: source({ async listPage(input) { return JSON.stringify({
        schema_version: 1, source_kind: "change_records_page", page_state: pageState,
        actor_id: input.actor_id, project_id: input.project_id,
        accessible_project_ids: input.accessible_project_ids,
        content_types: input.content_types, sort: input.sort, request_cursor: input.cursor,
        records: [], next_cursor: null, failures: pageState === "forbidden"
          ? [{ reason_code: "PROJECT_INFORMATION_FORBIDDEN", retryable: false }] : []
      }); } }),
      cursor_verifier: { verify: () => true }
    });
    expect(await adapter.queryPage(await fixture("change-records-query-v1-current.json")))
      .toMatchObject({ ok: true, value: { page_state: pageState, items: [] } });
  });

  it("projects a partial failure only with bounded partial results", async () => {
    const raw = JSON.parse(await source().listPage({
      project_id: "prj_change_records", actor_id: "actor_owner",
      accessible_project_ids: ["prj_change_records"],
      content_types: ["change_document", "archive_package", "project_content_candidate"],
      limit: 2, cursor: null, sort: "archived_at_desc_change_key_asc", request_cursor: null
    }));
    raw.page_state = "partial_failure";
    raw.records = raw.records.slice(0, 1);
    raw.failures = [{ reason_code: "PROJECTION_PARTIAL_FAILURE", retryable: true }];
    const adapter = createChangeRecordsQueryAdapter({
      source_port: source({ async listPage() { return JSON.stringify(raw); } }),
      cursor_verifier: { verify: () => true }
    });
    expect(await adapter.queryPage(await fixture("change-records-query-v1-current.json")))
      .toMatchObject({ ok: true, value: { page_state: "partial_failure", items: [{ change_key: "change-a" }] } });
  });

  it("returns record refs and loads one document body only by document identity", async () => {
    let detailInput: unknown;
    const adapter = createChangeRecordsQueryAdapter({
      source_port: source({ async getDetail(input) { detailInput = input; return source().getDetail(input); } }),
      cursor_verifier: { verify: () => true }
    });
    const request = {
      schema_version: 1, contract_kind: "detail_request", view: "change_records",
      project_id: "prj_change_records",
      query_scope: { actor_id: "actor_owner", accessible_project_ids: ["prj_change_records"],
        content_types: ["change_document", "archive_package", "project_content_candidate"] },
      detail_id: "change-a"
    };
    expect(await adapter.queryDetail(JSON.stringify(request))).toMatchObject({ ok: true, value: {
      detail: { detail_kind: "change_record", document_refs: documentRefs }
    }});
    expect(detailInput).toEqual({ project_id: "prj_change_records", actor_id: "actor_owner",
      accessible_project_ids: ["prj_change_records"],
      content_types: ["change_document", "archive_package", "project_content_candidate"],
      detail_id: "change-a", sort: "archived_at_desc_change_key_asc", request_cursor: null });

    const documentId = changeDocumentIdentity({
      project_id: "prj_change_records", change_key: "change-a",
      document_type: "design", source_path: "spec/change-a-design.md"
    });
    const documentAdapter = createChangeRecordsQueryAdapter({
      source_port: source({ async getDetail() { return JSON.stringify({
        schema_version: 1, source_kind: "change_document_detail",
        actor_id: "actor_owner", project_id: "prj_change_records",
        accessible_project_ids: ["prj_change_records"],
        content_types: ["change_document", "archive_package", "project_content_candidate"],
        sort: "archived_at_desc_change_key_asc", request_cursor: null,
        detail_id: documentId, document_id: documentId,
        change_key: "change-a", document_type: "design",
        source_path: "spec/change-a-design.md", content_hash: utf8Hash("# 设计"),
        archive_id: "archive_a", package_sha256: hash("a"),
        media_type: "text/markdown", content: "# 设计"
      }); } }),
      cursor_verifier: { verify: () => true }
    });
    request.detail_id = documentId;
    expect(await documentAdapter.queryDetail(JSON.stringify(request))).toMatchObject({ ok: true, value: {
      detail_id: documentId, detail: { detail_kind: "change_document", content_hash: utf8Hash("# 设计"), content: "# 设计" }
    }});
  });

  it("keeps legacy read-only and rejects hostile/non-serialized inputs before ports", async () => {
    let calls = 0;
    const adapter = createChangeRecordsQueryAdapter({
      source_port: source({ async listPage() { calls += 1; throw new Error("called"); }, async getDetail() { calls += 1; throw new Error("called"); } }),
      cursor_verifier: { verify: () => { calls += 1; return true; } }
    });
    expect(await adapter.queryPage(await fixture("change-records-query-v0-legacy.json")))
      .toEqual({ ok: false, reason_code: "CHANGE_RECORDS_LEGACY_READ_ONLY" });
    expect(await adapter.queryDetail(await fixture("change-records-query-v0-legacy.json")))
      .toEqual({ ok: false, reason_code: "CHANGE_RECORDS_LEGACY_READ_ONLY" });
    let traps = 0;
    const hostile = new Proxy({}, { get() { traps += 1; throw new Error("executed"); } });
    expect(await adapter.queryPage(hostile as never)).toEqual({
      ok: false, reason_code: "CHANGE_RECORDS_QUERY_INVALID"
    });
    expect(traps).toBe(0);
    expect(calls).toBe(0);
  });

  it("rejects non-serialized source values and treats cursor verifier errors as invalid", async () => {
    const request = JSON.parse(await fixture("change-records-query-v1-current.json"));
    request.cursor = "opaque_cursor_123456";
    const adapter = createChangeRecordsQueryAdapter({
      source_port: source({ async listPage() { return {} as never; } }),
      cursor_verifier: { verify() { throw new Error("verifier unavailable"); } }
    });
    expect(await adapter.queryPage(JSON.stringify(request))).toEqual({
      ok: false, reason_code: "CHANGE_RECORDS_CURSOR_INVALID"
    });
    const sourceAdapter = createChangeRecordsQueryAdapter({
      source_port: source({ async listPage() { return {} as never; } }),
      cursor_verifier: { verify: () => true }
    });
    request.cursor = null;
    expect(await sourceAdapter.queryPage(JSON.stringify(request))).toEqual({
      ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID"
    });
  });

  it("rejects detail identity, project, and archive-ref drift", async () => {
    const request = JSON.stringify({
      schema_version: 1, contract_kind: "detail_request", view: "change_records",
      project_id: "prj_change_records",
      query_scope: { actor_id: "actor_owner", accessible_project_ids: ["prj_change_records"],
        content_types: ["change_document", "archive_package", "project_content_candidate"] },
      detail_id: "doc_design"
    });
    const values = [
      { schema_version: 1, source_kind: "change_document_detail", document_id: "doc_other",
        project_id: "prj_change_records", change_key: "change-a", document_type: "design",
        source_path: "spec/change-a-design.md", content_hash: hash("d"), media_type: "text/markdown", content: "x" },
      { schema_version: 1, source_kind: "change_document_detail", document_id: "doc_design",
        project_id: "prj_foreign", change_key: "change-a", document_type: "design",
        source_path: "spec/change-a-design.md", content_hash: hash("d"), media_type: "text/markdown", content: "x" },
      { schema_version: 1, source_kind: "change_record_detail", change_key: "doc_design",
        document_refs: [], candidate_refs: [], archive_id: "archive_a", package_sha256: null }
    ];
    for (const value of values) {
      const adapter = createChangeRecordsQueryAdapter({
        source_port: source({ async getDetail() { return JSON.stringify(value); } }),
        cursor_verifier: { verify: () => true }
      });
      const result = await adapter.queryDetail(request);
      expect(result).toEqual({
        ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID"
      });
    }
  });

  it("fails closed on malformed, oversized, unsorted, duplicated, or mismatched source data", async () => {
    const valid = JSON.parse(await source().listPage({
      project_id: "prj_change_records", actor_id: "actor_owner",
      accessible_project_ids: ["prj_change_records"],
      content_types: ["change_document", "archive_package", "project_content_candidate"],
      limit: 2, cursor: null, sort: "archived_at_desc_change_key_asc", request_cursor: null
    }));
    const variants = [
      "not json",
      JSON.stringify({ ...valid, records: [...valid.records].reverse() }),
      JSON.stringify({ ...valid, records: [valid.records[0], valid.records[0]] }),
      JSON.stringify({ ...valid, records: [...valid.records, valid.records[0]] }),
      JSON.stringify({ ...valid, records: [{ ...valid.records[0], package_sha256: null }] }),
      "x".repeat(2_000_001)
    ];
    for (const raw of variants) {
      const adapter = createChangeRecordsQueryAdapter({
        source_port: source({ async listPage() { return raw; } }),
        cursor_verifier: { verify: () => true }
      });
      expect(await adapter.queryPage(await fixture("change-records-query-v1-current.json")))
        .toEqual({ ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" });
    }
  });

  it("rejects source scope echo drift, including the same change key from another project", async () => {
    const query = await fixture("change-records-query-v1-current.json");
    const base = JSON.parse(await source().listPage({
      project_id: "prj_change_records", actor_id: "actor_owner",
      accessible_project_ids: ["prj_change_records"],
      content_types: ["change_document", "archive_package", "project_content_candidate"],
      limit: 2, cursor: null, sort: "archived_at_desc_change_key_asc", request_cursor: null
    }));
    for (const drift of [
      { actor_id: "actor_foreign" }, { project_id: "prj_foreign" },
      { accessible_project_ids: ["prj_foreign"] }, { content_types: ["change_document"] },
      { sort: "other" }, { request_cursor: "other_cursor_12345" }
    ]) {
      const adapter = createChangeRecordsQueryAdapter({
        source_port: source({ async listPage() { return JSON.stringify({ ...base, ...drift }); } }),
        cursor_verifier: { verify: () => true }
      });
      expect(await adapter.queryPage(query)).toEqual({ ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" });
    }
  });

  it("recomputes UTF-8 hash and binds document type, canonical path class, and identity", async () => {
    const identity = { project_id: "prj_change_records", change_key: "change-a",
      document_type: "design" as const, source_path: "spec/change-a-design.md" };
    const documentId = changeDocumentIdentity(identity);
    const request = JSON.stringify({
      schema_version: 1, contract_kind: "detail_request", view: "change_records",
      project_id: identity.project_id,
      query_scope: { actor_id: "actor_owner", accessible_project_ids: [identity.project_id],
        content_types: ["change_document", "archive_package", "project_content_candidate"] },
      detail_id: documentId
    });
    const raw = {
      schema_version: 1, source_kind: "change_document_detail", actor_id: "actor_owner",
      project_id: identity.project_id, accessible_project_ids: [identity.project_id],
      content_types: ["change_document", "archive_package", "project_content_candidate"],
      sort: "archived_at_desc_change_key_asc", request_cursor: null,
      detail_id: documentId, document_id: documentId, change_key: identity.change_key,
      document_type: identity.document_type, source_path: identity.source_path,
      content_hash: utf8Hash("你好🙂"), media_type: "text/markdown", content: "你好🙂"
    };
    for (const drift of [
      { content_hash: hash("f") }, { document_type: "plan" },
      { source_path: "plans/change-a-test-scenarios.md" },
      { source_path: ".harness/rules/architecture.md" }, { document_id: "doc_forged" }
    ]) {
      const adapter = createChangeRecordsQueryAdapter({
        source_port: source({ async getDetail() { return JSON.stringify({ ...raw, ...drift }); } }),
        cursor_verifier: { verify: () => true }
      });
      expect(await adapter.queryDetail(request)).toEqual({ ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" });
    }
  });

  it("rejects a fully shaped detail response for the same change key from another project", async () => {
    const request = JSON.stringify({
      schema_version: 1, contract_kind: "detail_request", view: "change_records",
      project_id: "prj_change_records",
      query_scope: { actor_id: "actor_owner", accessible_project_ids: ["prj_change_records"],
        content_types: ["change_document", "archive_package", "project_content_candidate"] },
      detail_id: "change-a"
    });
    const adapter = createChangeRecordsQueryAdapter({
      source_port: source({ async getDetail() { return JSON.stringify({
        schema_version: 1, source_kind: "change_record_detail", actor_id: "actor_owner",
        project_id: "prj_foreign", accessible_project_ids: ["prj_change_records"],
        content_types: ["change_document", "archive_package", "project_content_candidate"],
        sort: "archived_at_desc_change_key_asc", request_cursor: null, detail_id: "change-a",
        change_key: "change-a", document_refs: [], candidate_refs: [],
        archive_id: null, package_sha256: null
      }); } }),
      cursor_verifier: { verify: () => true }
    });
    expect(await adapter.queryDetail(request)).toEqual({
      ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID"
    });
  });

  it("binds the test scenarios path to the exact change key", async () => {
    expect(sourcePathDocumentType("plans/change-a-test-scenarios.md", "change-a"))
      .toBe("test_scenarios");
    expect(sourcePathDocumentType("plans/change-b-test-scenarios.md", "change-a")).toBeNull();
    expect(sourcePathDocumentType("plans/nested/change-a-test-scenarios.md", "change-a")).toBeNull();
    expect(sourcePathDocumentType("spec/change-a-test-scenarios.md", "change-a")).toBeNull();
    const projectId = "prj_change_records";
    const changeKey = "change-a";
    for (const sourcePath of [
      "plans/change-b-test-scenarios.md",
      "plans/nested/change-a-test-scenarios.md",
      "spec/change-a-test-scenarios.md"
    ]) {
      const documentId = changeDocumentIdentity({
        project_id: projectId, change_key: changeKey,
        document_type: "test_scenarios", source_path: sourcePath
      });
      const request = JSON.stringify({
        schema_version: 1, contract_kind: "detail_request", view: "change_records",
        project_id: projectId,
        query_scope: { actor_id: "actor_owner", accessible_project_ids: [projectId],
          content_types: ["change_document", "archive_package", "project_content_candidate"] },
        detail_id: documentId
      });
      const adapter = createChangeRecordsQueryAdapter({
        source_port: source({ async getDetail() { return JSON.stringify({
          schema_version: 1, source_kind: "change_document_detail", actor_id: "actor_owner",
          project_id: projectId, accessible_project_ids: [projectId],
          content_types: ["change_document", "archive_package", "project_content_candidate"],
          sort: "archived_at_desc_change_key_asc", request_cursor: null,
          detail_id: documentId, document_id: documentId, change_key: changeKey,
          document_type: "test_scenarios", source_path,
          content_hash: utf8Hash("# 场景"), media_type: "text/markdown", content: "# 场景"
        }); } }),
        cursor_verifier: { verify: () => true }
      });
      expect(await adapter.queryDetail(request)).toEqual({
        ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID"
      });
    }
  });

  it("rejects non-canonical change keys before projecting any source record", async () => {
    const invalidKeys = [
      "nested/change-a", "nested\\change-a", ".", "..", "change\u0000a", "a".repeat(161)
    ];
    for (const [index, changeKey] of invalidKeys.entries()) {
      const sourcePath = `plans/${changeKey}-test-scenarios.md`;
      const documentId = `doc_${index.toString(16).padStart(32, "0")}`;
      const request = JSON.stringify({
        schema_version: 1, contract_kind: "detail_request", view: "change_records",
        project_id: "prj_change_records",
        query_scope: { actor_id: "actor_owner", accessible_project_ids: ["prj_change_records"],
          content_types: ["change_document", "archive_package", "project_content_candidate"] },
        detail_id: documentId
      });
      let projectionCalls = 0;
      const adapter = createChangeRecordsQueryAdapter({
        source_port: source({ async getDetail() { projectionCalls += 1; return JSON.stringify({
          schema_version: 1, source_kind: "change_document_detail", actor_id: "actor_owner",
          project_id: "prj_change_records", accessible_project_ids: ["prj_change_records"],
          content_types: ["change_document", "archive_package", "project_content_candidate"],
          sort: "archived_at_desc_change_key_asc", request_cursor: null,
          detail_id: documentId, document_id: documentId, change_key: changeKey,
          document_type: "test_scenarios", source_path: sourcePath,
          content_hash: utf8Hash("# 场景"), media_type: "text/markdown", content: "# 场景"
        }); } }),
        cursor_verifier: { verify: () => true }
      });
      expect(await adapter.queryDetail(request), JSON.stringify(changeKey)).toEqual({
        ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID"
      });
      expect(projectionCalls).toBe(1);
      expect(sourcePathDocumentType(sourcePath, changeKey)).toBeNull();

      const pageRequest = await fixture("change-records-query-v1-current.json");
      const pageSource = JSON.parse(await source().listPage({
        project_id: "prj_change_records", actor_id: "actor_owner",
        accessible_project_ids: ["prj_change_records"],
        content_types: ["change_document", "archive_package", "project_content_candidate"],
        limit: 2, cursor: null, sort: "archived_at_desc_change_key_asc", request_cursor: null
      }));
      pageSource.records[0].change_key = changeKey;
      const pageAdapter = createChangeRecordsQueryAdapter({
        source_port: source({ async listPage() { return JSON.stringify(pageSource); } }),
        cursor_verifier: { verify: () => true }
      });
      expect(await pageAdapter.queryPage(pageRequest)).toEqual({
        ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID"
      });

      const recordRequest = JSON.stringify({
        schema_version: 1, contract_kind: "detail_request", view: "change_records",
        project_id: "prj_change_records",
        query_scope: { actor_id: "actor_owner", accessible_project_ids: ["prj_change_records"],
          content_types: ["change_document", "archive_package", "project_content_candidate"] },
        detail_id: changeKey
      });
      let recordSourceCalls = 0;
      const recordAdapter = createChangeRecordsQueryAdapter({
        source_port: source({ async getDetail(input) { recordSourceCalls += 1; return JSON.stringify({
          schema_version: 1, source_kind: "change_record_detail", actor_id: input.actor_id,
          project_id: input.project_id, accessible_project_ids: input.accessible_project_ids,
          content_types: input.content_types, sort: input.sort, request_cursor: input.request_cursor,
          detail_id: input.detail_id, change_key: changeKey, document_refs: [], candidate_refs: [],
          archive_id: null, package_sha256: null
        }); } }),
        cursor_verifier: { verify: () => true }
      });
      expect(await recordAdapter.queryDetail(recordRequest)).toEqual({
        ok: false, reason_code: "CHANGE_RECORDS_QUERY_INVALID"
      });
      expect(recordSourceCalls).toBe(0);
    }
  });

  it("keeps every published document ref closed over the detail interface", async () => {
    const listAdapter = createChangeRecordsQueryAdapter({
      source_port: source(), cursor_verifier: { verify: () => true }
    });
    const page = await listAdapter.queryPage(await fixture("change-records-query-v1-current.json"));
    if (!page.ok) throw new Error(page.reason_code);
    const listRefs = page.value.items[0]?.item_kind === "change_record"
      ? page.value.items[0].document_refs : [];

    const recordRequest = JSON.stringify({
      schema_version: 1, contract_kind: "detail_request", view: "change_records",
      project_id: "prj_change_records",
      query_scope: { actor_id: "actor_owner", accessible_project_ids: ["prj_change_records"],
        content_types: ["change_document", "archive_package", "project_content_candidate"] },
      detail_id: "change-a"
    });
    const record = await listAdapter.queryDetail(recordRequest);
    if (!record.ok || record.value.detail.detail_kind !== "change_record") throw new Error("detail failed");
    expect(record.value.detail.document_refs).toEqual(listRefs);

    for (const [index, detailId] of listRefs.entries()) {
      const definition = documentDefinitions[index];
      if (definition === undefined) throw new Error("definition missing");
      const content = documentContents[index];
      if (content === undefined) throw new Error("content missing");
      const adapter = createChangeRecordsQueryAdapter({
        source_port: source({ async getDetail(input) { return JSON.stringify({
          schema_version: 1, source_kind: "change_document_detail", actor_id: input.actor_id,
          project_id: input.project_id, accessible_project_ids: input.accessible_project_ids,
          content_types: input.content_types, sort: input.sort, request_cursor: input.request_cursor,
          detail_id: input.detail_id, document_id: detailId, change_key: "change-a",
          ...definition, content_hash: utf8Hash(content), archive_id: "archive_a",
          package_sha256: hash("a"), media_type: definition.document_type === "change_summary"
            ? "application/json" : "text/markdown", content
        }); } }),
        cursor_verifier: { verify: () => true }
      });
      const request = JSON.parse(recordRequest);
      request.detail_id = detailId;
      expect(await adapter.queryDetail(JSON.stringify(request))).toMatchObject({
        ok: true, value: { detail_id: detailId }
      });
    }
  });

  it("rejects a non-canonical document ref at the serialized source seam", async () => {
    const raw = JSON.parse(await source().listPage({
      project_id: "prj_change_records", actor_id: "actor_owner",
      accessible_project_ids: ["prj_change_records"],
      content_types: ["change_document", "archive_package", "project_content_candidate"],
      limit: 2, cursor: null, sort: "archived_at_desc_change_key_asc", request_cursor: null
    }));
    raw.records[0].document_refs = ["doc_design"];
    const adapter = createChangeRecordsQueryAdapter({
      source_port: source({ async listPage() { return JSON.stringify(raw); } }),
      cursor_verifier: { verify: () => true }
    });
    expect(await adapter.queryPage(await fixture("change-records-query-v1-current.json"))).toEqual({
      ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID"
    });
  });

  it("rejects forged, unresolved, cross-change, duplicate, hostile, and non-NFC reference evidence", async () => {
    const forgedId = `doc_${"f".repeat(32)}`;
    const base = JSON.parse(await source().listPage({
      project_id: "prj_change_records", actor_id: "actor_owner",
      accessible_project_ids: ["prj_change_records"],
      content_types: ["change_document", "archive_package", "project_content_candidate"],
      limit: 2, cursor: null, sort: "archived_at_desc_change_key_asc", request_cursor: null
    }));
    base.records[0].document_refs = [forgedId];
    const descriptor = {
      document_id: forgedId, project_id: "prj_change_records", change_key: "change-a",
      document_type: "design", source_path: "spec/change-a-design.md",
      content_hash: utf8Hash("# 设计"), source_archive_id: "archive_a",
      source_package_sha256: hash("a")
    };
    for (const descriptors of [[descriptor], [], [{ ...descriptor, change_key: "change-b" }]]) {
      const adapter = createChangeRecordsQueryAdapter({
        source_port: source({ async listPage() { return JSON.stringify(base); } }),
        reference_port: { async resolve(input) { return JSON.stringify({
          schema_version: 1, source_kind: "change_document_reference_resolution",
          actor_id: input.actor_id, project_id: input.project_id,
          references: input.references, descriptors
        }); } },
        cursor_verifier: { verify: () => true }
      });
      expect(await adapter.queryPage(await fixture("change-records-query-v1-current.json"))).toEqual({
        ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID"
      });
    }
    base.records[0].document_refs = [documentRefs[0], documentRefs[0]];
    const duplicateAdapter = createChangeRecordsQueryAdapter({
      source_port: source({ async listPage() { return JSON.stringify(base); } }),
      cursor_verifier: { verify: () => true }
    });
    expect(await duplicateAdapter.queryPage(await fixture("change-records-query-v1-current.json")))
      .toEqual({ ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" });

    base.records[0].document_refs = [documentRefs[0]];
    const hostileAdapter = createChangeRecordsQueryAdapter({
      source_port: source({ async listPage() { return JSON.stringify(base); } }),
      reference_port: { async resolve() { return {} as never; } },
      cursor_verifier: { verify: () => true }
    });
    expect(await hostileAdapter.queryPage(await fixture("change-records-query-v1-current.json")))
      .toEqual({ ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID" });

    const nfdPath = "spec/change-a-de\u0301sign.md";
    const nfdId = changeDocumentIdentity({ project_id: "prj_change_records", change_key: "change-a",
      document_type: "design", source_path: nfdPath });
    const request = JSON.stringify({
      schema_version: 1, contract_kind: "detail_request", view: "change_records",
      project_id: "prj_change_records",
      query_scope: { actor_id: "actor_owner", accessible_project_ids: ["prj_change_records"],
        content_types: ["change_document", "archive_package", "project_content_candidate"] }, detail_id: nfdId
    });
    const nfdAdapter = createChangeRecordsQueryAdapter({
      source_port: source({ async getDetail(input) { return JSON.stringify({
        schema_version: 1, source_kind: "change_document_detail", actor_id: input.actor_id,
        project_id: input.project_id, accessible_project_ids: input.accessible_project_ids,
        content_types: input.content_types, sort: input.sort, request_cursor: input.request_cursor,
        detail_id: nfdId, document_id: nfdId, change_key: "change-a", document_type: "design",
        source_path: nfdPath, content_hash: utf8Hash("x"), media_type: "text/markdown", content: "x"
      }); } }),
      cursor_verifier: { verify: () => true }
    });
    expect(await nfdAdapter.queryDetail(request)).toEqual({
      ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID"
    });
  });

  it("binds descriptor content and archive tuple to the current record snapshot", async () => {
    const base = JSON.parse(await source().listPage({
      project_id: "prj_change_records", actor_id: "actor_owner",
      accessible_project_ids: ["prj_change_records"],
      content_types: ["change_document", "archive_package", "project_content_candidate"],
      limit: 2, cursor: null, sort: "archived_at_desc_change_key_asc", request_cursor: null
    }));
    const descriptor = {
      document_id: documentRefs[0], project_id: "prj_change_records", change_key: "change-a",
      document_type: "design", source_path: "spec/change-a-design.md",
      content_hash: utf8Hash(documentContents[0]), source_archive_id: "archive_a",
      source_package_sha256: hash("a")
    };
    for (const drift of [
      { source_archive_id: "archive_foreign" },
      { source_package_sha256: hash("b") },
      { content_hash: hash("c") }
    ]) {
      const adapter = createChangeRecordsQueryAdapter({
        source_port: source({ async listPage() { return JSON.stringify(base); } }),
        reference_port: { async resolve(input) { return JSON.stringify({
          schema_version: 1, source_kind: "change_document_reference_resolution",
          actor_id: input.actor_id, project_id: input.project_id, references: input.references,
          descriptors: [
            { ...descriptor, ...drift },
            ...documentRefs.slice(1).map((documentId, index) => ({
              document_id: documentId, project_id: "prj_change_records", change_key: "change-a",
              ...documentDefinitions[index + 1], content_hash: utf8Hash(documentContentAt(index + 1)),
              source_archive_id: "archive_a", source_package_sha256: hash("a")
            }))
          ]
        }); } },
        cursor_verifier: { verify: () => true }
      });
      expect(await adapter.queryPage(await fixture("change-records-query-v1-current.json"))).toEqual({
        ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID"
      });
    }

    const recordRequest = JSON.stringify({
      schema_version: 1, contract_kind: "detail_request", view: "change_records",
      project_id: "prj_change_records",
      query_scope: { actor_id: "actor_owner", accessible_project_ids: ["prj_change_records"],
        content_types: ["change_document", "archive_package", "project_content_candidate"] },
      detail_id: "change-a"
    });
    for (const drift of [
      { source_archive_id: "archive_foreign" },
      { source_package_sha256: hash("b") },
      { content_hash: hash("c") }
    ]) {
      const adapter = createChangeRecordsQueryAdapter({
        source_port: source(),
        reference_port: { async resolve(input) { return JSON.stringify({
          schema_version: 1, source_kind: "change_document_reference_resolution",
          actor_id: input.actor_id, project_id: input.project_id, references: input.references,
          descriptors: documentRefs.map((documentId, index) => ({
            document_id: documentId, project_id: "prj_change_records", change_key: "change-a",
            ...documentDefinitions[index], content_hash: utf8Hash(documentContentAt(index)),
            source_archive_id: "archive_a", source_package_sha256: hash("a"),
            ...(index === 0 ? drift : {})
          }))
        }); } },
        cursor_verifier: { verify: () => true }
      });
      expect(await adapter.queryDetail(recordRequest)).toEqual({
        ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID"
      });
    }

    const detailId = documentRefs[0];
    const detailRequest = JSON.parse(recordRequest);
    detailRequest.detail_id = detailId;
    for (const drift of [
      { source_archive_id: "archive_foreign" },
      { source_package_sha256: hash("b") },
      { content_hash: hash("c") }
    ]) {
      const adapter = createChangeRecordsQueryAdapter({
        source_port: source({ async getDetail(input) { return JSON.stringify({
          schema_version: 1, source_kind: "change_document_detail", actor_id: input.actor_id,
          project_id: input.project_id, accessible_project_ids: input.accessible_project_ids,
          content_types: input.content_types, sort: input.sort, request_cursor: null,
          detail_id: detailId, document_id: detailId, change_key: "change-a", document_type: "design",
          source_path: "spec/change-a-design.md", content_hash: utf8Hash(documentContents[0]),
          archive_id: "archive_a", package_sha256: hash("a"),
          media_type: "text/markdown", content: documentContents[0]
        }); } }),
        reference_port: { async resolve(input) { return JSON.stringify({
          schema_version: 1, source_kind: "change_document_reference_resolution",
          actor_id: input.actor_id, project_id: input.project_id, references: input.references,
          descriptors: [{ ...descriptor, ...drift }]
        }); } },
        cursor_verifier: { verify: () => true }
      });
      expect(await adapter.queryDetail(JSON.stringify(detailRequest))).toEqual({
        ok: false, reason_code: "CHANGE_RECORDS_SOURCE_INVALID"
      });
    }
  });

  it("preserves an explicit missing detail result", async () => {
    const adapter = createChangeRecordsQueryAdapter({
      source_port: source({ async getDetail() { return null; } }),
      reference_port: { async resolve() { throw new Error("must not resolve"); } },
      cursor_verifier: { verify: () => true }
    });
    const query = JSON.parse(await fixture("change-records-query-v1-current.json")) as Record<string, unknown>;
    await expect(adapter.queryDetail(JSON.stringify({
      schema_version: query.schema_version,
      contract_kind: "detail_request",
      view: query.view,
      project_id: query.project_id,
      query_scope: query.query_scope,
      detail_id: "change-a"
    }))).resolves.toEqual({
      ok: false, reason_code: "CHANGE_RECORDS_DETAIL_NOT_FOUND"
    });
  });
});
