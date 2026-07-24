import {
  MobileCommandEnvelopeSchema,
  type DeviceCommandPrincipal,
  type DeviceGateway,
} from "@hunter/device-gateway";
import type { FastifyInstance, FastifyRequest } from "fastify";

export type RemoteDeviceRequest = FastifyRequest & {
  hunterDevicePrincipal?: DeviceCommandPrincipal;
};

export function requireDevicePrincipal(request: FastifyRequest): DeviceCommandPrincipal {
  const principal = (request as RemoteDeviceRequest).hunterDevicePrincipal;
  if (principal === undefined) throw new Error("DEVICE_AUTH_CONTEXT_MISSING");
  return principal;
}

function statusForCommandError(error: unknown): number {
  if (!(error instanceof Error)) return 500;
  if (
    error.message.includes("EXPECTED_VERSION_CONFLICT")
    || error.message === "IDEMPOTENCY_KEY_REUSED"
    || error.message === "GATE_ALREADY_DECIDED"
  ) {
    return 409;
  }
  if (
    error.message.includes("FORBIDDEN")
    || error.message.includes("SCOPE_MISMATCH")
  ) {
    return 403;
  }
  return 400;
}

export function registerMobileCommandRoutes(
  app: FastifyInstance,
  gateway: DeviceGateway,
): void {
  app.post("/api/v1/mobile/commands", async (request, reply) => {
    const parsed = MobileCommandEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return await reply.code(400).send({ code: "COMMAND_SCHEMA_INVALID" });
    }
    try {
      return gateway.execute(parsed.data, requireDevicePrincipal(request));
    } catch (error) {
      return await reply.code(statusForCommandError(error)).send({
        code: error instanceof Error ? error.message.split(" ")[0] : "COMMAND_REJECTED",
      });
    }
  });
}
