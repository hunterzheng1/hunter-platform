// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { MobileCommandEnvelopeSchema } from "@hunter/device-gateway";

import { MobileCommandOutbox } from "./command-outbox.js";

const command = MobileCommandEnvelopeSchema.parse({
  projectId: "prj_mobile00001",
  runId: "run_mobile00001",
  stepRunId: "spr_mobile00001",
  expectedVersion: 7,
  idempotencyKey: "mobile-outbox-stable-0001",
  action: "pause_run",
  payload: {},
});

describe("mobile command outbox", () => {
  it("keeps the exact envelope after a transport failure and deletes it only after a terminal receipt", async () => {
    const outbox = new MobileCommandOutbox({ indexedDB: new IDBFactory() });
    let firstAttempt: unknown;
    await expect(
      outbox.submit(command, async (candidate) => {
        firstAttempt = candidate;
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");

    expect(firstAttempt).toEqual(command);
    expect(await outbox.pending()).toEqual([command]);

    let retryAttempt: unknown;
    const terminal = await outbox.retry(command.idempotencyKey, async (candidate) => {
      retryAttempt = candidate;
      return {
        status: "accepted",
        receipt: {
          commandId: `ApplyRunControl:${candidate.idempotencyKey}`,
          response: { status: "accepted" },
        },
      };
    });
    expect(retryAttempt).toEqual(command);
    expect((retryAttempt as typeof command).idempotencyKey).toBe(command.idempotencyKey);
    expect(terminal.status).toBe("accepted");
    expect(await outbox.pending()).toEqual([]);
  });

  it("rejects a different payload that reuses an existing idempotency key", async () => {
    const outbox = new MobileCommandOutbox({ indexedDB: new IDBFactory() });
    await expect(
      outbox.submit(command, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");

    await expect(
      outbox.submit(
        MobileCommandEnvelopeSchema.parse({ ...command, action: "resume_run" }),
        async () => ({ status: "accepted", receipt: {} }),
      ),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    expect(await outbox.pending()).toEqual([command]);
  });
});
