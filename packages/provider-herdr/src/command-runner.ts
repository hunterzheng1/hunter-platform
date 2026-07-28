import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

const FORBIDDEN_ARGUMENT =
  /(?:dangerously|bypass|yolo|auto[-_]?approve|approve[-_]?all|full[-_]?auto|approval[-_]?mode|sandbox)/iu;
const MAX_ARGUMENT_COUNT = 64;
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const HERDR_IDENTITY_UNSIGNED = {
  schemaVersion: 1,
  version: "0.7.5-preview.2026-07-21-0f10e1453a7f",
  assetSha256:
    "75c85763db0ca5fd13b485d0728cc3e9ea1152964a4e976e1d49f2e86b01a92b",
  assetSize: 19_981_312,
  apiSchemaSha256:
    "7cb5b7086f5dd04adb8b7b2069042afd7214da87f6bca66e2b07ff8aa95f6f6f",
} as const;
export const HERDR_EXECUTABLE_IDENTITY = Object.freeze({
  ...HERDR_IDENTITY_UNSIGNED,
  fingerprint: createHash("sha256")
    .update(JSON.stringify(HERDR_IDENTITY_UNSIGNED))
    .digest("hex"),
});
export type HerdrExecutableIdentity = typeof HERDR_EXECUTABLE_IDENTITY;

const HerdrExecutableIdentitySchema = z.strictObject({
  schemaVersion: z.literal(HERDR_EXECUTABLE_IDENTITY.schemaVersion),
  version: z.literal(HERDR_EXECUTABLE_IDENTITY.version),
  assetSha256: z.literal(HERDR_EXECUTABLE_IDENTITY.assetSha256),
  assetSize: z.literal(HERDR_EXECUTABLE_IDENTITY.assetSize),
  apiSchemaSha256: z.literal(HERDR_EXECUTABLE_IDENTITY.apiSchemaSha256),
  fingerprint: z.literal(HERDR_EXECUTABLE_IDENTITY.fingerprint),
});

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

export interface HerdrExecFileOptions {
  readonly encoding: "utf8";
  readonly env: NodeJS.ProcessEnv;
  readonly maxBuffer: number;
  readonly shell: false;
  readonly timeout: number;
  readonly windowsHide: true;
}

