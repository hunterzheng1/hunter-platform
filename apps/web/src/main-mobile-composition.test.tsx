// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const { createMobileComposition } = vi.hoisted(() => ({
  createMobileComposition: vi.fn(() => undefined),
}));

vi.mock("./mobile/mobile-composition.js", () => ({ createMobileComposition }));

it("passes only the explicit mobile bootstrap configuration into production composition", async () => {
  window.history.replaceState({}, "", "/mobile/");
  document.body.innerHTML = '<div id="root"></div>';
  const configuration = {
    apiOrigin: "https://remote.hunter",
    projectIds: ["prj_mobile00001"],
  };
  Object.defineProperty(window, "hunterMobileConfig", {
    configurable: true,
    value: configuration,
  });

  await import("./main.js");

  expect(createMobileComposition).toHaveBeenCalledWith(
    configuration,
    expect.objectContaining({
      indexedDB: window.indexedDB,
      crypto: window.crypto,
      fetch: expect.any(Function),
    }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "远程访问尚未配置",
  );
});
