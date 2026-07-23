import { startProtectedBoundaryDaemon } from "./auth/protected-boundary-daemon.js";

async function bootstrap(): Promise<void> {
  const bootstrapArguments = process.argv.slice(2);
  if (
    bootstrapArguments.length !== 2
    || bootstrapArguments[0] !== "--port=0"
    || bootstrapArguments[1] !== "--bootstrap-stdin"
  ) {
    process.stderr.write("hunterd bootstrap arguments invalid\n");
    process.exitCode = 1;
    return;
  }
  try {
    const daemon = await startProtectedBoundaryDaemon({
      capabilityInput: process.stdin,
      readinessOutput: process.stdout,
    });
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void daemon.shutdown().finally(() => {
        process.exitCode = 0;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    process.stderr.write("hunterd bootstrap failed\n");
    process.exitCode = 1;
  }
}

void bootstrap();
