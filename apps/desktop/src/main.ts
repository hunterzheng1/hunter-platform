import { app, BrowserWindow, ipcMain, shell } from "electron";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CHECKED_IN_VITE_RENDERER_URL,
  installWindowBoundary,
  loadPackagedRenderer,
  LOCKED_DOWN_WEB_PREFERENCES,
} from "./window-boundary.js";
import { DaemonSupervisor } from "./daemon-supervisor.js";
import {
  DesktopDaemonClient,
  installDesktopIpcHandlers,
} from "./ipc.js";

function packagedResource(relativePath: string): string {
  if (app.isPackaged) return join(process.resourcesPath, relativePath);
  return join(app.getAppPath(), "..", relativePath);
}

async function createMainWindow(): Promise<BrowserWindow> {
  const rendererEntry = app.isPackaged
    ? packagedResource(join("web", "index.html"))
    : undefined;
  const rendererUrl = rendererEntry === undefined
    ? CHECKED_IN_VITE_RENDERER_URL
    : pathToFileURL(rendererEntry).href;
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    webPreferences: {
      ...LOCKED_DOWN_WEB_PREFERENCES,
      preload: join(app.getAppPath(), "dist", "preload.cjs"),
    },
  });

  installWindowBoundary(
    {
      onWillNavigate: (handler) => {
        window.webContents.on("will-navigate", handler);
      },
      setPermissionRequestHandler: (handler) => {
        window.webContents.session.setPermissionRequestHandler(handler);
      },
      setWindowOpenHandler: (handler) => {
        window.webContents.setWindowOpenHandler(handler);
      },
    },
    rendererUrl,
    (target) => {
      void shell.openExternal(target).catch(() => undefined);
    },
  );

  if (rendererEntry === undefined) {
    await window.loadURL(CHECKED_IN_VITE_RENDERER_URL);
  } else {
    await loadPackagedRenderer(window, rendererEntry);
  }
  return window;
}

let supervisor: DaemonSupervisor | undefined;

async function startApplication(): Promise<void> {
  const capability = randomBytes(32).toString("base64url");
  supervisor = new DaemonSupervisor(
    undefined,
    app.isPackaged
      ? packagedResource(join("daemon", "main.cjs"))
      : join(app.getAppPath(), "dist-sidecar", "main.cjs"),
  );
  const daemon = await supervisor.startProtected(capability);
  const client = new DesktopDaemonClient(daemon.port, capability);
  installDesktopIpcHandlers(
    ipcMain,
    (channel, request) => client.request(channel, request),
    (request, listener, signal) =>
      client.subscribeEvents(request, listener, signal),
  );
  await createMainWindow();
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
});
app.on("window-all-closed", () => {
  supervisor?.stop();
  app.quit();
});

void app.whenReady().then(startApplication).catch(() => {
  supervisor?.stop();
  app.exit(1);
});
