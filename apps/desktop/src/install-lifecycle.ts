import { posix, win32 } from "node:path";

import { z } from "zod";

export interface DesktopInstancePort {
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance", listener: () => void): unknown;
  quit(): void;
}

export function acquireDesktopInstance(
  app: DesktopInstancePort,
  focusExisting: () => void,
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", focusExisting);
  return true;
}

export type DesktopStopReason =
  | "daemon_start_failed"
  | "renderer_crashed"
  | "normal_exit";

export function isRendererFailure(reason: string): boolean {
  return reason !== "clean-exit";
}

export interface DesktopStopReceipt {
  readonly schemaVersion: 1;
  readonly status: "stopped" | "already_stopped";
  readonly reason: DesktopStopReason;
}

export function ownsDesktopExit(receipt: DesktopStopReceipt): boolean {
  return receipt.status === "stopped";
}

export class OwnedDesktopProcessLifecycle {
  private stopped = false;
  private stopping: Promise<void> | undefined;

  constructor(private readonly stopOwned: () => Promise<void> | void) {}

  async stop(reason: DesktopStopReason): Promise<DesktopStopReceipt> {
    if (this.stopped) {
      return { schemaVersion: 1, status: "already_stopped", reason };
    }
    if (this.stopping !== undefined) {
      await this.stopping;
      return { schemaVersion: 1, status: "already_stopped", reason };
    }
    const attempt = Promise.resolve().then(async () => await this.stopOwned());
    this.stopping = attempt;
    try {
      await attempt;
      this.stopped = true;
      return { schemaVersion: 1, status: "stopped", reason };
    } finally {
      if (this.stopping === attempt) this.stopping = undefined;
    }
  }
}

export interface TemporaryLifecycleRoots {
  readonly fixtureRoot: string;
  readonly installRoot: string;
  readonly dataRoot: string;
}

function pathApi(path: string): typeof win32 | typeof posix {
  return win32.isAbsolute(path) ? win32 : posix;
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const api = pathApi(root);
  if (!api.isAbsolute(root) || !api.isAbsolute(candidate)) return false;
  const normalizedRoot = api.resolve(root);
  const normalizedCandidate = api.resolve(candidate);
  const relative = api.relative(normalizedRoot, normalizedCandidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${api.sep}`)
    && !api.isAbsolute(relative);
}

export function assertTemporaryLifecycleRoots(
  input: TemporaryLifecycleRoots,
): TemporaryLifecycleRoots {
  const api = pathApi(input.fixtureRoot);
  const normalizedInstall = api.resolve(input.installRoot);
  const normalizedData = api.resolve(input.dataRoot);
  const samePath = api === win32
    ? normalizedInstall.toLowerCase() === normalizedData.toLowerCase()
    : normalizedInstall === normalizedData;
  if (
    !api.basename(api.resolve(input.fixtureRoot))
      .startsWith("hunter-install-lifecycle-")
  ) {
    throw new Error("INSTALL_LIFECYCLE_FIXTURE_ROOT_INVALID");
  }
  if (
    !isStrictDescendant(input.fixtureRoot, input.installRoot)
    || !isStrictDescendant(input.fixtureRoot, input.dataRoot)
  ) {
    throw new Error("INSTALL_LIFECYCLE_ROOT_OUTSIDE_FIXTURE");
  }
  if (
    samePath
    || isStrictDescendant(input.installRoot, input.dataRoot)
    || isStrictDescendant(input.dataRoot, input.installRoot)
  ) {
    throw new Error("INSTALL_LIFECYCLE_ROOTS_OVERLAP");
  }
  return Object.freeze({ ...input });
}

const UpgradeGateReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("verified"),
  currentVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  targetVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  migrationStatus: z.literal("verified"),
  backupStatus: z.literal("verified"),
  sourceDataFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});

export interface GuardedCompatibleUpgradeInput {
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly prepareMigrationAndBackup: () => Promise<unknown>;
  readonly applyUpgrade: () => Promise<void>;
}

function isVersionIncrease(currentVersion: string, targetVersion: string) {
  const current = currentVersion.split(".").map(Number);
  const target = targetVersion.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const currentPart = current[index] ?? Number.NaN;
    const targetPart = target[index] ?? Number.NaN;
    if (targetPart > currentPart) return true;
    if (targetPart < currentPart) return false;
  }
  return false;
}

export async function runGuardedCompatibleUpgrade(
  input: GuardedCompatibleUpgradeInput,
) {
  const parsed = UpgradeGateReceiptSchema.safeParse(
    await input.prepareMigrationAndBackup(),
  );
  if (
    !parsed.success
    || parsed.data.currentVersion !== input.currentVersion
    || parsed.data.targetVersion !== input.targetVersion
    || !isVersionIncrease(input.currentVersion, input.targetVersion)
  ) {
    throw new Error("INSTALL_UPGRADE_GATE_INVALID");
  }
  await input.applyUpgrade();
  return Object.freeze({
    schemaVersion: 1 as const,
    status: "upgraded" as const,
    currentVersion: parsed.data.currentVersion,
    targetVersion: parsed.data.targetVersion,
    sourceDataFingerprint: parsed.data.sourceDataFingerprint,
  });
}

export interface UninstallDataDecisionInput {
  readonly deleteUserDataRequested: boolean;
  readonly firstConfirmation?: boolean | undefined;
  readonly secondConfirmation?: boolean | undefined;
}

export function decideUninstallDataAction(
  input: UninstallDataDecisionInput,
): "preserve" | "delete" {
  if (!input.deleteUserDataRequested) return "preserve";
  if (
    input.firstConfirmation !== true
    || input.secondConfirmation !== true
  ) {
    throw new Error("UNINSTALL_DATA_DELETE_CONFIRMATION_REQUIRED");
  }
  return "delete";
}
