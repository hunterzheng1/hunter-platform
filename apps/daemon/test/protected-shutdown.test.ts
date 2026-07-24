import { describe, expect, it, vi } from "vitest";

import { shutdownProtectedDaemon } from "../src/protected-shutdown.js";

describe("protected daemon shutdown", () => {
  it("reports success only after shutdown resolves", async () => {
    const reportFailure = vi.fn();

    await expect(shutdownProtectedDaemon(
      { shutdown: vi.fn(async () => undefined) },
      reportFailure,
    )).resolves.toBe(0);

    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("turns shutdown rejection into a sanitized non-zero result", async () => {
    const reportFailure = vi.fn();

    await expect(shutdownProtectedDaemon(
      {
        shutdown: vi.fn(async () => {
          throw new Error("C:\\private\\token-value");
        }),
      },
      reportFailure,
    )).resolves.toBe(1);

    expect(reportFailure).toHaveBeenCalledWith("hunterd shutdown failed\n");
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain("token-value");
  });
});
