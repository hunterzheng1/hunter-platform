import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import {
  canonicalJson,
  type PlatformInformationExportHashPort,
  type PlatformInformationPage,
  type PlatformInformationQuery,
} from "@hunter-harness/contracts";
import {
  createMemoryPlatformInformationExportArtifactPort,
  createMemoryPlatformInformationExportPageSource,
  createNodePlatformInformationExportHashPort,
  createPlatformInformationExportModule,
} from "../src/platform-information-export/index.js";

const query: PlatformInformationQuery = {
  schema_version: 1,
  contract_kind: "query",
  view: "project_knowledge",
  project_id: "prj_demo",
  query_scope: {
    actor_id: "actor_1",
    accessible_project_ids: ["prj_demo"],
    content_types: ["knowledge_entry"],
  },
  limit: 2,
  cursor: null,
  cursor_verification: "server_port_required",
  sort: "extracted_at_desc_knowledge_id_asc",
};

function item(id: string, timestamp: string) {
  return {
    item_kind: "knowledge_entry" as const,
    knowledge_id: id,
    display_title: `知识 ${id}`,
    lifecycle_status: "active" as const,
    source_change_key: `change_${id}`,
    extracted_at: timestamp,
    relationship_count: 0,
    sort_key: `${timestamp}:${id}`,
  };
}

function page(
  items: PlatformInformationPage["items"],
  next_cursor: string | null,
): PlatformInformationPage {
  return {
    schema_version: 1,
    contract_kind: "page",
    view: "project_knowledge",
    project_id: "prj_demo",
    page_state: items.length === 0 ? "empty" : "ready",
    sort: "extracted_at_desc_knowledge_id_asc",
    items,
    next_cursor,
    failures: [],
  };
}

async function signedSourcePage(
  request: PlatformInformationQuery,
  currentPage: PlatformInformationPage,
  hashPort = createNodePlatformInformationExportHashPort(),
): Promise<string> {
  const encoder = new TextEncoder();
  const items_sha = await hashPort.sha256(encoder.encode(canonicalJson(currentPage.items)));
  const payload = {
    schema_version: 1,
    source_kind: "platform_information_export_page",
    request,
    page: currentPage,
    items_sha,
  } as const;
  const proof_sha = await hashPort.sha256(encoder.encode(canonicalJson(payload)));
  return canonicalJson({ ...payload, proof_sha });
}

