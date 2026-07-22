import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ExternalOperationHandler } from "@hunter/runtime-contracts";

import { assertLoopbackListenOptions, buildApp } from "./app.js";
import { createSqliteApplicationServices, type SqliteServiceRepositories } from "./services/sqlite-application-services.js";

export interface DaemonStartOptions {
  readonly dataDirectory: string;
  readonly installSecret: string;
  readonly repositories: SqliteServiceRepositories;
  readonly externalHandler: ExternalOperationHandler;
  readonly allowedHost: string;
  readonly allowedOrigin: string;
  readonly publishPort: (port: number) => Promise<void>;
}

export async function startDaemon(options: DaemonStartOptions) {
  mkdirSync(options.dataDirectory, { recursive: true });
  const database = new DatabaseSync(join(options.dataDirectory, "hunter.sqlite"));
  const services = createSqliteApplicationServices({
    database,
    repositories: options.repositories,
    externalHandler: options.externalHandler,
    installSecret: options.installSecret,
    allowedHosts: [options.allowedHost],
    allowedOrigins: [options.allowedOrigin],
  });
  try {
    await services.recovery.run();
    await services.operationWorker.runOnce();
    const app = buildApp({
      authenticator: services.authenticator,
      allowedHosts: services.allowedHosts,
      allowedOrigins: services.allowedOrigins,
      eventStream: services.eventStream,
      services: {
        projectForExecutionPlan: (executionPlanId) => {
          const plan = options.repositories.getExecutionPlan(executionPlanId);
          return plan === null ? null : { projectId: plan.projectId, executionPlanId: plan.executionPlanId };
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
    return {
      port: address.port,
      services,
      shutdown: async () => {
        await app.close();
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
