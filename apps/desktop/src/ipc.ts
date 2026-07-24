import {
  ApproveRequirementHttpRequestSchema,
  CreateProjectHttpRequestSchema,
  CreateProjectHttpResponseSchema,
  CreateRequirementHttpRequestSchema,
  KnowledgeHttpResponseSchema,
  ProjectDetailHttpResponseSchema,
  ProjectListHttpResponseSchema,
  PublishChangeHttpRequestSchema,
  PublishChangeHttpResponseSchema,
  RequirementRevisionHttpResponseSchema,
  RunViewHttpResponseSchema,
} from "@hunter/api-contracts";
import {
  DeviceIdSchema,
  ProjectIdSchema,
  RequirementRevisionIdSchema,
  RunIdSchema,
} from "@hunter/domain/ids";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";

export const DESKTOP_IPC_CHANNELS = Object.freeze([
  "projects.list",
  "projects.create",
  "projects.get",
  "requirements.create",
  "requirements.approve",
  "changes.publish",
  "runs.get",
  "runs.command",
  "knowledge.list",
  "devices.pairing.create",
  "devices.pairing.confirm",
  "devices.revoke",
  "events.subscribe",
] as const);
export type DesktopIpcChannel = typeof DESKTOP_IPC_CHANNELS[number];

const EmptySchema = z.strictObject({});
const RunCommandSchema = z.strictObject({
  runId: RunIdSchema,
  action: z.enum(["pause", "resume", "terminate", "supplement"]),
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(128),
});
const RunCommandResponseSchema = z.strictObject({
  runId: RunIdSchema,
  status: z.string().min(1).max(64),
  aggregateVersion: z.number().int().nonnegative(),
});
const PairingIdSchema = z.string().regex(/^pair_[a-f0-9]{24}$/u);
const PairingChallengeResponseSchema = z.strictObject({
  pairingId: PairingIdSchema,
  challenge: z.string().regex(/^[A-Za-z0-9_-]{40,100}$/u),
  expiresAt: z.string().datetime({ offset: true }),
});
const MobileScopeSetSchema = z.array(z.enum([
  "runs:read",
  "artifacts:read",
  "gates:approve",
  "runs:control",
])).min(1).max(4).superRefine((scopes, context) => {
  if (new Set(scopes).size !== scopes.length) {
    context.addIssue({ code: "custom", message: "mobile scopes must be unique" });
  }
});
const PairingConfirmationRequestSchema = z.strictObject({
  pairingId: PairingIdSchema,
  scopes: MobileScopeSetSchema,
  projectIds: z.array(ProjectIdSchema).min(1).max(100),
  deviceExpiresAt: z.string().datetime({ offset: true }),
});
const StoredDeviceSchema = z.strictObject({
  deviceId: DeviceIdSchema,
  displayName: z.string().trim().min(1).max(120),
  publicJwk: z.record(z.string(), z.unknown()),
  publicKeyThumbprint: z.string().min(32).max(100),
  scopes: MobileScopeSetSchema,
  projectIds: z.array(ProjectIdSchema).min(1).max(100),
  version: z.number().int().positive(),
  expiresAt: z.string().datetime({ offset: true }),
  revokedAt: z.string().datetime({ offset: true }).nullable(),
});
const PairingConfirmationResponseSchema = z.strictObject({
  device: StoredDeviceSchema,
});
const DeviceRevokeRequestSchema = z.strictObject({ deviceId: DeviceIdSchema });
const DeviceRevokeResponseSchema = z.strictObject({ status: z.literal("revoked") });
const EventSubscriptionResponseSchema = z.strictObject({
  subscriptionId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  cursor: z.number().int().nonnegative(),
});
const EventEnvelopeSchema = z.strictObject({
  position: z.number().int().positive(),
  eventType: z.string().min(1).max(128),
});
const EventGapSchema = z.strictObject({
  status: z.literal("resync_required"),
  code: z.literal("EVENT_CURSOR_GAP"),
  retentionFloor: z.number().int().nonnegative(),
  highWaterPosition: z.number().int().nonnegative(),
  instructions: z.strictObject({
    snapshot: z.literal("reload_snapshot"),
    rebuild: z.literal("replace_projection_from_snapshot"),
    resume: z.literal("subscribe_after_high_water_position"),
  }),
});
const EventStreamStatusSchema = z.strictObject({
  status: z.literal("terminated"),
  code: z.enum([
    "EVENT_STREAM_ENDED",
    "EVENT_STREAM_FAILED",
    "EVENT_STREAM_TERMINATED",
  ]),
});
const DesktopEventSchema = z.union([
  EventEnvelopeSchema,
  EventGapSchema,
  EventStreamStatusSchema,
]);
const EventUnsubscribeRequestSchema = z.strictObject({
  subscriptionId: EventSubscriptionResponseSchema.shape.subscriptionId,
});
const EventUnsubscribeResponseSchema = z.strictObject({
  status: z.literal("unsubscribed"),
});

