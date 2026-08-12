// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowCenter } from "../components/workflow-center";
import { ToastProvider } from "../components/ui/Toast";
import type { HunterApi } from "../lib/api";

afterEach(cleanup);

describe("workflow source import UI", () => {
  it("keeps sync feedback visible after refreshing the selected family detail", async () => {
    const family = {
      family_id: "wff_harness",
      slug: "harness",
      displayName: "Harness",
      description: "Harness workflow family",
      tags: [],
      latest_version: "1.0.0",
      required_profiles: ["general"],
      revision: 1,
      npmReleases: [],
      source: { type: "npm" as const, ref: "@hunter-harness/workflow-harness" },
      created_at: "2026-08-12T00:00:00Z",
      updated_at: "2026-08-12T00:00:00Z"
    };
    const api = {
      listWorkflowFamilies: vi.fn(async () => [family]),
      listWorkflowFamilyVersions: vi.fn(async () => []),
      syncWorkflowFamily: vi.fn(async () => ({ updated: true, version: "1.1.0" }))
    } as unknown as HunterApi;

    render(<ToastProvider><WorkflowCenter api={api} /></ToastProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Harness/i }));
    fireEvent.click(await screen.findByRole("button", { name: /检查更新|check updates/i }));

    expect(await screen.findByText(/已拉取 1\.1\.0|Pulled 1\.1\.0/i)).toBeInTheDocument();
    expect(api.listWorkflowFamilyVersions).toHaveBeenCalledTimes(2);
  });

  it("preflights a source before creating its workflow-family draft", async () => {
    const inspectWorkflowFamilySource = vi.fn(async () => ({
      source: { type: "npm" as const, ref: "@hunter-harness/workflow-harness" },
      remote_version: "0.2.64",
      source_digest: `sha256:${"a".repeat(64)}`,
      manifest_detected: true,
      ready: true,
      suggested: {
        slug: "harness",
        displayName: "Harness",
        description: "Harness workflow family data package",
        tags: ["harness"]
      },
      profiles: [
        { profile: "general", file_count: 2 },
        { profile: "java", file_count: 2 }
      ],
      warnings: []
    }));
    const importWorkflowFamilySource = vi.fn(async () => ({
      family: {
        family_id: "wff_harness",
        slug: "harness",
        displayName: "Harness",
        description: "Harness workflow family data package",
        tags: ["harness"],
        latest_version: null,
        required_profiles: ["general", "java"],
        revision: 1,
        npmReleases: [],
        source: { type: "npm" as const, ref: "@hunter-harness/workflow-harness" },
        created_at: "2026-08-12T00:00:00Z",
        updated_at: "2026-08-12T00:00:00Z"
      },
      draft: {
        family_slug: "harness",
        profiles: [
          { profile: "general", file_count: 2 },
          { profile: "java", file_count: 2 }
        ],
        required_profiles: ["general", "java"],
        draftVersion: "0.2.64",
        checks: null,
        releaseNote: null,
        revision: 1,
        created_at: "2026-08-12T00:00:00Z",
        updated_at: "2026-08-12T00:00:00Z"
      },
      inspection: await inspectWorkflowFamilySource()
    }));
    inspectWorkflowFamilySource.mockClear();
    const api = {
      listWorkflowFamilies: vi.fn(async () => []),
      listWorkflowFamilyVersions: vi.fn(async () => []),
      inspectWorkflowFamilySource,
      importWorkflowFamilySource
    } as unknown as HunterApi;

    render(<ToastProvider><WorkflowCenter api={api} /></ToastProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /导入工作流|import workflow/i }));
    fireEvent.change(screen.getByLabelText(/来源标识|source reference/i), {
      target: { value: "@hunter-harness/workflow-harness" }
    });
    fireEvent.click(screen.getByRole("button", { name: /预检来源|inspect source/i }));

    await waitFor(() => expect(inspectWorkflowFamilySource).toHaveBeenCalledWith({
      type: "npm",
      ref: "@hunter-harness/workflow-harness"
    }));
    expect(await screen.findByText("general")).toBeInTheDocument();
    expect(screen.getByText("java")).toBeInTheDocument();
    expect(screen.getByText("0.2.64")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /创建草稿|create draft/i }));
    await waitFor(() => expect(importWorkflowFamilySource).toHaveBeenCalledWith(expect.objectContaining({
      slug: "harness",
      source_digest: `sha256:${"a".repeat(64)}`,
      source: { type: "npm", ref: "@hunter-harness/workflow-harness" }
    })));
  });

  it("ignores a preflight response after the source reference changes", async () => {
    let resolveInspection!: (value: Awaited<ReturnType<NonNullable<HunterApi["inspectWorkflowFamilySource"]>>>) => void;
    const inspectWorkflowFamilySource = vi.fn(() => new Promise<
      Awaited<ReturnType<NonNullable<HunterApi["inspectWorkflowFamilySource"]>>>
    >((resolve) => { resolveInspection = resolve; }));
    const api = {
      listWorkflowFamilies: vi.fn(async () => []),
      listWorkflowFamilyVersions: vi.fn(async () => []),
      inspectWorkflowFamilySource
    } as unknown as HunterApi;

    render(<ToastProvider><WorkflowCenter api={api} /></ToastProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /导入工作流|import workflow/i }));
    const sourceInput = screen.getByLabelText(/来源标识|source reference/i);
    fireEvent.change(sourceInput, { target: { value: "package-a" } });
    fireEvent.click(screen.getByRole("button", { name: /预检来源|inspect source/i }));
    await waitFor(() => expect(inspectWorkflowFamilySource).toHaveBeenCalledWith({ type: "npm", ref: "package-a" }));

    fireEvent.change(sourceInput, { target: { value: "package-b" } });
    resolveInspection({
      source: { type: "npm", ref: "package-a" },
      remote_version: "1.0.0",
      source_digest: `sha256:${"b".repeat(64)}`,
      manifest_detected: true,
      ready: true,
      suggested: { slug: "package-a", displayName: "Package A", description: "A", tags: [] },
      profiles: [{ profile: "general", file_count: 1 }],
      warnings: []
    });

    await waitFor(() => expect(screen.getByRole("button", { name: /预检来源|inspect source/i })).toBeEnabled());
    expect(screen.queryByText("general")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /创建草稿|create draft/i })).not.toBeInTheDocument();
  });

  it("ignores an older family-detail response after selecting another family", async () => {
    const family = (slug: string, name: string) => ({
      family_id: `wff_${slug}`,
      slug,
      displayName: name,
      description: `${name} workflow`,
      tags: [],
      latest_version: null,
      required_profiles: ["general"],
      revision: 1,
      npmReleases: [],
      created_at: "2026-08-12T00:00:00Z",
      updated_at: "2026-08-12T00:00:00Z"
    });
    let resolveFirst!: (value: Awaited<ReturnType<NonNullable<HunterApi["listWorkflowFamilyVersions"]>>>) => void;
    const listWorkflowFamilyVersions = vi.fn((slug: string) => slug === "first"
      ? new Promise<Awaited<ReturnType<NonNullable<HunterApi["listWorkflowFamilyVersions"]>>>>((resolve) => {
        resolveFirst = resolve;
      })
      : Promise.resolve([]));
    const api = {
      listWorkflowFamilies: vi.fn(async () => [family("first", "First"), family("second", "Second")]),
      listWorkflowFamilyVersions
    } as unknown as HunterApi;

    render(<ToastProvider><WorkflowCenter api={api} /></ToastProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /First/i }));
    fireEvent.click(screen.getByRole("button", { name: /Second/i }));
    await waitFor(() => expect(listWorkflowFamilyVersions).toHaveBeenCalledWith("second"));

    resolveFirst([{
      family_slug: "first",
      version: "9.9.9",
      profiles: [{
        profile: "general",
        file_count: 1,
        bundle_manifest: {
          schema_version: 1 as const,
          profile: "general",
          files: [{ path: "workflow.yaml", sha256: `sha256:${"a".repeat(64)}` }]
        },
        artifact_id: "wfb_first_general"
      }],
      artifacts: [],
      changeNote: "stale first response",
      created_at: "2026-08-12T00:00:00Z"
    }]);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Second" })).toBeInTheDocument());
    expect(screen.queryByText("9.9.9")).not.toBeInTheDocument();
    expect(screen.queryByText("stale first response")).not.toBeInTheDocument();
  });

  it("keeps an imported family selected when an older detail request finishes", async () => {
    const existing = {
      family_id: "wff_existing",
      slug: "existing",
      displayName: "Existing",
      description: "Existing workflow",
      tags: [],
      latest_version: null,
      required_profiles: ["general"],
      revision: 1,
      npmReleases: [],
      created_at: "2026-08-12T00:00:00Z",
      updated_at: "2026-08-12T00:00:00Z"
    };
    const imported = { ...existing, family_id: "wff_imported", slug: "imported", displayName: "Imported" };
    const inspection = {
      source: { type: "npm" as const, ref: "imported-workflow" },
      remote_version: "1.0.0",
      source_digest: `sha256:${"c".repeat(64)}`,
      manifest_detected: true,
      ready: true,
      suggested: { slug: "imported", displayName: "Imported", description: "Imported workflow", tags: [] },
      profiles: [{ profile: "general", file_count: 1 }],
      warnings: []
    };
    const importedDraft = {
      family_slug: "imported",
      profiles: [{ profile: "general", file_count: 1 }],
      required_profiles: ["general"],
      draftVersion: "1.0.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-08-12T00:00:00Z",
      updated_at: "2026-08-12T00:00:00Z"
    };
    let resolveExisting!: (value: Awaited<ReturnType<NonNullable<HunterApi["listWorkflowFamilyVersions"]>>>) => void;
    const api = {
      listWorkflowFamilies: vi.fn(async () => [existing]),
      listWorkflowFamilyVersions: vi.fn(() => new Promise<
        Awaited<ReturnType<NonNullable<HunterApi["listWorkflowFamilyVersions"]>>>
      >((resolve) => { resolveExisting = resolve; })),
      inspectWorkflowFamilySource: vi.fn(async () => inspection),
      importWorkflowFamilySource: vi.fn(async () => ({ family: imported, draft: importedDraft, inspection }))
    } as unknown as HunterApi;

    render(<ToastProvider><WorkflowCenter api={api} /></ToastProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Existing/i }));
    fireEvent.click(screen.getByRole("button", { name: /导入工作流|import workflow/i }));
    fireEvent.change(screen.getByLabelText(/来源标识|source reference/i), { target: { value: "imported-workflow" } });
    fireEvent.click(screen.getByRole("button", { name: /预检来源|inspect source/i }));
    await screen.findByText("general");
    fireEvent.click(screen.getByRole("button", { name: /创建草稿|create draft/i }));
    expect(await screen.findByRole("heading", { name: "Imported" })).toBeInTheDocument();

    resolveExisting([{
      family_slug: "existing",
      version: "9.9.9",
      profiles: [{
        profile: "general",
        file_count: 1,
        bundle_manifest: {
          schema_version: 1 as const,
          profile: "general",
          files: [{ path: "workflow.yaml", sha256: `sha256:${"b".repeat(64)}` }]
        },
        artifact_id: "wfb_existing_general"
      }],
      artifacts: [],
      changeNote: "stale existing response",
      created_at: "2026-08-12T00:00:00Z"
    }]);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Imported" })).toBeInTheDocument());
    expect(screen.queryByText("9.9.9")).not.toBeInTheDocument();
  });

  it("does not let an initial family-list response remove a newly imported family", async () => {
    const oldFamily = {
      family_id: "wff_old",
      slug: "old",
      displayName: "Old",
      description: "Old workflow",
      tags: [],
      latest_version: null,
      required_profiles: ["general"],
      revision: 1,
      npmReleases: [],
      created_at: "2026-08-12T00:00:00Z",
      updated_at: "2026-08-12T00:00:00Z"
    };
    const family = { ...oldFamily, family_id: "wff_imported", slug: "imported", displayName: "Imported" };
    const inspection = {
      source: { type: "npm" as const, ref: "imported-workflow" },
      remote_version: "1.0.0",
      source_digest: `sha256:${"d".repeat(64)}`,
      manifest_detected: true,
      ready: true,
      suggested: { slug: "imported", displayName: "Imported", description: "Imported workflow", tags: [] },
      profiles: [{ profile: "general", file_count: 1 }],
      warnings: []
    };
    const draft = {
      family_slug: "imported",
      profiles: [],
      required_profiles: ["general"],
      draftVersion: "1.0.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-08-12T00:00:00Z",
      updated_at: "2026-08-12T00:00:00Z"
    };
    let resolveList!: (value: typeof oldFamily[]) => void;
    const api = {
      listWorkflowFamilies: vi.fn(() => new Promise<typeof oldFamily[]>((resolve) => { resolveList = resolve; })),
      listWorkflowFamilyVersions: vi.fn(async () => []),
      inspectWorkflowFamilySource: vi.fn(async () => inspection),
      importWorkflowFamilySource: vi.fn(async () => ({ family, draft, inspection }))
    } as unknown as HunterApi;

    render(<ToastProvider><WorkflowCenter api={api} /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: /导入工作流|import workflow/i }));
    fireEvent.change(screen.getByLabelText(/来源标识|source reference/i), { target: { value: "imported-workflow" } });
    fireEvent.click(screen.getByRole("button", { name: /预检来源|inspect source/i }));
    await screen.findByText("general");
    fireEvent.click(screen.getByRole("button", { name: /创建草稿|create draft/i }));
    expect(await screen.findByRole("heading", { name: "Imported" })).toBeInTheDocument();

    resolveList([oldFamily]);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Imported" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Old/i })).not.toBeInTheDocument();
  });

  it("reviews, checks and publishes an imported workflow draft", async () => {
    const family = {
      family_id: "wff_harness",
      slug: "harness",
      displayName: "Harness",
      description: "Harness workflow family data package",
      tags: ["harness"],
      latest_version: null,
      required_profiles: ["general", "java"],
      revision: 1,
      npmReleases: [],
      source: { type: "npm" as const, ref: "@hunter-harness/workflow-harness" },
      created_at: "2026-08-12T00:00:00Z",
      updated_at: "2026-08-12T00:00:00Z"
    };
    const draft = {
      family_slug: "harness",
      profiles: [
        { profile: "general", file_count: 1 },
        { profile: "java", file_count: 1 }
      ],
      required_profiles: ["general", "java"],
      draftVersion: "0.2.64",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-08-12T00:00:00Z",
      updated_at: "2026-08-12T00:00:00Z"
    };
    const checks = {
      items: [
        { id: "PROFILE_OK_general", label: "Profile general", status: "green" as const, message: "verified", filePath: null, fixable: false },
        { id: "PROFILE_OK_java", label: "Profile java", status: "green" as const, message: "verified", filePath: null, fixable: false }
      ],
      summary: { green: 2, yellow: 0, red: 0 },
      checkedAt: "2026-08-12T00:01:00Z"
    };
    const runWorkflowFamilyDraftChecks = vi.fn(async () => checks);
    const publishWorkflowFamilyDraft = vi.fn(async () => ({
      family_slug: "harness",
      version: "0.2.64",
      profiles: [{
        profile: "general",
        file_count: 1,
        bundle_manifest: {
          schema_version: 1 as const,
          profile: "general",
          files: [{ path: "workflow.yaml", sha256: `sha256:${"c".repeat(64)}` }]
        },
        artifact_id: "wfb_harness_general"
      }],
      artifacts: [],
      changeNote: "Initial import",
      created_at: "2026-08-12T00:02:00Z"
    }));
    const api = {
      listWorkflowFamilies: vi.fn(async () => [family]),
      listWorkflowFamilyVersions: vi.fn(async () => []),
      getWorkflowFamilyDraft: vi.fn(async () => draft),
      runWorkflowFamilyDraftChecks,
      publishWorkflowFamilyDraft
    } as unknown as HunterApi;

    render(<ToastProvider><WorkflowCenter api={api} /></ToastProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Harness/i }));

    expect(await screen.findByText(/0\.2\.64/)).toBeInTheDocument();
    expect(screen.getByText("general")).toBeInTheDocument();
    expect(screen.getByText("java")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /运行检查|Run checks/i }));
    await waitFor(() => expect(runWorkflowFamilyDraftChecks).toHaveBeenCalledWith("harness"));
    expect(await screen.findByText(/2.*通过|2.*passed/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/发布版本号|Release version/i), { target: { value: "0.2.64" } });
    fireEvent.change(screen.getByLabelText(/变更说明|Release note/i), { target: { value: "Initial import" } });
    fireEvent.click(screen.getByRole("button", { name: /发布版本|Publish version/i }));
    await waitFor(() => expect(publishWorkflowFamilyDraft).toHaveBeenCalledWith("harness", {
      version: "0.2.64",
      releaseNote: "Initial import"
    }));
  });
});
