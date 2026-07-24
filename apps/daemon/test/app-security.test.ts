import { ExecutionPlanIdSchema, ProjectIdSchema } from "@hunter/domain";
import { describe, expect, it, vi } from "vitest";

import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { assertLoopbackListenOptions, buildApp } from "../src/app.js";

const host = "hunter-test.localhost";
const origin = "app://hunter";
const body = { runId: "run_http000001", executionPlanId: "epl_http000001", workflowRevisionId: "wfr_http000001", expectedVersion: 0, idempotencyKey: "start-http-1" };

function harness(options: { readonly expiresAt?: Date; readonly limits?: { readonly maxConcurrentRequests?: number; readonly maxRequestsPerWindow?: number; readonly rateWindowMs?: number }; readonly bodyLimit?: number; readonly requestTimeoutMs?: number; readonly authorizedProjectIds?: readonly ReturnType<typeof ProjectIdSchema.parse>[]; readonly planProjectId?: ReturnType<typeof ProjectIdSchema.parse>; readonly startRunImplementation?: (command: unknown, actor: unknown) => Promise<unknown> } = {}) {
  const authenticator = new LocalAuthenticator("install-secret-for-tests-only");
  const credential = authenticator.issueSession({ principalId: "desktop-user", authorizedProjectIds: options.authorizedProjectIds ?? [ProjectIdSchema.parse("prj_http000001")], expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000), csrf: "csrf-proof" });
  const startRun = vi.fn(options.startRunImplementation ?? (async (command: unknown, actor: unknown) => {
    void command;
    void actor;
    return { runId: body.runId };
  }));
  const app = buildApp({ authenticator, allowedHosts: [host], allowedOrigins: [origin], ...(options.limits === undefined ? {} : { limits: options.limits }), ...(options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit }), ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }), services: { listProjects: async (projectIds) => projectIds.map((projectId) => ({ projectId })), projectForExecutionPlan: () => ({ projectId: options.planProjectId ?? ProjectIdSchema.parse("prj_http000001"), executionPlanId: ExecutionPlanIdSchema.parse(body.executionPlanId) }), projectForRun: () => null, startRun } });
  const headers = { host, origin, authorization: `Bearer ${credential}`, "x-csrf-token": "csrf-proof", "content-type": "application/json" };
  return { app, startRun, headers };
}

describe("secure local app", () => {
  it("uses short-lived revocable session capabilities rather than exposing the install secret", () => {
    let revoked = false;
    const authenticator = new LocalAuthenticator("revocation-secret-tests", () => revoked);
    const token = authenticator.issueSession({ principalId: "desktop-user", authorizedProjectIds: [ProjectIdSchema.parse("prj_http000001")], expiresAt: new Date(Date.now() + 60_000), csrf: "csrf-proof" });
    expect(authenticator.authenticate(token).principalId).toBe("desktop-user");
    expect(token).not.toContain("revocation-secret-tests");
    revoked = true;
    expect(() => authenticator.authenticate(token)).toThrow(/LOCAL_CREDENTIAL_REVOKED/u);
  });
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
    expect((await app.inject({ method: "POST", url: "/runs", headers, payload: { ...body, idempotencyKey: "short" } })).statusCode).toBe(400);
    expect(startRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("authorizes scope and calls only the application command", async () => {
    const { app, startRun, headers } = harness();
    const response = await app.inject({ method: "POST", url: "/runs", headers, payload: body });
    expect(response.statusCode).toBe(200);
    expect(startRun).toHaveBeenCalledOnce();
    expect(startRun.mock.calls[0]![1]).toMatchObject({ actorId: "desktop-user" });
    for (const path of [
      "/pair",
      "/api/v1/devices/pairing-code",
      "/api/v1/devices/pair",
      "/api/v1/mobile/commands",
    ]) {
      expect(await app.inject({ method: "POST", url: path, headers, payload: {} }).then((value) => value.statusCode)).toBe(404);
    }
    await app.close();

    const forbidden = harness({ planProjectId: ProjectIdSchema.parse("prj_http000002") });
    expect((await forbidden.app.inject({ method: "POST", url: "/runs", headers: forbidden.headers, payload: body })).statusCode).toBe(403);
    expect(forbidden.startRun).not.toHaveBeenCalled();
    await forbidden.app.close();
  });

  it("fixes request timeouts and forbids every non-random or non-loopback listener", async () => {
    const { app } = harness({ requestTimeoutMs: 1_234 });
    expect((app.initialConfig as unknown as { readonly requestTimeout: number }).requestTimeout).toBe(1_234);
    expect(app.initialConfig.connectionTimeout).toBe(1_234);
    expect(() => assertLoopbackListenOptions({ host: "0.0.0.0", port: 0 })).toThrow(/FOUNDATION_REMOTE_LISTENER_FORBIDDEN/u);
    expect(() => assertLoopbackListenOptions({ host: "127.0.0.1", port: 8080 })).toThrow(/FOUNDATION_REMOTE_LISTENER_FORBIDDEN/u);
    expect(() => assertLoopbackListenOptions({ host: "127.0.0.1", port: 0 })).not.toThrow();
    await app.close();
  });

  it("rejects expired credentials, rate overflow, and oversized bodies before application services", async () => {
    const expired = harness({ expiresAt: new Date(Date.now() - 1_000) });
    expect((await expired.app.inject({ method: "POST", url: "/runs", headers: expired.headers, payload: body })).statusCode).toBe(401);
    expect(expired.startRun).not.toHaveBeenCalled();
    await expired.app.close();

    const limited = harness({ limits: { maxRequestsPerWindow: 1, rateWindowMs: 60_000 } });
    expect((await limited.app.inject({ method: "POST", url: "/runs", headers: limited.headers, payload: body })).statusCode).toBe(200);
    expect((await limited.app.inject({ method: "POST", url: "/runs", headers: limited.headers, payload: { ...body, idempotencyKey: "start-http-2" } })).statusCode).toBe(429);
    expect(limited.startRun).toHaveBeenCalledTimes(1);
    await limited.app.close();

    const small = harness({ bodyLimit: 32 });
    expect((await small.app.inject({ method: "POST", url: "/runs", headers: small.headers, payload: body })).statusCode).toBe(413);
    expect(small.startRun).not.toHaveBeenCalled();
    await small.app.close();
  });

  it("caps concurrent requests without starting a second application command", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const concurrent = harness({ limits: { maxConcurrentRequests: 1 }, startRunImplementation: async () => { await blocked; return { runId: body.runId }; } });
    const first = concurrent.app.inject({ method: "POST", url: "/runs", headers: concurrent.headers, payload: body });
    await vi.waitFor(() => expect(concurrent.startRun).toHaveBeenCalledOnce());
    const second = await concurrent.app.inject({ method: "POST", url: "/runs", headers: concurrent.headers, payload: { ...body, idempotencyKey: "start-http-concurrent" } });
    expect(second.statusCode).toBe(503);
    expect(concurrent.startRun).toHaveBeenCalledTimes(1);
    release?.();
    expect((await first).statusCode).toBe(200);
    await concurrent.app.close();
  });
});
