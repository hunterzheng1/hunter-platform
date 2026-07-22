import { ExecutionPlanIdSchema, ProjectIdSchema } from "@hunter/domain";
import { describe, expect, it, vi } from "vitest";

import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { buildApp } from "../src/app.js";

const host = "hunter-test.localhost";
const origin = "app://hunter";
const body = { runId: "run_http000001", executionPlanId: "epl_http000001", workflowRevisionId: "wfr_http000001", expectedVersion: 0, idempotencyKey: "start-http-1" };

function harness() {
  const authenticator = new LocalAuthenticator("install-secret-for-tests-only");
  const credential = authenticator.issueSession({ principalId: "desktop-user", authorizedProjectIds: [ProjectIdSchema.parse("prj_http000001")], expiresAt: new Date(Date.now() + 60_000), csrf: "csrf-proof" });
  const startRun = vi.fn(async (command: unknown, actor: unknown) => {
    void command;
    void actor;
    return { runId: body.runId };
  });
  const app = buildApp({ authenticator, allowedHosts: [host], allowedOrigins: [origin], services: { projectForExecutionPlan: () => ({ projectId: ProjectIdSchema.parse("prj_http000001"), executionPlanId: ExecutionPlanIdSchema.parse(body.executionPlanId) }), startRun } });
  const headers = { host, origin, authorization: `Bearer ${credential}`, "x-csrf-token": "csrf-proof", "content-type": "application/json" };
  return { app, startRun, headers };
}

describe("secure local app", () => {
  it("keeps health minimal and sets strict security headers", async () => {
    const { app } = harness();
    const response = await app.inject({ method: "GET", url: "/health", headers: { host } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers).toMatchObject({ "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" });
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    await app.close();
  });

  it("rejects authentication, Host, Origin, CSRF, content type, and schema failures before services", async () => {
    const { app, startRun, headers } = harness();
    const { authorization: ignoredAuthorization, ...withoutAuthorization } = headers;
    void ignoredAuthorization;
    const cases = [
      { headers: withoutAuthorization },
      { headers: { ...headers, host: "evil.localhost" } },
      { headers: { ...headers, origin: "https://evil.example" } },
      { headers: { ...headers, "x-csrf-token": "wrong" } },
      { headers: { ...headers, "content-type": "text/plain" } },
    ];
    for (const item of cases) {
      const response = await app.inject({ method: "POST", url: "/runs", headers: item.headers as never, payload: body });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    const malformed = await app.inject({ method: "POST", url: "/runs", headers, payload: { ...body, absolutePath: "C:/private" } });
    expect(malformed.statusCode).toBe(400);
    expect(startRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("authorizes scope and calls only the application command", async () => {
    const { app, startRun, headers } = harness();
    const response = await app.inject({ method: "POST", url: "/runs", headers, payload: body });
    expect(response.statusCode).toBe(200);
    expect(startRun).toHaveBeenCalledOnce();
    expect(startRun.mock.calls[0]![1]).toMatchObject({ actorId: "desktop-user" });
    expect(await app.inject({ method: "POST", url: "/pair", headers, payload: {} }).then((value) => value.statusCode)).toBe(404);
    await app.close();
  });
});
