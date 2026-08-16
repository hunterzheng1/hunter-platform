import { describe, expect, it, vi } from "vitest";

import {
  PLATFORM_INFORMATION_HTTP_OPERATIONS,
  type PlatformInformationConfirmRestoreHttpRequest,
  type RestoreBranchFilesIntent,
} from "@hunter-harness/contracts";

import { HttpHunterApi } from "../lib/api";
import type { ApiClientError } from "../lib/api";
import { MockApiClient } from "../lib/mock-api";

const hash = "sha256:" + "a".repeat(64);
const commit = "b".repeat(40);

function client(fetch: typeof globalThis.fetch): HttpHunterApi {
  return new HttpHunterApi({
    baseUrl: "https://console.test",
    tokenProvider: () => "session-token",
    fetch,
  });
}

function previewIntent(projectId = "prj_one"): RestoreBranchFilesIntent {
  return {
    schema_version: 1,
    contract_kind: "branch_files_pull_preview_intent",
    project_id: projectId,
    source_branch_name: "feature",
    source_commit_sha: commit,
    source_artifact_id: "art_one",
    source_project_version: "pv_one",
    scopes: ["branch_files"],
    selected_paths: ["src/index.ts"],
    preview_only: true,
  };
}

function confirmation(projectId = "prj_one"): PlatformInformationConfirmRestoreHttpRequest {
  const sourceRef = { project_id: projectId, branch_name: "feature", commit_sha: commit, client_id: "web" };
  const sourceVersion = { branch_name: "feature", commit_sha: commit, artifact_id: "art_one", project_version: "pv_one" };
  return {
    preview_receipt: {
      schema_version: 1,
      contract_kind: "branch_files_pull_preview_receipt",
      project_id: projectId,
      source_ref: sourceRef,
      source_version: sourceVersion,
      scopes: ["branch_files"],
      selected_paths: ["src/index.ts"],
      preview_hash: hash,
      conflicts: [],
    },
    confirmation_intent: {
      schema_version: 1,
      contract_kind: "branch_files_pull_confirmation_intent",
      project_id: projectId,
      source_ref: sourceRef,
      source_version: sourceVersion,
      scopes: ["branch_files"],
      preview_hash: hash,
      action: "continue",
      idempotency_key: "idem_one",
      conflict_decisions: [],
    },
  };
}

