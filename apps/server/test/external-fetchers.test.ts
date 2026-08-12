import { describe, expect, it } from "vitest";

import {
  ExternalFetchError,
  fetchExternalSnapshot,
  fetchGithubSnapshot,
  fetchNpmSnapshot,
  normalizeGithubRef,
  normalizeNpmRef,
  readExternalJson
} from "../src/external/fetchers.js";

describe("external skill source normalization", () => {
  it("normalizes npm and github refs", () => {
    expect(normalizeNpmRef(" @scope/pkg ")).toBe("@scope/pkg");
    expect(normalizeGithubRef("https://github.com/acme/widget.git")).toEqual({
      owner: "acme",
      repo: "widget",
      ref: "acme/widget"
    });
    expect(normalizeGithubRef("acme/widget")).toEqual({
      owner: "acme",
      repo: "widget",
      ref: "acme/widget"
    });
  });

  it("rejects invalid refs", () => {
    expect(() => normalizeNpmRef("")).toThrow(ExternalFetchError);
    expect(() => normalizeGithubRef("not-a-repo")).toThrow(ExternalFetchError);
  });
});

describe("external skill fetchers", () => {
  it("stops a source request that ignores AbortSignal after the configured deadline", async () => {
    await expect(fetchNpmSnapshot("@acme/never", {
      timeoutMs: 20,
      fetch: async () => new Promise<Response>(() => undefined)
    })).rejects.toMatchObject({
      code: "EXTERNAL_FETCH_TIMEOUT",
      statusCode: 504
    });
  });

  it("applies one absolute deadline to a slowly streaming response body", async () => {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        let emitted = 0;
        timer = setInterval(() => {
          controller.enqueue(encoder.encode(emitted === 0 ? "[" : emitted < 20 ? "0," : "0]"));
          emitted += 1;
          if (emitted > 20) {
            clearInterval(timer);
            controller.close();
          }
        }, 10);
      },
      cancel() {
        if (timer !== undefined) clearInterval(timer);
      }
    }));

    await expect(readExternalJson(response, 1024, 20)).rejects.toMatchObject({
      code: "EXTERNAL_FETCH_TIMEOUT",
      statusCode: 504
    });
  });

  it("fetches npm metadata snapshot via injected fetch", async () => {
    const snapshot = await fetchNpmSnapshot("@acme/widget", {
      now: () => "2026-07-12T00:00:00.000Z",
      fetch: async (input) => {
        expect(String(input)).toBe("https://registry.npmjs.org/%40acme%2Fwidget");
        return new Response(JSON.stringify({
          name: "@acme/widget",
          readme: "# Widget\n",
          "dist-tags": { latest: "1.2.3" },
          versions: {
            "1.2.3": {
              name: "@acme/widget",
              description: "A widget",
              license: "MIT",
              homepage: "https://example.com",
              version: "1.2.3"
            }
          }
        }), { status: 200 });
      }
    });
    expect(snapshot).toEqual({
      name: "@acme/widget",
      description: "A widget",
      version: "1.2.3",
      readme: "# Widget\n",
      installCommand: "npm install @acme/widget",
      license: "MIT",
      homepage: "https://example.com",
      releaseUrl: "https://example.com",
      fetchedAt: "2026-07-12T00:00:00.000Z"
    });
  });

  it("uses linked GitHub release notes to enrich npm version history", async () => {
    const fetched = await fetchExternalSnapshot({ type: "npm", ref: "@acme/widget" }, {
      now: () => "2026-07-12T00:00:00.000Z",
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("registry.npmjs.org")) {
          return new Response(JSON.stringify({
            name: "@acme/widget",
            "dist-tags": { latest: "1.2.0" },
            repository: { type: "git", url: "git+https://github.com/acme/widget.git" },
            versions: {
              "1.1.0": { name: "@acme/widget", version: "1.1.0", description: "Widget" },
              "1.2.0": { name: "@acme/widget", version: "1.2.0", description: "Widget" }
            }
          }), { status: 200 });
        }
        if (url.endsWith("/repos/acme/widget/releases?per_page=100")) {
          return new Response(JSON.stringify([
            { tag_name: "v1.2.0", name: "Reliable refresh", body: "- Fix frozen refresh state\n- Preserve summaries", html_url: "https://github.com/acme/widget/releases/tag/v1.2.0", published_at: "2026-03-01T00:00:00.000Z" },
            { tag_name: "v1.1.0", name: "First update", body: "- Add batch mode", html_url: "https://github.com/acme/widget/releases/tag/v1.1.0", published_at: "2026-02-01T00:00:00.000Z" }
          ]), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    expect(fetched.releases).toEqual([
      expect.objectContaining({ version: "1.1.0", title: "First update", changes: ["Add batch mode"] }),
      expect.objectContaining({ version: "1.2.0", title: "Reliable refresh", changes: ["Fix frozen refresh state", "Preserve summaries"] })
    ]);
  });

  it("fetches github metadata snapshot via injected fetch", async () => {
    const calls: string[] = [];
    const snapshot = await fetchGithubSnapshot("acme", "widget", {
      now: () => "2026-07-12T01:00:00.000Z",
      githubToken: "ghp_test",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(url);
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer ghp_test");
        if (url.endsWith("/repos/acme/widget")) {
          return new Response(JSON.stringify({
            full_name: "acme/widget",
            description: "GitHub widget",
            html_url: "https://github.com/acme/widget",
            homepage: "",
            default_branch: "main",
            license: { spdx_id: "Apache-2.0" }
          }), { status: 200 });
        }
        if (url.endsWith("/releases?per_page=100")) {
          return new Response(JSON.stringify([{
            tag_name: "v2.0.0",
            html_url: "https://github.com/acme/widget/releases/tag/v2.0.0"
          }]), { status: 200 });
        }
        if (url.endsWith("/readme")) {
          return new Response(JSON.stringify({
            encoding: "base64",
            content: Buffer.from("# Hello\n").toString("base64")
          }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
    });
    expect(calls).toEqual([
      "https://api.github.com/repos/acme/widget",
      "https://api.github.com/repos/acme/widget/releases?per_page=100",
      "https://api.github.com/repos/acme/widget/readme"
    ]);
    expect(snapshot).toMatchObject({
      name: "acme/widget",
      description: "GitHub widget",
      version: "v2.0.0",
      readme: "# Hello\n",
      installCommand: "https://github.com/acme/widget",
      license: "Apache-2.0",
      releaseUrl: "https://github.com/acme/widget/releases/tag/v2.0.0"
    });
  });

  it("maps missing upstream to EXTERNAL_SOURCE_NOT_FOUND", async () => {
    await expect(fetchNpmSnapshot("missing-pkg", {
      fetch: async () => new Response("missing", { status: 404 })
    })).rejects.toMatchObject({ code: "EXTERNAL_SOURCE_NOT_FOUND", statusCode: 404 });

    await expect(fetchExternalSnapshot(
      { type: "github", ref: "https://github.com/no/such" },
      { fetch: async () => new Response("missing", { status: 404 }) }
    )).rejects.toMatchObject({ code: "EXTERNAL_SOURCE_NOT_FOUND" });
  });
});
