import { createHash, generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import {
  DeviceGateway,
  DeviceStore,
  MobileCommandEnvelopeSchema,
  MobileCommandResultSchema,
  MobileRunProjectionSchema,
  PairingService,
  TokenService,
  createDeviceProofMessage,
  createPairingCompletionProofMessage,
  createRefreshProofMessage,
  type DeviceCommandPrincipal,
} from "@hunter/device-gateway";
import {
  AttemptIdSchema,
  ChangeRevisionIdSchema,
  DeviceIdSchema,
  ExecutionPlanIdSchema,
  ProjectIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
  StepRunIdSchema,
  canonicalSha256,
  createWorkflowRevision,
} from "@hunter/domain";
import {
  FlowEngine,
  createWorkflowRunBinding,
} from "@hunter/flow-engine";
import { EventLedgerReader, SqliteOperationJournal } from "@hunter/storage";
import { afterEach, describe, expect, it } from "vitest";

import { buildRemoteDeviceApp } from "../src/auth/remote-device-auth.js";
import { startRemoteTlsListener } from "../src/auth/remote-tls-listener.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { buildApp } from "../src/app.js";
import { DurableEventStream } from "../src/events/durable-event-stream.js";
import { createMobileProjectionProvider } from "../src/routes/mobile-projections.js";
import { SqliteFlowStore } from "../src/services/sqlite-application-services.js";

const projectId = ProjectIdSchema.parse("prj_mobile00001");
const otherProjectId = ProjectIdSchema.parse("prj_mobile00002");
const runId = RunIdSchema.parse("run_mobile00001");
const stepRunId = StepRunIdSchema.parse("spr_mobile00001");
const otherStepRunId = StepRunIdSchema.parse("spr_mobile00002");
const attemptId = AttemptIdSchema.parse("att_mobile00001");
const workflowPack = JSON.parse(
  readFileSync(
    join(process.cwd(), "workflow-packs/hunter-default/change-delivery.v1.json"),
    "utf8",
  ),
) as { revision: unknown };
const workflow = createWorkflowRevision(workflowPack.revision);
const agentStep = workflow.steps.find(({ kind }) => kind === "agent")!;
const gateStep = workflow.steps.find(({ kind }) => kind === "human_gate")!;

const principal: DeviceCommandPrincipal = {
  deviceId: DeviceIdSchema.parse("dvc_mobile00001"),
  scopes: ["runs:read", "gates:approve", "runs:control"],
  projectIds: [projectId],
};

describe("mobile command transaction boundary", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  function setup(gateDecision: "pending" | "approved" | "rejected" = "pending") {
    database = new DatabaseSync(":memory:");
    const journal = new SqliteOperationJournal(database);
    const flowStore = new SqliteFlowStore(
      database,
      journal,
      () => new Date("2026-07-24T00:01:00.000Z"),
    );
    const flowEngine = new FlowEngine(flowStore, {
      getWorkflowRevision: (candidate) =>
        candidate === workflow.workflowRevisionId ? workflow : null,
      getExecutionPlan: () => null,
      getRequirementRevision: () => null,
    });
    const gateMode = gateDecision !== "pending";
    const selectedStep = gateMode ? gateStep : agentStep;
    const binding = createWorkflowRunBinding({
      runId,
      projectId,
      changeRevisionId: ChangeRevisionIdSchema.parse("crv_mobilechange01"),
      requirementRevisionIds: [
        RequirementRevisionIdSchema.parse("rrv_mobilerevision01"),
      ],
      workflowRevisionId: workflow.workflowRevisionId,
      policySnapshot: { snapshotHash: "a".repeat(64), policyVersion: 1 },
      initialBudget: {
        maxAttempts: 5,
        maxElapsedMs: 60_000,
        maxCost: 100,
        maxTokens: 10_000,
        maxLoopIterations: 3,
      },
      subjectKind: "change",
      parentRunId: null,
      taskId: null,
      executionPlanId: ExecutionPlanIdSchema.parse("epl_mobileplan01"),
      taskGraphFingerprint: "b".repeat(64),
    });
    const seedEvents = [
      { type: "RunStarted" as const, binding },
      {
        type: "StepActivated" as const,
        stepRunId,
        stepId: selectedStep.stepId,
        attemptId,
        attemptNumber: 1,
        fixedContentHash: canonicalSha256({ runId, stepRunId }),
      },
      ...(gateMode
        ? [{
            type: "ExternalObservationRecorded" as const,
            stepRunId,
            attemptId,
            fact: "agent_returned" as const,
            executionStatus: "returned" as const,
          }]
        : []),
    ];
    journal.commitCommand({
      commandId: "seed-mobile-run",
      requestFingerprint: "a".repeat(64),
      projectId,
      aggregateId: `run:${runId}`,
      expectedVersion: 0,
      actor: { actorId: "seed", correlationId: "seed" },
      events: seedEvents.map((flowEvent, index) => ({
          eventId: `evt_mobile_seed0${index + 1}`,
          eventType: "FlowEvent",
          eventData: { flowEvent },
          schemaVersion: 1,
          occurredAt: "2026-07-24T00:00:00.000Z",
        })),
      operations: [],
      response: { seeded: true },
    });
    const gateway = new DeviceGateway({
      journal,
      commands: flowEngine,
    });
    return {
      gateway,
      flowEngine,
      flowStore,
      expectedVersion: flowStore.loadRun(runId)!.version,
      gateId: gateMode ? flowEngine.activeHumanGateId(runId) : undefined,
    };
  }

  it("derives stable replay-safe controls from canonical Flow state", () => {
    const { flowStore } = setup();
    const projections = createMobileProjectionProvider({
      flowStore,
      repositories: {
        getProject: (candidate) =>
          candidate === projectId ? { projectId, name: "Canonical mobile project" } : null,
        getWorkflowRevision: (candidate) =>
          candidate === workflow.workflowRevisionId ? workflow : null,
      },
    }).list([projectId]);

    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      projectId,
      runId,
      projectName: "Canonical mobile project",
      connection: "online",
    });
    expect(projections[0]!.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "pause_run",
        stepRunId,
        expectedVersion: flowStore.loadRun(runId)!.version,
      }),
    ]));
    expect(new Set(projections[0]!.commands.map(({ idempotencyKey }) => idempotencyKey)).size)
      .toBe(projections[0]!.commands.length);
  });

  it("returns the original receipt for the same key and fingerprint and advances once", () => {
    const { gateway, flowEngine, flowStore, expectedVersion } = setup();
    const command = MobileCommandEnvelopeSchema.parse({
      projectId,
      runId,
      stepRunId,
      expectedVersion,
      idempotencyKey: "mobile-command-stable-0001",
      action: "pause_run",
      payload: {},
    });

    const first = gateway.execute(command, principal);
    const replay = gateway.execute(command, principal);

    expect(replay).toEqual(first);
    expect(
      (
        database!
          .prepare("SELECT COUNT(*) AS count FROM events WHERE aggregate_id = ?")
          .get(`run:${runId}`) as { count: number }
      ).count,
    ).toBe(3);
    expect(
      (
        database!
          .prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE command_id = ?")
          .get(`ApplyRunControl:${command.idempotencyKey}`) as { count: number }
      ).count,
    ).toBe(1);
    const reloaded = flowStore.loadRun(runId)!;
    expect(reloaded.status).toBe("paused");
    flowEngine.handle({
      type: "ApplyRunControl",
      projectId,
      runId,
      target: { kind: "step", stepRunId },
      action: "resume",
      payload: {},
      expectedVersion: reloaded.version,
      idempotencyKey: "desktop-resume-after-mobile-0001",
      actor: { actorId: "desktop-owner", correlationId: "desktop-resume" },
    });
    expect(flowStore.loadRun(runId)!.status).toBe("running");
  });

  it("rejects idempotency reuse, stale versions, missing scope, and object-scope mismatches", () => {
    const { gateway, flowStore, expectedVersion } = setup();
    const base = {
      projectId,
      runId,
      stepRunId,
      expectedVersion,
      idempotencyKey: "mobile-command-stable-0002",
      action: "pause_run" as const,
      payload: {},
    };
    gateway.execute(MobileCommandEnvelopeSchema.parse(base), principal);

    expect(() =>
      gateway.execute(
        MobileCommandEnvelopeSchema.parse({
          ...base,
          action: "resume_run",
        }),
        principal,
      ),
    ).toThrowError("IDEMPOTENCY_KEY_REUSED");
    expect(() =>
      gateway.execute(
        MobileCommandEnvelopeSchema.parse({
          ...base,
          idempotencyKey: "mobile-command-stale-0003",
          expectedVersion,
        }),
        principal,
      ),
    ).toThrowError(/EXPECTED_VERSION_CONFLICT/u);
    expect(() =>
      gateway.execute(
        MobileCommandEnvelopeSchema.parse({
          ...base,
          idempotencyKey: "mobile-command-scope-0004",
          expectedVersion: flowStore.loadRun(runId)!.version,
        }),
        { ...principal, scopes: ["runs:read"] },
      ),
    ).toThrowError("DEVICE_SCOPE_FORBIDDEN");
    expect(() =>
      gateway.execute(
        MobileCommandEnvelopeSchema.parse({
          ...base,
          stepRunId: otherStepRunId,
          idempotencyKey: "mobile-command-target-0005",
          expectedVersion: flowStore.loadRun(runId)!.version,
        }),
        principal,
      ),
    ).toThrowError("COMMAND_TARGET_SCOPE_MISMATCH");
  });

  it("records a Gate decision once even when approval is replayed", () => {
    const { gateway, expectedVersion, gateId } = setup("approved");
    const command = MobileCommandEnvelopeSchema.parse({
      projectId,
      runId,
      gateId,
      expectedVersion,
      idempotencyKey: "mobile-gate-approval-0001",
      action: "approve_gate",
      payload: {},
    });

    const first = gateway.execute(command, principal);
    expect(gateway.execute(command, principal)).toEqual(first);
    expect(
      (
        database!
          .prepare(
            "SELECT COUNT(*) AS count FROM events WHERE event_type = 'FlowEvent' AND json_extract(event_data, '$.flowEvent.type') = 'VerificationChanged' AND json_extract(event_data, '$.flowEvent.status') = 'passed'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
  });

  it("rejects a Gate that another trusted channel already decided", () => {
    const { gateway, flowStore, expectedVersion, gateId } = setup("approved");
    gateway.execute(MobileCommandEnvelopeSchema.parse({
      projectId,
      runId,
      gateId,
      expectedVersion,
      idempotencyKey: "mobile-gate-already-decided-0001",
      action: "approve_gate",
      payload: {},
    }), principal);
    const command = MobileCommandEnvelopeSchema.parse({
      projectId,
      runId,
      gateId,
      expectedVersion: flowStore.loadRun(runId)!.version,
      idempotencyKey: "mobile-gate-already-decided-0002",
      action: "approve_gate",
      payload: {},
    });

    expect(() => gateway.execute(command, principal)).toThrowError("GATE_ALREADY_DECIDED");
  });
});

describe("remote device HTTP boundary", () => {
  let database: DatabaseSync | undefined;
  const now = new Date("2026-07-24T00:00:00.000Z");

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  async function setupRemote(
    limits: {
      readonly maxConcurrentRequests?: number;
      readonly maxRequestsPerWindow?: number;
      readonly rateWindowMs?: number;
    } = {
      maxConcurrentRequests: 4,
      maxRequestsPerWindow: 20,
      rateWindowMs: 60_000,
    },
  ) {
    database = new DatabaseSync(":memory:");
    const journal = new SqliteOperationJournal(database);
    const store = new DeviceStore(database);
    const pairing = new PairingService({ store, now: () => now });
    const pair = pairing.createChallenge({
      kind: "authenticated_desktop",
      principalId: "desktop-owner",
    });
    const generated = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const publicJwk = generated.publicKey.export({ format: "jwk" }) as JsonWebKey;
    const pairingMessage = `hunter-pairing-v1\n${pair.pairingId}\n${pair.challenge}`;
    const proof = sign(
      "sha256",
      Buffer.from(pairingMessage),
      { key: generated.privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64url");
    const device = pairing.confirmPairing({
      desktopPrincipal: {
        kind: "authenticated_desktop",
        principalId: "desktop-owner",
      },
      pairingId: pair.pairingId,
      challenge: pair.challenge,
      publicJwk,
      proof,
      deviceName: "Remote Pocket",
      scopes: ["runs:read", "gates:approve", "runs:control"],
      projectIds: [projectId],
      deviceExpiresAt: "2026-08-20T00:00:00.000Z",
    });
    const tokens = await TokenService.create({
      store,
      issuer: "https://hunter.local/device",
      audience: "hunter-mobile",
      signingSecretRef: "os-credential://hunter/device-signing",
      secretStore: {
        resolveSecret: async () => "remote-test-signing-material-at-least-32",
      },
      now: () => now,
    });
    const credentials = tokens.issue(device.deviceId);
    const flowStore = new SqliteFlowStore(database, journal, () => now);
    const flowEngine = new FlowEngine(flowStore, {
      getWorkflowRevision: (candidate) =>
        candidate === workflow.workflowRevisionId ? workflow : null,
      getExecutionPlan: () => null,
      getRequirementRevision: () => null,
    });
    const binding = createWorkflowRunBinding({
      runId,
      projectId,
      changeRevisionId: ChangeRevisionIdSchema.parse("crv_mobilechange01"),
      requirementRevisionIds: [
        RequirementRevisionIdSchema.parse("rrv_mobilerevision01"),
      ],
      workflowRevisionId: workflow.workflowRevisionId,
      policySnapshot: { snapshotHash: "a".repeat(64), policyVersion: 1 },
      initialBudget: {
        maxAttempts: 5,
        maxElapsedMs: 60_000,
        maxCost: 100,
        maxTokens: 10_000,
        maxLoopIterations: 3,
      },
      subjectKind: "change",
      parentRunId: null,
      taskId: null,
      executionPlanId: ExecutionPlanIdSchema.parse("epl_mobileplan01"),
      taskGraphFingerprint: "b".repeat(64),
    });
    journal.commitCommand({
      commandId: "seed-remote-run",
      requestFingerprint: createHash("sha256").update("seed-remote-run").digest("hex"),
      projectId,
      aggregateId: `run:${runId}`,
      expectedVersion: 0,
      actor: { actorId: "seed", correlationId: "seed" },
      events: [
        { type: "RunStarted" as const, binding },
        {
          type: "StepActivated" as const,
          stepRunId,
          stepId: agentStep.stepId,
          attemptId,
          attemptNumber: 1,
          fixedContentHash: canonicalSha256({ runId, stepRunId }),
        },
      ].map((flowEvent, index) => ({
        eventId: `evt_remote_seed000${index + 1}`,
        eventType: "FlowEvent",
        eventData: { flowEvent },
        schemaVersion: 1,
        occurredAt: now.toISOString(),
      })),
      operations: [],
      response: {},
    });
    const gateway = new DeviceGateway({
      journal,
      commands: flowEngine,
    });
    const app = buildRemoteDeviceApp({
      tokens,
      pairing,
      gateway,
      eventStream: new DurableEventStream(new EventLedgerReader(database)),
      projections: {
        list: (authorizedProjectIds) =>
          authorizedProjectIds.includes(projectId)
            ? [MobileRunProjectionSchema.parse({
                projectId,
                runId,
                projectName: "Mobile project",
                currentStep: "Planning agent",
                attention: "Run is active",
                connection: "online",
                commands: [{
                  projectId,
                  runId,
                  stepRunId,
                  expectedVersion: 2,
                  idempotencyKey: "projection-pause-command-0001",
                  action: "pause_run",
                  payload: {},
                }],
              })]
            : [],
      },
      allowedHosts: ["remote.hunter"],
      allowedOrigins: ["https://phone.example"],
      limits,
      https: {},
    });
    const signRequest = (input: {
      readonly accessToken: string;
      readonly method: string;
      readonly url: string;
      readonly body: unknown;
      readonly nonce: string;
    }) => {
      const timestamp = now.toISOString();
      const message = createDeviceProofMessage({
        ...input,
        timestamp,
      });
      return {
        host: "remote.hunter",
        origin: "https://phone.example",
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
        "x-device-timestamp": timestamp,
        "x-device-nonce": input.nonce,
        "x-device-proof": sign(
          "sha256",
          Buffer.from(message),
          { key: generated.privateKey, dsaEncoding: "ieee-p1363" },
        ).toString("base64url"),
      };
    };
    const signRefresh = (input: {
      readonly refreshCredential: string;
      readonly nonce: string;
    }) => {
      const timestamp = now.toISOString();
      return {
        refreshCredential: input.refreshCredential,
        timestamp,
        nonce: input.nonce,
        proof: sign(
          "sha256",
          Buffer.from(createRefreshProofMessage({
            refreshCredential: input.refreshCredential,
            timestamp,
            nonce: input.nonce,
          })),
          { key: generated.privateKey, dsaEncoding: "ieee-p1363" },
        ).toString("base64url"),
      };
    };
    return {
      app,
      store,
      device,
      credentials,
      signRequest,
      signRefresh,
      tokens,
      pairing,
      gateway,
    };
  }

  it("bootstraps credentials only after a device proof and desktop confirmation", async () => {
    const remote = await setupRemote();
    const challenge = remote.pairing.createChallenge({
      kind: "authenticated_desktop",
      principalId: "desktop-owner",
    });
    const key = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const publicJwk = key.publicKey.export({ format: "jwk" });
    const pairingProof = sign(
      "sha256",
      Buffer.from(`hunter-pairing-v1\n${challenge.pairingId}\n${challenge.challenge}`),
      { key: key.privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64url");
    const headers = {
      host: "remote.hunter",
      origin: "https://phone.example",
      "content-type": "application/json",
    };

    const submitted = await remote.app.inject({
      method: "POST",
      url: `/api/v1/mobile/pairings/${challenge.pairingId}/submit`,
      headers,
      payload: {
        challenge: challenge.challenge,
        publicJwk,
        proof: pairingProof,
        deviceName: "New Pocket",
      },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({
      status: "pending_desktop_confirmation",
      pairingId: challenge.pairingId,
    });
    remote.pairing.confirmSubmittedPairing({
      desktopPrincipal: {
        kind: "authenticated_desktop",
        principalId: "desktop-owner",
      },
      pairingId: challenge.pairingId,
      scopes: ["runs:read", "runs:control"],
      projectIds: [projectId],
      deviceExpiresAt: "2026-08-20T00:00:00.000Z",
    });
    const timestamp = now.toISOString();
    const nonce = "remote-pairing-complete-0001";
    const completion = {
      challenge: challenge.challenge,
      timestamp,
      nonce,
      proof: sign(
        "sha256",
        Buffer.from(createPairingCompletionProofMessage({
          pairingId: challenge.pairingId,
          challenge: challenge.challenge,
          timestamp,
          nonce,
        })),
        { key: key.privateKey, dsaEncoding: "ieee-p1363" },
      ).toString("base64url"),
    };
    const completed = await remote.app.inject({
      method: "POST",
      url: `/api/v1/mobile/pairings/${challenge.pairingId}/complete`,
      headers,
      payload: completion,
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      accessToken: expect.any(String),
      refreshCredential: expect.any(String),
    });
    expect((await remote.app.inject({
      method: "POST",
      url: `/api/v1/mobile/pairings/${challenge.pairingId}/complete`,
      headers,
      payload: {
        ...completion,
        nonce: "remote-pairing-complete-0002",
        proof: sign(
          "sha256",
          Buffer.from(createPairingCompletionProofMessage({
            pairingId: challenge.pairingId,
            challenge: challenge.challenge,
            timestamp,
            nonce: "remote-pairing-complete-0002",
          })),
          { key: key.privateKey, dsaEncoding: "ieee-p1363" },
        ).toString("base64url"),
      },
    })).json()).toEqual({ code: "PAIRING_CREDENTIALS_DELIVERED" });
    await remote.app.close();
  });

  it("permits only allowlisted credential-free CORS preflight metadata", async () => {
    const remote = await setupRemote();
    const response = await remote.app.inject({
      method: "OPTIONS",
      url: "/api/v1/mobile/commands",
      headers: {
        host: "remote.hunter",
        origin: "https://phone.example",
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "authorization,content-type,x-device-timestamp,x-device-nonce,x-device-proof",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://phone.example",
    );
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect((await remote.app.inject({
      method: "OPTIONS",
      url: "/api/v1/mobile/commands",
      headers: {
        host: "remote.hunter",
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    })).statusCode).toBe(403);
    await remote.app.close();
  });

  it("requires Origin, bearer, and a fresh device proof and never falls back to cookies", async () => {
    const { app, credentials, signRequest } = await setupRemote();
    const command = MobileCommandEnvelopeSchema.parse({
      projectId,
      runId,
      stepRunId,
      expectedVersion: 2,
      idempotencyKey: "remote-mobile-command-0001",
      action: "pause_run",
      payload: {},
    });
    const url = "/api/v1/mobile/commands";
    const headers = signRequest({
      accessToken: credentials.accessToken,
      method: "POST",
      url,
      body: command,
      nonce: "remote-command-nonce-0001",
    });
    const {
      "x-device-proof": _omittedProof,
      ...headersWithoutProof
    } = headers;
    void _omittedProof;

    const accepted = await app.inject({ method: "POST", url, headers, payload: command });
    expect(accepted.statusCode).toBe(200);
    expect(MobileCommandResultSchema.parse(accepted.json())).toMatchObject({
      status: "accepted",
      receipt: {
        commandId: "ApplyRunControl:remote-mobile-command-0001",
      },
    });
    expect(
      (await app.inject({
        method: "POST",
        url,
        headers: { ...headersWithoutProof, "x-device-nonce": "missing-proof-nonce" },
        payload: { ...command, idempotencyKey: "remote-mobile-command-0002", expectedVersion: 2 },
      })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({
        method: "POST",
        url,
        headers: { ...headers, origin: "https://evil.example" },
        payload: command,
      })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({
        method: "POST",
        url,
        headers: {
          host: "remote.hunter",
          origin: "https://phone.example",
          cookie: `access=${credentials.accessToken}`,
          "content-type": "application/json",
        },
        payload: command,
      })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({
        method: "POST",
        url: "/api/v1/devices/pairing-challenges",
        headers,
        payload: {},
      })).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("rate-limits invalid command proofs by source before repeating cryptographic verification", async () => {
    const { app, credentials, signRequest } = await setupRemote({
      maxConcurrentRequests: 4,
      maxRequestsPerWindow: 1,
      rateWindowMs: 60_000,
    });
    const command = MobileCommandEnvelopeSchema.parse({
      projectId,
      runId,
      stepRunId,
      expectedVersion: 2,
      idempotencyKey: "remote-preauth-rate-command-0001",
      action: "pause_run",
      payload: {},
    });
    const url = "/api/v1/mobile/commands";
    const invalidHeaders = (nonce: string) => ({
      ...signRequest({
        accessToken: credentials.accessToken,
        method: "POST",
        url,
        body: command,
        nonce,
      }),
      "x-device-proof": "invalid-device-proof",
    });

    expect((await app.inject({
      method: "POST",
      url,
      headers: invalidHeaders("preauth-rate-nonce-0001"),
      payload: command,
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url,
      headers: invalidHeaders("preauth-rate-nonce-0002"),
      payload: command,
    })).statusCode).toBe(429);
    await app.close();
  });

  it("serves only proof-authenticated Project-scoped mobile projections", async () => {
    const { app, credentials, signRequest } = await setupRemote();
    const url = `/api/v1/mobile/runs?projectId=${projectId}`;
    const response = await app.inject({
      method: "GET",
      url,
      headers: signRequest({
        accessToken: credentials.accessToken,
        method: "GET",
        url,
        body: undefined,
        nonce: "mobile-projection-nonce-0001",
      }),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ projectId, runId, projectName: "Mobile project" }),
    ]);
    await app.close();
  });

  it("rejects revoked-token replay and unauthenticated SSE", async () => {
    const { app, store, device, credentials, signRequest } = await setupRemote();
    const url = `/api/v1/mobile/events?projectId=${projectId}`;
    expect(
      (await app.inject({
        method: "GET",
        url,
        headers: { host: "remote.hunter", origin: "https://phone.example" },
      })).statusCode,
    ).toBe(401);
    const otherProjectUrl = `/api/v1/mobile/events?projectId=${otherProjectId}`;
    expect(
      (await app.inject({
        method: "GET",
        url: otherProjectUrl,
        headers: signRequest({
          accessToken: credentials.accessToken,
          method: "GET",
          url: otherProjectUrl,
          body: undefined,
          nonce: "cross-project-events-nonce-0001",
        }),
      })).statusCode,
    ).toBe(403);
    const authorizedUrl = `/api/v1/mobile/events?projectId=${projectId}&cursor=0&once=1`;
    const authorized = await app.inject({
      method: "GET",
      url: authorizedUrl,
      headers: signRequest({
        accessToken: credentials.accessToken,
        method: "GET",
        url: authorizedUrl,
        body: undefined,
        nonce: "authorized-events-nonce-0001",
      }),
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.headers["content-type"]).toContain("text/event-stream");
    expect(authorized.body).toContain(projectId);
    expect(authorized.body).not.toContain(otherProjectId);

    store.revokeDevice(device.deviceId, now.toISOString());
    const command = MobileCommandEnvelopeSchema.parse({
      projectId,
      runId,
      stepRunId,
      expectedVersion: 1,
      idempotencyKey: "revoked-mobile-command-0001",
      action: "pause_run",
      payload: {},
    });
    expect(
      (await app.inject({
        method: "POST",
        url: "/api/v1/mobile/commands",
        headers: signRequest({
          accessToken: credentials.accessToken,
          method: "POST",
          url: "/api/v1/mobile/commands",
          body: command,
          nonce: "revoked-command-nonce-0001",
        }),
        payload: command,
      })).statusCode,
    ).toBe(401);
    await app.close();
  });

  it("rotates refresh credentials with device proof and no cookie or access-token fallback", async () => {
    const remote = await setupRemote();
    const url = "/api/v1/mobile/refresh";
    const body = remote.signRefresh({
      refreshCredential: remote.credentials.refreshCredential,
      nonce: "remote-refresh-route-0001",
    });
    const headers = {
      host: "remote.hunter",
      origin: "https://phone.example",
      "content-type": "application/json",
    };
    const response = await remote.app.inject({
      method: "POST",
      url,
      headers,
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().refreshCredential).not.toBe(remote.credentials.refreshCredential);
    expect(
      (await remote.app.inject({
        method: "POST",
        url,
        headers: {
          ...headers,
          cookie: `refresh=${remote.credentials.refreshCredential}`,
        },
        payload: {},
      })).statusCode,
    ).toBe(401);
    expect(
      (await remote.app.inject({
        method: "POST",
        url,
        headers,
        payload: remote.signRefresh({
          refreshCredential: remote.credentials.refreshCredential,
          nonce: "remote-refresh-route-0002",
        }),
      })).statusCode,
    ).toBe(401);
    await remote.app.close();
  });

  it("rate-limits refresh proof verification before rotating another credential", async () => {
    const remote = await setupRemote({
      maxConcurrentRequests: 4,
      maxRequestsPerWindow: 1,
      rateWindowMs: 60_000,
    });
    const url = "/api/v1/mobile/refresh";
    const headers = {
      host: "remote.hunter",
      origin: "https://phone.example",
      "content-type": "application/json",
    };
    const first = await remote.app.inject({
      method: "POST",
      url,
      headers,
      payload: remote.signRefresh({
        refreshCredential: remote.credentials.refreshCredential,
        nonce: "rate-refresh-route-0001",
      }),
    });
    expect(first.statusCode).toBe(200);
    const rotated = first.json() as { refreshCredential: string };
    expect(
      (await remote.app.inject({
        method: "POST",
        url,
        headers,
        payload: remote.signRefresh({
          refreshCredential: rotated.refreshCredential,
          nonce: "rate-refresh-route-0002",
        }),
      })).statusCode,
    ).toBe(429);
    await remote.app.close();
  });

  it("keeps the remote listener disabled by default", async () => {
    await expect(startRemoteTlsListener({ enabled: false })).resolves.toEqual({
      status: "disabled",
    });
    const remote = await setupRemote();
    expect(() =>
      buildRemoteDeviceApp({
        tokens: remote.tokens,
        gateway: remote.gateway,
        allowedHosts: ["remote.hunter"],
        allowedOrigins: ["https://phone.example"],
      } as never),
    ).toThrowError("REMOTE_HTTPS_REQUIRED");
    await remote.app.close();
  });

  it("starts only a real TLS 1.3 non-loopback listener when explicitly enabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hunter-remote-tls-"));
    const keyPath = join(directory, "tls.key");
    const certPath = join(directory, "tls.crt");
    const openssl = process.platform === "win32"
      ? [
          "openssl",
          "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
          "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
        ].find((candidate) =>
          spawnSync(candidate, ["version"], { stdio: "ignore" }).status === 0)
      : "openssl";
    if (openssl === undefined) throw new Error("OPENSSL_REQUIRED_FOR_TLS_TEST");
    const generated = spawnSync(
      openssl,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-days",
        "1",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=remote.hunter",
        "-addext",
        "subjectAltName=DNS:remote.hunter,IP:127.0.0.1",
      ],
      { encoding: "utf8" },
    );
    if (generated.status !== 0) {
      throw new Error(`TLS_FIXTURE_GENERATION_FAILED ${generated.stderr}`);
    }
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);
    const remote = await setupRemote();
    await remote.app.close();
    const listener = await startRemoteTlsListener({
      enabled: true,
      host: "0.0.0.0",
      port: 0,
      key,
      cert,
      buildApp: (https) =>
        buildRemoteDeviceApp({
          tokens: remote.tokens,
          pairing: remote.pairing,
          gateway: remote.gateway,
          eventStream: new DurableEventStream(new EventLedgerReader(database!)),
          projections: {
            list: () => [],
          },
          allowedHosts: ["remote.hunter"],
          allowedOrigins: ["https://phone.example"],
          https,
        }),
    });
    if (listener.status !== "listening") throw new Error("REMOTE_LISTENER_NOT_STARTED");
    try {
      const port = Number(new URL(listener.address).port);
      const url = `/api/v1/mobile/events?projectId=${projectId}&cursor=0&once=1`;
      const headers = remote.signRequest({
        accessToken: remote.credentials.accessToken,
        method: "GET",
        url,
        body: undefined,
        nonce: "real-tls-events-nonce-0001",
      });
      const result = await new Promise<{ status: number | undefined; protocol: string | null }>(
        (resolve, reject) => {
          const request = httpsRequest(
            {
              hostname: "127.0.0.1",
              port,
              path: url,
              method: "GET",
              ca: cert,
              rejectUnauthorized: true,
              headers,
            },
            (response) => {
              resolve({
                status: response.statusCode,
                protocol: (
                  response.socket as import("node:tls").TLSSocket
                ).getProtocol(),
              });
              response.resume();
            },
          );
          request.on("error", reject);
          request.end();
        },
      );
      expect(result).toEqual({ status: 200, protocol: "TLSv1.3" });
    } finally {
      await listener.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("desktop-only pairing route", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("creates a challenge only through the authenticated local desktop channel", async () => {
    database = new DatabaseSync(":memory:");
    new SqliteOperationJournal(database);
    const store = new DeviceStore(database);
    const pairing = new PairingService({
      store,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });
    const authenticator = new LocalAuthenticator("desktop-pairing-tests-secret");
    const credential = authenticator.issueSession({
      principalId: "desktop-owner",
      authorizedProjectIds: [projectId],
      expiresAt: new Date(Date.now() + 60_000),
      csrf: "desktop-pairing-csrf",
    });
    const app = buildApp({
      authenticator,
      allowedHosts: ["hunter.localhost"],
      allowedOrigins: ["app://hunter"],
      services: {
        listProjects: async () => [],
        projectForExecutionPlan: () => null,
        projectForRun: () => null,
        startRun: async () => ({}),
      },
      devices: { pairing, store },
    });
    const url = "/api/v1/devices/pairing-challenges";
    const payload = {};
    const headers = {
      host: "hunter.localhost",
      origin: "app://hunter",
      authorization: `Bearer ${credential}`,
      "x-csrf-token": "desktop-pairing-csrf",
      "content-type": "application/json",
    };

    expect(
      (await app.inject({
        method: "POST",
        url,
        headers: {
          host: "hunter.localhost",
          origin: "app://hunter",
          "content-type": "application/json",
        },
        payload,
      })).statusCode,
    ).toBe(401);
    const response = await app.inject({ method: "POST", url, headers, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      expiresAt: "2026-07-24T00:05:00.000Z",
    });
    expect(response.json().challenge).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    const created = response.json() as {
      pairingId: string;
      challenge: string;
    };
    const submittedKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
    pairing.submitPairing({
      pairingId: created.pairingId,
      challenge: created.challenge,
      deviceName: "Submitted Pocket",
      publicJwk: submittedKey.publicKey.export({ format: "jwk" }),
      proof: sign(
        "sha256",
        Buffer.from(`hunter-pairing-v1\n${created.pairingId}\n${created.challenge}`),
        { key: submittedKey.privateKey, dsaEncoding: "ieee-p1363" },
      ).toString("base64url"),
    });
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/devices/pairings/${created.pairingId}/confirm`,
      headers,
      payload: {
        scopes: ["runs:read", "runs:control"],
        projectIds: [projectId],
        deviceExpiresAt: "2026-08-20T00:00:00.000Z",
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      device: { displayName: "Submitted Pocket", projectIds: [projectId] },
    });
    expect(confirmed.json()).not.toHaveProperty("credentials");

    const crossProjectPairing = pairing.createChallenge({
      kind: "authenticated_desktop",
      principalId: "desktop-owner",
    });
    const crossProjectKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const crossProjectDevice = pairing.confirmPairing({
      desktopPrincipal: {
        kind: "authenticated_desktop",
        principalId: "desktop-owner",
      },
      pairingId: crossProjectPairing.pairingId,
      challenge: crossProjectPairing.challenge,
      publicJwk: crossProjectKey.publicKey.export({ format: "jwk" }),
      proof: sign(
        "sha256",
        Buffer.from(
          `hunter-pairing-v1\n${crossProjectPairing.pairingId}\n${crossProjectPairing.challenge}`,
        ),
        { key: crossProjectKey.privateKey, dsaEncoding: "ieee-p1363" },
      ).toString("base64url"),
      deviceName: "Cross Project Pocket",
      scopes: ["runs:read"],
      projectIds: [projectId, otherProjectId],
      deviceExpiresAt: "2026-08-20T00:00:00.000Z",
    });
    expect(
      (await app.inject({
        method: "POST",
        url: `/api/v1/devices/${crossProjectDevice.deviceId}/revoke`,
        headers,
        payload: {},
      })).statusCode,
    ).toBe(403);
    await app.close();
  });
});
