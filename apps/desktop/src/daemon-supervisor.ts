import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type SpawnDaemon = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

const DAEMON_ARGUMENTS = ["--port=0", "--bootstrap-stdin"] as const;
const DAEMON_ENVIRONMENT = Object.freeze({ ELECTRON_RUN_AS_NODE: "1" });

export class DaemonSupervisor {
  private child: ChildProcess | undefined;
  private readonly stopRequested = new WeakSet<ChildProcess>();

  constructor(
    private readonly spawn: SpawnDaemon = nodeSpawn,
    private readonly daemonEntry: string,
    private readonly runtimeExecutable: string = process.execPath,
  ) {}

  start(): ChildProcess {
    if (this.child !== undefined) return this.child;

    const candidate = this.spawn(
      this.runtimeExecutable,
      [this.daemonEntry, ...DAEMON_ARGUMENTS],
      {
        env: DAEMON_ENVIRONMENT,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let ended = false;
    const release = () => {
      ended = true;
      if (this.child === candidate) this.child = undefined;
    };
    try {
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

  stop(): void {
    const ownedChild = this.child;
    if (ownedChild === undefined || this.stopRequested.has(ownedChild)) return;
    this.stopRequested.add(ownedChild);
    ownedChild.kill("SIGTERM");
  }
}
