import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import AdmZip from "adm-zip";

import {
  workflowBundleManifestSchema,
  workflowFamilyBundleArtifactSchema,
  workflowFamilyDraftStateSchema,
  workflowFamilyDraftSummarySchema,
  workflowFamilySchema,
  workflowFamilyVersionSchema,
  workflowFamilyVersionSummarySchema,
  SKILL_ERROR_CODE,
  type SkillCheckItem,
  type SkillCheckResult,
  type SkillDiffFile,
  type SourceFile,
  type WorkflowBundleManifest,
  type WorkflowFamily,
  type WorkflowFamilyDraftState,
  type WorkflowFamilyDraftSummary,
  type WorkflowFamilyMutation,
  type WorkflowFamilyVersion,
  type WorkflowFamilyVersionSummary
} from "@hunter-harness/contracts";
import {
  bumpPatch,
  compareSemver,
  computeDiff,
  normalizeManagedPath,
  sha256Bytes,
  type SensitiveFinding
} from "@hunter-harness/core";

import { ServerDomainError, type TransactionRepository } from "../repositories/interfaces.js";
import type { ArtifactStorage } from "../storage/interface.js";

export interface WorkflowFamilyState {
  detail: WorkflowFamily;
  versions: WorkflowFamilyVersion[];
}

export interface WorkflowFamilyStoreDeps {
  storage: ArtifactStorage;
  families: Map<string, WorkflowFamilyState>;
  drafts: Map<string, WorkflowFamilyDraftState>;
  persist: (tx?: TransactionRepository) => Promise<void>;
  compilerVersion: () => string;
}

function buildBundleManifest(profile: string, sourceFiles: SourceFile[]): WorkflowBundleManifest {
  const files = [...sourceFiles]
    .filter((file) => file.path !== "bundle-manifest.json")
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({
      path: file.path,
      sha256: sha256Bytes(Buffer.from(file.content, "utf8"))
    }));
  return workflowBundleManifestSchema.parse({
    schema_version: 1,
    profile,
    files
  });
}

export function summarizeWorkflowFamilyDraft(
  draft: WorkflowFamilyDraftState
): WorkflowFamilyDraftSummary {
  return workflowFamilyDraftSummarySchema.parse({
    family_slug: draft.family_slug,
    profiles: draft.profiles.map((entry) => ({
      profile: entry.profile,
      file_count: entry.sourceFiles.length
    })),
    required_profiles: draft.required_profiles,
    draftVersion: draft.draftVersion,
    checks: draft.checks,
    releaseNote: draft.releaseNote,
    revision: draft.revision,
    created_at: draft.created_at,
    updated_at: draft.updated_at
  });
}

export function summarizeWorkflowFamilyVersion(
  version: WorkflowFamilyVersion
): WorkflowFamilyVersionSummary {
  return workflowFamilyVersionSummarySchema.parse({
    family_slug: version.family_slug,
    version: version.version,
    profiles: version.profiles.map((entry) => ({
      profile: entry.profile,
      bundle_manifest: entry.bundle_manifest,
      artifact_id: entry.artifact_id,
      file_count: entry.sourceFiles.length
    })),
    artifacts: version.artifacts,
    changeNote: version.changeNote,
    created_at: version.created_at
  });
}

function verifyBundleManifest(manifest: WorkflowBundleManifest, sourceFiles: SourceFile[]): void {
  const fileMap = new Map(sourceFiles.map((file) => [file.path, file.content]));
  for (const entry of manifest.files) {
    const content = fileMap.get(entry.path);
    if (content === undefined) {
      throw new ServerDomainError(422, "WORKFLOW_BUNDLE_INCOMPLETE", "bundle manifest references a missing file", {
        path: entry.path
      });
    }
    const hash = sha256Bytes(Buffer.from(content, "utf8"));
    if (hash !== entry.sha256) {
      throw new ServerDomainError(422, "WORKFLOW_BUNDLE_HASH_MISMATCH", "bundle file hash mismatch", {
        path: entry.path
      });
    }
  }
}

