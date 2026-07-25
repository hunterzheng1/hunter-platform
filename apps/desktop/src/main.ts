import { app, BrowserWindow, ipcMain } from "electron";
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
import {
  acquireDesktopInstance,
  isRendererFailure,
  ownsDesktopExit,
  OwnedDesktopProcessLifecycle,
} from "./install-lifecycle.js";

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
  window.webContents.once("render-process-gone", (_event, details) => {
    if (!isRendererFailure(details.reason)) return;
    void lifecycle.stop("renderer_crashed").then((receipt) => {
      if (ownsDesktopExit(receipt)) app.exit(1);
    }).catch(() => app.exit(1));
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
  );

  if (rendererEntry === undefined) {
    await window.loadURL(CHECKED_IN_VITE_RENDERER_URL);
  } else {
    await loadPackagedRenderer(window, rendererEntry);
  }
  return window;
}

let supervisor: DaemonSupervisor | undefined;
let mainWindow: BrowserWindow | undefined;
const lifecycle = new OwnedDesktopProcessLifecycle(
  async () => await supervisor?.stop(),
);
let normalShutdownRequested = false;

async function startApplication(): Promise<void> {
  const capability = randomBytes(32).toString("base64url");
  supervisor = new DaemonSupervisor(
    undefined,
    app.isPackaged
      ? packagedResource(join("daemon", "main.cjs"))
      : join(app.getAppPath(), "dist-sidecar", "main.cjs"),
    process.execPath,
    app.getPath("userData"),
  );
  const daemon = await supervisor.startProtected(capability);
  const client = new DesktopDaemonClient(daemon.port, capability);
  installDesktopIpcHandlers(
    ipcMain,
    (channel, request) => client.request(channel, request),
    (request, listener, signal) =>
      client.subscribeEvents(request, listener, signal),
  );
  mainWindow = await createMainWindow();
  mainWindow.once("closed", () => {
    mainWindow = undefined;
  });
}

function focusExistingWindow(): void {
  const existing = mainWindow ?? BrowserWindow.getAllWindows()[0];
  if (existing === undefined) return;
  if (existing.isMinimized()) existing.restore();
  existing.show();
  existing.focus();
}

if (acquireDesktopInstance(app, focusExistingWindow)) {
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow().then((window) => {
        mainWindow = window;
      });
    } else {
      focusExistingWindow();
    }
  });
  app.on("before-quit", (event) => {
    event.preventDefault();
    if (normalShutdownRequested) return;
    normalShutdownRequested = true;
    void lifecycle.stop("normal_exit")
      .then((receipt) => {
        if (ownsDesktopExit(receipt)) app.exit(0);
      })
      .catch(() => app.exit(1));
  });
  app.on("window-all-closed", () => {
    app.quit();
  });

  void app.whenReady().then(startApplication).catch(async () => {
    try {
      const receipt = await lifecycle.stop("daemon_start_failed");
      if (ownsDesktopExit(receipt)) app.exit(1);
    } catch {
      app.exit(1);
    }
  });
}
