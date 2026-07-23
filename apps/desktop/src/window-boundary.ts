import { isAllowedExternalUrl } from "./window-policy.js";

export const CHECKED_IN_VITE_RENDERER_URL = "http://127.0.0.1:5173/";

export const LOCKED_DOWN_WEB_PREFERENCES = Object.freeze({
  allowRunningInsecureContent: false,
  contextIsolation: true,
  experimentalFeatures: false,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
});

type NavigationEvent = { preventDefault(): void };
type PermissionCallback = (allowed: boolean) => void;

export interface WindowBoundaryContents {
  readonly setWindowOpenHandler: (
    handler: (details: { readonly url: string }) => { readonly action: "deny" },
  ) => void;
  readonly onWillNavigate: (
    handler: (event: NavigationEvent, url: string) => void,
  ) => void;
  readonly setPermissionRequestHandler: (
    handler: (webContents: unknown, permission: string, callback: PermissionCallback) => void,
  ) => void;
}

export function installWindowBoundary(
  contents: WindowBoundaryContents,
  rendererUrl: string,
  openExternal: (target: string) => void,
): void {
  const openIfAllowed = (target: string) => {
    if (isAllowedExternalUrl(target)) openExternal(target);
  };
  contents.setWindowOpenHandler(({ url }) => {
    openIfAllowed(url);
    return { action: "deny" };
  });
  contents.onWillNavigate((event, url) => {
    if (url === rendererUrl) return;
    event.preventDefault();
    openIfAllowed(url);
  });
  contents.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

export async function loadPackagedRenderer(
  window: { readonly loadFile: (path: string) => Promise<unknown> },
  rendererEntry: string,
): Promise<void> {
  await window.loadFile(rendererEntry);
}
