import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  closePrivateDirectoryAuthority,
  consolidatePrivateDirectoryAuthority,
  listControlledEntries,
  prepareNewLeaf as prepareNewLeafRaw,
  publishControlledFile,
  validatePrivateDirectoryAuthority,
  verifyExisting as verifyExistingRaw,
  verifyExistingConsolidated,
} from "../src/private-directory-authority/index.js";
import {
  consolidatePrivateDirectoryAuthorityWithHookForTest,
  killPrivateDirectoryAuthorityGuardianForTest,
  listControlledEntriesWithHookForTest,
  prepareNewLeafWithPreAclHookForTest,
  prepareNewLeafWithHookForTest,
  publishControlledFileWithFaultForTest,
} from "../src/private-directory-authority/module.js";
import type { PrivateDirectoryAuthority } from "../src/private-directory-authority/types.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const authorities: PrivateDirectoryAuthority[] = [];

async function prepareNewLeaf(parent: unknown, leaf: unknown): Promise<PrivateDirectoryAuthority> {
  const result = await prepareNewLeafRaw(parent, leaf);
  authorities.push(result);
  return result;
}

async function verifyExisting(root: unknown, controlled: unknown): Promise<PrivateDirectoryAuthority> {
  const result = await verifyExistingRaw(root, controlled);
  authorities.push(result);
  return result;
}