const requestSchemas = {
  "projects.list": EmptySchema,
  "projects.create": z.strictObject({
    command: CreateProjectHttpRequestSchema,
  }),
  "projects.get": z.strictObject({ projectId: ProjectIdSchema }),
  "requirements.create": z.strictObject({
    projectId: ProjectIdSchema,
    command: CreateRequirementHttpRequestSchema,
  }),
  "requirements.approve": z.strictObject({
    projectId: ProjectIdSchema,
    revisionId: RequirementRevisionIdSchema,
    command: ApproveRequirementHttpRequestSchema,
  }),
  "changes.publish": z.strictObject({
    projectId: ProjectIdSchema,
    command: PublishChangeHttpRequestSchema,
  }),
  "runs.get": z.strictObject({ runId: RunIdSchema }),
  "runs.command": RunCommandSchema,
  "knowledge.list": z.strictObject({
    projectId: ProjectIdSchema,
    includeHistorical: z.boolean(),
  }),
  "devices.pairing.create": EmptySchema,
  "devices.pairing.confirm": PairingConfirmationRequestSchema,
  "devices.revoke": DeviceRevokeRequestSchema,
  "events.subscribe": z.strictObject({ cursor: z.number().int().nonnegative() }),
} as const;

const responseSchemas = {
  "projects.list": ProjectListHttpResponseSchema,
  "projects.create": CreateProjectHttpResponseSchema,
  "projects.get": ProjectDetailHttpResponseSchema,
  "requirements.create": RequirementRevisionHttpResponseSchema,
  "requirements.approve": RequirementRevisionHttpResponseSchema,
  "changes.publish": PublishChangeHttpResponseSchema,
  "runs.get": RunViewHttpResponseSchema,
  "runs.command": RunCommandResponseSchema,
  "knowledge.list": KnowledgeHttpResponseSchema,
  "devices.pairing.create": PairingChallengeResponseSchema,
  "devices.pairing.confirm": PairingConfirmationResponseSchema,
  "devices.revoke": DeviceRevokeResponseSchema,
  "events.subscribe": EventSubscriptionResponseSchema,
} as const;

export type DesktopInvoke = (
  channel: DesktopIpcChannel,
  request: unknown,
) => Promise<unknown>;
export type DesktopEventSubscriber = (
  request: unknown,
  listener: (event: unknown) => void,
  signal: AbortSignal,
) => Promise<void>;
export type DesktopSubscribe = (
  request: unknown,
  listener: (event: unknown) => void,
) => () => void;

export interface DesktopIpcSender {
  send(channel: "hunter:events.event", value: unknown): void;
  once?(event: "destroyed", listener: () => void): void;
}

export interface DesktopIpcRegistrar {
  handle(
    channel: string,
    listener: (
      event: { readonly sender?: DesktopIpcSender | undefined },
      request: unknown,
    ) => Promise<unknown>,
  ): void;
}

