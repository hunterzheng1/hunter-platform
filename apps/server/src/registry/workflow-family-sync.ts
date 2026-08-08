import { Readable } from "node:stream";
import { compareSemver } from "@hunter-harness/core";
import type { SourceFile, WorkflowFamily } from "@hunter-harness/contracts";
import * as tar from "tar";

import {
  ExternalFetchError,
  fetchNpmSnapshot,
  normalizeGithubRef,
  normalizeNpmRef,
  type ExternalFetcherDeps
} from "../external/fetchers.js";
import { ServerDomainError } from "../repositories/interfaces.js";
import type { WorkflowFamilyStore } from "./workflow-family-store.js";

export interface WorkflowFamilySyncResult {
  updated: boolean;
  version?: string;
}

async function fetchNpmTarball(
  packageName: string,
  version: string,
  deps: ExternalFetcherDeps
): Promise<Buffer> {
  const name = normalizeNpmRef(packageName);
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const metaUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  const metaResponse = await fetchFn(metaUrl, { headers: { accept: "application/json" } });
  if (metaResponse.status === 404) {
    throw new ExternalFetchError(404, "EXTERNAL_SOURCE_NOT_FOUND", `npm package not found: ${name}`);
  }
  if (!metaResponse.ok) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", `npm registry returned ${metaResponse.status}`);
  }
  const body = await metaResponse.json() as {
    versions?: Record<string, { dist?: { tarball?: string } }>;
  };
  const tarballUrl = body.versions?.[version]?.dist?.tarball;
  if (typeof tarballUrl !== "string" || tarballUrl.length === 0) {
    throw new ExternalFetchError(404, "EXTERNAL_SOURCE_NOT_FOUND", `npm version not found: ${name}@${version}`);
  }
  const tarballResponse = await fetchFn(tarballUrl);
  if (!tarballResponse.ok) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", `npm tarball returned ${tarballResponse.status}`);
  }
  return Buffer.from(await tarballResponse.arrayBuffer());
}

async function extractTarGz(tarball: Buffer): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const parser = new tar.Parser();
  const pending = new Promise<void>((resolve, reject) => {
    parser.on("entry", (entry: tar.ReadEntry) => {
      if (entry.type !== "File") {
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => chunks.push(chunk));
      entry.on("end", () => {
        let path = entry.path.replaceAll("\\", "/");
        if (path.startsWith("package/")) path = path.slice("package/".length);
        // GitHub tarballs use owner-repo-<sha>/ prefix
        const slash = path.indexOf("/");
        if (slash > 0 && !path.startsWith("harness/") && !path.includes("/")) {
          // keep as-is
        } else if (/^[^/]+-[0-9a-f]{7,40}\//i.test(path)) {
          path = path.replace(/^[^/]+\//, "");
        }
        if (path.length === 0 || path.includes("..")) return;
        files.push({ path, content: Buffer.concat(chunks).toString("utf8") });
      });
      entry.on("error", reject);
    });
    parser.on("end", () => resolve());
    parser.on("error", reject);
  });
  Readable.from(tarball).pipe(parser);
  await pending;
  return files;
}

function profileFilesFromPackage(
  allFiles: SourceFile[],
  profile: string
): SourceFile[] {
  const prefixes = [
    `harness/bundles/${profile}/`,
    `${profile}/`
  ];
  const out: SourceFile[] = [];
  for (const file of allFiles) {
    for (const prefix of prefixes) {
      if (file.path.startsWith(prefix)) {
        out.push({ path: file.path.slice(prefix.length), content: file.content });
        break;
      }
    }
  }
  return out;
}

/**
 * Pull the latest source revision for a workflow family and stage it as a draft.
 * Does not auto-publish.
 */
export async function syncWorkflowFamilyFromSource(
  store: WorkflowFamilyStore,
  slug: string,
  actorId: string,
  deps: ExternalFetcherDeps = {}
): Promise<WorkflowFamilySyncResult> {
  const family: WorkflowFamily = store.getFamily(slug);
  const source = family.source;
  if (source === undefined) {
    throw new ServerDomainError(
      422,
      "WORKFLOW_SOURCE_MISSING",
      "workflow family has no source; set source.type/ref before sync"
    );
  }

  let remoteVersion: string | null;
  let files: SourceFile[];

  if (source.type === "npm") {
    const snapshot = await fetchNpmSnapshot(source.ref, deps);
    remoteVersion = snapshot.version;
    if (remoteVersion === null) {
      throw new ServerDomainError(502, "EXTERNAL_FETCH_FAILED", "npm package has no latest version");
    }
    if (family.latest_version !== null && compareSemver(remoteVersion, family.latest_version) <= 0) {
      return { updated: false, version: family.latest_version };
    }
    const tarball = await fetchNpmTarball(source.ref, remoteVersion, deps);
    files = await extractTarGz(tarball);
  } else {
    const { owner, repo } = normalizeGithubRef(source.ref);
    const fetchFn = deps.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "hunter-platform"
    };
    if (deps.githubToken) headers.authorization = `Bearer ${deps.githubToken}`;
    const releaseResponse = await fetchFn(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      { headers }
    );
    if (releaseResponse.status === 404) {
      throw new ServerDomainError(404, "EXTERNAL_SOURCE_NOT_FOUND", "GitHub release not found");
    }
    if (!releaseResponse.ok) {
      throw new ServerDomainError(502, "EXTERNAL_FETCH_FAILED", `GitHub API returned ${releaseResponse.status}`);
    }
    const release = await releaseResponse.json() as { tag_name?: string; tarball_url?: string };
    remoteVersion = (release.tag_name ?? "").replace(/^v/i, "");
    if (remoteVersion.length === 0 || typeof release.tarball_url !== "string") {
      throw new ServerDomainError(502, "EXTERNAL_FETCH_FAILED", "GitHub release missing tag/tarball");
    }
    if (family.latest_version !== null && compareSemver(remoteVersion, family.latest_version) <= 0) {
      return { updated: false, version: family.latest_version };
    }
    const tarballResponse = await fetchFn(release.tarball_url, { headers });
    if (!tarballResponse.ok) {
      throw new ServerDomainError(502, "EXTERNAL_FETCH_FAILED", `GitHub tarball returned ${tarballResponse.status}`);
    }
    files = await extractTarGz(Buffer.from(await tarballResponse.arrayBuffer()));
  }

  let uploaded = 0;
  for (const profile of family.required_profiles) {
    const profileFiles = profileFilesFromPackage(files, profile);
    if (profileFiles.length === 0) continue;
    await store.uploadProfileDraft({
      slug,
      profile,
      files: profileFiles,
      actorId
    });
    uploaded += 1;
  }
  if (uploaded === 0) {
    throw new ServerDomainError(
      422,
      "WORKFLOW_BUNDLE_EMPTY",
      "source package contained no files for required profiles"
    );
  }
  return { updated: true, version: remoteVersion ?? undefined };
}
