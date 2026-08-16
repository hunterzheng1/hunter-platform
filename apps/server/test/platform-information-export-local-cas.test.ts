import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import {
  PLATFORM_INFORMATION_EXPORT_LIMITS,
  canonicalJson,
  type PlatformInformationPage,
  type PlatformInformationQuery,
} from "@hunter-harness/contracts";

import {
  createLocalPlatformInformationExportArtifactPort as createLocalPlatformInformationExportArtifactPortRaw,
  killLocalPlatformInformationExportAuthorityForTest,
  createMemoryPlatformInformationExportPageSource,
  createNodePlatformInformationExportHashPort,
  createPlatformInformationExportModule,
} from "../src/platform-information-export/index.js";

const roots: string[] = [];
const ports: Array<Awaited<ReturnType<typeof createLocalPlatformInformationExportArtifactPortRaw>>> = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(ports.splice(0).map((port) => port.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createLocalPlatformInformationExportArtifactPort(
  options: Parameters<typeof createLocalPlatformInformationExportArtifactPortRaw>[0],
) {
  const port = await createLocalPlatformInformationExportArtifactPortRaw(options);
  ports.push(port);
  return port;
}

const query: PlatformInformationQuery = {
  schema_version: 1,
  contract_kind: "query",
  view: "project_knowledge",
  project_id: "prj_local_cas",
  query_scope: {
    actor_id: "actor_local",
    accessible_project_ids: ["prj_local_cas"],
    content_types: ["knowledge_entry"],
  },
  limit: 10,
  cursor: null,
  cursor_verification: "server_port_required",
  sort: "extracted_at_desc_knowledge_id_asc",
};

const emptyPage: PlatformInformationPage = {
  schema_version: 1,
  contract_kind: "page",
  view: "project_knowledge",
  project_id: "prj_local_cas",
  page_state: "empty",
  sort: "extracted_at_desc_knowledge_id_asc",
  items: [],
  next_cursor: null,
  failures: [],
};

async function tempRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "hunter-export-cas-"));
  roots.push(parent);
  return join(parent, "private-cas-root");
}

