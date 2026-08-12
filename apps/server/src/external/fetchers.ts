import type { ExternalSkillReleaseNote, ExternalSkillSnapshot, ExternalSkillSource } from "@hunter-harness/contracts";

export type FetchFn = typeof globalThis.fetch;

export interface ExternalFetcherDeps {
  fetch?: FetchFn;
  githubToken?: string | null;
  now?: () => string;
  timeoutMs?: number;
}

const NPM_REGISTRY = "https://registry.npmjs.org";
const GITHUB_API = "https://api.github.com";
const MAX_EXTERNAL_JSON_BYTES = 4 * 1024 * 1024;
const MAX_NPM_PACKUMENT_BYTES = 24 * 1024 * 1024;
const DEFAULT_EXTERNAL_FETCH_TIMEOUT_MS = 15_000;

export interface ExternalSourceSnapshot {
  source: ExternalSkillSource;
  snapshot: ExternalSkillSnapshot;
  releases: ExternalSkillReleaseNote[];
}

export interface GithubRepositoryProfile {
  owner: string;
  repo: string;
  displayName: string;
  description: string;
  homepage: string;
  topics: string[];
}

export class ExternalFetchError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ExternalFetchError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizedTimeoutMs(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : DEFAULT_EXTERNAL_FETCH_TIMEOUT_MS;
}

interface ExternalDeadline {
  readonly expiresAt: number;
  readonly controller: AbortController;
}

function createExternalDeadline(timeoutMs: number | undefined): ExternalDeadline {
  return {
    expiresAt: Date.now() + normalizedTimeoutMs(timeoutMs),
    controller: new AbortController()
  };
}

async function withExternalDeadline<T>(
  work: Promise<T>,
  deadline: ExternalDeadline,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    const remainingMs = Math.max(0, deadline.expiresAt - Date.now());
    timer = setTimeout(() => {
      reject(new ExternalFetchError(
        504,
        "EXTERNAL_FETCH_TIMEOUT",
        "external source request timed out"
      ));
      deadline.controller.abort();
      onTimeout?.();
    }, remainingMs);
  });
  try {
    const result = await Promise.race([work, timeout]);
    if (Date.now() >= deadline.expiresAt) {
      deadline.controller.abort();
      onTimeout?.();
      throw new ExternalFetchError(504, "EXTERNAL_FETCH_TIMEOUT", "external source request timed out");
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function deadlineFetch(deps: ExternalFetcherDeps, deadline: ExternalDeadline): FetchFn {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  return async (input, init) => {
    const upstreamSignal = init?.signal;
    const abortFromUpstream = () => deadline.controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted === true) abortFromUpstream();
    else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
    try {
      return await withExternalDeadline(
        Promise.resolve(fetchFn(input, { ...init, signal: deadline.controller.signal })),
        deadline
      );
    } finally {
      upstreamSignal?.removeEventListener("abort", abortFromUpstream);
    }
  };
}

/** 规范化 npm 包名（去空白；保留 scope）。 */
export function normalizeNpmRef(ref: string): string {
  const trimmed = ref.trim().replace(/^npm:/i, "");
  if (trimmed.length === 0) {
    throw new ExternalFetchError(422, "VALIDATION_FAILED", "npm package name is required");
  }
  if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(trimmed)) {
    throw new ExternalFetchError(422, "VALIDATION_FAILED", "invalid npm package name");
  }
  return trimmed;
}

/** 从 GitHub URL 或 `owner/repo` 解析为规范化 ref。 */
export function normalizeGithubRef(ref: string): { owner: string; repo: string; ref: string } {
  const trimmed = ref.trim().replace(/\.git$/i, "");
  let owner: string | undefined;
  let repo: string | undefined;

  const https = trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i);
  if (https !== null) {
    owner = https[1];
    repo = https[2];
  } else {
    const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/#?]+)/i);
    if (ssh !== null) {
      owner = ssh[1];
      repo = ssh[2];
    } else {
      const short = trimmed.match(/^([^/\s]+)\/([^/\s#?]+)$/);
      if (short !== null) {
        owner = short[1];
        repo = short[2];
      }
    }
  }

  if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    throw new ExternalFetchError(422, "VALIDATION_FAILED", "invalid GitHub repository reference");
  }
  return { owner, repo, ref: `${owner}/${repo}` };
}

export async function fetchGithubRepositoryProfile(
  repositoryRef: string,
  deps: ExternalFetcherDeps = {}
): Promise<GithubRepositoryProfile> {
  const { owner, repo } = normalizeGithubRef(repositoryRef);
  const deadline = createExternalDeadline(deps.timeoutMs);
  const fetchFn = deadlineFetch(deps, deadline);
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "hunter-harness-agent-catalog"
  };
  const token = deps.githubToken?.trim();
  if (token !== undefined && token !== "") headers.authorization = `Bearer ${token}`;
  const response = await fetchFn(`${GITHUB_API}/repos/${owner}/${repo}`, { headers });
  if (response.status === 404) {
    throw new ExternalFetchError(404, "EXTERNAL_SOURCE_NOT_FOUND", `GitHub repository not found: ${owner}/${repo}`);
  }
  if (!response.ok) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", `GitHub API returned ${response.status}`);
  }
  const body = await readExternalJsonWithDeadline(response, MAX_EXTERNAL_JSON_BYTES, deadline) as Record<string, unknown> | null;
  if (body === null) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", "GitHub API returned invalid JSON");
  }
  return {
    owner,
    repo,
    displayName: typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : repo,
    description: typeof body.description === "string" && body.description.trim() !== ""
      ? body.description.trim()
      : `${owner}/${repo} GitHub repository`,
    homepage: typeof body.homepage === "string" && body.homepage.trim() !== ""
      ? body.homepage.trim()
      : (typeof body.html_url === "string" ? body.html_url : `https://github.com/${owner}/${repo}`),
    topics: Array.isArray(body.topics)
      ? body.topics.filter((item): item is string => typeof item === "string").slice(0, 12)
      : []
  };
}

