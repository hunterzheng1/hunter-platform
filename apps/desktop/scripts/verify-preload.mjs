import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";

const desktopDirectory = join(fileURLToPath(new URL("..", import.meta.url)));
let stage = "waiting-for-ready";
const hardTimeout = setTimeout(() => {
  process.stderr.write(`sandbox preload smoke timed out at ${stage}\n`);
  app.exit(1);
}, 15_000);

async function verifyPreload() {
  stage = "creating-window";
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      experimentalFeatures: false,
      nodeIntegration: false,
      preload: join(desktopDirectory, "dist", "preload.cjs"),
      sandbox: true,
      webSecurity: true,
    },
  });
  stage = "loading-renderer";
  let exitCode = 1;
  try {
    await window.loadURL("data:text/html,<main>Hunter preload smoke</main>");
    stage = "evaluating-bridge";
    const result = await window.webContents.executeJavaScript(`(() => {
      const api = window.hunter;
      if (api === undefined || !Object.isFrozen(api)) return { passed: false };
      return {
        passed: true,
        groups: Object.keys(api).sort(),
        frozen: Object.values(api).every((value) => Object.isFrozen(value)),
        forbidden: ["fetch", "shell", "filesystem", "ipcRenderer", "apiOrigin", "token"]
          .filter((key) => key in api),
      };
    })()`);
    stage = "validating-bridge";
    if (
      result?.passed !== true
      || result?.frozen !== true
      || result?.forbidden?.length !== 0
      || JSON.stringify(result.groups) !== JSON.stringify([
        "changes",
        "devices",
        "events",
        "knowledge",
        "projects",
        "requirements",
        "runs",
      ])
    ) {
      throw new Error("SANDBOX_PRELOAD_BRIDGE_INVALID");
    }
    stage = "writing-result";
    await new Promise((resolve, reject) => {
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, bridge: "passed", ...result })}\n`,
        (error) => {
          if (error === null || error === undefined) resolve();
          else reject(error);
        },
      );
    });
    stage = "complete";
    exitCode = 0;
  } finally {
    clearTimeout(hardTimeout);
    window.destroy();
    app.exit(exitCode);
  }
}

void app.whenReady().then(verifyPreload).catch(() => {
  process.stderr.write(`sandbox preload smoke failed at ${stage}\n`);
  app.exit(1);
});