export function validateAndIndexSourceFiles(sourceFiles: SourceFile[]): Record<string, string> {
  const files = Object.create(null) as Record<string, string>;
  const seen = new Map<string, string>();
  for (const file of sourceFiles) {
    let normalized: string;
    try {
      normalized = normalizeManagedPath(file.path);
    } catch (error) {
      throw new ServerDomainError(
        422,
        SKILL_ERROR_CODE.VALIDATION_FAILED,
        `unsafe file path: ${file.path}`,
        { reason: error instanceof Error ? error.message : "invalid path" }
      );
    }
    if (normalized !== file.path) {
      throw new ServerDomainError(
        422,
        SKILL_ERROR_CODE.VALIDATION_FAILED,
        `file path must be canonical: ${file.path}`,
        { canonical_path: normalized }
      );
    }
    const folded = normalized.toLocaleLowerCase("en-US");
    const existing = seen.get(folded);
    if (existing !== undefined) {
      throw new ServerDomainError(
        422,
        SKILL_ERROR_CODE.VALIDATION_FAILED,
        `duplicate or case-colliding file path: ${file.path}`,
        { existing_path: existing }
      );
    }
    seen.set(folded, normalized);
    files[normalized] = file.content;
  }
  return files;
}

export function trustedWorkflowFindingAllowed(finding: SensitiveFinding): boolean {
  const agentRoot = "(?:(?:general|java)/)?(?:claude-code|codebuddy|codex|cursor)";
  if (finding.rule_id === "HH_WINDOWS_ABSOLUTE_PATH") {
    return new RegExp(
      `^${agentRoot}/(?:contracts/fixtures/managed-execution\\.json|harness-test/(?:checklist|reference)\\.md|protocols/powershell-protocol\\.md)$`
    ).test(finding.path);
  }
  if (finding.rule_id === "HH_PASSWORD_VALUE") {
    return new RegExp(
      `^${agentRoot}/(?:harness-test/scripts/runtime-helpers\\.mjs|protocols/sensitive-info-protocol\\.md)$`
    ).test(finding.path);
  }
  if (finding.rule_id === "HH_AUTHORIZATION_BEARER" || finding.rule_id === "HH_DATABASE_URL") {
    return new RegExp(`^${agentRoot}/protocols/sensitive-info-protocol\\.md$`).test(finding.path);
  }
  return false;
}

function validatedDraftProfile(
  profile: string,
  sourceFiles: SourceFile[],
  allowTrustedSourceFindings = false
): WorkflowFamilyDraftState["profiles"][number] {
  if (sourceFiles.length === 0) {
    throw new ServerDomainError(422, "WORKFLOW_BUNDLE_EMPTY", "profile bundle must contain at least one file", {
      profile
    });
  }
  validateAndIndexSourceFiles(sourceFiles);
  void allowTrustedSourceFindings;
  return {
    profile,
    sourceFiles,
    bundle_manifest: buildBundleManifest(profile, sourceFiles)
  };
}

export class WorkflowFamilyStore {
  constructor(private readonly deps: WorkflowFamilyStoreDeps) {}

  createFamily(input: WorkflowFamilyMutation): WorkflowFamily {
    if (this.deps.families.has(input.slug)) {
      throw new ServerDomainError(409, "WORKFLOW_FAMILY_EXISTS", "workflow family already exists", { slug: input.slug });
    }
    const detail = this.buildFamily(input, new Date().toISOString());
    this.deps.families.set(input.slug, { detail, versions: [] });
    return structuredClone(detail);
  }

