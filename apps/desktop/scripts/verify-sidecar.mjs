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
import { withOwnedConcurrentStarts } from "../dist/sidecar-smoke-lifecycle.js";

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
    let requestNumber = 0;
    const request = async (method, path, body) => {
      requestNumber += 1;
      const timestamp = Date.now();
      const nonce = `sidecar-smoke-${index}-${requestNumber}`;
      const encodedBody = body === undefined ? "" : JSON.stringify(body);
      const bodyDigest = createHash("sha256").update(encodedBody).digest("hex");
      const canonical = [
        method,
        path,
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
      const response = await globalThis.fetch(`http://${host}${path}`, {
        method,
        headers: {
          host,
          origin: "app://hunter",
          ...(body === undefined
            ? {}
            : { "content-type": "application/json" }),
          "x-hunter-local-timestamp": String(timestamp),
          "x-hunter-local-nonce": nonce,
          "x-hunter-local-body-sha256": bodyDigest,
          "x-hunter-local-signature": signature,
        },
        ...(body === undefined ? {} : { body: encodedBody }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`SIDECAR_REQUEST_FAILED_${response.status}`);
      }
      return text === "" ? {} : JSON.parse(text);
    };
    await request("GET", "/health");
    const projectId = `prj_sidecarsmoke${index}`;
    const project = await request("POST", "/api/v1/projects", {
      projectId,
      name: `Sidecar smoke ${index}`,
      expectedVersion: 0,
      idempotencyKey: `sidecar-project-${index}`,
    });
    if (
      project.projectId !== projectId
      || project.authorization !== "host_session_reissue_required"
    ) {
      throw new Error("SIDECAR_PROJECT_CREATE_INVALID");
    }
    const listed = await request("GET", "/api/v1/projects");
    if (
      !Array.isArray(listed.projects)
      || !listed.projects.some((candidate) =>
        candidate?.projectId === projectId
      )
    ) {
      throw new Error("SIDECAR_PROJECT_AUTHORIZATION_REFRESH_FAILED");
    }
    const detail = await request("GET", `/api/v1/projects/${projectId}`);
    const requirement = await request(
      "POST",
      `/api/v1/projects/${projectId}/requirements`,
      {
        requirementId: `req_sidecarsmoke${index}`,
        revisionId: `rrv_sidecarsmoke${index}`,
        title: "Verify bundled sidecar",
        body: "Exercise the Hunter-owned definition services.",
        acceptanceCriteria: ["Published Change is persisted"],
        constraints: ["No production Provider calls"],
        expectedVersion: 0,
        idempotencyKey: `sidecar-requirement-${index}`,
      },
    );
    const approved = await request(
      "POST",
      `/api/v1/projects/${projectId}/requirement-revisions/${requirement.revisionId}/approve`,
      {
        expectedVersion: requirement.aggregateVersion,
        idempotencyKey: `sidecar-approve-${index}`,
      },
    );
    const defaults = detail.planningDefaults;
    if (
      !Array.isArray(defaults?.repositoryIds)
      || defaults.repositoryIds.length === 0
    ) {
      throw new Error("SIDECAR_PLANNING_DEFAULTS_MISSING");
    }
    const published = await request(
      "POST",
      `/api/v1/projects/${projectId}/changes`,
      {
        changeId: `chg_sidecarsmoke${index}`,
        changeRevisionId: `crv_sidecarsmoke${index}`,
        executionPlanId: `epl_sidecarsmoke${index}`,
        title: "Bundled sidecar composition",
        goal: "Prove the packaged Hunter-owned definition chain.",
        nonGoals: ["Call a production Provider"],
        requirementRevisionIds: [approved.revisionId],
        repositoryIds: defaults.repositoryIds,
        acceptanceCriteria: ["Definition chain returns a published plan"],
        constraints: ["Provider-neutral"],
        risks: ["Runtime remains unavailable"],
        dependsOnChangeRevisionIds: [],
        tasks: [{
          taskId: `tsk_sidecarsmoke${index}`,
          title: "Verify composition",
          objective: "Exercise persisted definitions.",
          acceptanceCriteria: ["Contract validation passes"],
          repositoryIds: defaults.repositoryIds,
          moduleScopes: ["apps"],
          dependsOn: [],
          readSet: ["apps"],
          writeSet: ["apps"],
          access: "write",
          workflowRevisionId: defaults.workflowRevisionId,
          defaultAgentProfileId: defaults.defaultAgentProfileId,
          sessionPolicy: defaults.sessionPolicy,
          workspacePolicy: defaults.workspacePolicy,
        }],
        expectedVersion: 0,
        idempotencyKey: `sidecar-change-${index}`,
      },
    );
    if (published.status !== "published") {
      throw new Error("SIDECAR_CHANGE_PUBLISH_INVALID");
    }
    return {
      child,
      dataDirectory,
      port: readiness.port,
      definitionChain: "passed",
    };
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

async function cleanup({ child, dataDirectory }) {
  if (child.exitCode === null) {
    const closed = new Promise((resolveClose) =>
      child.once("close", resolveClose));
    child.kill("SIGTERM");
    await closed;
  }
  await rm(dataDirectory, { recursive: true, force: true });
}

const report = await withOwnedConcurrentStarts(
  [() => start(17), () => start(23)],
  async (running) => {
    if (running.length !== 2) throw new Error("SIDECAR_START_COUNT_INVALID");
    if (running[0].port === running[1].port) {
      throw new Error("SIDECAR_PORT_REUSE");
    }
    if (running.some(({ definitionChain }) =>
      definitionChain !== "passed"
    )) {
      throw new Error("SIDECAR_DEFINITION_CHAIN_FAILED");
    }
    return {
      schemaVersion: 1,
      starts: [
        { readiness: "validated", port: "<ephemeral:1>", auth: "passed" },
        { readiness: "validated", port: "<ephemeral:2>", auth: "passed" },
      ],
      portsDistinct: true,
      definitionChains: "passed",
    };
  },
  cleanup,
);
process.stdout.write(`${JSON.stringify(report)}\n`);
