import process from "node:process";

await import("tsx/esm");

const { runE2eLauncher } = await import("./start-e2e-launcher.ts");

try {
  await runE2eLauncher({
    selfCheck: process.argv.includes("--self-check"),
    verify: process.argv.includes("--verify"),
  });
} catch (error) {
  const known = new Set([
    "E2E_ACTIVE_LOCK_HELD",
    "E2E_PORT_4173_UNAVAILABLE",
    "E2E_VERIFY_NOT_AVAILABLE_UNTIL_TASK_19",
    "E2E_WEB_BUILD_FAILED",
    "E2E_SELF_CHECK_FAILED",
    "E2E_WINDOWS_SID_INVALID",
  ]);
  const code =
    error instanceof Error && known.has(error.message)
      ? error.message
      : "E2E_LAUNCH_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