export function normalizeExternalSource(source: ExternalSkillSource): ExternalSkillSource {
  if (source.type === "npm") {
    return { type: "npm", ref: normalizeNpmRef(source.ref) };
  }
  return { type: "github", ref: normalizeGithubRef(source.ref).ref };
}

function encodeNpmPath(packageName: string): string {
  // npm registry 要求 scope 包路径把 `/` 编码为 `%2F`（`@scope%2Fname`）
  return encodeURIComponent(packageName);
}

function githubRepositoryFromNpm(value: unknown): { owner: string; repo: string } | null {
  const raw = typeof value === "string"
    ? value
    : (value !== null && typeof value === "object" && typeof (value as { url?: unknown }).url === "string"
      ? (value as { url: string }).url
      : "");
  const match = raw.replace(/^git\+/, "").replace(/\.git(?:#.*)?$/i, "").match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  return match?.[1] === undefined || match[2] === undefined ? null : { owner: match[1], repo: match[2] };
}

async function fetchGithubReleaseNotes(
  owner: string,
  repo: string,
  fetchFn: FetchFn,
  headers: Record<string, string>,
  deadline: ExternalDeadline
): Promise<ExternalSkillReleaseNote[]> {
  try {
    const response = await fetchFn(`${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=100`, { headers });
    if (!response.ok) return [];
    const bodies = await readExternalJsonWithDeadline(response, MAX_EXTERNAL_JSON_BYTES, deadline);
    if (!Array.isArray(bodies)) return [];
    return bodies
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" &&
        item.draft !== true && item.prerelease !== true && typeof item.tag_name === "string")
      .map((release) => ({
        version: release.tag_name as string,
        published_at: typeof release.published_at === "string" ? release.published_at : null,
        source_url: typeof release.html_url === "string" ? release.html_url : null,
        title: typeof release.name === "string" && release.name.trim().length > 0 ? release.name.trim().slice(0, 200) : null,
        changes: githubReleaseChanges(typeof release.body === "string" ? release.body : undefined)
      }))
      .reverse();
  } catch {
    // npm 元数据仍然可用时，GitHub 发布说明只是增强信息，失败不应阻断刷新。
    return [];
  }
}

export async function readExternalJson(
  response: Response,
  maxBytes = MAX_EXTERNAL_JSON_BYTES,
  timeoutMs = DEFAULT_EXTERNAL_FETCH_TIMEOUT_MS
): Promise<unknown> {
  return readExternalJsonWithDeadline(
    response,
    maxBytes,
    createExternalDeadline(timeoutMs)
  );
}

async function readExternalJsonWithDeadline(
  response: Response,
  maxBytes: number,
  deadline: ExternalDeadline
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ExternalFetchError(502, "EXTERNAL_RESPONSE_TOO_LARGE", "external source metadata exceeds the size limit");
  }
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await withExternalDeadline(reader.read(), deadline, () => {
        void reader.cancel();
      });
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ExternalFetchError(502, "EXTERNAL_RESPONSE_TOO_LARGE", "external source metadata exceeds the size limit");
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof ExternalFetchError) throw error;
    if (error instanceof SyntaxError) return null;
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", "external source response could not be read");
  } finally {
    reader.releaseLock();
  }
}