const WINDOWS_GUARDIAN_NATIVE_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class HunterPrivateDirectoryGuardianSpike {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern uint GetSecurityInfo(IntPtr handle, int kind, uint information, out IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")]
  public static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr memory);
  public static SafeFileHandle Open(string path) {
    return CreateFileW(path, 0x00030000, 0x00000000, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
  }
}`;

const WINDOWS_GUARDIAN_SCRIPT = String.raw`
Add-Type -TypeDefinition $env:HUNTER_GUARDIAN_NATIVE
$handle=[HunterPrivateDirectoryGuardianSpike]::Open($env:HUNTER_GUARDIAN_PATH)
if($handle.IsInvalid){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
$owner=[IntPtr]::Zero;$descriptor=[IntPtr]::Zero
$status=[HunterPrivateDirectoryGuardianSpike]::GetSecurityInfo($handle.DangerousGetHandle(),1,5,[ref]$owner,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[ref]$descriptor)
if($status -ne 0){throw [ComponentModel.Win32Exception]::new([int]$status)}
try {
  $length=[HunterPrivateDirectoryGuardianSpike]::GetSecurityDescriptorLength($descriptor)
  $bytes=New-Object byte[] $length
  [Runtime.InteropServices.Marshal]::Copy($descriptor,$bytes,0,$length)
  $raw=New-Object System.Security.AccessControl.RawSecurityDescriptor($bytes,0)
  [pscustomobject]@{ready=$true;owner=$raw.Owner.Value;sddl=$raw.GetSddlForm([System.Security.AccessControl.AccessControlSections]6)}|ConvertTo-Json -Compress
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally {
  if($descriptor -ne [IntPtr]::Zero){[void][HunterPrivateDirectoryGuardianSpike]::LocalFree($descriptor)}
  $handle.Dispose()
}`;

async function guardianLine(child: ReturnType<typeof spawn>): Promise<string> {
  if (child.stdout === null) throw new Error("guardian stdout is unavailable");
  const lines = createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("guardian did not become ready")), 15_000);
    lines.once("line", (line) => { clearTimeout(timeout); resolve(line); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`guardian exited before ready: ${code}`));
      }
    });
  });
}

async function parentRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hunter-private-authority-"));
  roots.push(path);
  return path;
}

async function windowsSddl(path: string): Promise<string> {
  const result = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$s=New-Object System.Security.AccessControl.DirectorySecurity($env:HUNTER_PRIVATE_PATH,[System.Security.AccessControl.AccessControlSections]::All);$s.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All)",
  ], {
    windowsHide: true,
    encoding: "utf8",
    env: { ...process.env, HUNTER_PRIVATE_PATH: path },
  });
  return result.stdout.trim();
}

async function currentWindowsSid(): Promise<string> {
  const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value"], {
    windowsHide: true, encoding: "utf8",
  });
  return result.stdout.trim();
}

async function setWindowsSddl(path: string, kind: "directory" | "file", sddl: string): Promise<void> {
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$s=if($env:HUNTER_KIND -eq 'file'){New-Object System.Security.AccessControl.FileSecurity}else{New-Object System.Security.AccessControl.DirectorySecurity};$s.SetSecurityDescriptorSddlForm($env:HUNTER_SDDL,[System.Security.AccessControl.AccessControlSections]::All);if($env:HUNTER_KIND -eq 'file'){([System.IO.FileInfo]::new($env:HUNTER_PATH)).SetAccessControl($s)}else{([System.IO.DirectoryInfo]::new($env:HUNTER_PATH)).SetAccessControl($s)}"], {
    windowsHide: true,
    encoding: "utf8",
    env: { ...process.env, HUNTER_PATH: path, HUNTER_KIND: kind, HUNTER_SDDL: sddl },
  });
}

afterEach(async () => {
  await Promise.all(authorities.splice(0).map(closePrivateDirectoryAuthority));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private directory authority Module", () => {
  function publicationRequest(
    controlledLeaf: string,
    finalName: string,
    bytes: Uint8Array,
  ) {
    return {
      controlled_leaf: controlledLeaf,
      final_name: finalName,
      expected_sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      expected_bytes: bytes.byteLength,
      reader: {
        async read(offset: number, maxBytes: number): Promise<Uint8Array | null> {
          if (offset >= bytes.byteLength) return null;
          return bytes.slice(offset, Math.min(bytes.byteLength, offset + maxBytes));
        },
      },
    };
  }

  it("publishes a controlled file once and reports identical or different existing content", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "objects");
    const proof = await consolidatePrivateDirectoryAuthority(
      rootAuthority, [child], ["objects"],
    );
    authorities.push(proof);
    const bytes = new TextEncoder().encode("durable publication\n");
    const request = publicationRequest("objects", "artifact.bin", bytes);

    await expect(publishControlledFile(proof, request)).resolves.toEqual({
      outcome: "published",
      sha256: request.expected_sha256,
      bytes: bytes.byteLength,
    });
    expect(await readFile(join(child.root, "artifact.bin"))).toEqual(Buffer.from(bytes));
    await expect(publishControlledFile(proof, request)).resolves.toEqual({
      outcome: "existing_identical",
      sha256: request.expected_sha256,
      bytes: bytes.byteLength,
    });
    const different = publicationRequest("objects", "artifact.bin", new TextEncoder().encode("different\n"));
    await expect(publishControlledFile(proof, different)).resolves.toMatchObject({
      outcome: "existing_different",
      sha256: request.expected_sha256,
      bytes: bytes.byteLength,
    });
    expect(Object.isFrozen(await publishControlledFile(proof, request))).toBe(true);
  });

  it.runIf(process.platform === "win32")("streams bounded chunks with backpressure and never exposes a partial final file", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "objects");
    const proof = await consolidatePrivateDirectoryAuthority(rootAuthority, [child], ["objects"]);
    authorities.push(proof);
    const bytes = new Uint8Array(1_200_000).fill(0x5a);
    const request = publicationRequest("objects", "large.bin", bytes);
    let releaseSecond = (): void => undefined;
    const secondGate = new Promise<void>((resolveGate) => { releaseSecond = resolveGate; });
    let secondReached = (): void => undefined;
    const reached = new Promise<void>((resolveReached) => { secondReached = resolveReached; });
    const maxima: number[] = [];
    let calls = 0;
    request.reader.read = async (offset, maxBytes) => {
      maxima.push(maxBytes);
      calls += 1;
      if (calls === 2) { secondReached(); await secondGate; }
      if (offset >= bytes.byteLength) return null;
      return bytes.slice(offset, Math.min(bytes.byteLength, offset + maxBytes));
    };
    const publishing = publishControlledFile(proof, request);
    await reached;
    await expect(lstat(join(child.root, "large.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(maxima.every((value) => value <= 1_048_576)).toBe(true);
    releaseSecond();
    await expect(publishing).resolves.toMatchObject({ outcome: "published", bytes: bytes.byteLength });
    expect(await readFile(join(child.root, "large.bin"))).toEqual(Buffer.from(bytes));
  });

  it.runIf(process.platform === "win32")("serializes same-key publishers and distinguishes concurrent content", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "objects");
    const proof = await consolidatePrivateDirectoryAuthority(rootAuthority, [child], ["objects"]);
    authorities.push(proof);
    const first = publicationRequest("objects", "shared.bin", new TextEncoder().encode("first"));
    const same = publicationRequest("objects", "shared.bin", new TextEncoder().encode("first"));
    const different = publicationRequest("objects", "shared.bin", new TextEncoder().encode("second"));
    const outcomes = await Promise.all([
      publishControlledFile(proof, first),
      publishControlledFile(proof, same),
      publishControlledFile(proof, different),
    ]);
    expect(outcomes.map((value) => value.outcome)).toEqual([
      "published", "existing_identical", "existing_different",
    ]);
    expect(await readFile(join(child.root, "shared.bin"), "utf8")).toBe("first");
  });

  it.runIf(process.platform === "win32")("aborts a failed reader without poisoning the guardian and permits retry", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "objects");
    const proof = await consolidatePrivateDirectoryAuthority(rootAuthority, [child], ["objects"]);
    authorities.push(proof);
    const bytes = new TextEncoder().encode("retryable");
    const failing = publicationRequest("objects", "retry.bin", bytes);
    failing.reader.read = async () => { throw new Error("reader failed"); };
    await expect(publishControlledFile(proof, failing)).rejects.toThrow("reader failed");
    expect(validatePrivateDirectoryAuthority(proof)).toBe(true);
    await expect(publishControlledFile(proof, publicationRequest("objects", "retry.bin", bytes)))
      .resolves.toMatchObject({ outcome: "published" });
    expect((await readdir(child.root)).some((name) => name.startsWith(".hunter-publish-v1-"))).toBe(false);
  });

  it("rejects hostile publication inputs and invalid authority before reader calls", async () => {
    let calls = 0;
    const bytes = new Uint8Array([1]);
    const request = publicationRequest("objects", "safe.bin", bytes);
    request.reader.read = async () => { calls += 1; return bytes; };
    await expect(publishControlledFile(Object.freeze({}), request)).rejects.toThrow("authority");
    await expect(publishControlledFile(Object.freeze({}), {
      ...request, expected_bytes: 512 * 1_024 * 1_024 + 1,
    })).rejects.toThrow("request");
    await expect(publishControlledFile(Object.freeze({}), {
      ...request, final_name: "../escape",
    })).rejects.toThrow("leaf");
    let traps = 0;
    const hostile = new Proxy({}, { get() { traps += 1; throw new Error("trap"); } });
    await expect(publishControlledFile(Object.freeze({}), hostile)).rejects.toThrow("request");
    const getterRequest = {};
    Object.defineProperty(getterRequest, "controlled_leaf", {
      enumerable: true, get() { traps += 1; throw new Error("getter"); },
    });
    await expect(publishControlledFile(Object.freeze({}), getterRequest)).rejects.toThrow("request");
    expect(calls).toBe(0);
    expect(traps).toBe(0);
  });

  it.runIf(process.platform === "win32")("rejects non-genuine reader promises and chunks without leaving publication state", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "objects");
    const proof = await consolidatePrivateDirectoryAuthority(rootAuthority, [child], ["objects"]);
    authorities.push(proof);
    const bytes = new Uint8Array([1]);
    const thenable = publicationRequest("objects", "thenable.bin", bytes);
    thenable.reader.read = (() => ({ then() { throw new Error("then trap"); } })) as never;
    await expect(publishControlledFile(proof, thenable)).rejects.toThrow("non-genuine Promise");
    const bufferChunk = publicationRequest("objects", "buffer.bin", bytes);
    bufferChunk.reader.read = async () => Buffer.from(bytes);
    await expect(publishControlledFile(proof, bufferChunk)).rejects.toThrow("invalid chunk");
    await expect(publishControlledFile(proof, publicationRequest("objects", "valid.bin", bytes)))
      .resolves.toMatchObject({ outcome: "published" });
  });

  it("does not execute hostile reader bind or Promise proxy prototype traps", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "objects");
    const proof = await consolidatePrivateDirectoryAuthority(rootAuthority, [child], ["objects"]);
    authorities.push(proof);
    let traps = 0;
    const read = async (): Promise<Uint8Array | null> => null;
    Object.defineProperty(read, "bind", { get() { traps += 1; throw new Error("bind getter"); } });
    const request = publicationRequest("objects", "hostile.bin", new Uint8Array(0));
    request.reader.read = read;
    await expect(publishControlledFile(proof, request)).resolves.toMatchObject({ outcome: "published" });
    const proxyPromise = new Proxy(Promise.resolve(null), {
      getPrototypeOf() { traps += 1; throw new Error("prototype trap"); },
    });
    const second = publicationRequest("objects", "proxy.bin", new Uint8Array(0));
    second.reader.read = (() => proxyPromise) as never;
    await expect(publishControlledFile(proof, second)).rejects.toThrow("non-genuine Promise");
    expect(traps).toBe(0);
  });

  it.runIf(process.platform === "win32")("rejects Win32 aliases and case-folded reserved publication names", async () => {
    const request = publicationRequest("objects", "safe.bin", new Uint8Array(0));
    for (const finalName of ["CON", "nul.txt", "trailing.", "trailing ", ".HUNTER-PUBLISH-V1-x.tmp"]) {
      await expect(publishControlledFile(Object.freeze({}), { ...request, final_name: finalName }))
        .rejects.toThrow(/name|reserved/u);
    }
  });

  it.runIf(process.platform === "win32")("fails closed for an existing hard-linked final file", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "objects");
    const proof = await consolidatePrivateDirectoryAuthority(rootAuthority, [child], ["objects"]);
    authorities.push(proof);
    const source = join(child.root, "source.bin");
    await writeFile(source, "linked");
    await link(source, join(child.root, "linked.bin"));
    const request = publicationRequest("objects", "linked.bin", new TextEncoder().encode("linked"));
    await expect(publishControlledFile(proof, request)).rejects.toThrow("guardian exited");
    expect(validatePrivateDirectoryAuthority(proof)).toBe(false);
    expect(await readFile(source, "utf8")).toBe("linked");
  });

  it.runIf(process.platform === "win32")("retries an ambiguous post-rename reply as existing identical", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "objects");
    const proof = await consolidatePrivateDirectoryAuthority(rootAuthority, [child], ["objects"]);
    authorities.push(proof);
    const request = publicationRequest("objects", "ambiguous.bin", new TextEncoder().encode("committed"));
    await expect(publishControlledFileWithFaultForTest(proof, request, "ambiguous_after_rename"))
      .rejects.toThrow("result");
    expect(validatePrivateDirectoryAuthority(proof)).toBe(true);
    await expect(publishControlledFile(proof, request)).resolves.toMatchObject({
      outcome: "existing_identical",
    });
  });

  it.runIf(process.platform === "win32")("leaves only a bounded invisible orphan when the guardian crashes before rename", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "objects");
    const proof = await consolidatePrivateDirectoryAuthority(rootAuthority, [child], ["objects"]);
    authorities.push(proof);
    const request = publicationRequest("objects", "before.bin", new TextEncoder().encode("not visible"));
    await expect(publishControlledFileWithFaultForTest(proof, request, "crash_before_rename"))
      .rejects.toThrow("guardian exited");
    await expect(lstat(join(child.root, "before.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    const orphans = (await readdir(child.root)).filter((name) => name.startsWith(".hunter-publish-v1-"));
    expect(orphans).toHaveLength(1);
    expect((await lstat(join(child.root, orphans[0] as string))).isFile()).toBe(true);
  });

  it.runIf(process.platform === "win32")("leaves a complete durable final when the guardian crashes after rename", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "objects");
    const proof = await consolidatePrivateDirectoryAuthority(rootAuthority, [child], ["objects"]);
    authorities.push(proof);
    const bytes = new TextEncoder().encode("fully committed");
    const request = publicationRequest("objects", "after.bin", bytes);
    await expect(publishControlledFileWithFaultForTest(proof, request, "crash_after_rename"))
      .rejects.toThrow("guardian exited");
    expect(await readFile(join(child.root, "after.bin"))).toEqual(Buffer.from(bytes));
    expect((await readdir(child.root)).some((name) => name.startsWith(".hunter-publish-v1-"))).toBe(false);
    expect(validatePrivateDirectoryAuthority(proof)).toBe(false);
  });

  it("never deletes an unrelated known-pattern temp while publishing the same key", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "objects");
    const proof = await consolidatePrivateDirectoryAuthority(rootAuthority, [child], ["objects"]);
    authorities.push(proof);
    const finalName = "preserve.bin";
    const prefix = createHash("sha256").update(finalName).digest("hex").slice(0, 16);
    const foreignTemp = join(child.root, `.hunter-publish-v1-${prefix}-foreign.tmp`);
    await writeFile(foreignTemp, "active foreign writer");
    const request = publicationRequest("objects", finalName, new TextEncoder().encode("winner"));
    await expect(publishControlledFile(proof, request)).resolves.toMatchObject({ outcome: "published" });
    expect(await readFile(foreignTemp, "utf8")).toBe("active foreign writer");
  });

  it.runIf(process.platform === "win32")("restarts an existing tree as a publish-capable consolidated proof", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "objects");
    await closePrivateDirectoryAuthority(child);
    await closePrivateDirectoryAuthority(rootAuthority);

    const restarted = await verifyExistingConsolidated(join(parent, "managed"), ["objects"]);
    authorities.push(restarted);
    expect(validatePrivateDirectoryAuthority(restarted)).toBe(true);
    await expect(rename(join(parent, "managed"), join(parent, "moved"))).rejects.toMatchObject({
      code: expect.stringMatching(/EPERM|EBUSY|EACCES/u),
    });
    const request = publicationRequest("objects", "restart.bin", new TextEncoder().encode("restart"));
    await expect(publishControlledFile(restarted, request)).resolves.toMatchObject({ outcome: "published" });
    await closePrivateDirectoryAuthority(restarted);
    await closePrivateDirectoryAuthority(restarted);
    await expect(rename(join(parent, "managed"), join(parent, "moved"))).resolves.toBeUndefined();
    await rename(join(parent, "moved"), join(parent, "managed"));
  });

  it.runIf(process.platform === "win32")("allows only one concurrent restart authority for an exact root", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "objects");
    await closePrivateDirectoryAuthority(child);
    await closePrivateDirectoryAuthority(rootAuthority);
    const settled = await Promise.allSettled([
      verifyExistingConsolidated(join(parent, "managed"), ["objects"]),
      verifyExistingConsolidated(join(parent, "managed"), ["objects"]),
    ]);
    const fulfilled = settled.filter((value): value is PromiseFulfilledResult<PrivateDirectoryAuthority> =>
      value.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const winner = fulfilled[0];
    if (winner === undefined) throw new Error("concurrent restart did not produce an authority");
    authorities.push(winner.value);
    expect(settled.filter((value) => value.status === "rejected")).toHaveLength(1);
  });

  it("purely rejects hostile or inexact consolidated restart input", async () => {
    let traps = 0;
    const hostile = new Proxy([], { get() { traps += 1; throw new Error("trap"); } });
    await expect(verifyExistingConsolidated("missing", hostile)).rejects.toThrow("controlled directories");
    const getterLeaves: unknown[] = [];
    Object.defineProperty(getterLeaves, "0", { enumerable: true, get() { traps += 1; return "objects"; } });
    Object.defineProperty(getterLeaves, "length", { value: 1 });
    await expect(verifyExistingConsolidated("missing", getterLeaves)).rejects.toThrow("controlled directories");
    expect(traps).toBe(0);
  });
  it.runIf(process.platform === "win32")("blocks an ACL-to-marker swap and never signs a failed preparation", async () => {
    const parent = await parentRoot();
    const root = join(parent, "managed");
    const moved = join(parent, "moved");
    await expect(prepareNewLeafWithHookForTest(parent, "managed", async (guardedRoot) => {
      expect(guardedRoot).toBe(root);
      await expect(rename(root, moved)).rejects.toMatchObject({
        code: expect.stringMatching(/EPERM|EBUSY|EACCES/u),
      });
      throw new Error("injected preparation failure");
    })).rejects.toThrow("injected preparation failure");
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(validatePrivateDirectoryAuthority({ root })).toBe(false);
  });

  it.runIf(process.platform === "win32")("quarantines a pre-hardening insertion with the canonical root ACL", async () => {
    const parent = await parentRoot();
    const root = join(parent, "managed");
    await expect(prepareNewLeafWithPreAclHookForTest(parent, "managed", async () => {
      await writeFile(join(root, "intruder.txt"), "intruder\n");
    })).rejects.toThrow("new private directory is not empty");
    expect(validatePrivateDirectoryAuthority({ root })).toBe(false);
    await expect(lstat(join(root, ".hunter-private-directory-authority-v1")))
      .rejects.toMatchObject({ code: "ENOENT" });
    const sid = await currentWindowsSid();
    const descriptor = await windowsSddl(root);
    expect(descriptor).toContain(`O:${sid}`);
    expect(descriptor).toContain("D:P");
    expect(descriptor.match(/\(A;OICI;FA;;;[^)]+\)/gu)?.sort()).toEqual([
      "(A;OICI;FA;;;BA)", `(A;OICI;FA;;;${sid})`, "(A;OICI;FA;;;SY)",
    ].sort());
    expect(descriptor).not.toContain("(I)");
  });

  it.runIf(process.platform === "win32")("invalidates an unforgeable proof when its guardian crashes", async () => {
    const parent = await parentRoot();
    const proof = await prepareNewLeaf(parent, "managed");
    expect(validatePrivateDirectoryAuthority(proof)).toBe(true);
    expect(validatePrivateDirectoryAuthority({
      root: proof.root,
      marker: proof.marker,
      controlled_directories: proof.controlled_directories,
    })).toBe(false);
    killPrivateDirectoryAuthorityGuardianForTest(proof);
    expect(validatePrivateDirectoryAuthority(proof)).toBe(false);
  });

  it.runIf(process.platform === "win32")("holds rename exclusion until close and supports restart verification", async () => {
    const parent = await parentRoot();
    const root = join(parent, "managed");
    const moved = join(parent, "moved");
    const proof = await prepareNewLeaf(parent, "managed");
    await expect(rename(root, moved)).rejects.toMatchObject({
      code: expect.stringMatching(/EPERM|EBUSY|EACCES/u),
    });
    await closePrivateDirectoryAuthority(proof);
    expect(validatePrivateDirectoryAuthority(proof)).toBe(false);
    await expect(rename(root, moved)).resolves.toBeUndefined();
    await rename(moved, root);
    const restarted = await verifyExisting(root, []);
    expect(validatePrivateDirectoryAuthority(restarted)).toBe(true);
  });

  it("lists only sorted bounded metadata from a registered controlled directory", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const childAuthority = await prepareNewLeaf(rootAuthority.root, "receipts");
    await writeFile(join(childAuthority.root, "b.json"), "bb");
    await writeFile(join(childAuthority.root, "a.json"), "a");
    const proof = await verifyExisting(rootAuthority.root, ["receipts"]);

    const entries = await listControlledEntries(proof, "receipts");
    expect(entries.map(({ name, kind, size }) => ({ name, kind, size }))).toEqual([
      { name: ".hunter-private-directory-authority-v1", kind: "file", size: 38 },
      { name: "a.json", kind: "file", size: 1 },
      { name: "b.json", kind: "file", size: 2 },
    ]);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(entries.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.identity) &&
      /^[0-9]+$/u.test(entry.identity.device) && /^[0-9]+$/u.test(entry.identity.file))).toBe(true);
    await expect(listControlledEntries(proof, "../receipts")).rejects.toThrow("leaf");
    await expect(listControlledEntries(Object.freeze({}), "receipts")).rejects.toThrow("authority");
    let executions = 0;
    const hostileLeaf = new Proxy({}, { get() { executions += 1; throw new Error("trap"); } });
    await expect(listControlledEntries(proof, hostileLeaf)).rejects.toThrow("leaf");
    expect(executions).toBe(0);
    await expect(rename(childAuthority.root, `${childAuthority.root}-moved`)).rejects.toMatchObject({
      code: expect.stringMatching(/EPERM|EBUSY|EACCES/u),
    });
    await closePrivateDirectoryAuthority(proof);
    await expect(listControlledEntries(proof, "receipts")).rejects.toThrow("authority");
  });

  it.runIf(process.platform === "win32")("atomically hands child ownership to a parent-bound controlled proof", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const first = await prepareNewLeaf(rootAuthority.root, "receipts");
    const second = await prepareNewLeaf(rootAuthority.root, "objects");
    await writeFile(join(first.root, "ready.json"), "{}");

    const consolidated = await consolidatePrivateDirectoryAuthority(
      rootAuthority, [first, second], ["receipts", "objects"],
    );
    authorities.push(consolidated);
    expect(validatePrivateDirectoryAuthority(first)).toBe(false);
    expect(validatePrivateDirectoryAuthority(second)).toBe(false);
    expect(validatePrivateDirectoryAuthority(rootAuthority)).toBe(true);
    expect(validatePrivateDirectoryAuthority(consolidated)).toBe(true);
    await expect(listControlledEntries(first, "receipts")).rejects.toThrow("authority");
    await expect(listControlledEntries(consolidated, "receipts")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "ready.json" }),
    ]));
    await expect(rename(rootAuthority.root, `${rootAuthority.root}-moved`)).rejects.toMatchObject({
      code: expect.stringMatching(/EPERM|EBUSY|EACCES/u),
    });
    await expect(rename(first.root, `${first.root}-moved`)).rejects.toMatchObject({
      code: expect.stringMatching(/EPERM|EBUSY|EACCES/u),
    });

    await closePrivateDirectoryAuthority(rootAuthority);
    expect(validatePrivateDirectoryAuthority(consolidated)).toBe(false);
  });

  it.runIf(process.platform === "win32")("rejects a non-exact handoff without consuming valid proofs", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "receipts");
    await expect(consolidatePrivateDirectoryAuthority(rootAuthority, [child], ["other"]))
      .rejects.toThrow("match");
    expect(validatePrivateDirectoryAuthority(rootAuthority)).toBe(true);
    expect(validatePrivateDirectoryAuthority(child)).toBe(true);
  });

  it.runIf(process.platform === "win32")("keeps root exclusion continuous and shares child close settlement during handoff", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "receipts");
    const moved = `${child.root}-moved`;

    const consolidated = await consolidatePrivateDirectoryAuthorityWithHookForTest(
      rootAuthority, [child], ["receipts"], async () => {
        await expect(rename(child.root, moved)).rejects.toMatchObject({
          code: expect.stringMatching(/EPERM|EBUSY|EACCES/u),
        });
        await expect(closePrivateDirectoryAuthority(child)).resolves.toBeUndefined();
      },
    );
    authorities.push(consolidated);
    expect(validatePrivateDirectoryAuthority(child)).toBe(false);
    expect(validatePrivateDirectoryAuthority(consolidated)).toBe(true);
    await expect(rename(child.root, moved)).rejects.toMatchObject({
      code: expect.stringMatching(/EPERM|EBUSY|EACCES/u),
    });
  });

  it.runIf(process.platform === "win32")("invalidates consumed children after a failed handoff without signing a partial proof", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "receipts");

    await expect(consolidatePrivateDirectoryAuthorityWithHookForTest(
      rootAuthority, [child], ["receipts"], () => { throw new Error("injected handoff failure"); },
    )).rejects.toThrow("injected handoff failure");
    expect(validatePrivateDirectoryAuthority(child)).toBe(false);
    expect(validatePrivateDirectoryAuthority(rootAuthority)).toBe(true);
    await expect(rename(child.root, `${child.root}-moved`)).rejects.toMatchObject({
      code: expect.stringMatching(/EPERM|EBUSY|EACCES/u),
    });
  });

  it.runIf(process.platform === "win32")("holds the parent guardian until a concurrent parent close settles the handoff", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "receipts");
    let closeSettled = false;
    let parentClose: Promise<void> | null = null;

    await expect(consolidatePrivateDirectoryAuthorityWithHookForTest(
      rootAuthority, [child], ["receipts"], async () => {
        parentClose = closePrivateDirectoryAuthority(rootAuthority)
          .then(() => { closeSettled = true; });
        await Promise.resolve();
        expect(closeSettled).toBe(false);
        await expect(rename(child.root, `${child.root}-moved`)).rejects.toMatchObject({
          code: expect.stringMatching(/EPERM|EBUSY|EACCES/u),
        });
      },
    )).rejects.toThrow("parent authority was lost");
    await parentClose;
    expect(closeSettled).toBe(true);
    expect(validatePrivateDirectoryAuthority(rootAuthority)).toBe(false);
    expect(validatePrivateDirectoryAuthority(child)).toBe(false);
  });

  it.runIf(process.platform === "win32")("closes partially opened controlled guardians when a later leaf fails final ACL verification", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const first = await prepareNewLeaf(rootAuthority.root, "receipts");
    const second = await prepareNewLeaf(rootAuthority.root, "objects");
    const sid = await currentWindowsSid();
    const canonical = `O:${sid}D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
    const widened = `${canonical}(A;OICI;FR;;;WD)`;

    await expect(consolidatePrivateDirectoryAuthorityWithHookForTest(
      rootAuthority, [first, second], ["receipts", "objects"],
      () => setWindowsSddl(second.root, "directory", widened),
    )).rejects.toThrow("DACL");
    expect(validatePrivateDirectoryAuthority(first)).toBe(false);
    expect(validatePrivateDirectoryAuthority(second)).toBe(false);
    expect(validatePrivateDirectoryAuthority(rootAuthority)).toBe(true);

    await setWindowsSddl(second.root, "directory", canonical);
    await closePrivateDirectoryAuthority(rootAuthority);
    const moved = `${first.root}-moved`;
    await expect(rename(first.root, moved)).resolves.toBeUndefined();
    await rename(moved, first.root);
  });

  it.runIf(process.platform === "win32")("supports independent consolidated close, restart, and parent-loss cascading", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "receipts");
    const consolidated = await consolidatePrivateDirectoryAuthority(
      rootAuthority, [child], ["receipts"],
    );
    authorities.push(consolidated);

    await closePrivateDirectoryAuthority(consolidated);
    expect(validatePrivateDirectoryAuthority(consolidated)).toBe(false);
    expect(validatePrivateDirectoryAuthority(rootAuthority)).toBe(true);
    await closePrivateDirectoryAuthority(rootAuthority);
    const restarted = await verifyExisting(rootAuthority.root, ["receipts"]);
    expect(validatePrivateDirectoryAuthority(restarted)).toBe(true);
  });

  it.runIf(process.platform === "win32")("cascades parent guardian loss into a consolidated proof", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "receipts");
    const consolidated = await consolidatePrivateDirectoryAuthority(
      rootAuthority, [child], ["receipts"],
    );
    authorities.push(consolidated);
    killPrivateDirectoryAuthorityGuardianForTest(rootAuthority);
    expect(validatePrivateDirectoryAuthority(rootAuthority)).toBe(false);
    expect(validatePrivateDirectoryAuthority(consolidated)).toBe(false);
    await expect(listControlledEntries(consolidated, "receipts")).rejects.toThrow("authority");
    const moved = `${child.root}-moved`;
    let renamed = false;
    for (let attempt = 0; attempt < 100 && !renamed; attempt += 1) {
      try {
        await rename(child.root, moved);
        renamed = true;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) ||
            !/EPERM|EBUSY|EACCES/u.test(String(error.code))) throw error;
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      }
    }
    expect(renamed).toBe(true);
    await rename(moved, child.root);
  });

  it.runIf(process.platform === "win32")("rejects wrong-parent and hostile handoff inputs without executing traps", async () => {
    const parent = await parentRoot();
    const firstRoot = await prepareNewLeaf(parent, "first");
    const secondRoot = await prepareNewLeaf(parent, "second");
    const child = await prepareNewLeaf(firstRoot.root, "receipts");
    await expect(consolidatePrivateDirectoryAuthority(secondRoot, [child], ["receipts"]))
      .rejects.toThrow("direct leaf");
    expect(validatePrivateDirectoryAuthority(child)).toBe(true);

    let traps = 0;
    const hostile = new Proxy([], { get() { traps += 1; throw new Error("trap"); } });
    await expect(consolidatePrivateDirectoryAuthority(firstRoot, hostile, ["receipts"]))
      .rejects.toThrow("child authorities");
    await expect(consolidatePrivateDirectoryAuthority(firstRoot, [child], hostile))
      .rejects.toThrow();
    const getterChildren: unknown[] = [];
    Object.defineProperty(getterChildren, "0", {
      configurable: true, enumerable: true, get() { traps += 1; throw new Error("getter"); },
    });
    Object.defineProperty(getterChildren, "length", { value: 1 });
    const getterLeaves: unknown[] = [];
    Object.defineProperty(getterLeaves, "0", {
      configurable: true, enumerable: true, get() { traps += 1; throw new Error("getter"); },
    });
    Object.defineProperty(getterLeaves, "length", { value: 1 });
    await expect(consolidatePrivateDirectoryAuthority(firstRoot, getterChildren, ["receipts"]))
      .rejects.toThrow("child authorities");
    await expect(consolidatePrivateDirectoryAuthority(firstRoot, [child], getterLeaves))
      .rejects.toThrow("controlled directories");
    expect(traps).toBe(0);
  });

  it("rejects an unregistered sibling instead of signing an incomplete handoff", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "receipts");
    await mkdir(join(rootAuthority.root, "intruder"), { mode: 0o700 });
    await expect(consolidatePrivateDirectoryAuthority(rootAuthority, [child], ["receipts"]))
      .rejects.toThrow("unvalidated entries");
    expect(validatePrivateDirectoryAuthority(rootAuthority)).toBe(true);
    expect(validatePrivateDirectoryAuthority(child)).toBe(false);
  });

  it.runIf(process.platform !== "win32")("consolidates exact POSIX children and preserves parent-dependent lifetime", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const child = await prepareNewLeaf(rootAuthority.root, "receipts");
    const consolidated = await consolidatePrivateDirectoryAuthority(
      rootAuthority, [child], ["receipts"],
    );
    authorities.push(consolidated);
    expect(validatePrivateDirectoryAuthority(child)).toBe(false);
    expect(validatePrivateDirectoryAuthority(consolidated)).toBe(true);
    await closePrivateDirectoryAuthority(rootAuthority);
    expect(validatePrivateDirectoryAuthority(consolidated)).toBe(false);
  });

  it.runIf(process.platform !== "win32")("rejects a controlled directory path swap during enumeration", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const childAuthority = await prepareNewLeaf(rootAuthority.root, "receipts");
    await writeFile(join(childAuthority.root, "original.json"), "original");
    const proof = await verifyExisting(rootAuthority.root, ["receipts"]);
    const moved = `${childAuthority.root}-moved`;

    await expect(listControlledEntriesWithHookForTest(proof, "receipts", async () => {
      await rename(childAuthority.root, moved);
      await mkdir(childAuthority.root, { mode: 0o700 });
      await writeFile(join(childAuthority.root, "replacement.json"), "replacement");
    })).rejects.toThrow("identity changed");
    expect(validatePrivateDirectoryAuthority(proof)).toBe(false);
  });

  it.runIf(process.platform === "win32")("fails controlled enumeration after guardian loss", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    await prepareNewLeaf(rootAuthority.root, "receipts");
    const proof = await verifyExisting(rootAuthority.root, ["receipts"]);
    killPrivateDirectoryAuthorityGuardianForTest(proof);
    await expect(listControlledEntries(proof, "receipts")).rejects.toThrow("authority");
  });

  it.runIf(process.platform === "win32")("settles concurrent enumeration and close only once", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const childAuthority = await prepareNewLeaf(rootAuthority.root, "receipts");
    await writeFile(join(childAuthority.root, "ready.json"), "{}");
    const proof = await verifyExisting(rootAuthority.root, ["receipts"]);

    const settled = await Promise.allSettled([
      listControlledEntries(proof, "receipts"),
      closePrivateDirectoryAuthority(proof),
    ]);
    expect(settled[1]).toMatchObject({ status: "fulfilled" });
    expect(validatePrivateDirectoryAuthority(proof)).toBe(false);
    expect(validatePrivateDirectoryAuthority(rootAuthority)).toBe(true);
    expect(validatePrivateDirectoryAuthority(childAuthority)).toBe(true);
  });

  it.runIf(process.platform === "win32")("fails closed when a controlled directory exceeds its entry bound", async () => {
    const parent = await parentRoot();
    const rootAuthority = await prepareNewLeaf(parent, "managed");
    const childAuthority = await prepareNewLeaf(rootAuthority.root, "receipts");
    const proof = await verifyExisting(rootAuthority.root, ["receipts"]);
    const names = Array.from({ length: 4_097 }, (_, index) => `r-${String(index).padStart(4, "0")}.json`);
    for (let offset = 0; offset < names.length; offset += 128) {
      await Promise.all(names.slice(offset, offset + 128)
        .map((name) => writeFile(join(childAuthority.root, name), "")));
    }
    await expect(listControlledEntries(proof, "receipts")).rejects.toThrow();
    expect(validatePrivateDirectoryAuthority(proof)).toBe(false);
  }, 30_000);

  it.runIf(process.platform === "win32")("spike: a native guardian can bind ACL inspection and rename exclusion to one directory handle", async () => {
    const parent = await parentRoot();
    const root = join(parent, "guarded");
    const moved = join(parent, "moved");
    await mkdir(root);
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_GUARDIAN_SCRIPT], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HUNTER_GUARDIAN_PATH: root, HUNTER_GUARDIAN_NATIVE: WINDOWS_GUARDIAN_NATIVE_SOURCE },
    });
    try {
      const proof = JSON.parse(await guardianLine(child)) as { ready: boolean; owner: string; sddl: string };
      expect(proof.ready).toBe(true);
      expect(proof.owner).toMatch(/^S-1-[0-9-]+$/u);
      expect(proof.sddl).toContain("D:");
      await expect(rename(root, moved)).rejects.toMatchObject({ code: expect.stringMatching(/EPERM|EBUSY|EACCES/u) });
    } finally {
      child.stdin?.end("close\n");
      await new Promise<void>((resolve, reject) => {
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`guardian exit ${String(code)}`)));
      });
    }
    await expect(rename(root, moved)).resolves.toBeUndefined();
  });

  it("creates only the exact private leaf without changing its parent and verifies inherited children", async () => {
    const parent = await parentRoot();
    const before = process.platform === "win32" ? await windowsSddl(parent) : null;
    const authority = await prepareNewLeaf(parent, "managed");
    const root = join(parent, "managed");

    expect(authority.root).toBe(root);
    expect(await readdir(parent)).toEqual(["managed"]);
    if (process.platform === "win32") {
      await expect(readFile(authority.marker, "utf8")).rejects.toMatchObject({ code: "EBUSY" });
      expect(await windowsSddl(parent)).toBe(before);
    } else {
      expect(await readFile(authority.marker, "utf8")).toBe("hunter-private-directory-authority-v1\n");
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      expect((await lstat(authority.marker)).mode & 0o777).toBe(0o600);
    }

    const childAuthority = await prepareNewLeaf(root, "attempts");
    const child = childAuthority.root;
    const inheritedGrandchild = join(child, "inherited");
    await mkdir(inheritedGrandchild, { mode: 0o700 });
    if (process.platform === "win32") {
      expect(await windowsSddl(inheritedGrandchild)).toMatch(/\(A;[^;]*ID[^;]*;FA;;;[^)]+\)/u);
    }
    const restarted = await verifyExisting(root, ["attempts"]);
    expect(restarted.controlled_directories).toEqual([child]);
  });

  it("rejects hostile input without executing Proxy traps or getters", async () => {
    let executions = 0;
    const proxy = new Proxy({}, {
      get() { executions += 1; throw new Error("trap"); },
      ownKeys() { executions += 1; throw new Error("trap"); },
    });
    await expect(prepareNewLeaf(proxy as never, "leaf")).rejects.toThrow("invalid private directory parent");
    const getter: unknown[] = [];
    Object.defineProperty(getter, "0", {
      get() { executions += 1; throw new Error("getter"); },
      enumerable: true,
    });
    Object.defineProperty(getter, "length", { value: 1 });
    await expect(verifyExisting("root", getter as never)).rejects.toThrow("invalid controlled directories");
    expect(executions).toBe(0);
  });

  it("purely rejects an existing business root and leaves its content and permissions unchanged", async () => {
    const parent = await parentRoot();
    const root = join(parent, "business");
    await mkdir(root);
    await writeFile(join(root, "keep.txt"), "keep\n");
    const before = process.platform === "win32"
      ? await windowsSddl(root)
      : String((await lstat(root)).mode);
    const entries = await readdir(root);

    await expect(verifyExisting(root, [])).rejects.toThrow();
    expect(await readdir(root)).toEqual(entries);
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("keep\n");
    expect(process.platform === "win32" ? await windowsSddl(root) : String((await lstat(root)).mode))
      .toBe(before);
  });

  it("rejects unvalidated root entries and nested controlled paths", async () => {
    const parent = await parentRoot();
    const proof = await prepareNewLeaf(parent, "managed");
    await closePrivateDirectoryAuthority(proof);
    await mkdir(join(proof.root, "extra"), { mode: 0o700 });
    await expect(verifyExisting(proof.root, [])).rejects.toThrow("unvalidated entries");
    await expect(verifyExisting(proof.root, ["extra/nested"])).rejects.toThrow("direct children");
  });

  it("rejects traversal, links, shared markers, and controlled paths outside the authority", async () => {
    const parent = await parentRoot();
    await expect(prepareNewLeaf(parent, "../escape")).rejects.toThrow("leaf");
    await expect(prepareNewLeaf(parent, "nested/leaf")).rejects.toThrow("leaf");
    await prepareNewLeaf(parent, "managed");
    const root = join(parent, "managed");
    await expect(verifyExisting(root, ["../escape"])).rejects.toThrow("controlled");
    await symlink(join(root, "attempts"), join(root, "linked"), "junction");
    await expect(verifyExisting(root, ["linked"])).rejects.toThrow(/link|reparse|directory/iu);
    await rm(join(root, "linked"));
    await Promise.all(authorities.splice(0).map(closePrivateDirectoryAuthority));
    await link(join(root, ".hunter-private-directory-authority-v1"), join(root, "marker-copy"));
    await expect(verifyExisting(root, [])).rejects.toThrow(/linked|shared/iu);
    await rm(join(root, "marker-copy"));
    await rm(join(root, ".hunter-private-directory-authority-v1"));
    await expect(verifyExisting(root, [])).rejects.toThrow("marker is missing");
  });

  it.runIf(process.platform === "win32")("fails closed for every non-canonical Windows descriptor", async () => {
    const sid = await currentWindowsSid();
    const cases: Array<[string, (root: string, marker: string) => Promise<void>]> = [
      ["missing inheritance flags", async (root) => setWindowsSddl(root, "directory", `O:${sid}G:SYD:P(A;;FA;;;${sid})(A;;FA;;;SY)(A;;FA;;;BA)`) ],
      ["generic extra rights", async (root) => setWindowsSddl(root, "directory", `O:${sid}G:SYD:P(A;OICI;GA;;;${sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`) ],
      ["deny ACE", async (root) => setWindowsSddl(root, "directory", `O:${sid}G:SYD:P(D;OICI;FR;;;WD)(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`) ],
      ["extra trustee", async (root) => setWindowsSddl(root, "directory", `O:${sid}G:SYD:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;WD)`) ],
      ["marker ACL", async (_root, marker) => setWindowsSddl(marker, "file", `O:${sid}G:SYD:P(A;;FA;;;${sid})(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;WD)`) ],
      ["root owner", async (root) => setWindowsSddl(root, "directory", `O:BAG:SYD:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`) ],
    ];
    for (const [name, mutate] of cases) {
      const parent = await parentRoot();
      const authority = await prepareNewLeaf(parent, "managed");
      try {
        await mutate(authority.root, authority.marker);
        await expect(verifyExisting(authority.root, []), name).rejects.toThrow();
      } finally {
        await setWindowsSddl(authority.root, "directory", `O:${sid}G:SYD:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`);
        await setWindowsSddl(authority.marker, "file", `O:${sid}G:SYD:P(A;;FA;;;${sid})(A;;FA;;;SY)(A;;FA;;;BA)`);
      }
    }
  });
});