async function windowsAcl(path: string): Promise<string> {
  return (await execFileAsync("icacls", [path], { windowsHide: true, encoding: "utf8" })).stdout;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function exportPage(
  artifact_port: Awaited<ReturnType<typeof createLocalPlatformInformationExportArtifactPort>>,
  currentPage: PlatformInformationPage,
) {
  const hash_port = createNodePlatformInformationExportHashPort();
  return createPlatformInformationExportModule({
    artifact_port,
    hash_port,
    page_source: createMemoryPlatformInformationExportPageSource({
      initial_query: query,
      pages: [currentPage],
      hash_port,
    }),
  }).export_all(query);
}

function casPath(root: string, contentSha: string): string {
  return join(root, "cas", `${contentSha.slice("sha256:".length)}.jsonl`);
}

describe("local filesystem Platform Information export CAS Adapter", () => {
  it.runIf(process.platform === "win32")("holds its authority until close and fails closed after guardian loss", async () => {
    const root = await tempRoot();
    const moved = `${root}-moved`;
    const port = await createLocalPlatformInformationExportArtifactPort({ root });
    await expect(createLocalPlatformInformationExportArtifactPortRaw({
      root,
      authority: Object.freeze({}),
    } as never)).rejects.toThrow("invalid export CAS options");
    await expect(rename(root, moved)).rejects.toMatchObject({
      code: expect.stringMatching(/EPERM|EBUSY|EACCES/u),
    });
    const queryKey = await createNodePlatformInformationExportHashPort()
      .sha256(new TextEncoder().encode(canonicalJson(query)));
    const attempt = await port.begin({ query_key: queryKey, query });
    killLocalPlatformInformationExportAuthorityForTest(port);
    await Promise.all([
      expect(port.begin({ query_key: queryKey, query })).rejects.toThrow("authority"),
      expect(port.append({ attempt_id: attempt.attempt_id, section: "manifest",
        chunk: new Uint8Array([1]), seal: false })).rejects.toThrow("authority"),
      expect(port.commit({ attempt_id: attempt.attempt_id, query_key: queryKey,
        serialized_receipt: "{}" })).rejects.toThrow("authority"),
      expect(port.abort({ attempt_id: attempt.attempt_id })).rejects.toThrow("authority"),
      expect(port.open({ export_id: attempt.export_id, project_id: query.project_id,
        content_sha: `sha256:${"0".repeat(64)}` })).rejects.toThrow("authority"),
    ]);
    await port.close();
    await expect(rename(root, moved)).resolves.toBeUndefined();
    await rename(moved, root);
  });

  it("validates lifetime before acquiring or creating a private root", async () => {
    const root = await tempRoot();
    await expect(createLocalPlatformInformationExportArtifactPortRaw({
      root,
      lifetime_ms: 0,
    })).rejects.toThrow("invalid export lifetime");
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "win32")("makes every concurrent close wait for guardian release", async () => {
    const root = await tempRoot();
    const moved = `${root}-moved`;
    const port = await createLocalPlatformInformationExportArtifactPort({ root });

    const first = port.close();
    const concurrent = port.close();
    await concurrent;
    await expect(rename(root, moved)).resolves.toBeUndefined();
    await first;
    await rename(moved, root);
  });
  it("streams a committed artifact and can reopen it after adapter restart", async () => {
    const root = await tempRoot();
    const hash_port = createNodePlatformInformationExportHashPort();
    const artifact_port = await createLocalPlatformInformationExportArtifactPort({
      root,
      now: () => "2026-08-14T03:00:00Z",
    });
    const exported = await exportPage(artifact_port, emptyPage);
    if (!exported.ok) throw new Error(exported.reason_code);
    expect(exported).toMatchObject({ ok: true });

    await artifact_port.close();
    const restarted = await createLocalPlatformInformationExportArtifactPort({ root });
    const chunks = await restarted.open(exported.value.download_ref);
    const bytes = await collect(chunks);

    expect(bytes.byteLength).toBe(exported.value.artifact.byte_count);
    expect(await hash_port.sha256(bytes)).toBe(exported.value.artifact.content_sha);
    const reopenedChunks = [];
    for await (const chunk of chunks) reopenedChunks.push(chunk.byteLength);
    expect(reopenedChunks.every((size) => size <= PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes)).toBe(true);
  });

  it("never overwrites a different canonical object even when no receipt exists", async () => {
    const root = await tempRoot();
    const now = () => "2026-08-14T03:00:00Z";
    const first = await createLocalPlatformInformationExportArtifactPort({ root, now });
    const exported = await exportPage(first, emptyPage);
    if (!exported.ok) throw new Error(exported.reason_code);
    const queryKey = await createNodePlatformInformationExportHashPort()
      .sha256(new TextEncoder().encode(canonicalJson(query)));
    await first.close();

    await rm(join(root, "queries", `${queryKey.slice("sha256:".length)}.json`));
    for (const entry of await readdir(join(root, "exports"))) {
      if (entry.endsWith(".json")) await rm(join(root, "exports", entry));
    }
    await writeFile(casPath(root, exported.value.artifact.content_sha), new Uint8Array([0x7b]));

    const before = await readFile(casPath(root, exported.value.artifact.content_sha));
    const restarted = await createLocalPlatformInformationExportArtifactPort({ root, now });
    await expect(exportPage(restarted, emptyPage)).resolves.toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    expect(await readFile(casPath(root, exported.value.artifact.content_sha))).toEqual(before);
  });

  it("never repairs a corrupt CAS object referenced by a surviving export receipt", async () => {
    const root = await tempRoot();
    const now = () => "2026-08-14T03:00:00Z";
    const first = await createLocalPlatformInformationExportArtifactPort({ root, now });
    const exported = await exportPage(first, emptyPage);
    if (!exported.ok) throw new Error(exported.reason_code);
    const queryKey = await createNodePlatformInformationExportHashPort()
      .sha256(new TextEncoder().encode(canonicalJson(query)));
    await first.close();
    await rm(join(root, "queries", `${queryKey.slice("sha256:".length)}.json`));
    const path = casPath(root, exported.value.artifact.content_sha);
    await writeFile(path, new Uint8Array([0x7b]));
    const before = await lstat(path, { bigint: true });
    const beforeBytes = await readFile(path);

    const restarted = await createLocalPlatformInformationExportArtifactPort({ root, now });
    await expect(exportPage(restarted, emptyPage)).resolves.toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    const after = await lstat(path, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(await readFile(path)).toEqual(beforeBytes);
  });

  it("never recreates a missing CAS object referenced by a surviving export receipt", async () => {
    const root = await tempRoot();
    const now = () => "2026-08-14T03:00:00Z";
    const first = await createLocalPlatformInformationExportArtifactPort({ root, now });
    const exported = await exportPage(first, emptyPage);
    if (!exported.ok) throw new Error(exported.reason_code);
    const queryKey = await createNodePlatformInformationExportHashPort()
      .sha256(new TextEncoder().encode(canonicalJson(query)));
    await first.close();
    await rm(join(root, "queries", `${queryKey.slice("sha256:".length)}.json`));
    const path = casPath(root, exported.value.artifact.content_sha);
    await rm(path);

    const restarted = await createLocalPlatformInformationExportArtifactPort({ root, now });
    await expect(exportPage(restarted, emptyPage)).resolves.toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never repairs a corrupt CAS object while any durable receipt still references it", async () => {
    const root = await tempRoot();
    const now = () => "2026-08-14T03:00:00Z";
    const first = await createLocalPlatformInformationExportArtifactPort({ root, now });
    const exported = await exportPage(first, emptyPage);
    if (!exported.ok) throw new Error(exported.reason_code);
    const hashPort = createNodePlatformInformationExportHashPort();
    const queryKey = await hashPort.sha256(new TextEncoder().encode(canonicalJson(query)));
    const alternateExportId = `export_${"f".repeat(32)}`;
    const alternateReceipt = {
      ...exported.value,
      export_id: alternateExportId,
      download_ref: { ...exported.value.download_ref, export_id: alternateExportId },
    };
    const alternateName = `${(await hashPort.sha256(
      new TextEncoder().encode(`export-id\0${alternateExportId}`),
    )).slice("sha256:".length)}.json`;
    await first.close();

    await rm(join(root, "queries", `${queryKey.slice("sha256:".length)}.json`));
    for (const entry of await readdir(join(root, "exports"))) {
      if (entry.endsWith(".json")) await rm(join(root, "exports", entry));
    }
    await writeFile(join(root, "exports", alternateName), canonicalJson(alternateReceipt), "utf8");
    const path = casPath(root, exported.value.artifact.content_sha);
    await writeFile(path, new Uint8Array([0x7b]));
    const before = await lstat(path, { bigint: true });
    const beforeBytes = await readFile(path);

    const restarted = await createLocalPlatformInformationExportArtifactPort({ root, now });
    await expect(exportPage(restarted, emptyPage)).resolves.toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    const after = await lstat(path, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(await readFile(path)).toEqual(beforeBytes);
  });

  it("treats a malformed durable receipt as fail-closed authority evidence", async () => {
    const root = await tempRoot();
    const now = () => "2026-08-14T03:00:00Z";
    const first = await createLocalPlatformInformationExportArtifactPort({ root, now });
    const exported = await exportPage(first, emptyPage);
    if (!exported.ok) throw new Error(exported.reason_code);
    const queryKey = await createNodePlatformInformationExportHashPort()
      .sha256(new TextEncoder().encode(canonicalJson(query)));
    await first.close();
    const exportReceipt = (await readdir(join(root, "exports")))
      .find((entry) => entry.endsWith(".json"));
    if (exportReceipt === undefined) throw new Error("export receipt was not published");
    await rm(join(root, "queries", `${queryKey.slice("sha256:".length)}.json`));
    await rm(join(root, "exports", exportReceipt));
    const receiptPath = join(root, "exports", `${"e".repeat(64)}.json`);
    await writeFile(receiptPath, "{", "utf8");
    const malformed = await readFile(receiptPath);
    const path = casPath(root, exported.value.artifact.content_sha);
    await writeFile(path, new Uint8Array([0x7b]));
    const before = await lstat(path, { bigint: true });
    const beforeBytes = await readFile(path);

    const restarted = await createLocalPlatformInformationExportArtifactPort({ root, now });
    await expect(exportPage(restarted, emptyPage)).resolves.toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
    expect(await readFile(receiptPath)).toEqual(malformed);
    expect((await lstat(path, { bigint: true })).ino).toBe(before.ino);
    expect(await readFile(path)).toEqual(beforeBytes);
  });

  it("makes concurrent equal commits idempotent and a different output a conflict", async () => {
    const root = await tempRoot();
    const port = await createLocalPlatformInformationExportArtifactPort({
      root,
      now: () => "2026-08-14T03:00:00Z",
    });
    const [first, second] = await Promise.all([
      exportPage(port, emptyPage),
      exportPage(port, emptyPage),
    ]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });

    const changedPage: PlatformInformationPage = {
      ...emptyPage,
      page_state: "ready",
      items: [{
        item_kind: "knowledge_entry",
        knowledge_id: "knowledge_changed",
        display_title: "Changed",
        lifecycle_status: "active",
        source_change_key: "change_changed",
        extracted_at: "2026-08-14T02:00:00Z",
        relationship_count: 0,
        sort_key: "2026-08-14T02:00:00Z:knowledge_changed",
      }],
    };
    await expect(exportPage(port, changedPage)).resolves.toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_COMMIT_CONFLICT",
    });
  });

  it("fails closed for corrupted or hard-linked committed objects", async () => {
    const root = await tempRoot();
    const port = await createLocalPlatformInformationExportArtifactPort({ root });
    const exported = await exportPage(port, emptyPage);
    if (!exported.ok) throw new Error(exported.reason_code);
    const path = casPath(root, exported.value.artifact.content_sha);
    await port.close();
    const alias = join(dirname(path), "hardlink-alias.jsonl");
    await link(path, alias);
    const hardLinked = await createLocalPlatformInformationExportArtifactPort({ root });
    await expect(hardLinked.open(exported.value.download_ref)).rejects.toThrow("private regular file");
    await hardLinked.close();
    await rm(alias);

    const file = await openFile(path, "r+");
    try {
      const firstByte = new Uint8Array(1);
      await file.read(firstByte, 0, 1, 0);
      firstByte[0] = (firstByte[0] ?? 0) ^ 0xff;
      await file.write(firstByte, 0, 1, 0);
      await file.sync();
    } finally {
      await file.close();
    }
    const restarted = await createLocalPlatformInformationExportArtifactPort({ root });
    const corrupt = await restarted.open(exported.value.download_ref);
    await expect(collect(corrupt)).rejects.toThrow("corrupt");
  });

  it("does not yield bytes when the CAS pathname is swapped after open", async () => {
    const root = await tempRoot();
    const port = await createLocalPlatformInformationExportArtifactPort({ root });
    const exported = await exportPage(port, emptyPage);
    if (!exported.ok) throw new Error(exported.reason_code);
    const source = await port.open(exported.value.download_ref);
    const path = casPath(root, exported.value.artifact.content_sha);
    const original = `${path}.original`;
    await rename(path, original);
    await writeFile(path, new Uint8Array([0x7b]));
    killLocalPlatformInformationExportAuthorityForTest(port);
    let yielded = 0;
    await expect((async () => {
      for await (const chunk of source) yielded += chunk.byteLength;
    })()).rejects.toThrow();
    expect(yielded).toBe(0);
  });

  it("keeps durable commit success idempotent when attempt cleanup fails", async () => {
    const root = await tempRoot();
    const cleanup = async (): Promise<void> => { throw new Error("injected cleanup failure"); };
    const port = await createLocalPlatformInformationExportArtifactPort({
      root,
      attempt_cleanup: cleanup,
    } as never);
    let committedInput: Parameters<typeof port.commit>[0] | undefined;
    const wrapped = {
      begin: port.begin,
      append: port.append,
      abort: port.abort,
      async commit(input: Parameters<typeof port.commit>[0]) {
        committedInput = input;
        return port.commit(input);
      },
    };
    const exported = await exportPage(wrapped as typeof port, emptyPage);
    if (!exported.ok) throw new Error(exported.reason_code);
    if (committedInput === undefined) throw new Error("commit was not captured");
    await expect(port.commit(committedInput)).resolves.toEqual({ ok: true, receipt: exported.value });
  });

  it.runIf(process.platform === "win32")("revalidates a queued commit after guardian loss", async () => {
    const root = await tempRoot();
    let releaseCleanup = (): void => undefined;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let cleanupEntered = (): void => undefined;
    const cleanupStarted = new Promise<void>((resolve) => { cleanupEntered = resolve; });
    const port = await createLocalPlatformInformationExportArtifactPort({
      root,
      now: () => "2026-08-14T03:00:00Z",
      async attempt_cleanup(directory) {
        cleanupEntered();
        await cleanupGate;
        await rm(directory, { recursive: true, force: true });
      },
    });
    const first = exportPage(port, emptyPage);
    await cleanupStarted;

    let secondCommitEntered = (): void => undefined;
    const secondCommitStarted = new Promise<void>((resolve) => { secondCommitEntered = resolve; });
    const queued = exportPage({
      begin: port.begin,
      append: port.append,
      abort: port.abort,
      async commit(input: Parameters<typeof port.commit>[0]) {
        secondCommitEntered();
        return port.commit(input);
      },
    } as typeof port, emptyPage);
    await secondCommitStarted;
    killLocalPlatformInformationExportAuthorityForTest(port);
    releaseCleanup();

    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(queued).resolves.toEqual({
      ok: false,
      reason_code: "PLATFORM_INFORMATION_EXPORT_ARTIFACT_WRITE_FAILURE",
    });
  });

  it("creates or requires a genuinely private root on the current platform", async () => {
    const root = await tempRoot();
    if (process.platform === "win32") {
      const parent = join(root, "..");
      const parentAcl = await windowsAcl(parent);
      const active = await createLocalPlatformInformationExportArtifactPort({ root });
      const acl = await windowsAcl(root);
      const entries = acl.split(/\r?\n/u).filter((line) => line.includes(":"));
      expect(entries).toHaveLength(3);
      expect(acl).not.toMatch(/Everyone|Authenticated Users|BUILTIN\\Users|CodexSandboxUsers/iu);
      expect(acl).toMatch(/SYSTEM/iu);
      expect(acl).toMatch(/Administrators/iu);
      expect(await windowsAcl(parent)).toBe(parentAcl);

      await active.close();
      await rm(join(root, ".hunter-private-directory-authority-v1"));
      await expect(createLocalPlatformInformationExportArtifactPort({ root }))
        .rejects.toThrow(/marker/iu);
    } else {
      const active = await createLocalPlatformInformationExportArtifactPort({ root });
      await active.close();
      await chmod(root, 0o755);
      await expect(createLocalPlatformInformationExportArtifactPort({ root }))
        .rejects.toThrow("private");
      await chmod(root, 0o700);
      await expect(createLocalPlatformInformationExportArtifactPort({ root })).resolves.toBeDefined();
    }
  });

  it("never mutates an existing business root or tolerates a widened managed subdirectory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hunter-export-business-"));
    roots.push(parent);
    const businessRoot = join(parent, "existing-data");
    await mkdir(businessRoot);
    await writeFile(join(businessRoot, "keep.txt"), "keep\n");
    if (process.platform === "win32") {
      const before = await windowsAcl(businessRoot);
      await expect(createLocalPlatformInformationExportArtifactPort({ root: businessRoot }))
        .rejects.toThrow(/private|marker|owner/iu);
      expect(await windowsAcl(businessRoot)).toBe(before);
      expect(await readFile(join(businessRoot, "keep.txt"), "utf8")).toBe("keep\n");

      const privateRoot = join(parent, "managed");
      const managed = await createLocalPlatformInformationExportArtifactPort({ root: privateRoot });
      await managed.close();
      const attempts = join(privateRoot, "attempts");
      await execFileAsync("icacls", [attempts, "/grant", "*S-1-1-0:(OI)(CI)RX"], {
        windowsHide: true,
        encoding: "utf8",
      });
      const widened = await windowsAcl(attempts);
      await expect(createLocalPlatformInformationExportArtifactPort({ root: privateRoot }))
        .rejects.toThrow(/DACL|private/iu);
      expect(await windowsAcl(attempts)).toBe(widened);
    } else {
      await chmod(businessRoot, 0o755);
      const before = await lstat(businessRoot);
      await expect(createLocalPlatformInformationExportArtifactPort({ root: businessRoot }))
        .rejects.toThrow("private");
      expect((await lstat(businessRoot)).mode).toBe(before.mode);
    }
  });

  it("rejects hostile inputs without running Proxy traps or getters and bounds append chunks", async () => {
    const root = await tempRoot();
    const port = await createLocalPlatformInformationExportArtifactPort({ root });
    let executions = 0;
    await expect(createLocalPlatformInformationExportArtifactPort(new Proxy({}, {
      get() { executions += 1; throw new Error("trap"); },
      ownKeys() { executions += 1; throw new Error("trap"); },
    }) as never)).rejects.toThrow("invalid export CAS options");
    const getterOptions = Object.defineProperty({}, "root", {
      enumerable: true,
      get() { executions += 1; return root; },
    });
    await expect(createLocalPlatformInformationExportArtifactPort(getterOptions as never))
      .rejects.toThrow("invalid export CAS options");
    const hostileRef = new Proxy({}, {
      get() { executions += 1; throw new Error("trap"); },
      ownKeys() { executions += 1; throw new Error("trap"); },
      getOwnPropertyDescriptor() { executions += 1; throw new Error("trap"); },
    });
    await expect(port.open(hostileRef as never)).rejects.toThrow("invalid export download reference");
    const getterRef = Object.defineProperty({}, "export_id", {
      enumerable: true,
      get() { executions += 1; return "export_bad"; },
    });
    await expect(port.open(getterRef as never)).rejects.toThrow("invalid export download reference");

    const hash = createNodePlatformInformationExportHashPort();
    const query_key = await hash.sha256(new TextEncoder().encode(canonicalJson(query)));
    const getterQuery = structuredClone(query);
    Object.defineProperty(getterQuery.query_scope, "actor_id", {
      enumerable: true,
      get() { executions += 1; return "actor_hostile"; },
    });
    await expect(port.begin({ query_key, query: getterQuery })).rejects.toThrow("invalid export begin input");
    const attempt = await port.begin({ query_key, query });
    const hostileChunk = new Proxy(new Uint8Array([1]), {
      get() { executions += 1; throw new Error("trap"); },
    });
    await expect(port.append({
      attempt_id: attempt.attempt_id,
      section: "manifest",
      chunk: hostileChunk,
      seal: false,
    })).rejects.toThrow("invalid export append input");
    expect(executions).toBe(0);
    await expect(port.append({
      attempt_id: attempt.attempt_id,
      section: "manifest",
      chunk: new Uint8Array(PLATFORM_INFORMATION_EXPORT_LIMITS.chunk_bytes + 1),
      seal: false,
    })).rejects.toThrow("invalid export append");
    const sectionAlias = join(root, "section-hardlink");
    if (process.platform === "win32") {
      await expect(link(join(root, "attempts", attempt.attempt_id, "manifest.part"), sectionAlias))
        .rejects.toMatchObject({ code: expect.stringMatching(/EPERM|EBUSY|EACCES/u) });
    } else {
      await expect(link(join(root, "attempts", attempt.attempt_id, "manifest.part"), sectionAlias))
        .resolves.toBeUndefined();
      await rm(sectionAlias);
    }
    await port.abort({ attempt_id: attempt.attempt_id });
    await port.close();
    await expect(readdir(join(root, "attempts"))).resolves.toEqual([
      ".hunter-private-directory-authority-v1",
    ]);
  });

  it("never exposes an uncommitted crash orphan through open", async () => {
    const root = await tempRoot();
    const hash = createNodePlatformInformationExportHashPort();
    const port = await createLocalPlatformInformationExportArtifactPort({ root });
    const query_key = await hash.sha256(new TextEncoder().encode(canonicalJson(query)));
    const attempt = await port.begin({ query_key, query });
    await port.append({
      attempt_id: attempt.attempt_id,
      section: "manifest",
      chunk: new TextEncoder().encode("orphan"),
      seal: false,
    });
    await port.append({
      attempt_id: attempt.attempt_id,
      section: "footer",
      chunk: new TextEncoder().encode("sealed"),
      seal: true,
    });
    await port.close();
    const orphan = join(root, "attempts", attempt.attempt_id);
    await mkdir(orphan, { recursive: false, mode: 0o700 });
    await writeFile(join(orphan, "assembled.tmp"), new TextEncoder().encode("crash orphan"), { mode: 0o600 });
    const restarted = await createLocalPlatformInformationExportArtifactPort({ root });
    await expect(restarted.open({
      export_id: attempt.export_id,
      project_id: query.project_id,
      content_sha: `sha256:${"0".repeat(64)}`,
    })).rejects.toThrow("not found");
  });

  it("returns the same receipt for a lost-response commit retry", async () => {
    const root = await tempRoot();
    const port = await createLocalPlatformInformationExportArtifactPort({ root });
    let committedInput: Parameters<typeof port.commit>[0] | undefined;
    const wrapped = {
      begin: port.begin,
      append: port.append,
      abort: port.abort,
      async commit(input: Parameters<typeof port.commit>[0]) {
        committedInput = input;
        return port.commit(input);
      },
    };
    const exported = await exportPage(wrapped as typeof port, emptyPage);
    if (!exported.ok) throw new Error(exported.reason_code);
    if (committedInput === undefined) throw new Error("commit was not captured");
    await expect(port.commit(committedInput)).resolves.toEqual({
      ok: true,
      receipt: exported.value,
    });
  });
});
