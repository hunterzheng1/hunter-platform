import { describe, expect, it, vi } from "vitest";

import { withOwnedConcurrentStarts } from "./sidecar-smoke-lifecycle.js";

describe("sidecar smoke lifecycle", () => {
  it("cleans every successful start when a peer start fails", async () => {
    const owned = { id: "started-sidecar" };
    const failure = new Error("SECOND_START_FAILED");
    const cleanup = vi.fn(async (resource: { readonly id: string }) => {
      void resource;
    });
    const use = vi.fn(async () => "unused");

    await expect(withOwnedConcurrentStarts(
      [
        async () => owned,
        async () => {
          throw failure;
        },
      ],
      use,
      cleanup,
    )).rejects.toBe(failure);

    expect(use).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith(owned);
  });

  it("keeps all successful resources owned until verification completes", async () => {
    const resources = [{ id: "one" }, { id: "two" }];
    const cleanup = vi.fn(async (resource: { readonly id: string }) => {
      void resource;
    });

    await expect(withOwnedConcurrentStarts(
      resources.map((resource) => async () => resource),
      async (running) => running.map(({ id }) => id).join(","),
      cleanup,
    )).resolves.toBe("one,two");

    expect(cleanup.mock.calls.map(([resource]) => resource)).toEqual(resources);
  });
});