  async importFamilyDraft(input: {
    family: WorkflowFamilyMutation;
    profiles: Array<{ profile: string; files: SourceFile[] }>;
    draftVersion?: string;
    sourceDigest?: string;
    allowTrustedSourceFindings?: boolean;
    tx?: TransactionRepository;
  }): Promise<{ family: WorkflowFamily; draft: WorkflowFamilyDraftState }> {
    if (this.deps.families.has(input.family.slug)) {
      throw new ServerDomainError(409, "WORKFLOW_FAMILY_EXISTS", "workflow family already exists", {
        slug: input.family.slug
      });
    }
    const profilesByName = new Map<string, SourceFile[]>();
    for (const entry of input.profiles) {
      if (profilesByName.has(entry.profile)) {
        throw new ServerDomainError(422, "WORKFLOW_PROFILE_DUPLICATE", "workflow source contains a duplicate profile", {
          profile: entry.profile
        });
      }
      profilesByName.set(entry.profile, entry.files);
    }
    const expected = new Set(input.family.required_profiles);
    const unexpected = [...profilesByName.keys()].find((profile) => !expected.has(profile));
    if (unexpected !== undefined) {
      throw new ServerDomainError(422, "WORKFLOW_PROFILE_INVALID", "workflow source contains an unexpected profile", {
        profile: unexpected
      });
    }
    const missing = input.family.required_profiles.find((profile) => !profilesByName.has(profile));
    if (missing !== undefined) {
      throw new ServerDomainError(422, "WORKFLOW_PROFILE_MISSING", "workflow source is missing a required profile", {
        profile: missing
      });
    }

    // Validate every profile before mutating either map so a later failure cannot
    // leave an orphan family or partially staged draft behind.
    const profiles = input.family.required_profiles.map((profile) =>
      validatedDraftProfile(
        profile,
        profilesByName.get(profile) ?? [],
        input.allowTrustedSourceFindings ?? false
      )
    );
    const now = new Date().toISOString();
    const family = this.buildFamily(input.family, now);
    const draft = workflowFamilyDraftStateSchema.parse({
      family_slug: family.slug,
      ...(input.sourceDigest === undefined ? {} : { source_digest: input.sourceDigest }),
      profiles,
      required_profiles: family.required_profiles,
      draftVersion: input.draftVersion ?? "0.1.0",
      checks: null,
      releaseNote: null,
      revision: 1,
      created_at: now,
      updated_at: now
    });

    this.deps.families.set(family.slug, { detail: family, versions: [] });
    this.deps.drafts.set(family.slug, draft);
    try {
      await this.deps.persist(input.tx);
    } catch (error) {
      this.deps.drafts.delete(family.slug);
      this.deps.families.delete(family.slug);
      throw error;
    }
    return { family: structuredClone(family), draft: structuredClone(draft) };
  }

  async replaceFamilyDraftProfiles(input: {
    slug: string;
    profiles: Array<{ profile: string; files: SourceFile[] }>;
    draftVersion?: string;
    sourceDigest?: string;
    allowTrustedSourceFindings?: boolean;
    tx?: TransactionRepository;
  }): Promise<WorkflowFamilyDraftState> {
    const family = this.ensureFamily(input.slug);
    const profilesByName = new Map<string, SourceFile[]>();
    for (const entry of input.profiles) {
      if (profilesByName.has(entry.profile)) {
        throw new ServerDomainError(422, "WORKFLOW_PROFILE_DUPLICATE", "workflow source contains a duplicate profile", {
          profile: entry.profile
        });
      }
      profilesByName.set(entry.profile, entry.files);
    }
    const expected = new Set(family.detail.required_profiles);
    const unexpected = [...profilesByName.keys()].find((profile) => !expected.has(profile));
    if (unexpected !== undefined) {
      throw new ServerDomainError(422, "WORKFLOW_PROFILE_INVALID", "workflow source contains an unexpected profile", {
        profile: unexpected
      });
    }
    const missing = family.detail.required_profiles.find((profile) => !profilesByName.has(profile));
    if (missing !== undefined) {
      throw new ServerDomainError(422, "WORKFLOW_PROFILE_MISSING", "workflow source is missing a required profile", {
        profile: missing
      });
    }

    const profiles = family.detail.required_profiles.map((profile) =>
      validatedDraftProfile(
        profile,
        profilesByName.get(profile) ?? [],
        input.allowTrustedSourceFindings ?? false
      )
    );
    const existingDraft = this.deps.drafts.get(input.slug);
    const now = new Date().toISOString();
    const draft = workflowFamilyDraftStateSchema.parse({
      family_slug: input.slug,
      ...(input.sourceDigest === undefined ? {} : { source_digest: input.sourceDigest }),
      profiles,
      required_profiles: family.detail.required_profiles,
      draftVersion: input.draftVersion
        ?? existingDraft?.draftVersion
        ?? (family.detail.latest_version === null ? "0.1.0" : bumpPatch(family.detail.latest_version)),
      checks: null,
      releaseNote: existingDraft?.releaseNote ?? null,
      revision: existingDraft === undefined ? 1 : existingDraft.revision + 1,
      created_at: existingDraft?.created_at ?? now,
      updated_at: now
    });
    this.deps.drafts.set(input.slug, draft);
    try {
      await this.deps.persist(input.tx);
    } catch (error) {
      if (existingDraft === undefined) this.deps.drafts.delete(input.slug);
      else this.deps.drafts.set(input.slug, existingDraft);
      throw error;
    }
    return structuredClone(draft);
  }

