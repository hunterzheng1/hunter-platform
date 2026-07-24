import {
  CapabilityProbeReceiptIdSchema,
} from "@hunter/domain";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const CodeBuddyTransportKindSchema = z.enum([
  "acp_stdio",
  "acp_http",
  "headless_stdio",
]);
export type CodeBuddyTransportKind = z.infer<
  typeof CodeBuddyTransportKindSchema
>;

function containsControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 31 || code === 127);
  });
}

export const CodeBuddyTransportEndpointSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => !containsControl(value));

export const VerifiedCodeBuddyTransportSelectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  transportKind: CodeBuddyTransportKindSchema,
  endpoint: CodeBuddyTransportEndpointSchema,
  protocolKind: z.string().min(1).max(128),
  protocolVersion: z.string().min(1).max(128),
  supportedProtocolVersions: z.array(z.string().min(1).max(128)).min(1).max(32),
  protocolSchemaVersion: z.number().int().nonnegative(),
  supportedProtocolSchemaVersions: z.array(z.number().int().nonnegative()).min(1).max(32),
  protocolSchemaDigest: DigestSchema,
  sourceEvidenceDigest: DigestSchema,
  probeReceiptId: CapabilityProbeReceiptIdSchema,
  selectionDigest: DigestSchema,
  receiptDigest: DigestSchema,
});
export type VerifiedCodeBuddyTransportSelection = z.infer<
  typeof VerifiedCodeBuddyTransportSelectionSchema
>;
