import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { discriminateTrustedAsyncResult } from "../src/trusted-async-result/index.js";

describe("trusted async result", () => {
  it("rejects an ordinary thenable without executing its getter", () => {
    let getterExecutions = 0;
    const thenable = Object.defineProperty({}, "then", {
      enumerable: true,
      get() { getterExecutions += 1; return () => undefined; },
    });

    expect(discriminateTrustedAsyncResult(thenable)).toBeUndefined();
    expect(getterExecutions).toBe(0);
  });

  it("rejects a Proxy without executing traps", () => {
    let traps = 0;
    const proxy = new Proxy({}, {
      get() { traps += 1; return undefined; },
      getPrototypeOf() { traps += 1; return Object.prototype; },
      ownKeys() { traps += 1; return []; },
      getOwnPropertyDescriptor() { traps += 1; return undefined; },
    });

    expect(discriminateTrustedAsyncResult(proxy)).toBeUndefined();
    expect(traps).toBe(0);
  });

  it("accepts a genuine cross-realm Promise by Node brand instead of prototype", async () => {
    const promise = runInNewContext("Promise.resolve('cross-realm')") as Promise<string>;

    const result = discriminateTrustedAsyncResult(promise);

    expect(result?.kind).toBe("promise");
    if (result?.kind === "promise") await expect(result.promise).resolves.toBe("cross-realm");
  });

  it("accepts bounded synchronous plain roots without Promise assimilation", () => {
    const result = discriminateTrustedAsyncResult({ ok: true, value: "sync" });

    expect(result).toMatchObject({ kind: "sync", value: { ok: true, value: "sync" } });
  });
});
