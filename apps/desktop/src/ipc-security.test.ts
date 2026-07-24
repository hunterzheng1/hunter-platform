import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopDaemonClient,
  DESKTOP_IPC_CHANNELS,
  createDesktopAuthenticatedTransport,
  createDesktopPreloadApi,
  installDesktopIpcHandlers,
  type DesktopIpcRegistrar,
} from "./ipc.js";

describe("desktop narrow IPC", () => {
  it("exposes only the named product methods", () => {
    expect(DESKTOP_IPC_CHANNELS).toEqual([
      "projects.list",
      "projects.create",
      "projects.get",
      "requirements.create",
      "requirements.approve",
      "changes.publish",
      "runs.get",
      "runs.command",
      "knowledge.list",
      "devices.pairing.create",
      "devices.pairing.confirm",
      "devices.revoke",
      "events.subscribe",
    ]);
  });

  it("exposes pairing only through named schema-validated desktop methods", async () => {
    const invoke = vi.fn(async () => ({
      pairingId: "pair_0123456789abcdef01234567",
      challenge: "C".repeat(43),
      expiresAt: "2026-07-24T00:05:00.000Z",
    }));
    const api = createDesktopPreloadApi(invoke, () => () => undefined);

    await expect(api.devices.createPairingChallenge({})).resolves.toMatchObject({
      pairingId: "pair_0123456789abcdef01234567",
    });
    await expect(
      api.devices.createPairingChallenge({ projectId: "prj_private0001" } as never),
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("devices.pairing.create", {});
  });

  it("strictly validates requests and responses before crossing the renderer boundary", async () => {
    const invoke = vi.fn(async (): Promise<unknown> => ({
      projects: [{ projectId: "prj_ipcsecure01", name: "Hunter" }],
    }));
    const subscribe = vi.fn(() => () => undefined);
    const api = createDesktopPreloadApi(invoke, subscribe);

    await expect(api.projects.list({})).resolves.toEqual({
      projects: [{ projectId: "prj_ipcsecure01", name: "Hunter" }],
    });
    await expect(
      api.projects.list({ apiOrigin: "http://127.0.0.1:3000" } as never),
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);

    invoke.mockResolvedValueOnce({
      projects: [{ projectId: "prj_ipcsecure01", name: "Hunter", token: "private" }],
    });
    await expect(api.projects.list({})).rejects.toThrow();
  });

  it("adapts only the Workbench route allowlist to named IPC", async () => {
    const invoke = vi.fn(async (channel: string): Promise<unknown> => {
      if (channel === "projects.create") {
        return {
          projectId: "prj_ipcsecure01",
          name: "Hunter",
          authorization: "host_session_reissue_required",
        };
      }
      if (channel === "projects.get") {
        return {
          projectId: "prj_ipcsecure01",
          name: "Hunter",
          requirements: [],
        };
      }
      throw new Error(`unexpected ${channel}`);
    });
    const transport = createDesktopAuthenticatedTransport(
      createDesktopPreloadApi(invoke, () => () => undefined),
    );
    const command = {
      projectId: "prj_ipcsecure01",
      name: "Hunter",
      expectedVersion: 0,
      idempotencyKey: "create-ipc-project",
    };

    await expect(transport.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    })).resolves.toMatchObject({ projectId: command.projectId });
    await expect(
      transport.request(`/api/v1/projects/${command.projectId}`),
    ).resolves.toMatchObject({ projectId: command.projectId });
    await expect(
      transport.request("http://127.0.0.1:43123/health"),
    ).rejects.toThrow("DESKTOP_TRANSPORT_ROUTE_NOT_ALLOWED");
    await expect(transport.request("/api/v1/projects", {
      method: "POST",
      headers: { authorization: "private" },
      body: JSON.stringify(command),
    })).rejects.toThrow("DESKTOP_TRANSPORT_HEADERS_INVALID");

    expect(invoke.mock.calls).toEqual([
      ["projects.create", { command }],
      ["projects.get", { projectId: command.projectId }],
    ]);
  });

  it("freezes the bridge and keeps origin, token, fetch, filesystem, shell, and arbitrary IPC out of preload", async () => {
    const api = createDesktopPreloadApi(
      async () => ({ projects: [] }),
      () => () => undefined,
    );
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.projects)).toBe(true);
    const source = await readFile(new URL("./preload.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /\b(?:apiOrigin|token|authorization|fetch|node:fs|child_process|shell|ipcRenderer\.send|ipcRenderer\.invoke\([^)]*channel)\b/iu,
    );
    expect(source).toContain(
      'exposeInMainWorld(\n  "hunterAuthenticatedTransport"',
    );
  });

  it("resolves preload and daemon entry from their packaged layouts", async () => {
    const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");
    expect(source).toContain(
      'join(app.getAppPath(), "dist", "preload.cjs")',
    );
    expect(source).toContain(
      'packagedResource(join("daemon", "main.cjs"))',
    );
  });

  it("authenticates an SSE stream and decodes only the narrow event envelope", async () => {
    const requestImpl = vi.fn(async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      void input;
      void init;
      return new Response(
        [
          "id: 7",
          "event: RunProjectionChanged",
          'data: {"position":7,"projectId":"prj_private","secret":"not-forwarded"}',
          "",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream; charset=utf-8" } },
      );
    });
    const client = new DesktopDaemonClient(
      43123,
      "D".repeat(43),
      "app://hunter",
      requestImpl,
      () => 1_000,
    );
    const listener = vi.fn();

    await client.subscribeEvents(
      { cursor: 6 },
      listener,
      new AbortController().signal,
    );

    expect(listener).toHaveBeenCalledWith({
      position: 7,
      eventType: "RunProjectionChanged",
    });
    const [url, init] = requestImpl.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:43123/events");
    expect((init?.headers as Record<string, string>)["last-event-id"]).toBe("6");
    expect(JSON.stringify(init)).not.toContain("D".repeat(43));
  });

  it("forwards SSE events only through the named renderer event channel", async () => {
    const handlers = new Map<string, Parameters<DesktopIpcRegistrar["handle"]>[1]>();
    const registrar: DesktopIpcRegistrar = {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    };
    const invoke = vi.fn(async (): Promise<unknown> => ({ projects: [] }));
    const subscribe = vi.fn(async (
      request: unknown,
      listener: (event: unknown) => void,
    ) => {
      void request;
      listener({ position: 9, eventType: "RunProjectionChanged" });
    });
    installDesktopIpcHandlers(registrar, invoke, subscribe);
    const send = vi.fn();
    const handler = handlers.get("hunter:events.subscribe");
    if (handler === undefined) throw new Error("EVENT_HANDLER_MISSING");

    const receipt = await handler(
      { sender: { send } },
      { cursor: 8 },
    );

    expect(receipt).toMatchObject({ cursor: 8 });
    expect(send).toHaveBeenCalledWith(
      "hunter:events.event",
      { position: 9, eventType: "RunProjectionChanged" },
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("forwards an explicit cursor gap instead of treating it as a generic HTTP failure", async () => {
    const gap = {
      status: "resync_required",
      code: "EVENT_CURSOR_GAP",
      retentionFloor: 10,
      highWaterPosition: 15,
      instructions: {
        snapshot: "reload_snapshot",
        rebuild: "replace_projection_from_snapshot",
        resume: "subscribe_after_high_water_position",
      },
    };
    const client = new DesktopDaemonClient(
      43123,
      "E".repeat(43),
      "app://hunter",
      async () => new Response(JSON.stringify(gap), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    const listener = vi.fn();

    await client.subscribeEvents(
      { cursor: 9 },
      listener,
      new AbortController().signal,
    );

    expect(listener).toHaveBeenCalledWith(gap);
  });

  it("binds unsubscribe to the sender and exact subscription receipt", async () => {
    const handlers = new Map<string, Parameters<DesktopIpcRegistrar["handle"]>[1]>();
    const registrar: DesktopIpcRegistrar = {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    };
    let streamSignal: AbortSignal | undefined;
    const subscribe = vi.fn((
      request: unknown,
      listener: (event: unknown) => void,
      signal: AbortSignal,
    ) => {
      void request;
      void listener;
      streamSignal = signal;
      return new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    installDesktopIpcHandlers(
      registrar,
      async () => ({ projects: [] }),
      subscribe,
    );
    const sender = { send: vi.fn() };
    const start = handlers.get("hunter:events.subscribe");
    const stop = handlers.get("hunter:events.unsubscribe");
    if (start === undefined || stop === undefined) {
      throw new Error("EVENT_HANDLERS_MISSING");
    }
    const receipt = await start({ sender }, { cursor: 3 }) as {
      subscriptionId: string;
    };

    await expect(stop(
      { sender: { send: vi.fn() } },
      { subscriptionId: receipt.subscriptionId },
    )).rejects.toThrowError("EVENT_SUBSCRIPTION_NOT_FOUND");
    await expect(stop(
      { sender },
      { subscriptionId: receipt.subscriptionId },
    )).resolves.toEqual({ status: "unsubscribed" });
    expect(streamSignal?.aborted).toBe(true);
  });

  it("does not deliver stale events or termination when a newer subscription supersedes a stream", async () => {
    const handlers = new Map<string, Parameters<DesktopIpcRegistrar["handle"]>[1]>();
    const registrar: DesktopIpcRegistrar = {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    };
    const signals: AbortSignal[] = [];
    const listeners: Array<(event: unknown) => void> = [];
    installDesktopIpcHandlers(
      registrar,
      async () => ({ projects: [] }),
      async (request, listener, signal) => {
        void request;
        listeners.push(listener);
        signals.push(signal);
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );
    const send = vi.fn();
    const sender = { send };
    const start = handlers.get("hunter:events.subscribe");
    const stop = handlers.get("hunter:events.unsubscribe");
    if (start === undefined || stop === undefined) {
      throw new Error("EVENT_HANDLERS_MISSING");
    }
    await start({ sender }, { cursor: 1 });
    const current = await start({ sender }, { cursor: 2 }) as {
      subscriptionId: string;
    };
    expect(signals[0]?.aborted).toBe(true);
    listeners[0]?.({ position: 2, eventType: "stale" });
    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();

    await stop({ sender }, { subscriptionId: current.subscriptionId });
  });
});
