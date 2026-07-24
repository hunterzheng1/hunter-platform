import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  isMobileRoute,
  registerMobileServiceWorker,
} from "./register-mobile-service-worker.js";

type FetchListener = (event: {
  readonly request: Request;
  readonly respondWith: (response: Promise<Response>) => void;
}) => void;

async function loadFetchListener(): Promise<{
  readonly listener: FetchListener;
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly source: string;
}> {
  const source = await readFile(new URL("../../public/sw.js", import.meta.url), "utf8");
  let listener: FetchListener | undefined;
  const fetch = vi.fn(async () => new Response("ok"));
  const serviceWorkerGlobal = {
    location: new URL("https://hunter.example/mobile"),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
    addEventListener(name: string, callback: unknown) {
      if (name === "fetch") listener = callback as FetchListener;
    },
  };
  vm.runInNewContext(source, {
    self: serviceWorkerGlobal,
    fetch,
    URL,
    Set,
  });
  if (listener === undefined) throw new Error("FETCH_LISTENER_MISSING");
  return { listener, fetch, source };
}

describe("mobile PWA safety", () => {
  it("keeps the install start URL inside the narrow mobile scope", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../public/manifest.webmanifest", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const index = await readFile(new URL("../../index.html", import.meta.url), "utf8");
    expect(manifest).toMatchObject({
      name: "Hunter Pocket",
      short_name: "Hunter",
      start_url: "/mobile/",
      scope: "/mobile/",
      display: "standalone",
    });
    expect(index).toContain('rel="manifest" href="/manifest.webmanifest"');
  });

  it("registers only on the secure /mobile HTTP(S) route and never on file:", () => {
    expect(isMobileRoute("/mobile")).toBe(true);
    expect(isMobileRoute("/mobile/runs/run_mobile00001")).toBe(true);
    expect(isMobileRoute("/projects/prj_mobile00001")).toBe(false);

    const loadListeners: Array<() => void> = [];
    const register = vi.fn(async () => undefined);
    expect(registerMobileServiceWorker({
      pathname: "/mobile",
      protocol: "https:",
      isSecureContext: true,
      register,
      onLoad: (listener) => loadListeners.push(listener),
    })).toBe(true);
    expect(register).not.toHaveBeenCalled();
    loadListeners[0]?.();
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/mobile/", type: "module" });

    for (const input of [
      { pathname: "/mobile", protocol: "file:", isSecureContext: true },
      { pathname: "/mobile", protocol: "http:", isSecureContext: false },
      { pathname: "/", protocol: "https:", isSecureContext: true },
    ]) {
      expect(registerMobileServiceWorker({
        ...input,
        register,
        onLoad: vi.fn(),
      })).toBe(false);
    }
  });

  it("bypasses API, event, auth, device, pairing, refresh, command, non-GET, and authorized requests", async () => {
    const { listener, fetch } = await loadFetchListener();
    const paths = [
      "/api/v1/runs",
      "/events",
      "/auth/session",
      "/devices/pair",
      "/pair",
      "/refresh",
      "/commands",
    ];
    for (const path of paths) {
      const respondWith = vi.fn();
      listener({
        request: new Request(`https://hunter.example${path}`, { method: "GET" }),
        respondWith,
      });
      expect(respondWith).not.toHaveBeenCalled();
    }
    const postRespondWith = vi.fn();
    listener({
      request: new Request("https://hunter.example/assets/app.js", { method: "POST" }),
      respondWith: postRespondWith,
    });
    expect(postRespondWith).not.toHaveBeenCalled();
    const authorizedRespondWith = vi.fn();
    listener({
      request: new Request("https://hunter.example/assets/app.js", {
        headers: { authorization: "Bearer redacted" },
      }),
      respondWith: authorizedRespondWith,
    });
    expect(authorizedRespondWith).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses network-only delivery for allowlisted same-origin static GETs and contains no Cache API", async () => {
    const { listener, fetch, source } = await loadFetchListener();
    const respondWith = vi.fn();
    listener({
      request: new Request("https://hunter.example/icons/hunter.svg"),
      respondWith,
    });
    expect(respondWith).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(source).not.toMatch(/\bcaches\b|\bcacheStorage\b|\bcache\.put\b|\baddAll\b/u);
  });
});
