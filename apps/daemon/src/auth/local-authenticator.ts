import { createHmac, timingSafeEqual } from "node:crypto";

import { ProjectIdSchema, type ProjectId } from "@hunter/domain";
import { z } from "zod";

const PayloadSchema = z.strictObject({
  principalId: z.string().trim().min(1),
  authorizedProjectIds: z.array(ProjectIdSchema),
  expiresAt: z.string().datetime({ offset: true }),
  csrf: z.string().min(8),
});

export interface LocalPrincipal {
  readonly principalId: string;
  readonly authorizedProjectIds: readonly ProjectId[];
  readonly expiresAt: string;
  readonly csrf: string;
}

export class LocalAuthenticator {
  public constructor(private readonly installSecret: string) {
    if (installSecret.length < 16) throw new Error("LOCAL_INSTALL_SECRET_TOO_SHORT");
  }

  public issueSession(input: { readonly principalId: string; readonly authorizedProjectIds: readonly ProjectId[]; readonly expiresAt: Date; readonly csrf: string }): string {
    const payload = PayloadSchema.parse({ ...input, expiresAt: input.expiresAt.toISOString() });
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${this.sign(encoded)}`;
  }

  public authenticate(token: string, now = new Date()): LocalPrincipal {
    const [encoded, signature, extra] = token.split(".");
    if (encoded === undefined || signature === undefined || extra !== undefined) throw new Error("LOCAL_CREDENTIAL_INVALID");
    const expected = Buffer.from(this.sign(encoded));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error("LOCAL_CREDENTIAL_INVALID");
    const principal = PayloadSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    if (Date.parse(principal.expiresAt) <= now.getTime()) throw new Error("LOCAL_CREDENTIAL_EXPIRED");
    return principal;
  }

  private sign(value: string): string {
    return createHmac("sha256", this.installSecret).update(value).digest("base64url");
  }
}