async function fetchNpmSource(
  packageName: string,
  deps: ExternalFetcherDeps = {}
): Promise<{ snapshot: ExternalSkillSnapshot; releases: ExternalSkillReleaseNote[] }> {
  const name = normalizeNpmRef(packageName);
  const deadline = createExternalDeadline(deps.timeoutMs);
  const fetchFn = deadlineFetch(deps, deadline);
  const now = deps.now ?? (() => new Date().toISOString());
  // External Skills need the package README, which npm omits from the
  // lightweight /latest manifest. Fetch the full packument with a hard body
  // limit, then combine its top-level README with the latest version metadata.
  const url = `${NPM_REGISTRY}/${encodeNpmPath(name)}`;
  const response = await fetchFn(url, {
    headers: { accept: "application/json" }
  });
  if (response.status === 404) {
    throw new ExternalFetchError(404, "EXTERNAL_SOURCE_NOT_FOUND", `npm package not found: ${name}`);
  }
  if (!response.ok) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", `npm registry returned ${response.status}`);
  }
  const body = (await readExternalJsonWithDeadline(response, MAX_NPM_PACKUMENT_BYTES, deadline)) as Record<string, unknown> | null;
  if (body === null || typeof body !== "object") {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", "npm registry returned invalid JSON");
  }
  const distTags = (body["dist-tags"] ?? {}) as Record<string, unknown>;
  const version = typeof body.version === "string"
    ? body.version
    : (typeof distTags.latest === "string" ? distTags.latest : null);
  const versions = (body.versions ?? {}) as Record<string, unknown>;
  const latest = version === null || typeof versions[version] !== "object" || versions[version] === null
    ? body
    : versions[version] as Record<string, unknown>;
  const description = typeof latest.description === "string"
    ? latest.description
    : (typeof body.description === "string" ? body.description : "");
  const licenseValue = latest.license ?? body.license;
  const license = typeof licenseValue === "string"
    ? licenseValue
    : (typeof (licenseValue as { type?: string } | undefined)?.type === "string"
      ? (licenseValue as { type: string }).type
      : null);
  const homepage = typeof latest.homepage === "string"
    ? latest.homepage
    : (typeof body.homepage === "string" ? body.homepage : null);
  const readme = typeof body.readme === "string" ? body.readme : null;
  const displayName = typeof latest.name === "string"
    ? latest.name
    : (typeof body.name === "string" ? body.name : name);

  const snapshot: ExternalSkillSnapshot = {
    name: displayName,
    description,
    version,
    readme,
    installCommand: `npm install ${name}`,
    license,
    homepage,
    releaseUrl: homepage ?? `https://www.npmjs.com/package/${name}`,
    fetchedAt: now()
  };
  const published = (body.time ?? {}) as Record<string, unknown>;
  const releases = Object.entries(versions).flatMap(([releaseVersion, raw]) => {
    if (raw === null || typeof raw !== "object") return [];
    const metadata = raw as Record<string, unknown>;
    const releaseDescription = typeof metadata.description === "string" && metadata.description.trim().length > 0
      ? `上游未提供该版本的独立发布说明（包简介：${metadata.description.trim().slice(0, 240)}）`
      : "上游未提供该版本的发布说明";
    const publishedAt = typeof published[releaseVersion] === "string" ? published[releaseVersion] : null;
    return [{
      version: releaseVersion,
      published_at: publishedAt,
      source_url: `https://www.npmjs.com/package/${name}/v/${releaseVersion}`,
      title: null,
      changes: [releaseDescription]
    } satisfies ExternalSkillReleaseNote];
  }).sort((left, right) => {
    if (left.published_at !== null && right.published_at !== null) return left.published_at.localeCompare(right.published_at);
    return left.version.localeCompare(right.version, undefined, { numeric: true });
  });
  const repository = githubRepositoryFromNpm(latest.repository ?? body.repository);
  if (repository === null) return { snapshot, releases };
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "hunter-harness-external-skill"
  };
  const token = deps.githubToken?.trim();
  if (token !== undefined && token !== "") headers.authorization = `Bearer ${token}`;
  const githubReleases = await fetchGithubReleaseNotes(repository.owner, repository.repo, fetchFn, headers, deadline);
  if (githubReleases.length === 0) return { snapshot, releases };
  const githubByVersion = new Map(githubReleases.map((release) => [release.version.replace(/^v(?=\d)/i, ""), release]));
  return {
    snapshot,
    releases: releases.map((release) => {
      const github = githubByVersion.get(release.version.replace(/^v(?=\d)/i, ""));
      return github === undefined ? release : { ...github, version: release.version };
    })
  };
}

export async function fetchNpmSnapshot(
  packageName: string,
  deps: ExternalFetcherDeps = {}
): Promise<ExternalSkillSnapshot> {
  return (await fetchNpmSource(packageName, deps)).snapshot;
}

