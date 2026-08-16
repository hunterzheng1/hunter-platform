import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createProjectKnowledgeQueryAdapter,
  type ProjectKnowledgeQuerySourcePort
} from "../src/project-knowledge-query/index.js";

const projectId = "prj_knowledge";
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const digest = (payload: string) =>
  `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;

function query(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    contract_kind: "query",
    view: "project_knowledge",
    project_id: projectId,
    query_scope: {
      actor_id: "actor_owner",
      accessible_project_ids: [projectId],
      content_types: ["knowledge_entry"]
    },
    limit: 25,
    cursor: null,
    cursor_verification: "server_port_required",
    sort: "extracted_at_desc_knowledge_id_asc",
    ...overrides
  };
}

function dependencies(overrides: Partial<ProjectKnowledgeQuerySourcePort> = {}) {
  const source: ProjectKnowledgeQuerySourcePort = {
    async listPage(input) {
      const data = JSON.parse(await fixture("project-knowledge-query-v1-current.json")) as {
        source_page: Record<string, unknown>;
      };
      return JSON.stringify({
        ...data.source_page,
        actor_id: input.actor_id,
        project_id: input.project_id,
        accessible_project_ids: input.accessible_project_ids,
        content_types: input.content_types,
        sort: input.sort,
        request_cursor: input.cursor
      });
    },
    async getDetail(input) {
      const data = JSON.parse(await fixture("project-knowledge-query-v1-current.json")) as {
        source_detail: Record<string, unknown>;
      };
      return JSON.stringify({
        ...data.source_detail,
        actor_id: input.actor_id,
        project_id: input.project_id,
        accessible_project_ids: input.accessible_project_ids,
        content_types: input.content_types,
        sort: input.sort,
        request_cursor: input.request_cursor,
        detail_id: input.detail_id,
        knowledge_id: input.detail_id
      });
    },
    ...overrides
  };
  return {
    source_port: source,
    cursor_verifier: { verify: async () => true },
    retry_intent_hash_port: { sha256: digest },
    retry_authority_port: {
      async lookup(input) {
        return JSON.stringify({
          schema_version: 1,
          authority_kind: "knowledge_retry_authority",
          decision: "authorized",
          actor_id: input.actor_id,
          accessible_project_ids: [input.project_id],
          project_id: input.project_id,
          job_id: input.job_id,
          expected_generation: input.expected_generation,
          job_status: "failed",
          retryable: true
        });
      }
    }
  };
}

describe("ProjectKnowledgeQueryAdapter", () => {
  it("projects only explicitly extracted knowledge into the bounded summary page", async () => {
    const source = {
      schema_version: 1,
      source_kind: "project_knowledge_page",
      actor_id: "actor_owner",
      project_id: projectId,
      accessible_project_ids: [projectId],
      content_types: ["knowledge_entry"],
      sort: "extracted_at_desc_knowledge_id_asc",
      request_cursor: null,
      page_state: "ready",
      entries: [{
        entry_origin: "explicit",
        knowledge_id: "knowledge.auth.boundary",
        display_title: "认证边界",
        lifecycle_status: "active",
        source_change_key: "auth-hardening",
        source_refs: ["doc_auth_summary"],
        extracted_at: "2026-08-12T08:00:00.000Z",
        relationship_refs: ["knowledge.auth.session"]
      }],
      next_cursor: null,
      failures: []
    };
    const adapter = createProjectKnowledgeQueryAdapter({
      source_port: {
        listPage: async () => JSON.stringify(source),
        getDetail: async () => { throw new Error("unused"); }
      },
      cursor_verifier: { verify: async () => true },
      retry_intent_hash_port: {
        sha256: (payload) => `sha256:${createHash("sha256").update(payload).digest("hex")}`
      },
      retry_authority_port: dependencies().retry_authority_port
    });

    await expect(adapter.queryPage(JSON.stringify(query()))).resolves.toEqual({
      ok: true,
      value: {
        schema_version: 1,
        contract_kind: "page",
        view: "project_knowledge",
        project_id: projectId,
        page_state: "ready",
        sort: "extracted_at_desc_knowledge_id_asc",
        items: [{
          item_kind: "knowledge_entry",
          knowledge_id: "knowledge.auth.boundary",
          display_title: "认证边界",
          lifecycle_status: "active",
          source_change_key: "auth-hardening",
          extracted_at: "2026-08-12T08:00:00.000Z",
          relationship_count: 1,
          sort_key: "2026-08-12T08:00:00.000Z|knowledge.auth.boundary"
        }],
        next_cursor: null,
        failures: []
      }
    });
  });

  it("returns only a hash-bound detail after validating explicit identity and source refs", async () => {
    const data = JSON.parse(await fixture("project-knowledge-query-v1-current.json")) as {
      detail_request: unknown;
    };
    const result = await createProjectKnowledgeQueryAdapter(dependencies())
      .queryDetail(JSON.stringify(data.detail_request));

    expect(result).toEqual({
      ok: true,
      value: {
        schema_version: 1,
        contract_kind: "detail_response",
        view: "project_knowledge",
        project_id: projectId,
        detail_id: "knowledge.auth.boundary",
        detail: {
          detail_kind: "knowledge_entry",
          content: "认证令牌只在服务端边界解析。",
          content_hash: "sha256:9aba182c0fb9f00b6f465d9dd6f75c4bb81c7abe3998c696ab7521cf1ac607d1",
          media_type: "text/markdown"
        }
      }
    });
  });

  it("preserves empty, processing, failed, and forbidden page semantics exactly", async () => {
    for (const [pageState, failures] of [
      ["empty", []],
      ["processing", []],
      ["failed", [{ reason_code: "KNOWLEDGE_EXTRACTION_FAILED", retryable: true }]],
      ["forbidden", [{ reason_code: "PROJECT_INFORMATION_FORBIDDEN", retryable: false }]]
    ] as const) {
      const adapter = createProjectKnowledgeQueryAdapter(dependencies({
        async listPage(input) {
          return JSON.stringify({
            schema_version: 1,
            source_kind: "project_knowledge_page",
            actor_id: input.actor_id,
            project_id: input.project_id,
            accessible_project_ids: input.accessible_project_ids,
            content_types: input.content_types,
            sort: input.sort,
            request_cursor: input.cursor,
            page_state: pageState,
            entries: [],
            next_cursor: null,
            failures
          });
        }
      }));
      const result = await adapter.queryPage(JSON.stringify(query()));
      expect(result).toMatchObject({ ok: true, value: { page_state: pageState, failures } });
    }
  });

  it("preserves a valid partial-failure page with explicit entries", async () => {
    const data = JSON.parse(await fixture("project-knowledge-query-v1-current.json")) as {
      source_page: Record<string, unknown>;
    };
    const adapter = createProjectKnowledgeQueryAdapter(dependencies({
      async listPage() {
        return JSON.stringify({
          ...data.source_page,
          page_state: "partial_failure",
          failures: [{ reason_code: "PROJECTION_PARTIAL_FAILURE", retryable: true }]
        });
      }
    }));

    await expect(adapter.queryPage(JSON.stringify(query()))).resolves.toMatchObject({
      ok: true,
      value: {
        page_state: "partial_failure",
        items: [{ knowledge_id: "knowledge.auth.boundary" }],
        failures: [{ reason_code: "PROJECTION_PARTIAL_FAILURE", retryable: true }]
      }
    });
  });

  it("rejects every malformed partial-failure and does not loosen other page states", async () => {
    const data = JSON.parse(await fixture("project-knowledge-query-v1-current.json")) as {
      source_page: Record<string, unknown>;
    };
    const invalidPages = [
      { ...data.source_page, page_state: "partial_failure", entries: [], failures: [{ reason_code: "PROJECTION_PARTIAL_FAILURE", retryable: true }] },
      { ...data.source_page, page_state: "partial_failure", failures: [] },
      { ...data.source_page, page_state: "partial_failure", failures: [{ reason_code: "KNOWLEDGE_EXTRACTION_FAILED", retryable: true }] },
      { ...data.source_page, page_state: "failed", entries: (data.source_page.entries as unknown[]), failures: [{ reason_code: "KNOWLEDGE_EXTRACTION_FAILED", retryable: true }] },
      { ...data.source_page, page_state: "ready", failures: [{ reason_code: "PROJECTION_PARTIAL_FAILURE", retryable: true }] }
    ];
    for (const page of invalidPages) {
      const result = await createProjectKnowledgeQueryAdapter(dependencies({
        async listPage() { return JSON.stringify(page); }
      })).queryPage(JSON.stringify(query()));
      expect(result).toEqual({ ok: false, reason_code: "PROJECT_KNOWLEDGE_SOURCE_INVALID" });
    }
  });

  it("verifies opaque cursors before calling the source and passes the frozen filter set", async () => {
    const calls: unknown[] = [];
    const cursor = "opaque_cursor_123456";
    const adapter = createProjectKnowledgeQueryAdapter({
      ...dependencies({
        async listPage(input) {
          calls.push(input);
          return JSON.stringify({
            schema_version: 1,
            source_kind: "project_knowledge_page",
            actor_id: input.actor_id,
            project_id: input.project_id,
            accessible_project_ids: input.accessible_project_ids,
            content_types: input.content_types,
            sort: input.sort,
            request_cursor: input.cursor,
            page_state: "empty",
            entries: [], next_cursor: null, failures: []
          });
        }
      }),
      cursor_verifier: { verify: async (input) => { calls.push(input); return true; } }
    });
    const result = await adapter.queryPage(JSON.stringify(query({ cursor })));
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        cursor,
        project_id: projectId,
        actor_id: "actor_owner",
        view: "project_knowledge",
        sort: "extracted_at_desc_knowledge_id_asc"
      },
      expect.objectContaining({
        content_types: ["knowledge_entry"],
        accessible_project_ids: [projectId],
        cursor
      })
    ]);
  });

  it("rejects every non-boolean-true cursor verdict before source access", async () => {
    const cursor = "opaque_cursor_123456";
    for (const verdict of [false, undefined, null, "true", {}, []]) {
      let sourceCalls = 0;
      const adapter = createProjectKnowledgeQueryAdapter({
        ...dependencies({
          async listPage() {
            sourceCalls += 1;
            throw new Error("must not run");
          }
        }),
        cursor_verifier: {
          verify: async () => verdict as never
        }
      });
      await expect(adapter.queryPage(JSON.stringify(query({ cursor })))).resolves.toEqual({
        ok: false,
        reason_code: "PROJECT_KNOWLEDGE_CURSOR_INVALID"
      });
      expect(sourceCalls).toBe(0);
    }

    let thrownSourceCalls = 0;
    const throwing = createProjectKnowledgeQueryAdapter({
      ...dependencies({
        async listPage() {
          thrownSourceCalls += 1;
          throw new Error("must not run");
        }
      }),
      cursor_verifier: { verify: async () => { throw new Error("hostile port"); } }
    });
    await expect(throwing.queryPage(JSON.stringify(query({ cursor })))).resolves.toEqual({
      ok: false,
      reason_code: "PROJECT_KNOWLEDGE_CURSOR_INVALID"
    });
    expect(thrownSourceCalls).toBe(0);
  });

  it("fails closed before source access for invalid ACL, content types, cursor, and hostile objects", async () => {
    let sourceCalls = 0;
    const source: ProjectKnowledgeQuerySourcePort = {
      async listPage() { sourceCalls += 1; throw new Error("must not run"); },
      async getDetail() { sourceCalls += 1; throw new Error("must not run"); }
    };
    const adapter = createProjectKnowledgeQueryAdapter({
      source_port: source,
      cursor_verifier: { verify: async () => false },
      retry_intent_hash_port: { sha256: digest }
    });
    await expect(adapter.queryPage(JSON.stringify(query({
      query_scope: {
        actor_id: "actor_owner",
        accessible_project_ids: ["prj_other"],
        content_types: ["knowledge_entry"]
      }
    })))).resolves.toMatchObject({ ok: false, reason_code: "PROJECT_KNOWLEDGE_QUERY_INVALID" });
    await expect(adapter.queryPage(JSON.stringify(query({
      query_scope: {
        actor_id: "actor_owner",
        accessible_project_ids: [projectId],
        content_types: ["change_document"]
      }
    })))).resolves.toMatchObject({ ok: false, reason_code: "PROJECT_KNOWLEDGE_QUERY_INVALID" });
    await expect(adapter.queryPage(JSON.stringify(query({ cursor: "opaque_cursor_123456" }))))
      .resolves.toMatchObject({ ok: false, reason_code: "PROJECT_KNOWLEDGE_CURSOR_INVALID" });
    let traps = 0;
    const hostile = new Proxy({}, { get() { traps += 1; throw new Error("trap"); } });
    await expect(adapter.queryPage(hostile)).resolves.toMatchObject({
      ok: false, reason_code: "PROJECT_KNOWLEDGE_QUERY_INVALID"
    });
    expect(traps).toBe(0);
    expect(sourceCalls).toBe(0);
  });

  it("rejects inferred entries, bodies in summaries, unstable pages, wrong echoes, and forged details", async () => {
    const cases: Array<(page: Record<string, unknown>) => void> = [
      (page) => {
        const first = (page.entries as Array<Record<string, unknown>>)[0];
        if (first !== undefined) first.entry_origin = "inferred";
      },
      (page) => {
        const first = (page.entries as Array<Record<string, unknown>>)[0];
        if (first !== undefined) first.content = "must not be listed";
      },
      (page) => {
        const first = (page.entries as Array<Record<string, unknown>>)[0];
        if (first !== undefined) {
          page.entries = [
            { ...first, knowledge_id: "knowledge.z", extracted_at: "2026-08-11T08:00:00.000Z" },
            first
          ];
        }
      },
      (page) => { page.project_id = "prj_other"; }
    ];
    const raw = JSON.parse(await fixture("project-knowledge-query-v1-current.json")) as {
      source_page: Record<string, unknown>;
    };
    for (const mutate of cases) {
      const page = structuredClone(raw.source_page);
      mutate(page);
      const result = await createProjectKnowledgeQueryAdapter(dependencies({
        async listPage() { return JSON.stringify(page); }
      })).queryPage(JSON.stringify(query()));
      expect(result).toEqual({ ok: false, reason_code: "PROJECT_KNOWLEDGE_SOURCE_INVALID" });
    }

    const detailData = JSON.parse(await fixture("project-knowledge-query-v1-current.json")) as {
      detail_request: unknown; source_detail: Record<string, unknown>;
    };
    for (const patch of [
      { entry_origin: "inferred" },
      { knowledge_id: "knowledge.other" },
      { source_refs: [] },
      { content_hash: `sha256:${"0".repeat(64)}` }
    ]) {
      const detail = { ...detailData.source_detail, ...patch };
      const result = await createProjectKnowledgeQueryAdapter(dependencies({
        async getDetail() { return JSON.stringify(detail); }
      })).queryDetail(JSON.stringify(detailData.detail_request));
      expect(result).toEqual({ ok: false, reason_code: "PROJECT_KNOWLEDGE_SOURCE_INVALID" });
    }
  });

  it("generates a canonical request-only retry intent and never exposes an execution seam", async () => {
    const data = JSON.parse(await fixture("project-knowledge-query-v1-current.json")) as {
      retry_request: unknown;
    };
    const adapter = createProjectKnowledgeQueryAdapter(dependencies());
    const result = await adapter.createRetryIntent(JSON.stringify(data.retry_request));
    expect(result).toMatchObject({
      ok: true,
      value: {
        contract_kind: "knowledge_extraction_retry_intent",
        actor_id: "actor_owner",
        project_id: projectId,
        job_id: "job_knowledge_archive-001",
        expected_generation: 3,
        retryable: true,
        request_only: true
      }
    });
    if (!result.ok) return;
    expect(result.value.intent_hash).toBe(
      "sha256:0c1228d4c2d3ce23b7bc9268b5ba94c3c806c9b2256fe1fa01237ea341dbfba6"
    );
    expect(Object.keys(adapter).sort()).toEqual(["createRetryIntent", "queryDetail", "queryPage"]);
  });

  it("does not let an attacker self-sign its own retry expected anchor", async () => {
    const data = JSON.parse(await fixture("project-knowledge-query-v1-current.json")) as {
      retry_request: Record<string, unknown>;
    };
    let hashCalls = 0;
    const adapter = createProjectKnowledgeQueryAdapter({
      ...dependencies(),
      retry_authority_port: {
        async lookup(input) {
          return JSON.stringify({
            schema_version: 1,
            authority_kind: "knowledge_retry_authority",
            decision: "authorized",
            actor_id: input.actor_id,
            accessible_project_ids: [input.project_id],
            project_id: input.project_id,
            job_id: input.job_id,
            expected_generation: 3,
            job_status: "failed",
            retryable: true
          });
        }
      },
      retry_intent_hash_port: {
        sha256(payload) { hashCalls += 1; return digest(payload); }
      }
    });
    await expect(adapter.createRetryIntent(JSON.stringify({
      ...data.retry_request,
      expected_generation: 999
    }))).resolves.toEqual({
      ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_GENERATION_CONFLICT"
    });
    expect(hashCalls).toBe(0);
  });

  it("preserves a bound authority not-found decision for the HTTP 404 mapping", async () => {
    const data = JSON.parse(await fixture("project-knowledge-query-v1-current.json")) as {
      retry_request: Record<string, unknown>;
    };
    const adapter = createProjectKnowledgeQueryAdapter({
      ...dependencies(),
      retry_authority_port: {
        async lookup(input) {
          return JSON.stringify({
            schema_version: 1,
            authority_kind: "knowledge_retry_authority",
            decision: "not_found",
            actor_id: input.actor_id,
            project_id: input.project_id,
            job_id: input.job_id,
            expected_generation: input.expected_generation
          });
        }
      }
    });
    await expect(adapter.createRetryIntent(JSON.stringify(data.retry_request))).resolves.toEqual({
      ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_JOB_NOT_FOUND"
    });
  });

  it("fails closed for forbidden, missing, foreign, nonfailed, nonretryable, and hostile authority snapshots", async () => {
    const data = JSON.parse(await fixture("project-knowledge-query-v1-current.json")) as {
      retry_request: unknown;
    };
    const authorityCases: unknown[] = [
      {
        schema_version: 1, authority_kind: "knowledge_retry_authority", decision: "forbidden",
        actor_id: "actor_owner", project_id: projectId,
        job_id: "job_knowledge_archive-001", expected_generation: 3
      },
      {
        schema_version: 1, authority_kind: "knowledge_retry_authority", decision: "not_found",
        actor_id: "actor_owner", project_id: projectId,
        job_id: "job_knowledge_archive-001", expected_generation: 3
      },
      {
        schema_version: 1, authority_kind: "knowledge_retry_authority", decision: "authorized",
        actor_id: "actor_foreign", accessible_project_ids: [projectId], project_id: projectId,
        job_id: "job_knowledge_archive-001", expected_generation: 3,
        job_status: "failed", retryable: true
      },
      {
        schema_version: 1, authority_kind: "knowledge_retry_authority", decision: "authorized",
        actor_id: "actor_owner", accessible_project_ids: [projectId], project_id: projectId,
        job_id: "job_knowledge_archive-001", expected_generation: 3,
        job_status: "ready", retryable: true
      },
      {
        schema_version: 1, authority_kind: "knowledge_retry_authority", decision: "authorized",
        actor_id: "actor_owner", accessible_project_ids: [projectId], project_id: projectId,
        job_id: "job_knowledge_archive-001", expected_generation: 3,
        job_status: "failed", retryable: false
      },
      { get schema_version() { throw new Error("hostile"); } }
    ];
    for (const authority of authorityCases) {
      let hashCalls = 0;
      const adapter = createProjectKnowledgeQueryAdapter({
        ...dependencies(),
        retry_authority_port: {
          async lookup() {
            return typeof authority === "string" ? authority : JSON.stringify(authority);
          }
        },
        retry_intent_hash_port: {
          sha256(payload) { hashCalls += 1; return digest(payload); }
        }
      });
      await expect(adapter.createRetryIntent(JSON.stringify(data.retry_request))).resolves.toMatchObject({ ok: false });
      expect(hashCalls).toBe(0);
    }

    const throwing = createProjectKnowledgeQueryAdapter({
      ...dependencies(),
      retry_authority_port: { async lookup() { throw new Error("unavailable"); } }
    });
    await expect(throwing.createRetryIntent(JSON.stringify(data.retry_request))).resolves.toEqual({
      ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_AUTHORITY_INVALID"
    });
  });

  it("fails closed for legacy snapshots and malformed retry/hash ports", async () => {
    const legacy = await fixture("project-knowledge-query-v0-legacy.json");
    const adapter = createProjectKnowledgeQueryAdapter(dependencies());
    await expect(adapter.queryPage(legacy)).resolves.toEqual({
      ok: false, reason_code: "PROJECT_KNOWLEDGE_LEGACY_READ_ONLY"
    });
    await expect(adapter.createRetryIntent(JSON.stringify({ schema_version: 1 }))).resolves.toEqual({
      ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_REQUEST_INVALID"
    });
    const badHash = createProjectKnowledgeQueryAdapter({
      ...dependencies(),
      retry_intent_hash_port: { sha256: () => "not-a-hash" }
    });
    const data = JSON.parse(await fixture("project-knowledge-query-v1-current.json")) as {
      retry_request: unknown;
    };
    await expect(badHash.createRetryIntent(JSON.stringify(data.retry_request))).resolves.toEqual({
      ok: false, reason_code: "PROJECT_KNOWLEDGE_RETRY_INTENT_INVALID"
    });
  });

  it("preserves an explicit missing detail result", async () => {
    const data = JSON.parse(await fixture("project-knowledge-query-v1-current.json")) as {
      detail_request: unknown;
    };
    const deps = dependencies();
    const adapter = createProjectKnowledgeQueryAdapter({
      ...deps,
      source_port: { ...deps.source_port, async getDetail() { return null; } }
    });
    await expect(adapter.queryDetail(JSON.stringify(data.detail_request))).resolves.toEqual({
      ok: false, reason_code: "PROJECT_KNOWLEDGE_DETAIL_NOT_FOUND"
    });
  });
});
