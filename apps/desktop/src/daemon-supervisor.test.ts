import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { DaemonSupervisor, type SpawnDaemon } from "./daemon-supervisor.js";

class FakeChild extends EventEmitter {
  readonly kill = vi.fn(() => true);
}

class FakeProtectedChild extends FakeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

describe("DaemonSupervisor", () => {
  it("starts hunterd once with the fixed protected-pipe process boundary", () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child) as unknown as SpawnDaemon;
    const supervisor = new DaemonSupervisor(spawn, "C:\\Hunter\\daemon\\src\\main.js", "C:\\Hunter\\electron.exe");

    expect(supervisor.start()).toBe(child);
    expect(supervisor.start()).toBe(child);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      "C:\\Hunter\\electron.exe",
      ["C:\\Hunter\\daemon\\src\\main.js", "--port=0", "--bootstrap-stdin"],
      {
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          ...(process.platform === "win32" && process.env.SystemRoot !== undefined
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          ...(process.platform === "win32" && process.env.WINDIR !== undefined
            ? { WINDIR: process.env.WINDIR }
            : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  });

  it("passes only the owned desktop data directory through the child environment", () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child) as unknown as SpawnDaemon;
    const supervisor = new DaemonSupervisor(
      spawn,
      "C:\\Hunter\\daemon\\main.cjs",
      "C:\\Hunter\\electron.exe",
      "C:\\Users\\owner\\AppData\\Roaming\\Hunter",
    );

    supervisor.start();

    expect(spawn).toHaveBeenCalledWith(
      "C:\\Hunter\\electron.exe",
      ["C:\\Hunter\\daemon\\main.cjs", "--port=0", "--bootstrap-stdin"],
      expect.objectContaining({
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: "1",
          HUNTER_DESKTOP_DATA_DIRECTORY:
            "C:\\Users\\owner\\AppData\\Roaming\\Hunter",
        }),
      }),
    );
  });

  it("terminates only its owned child once and waits for exit before restarting", () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) as unknown as SpawnDaemon;
    const supervisor = new DaemonSupervisor(spawn, "daemon.js", "electron.exe");

    expect(supervisor.start()).toBe(first);
    supervisor.stop();
    supervisor.stop();
    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
    expect(supervisor.start()).toBe(first);

    first.emit("exit", 0, null);
    expect(supervisor.start()).toBe(second);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("waits for close after an asynchronous spawn error before restarting", () => {
    const failed = new FakeChild();
    const replacement = new FakeChild();
    const spawn = vi.fn().mockReturnValueOnce(failed).mockReturnValueOnce(replacement) as unknown as SpawnDaemon;
    const supervisor = new DaemonSupervisor(spawn, "daemon.js", "electron.exe");

    expect(supervisor.start()).toBe(failed);
    failed.emit("error", new Error("spawn failed"));
    expect(supervisor.start()).toBe(failed);

    failed.emit("close", 1, null);
    expect(supervisor.start()).toBe(replacement);
    failed.emit("exit", 1, null);
    expect(supervisor.start()).toBe(replacement);
  });

  it("retains ownership after a post-spawn process error until the child exits", () => {
    const running = new FakeChild();
    const replacement = new FakeChild();
    const spawn = vi.fn().mockReturnValueOnce(running).mockReturnValueOnce(replacement) as unknown as SpawnDaemon;
    const supervisor = new DaemonSupervisor(spawn, "daemon.js", "electron.exe");

    expect(supervisor.start()).toBe(running);
    running.emit("spawn");
    running.emit("error", new Error("kill failed"));

    expect(supervisor.start()).toBe(running);
    expect(spawn).toHaveBeenCalledOnce();
    supervisor.stop();
    expect(running.kill).toHaveBeenCalledWith("SIGTERM");

    running.emit("exit", 1, null);
    expect(supervisor.start()).toBe(replacement);
  });

  it("does not retain a child when spawn throws synchronously", () => {
    const child = new FakeChild();
    const spawn = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("spawn threw");
      })
      .mockReturnValueOnce(child) as unknown as SpawnDaemon;
    const supervisor = new DaemonSupervisor(spawn, "daemon.js", "electron.exe");

    expect(() => supervisor.start()).toThrowError("spawn threw");
    expect(supervisor.start()).toBe(child);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("terminates and releases a spawned child when lifecycle listener registration throws", () => {
    const unobservable = new FakeChild();
    unobservable.once = vi.fn(() => {
      throw new Error("listener registration failed");
    }) as never;
    const replacement = new FakeChild();
    const spawn = vi.fn().mockReturnValueOnce(unobservable).mockReturnValueOnce(replacement) as unknown as SpawnDaemon;
    const supervisor = new DaemonSupervisor(spawn, "daemon.js", "electron.exe");

    expect(() => supervisor.start()).toThrowError("listener registration failed");
    expect(unobservable.kill).toHaveBeenCalledOnce();
    expect(unobservable.kill).toHaveBeenCalledWith("SIGTERM");
    expect(supervisor.start()).toBe(replacement);
  });

  it("delivers a fresh capability only through stdin and accepts secret-free readiness", async () => {
    const capability = "A".repeat(43);
    const first = new FakeProtectedChild();
    const second = new FakeProtectedChild();
    const spawn = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const supervisor = new DaemonSupervisor(
      spawn as unknown as SpawnDaemon,
      "daemon.js",
      "electron.exe",
    );

    const firstStart = supervisor.startProtected(capability);
    first.stdout.write('{"schemaVersion":1,"kind":"hunterd-ready","port":43101}\n');
    const firstReady = await firstStart;
    expect(firstReady).toMatchObject({ child: first, port: 43101 });
    expect(first.stdin.read()?.toString()).toBe(`${capability}\n`);

    const [command, args, options] = spawn.mock.calls[0] as unknown as [
      string,
      readonly string[],
      { readonly env?: Readonly<Record<string, string>> },
    ];
    expect(command).toBe("electron.exe");
    expect(JSON.stringify({ args, env: options.env })).not.toContain(capability);

    first.emit("exit", 0, null);
    const secondStart = supervisor.startProtected("B".repeat(43));
    second.stdout.write('{"schemaVersion":1,"kind":"hunterd-ready","port":43102}\n');
    const secondReady = await secondStart;
    expect(secondReady).toMatchObject({ child: second, port: 43102 });
    expect(secondReady.port).not.toBe(firstReady.port);
  });

  it("rejects a readiness record containing an unexpected secret field", async () => {
    const child = new FakeProtectedChild();
    const spawn = vi.fn(() => child) as unknown as SpawnDaemon;
    const supervisor = new DaemonSupervisor(spawn, "daemon.js", "electron.exe");

    const started = supervisor.startProtected("C".repeat(43));
    child.stdout.write(
      '{"schemaVersion":1,"kind":"hunterd-ready","port":43103,"capability":"redacted"}\n',
    );

    await expect(started).rejects.toThrowError("DAEMON_READINESS_INVALID");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