  listFamilies(): WorkflowFamily[] {
    return [...this.deps.families.values()].map((state) => structuredClone(state.detail));
  }

  getFamily(slug: string): WorkflowFamily {
    const state = this.deps.families.get(slug);
    if (state === undefined) {
      throw new ServerDomainError(404, "WORKFLOW_FAMILY_NOT_FOUND", "workflow family not found", { slug });
    }
    return structuredClone(state.detail);
  }

  ensureFamily(slug: string): WorkflowFamilyState {
    const state = this.deps.families.get(slug);
    if (state === undefined) {
      throw new ServerDomainError(404, "WORKFLOW_FAMILY_NOT_FOUND", "workflow family not found", { slug });
    }
    return state;
  }

  async uploadProfileDraft(input: {
    slug: string;
    profile: string;
    files: SourceFile[];
    actorId: string;
    draftVersion?: string;
  }): Promise<WorkflowFamilyDraftState> {
    const family = this.ensureFamily(input.slug);
    if (!family.detail.required_profiles.includes(input.profile)) {
      throw new ServerDomainError(422, "WORKFLOW_PROFILE_INVALID", "profile is not required for this family", {
        slug: input.slug,
        profile: input.profile
      });
    }
    const profileDraft = validatedDraftProfile(input.profile, input.files);
    const latest = family.detail.latest_version;
    const existingDraft = this.deps.drafts.get(input.slug);
    const draftVersion = input.draftVersion
      ?? existingDraft?.draftVersion
      ?? (latest === null ? "0.1.0" : bumpPatch(latest));
    const now = new Date().toISOString();
    const otherProfiles = (existingDraft?.profiles ?? []).filter((entry) => entry.profile !== input.profile);
    const draft = workflowFamilyDraftStateSchema.parse({
      family_slug: input.slug,
      profiles: [...otherProfiles, profileDraft],
      required_profiles: family.detail.required_profiles,
      draftVersion,
      checks: null,
      releaseNote: existingDraft?.releaseNote ?? null,
      revision: existingDraft === undefined ? 1 : existingDraft.revision + 1,
      created_at: existingDraft?.created_at ?? now,
      updated_at: now
    });
    this.deps.drafts.set(input.slug, draft);
    await this.deps.persist();
    return structuredClone(draft);
  }

  getFamilyDraft(slug: string): WorkflowFamilyDraftState {
    const draft = this.deps.drafts.get(slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow family draft not found", { slug });
    }
    return structuredClone(draft);
  }

  getFamilyDraftSummary(slug: string): WorkflowFamilyDraftSummary {
    return summarizeWorkflowFamilyDraft(this.getFamilyDraft(slug));
  }

  async discardFamilyDraft(slug: string, revision: number): Promise<void> {
    const draft = this.deps.drafts.get(slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow family draft not found", { slug });
    }
    if (draft.revision !== revision) {
      throw new ServerDomainError(409, SKILL_ERROR_CODE.REVISION_CONFLICT, "draft revision is stale", {
        slug, expected: draft.revision, provided: revision
      });
    }
    this.deps.drafts.delete(slug);
    await this.deps.persist();
  }

