import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Docker Compose npm publishing overlay", () => {
  it("provisions a persistent file-backed encryption key for managed credentials", async () => {
    const source = await readFile(
      new URL("../../../docker-compose.yml", import.meta.url),
      "utf8"
    );
    const compose = parse(source) as {
      services: {
        server: {
          environment: Record<string, string>;
          entrypoint: string[];
          volumes: string[];
        };
      };
    };

    expect(compose.services.server.environment.HUNTER_HARNESS_CREDENTIAL_KEY_FILE)
      .toBe("/var/lib/hunter-harness/secrets/credential-key");
    expect(compose.services.server.volumes)
      .toContain("ai-secrets:/var/lib/hunter-harness/secrets");
    const entrypoint = compose.services.server.entrypoint.join("\n");
    expect(entrypoint).toContain("randomBytes(32).toString('base64')");
    expect(entrypoint).toContain("chmod 600");
    expect(source).not.toMatch(/HUNTER_HARNESS_CREDENTIAL_KEY:\s*\S+/);
  });

  it("mounts the host npm token as a file-backed server secret", async () => {
    const source = await readFile(
      new URL("../../../docker-compose.npm.yml", import.meta.url),
      "utf8"
    );
    const compose = parse(source) as {
      services: {
        server: {
          environment: Record<string, string>;
          secrets: string[];
        };
      };
      secrets: Record<string, { environment: string }>;
    };

    expect(compose.services.server.environment.HUNTER_HARNESS_NPM_TOKEN_FILE)
      .toBe("/run/secrets/npm_token");
    expect(compose.services.server.secrets).toContain("npm_token");
    expect(compose.secrets.npm_token).toEqual({
      environment: "HUNTER_HARNESS_NPM_TOKEN"
    });
    expect(source).not.toContain("HUNTER_HARNESS_NPM_TOKEN:");
  });
});
