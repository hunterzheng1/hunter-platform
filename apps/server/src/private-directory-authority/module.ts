import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { promisify } from "node:util";
import { isProxy, isUint8Array } from "node:util/types";

import type {
  PrivateDirectoryAuthority,
  PrivateDirectoryControlledEntry,
  PublishControlledFileRequest,
  PublishControlledFileResult,
} from "./types.js";

const execFileAsync = promisify(execFile);
const MARKER_NAME = ".hunter-private-directory-authority-v1";
const MARKER_CONTENT = Buffer.from("hunter-private-directory-authority-v1\n", "utf8");
const WINDOWS_FULL_CONTROL = 0x001f01ff;
const WINDOWS_INHERITANCE_FLAGS = 0x03;
const WINDOWS_DACL_PROTECTED = 0x1000;
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const MAX_CONTROLLED_ENTRIES = 4_096;
const MAX_CONTROLLED_ENTRY_NAME_BYTES = 255;
const MAX_CONTROLLED_METADATA_BYTES = 1_048_576;
const MAX_PUBLISH_BYTES = 512 * 1_024 * 1_024;
const MAX_PUBLISH_CHUNK_BYTES = 512 * 1_024;

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface WindowsAce {
  readonly type: number;
  readonly flags: number;
  readonly mask: number;
  readonly sid: string;
  readonly object_flags: number | null;
  readonly object_type: string | null;
  readonly inherited_object_type: string | null;
}

interface WindowsDescriptor {
  readonly owner: string;
  readonly control_flags: number;
  readonly aces: readonly WindowsAce[];
}

interface WindowsEntry {
  readonly name: string;
  readonly attributes: number;
  readonly size: string;
  readonly file_index: string;
}

interface WindowsGuardian {
  readonly role: "root_owner" | "controlled_leaf" | "file";
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: ReadLineInterface;
  readonly iterator: AsyncIterableIterator<string>;
  alive: boolean;
  descriptor: WindowsDescriptor;
  file_index: bigint;
  volume: bigint;
  final_path: string;
  attributes: number;
  links: number;
  content_base64: string | null;
  entries: readonly string[] | null;
  entry_details: readonly WindowsEntry[] | null;
  command_tail: Promise<void>;
  diagnostic: string;
}

interface AuthorityState {
  active: boolean;
  operations: number;
  drained: (() => void) | null;
  close_promise: Promise<void> | null;
  readonly guardians: readonly WindowsGuardian[];
  readonly controlled: readonly {
    readonly path: string;
    readonly identity: Identity;
    readonly guardian: WindowsGuardian | null;
  }[];
  readonly dependencies: readonly object[];
  readonly dependents: Set<object>;
}

const authorityStates = new WeakMap<object, AuthorityState>();
const validAuthorities = new WeakSet<object>();
const guardianByPath = new Map<string, WindowsGuardian>();
const guardianReferences = new WeakMap<WindowsGuardian, { key: string; count: number }>();
const authoritiesByGuardian = new WeakMap<WindowsGuardian, Set<object>>();
const publishTails = new Map<string, Promise<void>>();

function guardianKey(path: string, role: WindowsGuardian["role"]): string {
  const resolved = resolve(path);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return `${role}\0${normalized}`;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identity(metadata: { dev: number | bigint; ino: number | bigint }): Identity {
  return { dev: BigInt(metadata.dev), ino: BigInt(metadata.ino) };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function assertPrimitivePath(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(message);
  }
}

function controlledSnapshot(value: unknown): readonly string[] {
  if (!Array.isArray(value) || isProxy(value)) {
    throw new Error("invalid controlled directories");
  }
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as
      Record<PropertyKey, PropertyDescriptor>;
  } catch {
    throw new Error("invalid controlled directories");
  }
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      lengthDescriptor.value > 1_000 || Reflect.ownKeys(descriptors).length !== lengthDescriptor.value + 1) {
    throw new Error("invalid controlled directories");
  }
  const copy: string[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
      throw new Error("invalid controlled directories");
    }
    copy.push(descriptor.value);
  }
  return Object.freeze(copy);
}

function exactLeaf(leaf: unknown): string {
  assertPrimitivePath(leaf, "invalid private directory leaf");
  if (leaf === "." || leaf === ".." || basename(leaf) !== leaf || isAbsolute(leaf) ||
      leaf.includes("/") || leaf.includes("\\")) {
    throw new Error("invalid private directory leaf");
  }
  return leaf;
}

function exactEntryName(value: unknown): string {
  const name = exactLeaf(value);
  if (name.includes(":")) throw new Error("controlled entry name contains an alternate data stream");
  if (name !== name.normalize("NFC") || Buffer.byteLength(name, "utf8") > MAX_CONTROLLED_ENTRY_NAME_BYTES ||
      Array.from(name).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127 ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff);
      })) {
    throw new Error("controlled entry name is not canonical");
  }
  return name;
}

function freezeControlledEntries(
  entries: readonly PrivateDirectoryControlledEntry[],
): readonly PrivateDirectoryControlledEntry[] {
  if (entries.length > MAX_CONTROLLED_ENTRIES) {
    throw new Error("controlled directory contains too many entries");
  }
  let metadataBytes = 0;
  const caseNames = new Set<string>();
  const result = entries.map((entry) => {
    const name = exactEntryName(entry.name);
    const caseName = name.toLowerCase();
    if (!caseNames.add(caseName)) throw new Error("controlled directory contains case-colliding entries");
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 ||
        !/^[0-9]+$/u.test(entry.identity.device) || !/^[0-9]+$/u.test(entry.identity.file)) {
      throw new Error("controlled entry metadata is invalid");
    }
    metadataBytes += Buffer.byteLength(name, "utf8") + 64;
    if (metadataBytes > MAX_CONTROLLED_METADATA_BYTES) {
      throw new Error("controlled directory metadata is too large");
    }
    return Object.freeze({
      name,
      kind: entry.kind,
      size: entry.size,
      identity: Object.freeze({ ...entry.identity }),
    });
  });
  result.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return Object.freeze(result);
}

function containedPath(root: string, candidate: string): string {
  assertPrimitivePath(candidate, "invalid controlled directories");
  if (isAbsolute(candidate)) throw new Error("controlled directory escapes private root");
  const absolute = resolve(root, candidate);
  const child = relative(root, absolute);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("controlled directory escapes private root");
  }
  if (child.includes(sep)) throw new Error("controlled directories must be direct children");
  return absolute;
}

async function inspectDirectory(path: string): Promise<Identity> {
  const resolved = resolve(path);
  const metadata = await lstat(resolved, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("private directory is linked, reparse-backed, or not a directory");
  }
  if (!samePath(await realpath(resolved), resolved)) {
    throw new Error("private directory resolves through a link or reparse point");
  }
  return identity(metadata);
}

async function inspectMarker(path: string): Promise<Identity> {
  const resolved = resolve(path);
  const metadata = await lstat(resolved, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n ||
      metadata.size !== BigInt(MARKER_CONTENT.byteLength)) {
    throw new Error("private directory marker is linked, shared, or invalid");
  }
  if (!samePath(await realpath(resolved), resolved)) {
    throw new Error("private directory marker resolves through a link or reparse point");
  }
  return identity(metadata);
}

async function currentWindowsSid(): Promise<string> {
  const result = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value",
  ], { windowsHide: true, encoding: "utf8" });
  const sid = result.stdout.trim();
  if (!/^S-1-[0-9-]+$/u.test(sid)) throw new Error("unable to resolve Windows service identity");
  return sid;
}

const WINDOWS_GUARDIAN_NATIVE = String.raw`
using System;
using System.ComponentModel;
using System.Security.AccessControl;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class HunterPrivateDirectoryGuardian {
  [StructLayout(LayoutKind.Sequential)] public struct ByHandleInfo {
    public uint attributes;
    public uint creationLow; public uint creationHigh; public uint accessLow; public uint accessHigh;
    public uint writeLow; public uint writeHigh;
    public uint volume; public uint sizeHigh; public uint sizeLow; public uint links;
    public uint indexHigh; public uint indexLow;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool delete; }
  public sealed class EntryInfo { public string name=""; public uint attributes; public long size; public ulong file_index; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetFileInformationByHandle(SafeFileHandle handle,out ByHandleInfo info);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,ref Disposition info,uint size);
  [DllImport("kernel32.dll",SetLastError=true,EntryPoint="SetFileInformationByHandle")] static extern bool SetFileInformationByHandleRaw(SafeFileHandle handle,int kind,IntPtr info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetFilePointerEx(SafeFileHandle handle,long distance,out long position,uint method);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool ReadFile(SafeFileHandle handle,byte[] bytes,uint count,out uint read,IntPtr overlapped);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool FlushFileBuffers(SafeFileHandle handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int kind,byte[] bytes,uint count);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,System.Text.StringBuilder path,uint length,uint flags);
  [DllImport("advapi32.dll",SetLastError=true)] public static extern uint GetSecurityInfo(IntPtr handle,int kind,uint information,out IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetKernelObjectSecurity(SafeFileHandle handle,uint information,byte[] descriptor);
  [DllImport("advapi32.dll")] public static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);
  public static SafeFileHandle Open(string path,string role,bool file,bool writable) {
    var controlled=role=="controlled_leaf";
    uint access=0x00030000u | (file ? 0x80000000u : controlled ? 0x80000003u : 0x00000001u) | (writable ? 0x000c0000u : 0u);
    uint share=controlled ? 7u : 0u;
    uint flags=file ? 0x00200000u : 0x02200000u;
    return CreateFileW(path,access,share,IntPtr.Zero,3u,flags,IntPtr.Zero);
  }
  public static SafeFileHandle OpenPublishTemp(string path) {
    return CreateFileW(path,0xC00F0000u,0u,IntPtr.Zero,1u,0x80200000u,IntPtr.Zero);
  }
  public static int RenameNoReplace(SafeFileHandle handle,string finalPath) {
    var nativePath=finalPath.StartsWith(@"\\") ? @"\??\UNC\"+finalPath.Substring(2) : @"\??\"+finalPath;
    var name=System.Text.Encoding.Unicode.GetBytes(nativePath);
    var nameOffset=IntPtr.Size==8 ? 20 : 12;
    var structureSize=nameOffset+name.Length+2;
    var memory=Marshal.AllocHGlobal(structureSize);
    try {
      for(var i=0;i<structureSize;i++) Marshal.WriteByte(memory,i,0);
      Marshal.WriteInt32(memory,0,0);
      Marshal.WriteIntPtr(memory,IntPtr.Size==8 ? 8 : 4,IntPtr.Zero);
      Marshal.WriteInt32(memory,IntPtr.Size==8 ? 16 : 8,name.Length);
      Marshal.Copy(name,0,IntPtr.Add(memory,nameOffset),name.Length);
      if(SetFileInformationByHandleRaw(handle,3,memory,(uint)structureSize)) return 0;
      return Marshal.GetLastWin32Error();
    } finally { Marshal.FreeHGlobal(memory); }
  }
  public static void SetSddl(SafeFileHandle handle,string sddl) {
    var raw=new RawSecurityDescriptor(sddl);
    var bytes=new byte[raw.BinaryLength];
    raw.GetBinaryForm(bytes,0);
    if(!SetKernelObjectSecurity(handle,0x80000005u,bytes)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static EntryInfo[] EntryDetails(SafeFileHandle handle) {
    var entries=new System.Collections.Generic.List<EntryInfo>();
    var restart=true;
    while(true) {
      var bytes=new byte[65536];
      if(!GetFileInformationByHandleEx(handle,restart ? 11 : 10,bytes,(uint)bytes.Length)) {
        var code=Marshal.GetLastWin32Error();
        if(code==18) break;
        throw new Win32Exception(code);
      }
      restart=false;
      var offset=0;
      while(true) {
        var nameLength=BitConverter.ToUInt32(bytes,offset+60);
        var name=System.Text.Encoding.Unicode.GetString(bytes,offset+104,(int)nameLength);
        if(name!="." && name!="..") entries.Add(new EntryInfo { name=name, attributes=BitConverter.ToUInt32(bytes,offset+56), size=BitConverter.ToInt64(bytes,offset+40), file_index=BitConverter.ToUInt64(bytes,offset+96) });
        if(entries.Count>4096) return entries.ToArray();
        var next=BitConverter.ToUInt32(bytes,offset);
        if(next==0) break;
        offset+=(int)next;
      }
    }
    return entries.ToArray();
  }
}`;

