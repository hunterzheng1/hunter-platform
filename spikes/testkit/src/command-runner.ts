import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

const MAX_CAPTURE_BYTES = 64 * 1024;

export interface CommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface CommandResult {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError: string | null | undefined;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

export type SpawnCommand = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

const spawnCommand: SpawnCommand = (executable, args, options) =>
  spawn(executable, [...args], options);

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) {
    return current;
  }
  const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current);
  return current + chunk.subarray(0, remaining).toString("utf8");
}

export class NodeCommandRunner implements CommandRunner {
  readonly #spawn: SpawnCommand;

  constructor(spawnImplementation: SpawnCommand = spawnCommand) {
    this.#spawn = spawnImplementation;
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    const startedAt = new Date().toISOString();

    return await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let spawnError: string | null = null;
      let settled = false;
      const timerRef: { current?: ReturnType<typeof setTimeout> } = {};

      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        if (timerRef.current !== undefined) clearTimeout(timerRef.current);
        resolve({
          executable: request.executable,
          args: request.args,
          cwd: request.cwd,
          exitCode,
          stdout,
          stderr,
          timedOut,
          spawnError,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.#spawn(request.executable, request.args, {
          cwd: request.cwd,
          shell: false,
          windowsHide: true,
        });
      } catch (error: unknown) {
        const spawnFailure = error as NodeJS.ErrnoException;
        spawnError = spawnFailure.code ?? spawnFailure.name;
        finish(null);
        return;
      }

      timerRef.current = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, request.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk);
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        spawnError = error.code ?? error.name;
        finish(null);
      });
      child.once("close", (code) => finish(code));
    });
  }
}
