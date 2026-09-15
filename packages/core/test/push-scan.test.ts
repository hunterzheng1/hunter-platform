import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { pushProject } from "../src/push/push.js";
import { scaffoldTestProject } from "./fixtures/test-project.js";

const resourcesRoot = fileURLToPath(new URL("../../workflow-data-harness", import.meta.url));

describe("pushProject sensitive scan UX", () => {
  async function initRoot(): Promise<string> {
    return scaffoldTestProject("hh-push-scan-");
  }

  it("throws SENSITIVE_CONTENT_BLOCKED with findings details when blocked", async () => {
    const root = await initRoot();
    await writeFile(
      join(root, ".harness", "rules", "unsafe.md"),
      "Authorization: Bearer blocked-secret-token-1234567890\n"
    );
    await expect(pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: true
    })).rejects.toMatchObject({
      code: "SENSITIVE_CONTENT_BLOCKED",
      details: {
        finding_count: expect.any(Number),
        findings: expect.arrayContaining([
          expect.objectContaining({
            path: ".harness/rules/unsafe.md",
            rule_id: "HH_AUTHORIZATION_BEARER"
          })
        ])
      }
    });
  });

  it("allows blocked preview when sensitiveScanSkip is true", async () => {
    const root = await initRoot();
    await writeFile(
      join(root, ".harness", "rules", "unsafe.md"),
      "Authorization: Bearer blocked-secret-token-1234567890\n"
    );
    const result = await pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: true,
      sensitiveScanSkip: true
    });
    expect(result.preview.blocked).toBe(true);
    expect(result.preview.security.findings.length).toBeGreaterThan(0);
  });

  it("excludes generated Python caches before scan and proposal construction", async () => {
    const root = await initRoot();
    const relativePath =
      ".agents/skills/harness-knowledge-ingest/scripts/__pycache__/" +
      "harness_knowledge.cpython-311.pyc";
    const cachePath = join(root, ...relativePath.split("/"));
    await mkdir(join(cachePath, ".."), { recursive: true });
    await writeFile(
      cachePath,
      Buffer.concat([
        Buffer.from("python-cache\0C:\\Users\\developer\\private-project\\source.py\0"),
        Buffer.alloc(512 * 1024, 0x61)
      ])
    );

    const result = await pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: true
    });

    expect(result.preview.operations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: relativePath })
      ])
    );
    expect(result.preview.security.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: relativePath })
      ])
    );
  });

  it("exempts harness-* working copies but still scans managed-root user files", async () => {
    const root = await initRoot();
    // v1 固定投影约定：skills 根下 harness-* 前缀 = Bundle working copy，豁免扫描；
    // 用户自写内容放在受管根下，照常扫描。
    const workingCopyDir = join(root, ".agents", "skills", "harness-local", "scripts");
    await mkdir(workingCopyDir, { recursive: true });
    await writeFile(
      join(workingCopyDir, "unsafe.py"),
      "header = 'Authorization: Bearer blocked-secret-token-1234567890'\n"
    );
    await writeFile(
      join(root, ".harness", "rules", "unsafe.py"),
      "header = 'Authorization: Bearer blocked-secret-token-1234567890'\n"
    );

    await expect(pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: true
    })).rejects.toMatchObject({
      code: "SENSITIVE_CONTENT_BLOCKED",
      details: {
        findings: expect.arrayContaining([
          expect.objectContaining({
            path: ".harness/rules/unsafe.py",
            rule_id: "HH_AUTHORIZATION_BEARER"
          })
        ])
      }
    });
  });

  it("rejects a cache-named symlink before applying cache exclusions", async () => {
    const root = await initRoot();
    const scriptsRoot = join(
      root,
      ".agents",
      "skills",
      "harness-local",
      "scripts"
    );
    const target = join(root, "python-cache-target");
    await mkdir(scriptsRoot, { recursive: true });
    await mkdir(target, { recursive: true });
    await symlink(target, join(scriptsRoot, "__pycache__"), "junction");

    await expect(pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: true
    })).rejects.toMatchObject({
      code: "UNSAFE_SYMLINK"
    });
  });

  it("does not report TOKEN_INVALID when credentials.local supplies auth", async () => {
    const root = await initRoot();
    await writeFile(
      join(root, ".harness", "credentials.local.yaml"),
      "token: cred-token\nserver_url: https://cred.example.test\n"
    );
    const fetch = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer cred-token");
      return new Response(JSON.stringify({
        schema_version: 1,
        project_id: "prj_cred",
        binding_status: "created",
        project_version: null,
        baseline_manifest: {
          schema_version: 1,
          project_id: "prj_cred",
          complete_project_version: null,
          artifact_manifest_hash: null,
          files: {}
        },
        request_id: "req"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    await expect(pushProject({
      projectRoot: root,
      resourcesRoot,
      env: {},
      dryRun: false,
      fetch
    })).rejects.not.toMatchObject({ code: "TOKEN_INVALID" });
    expect(fetch).toHaveBeenCalled();
  });
});
