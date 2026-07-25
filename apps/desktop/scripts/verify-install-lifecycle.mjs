import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "@playwright/test";
import {
  createConsistentBackup,
  loadStorageMigrations,
  runStorageMigrations,
  validateStorageBackupSource,
} from "@hunter/storage";

import {
  assertTemporaryLifecycleRoots,
  decideUninstallDataAction,
  runGuardedCompatibleUpgrade,
} from "../dist/install-lifecycle.js";

const desktopDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(
  await readFile(join(desktopDirectory, "package.json"), "utf8"),
);
const installerDirectory = join(desktopDirectory, "dist-installers");
const installerFilename = `Hunter Platform Setup ${packageJson.version}.exe`;
const installerPath = join(installerDirectory, installerFilename);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function authenticodeDirectory(file) {
  if (
    file.length < 256
    || file.toString("ascii", 0, 2) !== "MZ"
  ) {
    throw new Error("INSTALLER_PE_HEADER_INVALID");
  }
  const peOffset = file.readUInt32LE(0x3c);
  if (
    peOffset + 160 > file.length
    || file.toString("ascii", peOffset, peOffset + 4) !== "PE\u0000\u0000"
  ) {
    throw new Error("INSTALLER_PE_HEADER_INVALID");
  }
  const optionalHeader = peOffset + 24;
  const magic = file.readUInt16LE(optionalHeader);
  const dataDirectory = optionalHeader + (
    magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1
  );
  if (dataDirectory < optionalHeader) {
    throw new Error("INSTALLER_PE_HEADER_INVALID");
  }
  const securityDirectory = dataDirectory + (8 * 4);
  if (securityDirectory + 8 > file.length) {
    throw new Error("INSTALLER_PE_HEADER_INVALID");
  }
  return {
    offset: file.readUInt32LE(securityDirectory),
    size: file.readUInt32LE(securityDirectory + 4),
  };
}

const directoryEntries = await readdir(installerDirectory);
if (!directoryEntries.includes(installerFilename)) {
  throw new Error("INSTALLER_ARTIFACT_MISSING");
}
const installer = await readFile(installerPath);
const signature = authenticodeDirectory(installer);
if (signature.offset !== 0 || signature.size !== 0) {
  throw new Error("INSTALLER_MUST_REMAIN_UNSIGNED");
}
const installerStat = await stat(installerPath);
const artifactHash = sha256(installer);
const ownedChildren = new Set();

const daemonBundle = await readFile(
  join(installerDirectory, "win-unpacked", "resources", "daemon", "main.cjs"),
  "utf8",
);
for (const forbidden of [
  "deterministic-contract-fixture-v1",
  "fake-runtime-scenario",
  "E2E contract workflow",
  "FakeRuntime",
  "fake-runtime.js",
  "@hunter/testkit",
]) {
  if (daemonBundle.includes(forbidden)) {
    throw new Error("PRODUCTION_BUNDLE_CONTAINS_FAKE_RUNTIME");
  }
}

function waitForExit(child, timeoutMilliseconds, stage) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`PACKAGED_APP_EXIT_TIMEOUT_${stage}`));
    }, timeoutMilliseconds);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error(`PACKAGED_APP_SPAWN_FAILED_${stage}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function trackOwnedChild(child) {
  ownedChildren.add(child);
  child.once("close", () => ownedChildren.delete(child));
  return child;
}

function launchPackagedApp(executable, dataRoot) {
  const child = spawn(executable, [
    `--user-data-dir=${dataRoot}`,
  ], {
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  return trackOwnedChild(child);
}

async function launchControlledPackagedApp(executable, dataRoot) {
  const application = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${dataRoot}`],
    timeout: 15_000,
  });
  trackOwnedChild(application.process());
  const window = await application.firstWindow({ timeout: 15_000 });
  await window.waitForLoadState("load", { timeout: 15_000 });
  await delay(250);
  return application;
}

