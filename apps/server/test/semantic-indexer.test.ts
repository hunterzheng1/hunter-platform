import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { KnowledgeIngestEntry } from "@hunter-harness/contracts";

import { buildSemanticIndex } from "../src/semantic/indexer.js";
import { SemanticMemoryStore } from "../src/semantic/memory-store.js";

const fixtureRoot = fileURLToPath(new URL("../../../packages/contracts/test/fixtures/", import.meta.url));

describe("semantic indexer", () => {
  it("indexes knowledge ingest entries and markdown from artifact files", async () => {
    const entry = await readFile(join(fixtureRoot, "knowledge-ingest-entry.json"), "utf8");
    const build = buildSemanticIndex({
      projectId: "prj_sample",
      artifactId: "art_sample01",
      files: {
        ".harness/knowledge/entries/candidate/sample.json": entry,
        ".harness/knowledge/architecture/boundary.md": [
          "---",
          'id: "knowledge.architecture.boundary"',
          'type: "architecture"',
          'scope: "project"',
          'confidence: "verified"',
          'status: "active"',
          'domains: ["platform"]',
          'modules: ["core"]',
          'related_paths: ["packages/core/**"]',
          'source: {"kind":"design","ref":"docs/00-DESIGN.md"}',
          'created_at: "2026-06-20T00:00:00Z"',
          'updated_at: "2026-06-20T00:00:00Z"',
          'last_verified_at: "2026-06-20T00:00:00Z"',
          "expires_at: null",
          "supersedes: []",
          "superseded_by: []",
          "---",
          "",
          "Boundary stays explicit."
        ].join("\n"),
        "CLAUDE.md": "# Project\n",
        ".claude/rules/harness-general.md": "rule body\n"
      }
    });

    expect(build.documents.map((document) => document.kind)).toEqual([
      "rule",
      "knowledge_markdown",
      "knowledge_entry",
      "agent_instruction"
    ]);
    expect(build.documents.find((document) => document.kind === "knowledge_entry")).toMatchObject({
      title: "AI job 复用 LlmClient",
      metadata: { entry_type: "decision", status: "candidate" }
    });
  });

  it("indexes incomplete knowledge markdown as best-effort without throwing", () => {
    const build = buildSemanticIndex({
      projectId: "prj_sample",
      artifactId: "art_sample01",
      files: {
        ".harness/knowledge/architecture/e2e.md": "---\nid: knowledge.architecture.e2e\n---\n\nE2E knowledge.\n"
      }
    });
    expect(build.documents).toHaveLength(1);
    expect(build.documents[0]).toMatchObject({
      kind: "knowledge_markdown",
      title: "e2e.md",
      metadata: { parse_status: "best_effort" }
    });
  });

  it("emits references_path edges for markdown links and wiki-style links", () => {
    const build = buildSemanticIndex({
      projectId: "prj_links",
      artifactId: "art_links01",
      files: {
        ".harness/knowledge/architecture/boundary.md": [
          "---",
          'id: "knowledge.architecture.boundary"',
          'type: "architecture"',
          'scope: "project"',
          'confidence: "verified"',
          'status: "active"',
          'domains: ["platform"]',
          'modules: ["core"]',
          'related_paths: []',
          'source: {"kind":"design","ref":"docs/00-DESIGN.md"}',
          'created_at: "2026-06-20T00:00:00Z"',
          'updated_at: "2026-06-20T00:00:00Z"',
          'last_verified_at: "2026-06-20T00:00:00Z"',
          "expires_at: null",
          "supersedes: []",
          "superseded_by: []",
          "---",
          "",
          "Boundary stays explicit. See [glossary](./glossary.md) and [[e2e]] for more context."
        ].join("\n"),
        ".harness/knowledge/architecture/glossary.md": [
          "---",
          'id: "knowledge.architecture.glossary"',
          'type: "glossary"',
          'scope: "project"',
          'confidence: "verified"',
          'status: "active"',
          'domains: []',
          'modules: []',
          'related_paths: []',
          'source: {"kind":"design","ref":"docs/00-DESIGN.md"}',
          'created_at: "2026-06-20T00:00:00Z"',
          'updated_at: "2026-06-20T00:00:00Z"',
          'last_verified_at: "2026-06-20T00:00:00Z"',
          "expires_at: null",
          "supersedes: []",
          "superseded_by: []",
          "---",
          "",
          "Glossary terms."
        ].join("\n"),
        ".harness/knowledge/architecture/e2e.md": "---\nid: knowledge.architecture.e2e\n---\n\nE2E knowledge.\n"
      }
    });

    const boundary = build.documents.find((document) => document.source_path === ".harness/knowledge/architecture/boundary.md");
    const glossary = build.documents.find((document) => document.source_path === ".harness/knowledge/architecture/glossary.md");
    const e2e = build.documents.find((document) => document.source_path === ".harness/knowledge/architecture/e2e.md");
    expect(boundary).toBeDefined();
    expect(glossary).toBeDefined();
    expect(e2e).toBeDefined();

    const referenceEdges = build.edges.filter((edge) => edge.kind === "references_path");
    expect(referenceEdges).toContainEqual(expect.objectContaining({
      from_document_id: boundary?.document_id,
      to_document_id: glossary?.document_id,
      kind: "references_path"
    }));
    expect(referenceEdges).toContainEqual(expect.objectContaining({
      from_document_id: boundary?.document_id,
      to_document_id: e2e?.document_id,
      kind: "references_path"
    }));
  });

  it("emits tag_cooccurrence edges between knowledge markdown docs sharing a domain", () => {
    const shared = [
      "---",
      'id: "knowledge.architecture.alpha"',
      'type: "architecture"',
      'scope: "project"',
      'confidence: "verified"',
      'status: "active"',
      'domains: ["platform", "billing"]',
      'modules: ["core"]',
      'related_paths: []',
      'source: {"kind":"design","ref":"docs/00-DESIGN.md"}',
      'created_at: "2026-06-20T00:00:00Z"',
      'updated_at: "2026-06-20T00:00:00Z"',
      'last_verified_at: "2026-06-20T00:00:00Z"',
      "expires_at: null",
      "supersedes: []",
      "superseded_by: []",
      "---",
      "",
      "Alpha doc."
    ].join("\n");
    const other = [
      "---",
      'id: "knowledge.architecture.beta"',
      'type: "architecture"',
      'scope: "project"',
      'confidence: "verified"',
      'status: "active"',
      'domains: ["billing"]',
      'modules: ["payments"]',
      'related_paths: []',
      'source: {"kind":"design","ref":"docs/00-DESIGN.md"}',
      'created_at: "2026-06-20T00:00:00Z"',
      'updated_at: "2026-06-20T00:00:00Z"',
      'last_verified_at: "2026-06-20T00:00:00Z"',
      "expires_at: null",
      "supersedes: []",
      "superseded_by: []",
      "---",
      "",
      "Beta doc."
    ].join("\n");
    const unrelated = [
      "---",
      'id: "knowledge.architecture.gamma"',
      'type: "architecture"',
      'scope: "project"',
      'confidence: "verified"',
      'status: "active"',
      'domains: ["mobile"]',
      'modules: []',
      'related_paths: []',
      'source: {"kind":"design","ref":"docs/00-DESIGN.md"}',
      'created_at: "2026-06-20T00:00:00Z"',
      'updated_at: "2026-06-20T00:00:00Z"',
      'last_verified_at: "2026-06-20T00:00:00Z"',
      "expires_at: null",
      "supersedes: []",
      "superseded_by: []",
      "---",
      "",
      "Gamma doc."
    ].join("\n");

    const build = buildSemanticIndex({
      projectId: "prj_tags",
      artifactId: "art_tags01",
      files: {
        ".harness/knowledge/architecture/alpha.md": shared,
        ".harness/knowledge/architecture/beta.md": other,
        ".harness/knowledge/architecture/gamma.md": unrelated
      }
    });

    const alpha = build.documents.find((document) => document.source_path === ".harness/knowledge/architecture/alpha.md");
    const beta = build.documents.find((document) => document.source_path === ".harness/knowledge/architecture/beta.md");
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();

    const tagEdges = build.edges.filter((edge) => edge.kind === "tag_cooccurrence");
    expect(tagEdges).toHaveLength(1);
    const [edge] = tagEdges;
    expect(edge).toBeDefined();
    expect([edge?.from_document_id, edge?.to_document_id].sort()).toEqual(
      [alpha?.document_id, beta?.document_id].sort()
    );
    expect(edge?.metadata.shared_tags).toEqual(["billing"]);
  });

  it("emits related_archive edges when archive summary body references known source paths", () => {
    const build = buildSemanticIndex({
      projectId: "prj_archive",
      artifactId: "art_archive01",
      files: {
        "CLAUDE.md": "# Project\n",
        ".harness/archive/2026-06-30-sample/reports/final/summary-data.json": JSON.stringify({
          changeName: "sample",
          finalStatus: "OK",
          sourceFiles: ["CLAUDE.md", "unknown/path.md"]
        })
      }
    });

    const claude = build.documents.find((document) => document.source_path === "CLAUDE.md");
    const archive = build.documents.find((document) => document.kind === "archive_record");
    expect(claude).toBeDefined();
    expect(archive).toBeDefined();

    const relatedEdges = build.edges.filter((edge) => edge.kind === "related_archive");
    expect(relatedEdges).toContainEqual(expect.objectContaining({
      from_document_id: archive?.document_id,
      to_document_id: claude?.document_id,
      kind: "related_archive"
    }));
  });

  it("keeps archived design documents out of knowledge and indexes codebase maps as architecture", () => {
    const build = buildSemanticIndex({
      projectId: "prj_categories",
      artifactId: "art_categories01",
      files: {
        ".harness/archive/2026-08-12-sample/spec/sample-design.md": "# 示例设计\n\n设计正文。\n",
        ".harness/codebase/map/ARCHITECTURE.md": "# 项目架构\n\n架构正文。\n",
        ".harness/codebase/map-summary.md": "# Codebase Map Summary\n\n项目概览。\n",
        ".harness/codebase/map-manifest.json": JSON.stringify({
          schema_version: 1,
          generated_at: "2026-08-12 10:00:00",
          last_mapped_commit: "abc123",
          warnings: ["索引服务不可用，已降级扫描"]
        })
      }
    });

    expect(build.documents.find((document) => document.source_path.endsWith("sample-design.md"))).toMatchObject({
      kind: "change_document",
      metadata: { archive_role: "spec" }
    });
    expect(build.documents.filter((document) => document.kind === "architecture_document")).toHaveLength(3);
    expect(build.documents.filter((document) => document.kind === "knowledge_markdown")).toHaveLength(0);
  });

  it("projects archive summaries into a readable change overview", () => {
    const build = buildSemanticIndex({
      projectId: "prj_summary",
      artifactId: "art_summary01",
      files: {
        ".harness/archive/2026-08-12-sample/reports/final/summary-data.json": JSON.stringify({
          changeName: "sample",
          businessGoal: "完成项目绑定",
          finalStatus: "WARN",
          finalStatusReasons: ["场景映射证据不完整"],
          summary: { text: "已完成绑定并补齐服务端展示。" },
          timeline: [{ type: "decision", summary: "采用远端持久化作为最终状态。" }],
          reviewSummary: { summary: "评审通过，保留一个非阻断提醒。" },
          maintenanceNotes: ["后续仅需按周期刷新架构地图。"],
          diffStat: { filesChanged: 3, additions: 20, deletions: 4 },
          verification: {
            unitTests: { run: 117, failures: 0, errors: 0 },
            apiTests: { total: 7, passed: 7, failed: 0 }
          },
          releaseEligible: false,
          sourceFiles: ["apps/server/src/app.ts"]
        })
      }
    });

    const summary = build.documents.find((document) => document.kind === "archive_record");
    expect(summary?.body).toContain("## 变更结果");
    expect(summary?.body).toContain("完成项目绑定");
    expect(summary?.body).toContain("已完成绑定并补齐服务端展示");
    expect(summary?.body).toContain("采用远端持久化作为最终状态");
    expect(summary?.body).toContain("评审通过，保留一个非阻断提醒");
    expect(summary?.body).toContain("后续仅需按周期刷新架构地图");
    expect(summary?.body).not.toMatch(/^\s*\{/u);
    expect(summary?.metadata).toMatchObject({
      business_goal: "完成项目绑定",
      files_changed: 3,
      sourceFiles: ["apps/server/src/app.ts"]
    });
  });

  it("emits references_path edges for knowledge entry sourceFiles regardless of file order", async () => {
    const entry = await readFile(join(fixtureRoot, "knowledge-ingest-entry.json"), "utf8");
    const parsedEntry = JSON.parse(entry) as { scope: { sourceFiles: string[] } };
    parsedEntry.scope.sourceFiles = ["CLAUDE.md"];

    const build = buildSemanticIndex({
      projectId: "prj_order",
      artifactId: "art_order01",
      files: {
        ".harness/knowledge/entries/candidate/sample.json": JSON.stringify(parsedEntry),
        "CLAUDE.md": "# Project\n"
      }
    });

    const claude = build.documents.find((document) => document.source_path === "CLAUDE.md");
    const knowledgeEntry = build.documents.find((document) => document.kind === "knowledge_entry");
    expect(claude).toBeDefined();
    expect(knowledgeEntry).toBeDefined();

    const referenceEdges = build.edges.filter((edge) => edge.kind === "references_path");
    expect(referenceEdges).toContainEqual(expect.objectContaining({
      from_document_id: knowledgeEntry?.document_id,
      to_document_id: claude?.document_id,
      kind: "references_path"
    }));
  });

  it("rebuilds project semantic state idempotently in memory", async () => {
    const store = new SemanticMemoryStore();
    const first = buildSemanticIndex({
      projectId: "prj_a",
      artifactId: "art_1",
      files: { "CLAUDE.md": "first\n" }
    });
    const second = buildSemanticIndex({
      projectId: "prj_a",
      artifactId: "art_2",
      files: { "CLAUDE.md": "second\n", "AGENTS.md": "agents\n" }
    });
    await store.rebuild(first);
    await store.rebuild(second);
    expect(await store.listByKinds("prj_a", ["agent_instruction"])).toHaveLength(2);
    expect(await store.latestArtifactId("prj_a")).toBe("art_2");
    expect(await store.search("agents", "prj_a")).toHaveLength(1);
  });

  it("connects knowledge lifecycle, conflicts, and shared source scope", async () => {
    const fixture = JSON.parse(
      await readFile(join(fixtureRoot, "knowledge-ingest-entry.json"), "utf8")
    ) as KnowledgeIngestEntry;
    const first = structuredClone(fixture);
    first.id = "knowledge-old";
    first.title = "Old decision";
    first.scope.sourceFiles = ["packages/core/src/client.ts"];
    first.lifecycle.supersedes = [];
    first.lifecycle.conflictsWith = ["knowledge-new"];

    const second = structuredClone(fixture);
    second.id = "knowledge-new";
    second.title = "New decision";
    second.scope.sourceFiles = ["packages/core/src/client.ts"];
    second.lifecycle.supersedes = ["knowledge-old"];
    second.lifecycle.conflictsWith = ["knowledge-old"];

    const build = buildSemanticIndex({
      projectId: "prj_relations",
      artifactId: "art_relations01",
      files: {
        ".harness/knowledge/entries/active/old.json": JSON.stringify(first),
        ".harness/knowledge/entries/active/new.json": JSON.stringify(second)
      }
    });

    expect(build.edges.map((edge) => edge.kind).sort()).toEqual([
      "conflicts_with",
      "shared_scope",
      "supersedes"
    ]);
  });
});