  async runFamilyChecks(input: { slug: string; checkedAt: string }): Promise<SkillCheckResult> {
    const draft = this.deps.drafts.get(input.slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow family draft not found", { slug: input.slug });
    }
    const items: SkillCheckItem[] = [];
    for (const profile of draft.required_profiles) {
      const entry = draft.profiles.find((value) => value.profile === profile);
      if (entry === undefined) {
        items.push({
          id: "PROFILE_MISSING_" + profile,
          label: "Profile " + profile,
          status: "red",
          message: "required profile bundle is missing",
          filePath: null,
          fixable: false
        });
        continue;
      }
      try {
        verifyBundleManifest(entry.bundle_manifest, entry.sourceFiles);
        items.push({
          id: "PROFILE_OK_" + profile,
          label: "Profile " + profile,
          status: "green",
          message: "bundle manifest verified (" + entry.bundle_manifest.files.length + " files)",
          filePath: null,
          fixable: false
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "bundle verification failed";
        items.push({
          id: "PROFILE_BAD_" + profile,
          label: "Profile " + profile,
          status: "red",
          message,
          filePath: null,
          fixable: false
        });
      }
    }
    const summary = {
      green: items.filter((item) => item.status === "green").length,
      yellow: items.filter((item) => item.status === "yellow").length,
      red: items.filter((item) => item.status === "red").length
    };
    const result: SkillCheckResult = { items, summary, checkedAt: input.checkedAt };
    const updated: WorkflowFamilyDraftState = { ...draft, checks: result, updated_at: input.checkedAt };
    this.deps.drafts.set(input.slug, updated);
    await this.deps.persist();
    return structuredClone(result);
  }

  diffFamilyDraft(slug: string, profile?: string): SkillDiffFile[] {
    const draft = this.deps.drafts.get(slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow family draft not found", { slug });
    }
    const family = this.ensureFamily(slug);
    const latest = family.detail.latest_version;
    const targetProfile = profile ?? draft.profiles[0]?.profile;
    if (targetProfile === undefined) {
      return [];
    }
    const draftFiles = draft.profiles.find((entry) => entry.profile === targetProfile)?.sourceFiles ?? [];
    const published = family.versions.find((version) => version.version === latest);
    const publishedFiles = published?.profiles.find((entry) => entry.profile === targetProfile)?.sourceFiles ?? [];
    return computeDiff(publishedFiles, draftFiles);
  }

  async publishFamily(slug: string, input: {
    version: string;
    releaseNote?: string | null;
    actorId: string;
    tx?: TransactionRepository;
  }): Promise<WorkflowFamilyVersion> {
    const draft = this.deps.drafts.get(slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow family draft not found", { slug });
    }
    const familyState = this.ensureFamily(slug);
    const latest = familyState.detail.latest_version;
    if (latest !== null && compareSemver(input.version, latest) <= 0) {
      throw new ServerDomainError(409, "SKILL_VERSION_NOT_FORWARD", "workflow family version must be greater than the latest published version", {
        latest_version: latest,
        proposed_version: input.version
      });
    }
    for (const profile of draft.required_profiles) {
      if (!draft.profiles.some((entry) => entry.profile === profile)) {
        throw new ServerDomainError(422, "WORKFLOW_PROFILE_INCOMPLETE", "required profile bundle is missing before publish", {
          slug,
          profile
        });
      }
    }
    for (const entry of draft.profiles) {
      verifyBundleManifest(entry.bundle_manifest, entry.sourceFiles);
    }
    if (draft.checks === null) {
      throw new ServerDomainError(
        422,
        "WORKFLOW_CHECKS_REQUIRED",
        "workflow family draft checks must run before publish",
        { slug }
      );
    }
    if (draft.checks.summary.red > 0) {
      throw new ServerDomainError(
        422,
        "WORKFLOW_CHECKS_BLOCKED",
        "workflow family draft has blocking check failures",
        { slug, red: draft.checks.summary.red }
      );
    }
    const createdAt = new Date().toISOString();
    const artifacts = [];
    const versionProfiles = [];
    for (const entry of draft.profiles) {
      const bytes = this.buildProfileArtifact(slug, entry.profile, input.version, entry.sourceFiles, entry.bundle_manifest);
      const hash = sha256Bytes(bytes);
      await this.deps.storage.putBlob(hash, bytes);
      const artifact = workflowFamilyBundleArtifactSchema.parse({
        artifact_id: this.id("wfb_"),
        family_slug: slug,
        profile: entry.profile,
        version: input.version,
        content_sha256: hash,
        size_bytes: bytes.byteLength,
        bundle_manifest: entry.bundle_manifest,
        created_at: createdAt
      });
      artifacts.push(artifact);
      versionProfiles.push({
        profile: entry.profile,
        bundle_manifest: entry.bundle_manifest,
        artifact_id: artifact.artifact_id,
        sourceFiles: entry.sourceFiles
      });
    }
    const version = workflowFamilyVersionSchema.parse({
      family_slug: slug,
      version: input.version,
      ...(draft.source_digest === undefined ? {} : { source_digest: draft.source_digest }),
      profiles: versionProfiles,
      artifacts,
      changeNote: input.releaseNote ?? null,
      created_at: createdAt
    });
    familyState.versions.push(version);
    familyState.detail = workflowFamilySchema.parse({
      ...familyState.detail,
      latest_version: input.version,
      revision: familyState.detail.revision + 1,
      updated_at: createdAt
    });
    this.deps.drafts.delete(slug);
    await this.deps.persist(input.tx);
    return structuredClone(version);
  }

  listFamilyVersions(slug: string): WorkflowFamilyVersion[] {
    const state = this.ensureFamily(slug);
    return structuredClone(state.versions).sort((a, b) => compareSemver(b.version, a.version));
  }

  latestPublishedSourceDigest(slug: string): string | null {
    const state = this.ensureFamily(slug);
    const latest = state.detail.latest_version;
    if (latest === null) return null;
    return state.versions.find((version) => version.version === latest)?.source_digest ?? null;
  }

  listFamilyVersionSummaries(slug: string): WorkflowFamilyVersionSummary[] {
    return this.listFamilyVersions(slug).map(summarizeWorkflowFamilyVersion);
  }

  async getProfileArtifactBytes(slug: string, profile: string, version?: string): Promise<Uint8Array> {
    const artifact = this.latestProfileArtifact(slug, profile, version);
    const bytes = await this.deps.storage.getBlob(artifact.content_sha256);
    if (bytes === null) {
      throw new ServerDomainError(404, "WORKFLOW_FAMILY_ARTIFACT_NOT_FOUND", "published profile artifact blob not found", {
        slug,
        profile,
        version: version ?? this.ensureFamily(slug).detail.latest_version
      });
    }
    return bytes;
  }

  latestProfileArtifact(slug: string, profile: string, version?: string) {
    const state = this.ensureFamily(slug);
    const targetVersion = version ?? state.detail.latest_version;
    if (targetVersion === null) {
      throw new ServerDomainError(404, "WORKFLOW_FAMILY_ARTIFACT_NOT_FOUND", "published family version not found", { slug });
    }
    const record = state.versions.find((entry) => entry.version === targetVersion);
    const artifact = record?.artifacts.find((entry) => entry.profile === profile);
    if (artifact === undefined) {
      throw new ServerDomainError(404, "WORKFLOW_FAMILY_ARTIFACT_NOT_FOUND", "published profile artifact not found", {
        slug,
        profile,
        version: targetVersion
      });
    }
    return artifact;
  }

  private buildProfileArtifact(
    slug: string,
    profile: string,
    version: string,
    sourceFiles: SourceFile[],
    bundleManifest: WorkflowBundleManifest
  ): Uint8Array {
    const zip = new AdmZip();
    for (const file of sourceFiles) {
      zip.addFile(file.path, Buffer.from(file.content, "utf8"));
    }
    zip.addFile("bundle-manifest.json", Buffer.from(JSON.stringify(bundleManifest, null, 2) + "\n", "utf8"));
    zip.addFile("hunter-workflow-family.json", Buffer.from(JSON.stringify({
      schema_version: 1,
      family_slug: slug,
      profile,
      version,
      compiler_version: this.deps.compilerVersion()
    }, null, 2) + "\n", "utf8"));
    return zip.toBuffer();
  }

  private buildFamily(input: WorkflowFamilyMutation, now: string): WorkflowFamily {
    return workflowFamilySchema.parse({
      family_id: this.id("wff_"),
      slug: input.slug,
      displayName: input.displayName,
      description: input.description,
      tags: input.tags ?? [],
      latest_version: null,
      required_profiles: input.required_profiles,
      revision: 1,
      npmReleases: [],
      ...(input.source === undefined ? {} : { source: input.source }),
      created_at: now,
      updated_at: now
    });
  }

  private id(prefix: string): string {
    return prefix + randomUUID().replaceAll("-", "");
  }
}
