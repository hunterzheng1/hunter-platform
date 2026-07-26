import { expect, test } from "./fixtures/readiness-test.js";

test("remote mobile stays fail-closed without desktop pairing or explicit enablement", async ({
  page,
}) => {
  const sensitiveRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      path.startsWith("/api/")
      || path.startsWith("/events")
      || path.startsWith("/auth")
      || path.startsWith("/refresh")
    ) {
      sensitiveRequests.push(`${request.method()} ${path}`);
    }
  });

  await page.goto("/mobile");
  await expect(page.getByRole("heading", { name: "Hunter Pocket" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("远程访问尚未配置");
  await expect(page.getByRole("button")).toHaveCount(0);
  expect(page.viewportSize()?.width).toBeLessThanOrEqual(430);

  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const browser = globalThis as unknown as {
            readonly isSecureContext: boolean;
            readonly location: { readonly pathname: string };
            readonly navigator: {
              readonly serviceWorker?: {
                getRegistrations(): Promise<Array<{
                  readonly active?: { readonly state: string } | null;
                }>>;
                readonly controller: unknown;
              };
            };
          };
          const serviceWorker = browser.navigator.serviceWorker;
          const registrations = serviceWorker !== undefined
            ? await serviceWorker.getRegistrations()
            : [];
          return {
            isSecureContext: browser.isSecureContext,
            pathname: browser.location.pathname,
            registrations: registrations.length,
            activeState: registrations[0]?.active?.state ?? null,
            controlled: serviceWorker?.controller != null,
          };
        }),
      { timeout: 5_000 },
    )
    .toEqual({
      isSecureContext: true,
      pathname: "/mobile/",
      registrations: 1,
      activeState: "activated",
      controlled: false,
    });
  expect(sensitiveRequests).toEqual([]);
  expect(
    await page.evaluate(async () => {
      const browser = globalThis as unknown as {
        readonly caches?: { keys(): Promise<string[]> };
        readonly indexedDB: {
          databases?: () => Promise<Array<{ readonly name?: string }>>;
        };
      };
      return {
        cacheKeys: browser.caches === undefined ? [] : await browser.caches.keys(),
        localKeys: Object.keys(localStorage),
        sessionKeys: Object.keys(sessionStorage),
        databases: browser.indexedDB.databases === undefined
          ? []
          : (await browser.indexedDB.databases()).map((database) => database.name),
      };
    }),
  ).toEqual({
    cacheKeys: [],
    localKeys: ["hunter-e2e-csrf"],
    sessionKeys: [],
    databases: [],
  });
  const results = await page.evaluate(async () => {
    const candidates = [
      "/api/v1/mobile/shell",
      "/api/v1/mobile/files",
      "/api/v1/mobile/open",
      "/api/v1/mobile/artifacts",
      "/api/v1/mobile/providers/codex/resume",
    ];
    return await Promise.all(candidates.map(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "whoami",
          path: "C:\\private",
          url: "https://provider.invalid",
          providerOperation: "codex.resume",
        }),
      });
      const responseText = await response.text();
      return {
        url,
        acceptedAsOperation:
          response.ok
          && (response.headers.get("content-type") ?? "").includes(
            "application/json",
          ),
        reflectedPayload:
          responseText.includes("whoami")
          || responseText.includes("C:\\private")
          || responseText.includes("provider.invalid")
          || responseText.includes("codex.resume"),
      };
    }));
  });

  expect(results).toEqual([
    { url: "/api/v1/mobile/shell", acceptedAsOperation: false, reflectedPayload: false },
    { url: "/api/v1/mobile/files", acceptedAsOperation: false, reflectedPayload: false },
    { url: "/api/v1/mobile/open", acceptedAsOperation: false, reflectedPayload: false },
    { url: "/api/v1/mobile/artifacts", acceptedAsOperation: false, reflectedPayload: false },
    {
      url: "/api/v1/mobile/providers/codex/resume",
      acceptedAsOperation: false,
      reflectedPayload: false,
    },
  ]);
});