const WINDOWS_GUARDIAN_SCRIPT = String.raw`
Add-Type -TypeDefinition $env:HUNTER_PRIVATE_NATIVE
$isFile=$env:HUNTER_PRIVATE_KIND -eq 'file'
$writable=$env:HUNTER_PRIVATE_WRITABLE -eq '1'
$role=$env:HUNTER_PRIVATE_ROLE
$handle=[HunterPrivateDirectoryGuardian]::Open($env:HUNTER_PRIVATE_PATH,$role,$isFile,$writable)
if($handle.IsInvalid){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
$publishOwnerSid=([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$publishFileSddl='O:'+$publishOwnerSid+'D:P(A;;FA;;;'+$publishOwnerSid+')(A;;FA;;;SY)(A;;FA;;;BA)'
function Describe {
  $owner=[IntPtr]::Zero;$descriptor=[IntPtr]::Zero
  $status=[HunterPrivateDirectoryGuardian]::GetSecurityInfo($handle.DangerousGetHandle(),1,5,[ref]$owner,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[ref]$descriptor)
  if($status -ne 0){throw [ComponentModel.Win32Exception]::new([int]$status)}
  try {
    $length=[HunterPrivateDirectoryGuardian]::GetSecurityDescriptorLength($descriptor)
    $bytes=New-Object byte[] $length
    [Runtime.InteropServices.Marshal]::Copy($descriptor,$bytes,0,$length)
    $raw=New-Object System.Security.AccessControl.RawSecurityDescriptor($bytes,0)
    $aces=@($raw.DiscretionaryAcl | ForEach-Object {
  $objectFlags=$null;$objectType=$null;$inheritedObjectType=$null
  if($_ -is [System.Security.AccessControl.ObjectAce]){$objectFlags=[int]$_.ObjectAceFlags;$objectType=$_.ObjectAceType.ToString();$inheritedObjectType=$_.InheritedObjectAceType.ToString()}
  [pscustomobject]@{type=[int]$_.AceType;flags=[int]$_.AceFlags;mask=[int]$_.AccessMask;sid=$_.SecurityIdentifier.Value;object_flags=$objectFlags;object_type=$objectType;inherited_object_type=$inheritedObjectType}
    })
    $info=New-Object HunterPrivateDirectoryGuardian+ByHandleInfo
    if(-not [HunterPrivateDirectoryGuardian]::GetFileInformationByHandle($handle,[ref]$info)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
    $builder=New-Object Text.StringBuilder 32768
    if([HunterPrivateDirectoryGuardian]::GetFinalPathNameByHandleW($handle,$builder,32768,0) -eq 0){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
    $index=([uint64]$info.indexHigh -shl 32) -bor [uint64]$info.indexLow
    $content=$null
    if($isFile){$position=0L;if(-not [HunterPrivateDirectoryGuardian]::SetFilePointerEx($handle,0,[ref]$position,0)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())};$buffer=New-Object byte[] 4096;$count=0;if(-not [HunterPrivateDirectoryGuardian]::ReadFile($handle,$buffer,$buffer.Length,[ref]$count,[IntPtr]::Zero)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())};$content=[Convert]::ToBase64String($buffer,0,$count)}
    $entries=$null
    $entryDetails=$null
    if(-not $isFile){$entryDetails=@([HunterPrivateDirectoryGuardian]::EntryDetails($handle) | ForEach-Object {[pscustomobject]@{name=$_.name;attributes=[uint32]$_.attributes;size=$_.size.ToString();file_index=$_.file_index.ToString()}});$entries=@($entryDetails | ForEach-Object {$_.name})}
    [pscustomobject]@{owner=$raw.Owner.Value;control_flags=[int]$raw.ControlFlags;aces=$aces;file_index=$index.ToString();volume=([uint64]$info.volume).ToString();final_path=$builder.ToString();attributes=[uint32]$info.attributes;links=[uint32]$info.links;content_base64=$content;entries=$entries;entry_details=$entryDetails}|ConvertTo-Json -Compress -Depth 5
    [Console]::Out.Flush()
  } finally {if($descriptor -ne [IntPtr]::Zero){[void][HunterPrivateDirectoryGuardian]::LocalFree($descriptor)}}
}
$publishStream=$null;$publishHash=$null;$publishTemp=$null;$publishFinal=$null;$publishExpectedHash=$null;$publishExpectedBytes=0L;$publishCount=0L;$publishFault=$null
$publishVolume=0L;$publishIndex=0L
function Reset-Publish {
  if($null -ne $publishHash){$publishHash.Dispose();$publishHash=$null}
  if($null -ne $publishStream){$publishStream.Dispose();$publishStream=$null}
  if($null -ne $publishTemp){try{[IO.File]::Delete($publishTemp)}catch{};$publishTemp=$null}
  $script:publishStream=$null;$script:publishHash=$null;$script:publishTemp=$null
  $script:publishFinal=$null;$script:publishExpectedHash=$null;$script:publishExpectedBytes=0L;$script:publishCount=0L;$script:publishFault=$null
  $script:publishVolume=0L;$script:publishIndex=0L
}
function Hash-Stream($stream) {
  $stream.Position=0
  $hasher=[Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
  try {$buffer=New-Object byte[] 524288;while(($read=$stream.Read($buffer,0,$buffer.Length)) -gt 0){$hasher.AppendData($buffer,0,$read)};return 'sha256:'+([BitConverter]::ToString($hasher.GetHashAndReset()).Replace('-','').ToLowerInvariant())} finally {$hasher.Dispose()}
}
function Assert-PublishFile($stream,$expectedPath) {
  $info=New-Object HunterPrivateDirectoryGuardian+ByHandleInfo
  if(-not [HunterPrivateDirectoryGuardian]::GetFileInformationByHandle($stream.SafeFileHandle,[ref]$info)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
  if(($info.attributes -band 0x410) -ne 0 -or $info.links -ne 1){throw 'published file is linked or reparse-backed'}
  $builder=New-Object Text.StringBuilder 32768
  if([HunterPrivateDirectoryGuardian]::GetFinalPathNameByHandleW($stream.SafeFileHandle,$builder,32768,0) -eq 0){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
  $actual=$builder.ToString();if($actual.StartsWith('\\?\UNC\')){$actual='\\'+$actual.Substring(8)}elseif($actual.StartsWith('\\?\')){$actual=$actual.Substring(4)}
  if(-not [string]::Equals([IO.Path]::GetFullPath($actual),[IO.Path]::GetFullPath($expectedPath),[StringComparison]::OrdinalIgnoreCase)){throw 'published file handle identity is not the final path'}
  $owner=[IntPtr]::Zero;$descriptor=[IntPtr]::Zero
  $status=[HunterPrivateDirectoryGuardian]::GetSecurityInfo($stream.SafeFileHandle.DangerousGetHandle(),1,5,[ref]$owner,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[ref]$descriptor)
  if($status -ne 0){throw [ComponentModel.Win32Exception]::new([int]$status)}
  try{$length=[HunterPrivateDirectoryGuardian]::GetSecurityDescriptorLength($descriptor);$bytes=New-Object byte[] $length;[Runtime.InteropServices.Marshal]::Copy($descriptor,$bytes,0,$length);$raw=New-Object System.Security.AccessControl.RawSecurityDescriptor($bytes,0);$actualSddl=$raw.GetSddlForm([System.Security.AccessControl.AccessControlSections]6);$expectedSddl=(New-Object System.Security.AccessControl.RawSecurityDescriptor($publishFileSddl)).GetSddlForm([System.Security.AccessControl.AccessControlSections]6);if($actualSddl -ne $expectedSddl){throw 'published file ACL is not canonical'}}finally{if($descriptor -ne [IntPtr]::Zero){[void][HunterPrivateDirectoryGuardian]::LocalFree($descriptor)}}
}
try {
  Describe
  while(($command=[Console]::In.ReadLine()) -ne $null) {
    if($command -eq 'inspect'){Describe;continue}
    if($command -eq 'flush-directory'){if($role -ne 'controlled_leaf'){throw 'invalid guardian role'};if(-not [HunterPrivateDirectoryGuardian]::FlushFileBuffers($handle)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())};'{"ok":true}';[Console]::Out.Flush();continue}
    if($command.StartsWith('publish-start ')){
      if($role -ne 'controlled_leaf' -or $null -ne $publishStream){throw 'invalid publish state'}
      $request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($command.Substring(14)))|ConvertFrom-Json
      $publishFinal=[IO.Path]::Combine($env:HUNTER_PRIVATE_PATH,[string]$request.final_name)
      $publishExpectedHash=[string]$request.expected_sha256;$publishExpectedBytes=[int64]$request.expected_bytes
      $publishFault=[string]$request.fault
      $publishTemp=[IO.Path]::Combine($env:HUNTER_PRIVATE_PATH,([string]$request.temp_prefix)+[Guid]::NewGuid().ToString('N')+'.tmp')
      $publishHandle=[HunterPrivateDirectoryGuardian]::OpenPublishTemp($publishTemp);if($publishHandle.IsInvalid){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
      $publishStream=[IO.FileStream]::new($publishHandle,[IO.FileAccess]::ReadWrite,524288,$false)
      [HunterPrivateDirectoryGuardian]::SetSddl($publishStream.SafeFileHandle,$publishFileSddl)
      $publishInfo=New-Object HunterPrivateDirectoryGuardian+ByHandleInfo;if(-not [HunterPrivateDirectoryGuardian]::GetFileInformationByHandle($publishStream.SafeFileHandle,[ref]$publishInfo)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())};$publishVolume=[uint64]$publishInfo.volume;$publishIndex=([uint64]$publishInfo.indexHigh -shl 32) -bor [uint64]$publishInfo.indexLow
      $publishHash=[Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
      '{"ok":true}';[Console]::Out.Flush();continue
    }
    if($command.StartsWith('publish-chunk ')){
      if($null -eq $publishStream){throw 'invalid publish state'}
      $bytes=[Convert]::FromBase64String($command.Substring(14));if($bytes.Length -gt 524288 -or $bytes.Length -eq 0){throw 'invalid publish chunk'}
      $publishStream.Write($bytes,0,$bytes.Length);$publishHash.AppendData($bytes);$publishCount+=$bytes.Length
      '{"ok":true}';[Console]::Out.Flush();continue
    }
    if($command -eq 'publish-abort'){Reset-Publish;'{"ok":true}';[Console]::Out.Flush();continue}
    if($command -eq 'publish-finish'){
      if($null -eq $publishStream){throw 'invalid publish state'}
      $streamed='sha256:'+([BitConverter]::ToString($publishHash.GetHashAndReset()).Replace('-','').ToLowerInvariant())
      if($publishCount -ne $publishExpectedBytes -or $streamed -ne $publishExpectedHash){throw 'publish expectation mismatch'}
      $publishStream.Flush($true);$verified=Hash-Stream $publishStream
      if($verified -ne $publishExpectedHash){throw 'publish same-handle verification failed'}
      if($publishFault -eq 'crash_before_rename'){[Environment]::Exit(90)}
      $code=[HunterPrivateDirectoryGuardian]::RenameNoReplace($publishStream.SafeFileHandle,$publishFinal)
      if($code -eq 0){
        $publishStream.Flush($true);$publishStream.Dispose();$publishStream=$null;$publishTemp=$null
        $final=[IO.FileStream]::new($publishFinal,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete,524288,[IO.FileOptions]::WriteThrough)
        try{Assert-PublishFile $final $publishFinal;$finalInfo=New-Object HunterPrivateDirectoryGuardian+ByHandleInfo;if(-not [HunterPrivateDirectoryGuardian]::GetFileInformationByHandle($final.SafeFileHandle,[ref]$finalInfo)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())};$finalIndex=([uint64]$finalInfo.indexHigh -shl 32) -bor [uint64]$finalInfo.indexLow;if([uint64]$finalInfo.volume -ne $publishVolume -or $finalIndex -ne $publishIndex){throw 'published file identity changed after rename'};$finalHash=Hash-Stream $final;if($finalHash -ne $publishExpectedHash -or $final.Length -ne $publishExpectedBytes){throw 'published file verification failed'};$final.Flush($true)}finally{$final.Dispose()}
        if(-not [HunterPrivateDirectoryGuardian]::FlushFileBuffers($handle)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
        if($publishFault -eq 'crash_after_rename'){[Environment]::Exit(91)}
        if($publishFault -eq 'ambiguous_after_rename'){'{"ambiguous":true}';[Console]::Out.Flush();Reset-Publish;continue}
        [pscustomobject]@{outcome='published';sha256=$finalHash;bytes=$publishExpectedBytes}|ConvertTo-Json -Compress;[Console]::Out.Flush();Reset-Publish;continue
      }
      if($code -ne 80 -and $code -ne 183){throw "publish rename failed code $code"}
      $publishStream.Dispose();$publishStream=$null;[IO.File]::Delete($publishTemp);$publishTemp=$null
      $existing=[IO.FileStream]::new($publishFinal,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
      try{Assert-PublishFile $existing $publishFinal;$existingHash=Hash-Stream $existing;$existingBytes=$existing.Length}finally{$existing.Dispose()}
      [pscustomobject]@{outcome=if($existingHash -eq $publishExpectedHash -and $existingBytes -eq $publishExpectedBytes){'existing_identical'}else{'existing_different'};sha256=$existingHash;bytes=$existingBytes}|ConvertTo-Json -Compress;[Console]::Out.Flush();Reset-Publish;continue
    }
    if($command.StartsWith('set ')){if(-not $writable){throw 'guardian is read-only'};$sddl=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($command.Substring(4)));[HunterPrivateDirectoryGuardian]::SetSddl($handle,$sddl);Describe;continue}
    if($command -eq 'delete'){$disposition=New-Object HunterPrivateDirectoryGuardian+Disposition;$disposition.delete=$true;if(-not [HunterPrivateDirectoryGuardian]::SetFileInformationByHandle($handle,4,[ref]$disposition,4)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())};break}
    if($command -eq 'close'){break}
    throw 'invalid guardian command'
  }
} finally {Reset-Publish;$handle.Dispose()}
`;

