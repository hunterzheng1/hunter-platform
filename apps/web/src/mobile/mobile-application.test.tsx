// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MobileCommandEnvelopeSchema,
  MobileCommandResultSchema,
  MobileRunProjectionSchema,
} from "@hunter/device-gateway";

import { MobileApplication } from "./mobile-application.js";

afterEach(cleanup);

describe("mobile application composition", () => {
  it("connects the runtime and routes the complete command through the durable outbox", async () => {
    const command = MobileCommandEnvelopeSchema.parse({
      projectId: "prj_mobile00001",
      runId: "run_mobile00001",
      stepRunId: "spr_mobile00001",
      expectedVersion: 2,
      idempotencyKey: "mobile-application-pause-0001",
      action: "pause_run",
      payload: {},
    });
    const projection = MobileRunProjectionSchema.parse({
      projectId: command.projectId,
      runId: command.runId,
      projectName: "Composed mobile project",
      currentStep: "agent:planning-agent",
      attention: "Run is running",
      connection: "online",
      commands: [command],
    });
    const runtime = {
      connect: vi.fn(async () => ({ state: "connected" as const, runs: [projection] })),
      pollEvents: vi.fn(async () => ({ state: "connected" as const, runs: [projection] })),
      beginPairing: vi.fn(),
      completePairing: vi.fn(),
      execute: vi.fn(async () => ({
        status: "accepted" as const,
        receipt: {
          commandId: "ApplyRunControl:mobile-application-pause-0001",
          response: { status: "accepted" },
        },
      })),
    };
    const outbox = {
      submit: vi.fn(async (
        candidate: unknown,
        transport: (value: typeof command) => Promise<unknown>,
      ) => MobileCommandResultSchema.parse(
        await transport(candidate as typeof command),
      )),
    };

    render(<MobileApplication runtime={runtime} outbox={outbox} />);
    expect(await screen.findByText("Composed mobile project")).not.toBeNull();
    await waitFor(() => expect(runtime.pollEvents).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));

    expect(outbox.submit).toHaveBeenCalledWith(command, expect.any(Function));
    expect(runtime.execute).toHaveBeenCalledWith(command);
  });

  it("offers an explicit proof-based bootstrap when no device binding can be restored", async () => {
    const beginPairing = vi.fn(async () => ({
      status: "pending_desktop_confirmation" as const,
      pairingId: "pair_0123456789abcdef01234567",
      expiresAt: "2026-07-24T00:05:00.000Z",
      keyId: "key_mobile-application-test",
    }));
    const completePairing = vi.fn(async () => ({
      state: "connected" as const,
      runs: [],
    }));
    render(
      <MobileApplication
        runtime={{
          connect: vi.fn(async () => ({ state: "unpaired" as const })),
          pollEvents: vi.fn(),
          beginPairing,
          completePairing,
          execute: vi.fn(),
        }}
        outbox={{ submit: vi.fn() }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "安全配对" })).not.toBeNull();
    fireEvent.change(screen.getByLabelText("配对 ID"), {
      target: { value: "pair_0123456789abcdef01234567" },
    });
    fireEvent.change(screen.getByLabelText("配对挑战"), {
      target: { value: "pairing-challenge-mobile-application-00000001" },
    });
    fireEvent.change(screen.getByLabelText("设备名称"), {
      target: { value: "My phone" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交设备证明" }));
    await waitFor(() => expect(beginPairing).toHaveBeenCalledWith({
      pairingId: "pair_0123456789abcdef01234567",
      challenge: "pairing-challenge-mobile-application-00000001",
      deviceName: "My phone",
    }));
    fireEvent.click(await screen.findByRole("button", { name: "完成配对" }));
    await waitFor(() => expect(completePairing).toHaveBeenCalledWith({
      pairingId: "pair_0123456789abcdef01234567",
      challenge: "pairing-challenge-mobile-application-00000001",
      keyId: "key_mobile-application-test",
    }));
    expect(await screen.findByRole("heading", { name: "Hunter Pocket" })).not.toBeNull();
  });
});
