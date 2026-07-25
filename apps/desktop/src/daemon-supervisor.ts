import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { z } from "zod";

export type SpawnDaemon = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

const DAEMON_ARGUMENTS = ["--port=0", "--bootstrap-stdin"] as const;
function daemonEnvironment(dataDirectory: string | undefined) {
  return Object.freeze({
    ELECTRON_RUN_AS_NODE: "1",
    ...(dataDirectory === undefined
      ? {}
      : { HUNTER_DESKTOP_DATA_DIRECTORY: dataDirectory }),
    ...(process.platform === "win32" && process.env.SystemRoot !== undefined
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
    ...(process.platform === "win32" && process.env.WINDIR !== undefined
      ? { WINDIR: process.env.WINDIR }
      : {}),
  });
}
const CapabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const ReadinessSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("hunterd-ready"),
  port: z.number().int().min(1).max(65_535),
});

export class DaemonSupervisor {
  private child: ChildProcess | undefined;
  private protectedStart: Promise<{ readonly child: ChildProcess; readonly port: number }> | undefined;
  private readonly stopCompletions = new WeakMap<ChildProcess, Promise<void>>();

  constructor(
    private readonly spawn: SpawnDaemon = nodeSpawn,
    private readonly daemonEntry: string,
    private readonly runtimeExecutable: string = process.execPath,
    private readonly dataDirectory?: string | undefined,
  ) {}

  start(): ChildProcess {
    if (this.child !== undefined) return this.child;

    const candidate = this.spawn(
      this.runtimeExecutable,
      [this.daemonEntry, ...DAEMON_ARGUMENTS],
      {
        env: daemonEnvironment(this.dataDirectory),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let ended = false;
    const release = () => {
      ended = true;
      if (this.child === candidate) this.child = undefined;
      if (this.child === undefined) this.protectedStart = undefined;
    };
    try {
      candidate.stderr?.resume();
      candidate.on("error", () => {
        // A ChildProcess error is an observation, not proof that the process
        // exited. Keep ownership until close/exit so a second child cannot
        // be started while the first may still be alive.
      });
      candidate.once("close", release);
      candidate.once("exit", release);
    } catch (error) {
      try {
        candidate.kill("SIGTERM");
      } catch {
        // Listener setup already failed. Preserve the original lifecycle error.
      }
      throw error;
    }
    if (!ended) this.child = candidate;
    return candidate;
  }

  startProtected(
    capabilityInput: string,
  ): Promise<{ readonly child: ChildProcess; readonly port: number }> {
    if (this.protectedStart !== undefined) return this.protectedStart;
    const capability = CapabilitySchema.parse(capabilityInput);
    const child = this.start();
    const promise = new Promise<{ readonly child: ChildProcess; readonly port: number }>(
      (resolve, reject) => {
        if (child.stdin === null || child.stdout === null) {
          void this.requestStop(child).catch(() => undefined);
          reject(new Error("DAEMON_PROTECTED_PIPE_MISSING"));
          return;
        }
        let buffered = "";
        const timeout = setTimeout(() => {
          fail(new Error("DAEMON_READINESS_TIMEOUT"));
        }, 10_000);
        timeout.unref();
        const cleanup = () => {
          clearTimeout(timeout);
          child.stdout?.off("data", onData);
          child.off("error", onError);
          child.off("close", onClose);
        };
        const fail = (error: Error) => {
          cleanup();
          void this.requestStop(child).catch(() => undefined);
          reject(error);
        };
        function onError() {
          fail(new Error("DAEMON_START_FAILED"));
        }
        function onClose() {
          fail(new Error("DAEMON_EXITED_BEFORE_READY"));
        }
        function onData(chunk: Buffer | string) {
          buffered += chunk.toString();
          if (Buffer.byteLength(buffered, "utf8") > 1_024) {
            fail(new Error("DAEMON_READINESS_INVALID"));
            return;
          }
          const newline = buffered.indexOf("\n");
          if (newline < 0) return;
          const line = buffered.slice(0, newline).trimEnd();
          cleanup();
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            fail(new Error("DAEMON_READINESS_INVALID"));
            return;
          }
          const readiness = ReadinessSchema.safeParse(value);
          if (!readiness.success) {
            fail(new Error("DAEMON_READINESS_INVALID"));
            return;
          }
          resolve({ child, port: readiness.data.port });
        }
        child.stdout.on("data", onData);
        child.once("error", onError);
        child.once("close", onClose);
        child.stdin.end(`${capability}\n`, "utf8");
      },
    );
    this.protectedStart = promise;
    void promise.catch(() => {
      if (this.protectedStart === promise) this.protectedStart = undefined;
    });
    return promise;
  }

  private requestStop(child: ChildProcess): Promise<void> {
    const existing = this.stopCompletions.get(child);
    if (existing !== undefined) return existing;
    if (child.exitCode !== null && child.exitCode !== undefined) {
      return Promise.resolve();
    }
    const completion = new Promise<void>((resolve, reject) => {
      const timers: {
        escalation?: NodeJS.Timeout | undefined;
        failure?: NodeJS.Timeout | undefined;
      } = {};
      let closed = false;
      const cleanup = () => {
        if (timers.escalation !== undefined) {
          clearTimeout(timers.escalation);
        }
        if (timers.failure !== undefined) clearTimeout(timers.failure);
        child.off("close", onClose);
      };
      const onClose = () => {
        closed = true;
        cleanup();
        resolve();
      };
      const force = () => {
        if (closed) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // The final close event remains authoritative.
        }
        if (closed) return;
        timers.failure = setTimeout(() => {
          cleanup();
          reject(new Error("DAEMON_STOP_TIMEOUT"));
        }, 5_000);
        timers.failure.unref();
      };
      child.once("close", onClose);
      let terminationRequested = false;
      try {
        terminationRequested = child.kill("SIGTERM");
      } catch {
        // Escalate below; a thrown request is not proof of termination.
      }
      if (closed) return;
      if (!terminationRequested) {
        force();
        return;
      }
      timers.escalation = setTimeout(force, 5_000);
      timers.escalation.unref();
    });
    this.stopCompletions.set(child, completion);
    void completion.catch(() => {
      if (this.stopCompletions.get(child) === completion) {
        this.stopCompletions.delete(child);
      }
    });
    return completion;
  }

  stop(): Promise<void> {
    const ownedChild = this.child;
    if (ownedChild === undefined) return Promise.resolve();
    return this.requestStop(ownedChild);
  }
}