async function fetchGithubReadme(
  owner: string,
  repo: string,
  fetchFn: FetchFn,
  headers: Record<string, string>,
  deadline: ExternalDeadline
): Promise<string | null> {
  const response = await fetchFn(`${GITHUB_API}/repos/${owner}/${repo}/readme`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const body = (await readExternalJsonWithDeadline(response, MAX_EXTERNAL_JSON_BYTES, deadline)) as { content?: string; encoding?: string } | null;
  if (body === null || typeof body.content !== "string") return null;
  if (body.encoding === "base64") {
    try {
      return Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  return body.content;
}

function githubReleaseChanges(body: string | undefined): string[] {
  if (body === undefined || body.trim().length === 0) return ["上游未提供该版本的发布说明"];
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bullets = lines
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((line) => line.slice(0, 300));
  return bullets.length > 0 ? bullets : ["上游未提供该版本的发布说明"];
}

async function fetchGithubSource(
  owner: string,
  repo: string,
  deps: ExternalFetcherDeps = {}
): Promise<{ snapshot: ExternalSkillSnapshot; releases: ExternalSkillReleaseNote[] }> {
  const deadline = createExternalDeadline(deps.timeoutMs);
  const fetchFn = deadlineFetch(deps, deadline);
  const now = deps.now ?? (() => new Date().toISOString());
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "hunter-harness-external-skill"
  };
  const token = deps.githubToken?.trim();
  if (token !== undefined && token !== "") {
    headers.authorization = `Bearer ${token}`;
  }

  const repoResponse = await fetchFn(`${GITHUB_API}/repos/${owner}/${repo}`, { headers });
  if (repoResponse.status === 404) {
    throw new ExternalFetchError(404, "EXTERNAL_SOURCE_NOT_FOUND", `GitHub repository not found: ${owner}/${repo}`);
  }
  if (!repoResponse.ok) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", `GitHub API returned ${repoResponse.status}`);
  }
  const repoBody = (await readExternalJsonWithDeadline(repoResponse, MAX_EXTERNAL_JSON_BYTES, deadline)) as Record<string, unknown> | null;
  if (repoBody === null) {
    throw new ExternalFetchError(502, "EXTERNAL_FETCH_FAILED", "GitHub API returned invalid JSON");
  }

  let version: string | null = null;
  let releaseUrl: string | null = typeof repoBody.html_url === "string" ? repoBody.html_url : `https://github.com/${owner}/${repo}`;
  const releases = await fetchGithubReleaseNotes(owner, repo, fetchFn, headers, deadline);
  const latestRelease = releases.at(-1);
  if (latestRelease !== undefined) {
    version = latestRelease.version;
    if (latestRelease.source_url !== null) releaseUrl = latestRelease.source_url;
  } else if (typeof repoBody.default_branch === "string") {
    version = repoBody.default_branch;
  }

  const licenseObj = repoBody.license as { spdx_id?: string; name?: string } | null | undefined;
  const license = typeof licenseObj?.spdx_id === "string" && licenseObj.spdx_id !== "NOASSERTION"
    ? licenseObj.spdx_id
    : (typeof licenseObj?.name === "string" ? licenseObj.name : null);

  const readme = await fetchGithubReadme(owner, repo, fetchFn, headers, deadline);
  const name = typeof repoBody.full_name === "string" ? repoBody.full_name : `${owner}/${repo}`;
  const description = typeof repoBody.description === "string" ? repoBody.description : "";
  const homepage = typeof repoBody.homepage === "string" && repoBody.homepage.length > 0
    ? repoBody.homepage
    : (typeof repoBody.html_url === "string" ? repoBody.html_url : `https://github.com/${owner}/${repo}`);

  const snapshot: ExternalSkillSnapshot = {
    name,
    description,
    version,
    readme,
    installCommand: `https://github.com/${owner}/${repo}`,
    license,
    homepage,
    releaseUrl,
    fetchedAt: now()
  };
  return { snapshot, releases };
}

export async function fetchGithubSnapshot(
  owner: string,
  repo: string,
  deps: ExternalFetcherDeps = {}
): Promise<ExternalSkillSnapshot> {
  return (await fetchGithubSource(owner, repo, deps)).snapshot;
}

export async function fetchExternalSnapshot(
  source: ExternalSkillSource,
  deps: ExternalFetcherDeps = {}
): Promise<ExternalSourceSnapshot> {
  const normalized = normalizeExternalSource(source);
  if (normalized.type === "npm") {
    const fetched = await fetchNpmSource(normalized.ref, deps);
    return { source: normalized, ...fetched };
  }
  const { owner, repo } = normalizeGithubRef(normalized.ref);
  const fetched = await fetchGithubSource(owner, repo, deps);
  return { source: normalized, ...fetched };
}
