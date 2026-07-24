import type { CurrentCapabilityProbeReceipt } from "@hunter/runtime-contracts";

export type LocalProbeStatus = "DETECTED" | "BLOCKED" | "NOT_PROVEN";

export interface LocalProviderProbe {
  readonly availability: LocalProbeStatus;
  readonly authentication: LocalProbeStatus;
  readonly version: string | null;
}

function comparableVersion(value: string): string {
  const semantic = value.match(
    /\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/u,
  )?.[0];
  return (semantic ?? value.trim()).toLowerCase().replace(/^v/u, "");
}

export function assertLocalProbeMatchesReceipt(
  connector: string,
  probe: LocalProviderProbe,
  receipt: CurrentCapabilityProbeReceipt,
): void {
  if (
    probe.availability !== "DETECTED"
    || receipt.executable.status !== "available"
  ) {
    throw new Error(`REAL_PROVIDER_EXECUTABLE_NOT_DETECTED:${connector}`);
  }
  if (
    probe.version === null
    || receipt.productVersion.observed === null
    || comparableVersion(probe.version)
      !== comparableVersion(receipt.productVersion.observed)
  ) {
    throw new Error(`REAL_PROVIDER_VERSION_MISMATCH:${connector}`);
  }
  const expectedAuthentication: LocalProbeStatus =
    receipt.loginState === "authenticated"
    || receipt.loginState === "not_required"
      ? "DETECTED"
      : receipt.loginState === "unauthenticated"
        ? "BLOCKED"
        : "NOT_PROVEN";
  if (probe.authentication !== expectedAuthentication) {
    throw new Error(`REAL_PROVIDER_LOGIN_STATE_MISMATCH:${connector}`);
  }
}
