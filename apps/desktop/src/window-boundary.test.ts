import { describe, expect, it, vi } from "vitest";

import {
  CHECKED_IN_VITE_RENDERER_URL,
  installWindowBoundary,
  loadPackagedRenderer,
  LOCKED_DOWN_WEB_PREFERENCES,
  type WindowBoundaryContents,
} from "./window-boundary.js";

describe("locked-down desktop window boundary", () => {
  it("freezes the Task 11 web preferences", () => {
    expect(LOCKED_DOWN_WEB_PREFERENCES).toEqual({
      allowRunningInsecureContent: false,
      contextIsolation: true,
      experimentalFeatures: false,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
    expect(Object.isFrozen(LOCKED_DOWN_WEB_PREFERENCES)).toBe(true);
    expect(CHECKED_IN_VITE_RENDERER_URL).toBe("http://127.0.0.1:5173/");
  });

  it("loads only the supplied packaged renderer file", async () => {
    const loadFile = vi.fn(async () => undefined);

    await loadPackagedRenderer({ loadFile }, "C:\\Hunter\\resources\\web\\index.html");

    expect(loadFile).toHaveBeenCalledOnce();
    expect(loadFile).toHaveBeenCalledWith("C:\\Hunter\\resources\\web\\index.html");
  });

  it("denies new windows, navigation, permissions, and direct external-open side effects", () => {
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
    installWindowBoundary(contents, "file:///C:/Hunter/resources/web/index.html");

    expect(openHandler?.({ url: "https://docs.example.test" })).toEqual({ action: "deny" });
    expect(openHandler?.({ url: "file:///C:/private.txt" })).toEqual({ action: "deny" });
    expect(openExternal).not.toHaveBeenCalled();

    const localEvent = { preventDefault: vi.fn() };
    navigateHandler?.(localEvent, "file:///C:/Hunter/resources/web/index.html");
    expect(localEvent.preventDefault).not.toHaveBeenCalled();

    const externalEvent = { preventDefault: vi.fn() };
    navigateHandler?.(externalEvent, "https://docs.example.test/guide");
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).not.toHaveBeenCalled();

    const unsafeEvent = { preventDefault: vi.fn() };
    navigateHandler?.(unsafeEvent, "javascript:alert(1)");
    expect(unsafeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).not.toHaveBeenCalled();

    const permissionResult = vi.fn();
    permissionHandler?.({}, "notifications", permissionResult);
    expect(permissionResult).toHaveBeenCalledWith(false);
  });
});