function parseGuardianDescriptor(line: string): WindowsDescriptor & {
  file_index: string; volume: string; final_path: string; attributes: number;
  links: number; content_base64: string | null;
  entries: readonly string[] | null;
  entry_details: readonly WindowsEntry[] | null;
} {
  const parsed = JSON.parse(line) as unknown;
  if (parsed === null || typeof parsed !== "object") throw new Error("invalid Windows security descriptor");
  const value = parsed as Partial<WindowsDescriptor> & Partial<{
    file_index: string; volume: string; final_path: string; attributes: number;
    links: number; content_base64: string | null;
    entries: readonly string[] | null;
    entry_details: readonly WindowsEntry[] | null;
  }>;
  if (typeof value.owner !== "string" || typeof value.control_flags !== "number" ||
      !Array.isArray(value.aces) || typeof value.file_index !== "string" ||
      typeof value.volume !== "string" || typeof value.final_path !== "string" ||
      typeof value.attributes !== "number" || typeof value.links !== "number" ||
      !(typeof value.content_base64 === "string" || value.content_base64 === null) ||
      !(value.entries === null || (Array.isArray(value.entries) &&
        value.entries.every((entry) => typeof entry === "string"))) ||
      !(value.entry_details === null || (Array.isArray(value.entry_details) &&
        value.entry_details.every((entry) => entry !== null && typeof entry === "object" &&
          typeof (entry as Partial<WindowsEntry>).name === "string" &&
          typeof (entry as Partial<WindowsEntry>).attributes === "number" &&
          typeof (entry as Partial<WindowsEntry>).size === "string" &&
          typeof (entry as Partial<WindowsEntry>).file_index === "string")))) {
    throw new Error("invalid Windows security descriptor");
  }
  return value as WindowsDescriptor & {
    file_index: string; volume: string; final_path: string; attributes: number;
    links: number; content_base64: string | null;
    entries: readonly string[] | null;
    entry_details: readonly WindowsEntry[] | null;
  };
}

async function nextGuardianLine(guardian: Pick<WindowsGuardian, "iterator" | "alive" | "diagnostic">): Promise<string> {
  const next = await guardian.iterator.next();
  if (next.done) guardian.alive = false;
  if (next.done || !guardian.alive) throw new Error(`private directory guardian exited${
    guardian.diagnostic.trim() === "" ? "" : `: ${guardian.diagnostic.trim()}`}`);
  return next.value;
}