export type HerdrExecFileAdapter = (
  executable: string,
  args: readonly string[],
  options: HerdrExecFileOptions,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export interface HerdrCommandRunnerOptions {
  readonly executable: string;
  readonly sessionName: string;
  readonly configPath: string;
  readonly execFile?: HerdrExecFileAdapter;
  readonly timeoutMs?: number;
}

export class HerdrAdapterError extends Error {
  constructor(
    readonly code:
      | "HERDR_ARGUMENT_FORBIDDEN"
      | "HERDR_ARGUMENT_INVALID"
      | "HERDR_COMMAND_FAILED"
      | "HERDR_COMMAND_FORBIDDEN"
      | "HERDR_EXECUTABLE_INVALID"
      | "HERDR_IDENTITY_MISMATCH"
      | "HERDR_OUTPUT_INVALID",
    readonly effectPossible = false,
  ) {
    super(code);
    this.name = "HerdrAdapterError";
  }
}

const defaultExecFile: HerdrExecFileAdapter = (
  executable,
  args,
  options,
) =>
  new Promise((resolve, reject) => {
    execFile(executable, [...args], options, (error, stdout, stderr) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

function validateExecutable(executable: string): string {
  if (
    executable.length === 0
    || executable.length > 1_024
    || executable.trim() !== executable
    || hasControlCharacter(executable)
    || /["']/u.test(executable)
    || (!isAbsolute(executable) && /[\\/]/u.test(executable))
  ) {
    throw new HerdrAdapterError("HERDR_EXECUTABLE_INVALID");
  }
  return executable;
}

function validateSessionName(value: string): string {
  if (!/^hunter-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value)) {
    throw new HerdrAdapterError("HERDR_ARGUMENT_INVALID");
  }
  return value;
}

function validateCommandShape(
  args: readonly string[],
  ownedSessionName: string,
): void {
  const command = args.slice(0, 2).join(" ");
  if (args.some((argument) => argument === "--force")) {
    throw new HerdrAdapterError("HERDR_COMMAND_FORBIDDEN");
  }
  const valid =
    (command === "worktree open"
      && args.length === 10
      && args[2] === "--cwd"
      && args[4] === "--path"
      && args[6] === "--label"
      && args[8] === "--no-focus"
      && args[9] === "--json"
      && isAbsolute(args[3] ?? "")
      && isAbsolute(args[5] ?? "")
      && /^hunter-opn_[a-z0-9][a-z0-9_-]{7,91}$/u.test(args[7] ?? ""))
    || (command === "workspace close"
      && args.length === 3
      && /^w[1-9][0-9]*$/u.test(args[2] ?? ""))
    || (command === "session list"
      && args.length === 3
      && args[2] === "--json")
    || ((command === "session stop" || command === "session delete")
      && args.length === 4
      && args[2] === ownedSessionName
      && args[3] === "--json")
    || (command === "agent start"
      && args.length === 7
      && /^hunter-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(
        args[2] ?? "",
      )
      && args[3] === "--kind"
      && args[4] === "codex"
      && args[5] === "--pane"
      && /^w[1-9][0-9]*:p[1-9][0-9]*$/u.test(args[6] ?? ""));
  if (!valid) throw new HerdrAdapterError("HERDR_COMMAND_FORBIDDEN");
}

function validateArguments(
  args: readonly string[],
  ownedSessionName: string,
): string[] {
  if (args.length < 2 || args.length > MAX_ARGUMENT_COUNT) {
    throw new HerdrAdapterError("HERDR_ARGUMENT_INVALID");
  }
  let totalBytes = 0;
  const validated = args.map((argument) => {
    totalBytes += Buffer.byteLength(argument, "utf8");
    if (
      argument.length === 0
      || Buffer.byteLength(argument, "utf8") > 8 * 1024
      || totalBytes > MAX_ARGUMENT_BYTES
      || hasControlCharacter(argument)
    ) {
      throw new HerdrAdapterError("HERDR_ARGUMENT_INVALID");
    }
    if (FORBIDDEN_ARGUMENT.test(argument)) {
      throw new HerdrAdapterError("HERDR_ARGUMENT_FORBIDDEN");
    }
    return argument;
  });
  validateCommandShape(validated, ownedSessionName);
  return validated;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

async function verifyHerdrExecutableIdentity(options: {
  readonly executable: string;
  readonly sessionName: string;
  readonly configPath: string;
  readonly execFile: HerdrExecFileAdapter;
  readonly timeoutMs: number;
}): Promise<HerdrExecutableIdentity> {
  try {
    const stat = lstatSync(options.executable);
    if (!stat.isFile() || stat.size !== HERDR_EXECUTABLE_IDENTITY.assetSize) {
      throw new Error("asset");
    }
    const assetSha256 = createHash("sha256")
      .update(readFileSync(options.executable))
      .digest("hex");
    if (assetSha256 !== HERDR_EXECUTABLE_IDENTITY.assetSha256) {
      throw new Error("asset");
    }
    const run = async (args: readonly string[], maxBuffer: number) =>
      await options.execFile(
        options.executable,
        ["--session", options.sessionName, ...args],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HERDR_SESSION: options.sessionName,
            HERDR_CONFIG_PATH: options.configPath,
          },
          maxBuffer,
          shell: false,
          timeout: options.timeoutMs,
          windowsHide: true,
        },
      );
    const version = await run(["--version"], 4 * 1024);
    if (
      version.stdout.trim()
      !== `herdr ${HERDR_EXECUTABLE_IDENTITY.version}`
    ) {
      throw new Error("version");
    }
    const schema = await run(["api", "schema", "--json"], MAX_OUTPUT_BYTES);
    const parsedSchema = JSON.parse(schema.stdout) as unknown;
    const apiSchemaSha256 = createHash("sha256")
      .update(JSON.stringify(canonicalize(parsedSchema)))
      .digest("hex");
    if (apiSchemaSha256 !== HERDR_EXECUTABLE_IDENTITY.apiSchemaSha256) {
      throw new Error("schema");
    }
    return HERDR_EXECUTABLE_IDENTITY;
  } catch {
    throw new HerdrAdapterError("HERDR_IDENTITY_MISMATCH");
  }
}

export class HerdrCommandRunner {
  readonly #executable: string;
  readonly #sessionName: string;
  readonly #configPath: string;
  readonly #execFile: HerdrExecFileAdapter;
  #identityPromise: Promise<HerdrExecutableIdentity> | undefined;
  readonly #timeoutMs: number;

  constructor(options: HerdrCommandRunnerOptions) {
    this.#executable = validateExecutable(options.executable);
    this.#sessionName = validateSessionName(options.sessionName);
    if (
      !isAbsolute(options.configPath)
      || options.configPath.length > 4_096
      || hasControlCharacter(options.configPath)
    ) {
      throw new HerdrAdapterError("HERDR_ARGUMENT_INVALID");
    }
    this.#configPath = options.configPath;
    this.#execFile = options.execFile ?? defaultExecFile;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#timeoutMs)
      || this.#timeoutMs < 1_000
      || this.#timeoutMs > 300_000
    ) {
      throw new HerdrAdapterError("HERDR_ARGUMENT_INVALID");
    }
  }

  async run(args: readonly string[]): Promise<unknown> {
    const validated = validateArguments(args, this.#sessionName);
    const effectPossible =
      (validated[0] === "worktree" && validated[1] === "open")
      || (validated[0] === "workspace" && validated[1] === "close")
      || (validated[0] === "session"
        && (validated[1] === "stop" || validated[1] === "delete"))
      || (validated[0] === "agent" && validated[1] === "start");
    const identityVerifier =
      testIdentityVerifiers.get(this)
      ?? (async () =>
        await verifyHerdrExecutableIdentity({
          executable: this.#executable,
          sessionName: this.#sessionName,
          configPath: this.#configPath,
          execFile: this.#execFile,
          timeoutMs: this.#timeoutMs,
        }));
    this.#identityPromise ??= Promise.resolve(identityVerifier()).then(
      (identity) => {
        const parsed = HerdrExecutableIdentitySchema.safeParse(identity);
        if (!parsed.success) {
          throw new HerdrAdapterError("HERDR_IDENTITY_MISMATCH");
        }
        return parsed.data;
      },
      () => {
        throw new HerdrAdapterError("HERDR_IDENTITY_MISMATCH");
      },
    );
    await this.#identityPromise;
    let stdout: string;
    try {
      ({ stdout } = await this.#execFile(
        this.#executable,
        ["--session", this.#sessionName, ...validated],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HERDR_SESSION: this.#sessionName,
            HERDR_CONFIG_PATH: this.#configPath,
          },
          maxBuffer: MAX_OUTPUT_BYTES,
          shell: false,
          timeout: this.#timeoutMs,
          windowsHide: true,
        },
      ));
    } catch {
      throw new HerdrAdapterError("HERDR_COMMAND_FAILED", effectPossible);
    }
    if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
      throw new HerdrAdapterError("HERDR_OUTPUT_INVALID", effectPossible);
    }
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new HerdrAdapterError("HERDR_OUTPUT_INVALID", effectPossible);
    }
  }
}

const testIdentityVerifiers = new WeakMap<
  HerdrCommandRunner,
  () => Promise<unknown>
>();

export function createHerdrCommandRunnerForTest(
  options: HerdrCommandRunnerOptions,
  identityVerifier: () => Promise<unknown>,
): HerdrCommandRunner {
  const runner = new HerdrCommandRunner(options);
  testIdentityVerifiers.set(runner, identityVerifier);
  return runner;
}
