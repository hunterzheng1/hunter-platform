import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DeviceGateway,
  DeviceStore,
  PairingService,
  TokenService,
} from "@hunter/device-gateway";
import type { ExternalOperationHandler } from "@hunter/runtime-contracts";

import { assertLoopbackListenOptions, buildApp } from "./app.js";
import { buildRemoteDeviceApp } from "./auth/remote-device-auth.js";
import {
  startRemoteTlsListener,
  type RemoteTlsListenerResult,
} from "./auth/remote-tls-listener.js";
import { createMobileProjectionProvider } from "./routes/mobile-projections.js";
import {
  createApplicationComposition,
  type ApplicationCompositionInput,
} from "./services/composition-root.js";
import type { CompletionVerifierPort } from "./services/application-services.js";
import type { SqliteServiceRepositories } from "./services/sqlite-application-services.js";

export type RemoteDaemonOptions =
  | { readonly enabled?: false }
  | {
      readonly enabled: true;
      readonly host: string;
      readonly port: number;
      readonly issuer: string;
      readonly allowedHosts: readonly string[];
      readonly allowedOrigins: readonly string[];
      readonly signingSecretRef: string;
      readonly tlsKeyRef: string;
      readonly tlsCertRef: string;
    };

export interface DaemonStartOptions {
  readonly dataDirectory: string;
  readonly secretRef: string;
  readonly secretStore: { resolveSecret(secretRef: string): Promise<string> };
  readonly repositories?: SqliteServiceRepositories | undefined;
  readonly externalHandler: ExternalOperationHandler;
  readonly verifier: CompletionVerifierPort;
  readonly allowedHost: string;
  readonly allowedOrigin: string;
  readonly publishPort: (port: number) => Promise<void>;
  readonly remote?: RemoteDaemonOptions | undefined;
  readonly archive?: ApplicationCompositionInput["archive"] | undefined;
}

function assertSecretRef(reference: string): void {
  if (!/^os-credential:\/\/[A-Za-z0-9._/-]+$/u.test(reference)) {
    throw new Error("SECRET_REF_SCHEME_INVALID");
  }
}