async function withGuardianCommand<T>(guardian: WindowsGuardian, operation: () => Promise<T>): Promise<T> {
  const predecessor = guardian.command_tail;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  guardian.command_tail = predecessor.then(() => gate);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function startWindowsGuardian(
  path: string,
  kind: "directory" | "file",
  writable = false,
  role: WindowsGuardian["role"] = kind === "file" ? "file" : "root_owner",
): Promise<WindowsGuardian> {
  const key = guardianKey(path, role);
  const held = guardianByPath.get(key);
  if (held !== undefined && held.alive) {
    const reference = guardianReferences.get(held);
    if (reference === undefined) throw new Error("private directory guardian registry is inconsistent");
    reference.count += 1;
    await reinspectWindowsGuardian(held);
    return held;
  }
  guardianByPath.delete(key);
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_GUARDIAN_SCRIPT], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HUNTER_PRIVATE_PATH: path,
      HUNTER_PRIVATE_KIND: kind,
      HUNTER_PRIVATE_ROLE: role,
      HUNTER_PRIVATE_WRITABLE: writable ? "1" : "0",
      HUNTER_PRIVATE_NATIVE: WINDOWS_GUARDIAN_NATIVE,
    },
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stdin.on("error", () => { /* guardian exit is observed through the authority state */ });
  let diagnostic = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (diagnostic.length < 4_096) diagnostic += chunk.slice(0, 4_096 - diagnostic.length);
    guardian.diagnostic = diagnostic;
  });
  const guardian: WindowsGuardian = {
    child, lines, iterator: lines[Symbol.asyncIterator](), alive: true, role,
    descriptor: { owner: "", control_flags: 0, aces: [] }, file_index: 0n,
    volume: 0n, final_path: "", attributes: 0, links: 0, content_base64: null, entries: null,
    entry_details: null, command_tail: Promise.resolve(), diagnostic: "",
  };
  child.once("exit", () => {
    guardian.alive = false;
    for (const proof of authoritiesByGuardian.get(guardian) ?? []) {
      const state = authorityStates.get(proof);
      if (state !== undefined) void settleAuthority(proof, state).catch(() => undefined);
    }
  });
  try {
    const value = parseGuardianDescriptor(await nextGuardianLine(guardian));
    guardian.descriptor = value;
    Object.assign(guardian, {
      file_index: BigInt(value.file_index), volume: BigInt(value.volume), final_path: value.final_path,
      attributes: value.attributes, links: value.links, content_base64: value.content_base64,
      entries: value.entries, entry_details: value.entry_details,
    });
    guardianByPath.set(key, guardian);
    guardianReferences.set(guardian, { key, count: 1 });
    return guardian;
  } catch (error) {
    child.kill();
    throw new Error(`private directory guardian failed to acquire its handle${diagnostic.trim() === "" ? "" : `: ${diagnostic.trim()}`}`, { cause: error });
  }
}

async function reinspectWindowsGuardian(guardian: WindowsGuardian): Promise<WindowsDescriptor> {
  return withGuardianCommand(guardian, async () => {
    guardian.child.stdin.write("inspect\n");
    const value = parseGuardianDescriptor(await nextGuardianLine(guardian));
    guardian.descriptor = value;
    Object.assign(guardian, {
      file_index: BigInt(value.file_index), volume: BigInt(value.volume), final_path: value.final_path,
      attributes: value.attributes, links: value.links, content_base64: value.content_base64,
      entries: value.entries, entry_details: value.entry_details,
    });
    return value;
  });
}

async function setWindowsGuardianAcl(
  guardian: WindowsGuardian,
  kind: "directory" | "file",
  ownerSid: string,
): Promise<WindowsDescriptor> {
  return withGuardianCommand(guardian, async () => {
    const flags = kind === "directory" ? "OICI" : "";
    const sddl = `O:${ownerSid}D:P(A;${flags};FA;;;${ownerSid})(A;${flags};FA;;;SY)(A;${flags};FA;;;BA)`;
    guardian.child.stdin.write(`set ${Buffer.from(sddl, "utf8").toString("base64")}\n`);
    const value = parseGuardianDescriptor(await nextGuardianLine(guardian));
    guardian.descriptor = value;
    Object.assign(guardian, {
      file_index: BigInt(value.file_index), volume: BigInt(value.volume), final_path: value.final_path,
      attributes: value.attributes, links: value.links, content_base64: value.content_base64,
      entries: value.entries, entry_details: value.entry_details,
    });
    return value;
  });
}

async function closeWindowsGuardian(guardian: WindowsGuardian): Promise<void> {
  const reference = guardianReferences.get(guardian);
  if (reference !== undefined && reference.count > 1) {
    reference.count -= 1;
    return;
  }
  if (reference !== undefined) guardianByPath.delete(reference.key);
  await withGuardianCommand(guardian, async () => {
    if (!guardian.alive || guardian.child.killed || guardian.child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => guardian.child.once("exit", () => resolve()));
    guardian.child.stdin.end("close\n");
    await exited;
    guardian.lines.close();
  });
}

async function deleteWithWindowsGuardian(guardian: WindowsGuardian): Promise<void> {
  const reference = guardianReferences.get(guardian);
  if (reference !== undefined) guardianByPath.delete(reference.key);
  await withGuardianCommand(guardian, async () => {
    if (!guardian.alive) return;
    const exited = new Promise<void>((resolve) => guardian.child.once("exit", () => resolve()));
    guardian.child.stdin.end("delete\n");
    await exited;
    guardian.lines.close();
  });
}

function assertCanonicalWindowsDescriptor(
  descriptor: WindowsDescriptor,
  ownerSid: string,
  kind: "root" | "controlled" | "file",
): void {
  if (descriptor.owner !== ownerSid) throw new Error("private path owner is not the service identity");
  const protectedDacl = (descriptor.control_flags & WINDOWS_DACL_PROTECTED) !== 0;
  if (!protectedDacl) {
    throw new Error("private path DACL protection is not canonical");
  }
  if (descriptor.aces.length !== 3) throw new Error("private path DACL has extra or missing ACEs");
  const expectedFlags = kind === "file" ? 0 : WINDOWS_INHERITANCE_FLAGS;
  const expectedSids = new Set([ownerSid, SYSTEM_SID, ADMINISTRATORS_SID]);
  for (const ace of descriptor.aces) {
    if (ace.type !== 0 || ace.flags !== expectedFlags || ace.mask !== WINDOWS_FULL_CONTROL ||
        ace.object_flags !== null || ace.object_type !== null || ace.inherited_object_type !== null ||
        !expectedSids.delete(ace.sid)) {
      throw new Error("private path DACL is not canonical");
    }
  }
  if (expectedSids.size !== 0) throw new Error("private path DACL has an invalid trustee set");
}

async function assertPosixDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if ((metadata.mode & 0o777) !== 0o700 ||
      (typeof process.geteuid === "function" && metadata.uid !== process.geteuid())) {
    throw new Error("private directory permissions or owner are not canonical");
  }
}

async function assertPosixMarker(path: string): Promise<void> {
  const metadata = await lstat(path);
  if ((metadata.mode & 0o777) !== 0o600 ||
      (typeof process.geteuid === "function" && metadata.uid !== process.geteuid())) {
    throw new Error("private directory marker permissions or owner are not canonical");
  }
}

async function verifyDirectoryStable(path: string, expected: Identity): Promise<void> {
  const after = await inspectDirectory(path);
  if (!sameIdentity(expected, after)) throw new Error("private directory identity changed during verification");
}

function windowsFinalPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

function assertGuardianBinds(guardian: WindowsGuardian, path: string, expected: Identity): void {
  if (!samePath(resolve(windowsFinalPath(guardian.final_path)), resolve(path)) ||
      (guardian.attributes & 0x400) !== 0 || guardian.volume !== expected.dev ||
      guardian.file_index !== expected.ino) {
    throw new Error("private directory guardian acquired a different or reparse-backed object");
  }
}

function assertGuardianMarker(guardian: WindowsGuardian): void {
  if ((guardian.attributes & 0x10) !== 0 || guardian.links !== 1 ||
      guardian.content_base64 === null ||
      !Buffer.from(guardian.content_base64, "base64").equals(MARKER_CONTENT)) {
    throw new Error("private directory marker is linked, shared, or invalid");
  }
}

function guardianEntries(guardian: WindowsGuardian): readonly string[] {
  if (guardian.entries === null) throw new Error("private directory guardian did not enumerate a directory");
  return [...guardian.entries];
}

function assertExactRootEntries(entries: readonly string[], controlled: readonly string[]): void {
  const normalize = (name: string): string => process.platform === "win32" ? name.toLowerCase() : name;
  const actual = [...entries].map(normalize).sort();
  const expected = [MARKER_NAME, ...controlled.map((path) => basename(path))].map(normalize).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("private directory contains unvalidated entries");
  }
}

function authority(
  root: string,
  controlled: readonly string[],
  guardians: readonly WindowsGuardian[] = [],
  controlledState: AuthorityState["controlled"] = [],
  dependencies: readonly object[] = [],
): PrivateDirectoryAuthority {
  const proof = Object.freeze({
    root,
    marker: join(root, MARKER_NAME),
    controlled_directories: Object.freeze([...controlled]),
  }) as PrivateDirectoryAuthority;
  authorityStates.set(proof, {
    active: true, operations: 0, drained: null, close_promise: null,
    guardians: Object.freeze([...guardians]),
    controlled: Object.freeze([...controlledState]),
    dependencies: Object.freeze([...dependencies]),
    dependents: new Set<object>(),
  });
  for (const guardian of guardians) {
    let proofs = authoritiesByGuardian.get(guardian);
    if (proofs === undefined) {
      proofs = new Set<object>();
      authoritiesByGuardian.set(guardian, proofs);
    }
    proofs.add(proof);
  }
  for (const dependency of dependencies) authorityStates.get(dependency)?.dependents.add(proof);
  validAuthorities.add(proof);
  return proof;
}

/** False for forged, explicitly closed, or guardian-lost proofs. */
export function validatePrivateDirectoryAuthority(value: unknown): value is PrivateDirectoryAuthority {
  if (value === null || typeof value !== "object" || isProxy(value)) return false;
  const state = authorityStates.get(value);
  return validAuthorities.has(value) && state !== undefined && state.active && state.guardians.every((guardian) =>
    guardian.alive && !guardian.child.killed && guardian.child.exitCode === null) &&
    state.dependencies.every((dependency) => validatePrivateDirectoryAuthority(dependency));
}