export function installDesktopIpcHandlers(
  registrar: DesktopIpcRegistrar,
  invoke: DesktopInvoke,
  subscribeEvents?: DesktopEventSubscriber,
): void {
  type Subscription = {
    readonly controller: AbortController;
    readonly subscriptionId: string;
    closedByRenderer: boolean;
    superseded: boolean;
  };
  const subscriptions = new WeakMap<DesktopIpcSender, Subscription>();
  const sendStatus = (
    sender: DesktopIpcSender,
    code: z.infer<typeof EventStreamStatusSchema>["code"],
  ) => {
    try {
      sender.send("hunter:events.event", { status: "terminated", code });
    } catch {
      // A destroyed renderer has no remaining observer for stream status.
    }
  };
  for (const channel of DESKTOP_IPC_CHANNELS) {
    registrar.handle(`hunter:${channel}`, async (event, request) => {
      if (channel !== "events.subscribe") {
        return invokeValidated(invoke, channel, request);
      }
      if (subscribeEvents === undefined || event.sender === undefined) {
        throw new Error("EVENT_SUBSCRIPTION_UNAVAILABLE");
      }
      const parsed = requestSchemas[channel].parse(request);
      const previous = subscriptions.get(event.sender);
      const controller = new AbortController();
      const subscriptionId = randomBytes(18).toString("base64url");
      const sender = event.sender;
      const subscription: Subscription = {
        controller,
        subscriptionId,
        closedByRenderer: false,
        superseded: false,
      };
      subscriptions.set(sender, subscription);
      if (previous !== undefined) {
        previous.superseded = true;
        previous.controller.abort();
      }
      sender.once?.("destroyed", () => {
        subscription.closedByRenderer = true;
        controller.abort();
      });
      void subscribeEvents(
        parsed,
        (value) => {
          if (subscriptions.get(sender) !== subscription) return;
          sender.send(
            "hunter:events.event",
            DesktopEventSchema.parse(value),
          );
        },
        controller.signal,
      ).then(() => {
        if (subscription.superseded) return;
        sendStatus(
          sender,
          subscription.closedByRenderer
            ? "EVENT_STREAM_TERMINATED"
            : "EVENT_STREAM_ENDED",
        );
      }).catch(() => {
        if (subscription.superseded) return;
        sendStatus(
          sender,
          subscription.closedByRenderer
            ? "EVENT_STREAM_TERMINATED"
            : "EVENT_STREAM_FAILED",
        );
      }).finally(() => {
        if (subscriptions.get(sender) === subscription) {
          subscriptions.delete(sender);
        }
      });
      return responseSchemas[channel].parse({
        subscriptionId,
        cursor: parsed.cursor,
      });
    });
  }
  registrar.handle("hunter:events.unsubscribe", async (event, request) => {
    if (event.sender === undefined) {
      throw new Error("EVENT_SUBSCRIPTION_UNAVAILABLE");
    }
    const parsed = EventUnsubscribeRequestSchema.parse(request);
    const subscription = subscriptions.get(event.sender);
    if (
      subscription === undefined
      || subscription.subscriptionId !== parsed.subscriptionId
    ) {
      throw new Error("EVENT_SUBSCRIPTION_NOT_FOUND");
    }
    subscription.closedByRenderer = true;
    subscription.controller.abort();
    subscriptions.delete(event.sender);
    return EventUnsubscribeResponseSchema.parse({ status: "unsubscribed" });
  });
}

