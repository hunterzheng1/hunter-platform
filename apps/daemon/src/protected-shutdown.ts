export async function shutdownProtectedDaemon(
  daemon: { shutdown(): Promise<void> },
  reportFailure: (message: string) => void,
): Promise<0 | 1> {
  try {
    await daemon.shutdown();
    return 0;
  } catch {
    reportFailure("hunterd shutdown failed\n");
    return 1;
  }
}