async function listControlledEntriesInternal(
  value: PrivateDirectoryAuthority,
  state: AuthorityState,
  leaf: string,
  afterOpen: (() => Promise<void>) | null = null,
): Promise<readonly PrivateDirectoryControlledEntry[]> {
  const controlled = state.controlled.find((candidate) => basename(candidate.path) === leaf);
  if (controlled === undefined) throw new Error("directory is not controlled by this authority");

  if (controlled.guardian !== null) {
    const guardian = controlled.guardian;
    const descriptor = await reinspectWindowsGuardian(guardian);
    if (!validatePrivateDirectoryAuthority(value) || descriptor !== guardian.descriptor ||
        !samePath(resolve(windowsFinalPath(guardian.final_path)), resolve(controlled.path)) ||
        guardian.volume !== controlled.identity.dev || guardian.file_index !== controlled.identity.ino ||
        (guardian.attributes & 0x410) !== 0x10 || guardian.entry_details === null) {
      throw new Error("controlled directory guardian identity is unavailable");
    }
    return freezeControlledEntries(guardian.entry_details.map((entry) => {
      const reparse = (entry.attributes & 0x400) !== 0;
      const directory = (entry.attributes & 0x10) !== 0;
      if (reparse) throw new Error("controlled entry is reparse-backed");
      const size = Number(BigInt(entry.size));
      return {
        name: entry.name,
        kind: directory ? "directory" as const : "file" as const,
        size,
        identity: { device: guardian.volume.toString(), file: entry.file_index },
      };
    }));
  }

  const handle = await open(
    controlled.path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedIdentity = identity(await handle.stat({ bigint: true }));
    if (!sameIdentity(openedIdentity, controlled.identity)) {
      throw new Error("controlled directory identity changed before enumeration");
    }
    await afterOpen?.();
    if (!sameIdentity(openedIdentity, await inspectDirectory(controlled.path))) {
      throw new Error("controlled directory identity changed before enumeration");
    }
    const entries = await readdir(controlled.path, { withFileTypes: true });
    const result: PrivateDirectoryControlledEntry[] = [];
    for (const entry of entries) {
      const name = exactEntryName(entry.name);
      if (!entry.isFile() && !entry.isDirectory()) throw new Error("controlled entry type is not allowed");
      const path = join(controlled.path, name);
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory()) ||
          !samePath(await realpath(path), path)) {
        throw new Error("controlled entry is linked or has an invalid type");
      }
      result.push({
        name,
        kind: metadata.isDirectory() ? "directory" : "file",
        size: Number(metadata.size),
        identity: { device: metadata.dev.toString(), file: metadata.ino.toString() },
      });
    }
    if (!sameIdentity(openedIdentity, await inspectDirectory(controlled.path)) ||
        !sameIdentity(openedIdentity, identity(await handle.stat({ bigint: true })))) {
      throw new Error("controlled directory identity changed during enumeration");
    }
    return freezeControlledEntries(result);
  } finally {
    await handle.close();
  }
}

function settleAuthority(
  value: object,
  state: AuthorityState,
): Promise<void> {
  if (state.close_promise !== null) return state.close_promise;
  state.active = false;
  validAuthorities.delete(value);
  state.close_promise = (async () => {
    await Promise.all([...state.dependents].map(async (dependent) => {
      const dependentState = authorityStates.get(dependent);
      if (dependentState !== undefined) await settleAuthority(dependent, dependentState);
    }));
    if (state.operations > 0) {
      await new Promise<void>((resolveDrained) => { state.drained = resolveDrained; });
    }
    await Promise.all(state.guardians.map(closeWindowsGuardian));
    for (const guardian of state.guardians) authoritiesByGuardian.get(guardian)?.delete(value);
    for (const dependency of state.dependencies) authorityStates.get(dependency)?.dependents.delete(value);
  })();
  return state.close_promise;
}

/** Lists bounded metadata from one direct controlled directory without exposing path authority. */
async function listControlledEntriesWithHook(
  value: unknown,
  controlledLeaf: unknown,
  afterOpen: (() => Promise<void>) | null,
): Promise<readonly PrivateDirectoryControlledEntry[]> {
  if (!validatePrivateDirectoryAuthority(value)) {
    throw new Error("private directory authority is unavailable");
  }
  const leaf = exactEntryName(controlledLeaf);
  const state = authorityStates.get(value);
  if (state === undefined || !state.active) throw new Error("private directory authority is unavailable");
  state.operations += 1;
  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    state.operations -= 1;
    if (state.operations === 0) {
      const drained = state.drained;
      state.drained = null;
      drained?.();
    }
  };
  try {
    return await listControlledEntriesInternal(value, state, leaf, afterOpen);
  } catch (error) {
    const settlement = settleAuthority(value, state);
    leave();
    await settlement;
    throw error;
  } finally {
    leave();
  }
}

/** Lists bounded metadata from one direct controlled directory without exposing path authority. */
export async function listControlledEntries(
  value: unknown,
  controlledLeaf: unknown,
): Promise<readonly PrivateDirectoryControlledEntry[]> {
  return listControlledEntriesWithHook(value, controlledLeaf, null);
}

interface SafePublishRequest {
  readonly controlled_leaf: string;
  readonly final_name: string;
  readonly expected_sha256: string;
  readonly expected_bytes: number;
  readonly read: (offset: number, maxBytes: number) => Promise<Uint8Array | null>;
}

function publishRequestSnapshot(value: unknown): SafePublishRequest {
  if (value === null || typeof value !== "object" || isProxy(value)) {
    throw new Error("invalid controlled file publication request");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const requestKeys = ["controlled_leaf", "expected_bytes", "expected_sha256", "final_name", "reader"];
  if (Reflect.ownKeys(descriptors).map(String).sort().join("\0") !== requestKeys.join("\0")) {
    throw new Error("invalid controlled file publication request");
  }
  const readRequestField = (name: keyof PublishControlledFileRequest): unknown => {
    const descriptor = descriptors[name];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("invalid controlled file publication request");
    }
    return descriptor.value;
  };
  const controlledLeaf = exactEntryName(readRequestField("controlled_leaf"));
  const finalName = exactEntryName(readRequestField("final_name"));
  if (process.platform === "win32") {
    const base = finalName.split(".", 1)[0]?.toUpperCase() ?? "";
    if (finalName.endsWith(".") || finalName.endsWith(" ") ||
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base)) {
      throw new Error("controlled file name is not portable on Windows");
    }
  }
  if (finalName.toLowerCase().startsWith(".hunter-publish-v1-")) {
    throw new Error("controlled file name is reserved");
  }
  const expectedSha256 = readRequestField("expected_sha256");
  const expectedBytes = readRequestField("expected_bytes");
  const reader = readRequestField("reader");
  if (typeof expectedSha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(expectedSha256) ||
      typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 0 || expectedBytes > MAX_PUBLISH_BYTES ||
      reader === null || typeof reader !== "object" || isProxy(reader)) {
    throw new Error("invalid controlled file publication request");
  }
  const readerDescriptors = Object.getOwnPropertyDescriptors(reader);
  if (Reflect.ownKeys(readerDescriptors).map(String).join("\0") !== "read") {
    throw new Error("invalid controlled file reader");
  }
  const readDescriptor = readerDescriptors.read;
  if (readDescriptor === undefined || !("value" in readDescriptor) ||
      typeof readDescriptor.value !== "function" || isProxy(readDescriptor.value)) {
    throw new Error("invalid controlled file reader");
  }
  return Object.freeze({
    controlled_leaf: controlledLeaf,
    final_name: finalName,
    expected_sha256: expectedSha256,
    expected_bytes: expectedBytes,
    read: Function.prototype.bind.call(readDescriptor.value, reader) as SafePublishRequest["read"],
  });
}

async function hashOpenedFile(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(MAX_PUBLISH_CHUNK_BYTES);
  let offset = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) break;
    digest.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
    if (offset > MAX_PUBLISH_BYTES) throw new Error("controlled file exceeds publication bound");
  }
  return { sha256: `sha256:${digest.digest("hex")}`, bytes: offset };
}

async function inspectPublishedFile(path: string): Promise<{
  readonly sha256: string;
  readonly bytes: number;
}> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      !samePath(await realpath(path), path)) {
    throw new Error("controlled publication target is linked or not a regular file");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(identity(before), identity(opened))) {
      throw new Error("controlled publication target identity changed before open");
    }
    const result = await hashOpenedFile(handle);
    const after = await lstat(path, { bigint: true });
    if (!sameIdentity(identity(opened), identity(after)) || after.nlink !== 1n) {
      throw new Error("controlled publication target identity changed during verification");
    }
    if (process.platform !== "win32" && ((after.mode & 0o777n) !== 0o600n ||
        (typeof process.geteuid === "function" && after.uid !== BigInt(process.geteuid())))) {
      throw new Error("controlled publication target permissions or owner are not canonical");
    }
    return result;
  } finally {
    await handle.close();
  }
}