function daemonRoute(
  channel: DesktopIpcChannel,
  request: Record<string, unknown>,
): { readonly method: "GET" | "POST"; readonly path: string; readonly body?: unknown } {
  switch (channel) {
    case "projects.list": return { method: "GET", path: "/api/v1/projects" };
    case "projects.create": return { method: "POST", path: "/api/v1/projects", body: request.command };
    case "projects.get": return { method: "GET", path: `/api/v1/projects/${String(request.projectId)}` };
    case "requirements.create": return { method: "POST", path: `/api/v1/projects/${String(request.projectId)}/requirements`, body: request.command };
    case "requirements.approve": return { method: "POST", path: `/api/v1/projects/${String(request.projectId)}/requirement-revisions/${String(request.revisionId)}/approve`, body: request.command };
    case "changes.publish": return { method: "POST", path: `/api/v1/projects/${String(request.projectId)}/changes`, body: request.command };
    case "runs.get": return { method: "GET", path: `/api/v1/runs/${String(request.runId)}` };
    case "runs.command": return { method: "POST", path: `/api/v1/runs/${String(request.runId)}/commands`, body: request };
    case "knowledge.list": return {
      method: "GET",
      path: `/api/v1/projects/${String(request.projectId)}/knowledge?includeHistorical=${String(request.includeHistorical)}`,
    };
    case "devices.pairing.create": return { method: "POST", path: "/api/v1/devices/pairing-challenges", body: {} };
    case "devices.pairing.confirm": {
      const { pairingId, ...body } = request;
      return { method: "POST", path: `/api/v1/devices/pairings/${String(pairingId)}/confirm`, body };
    }
    case "devices.revoke": return { method: "POST", path: `/api/v1/devices/${String(request.deviceId)}/revoke`, body: {} };
    case "events.subscribe": return { method: "GET", path: "/events" };
  }
}

