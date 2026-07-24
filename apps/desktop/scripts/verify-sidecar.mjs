import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";

import electronExecutable from "electron";

const desktopDirectory = join(fileURLToPath(new URL("..", import.meta.url)));
const daemonEntry = join(desktopDirectory, "dist-sidecar", "main.cjs");

function waitForReadiness(child, capability) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("SIDECAR_READINESS_TIMEOUT"));
    }, 10_000);
    const fail = (code) => {
      clearTimeout(timeout);
      child.kill("SIGTERM");
      reject(new Error(code));
    };
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr, "utf8") > 16 * 1024) {
        fail("SIDECAR_STDERR_TOO_LARGE");
      }
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, "utf8") > 1_024) {
        fail("SIDECAR_READINESS_INVALID");
        return;
      }
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      let value;
      try {
        value = JSON.parse(stdout.slice(0, newline));
      } catch {
        fail("SIDECAR_READINESS_INVALID");
        return;
      }
      if (
        value?.schemaVersion !== 1
        || value?.kind !== "hunterd-ready"
        || !Number.isInteger(value?.port)
        || value.port < 1
        || value.port > 65_535
        || Object.keys(value).sort().join(",") !== "kind,port,schemaVersion"
        || stdout.includes(capability)
        || stderr.includes(capability)
      ) {
        fail("SIDECAR_READINESS_INVALID");
        return;
      }
      resolve(value);
    });
    child.once("error", () => fail("SIDECAR_SPAWN_FAILED"));
    child.once("close", (exitCode, signal) => {
      if (!stdout.includes("\n")) {
        const runtimeCategory = [
          "ERR_REQUIRE_ESM",
          "ERR_MODULE_NOT_FOUND",
          "SyntaxError",
          "ReferenceError",
          "TypeError",
          "Cannot find module",
          "Unexpected token",
        ].find((token) => stderr.includes(token)) ?? "UNCLASSIFIED";
        const sanitizedFirstLine = stderr
          .replaceAll(/file:\/\/\/[^\s)]+/gu, "<file-url>")
          .replaceAll(/[A-Za-z]:[\\/][^\r\n]*/gu, "<path>")
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .find((line) =>
            line.length > 0
            && line !== "<file-url>"
            && line !== "<path>"
            && !line.startsWith("at "),
          )
          ?.slice(0, 200) ?? "no-stderr-line";
        fail(
          stderr.includes("bootstrap arguments invalid")
            ? "SIDECAR_BOOTSTRAP_ARGUMENTS_INVALID"
            : stderr.includes("bootstrap failed")
              ? "SIDECAR_BOOTSTRAP_FAILED"
              : `SIDECAR_EXITED_BEFORE_READY_${runtimeCategory}_${String(exitCode)}_${String(signal)}_OUT${String(Buffer.byteLength(stdout, "utf8"))}_ERR${String(Buffer.byteLength(stderr, "utf8"))}_${sanitizedFirstLine}`,
        );
      }
    });
  });
}

async function start(index) {
  const capability = Buffer.alloc(32, index).toString("base64url");
  const dataDirectory = await mkdtemp(
    join(tmpdir(), "hunter-sidecar-smoke-"),
  );
  const args = [daemonEntry, "--port=0", "--bootstrap-stdin"];
  const environment = {
    ELECTRON_RUN_AS_NODE: "1",
    HUNTER_DESKTOP_DATA_DIRECTORY: dataDirectory,
    ...(process.platform === "win32" && process.env.SystemRoot !== undefined
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
    ...(process.platform === "win32" && process.env.WINDIR !== undefined
      ? { WINDIR: process.env.WINDIR }
      : {}),
  };
  const child = spawn(electronExecutable, args, {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    child.stdin.end(`${capability}\n`, "utf8");
    const readiness = await waitForReadiness(child, capability);
    const host = `127.0.0.1:${readiness.port}`;
    const timestamp = Date.now();
    const nonce = `sidecar-smoke-nonce-${index}`;
    const bodyDigest = createHash("sha256").update("").digest("hex");
    const canonical = [
      "GET",
      "/health",
      host,
      "app://hunter",
      String(timestamp),
      nonce,
      "",
      bodyDigest,
    ].join("\n");
    const signature = createHmac(
      "sha256",
      Buffer.from(capability, "base64url"),
    ).update(canonical).digest("base64url");
    const response = await globalThis.fetch(`http://${host}/health`, {
      headers: {
        host,
        origin: "app://hunter",
        "x-hunter-local-timestamp": String(timestamp),
        "x-hunter-local-nonce": nonce,
        "x-hunter-local-body-sha256": bodyDigest,
        "x-hunter-local-signature": signature,
      },
    });
    if (response.status !== 200) {
      throw new Error("SIDECAR_AUTHENTICATED_HEALTH_FAILED");
    }
    await response.body?.cancel();
    return { child, dataDirectory, port: readiness.port };
  } catch (error) {
    if (child.exitCode === null) {
      const closed = new Promise((resolveClose) =>
        child.once("close", resolveClose));
      child.kill("SIGTERM");
      await closed;
    }
    await rm(dataDirectory, { recursive: true, force: true });
    throw error;
  }
}

const running = await Promise.all([start(17), start(23)]);
try {
  if (running[0].port === running[1].port) {
    throw new Error("SIDECAR_PORT_REUSE");
  }
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      starts: [
        { readiness: "validated", port: "<ephemeral:1>", auth: "passed" },
        { readiness: "validated", port: "<ephemeral:2>", auth: "passed" },
      ],
      portsDistinct: true,
    })}\n`,
  );
} finally {
  await Promise.all(running.map(async ({ child, dataDirectory }) => {
    if (child.exitCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGTERM");
      await closed;
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }));
}
