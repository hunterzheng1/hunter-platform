// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

it("renders /mobile as an unavailable remote surface without reading the desktop transport", async () => {
  window.history.replaceState({}, "", "/mobile");
  document.body.innerHTML = '<div id="root"></div>';
  const desktopTransportRead = vi.fn();
  Object.defineProperty(window, "hunterAuthenticatedTransport", {
    configurable: true,
    get() {
      desktopTransportRead();
      throw new Error("DESKTOP_TRANSPORT_MUST_NOT_BE_READ_FOR_MOBILE");
    },
  });

  await import("./main.js");

  expect(window.location.pathname).toBe("/mobile/");
  expect((await screen.findByRole("alert")).textContent).toContain("远程访问尚未配置");
  expect(desktopTransportRead).not.toHaveBeenCalled();
});
