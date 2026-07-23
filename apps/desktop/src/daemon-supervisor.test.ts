import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { DaemonSupervisor, type SpawnDaemon } from "./daemon-supervisor.js";

class FakeChild extends EventEmitter {
  readonly kill = vi.fn(() => true);
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
        env: { ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
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
});