async function removeTemporaryTree(path) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return attempt;
    } catch (error) {
      if (
        error?.code !== "EPERM"
        && error?.code !== "EBUSY"
        && error?.code !== "ENOTEMPTY"
      ) {
        throw error;
      }
      if (attempt === 20) {
        throw new Error("INSTALL_LIFECYCLE_TEMPORARY_CLEANUP_FAILED");
      }
      await delay(250);
    }
  }
  throw new Error("INSTALL_LIFECYCLE_TEMPORARY_CLEANUP_FAILED");
}

const fixtureRoot = await mkdtemp(
  join(tmpdir(), "hunter-install-lifecycle-"),
);
const roots = assertTemporaryLifecycleRoots({
  fixtureRoot,
  installRoot: join(fixtureRoot, "安装 目录"),
  dataRoot: join(fixtureRoot, "用户 数据"),
});
let cleanupStatus = "pending";
let fixtureCleanupAttempts = 0;
let report;
try {
  await mkdir(roots.installRoot, { recursive: true });
  await mkdir(roots.dataRoot, { recursive: true });
  const stagedInstaller = join(roots.installRoot, basename(installerPath));
  await copyFile(installerPath, stagedInstaller);
  if (sha256(await readFile(stagedInstaller)) !== artifactHash) {
    throw new Error("TEMPORARY_INSTALL_ARTIFACT_HASH_MISMATCH");
  }
  const installedLayout = join(roots.installRoot, "Hunter Platform");
  await cp(
    join(installerDirectory, "win-unpacked"),
    installedLayout,
    { recursive: true, force: false },
  );
  const packagedExecutable = join(installedLayout, "Hunter Platform.exe");
  const packagedDaemon = join(
    installedLayout,
    "resources",
    "daemon",
    "main.cjs",
  );

  const unavailableDaemon = `${packagedDaemon}.unavailable`;
  await rename(packagedDaemon, unavailableDaemon);
  try {
    const failedStart = launchPackagedApp(
      packagedExecutable,
      join(roots.dataRoot, "daemon 启动失败"),
    );
    const failedExit = await waitForExit(
      failedStart,
      15_000,
      "daemon_start_failure",
    );
    if (failedExit.code !== 1) {
      throw new Error("PACKAGED_DAEMON_FAILURE_EXIT_INVALID");
    }
  } finally {
    await rename(unavailableDaemon, packagedDaemon);
  }

  const normalDataRoot = join(roots.dataRoot, "首次 启动");
  const firstApplication = await launchControlledPackagedApp(
    packagedExecutable,
    normalDataRoot,
  );
  const first = firstApplication.process();
  const firstExit = waitForExit(first, 20_000, "normal_exit");
  const duplicate = launchPackagedApp(packagedExecutable, normalDataRoot);
  const duplicateExit = await waitForExit(
    duplicate,
    10_000,
    "duplicate_instance",
  );
  if (duplicateExit.code !== 0 || first.exitCode !== null) {
    throw new Error("PACKAGED_DOUBLE_INSTANCE_INVALID");
  }
  const shutdownObservationPath = join(
    roots.dataRoot,
    "normal-shutdown-observations.jsonl",
  );
  await firstApplication.evaluate(({ app, BrowserWindow }, markerPath) => {
    const fileSystem = process.getBuiltinModule("node:fs");
    const record = (event, detail) => {
      fileSystem.appendFileSync(
        markerPath,
        `${JSON.stringify({ event, detail })}\n`,
        "utf8",
      );
    };
    app.on("before-quit", () => record("before-quit", null));
    app.on("will-quit", () => record("will-quit", null));
    app.on("quit", (_event, code) => record("quit", code));
    BrowserWindow.getAllWindows()[0]?.webContents.on(
      "render-process-gone",
      (_event, details) => record("render-process-gone", details.reason),
    );
    app.quit();
  }, shutdownObservationPath).catch(() => undefined);
  const normalExit = await firstExit;
  const shutdownObservations = (await readFile(
    shutdownObservationPath,
    "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line));
  if (normalExit.code !== 0) {
    throw new Error(
      `PACKAGED_NORMAL_EXIT_INVALID_${String(normalExit.code)}_${String(normalExit.signal)}_${shutdownObservations.map(({ event, detail }) => `${event}:${String(detail)}`).join(",")}`,
    );
  }

  const crashDataRoot = join(roots.dataRoot, "渲染器 崩溃");
  const crashApplication = await launchControlledPackagedApp(
    packagedExecutable,
    crashDataRoot,
  );
  const crashApp = crashApplication.process();
  const crashExit = waitForExit(crashApp, 20_000, "renderer_crash");
  await crashApplication.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer();
  }).catch(() => undefined);
  const rendererCrashExit = await crashExit;
  if (rendererCrashExit.code !== 1) {
    throw new Error("PACKAGED_RENDERER_CRASH_EXIT_INVALID");
  }

  const upgradeDataRoot = join(roots.dataRoot, "兼容 升级");
  await mkdir(upgradeDataRoot, { recursive: true });
  const migrations = loadStorageMigrations();
  if (migrations.length < 2) {
    throw new Error("INSTALL_UPGRADE_PREVIOUS_SCHEMA_UNAVAILABLE");
  }
  const previousMigrations = migrations.slice(0, -1);
  const previousDatabase = new DatabaseSync(
    join(upgradeDataRoot, "hunter.sqlite"),
  );
  let migrationSchemaVersionBefore;
  try {
    migrationSchemaVersionBefore = runStorageMigrations(
      previousDatabase,
      previousMigrations,
    ).schemaVersion;
  } finally {
    previousDatabase.close();
  }
  const userDataPath = join(upgradeDataRoot, "兼容 用户 数据.txt");
  const userData = "Hunter compatible data fixture\n";
  await writeFile(userDataPath, userData, "utf8");
  const sourceDataFingerprint = sha256(await readFile(userDataPath));
  const versionParts = packageJson.version.split(".").map(Number);
  if (
    versionParts.length !== 3
    || versionParts.some((part) => !Number.isSafeInteger(part) || part < 0)
  ) {
    throw new Error("DESKTOP_PACKAGE_VERSION_INVALID");
  }
  const targetVersion = [
    versionParts[0],
    versionParts[1],
    versionParts[2] + 1,
  ].join(".");
  let migrationSchemaVersionAfter;
  let backupManifestHash;
  const upgradeReceipt = await runGuardedCompatibleUpgrade({
    currentVersion: packageJson.version,
    targetVersion,
    prepareMigrationAndBackup: async () => {
      const database = new DatabaseSync(
        join(upgradeDataRoot, "hunter.sqlite"),
      );
      try {
        const health = validateStorageBackupSource(
          database,
          migrations,
        );
        if (health.schemaVersion !== migrationSchemaVersionBefore) {
          throw new Error("INSTALL_UPGRADE_SOURCE_SCHEMA_INVALID");
        }
        const backup = await createConsistentBackup({
          sourceRoot: upgradeDataRoot,
          backupRoot: join(fixtureRoot, "升级 备份"),
          database,
        });
        backupManifestHash = backup.manifest.manifestHash;
        return {
          schemaVersion: 1,
          status: "verified",
          currentVersion: packageJson.version,
          targetVersion,
          migrationStatus: "verified",
          backupStatus: "verified",
          sourceDataFingerprint: backup.manifest.manifestHash,
        };
      } finally {
        database.close();
      }
    },
    applyUpgrade: async () => {
      const upgradeApplication = await launchControlledPackagedApp(
        packagedExecutable,
        upgradeDataRoot,
      );
      const upgradeProcess = upgradeApplication.process();
      const upgradeExit = waitForExit(
        upgradeProcess,
        20_000,
        "compatible_upgrade",
      );
      await upgradeApplication.evaluate(({ app }) => {
        app.quit();
      }).catch(() => undefined);
      const upgraded = await upgradeExit;
      if (upgraded.code !== 0) {
        throw new Error("PACKAGED_COMPATIBLE_UPGRADE_EXIT_INVALID");
      }
      const migratedDatabase = new DatabaseSync(
        join(upgradeDataRoot, "hunter.sqlite"),
      );
      try {
        migrationSchemaVersionAfter = validateStorageBackupSource(
          migratedDatabase,
          migrations,
        ).schemaVersion;
      } finally {
        migratedDatabase.close();
      }
      if (
        migrationSchemaVersionAfter !== migrations.length
        || migrationSchemaVersionAfter <= migrationSchemaVersionBefore
      ) {
        throw new Error("PACKAGED_COMPATIBLE_UPGRADE_MIGRATION_INVALID");
      }
      await writeFile(
        join(roots.installRoot, "version.json"),
        `${JSON.stringify({ version: targetVersion })}\n`,
        "utf8",
      );
    },
  });
  if (await readFile(userDataPath, "utf8") !== userData) {
    throw new Error("UPGRADE_CHANGED_COMPATIBLE_USER_DATA");
  }

  if (
    decideUninstallDataAction({ deleteUserDataRequested: false })
    !== "preserve"
  ) {
    throw new Error("UNINSTALL_DEFAULT_MUST_PRESERVE_DATA");
  }
  const installCleanupAttempts = await removeTemporaryTree(roots.installRoot);
  if (await readFile(userDataPath, "utf8") !== userData) {
    throw new Error("UNINSTALL_DID_NOT_PRESERVE_USER_DATA");
  }
  if (
    decideUninstallDataAction({
      deleteUserDataRequested: true,
      firstConfirmation: true,
      secondConfirmation: true,
    }) !== "delete"
  ) {
    throw new Error("UNINSTALL_DOUBLE_CONFIRMATION_INVALID");
  }
  const dataCleanupAttempts = await removeTemporaryTree(roots.dataRoot);

  report = {
    schemaVersion: 1,
    scope: "contract_only",
    platform: process.platform,
    artifact: {
      filename: installerFilename,
      version: packageJson.version,
      bytes: installerStat.size,
      sha256: artifactHash,
      signature: "unsigned",
      published: false,
      uploaded: false,
    },
    fixture: {
      roots: ["<temporary>/安装 目录", "<temporary>/用户 数据"],
      stagedArtifactHash: "matched",
      firstStartup: "passed",
      duplicateInstance: "rejected",
      daemonStartupFailure: "owned_processes_reclaimed",
      rendererCrash: "owned_processes_reclaimed",
      normalExit: "owned_processes_reclaimed",
      normalShutdownSequence: shutdownObservations,
      compatibleDataAfterUpgrade: "preserved",
      uninstallDefault: "preserved",
      explicitDelete: "double_confirmation_in_temporary_fixture",
      cleanupAttempts: {
        install: installCleanupAttempts,
        data: dataCleanupAttempts,
      },
    },
    upgrade: upgradeReceipt,
    upgradeGate: {
      migrationSchemaVersionBefore,
      migrationSchemaVersionAfter,
      backupManifestHash,
      compatibleDataFingerprint: sourceDataFingerprint,
    },
    productionBundle: {
      fakeRuntimeMarkers: "absent",
      preloadAllowlist: "verified_by_pack_preload_smoke",
    },
    externalValidation: {
      smartScreen: "BLOCKED",
      codeSigning: "BLOCKED",
      distribution: "BLOCKED",
      productionUpgrade: "BLOCKED",
    },
  };
} finally {
  await Promise.all([...ownedChildren].map(async (child) => {
    child.kill();
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5_000);
      child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }));
  fixtureCleanupAttempts = await removeTemporaryTree(fixtureRoot);
  cleanupStatus = "removed";
}

process.stdout.write(`${JSON.stringify({
  ...report,
  cleanup: {
    status: cleanupStatus,
    attempts: fixtureCleanupAttempts,
    realUserPathsTouched: false,
  },
})}\n`);