describe("Platform Information streaming Export Module", () => {
  it("accepts the current source fixture and fails the legacy fixture closed", async () => {
    const [current, legacy] = await Promise.all([
      readFile(new URL("./fixtures/platform-information-export-source-v1-current.json", import.meta.url), "utf8"),
      readFile(new URL("./fixtures/platform-information-export-source-v0-legacy.json", import.meta.url), "utf8"),
    ]);
    const hash_port = createNodePlatformInformationExportHashPort();
    const currentArtifact = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    const currentResult = await createPlatformInformationExportModule({
      hash_port,
      artifact_port: currentArtifact,
      page_source: { read_page: async () => current },
    }).export_all(query);
    const legacyArtifact = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    const legacyResult = await createPlatformInformationExportModule({
      hash_port,
      artifact_port: legacyArtifact,
      page_source: { read_page: async () => legacy },
    }).export_all(query);

    expect(currentResult).toMatchObject({ ok: true, value: { artifact: { item_count: 0 } } });
    expect(legacyResult).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_PAGE_INVALID",
    });
    expect(legacyArtifact.metrics).toMatchObject({ abort_count: 1, commit_count: 0 });
  });

  it("exports two pages as a self-verified canonical JSONL artifact", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const page_source = createMemoryPlatformInformationExportPageSource({
      initial_query: query,
      pages: [
        page([
          item("one", "2026-08-14T02:00:00Z"),
          item("two", "2026-08-14T01:00:00Z"),
        ], "cursor_00000000000001"),
        page([item("three", "2026-08-14T00:00:00Z")], null),
      ],
      hash_port,
    });
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({
      hash_port,
      now: () => "2026-08-14T03:00:00Z",
    });
    const result = await createPlatformInformationExportModule({
      page_source,
      artifact_port,
      hash_port,
    }).export_all(query);

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "ready",
        artifact: { item_count: 3, page_count: 2 },
        m4_proof: { exported_count: 3, completed: true },
      },
    });
    expect(page_source.metrics.read_count).toBe(2);
    expect(artifact_port.metrics.max_unacknowledged_appends).toBe(1);
    expect(artifact_port.metrics.commit_count).toBe(1);
  });

  it("exports one terminal empty page without inventing items", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([], null)],
        hash_port,
      }),
    }).export_all(query);

    expect(result).toMatchObject({
      ok: true,
      value: {
        artifact: { item_count: 0, page_count: 1 },
        m4_proof: {
          pages: [{ request_cursor: null, response_next_cursor: null, result_count: 0 }],
          exported_count: 0,
        },
      },
    });
  });

  it("starts the proof at the trusted resume cursor", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const resumeQuery = { ...query, cursor: "cursor_resume_0001" };
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port: createMemoryPlatformInformationExportArtifactPort({ hash_port }),
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: resumeQuery,
        pages: [page([item("resumed", "2026-08-14T00:00:00Z")], null)],
        hash_port,
      }),
    }).export_all(resumeQuery);

    expect(result).toMatchObject({
      ok: true,
      value: { m4_proof: { pages: [{ request_cursor: "cursor_resume_0001" }] } },
    });
  });

  it("commits the same query and output idempotently", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const pages = [page([item("stable", "2026-08-14T00:00:00Z")], null)];
    const page_source = createMemoryPlatformInformationExportPageSource({
      initial_query: query,
      pages,
      hash_port,
    });
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({
      hash_port,
      now: () => "2026-08-14T03:00:00Z",
    });
    const module = createPlatformInformationExportModule({ hash_port, page_source, artifact_port });

    const first = await module.export_all(query);
    const second = await module.export_all(query);

    expect(second).toEqual(first);
    expect(artifact_port.metrics.commit_count).toBe(2);
    expect(artifact_port.metrics.abort_count).toBe(0);
  });

  it("accepts a genuine cross-realm Promise from an Artifact Port", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const memory = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    const crossRealmResolve = runInNewContext("(value) => Promise.resolve(value)") as
      (value: unknown) => Promise<unknown>;
    const artifact_port = {
      ...memory,
      begin(input: Parameters<typeof memory.begin>[0]) {
        return crossRealmResolve(memory.begin(input)) as never;
      },
    };
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([], null)],
        hash_port,
      }),
    }).export_all(query);

    expect(result).toMatchObject({ ok: true, value: { artifact: { item_count: 0 } } });
  });

  it("rejects a different output for an already committed query", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const mutablePage = page([item("first", "2026-08-14T00:00:00Z")], null);
    const page_source = createMemoryPlatformInformationExportPageSource({
      initial_query: query,
      pages: [mutablePage],
      hash_port,
    });
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({
      hash_port,
      now: () => "2026-08-14T03:00:00Z",
    });
    const module = createPlatformInformationExportModule({ hash_port, page_source, artifact_port });
    expect((await module.export_all(query)).ok).toBe(true);
    mutablePage.items = [item("changed", "2026-08-14T00:00:00Z")];

    await expect(module.export_all(query)).resolves.toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_COMMIT_CONFLICT",
    });
    expect(artifact_port.metrics.abort_count).toBe(1);
  });

  it("rejects hostile input before executing any Port", async () => {
    let executions = 0;
    const trap = () => { executions += 1; throw new Error("port must not execute"); };
    const module = createPlatformInformationExportModule({
      hash_port: { sha256: trap, create_sha256: trap },
      page_source: { read_page: trap },
      artifact_port: { begin: trap, append: trap, commit: trap, abort: trap },
    });

    await expect(module.export_all({ ...query, extra: true })).resolves.toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_QUERY_INVALID",
    });
    expect(executions).toBe(0);
  });

  it.each(["getter", "proxy"])("rejects a hostile %s begin output without traps or later Port calls", async (kind) => {
    const hash_port = createNodePlatformInformationExportHashPort();
    let getterExecutions = 0;
    let proxyTraps = 0;
    let laterCalls = 0;
    const hostile = kind === "getter"
      ? Object.defineProperty({}, "attempt_id", {
          enumerable: true,
          get() { getterExecutions += 1; return "attempt_hostile"; },
        })
      : new Proxy({}, {
          get() { proxyTraps += 1; return undefined; },
          getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
          ownKeys() { proxyTraps += 1; return []; },
          getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
        });
    const result = await createPlatformInformationExportModule({
      hash_port,
      page_source: { read_page: async () => { laterCalls += 1; return ""; } },
      artifact_port: {
        begin: () => hostile as never,
        append: async () => { laterCalls += 1; throw new Error("must not append"); },
        commit: async () => { laterCalls += 1; throw new Error("must not commit"); },
        abort: async () => { laterCalls += 1; },
      },
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    expect({ getterExecutions, proxyTraps, laterCalls }).toEqual({
      getterExecutions: 0,
      proxyTraps: 0,
      laterCalls: 0,
    });
  });

  it("aborts exactly once when begin has a trusted attempt id but hostile nested reader", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    let getterExecutions = 0;
    let aborts = 0;
    let laterCalls = 0;
    const hostileReader = Object.defineProperty({}, "read", {
      enumerable: true,
      get() { getterExecutions += 1; return () => null; },
    });
    const result = await createPlatformInformationExportModule({
      hash_port,
      page_source: { read_page: () => { laterCalls += 1; return ""; } },
      artifact_port: {
        begin: () => ({
          attempt_id: "attempt_trusted",
          export_id: "export_trusted",
          created_at: "2026-08-14T00:00:00Z",
          expires_at: "2026-08-15T00:00:00Z",
          staged_reader: hostileReader as never,
        }),
        append: () => { laterCalls += 1; throw new Error("must not append"); },
        commit: () => { laterCalls += 1; throw new Error("must not commit"); },
        abort: ({ attempt_id }) => {
          expect(attempt_id).toBe("attempt_trusted");
          aborts += 1;
        },
      },
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    expect({ getterExecutions, aborts, laterCalls }).toEqual({
      getterExecutions: 0,
      aborts: 1,
      laterCalls: 0,
    });
  });

  it("maps hostile source results exactly and aborts without commit", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    const module = createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: { read_page: async () => "{}" },
    });

    await expect(module.export_all(query)).resolves.toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_PAGE_INVALID",
    });
    expect(artifact_port.metrics).toMatchObject({ abort_count: 1, commit_count: 0 });
  });

  it.each([
    ["items sha", "PLATFORM_INFORMATION_EXPORT_PAGE_ITEMS_HASH_MISMATCH", (raw: Record<string, unknown>) => ({
      ...raw, items_sha: `sha256:${"f".repeat(64)}`,
    })],
    ["proof sha", "PLATFORM_INFORMATION_EXPORT_PAGE_PROOF_HASH_MISMATCH", (raw: Record<string, unknown>) => ({
      ...raw, proof_sha: `sha256:${"f".repeat(64)}`,
    })],
    ["identity", "PLATFORM_INFORMATION_EXPORT_PAGE_IDENTITY_MISMATCH", (raw: Record<string, unknown>) => ({
      ...raw,
      request: { ...(raw.request as Record<string, unknown>), cursor: "cursor_forged_0001" },
    })],
  ])("rejects forged page %s", async (_name, reasonCode, mutate) => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const valid = JSON.parse(await signedSourcePage(
      query,
      page([item("one", "2026-08-14T00:00:00Z")], null),
    ));
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: { read_page: async () => JSON.stringify(mutate(valid)) },
    }).export_all(query);

    expect(result).toEqual({ ok: false, reason_code: reasonCode });
    expect(artifact_port.metrics).toMatchObject({ abort_count: 1, commit_count: 0 });
  });

  it("does not claim a processing page is a completed export", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const processing: PlatformInformationPage = {
      ...page([], null),
      page_state: "processing",
    };
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [processing],
        hash_port,
      }),
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_PAGE_STATE_NOT_EXPORTABLE",
    });
    expect(artifact_port.metrics.commit_count).toBe(0);
  });

  it.each([
    ["nonprogress", "PLATFORM_INFORMATION_EXPORT_CURSOR_NONPROGRESS", [
      "cursor_resume_0001", "cursor_resume_0001",
    ]],
    ["loop", "PLATFORM_INFORMATION_EXPORT_CURSOR_LOOP", [
      "cursor_loop_000001", "cursor_loop_000002", "cursor_loop_000001",
    ]],
  ])("rejects cursor %s", async (_name, reasonCode, responseCursors) => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const start = responseCursors[0] ?? null;
    const loopQuery = { ...query, cursor: start };
    let index = 0;
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: {
        async read_page(request) {
          const next = responseCursors[Math.min(index + 1, responseCursors.length - 1)] ?? null;
          index += 1;
          return signedSourcePage(
            request,
            page([item(`item_${index}`, "2026-08-14T00:00:00Z")], next),
          );
        },
      },
    }).export_all(loopQuery);

    expect(result).toEqual({ ok: false, reason_code: reasonCode });
    expect(artifact_port.metrics).toMatchObject({ abort_count: 1, commit_count: 0 });
  });

  it("aborts when the awaited writer fails", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({
      hash_port,
      fail_append_at: 1,
    });
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([item("one", "2026-08-14T00:00:00Z")], null)],
        hash_port,
      }),
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    expect(artifact_port.metrics).toMatchObject({ abort_count: 1, commit_count: 0 });
  });

  it("rejects a Proxy append result without traps and aborts exactly once", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const memory = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    let proxyTraps = 0;
    let returnedProxy = false;
    const artifact_port = {
      ...memory,
      append(input: Parameters<typeof memory.append>[0]) {
        if (returnedProxy) return memory.append(input);
        returnedProxy = true;
        return new Proxy({}, {
          get() { proxyTraps += 1; return undefined; },
          getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
          ownKeys() { proxyTraps += 1; return []; },
          getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
        }) as never;
      },
    };
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([item("one", "2026-08-14T00:00:00Z")], null)],
        hash_port,
      }),
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    expect(proxyTraps).toBe(0);
    expect(memory.metrics.abort_count).toBe(1);
  });

  it("rejects an append getter without executing it and aborts exactly once", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const memory = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    let getterExecutions = 0;
    const artifact_port = {
      ...memory,
      append() {
        return Object.defineProperties({}, {
          sealed: { enumerable: true, get() { getterExecutions += 1; return false; } },
          content_sha: { enumerable: true, value: null },
          byte_count: { enumerable: true, value: null },
        }) as never;
      },
    };
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([item("one", "2026-08-14T00:00:00Z")], null)],
        hash_port,
      }),
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    expect(getterExecutions).toBe(0);
    expect(memory.metrics.abort_count).toBe(1);
  });

  it("aborts when the incremental item hash session throws", async () => {
    const sourceHash = createNodePlatformInformationExportHashPort();
    const failingHash: PlatformInformationExportHashPort = {
      sha256: sourceHash.sha256,
      create_sha256: () => ({
        update: () => { throw new Error("injected hash update failure"); },
        digest: () => `sha256:${"0".repeat(64)}`,
      }),
    };
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({ hash_port: sourceHash });
    const result = await createPlatformInformationExportModule({
      hash_port: failingHash,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([item("one", "2026-08-14T00:00:00Z")], null)],
        hash_port: sourceHash,
      }),
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE",
    });
    expect(artifact_port.metrics).toMatchObject({ abort_count: 1, commit_count: 0 });
  });

  it("aborts when the incremental proof hash throws", async () => {
    const sourceHash = createNodePlatformInformationExportHashPort();
    let sessions = 0;
    const failingHash: PlatformInformationExportHashPort = {
      sha256: sourceHash.sha256,
      create_sha256() {
        sessions += 1;
        if (sessions === 2) {
          return {
            update: () => { throw new Error("injected proof hash failure"); },
            digest: () => `sha256:${"0".repeat(64)}`,
          };
        }
        return sourceHash.create_sha256();
      },
    };
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({ hash_port: sourceHash });
    const result = await createPlatformInformationExportModule({
      hash_port: failingHash,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([], null)],
        hash_port: sourceHash,
      }),
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_HASH_PORT_FAILURE",
    });
    expect(artifact_port.metrics).toMatchObject({ abort_count: 1, commit_count: 0 });
  });

  it("aborts a failed commit and leaves no committed artifact", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({
      hash_port,
      throw_on_commit: true,
    });
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([], null)],
        hash_port,
      }),
    }).export_all(query);
    const queryKey = await hash_port.sha256(new TextEncoder().encode(canonicalJson(query)));

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    expect(artifact_port.read_committed(queryKey)).toBeNull();
    expect(artifact_port.metrics).toMatchObject({ abort_count: 1, commit_count: 1 });
  });

  it.each([
    ["non-string", 42, "PLATFORM_INFORMATION_EXPORT_PAGE_SERIALIZED_JSON_REQUIRED"],
    ["oversized", "x".repeat(1024 * 1024 + 1), "PLATFORM_INFORMATION_EXPORT_PAGE_SERIALIZED_JSON_TOO_LARGE"],
  ])("rejects a %s source payload before parsing", async (_name, sourceResult, reasonCode) => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: { read_page: async () => sourceResult },
    }).export_all(query);

    expect(result).toEqual({ ok: false, reason_code: reasonCode });
    expect(artifact_port.metrics).toMatchObject({ abort_count: 1, commit_count: 0 });
  });

  it("aborts when staged bytes fail the terminal M6A self-verifier", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const memory = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    const artifact_port = {
      ...memory,
      async begin(input: Parameters<typeof memory.begin>[0]) {
        const begun = await memory.begin(input);
        let first = true;
        return {
          ...begun,
          staged_reader: {
            async read() {
              const chunk = await begun.staged_reader.read();
              if (chunk === null || !first) return chunk;
              first = false;
              const corrupted = chunk.slice();
              corrupted[0] = (corrupted[0] ?? 0) ^ 1;
              return corrupted;
            },
          },
        };
      },
    };
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([], null)],
        hash_port,
      }),
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_SELF_VERIFICATION_FAILED",
    });
    expect(memory.metrics).toMatchObject({ abort_count: 1, commit_count: 0 });
  });

  it("rejects a Proxy staged-reader chunk without traps and aborts exactly once", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const memory = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    let proxyTraps = 0;
    const artifact_port = {
      ...memory,
      async begin(input: Parameters<typeof memory.begin>[0]) {
        const begun = await memory.begin(input);
        return {
          ...begun,
          staged_reader: {
            read() {
              return new Proxy(new Uint8Array([1]), {
                get() { proxyTraps += 1; return undefined; },
                getPrototypeOf() { proxyTraps += 1; return Uint8Array.prototype; },
              });
            },
          },
        };
      },
    };
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([], null)],
        hash_port,
      }),
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_SELF_VERIFICATION_FAILED",
    });
    expect(proxyTraps).toBe(0);
    expect(memory.metrics.abort_count).toBe(1);
  });

  it("rejects a Proxy commit result without traps and aborts exactly once", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const memory = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    let proxyTraps = 0;
    const artifact_port = {
      ...memory,
      commit() {
        return new Proxy({}, {
          get() { proxyTraps += 1; return undefined; },
          getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
          ownKeys() { proxyTraps += 1; return []; },
          getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
        }) as never;
      },
    };
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([], null)],
        hash_port,
      }),
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    expect(proxyTraps).toBe(0);
    expect(memory.metrics.abort_count).toBe(1);
  });

  it("snapshots a commit receipt before schema parsing and never executes nested getters", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const memory = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    let getterExecutions = 0;
    const artifact_port = {
      ...memory,
      commit() {
        const receipt = Object.defineProperty({}, "schema_version", {
          enumerable: true,
          get() { getterExecutions += 1; return 1; },
        });
        return { ok: true as const, receipt: receipt as never };
      },
    };
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([], null)],
        hash_port,
      }),
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    expect(getterExecutions).toBe(0);
    expect(memory.metrics.abort_count).toBe(1);
  });

  it.each([
    ["sparse", 10_000],
    ["huge", 4_294_967_295],
  ])("rejects a %s receipt array before proportional result allocation", async (_name, length) => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const memory = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    const artifact_port = {
      ...memory,
      commit(input: Parameters<typeof memory.commit>[0]) {
        const receipt = JSON.parse(input.serialized_receipt) as {
          m4_proof: { pages: unknown[] };
        };
        const hostilePages: unknown[] = [];
        hostilePages.length = length;
        receipt.m4_proof.pages = hostilePages;
        return { ok: true as const, receipt: receipt as never };
      },
    };
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([], null)],
        hash_port,
      }),
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    expect(memory.metrics.abort_count).toBe(1);
  });

  it("accepts exactly 10,000 pages while buffering only one page and one bounded append", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    let reads = 0;
    let activePages = 0;
    let maxActivePages = 0;
    let maxPageBytes = 0;
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: {
        async read_page(request) {
          reads += 1;
          activePages += 1;
          maxActivePages = Math.max(maxActivePages, activePages);
          try {
            const next = reads === 10_000
              ? null
              : `cursor_${String(reads).padStart(12, "0")}`;
            const serialized = await signedSourcePage(
              request,
              page([item(`item_${reads}`, "2026-08-14T00:00:00Z")], next),
            );
            maxPageBytes = Math.max(maxPageBytes, new TextEncoder().encode(serialized).byteLength);
            return serialized;
          } finally {
            activePages -= 1;
          }
        },
      },
    }).export_all(query);

    expect(result).toMatchObject({
      ok: true,
      value: { artifact: { page_count: 10_000, item_count: 10_000 } },
    });
    expect(reads).toBe(10_000);
    expect(maxActivePages).toBe(1);
    expect(maxPageBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(artifact_port.metrics.max_unacknowledged_appends).toBe(1);
    expect(artifact_port.metrics.max_append_chunk_bytes).toBeLessThanOrEqual(1024 * 1024);
  }, 60_000);

  it("aborts before reading page 10,001", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const artifact_port = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    let reads = 0;
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: {
        async read_page(request) {
          reads += 1;
          return signedSourcePage(
            request,
            page(
              [item(`item_${reads}`, "2026-08-14T00:00:00Z")],
              `cursor_${String(reads).padStart(12, "0")}`,
            ),
          );
        },
      },
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_PAGE_LIMIT_EXCEEDED",
    });
    expect(reads).toBe(10_000);
    expect(artifact_port.metrics).toMatchObject({ abort_count: 1, commit_count: 0 });
  }, 60_000);

  it("rejects an artifact writer summary above the contract size cap", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const memory = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    const artifact_port = {
      ...memory,
      async append(input: Parameters<typeof memory.append>[0]) {
        const result = await memory.append(input);
        return input.seal ? {
          ...result,
          byte_count: 512 * 1024 * 1024 + 1,
        } : result;
      },
    };
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([], null)],
        hash_port,
      }),
    }).export_all(query);

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_TOO_LARGE",
    });
    expect(memory.metrics).toMatchObject({ abort_count: 1, commit_count: 0 });
  });

  it("lets the memory Port independently reject a forged commit hash and retain no partial", async () => {
    const hash_port = createNodePlatformInformationExportHashPort();
    const memory = createMemoryPlatformInformationExportArtifactPort({ hash_port });
    const artifact_port = {
      ...memory,
      async commit(input: Parameters<typeof memory.commit>[0]) {
        const receipt = JSON.parse(input.serialized_receipt) as {
          artifact: { content_sha: string };
          download_ref: { content_sha: string };
        };
        const forged = `sha256:${"f".repeat(64)}`;
        receipt.artifact.content_sha = forged;
        receipt.download_ref.content_sha = forged;
        return memory.commit({ ...input, serialized_receipt: JSON.stringify(receipt) });
      },
    };
    const result = await createPlatformInformationExportModule({
      hash_port,
      artifact_port,
      page_source: createMemoryPlatformInformationExportPageSource({
        initial_query: query,
        pages: [page([], null)],
        hash_port,
      }),
    }).export_all(query);
    const queryKey = await hash_port.sha256(new TextEncoder().encode(canonicalJson(query)));

    expect(result).toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    expect(memory.read_committed(queryKey)).toBeNull();
    expect(memory.metrics.abort_count).toBe(1);
  });
});