describe("platform information Web API adapter", () => {
  it("uses the shared list descriptor and normalizes the first-page query", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({
        schema_version: 1,
        contract_kind: "page",
        view: "project_knowledge",
        project_id: "prj_one",
        page_state: "processing",
        sort: "extracted_at_desc_knowledge_id_asc",
        items: [],
        next_cursor: null,
        failures: [],
      });
    });
    const api = client(fetch as unknown as typeof globalThis.fetch);

    await api.listPlatformInformation("prj_one", "project_knowledge", {});

    expect(calls[0]?.url).toBe("https://console.test" +
      PLATFORM_INFORMATION_HTTP_OPERATIONS.list.path
        .replace("{project_id}", "prj_one")
        .replace("{view}", "project_knowledge") + "?limit=50");
    expect(calls[0]?.init?.method).toBe(PLATFORM_INFORMATION_HTTP_OPERATIONS.list.method);
  });

  it("uses shared detail and action descriptors without hand-authored paths", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("branch-files:preview-restore")) {
        return Response.json(confirmation().preview_receipt);
      }
      if (url.includes("branch-files:confirm-restore")) {
        return Response.json({
          schema_version: 1,
          contract_kind: "branch_files_pull_confirmed_intent",
          project_id: "prj_one",
          source_ref: confirmation().preview_receipt.source_ref,
          source_version: confirmation().preview_receipt.source_version,
          scopes: ["branch_files"],
          selected_paths: ["src/index.ts"],
          preview_hash: hash,
          idempotency_key: "idem_one",
          conflict_decisions: [],
          request_only: true,
        });
      }
      if (url.includes("knowledge:retry-extraction")) {
        return Response.json({
          schema_version: 1,
          contract_kind: "knowledge_extraction_retry_intent",
          actor_id: "usr_one",
          project_id: "prj_one",
          job_id: "job_knowledge_one",
          expected_generation: 2,
          retryable: true,
          request_only: true,
          intent_hash: hash,
        });
      }
      return Response.json({
        schema_version: 1,
        contract_kind: "detail_response",
        view: "branch_files",
        project_id: "prj_one",
        detail_id: "src/index.ts",
        detail: { detail_kind: "branch_file", content: "x", content_hash: hash, media_type: "text/plain" },
      });
    });
    const api = client(fetch as unknown as typeof globalThis.fetch);

    await api.getPlatformInformationDetail("prj_one", "branch_files", "src/index.ts");
    await api.previewBranchFilesRestore("prj_one", previewIntent());
    await api.confirmBranchFilesRestore("prj_one", confirmation());
    await api.retryProjectKnowledgeExtraction("prj_one", { job_id: "job_knowledge_one", expected_generation: 2 });

    const operations = [
      PLATFORM_INFORMATION_HTTP_OPERATIONS.detail,
      PLATFORM_INFORMATION_HTTP_OPERATIONS.preview_restore,
      PLATFORM_INFORMATION_HTTP_OPERATIONS.confirm_restore,
      PLATFORM_INFORMATION_HTTP_OPERATIONS.retry_extraction,
    ];
    expect(calls.map((call) => call.init?.method)).toEqual(operations.map((operation) => operation.method));
    expect(calls.map((call) => call.url)).toEqual(operations.map((operation) => "https://console.test" + operation.path
      .replace("{project_id}", "prj_one")
      .replace("{view}", "branch_files")
      .replace("{detail_id}", encodeURIComponent("src/index.ts"))));
  });

  it("rejects a cross-project confirmation before transport", async () => {
    const fetch = vi.fn();
    const api = client(fetch as unknown as typeof globalThis.fetch);

    await expect(api.confirmBranchFilesRestore("prj_other", confirmation("prj_one"))).rejects.toMatchObject({
      status: 409,
      code: "BRANCH_FILES_PULL_CONFIRMATION_MISMATCH",
    } satisfies Partial<ApiClientError>);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the exact confirmation snapshot accepted by the semantic validator", async () => {
    const safe = confirmation();
    let calls = 0;
    const hostile = {
      toJSON() {
        calls += 1;
        return calls === 1 ? safe : { compromised: true };
      },
    } as unknown as PlatformInformationConfirmRestoreHttpRequest;
    let transmitted: unknown;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      transmitted = JSON.parse(String(init?.body)) as unknown;
      return Response.json({
        schema_version: 1,
        contract_kind: "branch_files_pull_confirmed_intent",
        project_id: "prj_one",
        source_ref: safe.preview_receipt.source_ref,
        source_version: safe.preview_receipt.source_version,
        scopes: ["branch_files"],
        selected_paths: safe.preview_receipt.selected_paths,
        preview_hash: hash,
        idempotency_key: "idem_one",
        conflict_decisions: [],
        request_only: true,
      });
    });

    await client(fetch as unknown as typeof globalThis.fetch).confirmBranchFilesRestore("prj_one", hostile);

    expect(calls).toBe(1);
    expect(transmitted).toEqual(safe);
  });

  it("preserves canonical server error status and machine code", async () => {
    const fetch = vi.fn(async () => Response.json({
      error: { code: "PROJECT_KEY_MISMATCH", message: "Project key mismatch.", details: { expected: "prj_one" } },
    }, { status: 403 }));

    await expect(client(fetch as unknown as typeof globalThis.fetch)
      .listPlatformInformation("prj_one", "branch_files", { limit: 25 }))
      .rejects.toMatchObject({ status: 403, code: "PROJECT_KEY_MISMATCH", details: { expected: "prj_one" } });
  });

  it("rejects invalid query and response wire shapes", async () => {
    const fetch = vi.fn(async () => Response.json({ page_state: "processing", items: [] }));
    const api = client(fetch as unknown as typeof globalThis.fetch);

    await expect(api.listPlatformInformation("prj_one", "branch_files", { limit: 0 }))
      .rejects.toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
    expect(fetch).not.toHaveBeenCalled();

    await expect(api.listPlatformInformation("prj_one", "branch_files"))
      .rejects.toMatchObject({ status: 503, code: "PLATFORM_INFORMATION_UNAVAILABLE" });
  });

  it("keeps demo data honest with processing lists and unsupported actions", async () => {
    const mock = new MockApiClient();
    await expect(mock.listPlatformInformation("prj_one", "branch_files"))
      .resolves.toMatchObject({ project_id: "prj_one", view: "branch_files", page_state: "processing", items: [] });
    await expect(mock.previewBranchFilesRestore("prj_one", previewIntent()))
      .rejects.toMatchObject({ status: 503, code: "PLATFORM_INFORMATION_UNAVAILABLE" });
  });
});
