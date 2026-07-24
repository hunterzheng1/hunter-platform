import { useEffect, useState } from "react";

import type {
  MobileCommandEnvelope,
  MobileCommandResult,
} from "@hunter/device-gateway/mobile-contracts";

import {
  MobileCockpitWithOutbox,
  MobileUnavailablePage,
} from "../pages/mobile-cockpit.js";
import type { MobileCommandOutbox } from "./command-outbox.js";
import type { MobileRuntimeSnapshot } from "./mobile-runtime.js";

export interface MobileApplicationRuntime {
  connect(): Promise<MobileRuntimeSnapshot>;
  pollEvents(): Promise<MobileRuntimeSnapshot>;
  beginPairing(input: {
    readonly pairingId: string;
    readonly challenge: string;
    readonly deviceName: string;
  }): Promise<{
    readonly status: "pending_desktop_confirmation";
    readonly pairingId: string;
    readonly expiresAt: string;
    readonly keyId: string;
  }>;
  completePairing(input: {
    readonly pairingId: string;
    readonly challenge: string;
    readonly keyId: string;
  }): Promise<MobileRuntimeSnapshot>;
  execute(command: MobileCommandEnvelope): Promise<MobileCommandResult>;
}

export function MobileApplication({
  runtime,
  outbox,
}: {
  readonly runtime: MobileApplicationRuntime;
  readonly outbox: Pick<MobileCommandOutbox, "submit">;
}) {
  const [snapshot, setSnapshot] = useState<MobileRuntimeSnapshot>();
  const [pairingId, setPairingId] = useState("");
  const [challenge, setChallenge] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [pending, setPending] = useState<{
    readonly pairingId: string;
    readonly challenge: string;
    readonly keyId: string;
    readonly expiresAt: string;
  }>();
  const [pairingError, setPairingError] = useState(false);
  useEffect(() => {
    let active = true;
    void runtime.connect()
      .then((connected) => {
        if (active) setSnapshot(connected);
      })
      .catch(() => {
        if (active) setSnapshot({ state: "unpaired" });
      });
    return () => {
      active = false;
    };
  }, [runtime]);
  useEffect(() => {
    if (snapshot?.state !== "connected") return;
    let active = true;
    const poll = async () => {
      try {
        const latest = await runtime.pollEvents();
        if (active) setSnapshot(latest);
      } catch {
        // Preserve the last authenticated projection across transient network loss.
      }
    };
    void poll();
    const pollTimer = setInterval(() => void poll(), 3_000);
    return () => {
      active = false;
      clearInterval(pollTimer);
    };
  }, [runtime, snapshot?.state]);

  if (snapshot === undefined) return <MobileUnavailablePage />;
  if (snapshot.state === "unpaired") {
    return (
      <main className="mobile-cockpit">
        <h1>安全配对</h1>
        {pending === undefined
          ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setPairingError(false);
                  void runtime.beginPairing({ pairingId, challenge, deviceName })
                    .then((result) => setPending({
                      pairingId: result.pairingId,
                      challenge,
                      keyId: result.keyId,
                      expiresAt: result.expiresAt,
                    }))
                    .catch(() => setPairingError(true));
                }}
              >
                <label>配对 ID<input value={pairingId} onChange={(event) => setPairingId(event.target.value)} /></label>
                <label>配对挑战<input value={challenge} onChange={(event) => setChallenge(event.target.value)} /></label>
                <label>设备名称<input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} /></label>
                <button type="submit">提交设备证明</button>
              </form>
            )
          : (
              <section>
                <p>等待桌面端确认；挑战将在 {pending.expiresAt} 过期。</p>
                <button
                  type="button"
                  onClick={() => {
                    setPairingError(false);
                    void runtime.completePairing({
                      pairingId: pending.pairingId,
                      challenge: pending.challenge,
                      keyId: pending.keyId,
                    })
                      .then(setSnapshot)
                      .catch(() => setPairingError(true));
                  }}
                >
                  完成配对
                </button>
              </section>
            )}
        {pairingError ? <p role="alert">配对尚未完成或已失效。</p> : null}
      </main>
    );
  }
  return (
    <MobileCockpitWithOutbox
      runs={snapshot.runs}
      outbox={outbox}
      transport={async (command) => await runtime.execute(command)}
    />
  );
}
