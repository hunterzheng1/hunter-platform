import { describe, expect, it, vi } from "vitest";

import { desktopPreloadCapabilities } from "./preload.js";
import {
  installWindowBoundary,
  loadPackagedRenderer,
  LOCKED_DOWN_WEB_PREFERENCES,
  type WindowBoundaryContents,
} from "./window-boundary.js";

describe("locked-down desktop window boundary", () => {
  it("freezes the Task 11 web preferences and exposes no preload capability", () => {
    expect(LOCKED_DOWN_WEB_PREFERENCES).toEqual({
      allowRunningInsecureContent: false,
      contextIsolation: true,
      experimentalFeatures: false,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
    expect(Object.isFrozen(LOCKED_DOWN_WEB_PREFERENCES)).toBe(true);
    expect(desktopPreloadCapabilities).toEqual([]);
    expect(Object.isFrozen(desktopPreloadCapabilities)).toBe(true);
  });

  it("loads only the supplied packaged renderer file", async () => {
    const loadFile = vi.fn(async () => undefined);

    await loadPackagedRenderer({ loadFile }, "C:\\Hunter\\resources\\web\\index.html");

    expect(loadFile).toHaveBeenCalledOnce();
    expect(loadFile).toHaveBeenCalledWith("C:\\Hunter\\resources\\web\\index.html");
  });

  it("denies new windows, navigation, and permissions while opening only HTTPS externally", () => {
    let openHandler: ((details: { url: string }) => { action: "deny" }) | undefined;
    let navigateHandler: ((event: { preventDefault(): void }, url: string) => void) | undefined;
    let permissionHandler: ((webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined;
    const contents: WindowBoundaryContents = {
      onWillNavigate: (handler) => {
        navigateHandler = handler;
      },
      setPermissionRequestHandler: (handler) => {
        permissionHandler = handler;
      },
      setWindowOpenHandler: (handler) => {
        openHandler = handler;
      },
    };
    const openExternal = vi.fn();
    installWindowBoundary(contents, "file:///C:/Hunter/resources/web/index.html", openExternal);

    expect(openHandler?.({ url: "https://docs.example.test" })).toEqual({ action: "deny" });
    expect(openHandler?.({ url: "file:///C:/private.txt" })).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith("https://docs.example.test");

    const localEvent = { preventDefault: vi.fn() };
    navigateHandler?.(localEvent, "file:///C:/Hunter/resources/web/index.html");
    expect(localEvent.preventDefault).not.toHaveBeenCalled();

    const externalEvent = { preventDefault: vi.fn() };
    navigateHandler?.(externalEvent, "https://docs.example.test/guide");
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenLastCalledWith("https://docs.example.test/guide");

    const unsafeEvent = { preventDefault: vi.fn() };
    navigateHandler?.(unsafeEvent, "javascript:alert(1)");
    expect(unsafeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledTimes(2);

    const permissionResult = vi.fn();
    permissionHandler?.({}, "notifications", permissionResult);
    expect(permissionResult).toHaveBeenCalledWith(false);
  });
});
