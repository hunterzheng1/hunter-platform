import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { canonicalJson } from "@hunter-harness/contracts";
import { sha256Bytes, uuidV7 } from "@hunter-harness/core";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

const token = "workflow-import-owner-token";
const packageName = "@hunter-harness/workflow-harness";
const packageVersion = "0.2.64";
const npmTarballUrl = `https://registry.npmjs.org/@hunter-harness/workflow-harness/-/workflow-harness-${packageVersion}.tgz`;
const githubCommit = "0123456789abcdef0123456789abcdef01234567";

async function tarGz(entries: Record<string, string | Buffer>, archiveRoot = "package"): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), "workflow-import-"));
  for (const [path, content] of Object.entries(entries)) {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of tar.c({ cwd: root, gzip: true }, [archiveRoot])) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function writeTarOctal(header: Buffer, start: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length, "ascii");
}

function paxHeader(body: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write("PaxHeader", 0, 100, "ascii");
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, body.byteLength);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "x".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function tarGzRawFiles(entries: Array<[string, string | Buffer]>): Buffer {
  const parts: Buffer[] = [];
  for (const [path, value] of entries) {
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, "utf8");
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, content.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    const padding = Buffer.alloc((512 - (content.byteLength % 512)) % 512);
    parts.push(header, content, padding);
  }
  parts.push(Buffer.alloc(1_024));
  return gzipSync(Buffer.concat(parts));
}

function tarGzPaxHeaders(count: number): Buffer {
  const body = Buffer.from("20 comment=metadata\n", "utf8");
  const paddedBody = Buffer.concat([body, Buffer.alloc(512 - body.byteLength)]);
  const parts: Buffer[] = [];
  for (let index = 0; index < count; index += 1) parts.push(paxHeader(body), paddedBody);
  parts.push(Buffer.alloc(1_024));
  return gzipSync(Buffer.concat(parts));
}

function tarGzOversizedPax(bodySize: number): Buffer {
  const body = Buffer.alloc(bodySize, 0x61);
  const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512);
  return gzipSync(Buffer.concat([paxHeader(body), body, padding, Buffer.alloc(1_024)]));
}

async function tarGzDirectories(count: number): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), "workflow-import-entries-"));
  const archiveRoot = join(root, "package");
  await mkdir(archiveRoot, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    await mkdir(join(archiveRoot, `entry-${String(index).padStart(4, "0")}`));
  }
  const chunks: Buffer[] = [];
  for await (const chunk of tar.c({ cwd: root, gzip: true }, ["package"])) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

function workflowEntries(
  prefix = "package/",
  extraHarnessFiles: Record<string, string | Buffer> = {}
): Record<string, string | Buffer> {
  const harnessFiles = {
    "harness/bundles/general/AGENTS.md": "# General harness\n",
    "harness/manifests/general/claude-code.json": "{\"schema_version\":1}\n",
    "harness/bundles/java/AGENTS.md": "# Java harness\n",
    "harness/manifests/java/claude-code.json": "{\"schema_version\":1}\n",
    ...extraHarnessFiles
  };
  const contentSha256 = sha256Bytes(canonicalJson(
    Object.entries(harnessFiles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, content]) => ({
        path,
        content: Buffer.isBuffer(content) ? content.toString("utf8") : content
      }))
  ));
  return {
    [`${prefix}hunter-workflow-family.json`]: JSON.stringify({
      schema_version: 1,
      family_slug: "harness",
      display_name: "Harness",
      required_profiles: ["general", "java"],
      bundle_version: "0.2.53",
      content_sha256: contentSha256,
      workflowPackageVersion: packageVersion,
      capabilities: ["sync@2", "build-profile@3"]
    }),
    [`${prefix}package.json`]: JSON.stringify({
      name: packageName,
      version: packageVersion,
      description: "Harness workflow family data package"
    }),
    ...Object.fromEntries(Object.entries(harnessFiles).map(([path, content]) => [`${prefix}${path}`, content]))
  };
}

