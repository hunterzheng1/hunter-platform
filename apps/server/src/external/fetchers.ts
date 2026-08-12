import type { ExternalSkillSnapshot, ExternalSkillSource } from "@hunter-harness/contracts";

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

export async function fetchNpmSnapshot(
  packageName: string,
  deps: ExternalFetcherDeps = {}
): Promise<ExternalSkillSnapshot> {
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

  return {
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

export async function fetchGithubSnapshot(
  owner: string,
  repo: string,
  deps: ExternalFetcherDeps = {}
): Promise<ExternalSkillSnapshot> {
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
  const releaseResponse = await fetchFn(`${GITHUB_API}/repos/${owner}/${repo}/releases/latest`, { headers });
  if (releaseResponse.ok) {
    const releaseBody = (await readExternalJsonWithDeadline(releaseResponse, MAX_EXTERNAL_JSON_BYTES, deadline)) as Record<string, unknown> | null;
    if (releaseBody !== null) {
      if (typeof releaseBody.tag_name === "string") version = releaseBody.tag_name;
      if (typeof releaseBody.html_url === "string") releaseUrl = releaseBody.html_url;
    }
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

  return {
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
}

export async function fetchExternalSnapshot(
  source: ExternalSkillSource,
  deps: ExternalFetcherDeps = {}
): Promise<{ source: ExternalSkillSource; snapshot: ExternalSkillSnapshot }> {
  const normalized = normalizeExternalSource(source);
  if (normalized.type === "npm") {
    return { source: normalized, snapshot: await fetchNpmSnapshot(normalized.ref, deps) };
  }
  const { owner, repo } = normalizeGithubRef(normalized.ref);
  return { source: normalized, snapshot: await fetchGithubSnapshot(owner, repo, deps) };
}