async function flushPosixPath(path: string, directory: boolean): Promise<void> {
  const handle = await open(path, constants.O_RDONLY |
    (directory ? (constants.O_DIRECTORY ?? 0) : 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function withPublishQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = publishTails.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = predecessor.catch(() => undefined).then(() => gate);
  publishTails.set(key, tail);
  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (publishTails.get(key) === tail) publishTails.delete(key);
  }
}

async function readPublishChunk(
  request: SafePublishRequest,
  offset: number,
  maxBytes: number,
): Promise<Buffer | null> {
  const promise = request.read(offset, maxBytes);
  if (promise === null || typeof promise !== "object" || isProxy(promise) ||
      Object.getPrototypeOf(promise) !== Promise.prototype) {
    throw new Error("controlled file reader returned a non-genuine Promise");
  }
  const value = await promise;
  if (value === null) return null;
  if (!isUint8Array(value) || isProxy(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype ||
      value.byteLength === 0 || value.byteLength > maxBytes) {
    throw new Error("controlled file reader returned an invalid chunk");
  }
  return Buffer.from(value);
}

function parsePublishResult(line: string): PublishControlledFileResult {
  const parsed = JSON.parse(line) as unknown;
  if (parsed === null || typeof parsed !== "object" || isProxy(parsed)) {
    throw new Error("invalid controlled publication result");
  }
  const descriptors = Object.getOwnPropertyDescriptors(parsed);
  const outcome = descriptors.outcome;
  const sha256 = descriptors.sha256;
  const bytes = descriptors.bytes;
  if (outcome === undefined || !("value" in outcome) ||
      !["published", "existing_identical", "existing_different"].includes(String(outcome.value)) ||
      sha256 === undefined || !("value" in sha256) ||
      typeof sha256.value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(sha256.value) ||
      bytes === undefined || !("value" in bytes) ||
      typeof bytes.value !== "number" || !Number.isSafeInteger(bytes.value) || bytes.value < 0 ||
      bytes.value > MAX_PUBLISH_BYTES) {
    throw new Error("invalid controlled publication result");
  }
  return Object.freeze({
    outcome: outcome.value as PublishControlledFileResult["outcome"],
    sha256: sha256.value,
    bytes: bytes.value,
  });
}

async function publishWithWindowsGuardian(
  proof: PrivateDirectoryAuthority,
  guardian: WindowsGuardian,
  request: SafePublishRequest,
  tempPrefix: string,
  fault: "" | "crash_before_rename" | "crash_after_rename" | "ambiguous_after_rename",
): Promise<PublishControlledFileResult> {
  return withGuardianCommand(guardian, async () => {
    let startedPublication = false;
    try {
      if (!validatePrivateDirectoryAuthority(proof)) throw new Error("private directory authority is unavailable");
      const start = Buffer.from(JSON.stringify({
        final_name: request.final_name,
        expected_sha256: request.expected_sha256,
        expected_bytes: request.expected_bytes,
        temp_prefix: tempPrefix,
        fault,
      }), "utf8").toString("base64");
      guardian.child.stdin.write(`publish-start ${start}\n`);
      const started = JSON.parse(await nextGuardianLine(guardian)) as { ok?: unknown };
      if (started.ok !== true) throw new Error("controlled publication guardian did not start");
      startedPublication = true;
      let offset = 0;
      while (offset < request.expected_bytes) {
        if (!validatePrivateDirectoryAuthority(proof)) throw new Error("private directory authority is unavailable");
        const chunk = await readPublishChunk(
          request, offset, Math.min(MAX_PUBLISH_CHUNK_BYTES, request.expected_bytes - offset),
        );
        if (chunk === null) throw new Error("controlled file reader ended before expected size");
        guardian.child.stdin.write(`publish-chunk ${chunk.toString("base64")}\n`);
        const acknowledged = JSON.parse(await nextGuardianLine(guardian)) as { ok?: unknown };
        if (acknowledged.ok !== true) throw new Error("controlled publication chunk was not acknowledged");
        offset += chunk.length;
      }
      if (await readPublishChunk(request, offset, 1) !== null) {
        throw new Error("controlled file reader exceeded expected size");
      }
      if (!validatePrivateDirectoryAuthority(proof)) throw new Error("private directory authority is unavailable");
      guardian.child.stdin.write("publish-finish\n");
      const result = parsePublishResult(await nextGuardianLine(guardian));
      startedPublication = false;
      return result;
    } catch (error) {
      if (startedPublication && guardian.alive && guardian.child.exitCode === null) {
        guardian.child.stdin.write("publish-abort\n");
        try { await nextGuardianLine(guardian); } catch { /* guardian loss is the primary failure */ }
      }
      throw error;
    }
  });
}

/** Durably publishes one bounded file inside a registered controlled leaf. */
async function publishControlledFileInternal(
  authorityValue: unknown,
  requestValue: unknown,
  fault: "" | "crash_before_rename" | "crash_after_rename" | "ambiguous_after_rename",
): Promise<PublishControlledFileResult> {
  const request = publishRequestSnapshot(requestValue);
  if (!validatePrivateDirectoryAuthority(authorityValue)) {
    throw new Error("private directory authority is unavailable");
  }
  const proof = authorityValue;
  const state = authorityStates.get(proof);
  if (state === undefined || !state.active) throw new Error("private directory authority is unavailable");
  const controlled = state.controlled.find((candidate) => basename(candidate.path) === request.controlled_leaf);
  if (controlled === undefined || (process.platform === "win32" && controlled.guardian?.role !== "controlled_leaf")) {
    throw new Error("directory is not publish-controlled by this authority");
  }
  const queueKey = `${process.platform === "win32" ? controlled.path.toLowerCase() : controlled.path}\0${
    process.platform === "win32" ? request.final_name.toLowerCase() : request.final_name}`;
  state.operations += 1;
  try {
    return await withPublishQueue(queueKey, async () => {
      if (!validatePrivateDirectoryAuthority(proof)) throw new Error("private directory authority is unavailable");
      const prefixDigest = createHash("sha256").update(request.final_name).digest("hex").slice(0, 16);
      const tempPrefix = `.hunter-publish-v1-${prefixDigest}-`;
      if (!validatePrivateDirectoryAuthority(proof)) throw new Error("private directory authority is unavailable");
      const finalPath = join(controlled.path, request.final_name);
      if (controlled.guardian !== null) {
        return publishWithWindowsGuardian(proof, controlled.guardian, request, tempPrefix, fault);
      }
      const tempPath = join(controlled.path, `${tempPrefix}${randomUUID()}.tmp`);
      const handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      const tempIdentity = identity(await handle.stat({ bigint: true }));
      let published = false;
      try {
        const incremental = createHash("sha256");
        let offset = 0;
        while (offset < request.expected_bytes) {
          if (!validatePrivateDirectoryAuthority(proof)) throw new Error("private directory authority is unavailable");
          const chunk = await readPublishChunk(
            request, offset, Math.min(MAX_PUBLISH_CHUNK_BYTES, request.expected_bytes - offset),
          );
          if (chunk === null) throw new Error("controlled file reader ended before expected size");
          await handle.write(chunk, 0, chunk.length, offset);
          incremental.update(chunk);
          offset += chunk.length;
        }
        if (await readPublishChunk(request, offset, 1) !== null) {
          throw new Error("controlled file reader exceeded expected size");
        }
        const streamedSha256 = `sha256:${incremental.digest("hex")}`;
        if (streamedSha256 !== request.expected_sha256) throw new Error("controlled file digest does not match expectation");
        await handle.sync();
        const verified = await hashOpenedFile(handle);
        if (verified.sha256 !== request.expected_sha256 || verified.bytes !== request.expected_bytes) {
          throw new Error("controlled file same-handle verification failed");
        }
        if (!validatePrivateDirectoryAuthority(proof)) throw new Error("private directory authority is unavailable");
        try {
          await link(tempPath, finalPath);
          const linked = await lstat(finalPath, { bigint: true });
          const held = await handle.stat({ bigint: true });
          if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 2n ||
              !sameIdentity(identity(linked), tempIdentity) ||
              !sameIdentity(identity(linked), identity(held))) {
            try {
              const currentFinal = await lstat(finalPath, { bigint: true });
              if (sameIdentity(identity(currentFinal), identity(linked))) await unlink(finalPath);
            } catch { /* fail closed; never delete a changed final identity */ }
            throw new Error("controlled publication link did not preserve the temp identity");
          }
          await unlink(tempPath);
          published = true;
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          const existing = await inspectPublishedFile(finalPath);
          return Object.freeze({
            outcome: existing.sha256 === request.expected_sha256 && existing.bytes === request.expected_bytes
              ? "existing_identical" as const
              : "existing_different" as const,
            sha256: existing.sha256,
            bytes: existing.bytes,
          });
        }
        const final = await inspectPublishedFile(finalPath);
        if (final.sha256 !== request.expected_sha256 || final.bytes !== request.expected_bytes) {
          throw new Error("controlled publication changed after atomic link");
        }
        const finalMetadata = await lstat(finalPath);
        if ((finalMetadata.mode & 0o777) !== 0o600 ||
            (typeof process.geteuid === "function" && finalMetadata.uid !== process.geteuid())) {
          throw new Error("controlled publication final permissions or owner are not canonical");
        }
        await flushPosixPath(finalPath, false);
        await flushPosixPath(controlled.path, true);
        if (controlled.guardian !== null) {
          await withGuardianCommand(controlled.guardian, async () => {
            controlled.guardian?.child.stdin.write("flush-directory\n");
            const response = JSON.parse(await nextGuardianLine(controlled.guardian as WindowsGuardian)) as { ok?: unknown };
            if (response.ok !== true) throw new Error("controlled directory flush failed");
          });
        }
        return Object.freeze({
          outcome: "published" as const,
          sha256: final.sha256,
          bytes: final.bytes,
        });
      } finally {
        try { await handle.close(); } catch { /* already closed */ }
        if (!published) {
          try {
            const current = await lstat(tempPath, { bigint: true });
            if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1n &&
                sameIdentity(identity(current), tempIdentity)) {
              await unlink(tempPath);
            }
          } catch { /* only this attempt's exact identity is eligible for best-effort cleanup */ }
        }
      }
    });
  } finally {
    state.operations -= 1;
    if (state.operations === 0) {
      const drained = state.drained;
      state.drained = null;
      drained?.();
    }
  }
}

/** Durably publishes one bounded file inside a registered controlled leaf. */
export async function publishControlledFile(
  authorityValue: unknown,
  requestValue: unknown,
): Promise<PublishControlledFileResult> {
  return publishControlledFileInternal(authorityValue, requestValue, "");
}

/** @internal Deterministic crash/ambiguity seam; intentionally omitted from the package index. */
export async function publishControlledFileWithFaultForTest(
  authorityValue: unknown,
  requestValue: unknown,
  fault: "crash_before_rename" | "crash_after_rename" | "ambiguous_after_rename",
): Promise<PublishControlledFileResult> {
  return publishControlledFileInternal(authorityValue, requestValue, fault);
}

/** @internal Deterministic POSIX pathname-swap seam; intentionally not exported by the package index. */
export async function listControlledEntriesWithHookForTest(
  value: unknown,
  controlledLeaf: unknown,
  afterOpen: () => Promise<void>,
): Promise<readonly PrivateDirectoryControlledEntry[]> {
  if (typeof afterOpen !== "function" || isProxy(afterOpen)) throw new Error("invalid enumeration hook");
  return listControlledEntriesWithHook(value, controlledLeaf, afterOpen);
}

function authorityArraySnapshot(value: unknown): readonly PrivateDirectoryAuthority[] {
  if (!Array.isArray(value) || isProxy(value)) throw new Error("invalid child authorities");
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const length = descriptors.length;
  const count = length !== undefined && "value" in length ? length.value : undefined;
  if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 1_000 ||
      Reflect.ownKeys(descriptors).length !== (count as number) + 1) {
    throw new Error("invalid child authorities");
  }
  const result: PrivateDirectoryAuthority[] = [];
  for (let index = 0; index < (count as number); index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) ||
        !validatePrivateDirectoryAuthority(descriptor.value)) throw new Error("invalid child authorities");
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