export async function startDaemon(options: DaemonStartOptions) {
  assertSecretRef(options.secretRef);
  if (options.remote?.enabled === true) {
    assertSecretRef(options.remote.signingSecretRef);
    assertSecretRef(options.remote.tlsKeyRef);
    assertSecretRef(options.remote.tlsCertRef);
  }
  mkdirSync(options.dataDirectory, { recursive: true });
  const installSecret = await options.secretStore.resolveSecret(options.secretRef);
  const database = new DatabaseSync(join(options.dataDirectory, "hunter.sqlite"));
  let app: ReturnType<typeof buildApp> | undefined;
  let workerTimer: ReturnType<typeof setInterval> | undefined;
  let workerDrain: Promise<void> = Promise.resolve();
  let remote: RemoteTlsListenerResult = { status: "disabled" };
  try {
    const composition = createApplicationComposition({
      database,
      repositories: options.repositories,
      externalHandler: options.externalHandler,
      verifier: options.verifier,
      installSecret,
      allowedHosts: [options.allowedHost],
      allowedOrigins: [options.allowedOrigin],
      contentDirectory: options.dataDirectory,
      ...(options.archive === undefined ? {} : { archive: options.archive }),
    });
    const { services } = composition;
    const remoteEnabled = options.remote?.enabled === true;
    const deviceStore = remoteEnabled ? new DeviceStore(database) : undefined;
    const pairing = deviceStore === undefined
      ? undefined
      : new PairingService({ store: deviceStore });
    const tokens = deviceStore === undefined || options.remote?.enabled !== true
      ? undefined
      : await TokenService.create({
          store: deviceStore,
          issuer: options.remote.issuer,
          audience: "hunter-mobile",
          signingSecretRef: options.remote.signingSecretRef,
          secretStore: options.secretStore,
        });
    const gateway = deviceStore === undefined
      ? undefined
      : new DeviceGateway({
          journal: services.journal,
          commands: services.flowEngine,
        });
    const projections = createMobileProjectionProvider({
      flowStore: services.flowStore,
      repositories: services.repositories,
    });
    database.prepare(
      `INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
       VALUES ('local_secret_ref', ?, ?)
       ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value, updated_at = excluded.updated_at`,
    ).run(options.secretRef, new Date().toISOString());
    await services.recovery.run();
    await services.operationWorker.runOnce();
    let workerFailure: unknown;
    const superviseWorker = () => {
      workerDrain = workerDrain.then(async () => {
        if (workerFailure !== undefined) return;
        try {
          await services.operationWorker.runOnce();
        } catch (error) {
          workerFailure = error;
        }
      });
    };
    workerTimer = setInterval(superviseWorker, 100);
    workerTimer.unref();
    app = buildApp({
      authenticator: services.authenticator,
      allowedHosts: services.allowedHosts,
      allowedOrigins: services.allowedOrigins,
      eventStream: services.eventStream,
      devices: pairing === undefined || tokens === undefined || deviceStore === undefined
        ? undefined
        : { pairing, store: deviceStore },
      services: {
        listProjects: async (authorizedProjectIds) => {
          return authorizedProjectIds.flatMap((projectId) => {
            const project = services.repositories.getProject(projectId);
            return project === null ? [] : [{ projectId: project.projectId, name: project.name }];
          });
        },
        projectForExecutionPlan: (executionPlanId) => {
          const plan = services.repositories.getExecutionPlan(executionPlanId);
          return plan === null ? null : { projectId: plan.projectId, executionPlanId: plan.executionPlanId };
        },
        projectForRun: (runId) => {
          const run = services.flowStore.loadRun(runId);
          return run === null
            ? null
            : { projectId: run.binding.projectId, runId: run.binding.runId };
        },
        startRun: async (command, actor) => composition.startRun.execute(command, actor),
        ...(composition.knowledge === undefined
          ? {}
          : {
              knowledge: {
                resolve: async (input) => await composition.knowledge!.resolve(input),
              },
            }),
      },
    });
    const listenOptions = { host: "127.0.0.1", port: 0 } as const;
    assertLoopbackListenOptions(listenOptions);
    await app.listen(listenOptions);
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("DAEMON_LISTEN_ADDRESS_INVALID");
    const remoteOptions = options.remote;
    if (
      remoteOptions?.enabled === true
      && tokens !== undefined
      && pairing !== undefined
      && gateway !== undefined
    ) {
      const tlsKey = await options.secretStore.resolveSecret(remoteOptions.tlsKeyRef);
      const tlsCert = await options.secretStore.resolveSecret(remoteOptions.tlsCertRef);
      remote = await startRemoteTlsListener({
        enabled: true,
        host: remoteOptions.host,
        port: remoteOptions.port,
        key: tlsKey,
        cert: tlsCert,
        buildApp: (https) =>
          buildRemoteDeviceApp({
            tokens,
            pairing,
            gateway,
            eventStream: services.eventStream,
            projections,
            allowedHosts: remoteOptions.allowedHosts,
            allowedOrigins: remoteOptions.allowedOrigins,
            https,
          }),
      });
    } else {
      remote = await startRemoteTlsListener({ enabled: false });
    }
    await options.publishPort(address.port);
    const runningApp = app;
    let closed = false;
    return {
      port: address.port,
      remote,
      services,
      shutdown: async () => {
        if (closed) return;
        closed = true;
        if (remote.status === "listening") await remote.close();
        await runningApp.close();
        if (workerTimer !== undefined) clearInterval(workerTimer);
        await workerDrain;
        services.projectionRunner.runIncremental();
        database.close();
      },
    };
  } catch (error) {
    if (workerTimer !== undefined) clearInterval(workerTimer);
    if (app !== undefined) await app.close().catch(() => undefined);
    if (remote.status === "listening") await remote.close().catch(() => undefined);
    await workerDrain.catch(() => undefined);
    database.close();
    throw error;
  }
}
