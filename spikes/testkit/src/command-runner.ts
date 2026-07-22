import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

const MAX_CAPTURE_BYTES = 64 * 1024;
const TERMINATION_DEADLINE_MS = 2_500;

export type TimeoutCleanup =
  | "not_applicable"
  | "process_tree_terminated"
  | "not_proven";

export interface CommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

export interface CommandResult {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly timeoutCleanup?: TimeoutCleanup;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processTreeIsAlive(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessTreeExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processTreeIsAlive(pid) && Date.now() < deadline) {
    await delay(25);
  }
  return !processTreeIsAlive(pid);
}

async function runWindowsTreeKill(pid: number): Promise<boolean> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const deadline = setTimeout(() => finish(false), 1_500);
    let killer: ReturnType<typeof spawn>;
    try {
      killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      finish(false);
      return;
    }
    killer.once("error", () => finish(false));
    killer.once("close", (code) => finish(code === 0));
  });
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
): Promise<TimeoutCleanup> {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    return "not_proven";
  }

  if (process.platform === "win32") {
    const treeKillSucceeded = await runWindowsTreeKill(pid);
    if (!treeKillSucceeded) child.kill("SIGKILL");
    const exited = await waitForProcessTreeExit(pid, 750);
    return treeKillSucceeded && exited ? "process_tree_terminated" : "not_proven";
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  if (!(await waitForProcessTreeExit(pid, 500))) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  return (await waitForProcessTreeExit(pid, 750))
    ? "process_tree_terminated"
    : "not_proven";
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
      let timeoutCleanup: TimeoutCleanup = "not_applicable";
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
          timeoutCleanup,
          spawnError,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.#spawn(request.executable, request.args, {
          cwd: request.cwd,
          env:
            request.environment === undefined
              ? process.env
              : { ...process.env, ...request.environment },
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
        });
      } catch (error: unknown) {
        const spawnFailure = error as NodeJS.ErrnoException;
        spawnError = spawnFailure.code ?? spawnFailure.name;
        finish(null);
        return;
      }

      child.stdin.on("error", () => undefined);
      child.stdin.end(request.stdin);

      timerRef.current = setTimeout(() => {
        timedOut = true;
        void Promise.race<TimeoutCleanup>([
          terminateProcessTree(child),
          delay(TERMINATION_DEADLINE_MS).then(() => "not_proven" as const),
        ]).then((outcome) => {
          timeoutCleanup = outcome;
          finish(null);
        });
      }, request.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk);
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        spawnError = error.code ?? error.name;
        if (!timedOut) finish(null);
      });
      child.once("close", (code) => {
        if (!timedOut) finish(code);
      });
    });
  }
}