export class DesktopDaemonClient {
  constructor(
    private readonly port: number,
    private readonly capability: string,
    private readonly origin = "app://hunter",
    private readonly requestImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("DAEMON_PORT_INVALID");
    }
    if (!/^[A-Za-z0-9_-]{43}$/u.test(capability)) {
      throw new Error("DAEMON_CAPABILITY_INVALID");
    }
  }

  async request(channel: DesktopIpcChannel, requestInput: unknown): Promise<unknown> {
    if (channel === "events.subscribe") {
      throw new Error("EVENT_SUBSCRIPTION_REQUIRES_STREAM");
    }
    const request = requestSchemas[channel].parse(requestInput) as Record<string, unknown>;
    const route = daemonRoute(channel, request);
    const response = await this.signedFetch(route);
    const text = await readBoundedResponseBody(response, 1024 * 1024);
    if (!response.ok) throw new Error(`DAEMON_REQUEST_FAILED_${response.status}`);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("DAEMON_RESPONSE_INVALID");
    }
    return responseSchemas[channel].parse(value);
  }

  async subscribeEvents(
    requestInput: unknown,
    listener: (event: unknown) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const request = requestSchemas["events.subscribe"].parse(requestInput);
    const route = daemonRoute("events.subscribe", request);
    const response = await this.signedFetch(route, signal, {
      "last-event-id": String(request.cursor),
    });
    if (response.status === 409) {
      const text = await readBoundedResponseBody(response, 64 * 1024);
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error("DAEMON_EVENT_GAP_INVALID");
      }
      listener(EventGapSchema.parse(value));
      return;
    }
    if (!response.ok) {
      await readBoundedResponseBody(response, 64 * 1024);
      throw new Error(`DAEMON_EVENT_STREAM_FAILED_${response.status}`);
    }
    if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
      throw new Error("DAEMON_EVENT_STREAM_CONTENT_TYPE_INVALID");
    }
    if (response.body === null) throw new Error("DAEMON_EVENT_STREAM_MISSING");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      if (Buffer.byteLength(buffered, "utf8") > 256 * 1024) {
        await reader.cancel();
        throw new Error("DAEMON_EVENT_FRAME_TOO_LARGE");
      }
      let boundary = buffered.search(/\r?\n\r?\n/u);
      while (boundary >= 0) {
        const frame = buffered.slice(0, boundary);
        const delimiter = buffered.slice(boundary).match(/^\r?\n\r?\n/u)?.[0] ?? "\n\n";
        buffered = buffered.slice(boundary + delimiter.length);
        const event = parseServerSentEvent(frame);
        if (event !== undefined) listener(event);
        boundary = buffered.search(/\r?\n\r?\n/u);
      }
    }
  }

  private async signedFetch(
    route: {
      readonly method: "GET" | "POST";
      readonly path: string;
      readonly body?: unknown;
    },
    signal?: AbortSignal,
    additionalHeaders: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    const host = `127.0.0.1:${this.port}`;
    const encodedBody = route.body === undefined ? "" : JSON.stringify(route.body);
    const timestamp = this.now();
    const nonce = randomBytes(18).toString("base64url");
    const bodyDigest = createHash("sha256").update(encodedBody).digest("hex");
    const canonical = [
      route.method,
      route.path,
      host,
      this.origin,
      String(timestamp),
      nonce,
      additionalHeaders["last-event-id"] ?? "",
      bodyDigest,
    ].join("\n");
    const signature = createHmac(
      "sha256",
      Buffer.from(this.capability, "base64url"),
    ).update(canonical).digest("base64url");
    return this.requestImpl(`http://${host}${route.path}`, {
      method: route.method,
      headers: {
        host,
        origin: this.origin,
        ...(route.body === undefined ? {} : { "content-type": "application/json" }),
        "x-hunter-local-timestamp": String(timestamp),
        "x-hunter-local-nonce": nonce,
        "x-hunter-local-body-sha256": bodyDigest,
        "x-hunter-local-signature": signature,
        ...additionalHeaders,
      },
      ...(route.body === undefined ? {} : { body: encodedBody }),
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

async function readBoundedResponseBody(
  response: Response,
  limit: number,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let value = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return value + decoder.decode();
    total += chunk.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("DAEMON_RESPONSE_TOO_LARGE");
    }
    value += decoder.decode(chunk.value, { stream: true });
  }
}

function parseServerSentEvent(frame: string): z.infer<typeof EventEnvelopeSchema> | undefined {
  const lines = frame.split(/\r?\n/u);
  if (lines.every((line) => line === "" || line.startsWith(":"))) return undefined;
  const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trim();
  const eventType = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (id === undefined || eventType === undefined || dataLines.length === 0) {
    throw new Error("DAEMON_EVENT_FRAME_INVALID");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(dataLines.join("\n"));
  } catch {
    throw new Error("DAEMON_EVENT_FRAME_INVALID");
  }
  if (raw === null || typeof raw !== "object") {
    throw new Error("DAEMON_EVENT_FRAME_INVALID");
  }
  const position = "position" in raw ? raw.position : undefined;
  const envelope = EventEnvelopeSchema.parse({ position, eventType });
  if (String(envelope.position) !== id) {
    throw new Error("DAEMON_EVENT_POSITION_MISMATCH");
  }
  return envelope;
}

async function invokeValidated(
  invoke: DesktopInvoke,
  channel: DesktopIpcChannel,
  request: unknown,
): Promise<unknown> {
  const parsedRequest = requestSchemas[channel].parse(request);
  const response = await invoke(channel, parsedRequest);
  return responseSchemas[channel].parse(response);
}

export function createDesktopPreloadApi(
  invoke: DesktopInvoke,
  subscribe: DesktopSubscribe,
) {
  const api = {
    projects: Object.freeze({
      list: (request: unknown) => invokeValidated(invoke, "projects.list", request),
      create: (request: unknown) => invokeValidated(invoke, "projects.create", request),
      get: (request: unknown) => invokeValidated(invoke, "projects.get", request),
    }),
    requirements: Object.freeze({
      create: (request: unknown) => invokeValidated(invoke, "requirements.create", request),
      approve: (request: unknown) => invokeValidated(invoke, "requirements.approve", request),
    }),
    changes: Object.freeze({
      publish: (request: unknown) => invokeValidated(invoke, "changes.publish", request),
    }),
    runs: Object.freeze({
      get: (request: unknown) => invokeValidated(invoke, "runs.get", request),
      command: (request: unknown) => invokeValidated(invoke, "runs.command", request),
    }),
    knowledge: Object.freeze({
      list: (request: unknown) => invokeValidated(invoke, "knowledge.list", request),
    }),
    devices: Object.freeze({
      createPairingChallenge: (request: unknown) =>
        invokeValidated(invoke, "devices.pairing.create", request),
      confirmPairing: (request: unknown) =>
        invokeValidated(invoke, "devices.pairing.confirm", request),
      revoke: (request: unknown) =>
        invokeValidated(invoke, "devices.revoke", request),
    }),
    events: Object.freeze({
      subscribe: (request: unknown, listener: (event: unknown) => void) => {
        const parsed = requestSchemas["events.subscribe"].parse(request);
        return subscribe(parsed, (event) => listener(DesktopEventSchema.parse(event)));
      },
    }),
  };
  return Object.freeze(api);
}

type DesktopPreloadApi = ReturnType<typeof createDesktopPreloadApi>;

function parseDesktopCommandBody(init: RequestInit | undefined): unknown {
  if (
    init === undefined
    || init.method?.toUpperCase() !== "POST"
    || typeof init.body !== "string"
    || Object.keys(init).some((key) =>
      !["method", "headers", "body"].includes(key)
    )
  ) {
    throw new Error("DESKTOP_TRANSPORT_REQUEST_INVALID");
  }
  const headers = new Headers(init.headers);
  if (
    [...headers.keys()].some((key) => key !== "content-type")
    || headers.get("content-type") !== "application/json"
  ) {
    throw new Error("DESKTOP_TRANSPORT_HEADERS_INVALID");
  }
  try {
    return JSON.parse(init.body) as unknown;
  } catch {
    throw new Error("DESKTOP_TRANSPORT_BODY_INVALID");
  }
}

export function createDesktopAuthenticatedTransport(api: DesktopPreloadApi) {
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    if (init === undefined) {
      if (path === "/api/v1/projects") return await api.projects.list({});
      const project = /^\/api\/v1\/projects\/(prj_[A-Za-z0-9_-]+)$/u.exec(path);
      if (project !== null) {
        return await api.projects.get({ projectId: project[1] });
      }
      const run = /^\/api\/v1\/runs\/(run_[A-Za-z0-9_-]+)$/u.exec(path);
      if (run !== null) return await api.runs.get({ runId: run[1] });
      const knowledge = /^\/api\/v1\/projects\/(prj_[A-Za-z0-9_-]+)\/knowledge\?includeHistorical=(true|false)$/u.exec(path);
      if (knowledge !== null) {
        return await api.knowledge.list({
          projectId: knowledge[1],
          includeHistorical: knowledge[2] === "true",
        });
      }
      throw new Error("DESKTOP_TRANSPORT_ROUTE_NOT_ALLOWED");
    }
    const command = parseDesktopCommandBody(init);
    if (path === "/api/v1/projects") {
      return await api.projects.create({ command });
    }
    const requirement = /^\/api\/v1\/projects\/(prj_[A-Za-z0-9_-]+)\/requirements$/u.exec(path);
    if (requirement !== null) {
      return await api.requirements.create({
        projectId: requirement[1],
        command,
      });
    }
    const approval = /^\/api\/v1\/projects\/(prj_[A-Za-z0-9_-]+)\/requirement-revisions\/(rrv_[A-Za-z0-9_-]+)\/approve$/u.exec(path);
    if (approval !== null) {
      return await api.requirements.approve({
        projectId: approval[1],
        revisionId: approval[2],
        command,
      });
    }
    const change = /^\/api\/v1\/projects\/(prj_[A-Za-z0-9_-]+)\/changes$/u.exec(path);
    if (change !== null) {
      return await api.changes.publish({
        projectId: change[1],
        command,
      });
    }
    throw new Error("DESKTOP_TRANSPORT_ROUTE_NOT_ALLOWED");
  };
  return Object.freeze({ request });
}
