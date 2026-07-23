import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  installWindowBoundary,
  loadPackagedRenderer,
  LOCKED_DOWN_WEB_PREFERENCES,
} from "./window-boundary.js";

function packagedResource(relativePath: string): string {
  if (app.isPackaged) return join(process.resourcesPath, relativePath);
  return join(app.getAppPath(), "..", relativePath);
}

async function createMainWindow(): Promise<BrowserWindow> {
  const rendererEntry = packagedResource(join("web", "index.html"));
  const rendererUrl = pathToFileURL(rendererEntry).href;
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    webPreferences: LOCKED_DOWN_WEB_PREFERENCES,
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

  await loadPackagedRenderer(window, rendererEntry);
  return window;
}

await app.whenReady();

await createMainWindow();

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
});
app.on("window-all-closed", () => {
  app.quit();
});
