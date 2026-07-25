import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  acquireDesktopInstance,
  assertTemporaryLifecycleRoots,
  decideUninstallDataAction,
  isRendererFailure,
  ownsDesktopExit,
  OwnedDesktopProcessLifecycle,
  runGuardedCompatibleUpgrade,
} from "./install-lifecycle.js";

describe("desktop install lifecycle", () => {
  it("claims the first instance and focuses it when a second launch arrives", () => {
    let secondInstance: (() => void) | undefined;
    const app = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((event: "second-instance", listener: () => void) => {
        expect(event).toBe("second-instance");
        secondInstance = listener;
      }),
      quit: vi.fn(),
    };
    const focusExisting = vi.fn();

    expect(acquireDesktopInstance(app, focusExisting)).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();
    expect(focusExisting).not.toHaveBeenCalled();

    secondInstance?.();
    expect(focusExisting).toHaveBeenCalledOnce();
  });

  it("quits a duplicate before registering lifecycle handlers or starting owned work", () => {
    const app = {
      requestSingleInstanceLock: vi.fn(() => false),
      on: vi.fn(),
      quit: vi.fn(),
    };
    const focusExisting = vi.fn();

    expect(acquireDesktopInstance(app, focusExisting)).toBe(false);
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.on).not.toHaveBeenCalled();
    expect(focusExisting).not.toHaveBeenCalled();
  });

  it.each([
    "daemon_start_failed",
    "renderer_crashed",
    "normal_exit",
  ] as const)("reclaims the owned sidecar exactly once after %s", async (reason) => {
    const stopOwned = vi.fn();
    const lifecycle = new OwnedDesktopProcessLifecycle(stopOwned);

    await expect(lifecycle.stop(reason)).resolves.toEqual({
      schemaVersion: 1,
      status: "stopped",
      reason,
    });
    await expect(lifecycle.stop("normal_exit")).resolves.toEqual({
      schemaVersion: 1,
      status: "already_stopped",
      reason: "normal_exit",
    });
    expect(stopOwned).toHaveBeenCalledOnce();
  });

  it("does not classify a clean renderer exit as a crash", () => {
    expect(isRendererFailure("clean-exit")).toBe(false);
    expect(isRendererFailure("crashed")).toBe(true);
    expect(isRendererFailure("oom")).toBe(true);
    expect(isRendererFailure("integrity-failure")).toBe(true);
  });

  it("keeps a normal shutdown authoritative over a later renderer observation", async () => {
    let release: (() => void) | undefined;
    const stopOwned = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const lifecycle = new OwnedDesktopProcessLifecycle(stopOwned);

    const normal = lifecycle.stop("normal_exit");
    const renderer = lifecycle.stop("renderer_crashed");
    await Promise.resolve();
    expect(stopOwned).toHaveBeenCalledOnce();
    release?.();
    await expect(normal).resolves.toMatchObject({ status: "stopped" });
    await expect(renderer).resolves.toMatchObject({
      status: "already_stopped",
    });
    expect(stopOwned).toHaveBeenCalledOnce();
  });

  it("keeps a failure-first shutdown authoritative over a later normal quit", async () => {
    let release: (() => void) | undefined;
    const lifecycle = new OwnedDesktopProcessLifecycle(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const failure = lifecycle.stop("daemon_start_failed");
    const normal = lifecycle.stop("normal_exit");
    await Promise.resolve();
    release?.();

    const failureReceipt = await failure;
    const normalReceipt = await normal;
    expect(ownsDesktopExit(failureReceipt)).toBe(true);
    expect(ownsDesktopExit(normalReceipt)).toBe(false);
  });

  it("does not claim stopped and permits retry when owned-process cleanup fails", async () => {
    const stopOwned = vi.fn()
      .mockRejectedValueOnce(new Error("OWNED_PROCESS_STILL_RUNNING"))
      .mockResolvedValueOnce(undefined);
    const lifecycle = new OwnedDesktopProcessLifecycle(stopOwned);

    await expect(lifecycle.stop("normal_exit")).rejects.toThrowError(
      "OWNED_PROCESS_STILL_RUNNING",
    );
    await expect(lifecycle.stop("normal_exit")).resolves.toMatchObject({
      status: "stopped",
    });
    expect(stopOwned).toHaveBeenCalledTimes(2);
  });

  it("wires every owned-process stop observation into the Electron main boundary", async () => {
    const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");

    expect(source).toContain("acquireDesktopInstance(app, focusExistingWindow)");
    expect(source).toContain('lifecycle.stop("daemon_start_failed")');
    expect(source).toContain('lifecycle.stop("renderer_crashed")');
    expect(source).toContain('lifecycle.stop("normal_exit")');
  });

  it("accepts only distinct install and data roots inside an automated temporary fixture", () => {
    const fixtureRoot = "C:\\Temp\\hunter-install-lifecycle-abc";
    expect(assertTemporaryLifecycleRoots({
      fixtureRoot,
      installRoot: `${fixtureRoot}\\安装 目录`,
      dataRoot: `${fixtureRoot}\\用户 数据`,
    })).toEqual({
      fixtureRoot,
      installRoot: `${fixtureRoot}\\安装 目录`,
      dataRoot: `${fixtureRoot}\\用户 数据`,
    });

    expect(() => assertTemporaryLifecycleRoots({
      fixtureRoot,
      installRoot: "C:\\Program Files\\Hunter Platform",
      dataRoot: `${fixtureRoot}\\用户 数据`,
    })).toThrowError("INSTALL_LIFECYCLE_ROOT_OUTSIDE_FIXTURE");
    expect(() => assertTemporaryLifecycleRoots({
      fixtureRoot,
      installRoot: `${fixtureRoot}\\same`,
      dataRoot: `${fixtureRoot}\\same`,
    })).toThrowError("INSTALL_LIFECYCLE_ROOTS_OVERLAP");
  });

  it("runs the verified migration and backup gate before applying an upgrade", async () => {
    const order: string[] = [];
    const receipt = await runGuardedCompatibleUpgrade({
      currentVersion: "0.1.0",
      targetVersion: "0.2.0",
      prepareMigrationAndBackup: async () => {
        order.push("gate");
        return {
          schemaVersion: 1,
          status: "verified",
          currentVersion: "0.1.0",
          targetVersion: "0.2.0",
          migrationStatus: "verified",
          backupStatus: "verified",
          sourceDataFingerprint: "a".repeat(64),
        };
      },
      applyUpgrade: async () => {
        order.push("upgrade");
      },
    });

    expect(order).toEqual(["gate", "upgrade"]);
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      status: "upgraded",
      currentVersion: "0.1.0",
      targetVersion: "0.2.0",
      sourceDataFingerprint: "a".repeat(64),
    });
  });

  it("fails closed without changing the installation when the upgrade gate is incomplete", async () => {
    const applyUpgrade = vi.fn(async () => undefined);

    await expect(runGuardedCompatibleUpgrade({
      currentVersion: "0.1.0",
      targetVersion: "0.2.0",
      prepareMigrationAndBackup: async () => ({
        schemaVersion: 1,
        status: "verified",
        currentVersion: "0.1.0",
        targetVersion: "0.2.0",
        migrationStatus: "verified",
        backupStatus: "missing",
        sourceDataFingerprint: "a".repeat(64),
      }),
      applyUpgrade,
    })).rejects.toThrowError("INSTALL_UPGRADE_GATE_INVALID");
    expect(applyUpgrade).not.toHaveBeenCalled();
  });

  it("rejects a mismatched or extensible upgrade gate receipt", async () => {
    const applyUpgrade = vi.fn(async () => undefined);
    const base = {
      schemaVersion: 1 as const,
      status: "verified" as const,
      currentVersion: "0.1.0",
      targetVersion: "0.2.0",
      migrationStatus: "verified" as const,
      backupStatus: "verified" as const,
      sourceDataFingerprint: "b".repeat(64),
    };

    await expect(runGuardedCompatibleUpgrade({
      currentVersion: "0.1.0",
      targetVersion: "0.3.0",
      prepareMigrationAndBackup: async () => base,
      applyUpgrade,
    })).rejects.toThrowError("INSTALL_UPGRADE_GATE_INVALID");
    await expect(runGuardedCompatibleUpgrade({
      currentVersion: "0.1.0",
      targetVersion: "0.2.0",
      prepareMigrationAndBackup: async () => ({
        ...base,
        providerPrivate: "must-not-cross-the-gate",
      }),
      applyUpgrade,
    })).rejects.toThrowError("INSTALL_UPGRADE_GATE_INVALID");
    expect(applyUpgrade).not.toHaveBeenCalled();
  });

  it("rejects a downgrade even when its migration and backup receipt is otherwise valid", async () => {
    const applyUpgrade = vi.fn(async () => undefined);

    await expect(runGuardedCompatibleUpgrade({
      currentVersion: "1.2.3",
      targetVersion: "1.2.2",
      prepareMigrationAndBackup: async () => ({
        schemaVersion: 1,
        status: "verified",
        currentVersion: "1.2.3",
        targetVersion: "1.2.2",
        migrationStatus: "verified",
        backupStatus: "verified",
        sourceDataFingerprint: "c".repeat(64),
      }),
      applyUpgrade,
    })).rejects.toThrowError("INSTALL_UPGRADE_GATE_INVALID");
    expect(applyUpgrade).not.toHaveBeenCalled();
  });

  it("preserves user data by default and requires two confirmations to delete it", () => {
    expect(decideUninstallDataAction({ deleteUserDataRequested: false }))
      .toBe("preserve");
    expect(() => decideUninstallDataAction({
      deleteUserDataRequested: true,
      firstConfirmation: true,
      secondConfirmation: false,
    })).toThrowError("UNINSTALL_DATA_DELETE_CONFIRMATION_REQUIRED");
    expect(decideUninstallDataAction({
      deleteUserDataRequested: true,
      firstConfirmation: true,
      secondConfirmation: true,
    })).toBe("delete");
  });
});
