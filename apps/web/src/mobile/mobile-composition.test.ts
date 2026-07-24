// @vitest-environment jsdom
import { webcrypto } from "node:crypto";

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

import { createMobileComposition } from "./mobile-composition.js";

describe("mobile production composition", () => {
  it("accepts only a secret-free HTTPS configuration", () => {
    const platform = {
      indexedDB: new IDBFactory(),
      crypto: webcrypto as unknown as Crypto,
      fetch: vi.fn(),
    };

    expect(createMobileComposition({
      apiOrigin: "https://remote.hunter",
      projectIds: ["prj_mobile00001"],
    }, platform)).toMatchObject({
      runtime: expect.any(Object),
      outbox: expect.any(Object),
    });
    expect(createMobileComposition({
      apiOrigin: "http://remote.hunter",
      projectIds: ["prj_mobile00001"],
    }, platform)).toBeUndefined();
    expect(createMobileComposition({
      apiOrigin: "https://remote.hunter",
      projectIds: ["prj_mobile00001"],
      accessToken: "must-never-enter-bootstrap-state",
    }, platform)).toBeUndefined();
  });
});