describe("workflow family source import API", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let repository: MemoryRepository;
  let npmTarball: Buffer;
  let githubTarball: Buffer;
  let resolvedGithubCommit: string;
  let fetchMode: "ok" | "paused" | "network-error" | "timeout" | "body-timeout" | "bad-integrity" | "unsafe-url";
  let fetchStarted: ReturnType<typeof deferred>;
  let releaseFetch: ReturnType<typeof deferred>;

  beforeEach(async () => {
    fetchMode = "ok";
    fetchStarted = deferred();
    releaseFetch = deferred();
    resolvedGithubCommit = githubCommit;
    npmTarball = await tarGz(workflowEntries());
    const githubRoot = "hunterzheng1-Hunter-Harness-0123456789abcdef";
    const githubPackagePrefix = `${githubRoot}/packages/workflow-data-harness/`;
    const generatedGithubTree = workflowEntries(githubPackagePrefix);
    const trackedGithubTree = Object.fromEntries(
      Object.entries(generatedGithubTree).filter(([path]) => !path.startsWith(`${githubPackagePrefix}harness/`))
    );
    githubTarball = await tarGz(
      {
        ...trackedGithubTree,
        // A non-UTF-8 file elsewhere in the monorepo must not poison an exact
        // package subpath import.
        [`${githubRoot}/harness/overlays/java/reference.md`]: Buffer.from([0xe3, 0x80, 0x3f])
      },
      githubRoot
    );
    const externalFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (fetchMode === "paused") {
        fetchStarted.resolve();
        await releaseFetch.promise;
        fetchMode = "ok";
      }
      if (fetchMode === "network-error") throw new Error("socket reset");
      if (fetchMode === "timeout") {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      if (fetchMode === "body-timeout") {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`) {
        return new Response(JSON.stringify({
          name: packageName,
          description: "Harness workflow family data package",
          version: packageVersion
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${packageVersion}`) {
        return new Response(JSON.stringify({
          name: packageName,
          version: packageVersion,
          dist: {
            tarball: fetchMode === "unsafe-url" ? "http://127.0.0.1/internal.tgz" : npmTarballUrl,
            integrity: fetchMode === "bad-integrity"
              ? `sha512:${"A".repeat(88)}`.replace(":", "-")
              : `sha512-${createHash("sha512").update(npmTarball).digest("base64")}`
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === npmTarballUrl) {
        return new Response(npmTarball, { status: 200 });
      }
      if (url === "https://api.github.com/repos/hunterzheng1/Hunter-Harness") {
        return new Response(JSON.stringify({
          default_branch: "main",
          full_name: "hunterzheng1/Hunter-Harness",
          description: "Hunter Harness"
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const commitPrefix = "https://api.github.com/repos/hunterzheng1/Hunter-Harness/commits/";
      if (url.startsWith(commitPrefix)) {
        const ref = decodeURIComponent(url.slice(commitPrefix.length));
        if (ref === "main" || ref === "feature/foo") {
          return new Response(JSON.stringify({ sha: resolvedGithubCommit }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response("not found", { status: 404 });
      }
      if (url === `https://api.github.com/repos/hunterzheng1/Hunter-Harness/tarball/${resolvedGithubCommit}`) {
        return new Response(githubTarball, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      registryPersistence: {
        load: (tx) => (tx ?? repository).loadRegistryState(),
        save: (snapshot, tx) => (tx ?? repository).saveRegistryState(snapshot)
      },
      externalFetch,
      externalFetchTimeoutMs: 250
    });
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  function headers(): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7()
    };
  }

  it("preflights the published Hunter-Harness npm data package", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ready: true,
      remote_version: packageVersion,
      source_digest: sha256Bytes(npmTarball),
      manifest_detected: true,
      suggested: {
        slug: "harness",
        displayName: "Harness",
        description: "Harness workflow family data package"
      }
    });
    expect(response.json().profiles.map((entry: { profile: string }) => entry.profile)).toEqual(["general", "java"]);
  });

  it("imports inspected profiles as a new workflow-family draft", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import",
      headers: headers(),
      payload: {
        schema_version: 1,
        source: { type: "npm", ref: packageName },
        slug: "harness",
        displayName: "Harness",
        description: "Harness workflow family data package",
        tags: ["harness"],
        source_digest: sha256Bytes(npmTarball)
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().family).toMatchObject({
      slug: "harness",
      required_profiles: ["general", "java"],
      source: { type: "npm", ref: packageName }
    });
    expect(response.json().draft.profiles).toEqual([
      { profile: "general", file_count: 2 },
      { profile: "java", file_count: 2 }
    ]);
    expect(response.json().draft.draftVersion).toBe(packageVersion);
    expect(response.body).not.toContain("sourceFiles");
    expect(response.body).not.toContain("{\"schema_version\":1}");

    const draft = await app.inject({
      method: "GET",
      url: "/api/v1/workflow-families/harness/draft",
      headers: headers()
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().required_profiles).toEqual(["general", "java"]);
    expect(draft.json().profiles).toEqual([
      { profile: "general", file_count: 2 },
      { profile: "java", file_count: 2 }
    ]);
    expect(draft.body).not.toContain("sourceFiles");

    const persisted = await repository.loadRegistryState() as {
      workflowFamilyDrafts?: Array<[string, { profiles?: Array<Record<string, unknown>> }]>
    };
    const persistedProfiles = persisted.workflowFamilyDrafts?.[0]?.[1].profiles ?? [];
    expect(persistedProfiles).toHaveLength(2);
    expect(persistedProfiles[0]).toHaveProperty("source_blob_sha256");
    expect(persistedProfiles[0]).not.toHaveProperty("sourceFiles");
  });

  it("replays a successful import without refetching a changed or unavailable source", async () => {
    const request = {
      method: "POST" as const,
      url: "/api/v1/workflow-families/import",
      headers: headers(),
      payload: {
        schema_version: 1,
        source: { type: "npm" as const, ref: packageName },
        slug: "harness",
        displayName: "Harness",
        description: "Harness workflow family data package",
        tags: ["harness"],
        source_digest: sha256Bytes(npmTarball)
      }
    };

    const imported = await app.inject(request);
    expect(imported.statusCode).toBe(201);

    fetchMode = "network-error";
    const replayed = await app.inject(request);
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json()).toEqual(imported.json());
  });

  it("does not hold the registry mutation lease or database transaction while fetching a source", async () => {
    fetchMode = "paused";
    const importing = app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import",
      headers: headers(),
      payload: {
        schema_version: 1,
        source: { type: "npm", ref: packageName },
        slug: "harness",
        displayName: "Harness",
        description: "Harness workflow family data package",
        tags: ["harness"],
        source_digest: sha256Bytes(npmTarball)
      }
    });
    await fetchStarted.promise;

    const registering = app.inject({
      method: "POST",
      url: "/api/v1/agent-tools",
      headers: headers(),
      payload: {
        schema_version: 1,
        slug: "pi-coding-agent",
        displayName: "Pi Coding Agent",
        description: "Agent runtime registered while workflow source I/O is pending.",
        category: "runtime",
        status: "active",
        source: {
          type: "github",
          ref: "https://github.com/earendil-works/pi/tree/main/packages/coding-agent"
        },
        homepage: null,
        packageName: null,
        installCommand: null,
        tags: ["agent-tool"],
        relatedWorkflowFamilies: []
      }
    });
    const registration = await Promise.race([
      registering,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))
    ]);
    releaseFetch.resolve();

    expect(registration).not.toBeNull();
    expect(registration?.statusCode).toBe(201);
    expect((await importing).statusCode).toBe(201);
  });

  it("rolls an imported family back when its audit event cannot commit", async () => {
    const withTransaction = repository.withTransaction.bind(repository);
    vi.spyOn(repository, "withTransaction").mockImplementationOnce((fn) =>
      withTransaction((tx) => fn({
        ...tx,
        appendAudit: async () => {
          throw new Error("audit unavailable");
        }
      }))
    );
    const requestHeaders = headers();
    const request = {
      method: "POST" as const,
      url: "/api/v1/workflow-families/import",
      headers: requestHeaders,
      payload: {
        schema_version: 1,
        source: { type: "npm", ref: packageName },
        slug: "harness",
        displayName: "Harness",
        description: "Harness workflow family data package",
        tags: ["harness"],
        source_digest: sha256Bytes(npmTarball)
      }
    };

    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(500);
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/workflow-families/harness",
      headers: headers()
    });
    expect(missing.statusCode).toBe(404);

    const retried = await app.inject(request);
    expect(retried.statusCode).toBe(201);
  });

  it("rolls publish back with its draft when audit persistence fails", async () => {
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import",
      headers: headers(),
      payload: {
        schema_version: 1,
        source: { type: "npm", ref: packageName },
        slug: "harness",
        displayName: "Harness",
        description: "Harness workflow family data package",
        tags: ["harness"],
        source_digest: sha256Bytes(npmTarball)
      }
    });
    expect(imported.statusCode).toBe(201);
    const checked = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/harness/draft/checks",
      headers: headers(),
      payload: {}
    });
    expect(checked.statusCode).toBe(200);

    const withTransaction = repository.withTransaction.bind(repository);
    vi.spyOn(repository, "withTransaction").mockImplementationOnce((fn) =>
      withTransaction((tx) => fn({
        ...tx,
        appendAudit: async () => {
          throw new Error("audit unavailable");
        }
      }))
    );
    const request = {
      method: "POST" as const,
      url: "/api/v1/workflow-families/harness/publish",
      headers: headers(),
      payload: { version: packageVersion, releaseNote: "Initial import" }
    };
    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(500);

    const familyAfterFailure = await app.inject({
      method: "GET",
      url: "/api/v1/workflow-families/harness",
      headers: headers()
    });
    expect(familyAfterFailure.json().latest_version).toBeNull();
    const draftAfterFailure = await app.inject({
      method: "GET",
      url: "/api/v1/workflow-families/harness/draft",
      headers: headers()
    });
    expect(draftAfterFailure.statusCode).toBe(200);

    const retried = await app.inject(request);
    expect(retried.statusCode).toBe(200);
    expect(retried.json().profiles).toEqual([
      expect.objectContaining({ profile: "general", file_count: 2 }),
      expect.objectContaining({ profile: "java", file_count: 2 })
    ]);
    expect(retried.body).not.toContain("sourceFiles");
  });

  it("does not leave an orphan family when a later profile fails validation", async () => {
    npmTarball = await tarGz(workflowEntries("package/", {
      "harness/bundles/java/private-key.pem": "-----BEGIN PRIVATE KEY-----\nsecret\n"
    }));

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import",
      headers: headers(),
      payload: {
        schema_version: 1,
        source: { type: "npm", ref: packageName },
        slug: "harness",
        displayName: "Harness",
        description: "Harness workflow family data package",
        tags: ["harness"],
        source_digest: sha256Bytes(npmTarball)
      }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("WORKFLOW_SOURCE_NOT_READY");

    const family = await app.inject({
      method: "GET",
      url: "/api/v1/workflow-families/harness",
      headers: headers()
    });
    expect(family.statusCode).toBe(404);
  });

  it("does not let trusted publisher identity bypass an unexpected password finding", async () => {
    npmTarball = await tarGz(workflowEntries("package/", {
      "harness/bundles/general/claude-code/notes.md": "password=unexpected-secret-value\n"
    }));

    const inspected = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().ready).toBe(false);
    expect(inspected.json().warnings).toContainEqual(expect.stringContaining("Sensitive-content scan blocked"));

    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import",
      headers: headers(),
      payload: {
        schema_version: 1,
        source: { type: "npm", ref: packageName },
        slug: "harness",
        displayName: "Harness",
        description: "Harness workflow family data package",
        tags: ["harness"],
        source_digest: sha256Bytes(npmTarball)
      }
    });
    expect(imported.statusCode).toBe(422);
    expect(imported.json().error.code).toBe("WORKFLOW_SOURCE_NOT_READY");
  });

  it("reports case-colliding profile paths during preflight and keeps import parity", async () => {
    npmTarball = tarGzRawFiles(Object.entries(workflowEntries("package/", {
      "harness/bundles/general/Foo.md": "upper-case path\n",
      "harness/bundles/general/foo.md": "lower-case path\n"
    })));
    const sourceDigest = sha256Bytes(npmTarball);
    const inspected = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().ready).toBe(false);
    expect(inspected.json().warnings).toContainEqual(expect.stringContaining("duplicate or case-colliding"));

    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import",
      headers: headers(),
      payload: {
        schema_version: 1,
        source: { type: "npm", ref: packageName },
        slug: "harness",
        displayName: "Harness",
        description: "Harness workflow family data package",
        tags: ["harness"],
        source_digest: sourceDigest
      }
    });
    expect(imported.statusCode).toBe(422);
    expect(imported.json().error.code).toBe("WORKFLOW_SOURCE_NOT_READY");
  });

  it("replaces all synced profiles atomically when a later profile is invalid", async () => {
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import",
      headers: headers(),
      payload: {
        schema_version: 1,
        source: { type: "npm", ref: packageName },
        source_digest: sha256Bytes(npmTarball),
        slug: "harness",
        displayName: "Harness",
        description: "Harness workflow family data package",
        tags: ["harness"]
      }
    });
    expect(imported.statusCode).toBe(201);

    npmTarball = await tarGz(workflowEntries("package/", {
      "harness/bundles/general/AGENTS.md": "# Changed general harness\n",
      "harness/bundles/java/private-key.pem": "-----BEGIN PRIVATE KEY-----\nsecret\n"
    }));
    const sync = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/harness/sync",
      headers: headers(),
      payload: {}
    });
    expect(sync.statusCode).toBe(422);
    expect(sync.json().error.code).toBe("WORKFLOW_SOURCE_NOT_READY");

    const draft = await app.inject({
      method: "GET",
      url: "/api/v1/workflow-families/harness/draft",
      headers: headers()
    });
    const general = draft.json().profiles.find((entry: { profile: string }) => entry.profile === "general");
    expect(general).toEqual({ profile: "general", file_count: 2 });
    expect(draft.json()).toMatchObject({
      revision: imported.json().draft.revision,
      draftVersion: imported.json().draft.draftVersion,
      profiles: imported.json().draft.profiles
    });
  });

  it("keeps an exact GitHub tree subpath while inspecting a monorepo package", async () => {
    const ref = "https://github.com/hunterzheng1/Hunter-Harness/tree/main/packages/workflow-data-harness";
    const sourceDigest = sha256Bytes(canonicalJson({
      github_archive_sha256: sha256Bytes(githubTarball),
      npm_archive_sha256: sha256Bytes(npmTarball),
      npm_package: `${packageName}@${packageVersion}`
    }));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "github", ref } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: { type: "github", ref },
      ready: true,
      remote_version: packageVersion,
      source_digest: sourceDigest,
      suggested: { slug: "harness" }
    });
    expect(response.json().profiles.map((entry: { profile: string }) => entry.profile)).toEqual(["general", "java"]);
    expect(response.json().warnings).toContainEqual(expect.stringContaining("matching published artifact"));

    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import",
      headers: headers(),
      payload: {
        schema_version: 1,
        source: { type: "github", ref },
        source_digest: sourceDigest,
        slug: "harness-github",
        displayName: "Harness GitHub",
        description: "Imported from an exact GitHub monorepo subpath",
        tags: ["harness"]
      }
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().family.source).toEqual({ type: "github", ref });
    expect(imported.json().draft.profiles.map((entry: { profile: string }) => entry.profile)).toEqual(["general", "java"]);
  });

  it("resolves slash-bearing GitHub branches without changing the exact source", async () => {
    const ref = "https://github.com/hunterzheng1/Hunter-Harness/tree/feature/foo/packages/workflow-data-harness";
    const sourceDigest = sha256Bytes(canonicalJson({
      github_archive_sha256: sha256Bytes(githubTarball),
      npm_archive_sha256: sha256Bytes(npmTarball),
      npm_package: `${packageName}@${packageVersion}`
    }));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "github", ref } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: { type: "github", ref },
      ready: true,
      source_digest: sourceDigest
    });
  });

  it("rejects mutable GitHub content that changes without a workflow version bump", async () => {
    const ref = "https://github.com/hunterzheng1/Hunter-Harness/tree/main/packages/workflow-data-harness";
    const inspected = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "github", ref } }
    });
    expect(inspected.statusCode).toBe(200);

    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import",
      headers: headers(),
      payload: {
        schema_version: 1,
        source: { type: "github", ref },
        source_digest: inspected.json().source_digest,
        slug: "harness-github",
        displayName: "Harness GitHub",
        description: "Imported from a mutable GitHub branch",
        tags: ["harness"]
      }
    });
    expect(imported.statusCode).toBe(201);
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/harness-github/draft/checks",
      headers: headers(),
      payload: {}
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/harness-github/publish",
      headers: headers(),
      payload: { version: packageVersion, releaseNote: "Initial GitHub import" }
    })).statusCode).toBe(200);

    resolvedGithubCommit = "fedcba9876543210fedcba9876543210fedcba98";
    const githubRoot = "hunterzheng1-Hunter-Harness-fedcba9876543210";
    const packagePrefix = `${githubRoot}/packages/workflow-data-harness/`;
    const changedTree = workflowEntries(packagePrefix);
    githubTarball = await tarGz({
      ...Object.fromEntries(
        Object.entries(changedTree).filter(([path]) => !path.startsWith(`${packagePrefix}harness/`))
      ),
      [`${githubRoot}/README.md`]: "Mutable branch changed without publishing a new workflow package version.\n"
    }, githubRoot);

    const synced = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/harness-github/sync",
      headers: headers(),
      payload: {}
    });
    expect(synced.statusCode).toBe(409);
    expect(synced.json().error.code).toBe("WORKFLOW_SOURCE_VERSION_CONFLICT");
  });

  it("rejects unsupported GitHub URL suffixes instead of collapsing them to the repository root", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: {
        schema_version: 1,
        source: {
          type: "github",
          ref: "https://github.com/hunterzheng1/Hunter-Harness/blob/main/packages/workflow-data-harness/package.json"
        }
      }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("WORKFLOW_SOURCE_REF_INVALID");
  });

  it("verifies the workflow manifest content hash before marking a source ready", async () => {
    const tampered = workflowEntries();
    tampered["package/harness/bundles/general/AGENTS.md"] = "tampered after manifest generation\n";
    npmTarball = await tarGz(tampered);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("WORKFLOW_SOURCE_CONTENT_INTEGRITY_FAILED");
  });

  it("rejects malformed, unsupported, and partially invalid workflow manifests", async () => {
    const malformed = workflowEntries();
    malformed["package/hunter-workflow-family.json"] = "{";
    npmTarball = await tarGz(malformed);
    const malformedResponse = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });
    expect(malformedResponse.statusCode).toBe(422);
    expect(malformedResponse.json().error.code).toBe("WORKFLOW_SOURCE_MANIFEST_INVALID");

    const unsupported = workflowEntries();
    const unsupportedManifest = JSON.parse(unsupported["package/hunter-workflow-family.json"] ?? "{}") as Record<string, unknown>;
    unsupported["package/hunter-workflow-family.json"] = JSON.stringify({ ...unsupportedManifest, schema_version: 999 });
    npmTarball = await tarGz(unsupported);
    const unsupportedResponse = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });
    expect(unsupportedResponse.statusCode).toBe(422);
    expect(unsupportedResponse.json().error.code).toBe("WORKFLOW_SOURCE_MANIFEST_UNSUPPORTED");

    const invalidProfile = workflowEntries();
    const invalidProfileManifest = JSON.parse(invalidProfile["package/hunter-workflow-family.json"] ?? "{}") as Record<string, unknown>;
    invalidProfile["package/hunter-workflow-family.json"] = JSON.stringify({
      ...invalidProfileManifest,
      required_profiles: ["general", "../java"]
    });
    npmTarball = await tarGz(invalidProfile);
    const invalidProfileResponse = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });
    expect(invalidProfileResponse.statusCode).toBe(422);
    expect(invalidProfileResponse.json().error.code).toBe("WORKFLOW_SOURCE_MANIFEST_INVALID");
  });

  it("rejects import when the source changes after preflight", async () => {
    const inspected = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });
    const sourceDigest = inspected.json().source_digest as string;
    npmTarball = await tarGz(workflowEntries("package/", {
      "harness/bundles/general/changed.md": "changed after inspection\n"
    }));

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import",
      headers: headers(),
      payload: {
        schema_version: 1,
        source: { type: "npm", ref: packageName },
        source_digest: sourceDigest,
        slug: "harness",
        displayName: "Harness",
        description: "Harness workflow family data package",
        tags: ["harness"]
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("WORKFLOW_SOURCE_CHANGED");
  });

  it("maps external network failures and deadlines to stable API errors", async () => {
    fetchMode = "network-error";
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.code).toBe("EXTERNAL_FETCH_FAILED");

    fetchMode = "timeout";
    const timedOut = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });
    expect(timedOut.statusCode).toBe(504);
    expect(timedOut.json().error.code).toBe("EXTERNAL_FETCH_TIMEOUT");

    fetchMode = "body-timeout";
    const bodyTimedOut = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });
    expect(bodyTimedOut.statusCode).toBe(504);
    expect(bodyTimedOut.json().error.code).toBe("EXTERNAL_FETCH_TIMEOUT");
  });

  it("verifies npm integrity and rejects metadata-driven non-registry URLs", async () => {
    fetchMode = "bad-integrity";
    const badIntegrity = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });
    expect(badIntegrity.statusCode).toBe(502);
    expect(badIntegrity.json().error.code).toBe("WORKFLOW_SOURCE_INTEGRITY_FAILED");

    fetchMode = "unsafe-url";
    const unsafeUrl = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });
    expect(unsafeUrl.statusCode).toBe(502);
    expect(unsafeUrl.json().error.code).toBe("WORKFLOW_SOURCE_TARBALL_URL_REJECTED");
  });

  it("rejects an oversized workflow file and aborts further decompression", async () => {
    npmTarball = await tarGz(workflowEntries("package/", {
      "harness/bundles/general/oversized.md": "x".repeat(4 * 1024 * 1024 + 1)
    }));
    const abortSpy = vi.spyOn(tar.Parser.prototype, "abort");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("WORKFLOW_SOURCE_TOO_LARGE");
    expect(abortSpy).toHaveBeenCalledOnce();
  });

  it("counts non-file tar entries toward the archive limit", async () => {
    npmTarball = await tarGzDirectories(2_001);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("WORKFLOW_SOURCE_TOO_LARGE");
  });

  it("counts repeated PAX metadata toward the archive entry limit", async () => {
    npmTarball = tarGzPaxHeaders(2_001);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("WORKFLOW_SOURCE_TOO_LARGE");
  });

  it("counts oversized PAX metadata emitted as an ignored tar entry", async () => {
    npmTarball = tarGzOversizedPax(32 * 1024 * 1024 + 1);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("WORKFLOW_SOURCE_TOO_LARGE");
  });

  it("rejects invalid UTF-8 files instead of staging lossy text", async () => {
    npmTarball = await tarGz({
      ...workflowEntries(),
      "package/harness/bundles/general/binary.dat": Buffer.from([0xc3, 0x28])
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("WORKFLOW_SOURCE_INVALID_UTF8");
  });

  it("accepts manifest-verified canonical replacement only for trusted Markdown", async () => {
    npmTarball = await tarGz(workflowEntries("package/", {
      "harness/bundles/java/claude-code/harness-run/reference.md": Buffer.from([
        0x23, 0x20, 0x52, 0x65, 0x66, 0x0a, 0xe3, 0x80, 0x3f, 0x0a
      ])
    }));

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ready).toBe(true);
    expect(response.json().warnings).toContainEqual(expect.stringContaining("canonical UTF-8 replacement"));
  });

  it("rejects checksum-corrupt archives even if required profiles remain readable", async () => {
    const raw = gunzipSync(npmTarball);
    raw[148] = raw[148] === 0x30 ? 0x31 : 0x30;
    npmTarball = gzipSync(raw);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workflow-families/import/inspect",
      headers: headers(),
      payload: { schema_version: 1, source: { type: "npm", ref: packageName } }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("WORKFLOW_SOURCE_INVALID_ARCHIVE");
  });
});