async function consolidatePrivateDirectoryAuthorityInternal(
  parentValue: unknown,
  childValues: unknown,
  exactControlledLeaves: unknown,
  duringTransition: (() => void | Promise<void>) | null,
): Promise<PrivateDirectoryAuthority> {
  if (!validatePrivateDirectoryAuthority(parentValue)) throw new Error("parent authority is unavailable");
  const parent = parentValue;
  if (parent.controlled_directories.length !== 0) {
    throw new Error("parent authority must be an exact root owner");
  }
  const children = authorityArraySnapshot(childValues);
  const leaves = controlledSnapshot(exactControlledLeaves).map(exactEntryName);
  if (children.length !== leaves.length || new Set(children).size !== children.length ||
      new Set(leaves.map((leaf) => process.platform === "win32" ? leaf.toLowerCase() : leaf)).size !== leaves.length) {
    throw new Error("handoff children and controlled leaves do not match");
  }
  const expected = new Map(leaves.map((leaf) => [process.platform === "win32" ? leaf.toLowerCase() : leaf, leaf]));
  for (const child of children) {
    if (!samePath(dirname(child.root), parent.root) || child.controlled_directories.length !== 0) {
      throw new Error("handoff child is not an exact direct leaf");
    }
    const key = process.platform === "win32" ? basename(child.root).toLowerCase() : basename(child.root);
    if (!expected.delete(key)) throw new Error("handoff child does not match controlled leaves");
  }
  if (expected.size !== 0) throw new Error("handoff controlled leaves are incomplete");

  const childRecords = children.map((child) => {
    const state = authorityStates.get(child);
    if (state === undefined) throw new Error("handoff child authority state is unavailable");
    return { child, state };
  });
  const childBindings = await Promise.all(childRecords.map(async ({ child, state }) => {
    if (process.platform !== "win32") {
      return {
        path: child.root,
        root: await inspectDirectory(child.root),
        marker: await inspectMarker(child.marker),
      };
    }
    const rootGuardian = state.guardians.find((guardian) =>
      guardian.role === "root_owner" && samePath(windowsFinalPath(guardian.final_path), child.root));
    const markerGuardian = state.guardians.find((guardian) =>
      guardian.role === "file" && samePath(windowsFinalPath(guardian.final_path), child.marker));
    if (rootGuardian === undefined || markerGuardian === undefined) {
      throw new Error("handoff child does not own exact root and marker handles");
    }
    return {
      path: child.root,
      root: { dev: rootGuardian.volume, ino: rootGuardian.file_index },
      marker: { dev: markerGuardian.volume, ino: markerGuardian.file_index },
    };
  }));
  if (!validatePrivateDirectoryAuthority(parent) ||
      children.some((child) => !validatePrivateDirectoryAuthority(child))) {
    throw new Error("handoff authority was lost before consumption");
  }
  const parentState = authorityStates.get(parent);
  if (parentState === undefined || !parentState.active) {
    throw new Error("parent authority is unavailable");
  }
  const parentRootGuardian = process.platform === "win32"
    ? parentState.guardians.find((guardian) =>
      guardian.role === "root_owner" && samePath(windowsFinalPath(guardian.final_path), parent.root))
    : null;
  if (process.platform === "win32" && parentRootGuardian === undefined) {
    throw new Error("parent authority does not own its exact root handle");
  }
  parentState.operations += 1;
  let parentOperationLeft = false;
  const leaveParentOperation = (): void => {
    if (parentOperationLeft) return;
    parentOperationLeft = true;
    parentState.operations -= 1;
    if (parentState.operations === 0) {
      const drained = parentState.drained;
      parentState.drained = null;
      drained?.();
    }
  };
  // Establish the ordinary single-settlement path synchronously for every
  // consumed proof. A concurrent close then joins this exact settlement
  // instead of releasing the same guardian reference a second time.
  const childSettlements = childRecords.map(({ child, state }) => settleAuthority(child, state));
  const bindingsByRoot = new Map(childBindings.map((binding) => [
    process.platform === "win32" ? binding.path.toLowerCase() : binding.path,
    binding,
  ]));
  const opened: WindowsGuardian[] = [];
  const controlledState: Array<AuthorityState["controlled"][number]> = [];
  try {
    if (parentRootGuardian !== null && parentRootGuardian !== undefined) {
      await reinspectWindowsGuardian(parentRootGuardian);
      assertExactRootEntries(guardianEntries(parentRootGuardian), leaves.map((leaf) => join(parent.root, leaf)));
    } else {
      assertExactRootEntries(await readdir(parent.root), leaves.map((leaf) => join(parent.root, leaf)));
    }
    await Promise.all(childSettlements);
    if (!validatePrivateDirectoryAuthority(parent)) throw new Error("parent authority was lost during handoff");
    await duringTransition?.();
    if (!validatePrivateDirectoryAuthority(parent)) throw new Error("parent authority was lost during handoff");
    const ownerSid = process.platform === "win32" ? await currentWindowsSid() : null;
    for (const leaf of leaves) {
      const path = join(parent.root, leaf);
      const pathIdentity = await inspectDirectory(path);
      const markerPath = join(path, MARKER_NAME);
      const markerIdentity = await inspectMarker(markerPath);
      const expectedBinding = bindingsByRoot.get(process.platform === "win32" ? path.toLowerCase() : path);
      if (expectedBinding === undefined) throw new Error("handoff child binding is unavailable");
      if (!sameIdentity(pathIdentity, expectedBinding.root) ||
          !sameIdentity(markerIdentity, expectedBinding.marker)) {
        throw new Error("handoff child identity changed during guardian transition");
      }
      if (ownerSid === null) {
        await assertPosixDirectory(path);
        await assertPosixMarker(markerPath);
        controlledState.push({ path, identity: pathIdentity, guardian: null });
        continue;
      }
      const guardian = await startWindowsGuardian(path, "directory", false, "controlled_leaf");
      opened.push(guardian);
      assertGuardianBinds(guardian, path, pathIdentity);
      assertCanonicalWindowsDescriptor(guardian.descriptor, ownerSid, "controlled");
      await withGuardianCommand(guardian, async () => {
        guardian.child.stdin.write("flush-directory\n");
        const response = JSON.parse(await nextGuardianLine(guardian)) as { ok?: unknown };
        if (response.ok !== true) throw new Error("controlled directory flush failed");
      });
      const markerGuardian = await startWindowsGuardian(markerPath, "file");
      opened.push(markerGuardian);
      assertGuardianBinds(markerGuardian, markerPath, markerIdentity);
      assertGuardianMarker(markerGuardian);
      assertCanonicalWindowsDescriptor(markerGuardian.descriptor, ownerSid, "file");
      assertCanonicalWindowsDescriptor(
        await reinspectWindowsGuardian(guardian), ownerSid, "controlled",
      );
      assertGuardianBinds(guardian, path, pathIdentity);
      controlledState.push({ path, identity: pathIdentity, guardian });
    }
    if (!validatePrivateDirectoryAuthority(parent)) throw new Error("parent authority was lost during handoff");
    if (process.platform === "win32") {
      opened.push(await startWindowsGuardian(parent.root, "directory"));
    }
    if (parentRootGuardian !== null && parentRootGuardian !== undefined) {
      await reinspectWindowsGuardian(parentRootGuardian);
      assertExactRootEntries(guardianEntries(parentRootGuardian), leaves.map((leaf) => join(parent.root, leaf)));
    } else {
      assertExactRootEntries(await readdir(parent.root), leaves.map((leaf) => join(parent.root, leaf)));
    }
    if (!validatePrivateDirectoryAuthority(parent)) throw new Error("parent authority was lost during handoff");
    return authority(parent.root, leaves.map((leaf) => join(parent.root, leaf)),
      opened, controlledState, [parent]);
  } catch (error) {
    await Promise.all(opened.map(closeWindowsGuardian));
    throw error;
  } finally {
    leaveParentOperation();
  }
}

/** Consumes exact child root-owner proofs and atomically replaces them with controlled-leaf guardians. */
export async function consolidatePrivateDirectoryAuthority(
  parentValue: unknown,
  childValues: unknown,
  exactControlledLeaves: unknown,
): Promise<PrivateDirectoryAuthority> {
  return consolidatePrivateDirectoryAuthorityInternal(
    parentValue, childValues, exactControlledLeaves, null,
  );
}

/** @internal Deterministic handoff seam; intentionally omitted from the package index. */
export async function consolidatePrivateDirectoryAuthorityWithHookForTest(
  parentValue: unknown,
  childValues: unknown,
  exactControlledLeaves: unknown,
  duringTransition: () => void | Promise<void>,
): Promise<PrivateDirectoryAuthority> {
  if (typeof duringTransition !== "function" || isProxy(duringTransition)) {
    throw new Error("invalid handoff hook");
  }
  return consolidatePrivateDirectoryAuthorityInternal(
    parentValue, childValues, exactControlledLeaves, duringTransition,
  );
}

/** Releases every guardian handle and irreversibly invalidates the proof. */
export async function closePrivateDirectoryAuthority(value: unknown): Promise<void> {
  if (value === null || typeof value !== "object" || isProxy(value)) return;
  const state = authorityStates.get(value);
  if (state === undefined) return;
  await settleAuthority(value, state);
}

