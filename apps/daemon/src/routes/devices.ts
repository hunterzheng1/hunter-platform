import {
  DeviceIdSchema,
  ProjectIdSchema,
} from "@hunter/domain";
import {
  MobileScopeSetSchema,
  type DeviceStore,
  type PairingService,
} from "@hunter/device-gateway";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requirePrincipal } from "../http/security-hooks.js";

const ConfirmPairingBodySchema = z.strictObject({
  scopes: MobileScopeSetSchema,
  projectIds: z.array(ProjectIdSchema).min(1).max(100),
  deviceExpiresAt: z.string().datetime({ offset: true }),
});

export interface DeviceRoutesServices {
  readonly pairing: PairingService;
  readonly store: DeviceStore;
}

export function registerDeviceRoutes(
  app: FastifyInstance,
  services: DeviceRoutesServices,
): void {
  app.post("/api/v1/devices/pairing-challenges", async (request) => {
    const principal = requirePrincipal(request);
    return services.pairing.createChallenge({
      kind: "authenticated_desktop",
      principalId: principal.principalId,
    });
  });

  app.post("/api/v1/devices/pairings/:pairingId/confirm", async (request, reply) => {
    const principal = requirePrincipal(request);
    const pairingId = (request.params as { pairingId?: unknown }).pairingId;
    const parsed = ConfirmPairingBodySchema.safeParse(request.body);
    if (typeof pairingId !== "string" || !parsed.success) {
      return await reply.code(400).send({ code: "PAIRING_CONFIRMATION_INVALID" });
    }
    if (
      parsed.data.projectIds.some(
        (projectId) => !principal.authorizedProjectIds.includes(projectId),
      )
    ) {
      return await reply.code(403).send({ code: "PROJECT_FORBIDDEN" });
    }
    try {
      const device = services.pairing.confirmSubmittedPairing({
        desktopPrincipal: {
          kind: "authenticated_desktop",
          principalId: principal.principalId,
        },
        pairingId,
        ...parsed.data,
      });
      return { device };
    } catch (error) {
      return await reply.code(400).send({
        code: error instanceof Error ? error.message : "PAIRING_CONFIRMATION_REJECTED",
      });
    }
  });

  app.post("/api/v1/devices/:deviceId/revoke", async (request, reply) => {
    const principal = requirePrincipal(request);
    const parsed = DeviceIdSchema.safeParse(
      (request.params as { deviceId?: unknown }).deviceId,
    );
    if (!parsed.success) return await reply.code(400).send({ code: "DEVICE_ID_INVALID" });
    const device = services.store.getDevice(parsed.data);
    if (
      device === undefined
      || !device.projectIds.every((projectId) =>
        principal.authorizedProjectIds.includes(projectId))
    ) {
      return await reply.code(403).send({ code: "DEVICE_FORBIDDEN" });
    }
    services.store.revokeDevice(parsed.data, new Date().toISOString());
    return { status: "revoked" };
  });
}
