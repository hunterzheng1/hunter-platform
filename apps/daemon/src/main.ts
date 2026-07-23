import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ExternalOperationHandler } from "@hunter/runtime-contracts";

import { assertLoopbackListenOptions, buildApp } from "./app.js";
import { createSqliteApplicationServices, type SqliteServiceRepositories } from "./services/sqlite-application-services.js";

export interface DaemonStartOptions {
  readonly dataDirectory: string;
  readonly secretRef: string;
  readonly secretStore: { resolveSecret(secretRef: string): Promise<string> };
  readonly repositories?: SqliteServiceRepositories | undefined;
  readonly externalHandler: ExternalOperationHandler;
  readonly allowedHost: string;
  readonly allowedOrigin: string;
  readonly publishPort: (port: number) => Promise<void>;
}

export async function startDaemon(options: DaemonStartOptions) {
  if (!/^os-credential:\/\/[A-Za-z0-9._/-]+$/u.test(options.secretRef)) throw new Error("SECRET_REF_SCHEME_INVALID");
  mkdirSync(options.dataDirectory, { recursive: true });
  const installSecret = await options.secretStore.resolveSecret(options.secretRef);
  const database = new DatabaseSync(join(options.dataDirectory, "hunter.sqlite"));
  let app: ReturnType<typeof buildApp> | undefined;
  let workerTimer: ReturnType<typeof setInterval> | undefined;
  let workerDrain: Promise<void> = Promise.resolve();
  try {
    const services = createSqliteApplicationServices({
      database,
      repositories: options.repositories,
      externalHandler: options.externalHandler,
      installSecret,
      allowedHosts: [options.allowedHost],
      allowedOrigins: [options.allowedOrigin],
      contentDirectory: options.dataDirectory,
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
        startRun: async (command, actor) => services.startRun.execute(command, actor),
      },
    });
    const listenOptions = { host: "127.0.0.1", port: 0 } as const;
    assertLoopbackListenOptions(listenOptions);
    await app.listen(listenOptions);
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("DAEMON_LISTEN_ADDRESS_INVALID");
    await options.publishPort(address.port);
    const runningApp = app;
    let closed = false;
    return {
      port: address.port,
      services,
      shutdown: async () => {
        if (closed) return;
        closed = true;
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
    await workerDrain.catch(() => undefined);
    database.close();
    throw error;
  }
}