async function prepareNewLeafInternal(
  parent: unknown,
  leaf: unknown,
  afterRootSecured?: (root: string) => void | Promise<void>,
  beforeRootSecured?: (root: string) => void | Promise<void>,
): Promise<PrivateDirectoryAuthority> {
  assertPrimitivePath(parent, "invalid private directory parent");
  const name = exactLeaf(leaf);
  const parentPath = resolve(parent);
  const parentIdentity = await inspectDirectory(parentPath);
  const root = join(parentPath, name);
  const ownerSid = process.platform === "win32" ? await currentWindowsSid() : null;
  await mkdir(root, { recursive: false, mode: 0o700 });
  let rootIdentity: Identity;
  try {
    rootIdentity = await inspectDirectory(root);
    await verifyDirectoryStable(parentPath, parentIdentity);
  } catch (error) {
    try { await rm(root, { recursive: false, force: true }); } catch { /* best-effort isolation */ }
    throw error;
  }
  const markerPath = join(root, MARKER_NAME);
  if (ownerSid === null) {
    try {
      await assertPosixDirectory(root);
      const marker = await open(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        await marker.writeFile(MARKER_CONTENT);
        await marker.sync();
      } finally {
        await marker.close();
      }
      await assertPosixMarker(markerPath);
      await verifyDirectoryStable(root, rootIdentity);
      await verifyDirectoryStable(parentPath, parentIdentity);
      return authority(root, []);
    } catch (error) {
      try { await rm(markerPath, { force: true }); } catch { /* best-effort isolation */ }
      try { await rm(root, { recursive: false, force: true }); } catch { /* best-effort isolation */ }
      throw error;
    }
  }

  let rootGuardian: WindowsGuardian | null = null;
  let markerGuardian: WindowsGuardian | null = null;
  try {
    rootGuardian = await startWindowsGuardian(root, "directory", true);
    assertGuardianBinds(rootGuardian, root, rootIdentity);
    if ((rootGuardian.attributes & 0x10) === 0) throw new Error("private root handle is not a directory");
    await beforeRootSecured?.(root);
    assertCanonicalWindowsDescriptor(
      await setWindowsGuardianAcl(rootGuardian, "directory", ownerSid), ownerSid, "root",
    );
    if (guardianEntries(rootGuardian).length !== 0) throw new Error("new private directory is not empty");
    await afterRootSecured?.(root);

    const marker = await open(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await marker.writeFile(MARKER_CONTENT);
      await marker.sync();
    } finally {
      await marker.close();
    }
    const markerIdentity = await inspectMarker(markerPath);
    markerGuardian = await startWindowsGuardian(markerPath, "file", true);
    assertGuardianBinds(markerGuardian, markerPath, markerIdentity);
    assertGuardianMarker(markerGuardian);
    assertCanonicalWindowsDescriptor(
      await setWindowsGuardianAcl(markerGuardian, "file", ownerSid), ownerSid, "file",
    );
    assertGuardianMarker(markerGuardian);
    await reinspectWindowsGuardian(rootGuardian);
    const rootEntries = guardianEntries(rootGuardian);
    if (rootEntries.length !== 1 || rootEntries[0] !== MARKER_NAME) {
      throw new Error("new private directory gained unexpected entries");
    }
    await verifyDirectoryStable(parentPath, parentIdentity);
    return authority(root, [], [rootGuardian, markerGuardian]);
  } catch (error) {
    if (markerGuardian === null) {
      try { markerGuardian = await startWindowsGuardian(markerPath, "file"); } catch { /* absent */ }
    }
    if (markerGuardian !== null) {
      try { await deleteWithWindowsGuardian(markerGuardian); } catch { await closeWindowsGuardian(markerGuardian); }
    }
    if (rootGuardian !== null) {
      if (markerGuardian === null) {
        try { await rm(markerPath, { force: true }); } catch { /* best-effort isolation */ }
      }
      try { await deleteWithWindowsGuardian(rootGuardian); } catch { await closeWindowsGuardian(rootGuardian); }
    }
    throw error;
  }
}

export async function prepareNewLeaf(parent: unknown, leaf: unknown): Promise<PrivateDirectoryAuthority> {
  return prepareNewLeafInternal(parent, leaf);
}

/** Internal focused-test seam; deliberately omitted from the package index. */
export async function prepareNewLeafWithHookForTest(
  parent: unknown,
  leaf: unknown,
  afterRootSecured: (root: string) => void | Promise<void>,
): Promise<PrivateDirectoryAuthority> {
  return prepareNewLeafInternal(parent, leaf, afterRootSecured);
}

/** Internal focused-test seam; deliberately omitted from the package index. */
export async function prepareNewLeafWithPreAclHookForTest(
  parent: unknown,
  leaf: unknown,
  beforeRootSecured: (root: string) => void | Promise<void>,
): Promise<PrivateDirectoryAuthority> {
  return prepareNewLeafInternal(parent, leaf, undefined, beforeRootSecured);
}

/** Internal focused-test seam; deliberately omitted from the package index. */
export function killPrivateDirectoryAuthorityGuardianForTest(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  authorityStates.get(value)?.guardians[0]?.child.kill();
}

export async function verifyExisting(root: unknown, controlledDirectories: unknown): Promise<PrivateDirectoryAuthority> {
  assertPrimitivePath(root, "invalid private directory root");
  const controlled = controlledSnapshot(controlledDirectories);
  const rootPath = resolve(root);
  const rootIdentity = await inspectDirectory(rootPath);
  const paths = controlled.map((candidate) => containedPath(rootPath, candidate));
  if (new Set(paths.map((path) => process.platform === "win32" ? path.toLowerCase() : path)).size !== paths.length) {
    throw new Error("controlled directories contain duplicates");
  }
  const markerPath = join(rootPath, MARKER_NAME);
  let markerIdentity: Identity;
  try {
    markerIdentity = await inspectMarker(markerPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Error("private directory marker is missing", { cause: error });
    throw error;
  }
  const ownerSid = process.platform === "win32" ? await currentWindowsSid() : null;
  const guardians: WindowsGuardian[] = [];
  const controlledState: Array<AuthorityState["controlled"][number]> = [];
  if (ownerSid === null) {
    await assertPosixDirectory(rootPath);
    await assertPosixMarker(markerPath);
  } else {
    try {
      const rootGuardian = await startWindowsGuardian(rootPath, "directory");
      guardians.push(rootGuardian);
      assertGuardianBinds(rootGuardian, rootPath, rootIdentity);
      assertCanonicalWindowsDescriptor(rootGuardian.descriptor, ownerSid, "root");
      const markerGuardian = await startWindowsGuardian(markerPath, "file");
      guardians.push(markerGuardian);
      assertGuardianBinds(markerGuardian, markerPath, markerIdentity);
      assertCanonicalWindowsDescriptor(markerGuardian.descriptor, ownerSid, "file");
      assertGuardianMarker(markerGuardian);
      for (const path of paths) {
        const controlledIdentity = await inspectDirectory(path);
        const guardian = await startWindowsGuardian(path, "directory");
        guardians.push(guardian);
        assertGuardianBinds(guardian, path, controlledIdentity);
        assertCanonicalWindowsDescriptor(guardian.descriptor, ownerSid, "controlled");
        controlledState.push({ path, identity: controlledIdentity, guardian });
      }
      assertExactRootEntries(guardianEntries(rootGuardian), paths);
    } catch (error) {
      await Promise.all(guardians.map(closeWindowsGuardian));
      throw error;
    }
  }
  if (ownerSid === null) {
    const marker = await open(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const openedIdentity = identity(await marker.stat({ bigint: true }));
      if (!sameIdentity(markerIdentity, openedIdentity)) {
        throw new Error("private directory marker identity changed before it was opened");
      }
      const bytes = await marker.readFile();
      if (!bytes.equals(MARKER_CONTENT)) throw new Error("private directory marker is invalid");
      if (!sameIdentity(openedIdentity, identity(await marker.stat({ bigint: true })))) {
        throw new Error("private directory marker identity changed while it was read");
      }
    } finally {
      await marker.close();
    }
    if (!sameIdentity(markerIdentity, await inspectMarker(markerPath))) {
      throw new Error("private directory marker identity changed during verification");
    }
    for (const path of paths) {
      const controlledIdentity = await inspectDirectory(path);
      await assertPosixDirectory(path);
      await verifyDirectoryStable(path, controlledIdentity);
      controlledState.push({ path, identity: controlledIdentity, guardian: null });
    }
    assertExactRootEntries(await readdir(rootPath), paths);
  }
  await verifyDirectoryStable(rootPath, rootIdentity);
  return authority(rootPath, paths, guardians, controlledState);
}

/** Rebuilds a publish-capable consolidated proof for an existing private tree. */
export async function verifyExistingConsolidated(
  root: unknown,
  exactControlledLeaves: unknown,
): Promise<PrivateDirectoryAuthority> {
  const leaves = controlledSnapshot(exactControlledLeaves).map(exactEntryName);
  const intermediate = await verifyExisting(root, leaves);
  if (process.platform !== "win32") return intermediate;
  const state = authorityStates.get(intermediate);
  if (state === undefined || !state.active) throw new Error("verified private directory authority is unavailable");
  const retained: WindowsGuardian[] = [];
  const controlledState: Array<AuthorityState["controlled"][number]> = [];
  try {
    retained.push(await startWindowsGuardian(intermediate.root, "directory"));
    retained.push(await startWindowsGuardian(intermediate.marker, "file"));
    if (!validatePrivateDirectoryAuthority(intermediate)) {
      throw new Error("verified private directory authority was lost during restart handoff");
    }
    await settleAuthority(intermediate, state);
    const ownerSid = await currentWindowsSid();
    for (const leaf of leaves) {
      const path = join(intermediate.root, leaf);
      const pathIdentity = await inspectDirectory(path);
      const guardian = await startWindowsGuardian(path, "directory", false, "controlled_leaf");
      retained.push(guardian);
      assertGuardianBinds(guardian, path, pathIdentity);
      assertCanonicalWindowsDescriptor(guardian.descriptor, ownerSid, "controlled");
      await withGuardianCommand(guardian, async () => {
        guardian.child.stdin.write("flush-directory\n");
        const response = JSON.parse(await nextGuardianLine(guardian)) as { ok?: unknown };
        if (response.ok !== true) throw new Error("controlled directory flush failed");
      });
      assertCanonicalWindowsDescriptor(
        await reinspectWindowsGuardian(guardian), ownerSid, "controlled",
      );
      assertGuardianBinds(guardian, path, pathIdentity);
      controlledState.push({ path, identity: pathIdentity, guardian });
    }
    const rootGuardian = retained[0];
    if (rootGuardian === undefined) throw new Error("restart root guardian is unavailable");
    await reinspectWindowsGuardian(rootGuardian);
    assertExactRootEntries(guardianEntries(rootGuardian), leaves.map((leaf) => join(intermediate.root, leaf)));
    return authority(intermediate.root, leaves.map((leaf) => join(intermediate.root, leaf)),
      retained, controlledState);
  } catch (error) {
    await settleAuthority(intermediate, state).catch(() => undefined);
    await Promise.all(retained.map(closeWindowsGuardian));
    throw error;
  }
}
