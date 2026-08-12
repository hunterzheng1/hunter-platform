import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";

import type { SourceFile } from "@hunter-harness/contracts";

import type { RegistryPersistence } from "../src/registry/persistence.js";
import { RegistryStore } from "../src/registry/store.js";
import { WorkflowFamilyStore } from "../src/registry/workflow-family-store.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const generalFiles: SourceFile[] = [
  { path: ".harness-build.json", content: '{"profile":"general","version":"1.0.0"}\n' },
  { path: "manifests/claude-code.json", content: '{"schema_version":1}\n' }
];

const javaFiles: SourceFile[] = [
  { path: ".harness-build.json", content: '{"profile":"java","version":"1.0.0"}\n' },
  { path: "manifests/claude-code.json", content: '{"schema_version":1}\n' }
];

function newStore(): WorkflowFamilyStore {
  const store = new WorkflowFamilyStore({
    storage: new MemoryArtifactStorage(),
    families: new Map(),
    drafts: new Map(),
    persist: async () => {},
    compilerVersion: () => "1.0.0"
  });
  store.createFamily({
    slug: "harness",
    displayName: "Harness",
    description: "Default harness workflow family",
    tags: [],
    required_profiles: ["general", "java"]
  });
  return store;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

describe("WorkflowFamilyStore", () => {
  it("uploads per-profile drafts and publishes one family version", async () => {
    const store = newStore();
    await store.uploadProfileDraft({ slug: "harness", profile: "general", files: generalFiles, actorId: "actor" });
    await store.uploadProfileDraft({ slug: "harness", profile: "java", files: javaFiles, actorId: "actor" });
    const checks = await store.runFamilyChecks({ slug: "harness", checkedAt: "2026-07-12T00:00:00Z" });
    expect(checks.summary.red).toBe(0);
    const version = await store.publishFamily("harness", { version: "1.0.0", releaseNote: "init", actorId: "actor" });
    expect(version.version).toBe("1.0.0");
    expect(version.profiles).toHaveLength(2);
    expect(store.getFamily("harness").latest_version).toBe("1.0.0");
  });

  it("flags missing required profile during checks", async () => {
    const store = newStore();
    await store.uploadProfileDraft({ slug: "harness", profile: "general", files: generalFiles, actorId: "actor" });
    const checks = await store.runFamilyChecks({ slug: "harness", checkedAt: "2026-07-12T00:00:00Z" });
    expect(checks.items.some((item) => item.id === "PROFILE_MISSING_java")).toBe(true);
    expect(checks.summary.red).toBeGreaterThan(0);
  });

  it("rejects publish when required profile is missing", async () => {
    const store = newStore();
    await store.uploadProfileDraft({ slug: "harness", profile: "general", files: generalFiles, actorId: "actor" });
    await expect(store.publishFamily("harness", { version: "1.0.0", actorId: "actor" }))
      .rejects.toMatchObject({ code: "WORKFLOW_PROFILE_INCOMPLETE" });
  });

  it("rejects publish until the complete draft has passed server-side checks", async () => {
    const store = newStore();
    await store.uploadProfileDraft({ slug: "harness", profile: "general", files: generalFiles, actorId: "actor" });
    await store.uploadProfileDraft({ slug: "harness", profile: "java", files: javaFiles, actorId: "actor" });
    await expect(store.publishFamily("harness", { version: "1.0.0", actorId: "actor" }))
      .rejects.toMatchObject({ code: "WORKFLOW_CHECKS_REQUIRED" });
  });

  it("scans sensitive content even when the file path is __proto__", async () => {
    const store = newStore();
    await expect(store.uploadProfileDraft({
      slug: "harness",
      profile: "general",
      files: [{ path: "__proto__", content: "-----BEGIN PRIVATE KEY-----\nsecret\n" }],
      actorId: "actor"
    })).rejects.toMatchObject({ code: "SENSITIVE_CONTENT_BLOCKED" });
  });

  it("rejects duplicate and non-canonical profile file paths", async () => {
    const store = newStore();
    await expect(store.uploadProfileDraft({
      slug: "harness",
      profile: "general",
      files: [
        { path: "AGENTS.md", content: "first" },
        { path: "AGENTS.md", content: "second" }
      ],
      actorId: "actor"
    })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });

    await expect(store.uploadProfileDraft({
      slug: "harness",
      profile: "general",
      files: [{ path: "./AGENTS.md", content: "alias" }],
      actorId: "actor"
    })).rejects.toMatchObject({ code: "SKILL_VALIDATION_FAILED" });
  });

  it("stores downloadable profile artifact zip", async () => {
    const storage = new MemoryArtifactStorage();
    const store = new WorkflowFamilyStore({
      storage,
      families: new Map(),
      drafts: new Map(),
      persist: async () => {},
      compilerVersion: () => "1.0.0"
    });
    store.createFamily({
      slug: "harness",
      displayName: "Harness",
      description: "Default harness workflow family",
      tags: [],
      required_profiles: ["general"]
    });
    await store.uploadProfileDraft({ slug: "harness", profile: "general", files: generalFiles, actorId: "actor" });
    await store.runFamilyChecks({ slug: "harness", checkedAt: "2026-07-12T00:00:00Z" });
    const version = await store.publishFamily("harness", { version: "1.0.0", actorId: "actor" });
    const bytes = await store.getProfileArtifactBytes("harness", "general");
    const zip = new AdmZip(bytes);
    expect(zip.getEntry("hunter-workflow-family.json")).not.toBeNull();
    expect(version.artifacts[0]?.profile).toBe("general");
  });

  it("waits for a failing registry mutation before applying workflow checks", async () => {
    const snapshots: unknown[] = [];
    const persistence: RegistryPersistence = {
      load: async () => snapshots.at(-1) ?? null,
      save: async (snapshot) => {
        snapshots.push(structuredClone(snapshot));
      }
    };
    const storage = new MemoryArtifactStorage();
    const registry = new RegistryStore(storage, persistence);
    await registry.initialize();
    await registry.withFeatureMutation(async () => {
      registry.createWorkflowFamily({
        slug: "harness",
        displayName: "Harness",
        description: "Default harness workflow family",
        tags: [],
        required_profiles: ["general", "java"]
      });
      await registry.persist();
    });
    await registry.uploadWorkflowFamilyProfileDraft({
      slug: "harness",
      profile: "general",
      files: generalFiles,
      actorId: "actor"
    });
    await registry.uploadWorkflowFamilyProfileDraft({
      slug: "harness",
      profile: "java",
      files: javaFiles,
      actorId: "actor"
    });

    const entered = deferred();
    const release = deferred();
    const failing = registry.withFeatureMutation(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("transaction failed");
    });
    await entered.promise;
    const checking = registry.runWorkflowFamilyChecks({
      slug: "harness",
      checkedAt: "2026-07-12T00:00:00Z"
    });
    await Promise.resolve();
    release.resolve();

    await expect(failing).rejects.toThrow("transaction failed");
    const checks = await checking;
    expect(checks.summary.red).toBe(0);
    expect(registry.getWorkflowFamilyDraft("harness").checks).not.toBeNull();

    const reloaded = new RegistryStore(storage, persistence);
    await reloaded.initialize();
    expect(reloaded.getWorkflowFamilyDraft("harness").checks).not.toBeNull();
  });

  it("externalizes published profile sources while preserving them across reload", async () => {
    let snapshot: unknown = null;
    const persistence: RegistryPersistence = {
      load: async () => snapshot,
      save: async (next) => { snapshot = structuredClone(next); }
    };
    const storage = new MemoryArtifactStorage();
    const registry = new RegistryStore(storage, persistence);
    await registry.initialize();
    registry.createWorkflowFamily({
      slug: "harness",
      displayName: "Harness",
      description: "Default harness workflow family",
      tags: [],
      required_profiles: ["general"]
    });
    await registry.persist();
    await registry.uploadWorkflowFamilyProfileDraft({
      slug: "harness",
      profile: "general",
      files: generalFiles,
      actorId: "actor"
    });
    await registry.runWorkflowFamilyChecks({
      slug: "harness",
      checkedAt: "2026-07-12T00:00:00Z"
    });
    await registry.publishWorkflowFamily("harness", {
      version: "1.0.0",
      actorId: "actor"
    });

    const persisted = snapshot as {
      workflowFamilies: Array<[string, { versions: Array<{ profiles: Array<Record<string, unknown>> }> }]>
    };
    const persistedProfile = persisted.workflowFamilies[0]?.[1].versions[0]?.profiles[0];
    expect(persistedProfile).toHaveProperty("source_blob_sha256");
    expect(persistedProfile).not.toHaveProperty("sourceFiles");

    const summaries = registry.listWorkflowFamilyVersionSummaries("harness");
    expect(summaries[0]?.profiles[0]).toMatchObject({ profile: "general", file_count: 2 });
    expect(summaries[0]?.profiles[0]).not.toHaveProperty("sourceFiles");

    const reloaded = new RegistryStore(storage, persistence);
    await reloaded.initialize();
    expect(reloaded.listWorkflowFamilyVersions("harness")[0]?.profiles[0]?.sourceFiles)
      .toEqual(generalFiles);
  });
});
