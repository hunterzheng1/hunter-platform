import { execFile } from "node:child_process";

const FORBIDDEN_ARGUMENT =
  /(?:dangerously|bypass|yolo|auto[-_]?approve|approve[-_]?all)/iu;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

interface ExecFileOptions {
  readonly encoding: "utf8";
  readonly maxBuffer: number;
  readonly shell: false;
  readonly timeout: number;
  readonly windowsHide: true;
}

export type ExecFileAdapter = (
  executable: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<{ readonly stdout: string }>;

export interface JsonCommandRunner {
  run(args: readonly string[]): Promise<unknown>;
}

export interface OrcaExecutableResolution {
  readonly configuredCommand?: string;
  readonly development: boolean;
  readonly platform: NodeJS.Platform;
}

export interface OrcaCommandRunnerOptions {
  readonly executable?: string;
  readonly execFile?: ExecFileAdapter;
  readonly maxBufferBytes?: number;
  readonly timeoutMs?: number;
}

export class OrcaAdapterError extends Error {
  constructor(
    readonly code:
      | "ORCA_ARGUMENT_FORBIDDEN"
      | "ORCA_ARGUMENT_INVALID"
      | "ORCA_COMMAND_FAILED"
      | "ORCA_EXECUTABLE_INVALID"
      | "ORCA_OUTPUT_INVALID",
  ) {
    super(code);
    this.name = "OrcaAdapterError";
  }
}

function validateExecutable(executable: string): string {
  const hasWhitespace = /\s/u.test(executable);
  const looksLikePath = /[\\/]/u.test(executable);
  if (
    executable.length === 0 ||
    executable.length > 1_024 ||
    executable.trim() !== executable ||
    hasControlCharacter(executable) ||
    /["']/u.test(executable) ||
    (hasWhitespace && !looksLikePath) ||
    /\s--?[A-Za-z]/u.test(executable)
  ) {
    throw new OrcaAdapterError("ORCA_EXECUTABLE_INVALID");
  }
  return executable;
}

export function resolveOrcaExecutable(input: OrcaExecutableResolution): string {
  if (input.configuredCommand !== undefined) {
    return validateExecutable(input.configuredCommand);
  }
  if (input.development) return "orca-dev";
  return input.platform === "linux" ? "orca-ide" : "orca";
}

const defaultExecFile: ExecFileAdapter = (executable, args, options) =>
  new Promise((resolve, reject) => {
    execFile(executable, [...args], options, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });

function validateArguments(args: readonly string[]): string[] {
  if (args.length === 0 || args.length > 64 || args.at(-1) !== "--json") {
    throw new OrcaAdapterError("ORCA_ARGUMENT_INVALID");
  }
  let totalLength = 0;
  return args.map((argument) => {
    totalLength += argument.length;
    if (
      argument.length === 0 ||
      argument.length > 4_096 ||
      totalLength > 16_384 ||
      hasControlCharacter(argument)
    ) {
      throw new OrcaAdapterError("ORCA_ARGUMENT_INVALID");
    }
    if (FORBIDDEN_ARGUMENT.test(argument)) {
      throw new OrcaAdapterError("ORCA_ARGUMENT_FORBIDDEN");
    }
    return argument;
  });
}

export class OrcaCommandRunner implements JsonCommandRunner {
  readonly #executable: string;
  readonly #execFile: ExecFileAdapter;
  readonly #maxBufferBytes: number;
  readonly #timeoutMs: number;

  constructor(options: OrcaCommandRunnerOptions = {}) {
    this.#executable = validateExecutable(
      options.executable ??
        resolveOrcaExecutable({
          ...(process.env.ORCA_CLI_COMMAND === undefined
            ? {}
            : { configuredCommand: process.env.ORCA_CLI_COMMAND }),
          development:
            process.env.ORCA_DEV_REPO_ROOT !== undefined &&
            process.env.ORCA_DEV_REPO_ROOT.trim().length > 0,
          platform: process.platform,
        }),
    );
    this.#execFile = options.execFile ?? defaultExecFile;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxBufferBytes = options.maxBufferBytes ?? 1024 * 1024;

    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1_000 ||
      this.#timeoutMs > 120_000 ||
      !Number.isSafeInteger(this.#maxBufferBytes) ||
      this.#maxBufferBytes < 1_024 ||
      this.#maxBufferBytes > 10 * 1024 * 1024
    ) {
      throw new OrcaAdapterError("ORCA_ARGUMENT_INVALID");
    }
  }

  async run(args: readonly string[]): Promise<unknown> {
    const validatedArguments = validateArguments(args);
    let stdout: string;
    try {
      ({ stdout } = await this.#execFile(this.#executable, validatedArguments, {
        encoding: "utf8",
        maxBuffer: this.#maxBufferBytes,
        shell: false,
        timeout: this.#timeoutMs,
        windowsHide: true,
      }));
    } catch {
      throw new OrcaAdapterError("ORCA_COMMAND_FAILED");
    }

    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new OrcaAdapterError("ORCA_OUTPUT_INVALID");
    }
  }
}
