import {
  PLATFORM_INFORMATION_HTTP_OPERATIONS,
  normalizePlatformInformationListHttpQuery,
  platformInformationBranchFilesPageSchema,
  platformInformationConfirmRestoreHttpRequestSchema,
  platformInformationDetailResponseSchema,
  platformInformationPageSchema,
  platformInformationPreviewRestoreHttpRequestSchema,
  platformInformationRetryExtractionHttpRequestSchema,
  restoreBranchFilesConfirmedIntentSchema,
  restoreBranchFilesPreviewReceiptSchema,
  knowledgeExtractionRetryIntentSchema,
  validatePlatformInformationConfirmRestoreHttpRequest,
} from "@hunter-harness/contracts";

export type PlatformInformationOperationName = keyof typeof PLATFORM_INFORMATION_HTTP_OPERATIONS;

export function platformInformationErrorStatus(
  operationName: PlatformInformationOperationName,
  code: string,
): number | null {
  const errors = PLATFORM_INFORMATION_HTTP_OPERATIONS[operationName].errors as Readonly<Record<string, readonly string[]>>;
  const entry = Object.entries(errors).find(([, codes]) => codes.includes(code));
  return entry === undefined ? null : Number(entry[0]);
}

export function buildPlatformInformationPath(
  operationName: PlatformInformationOperationName,
  parameters: Readonly<Record<string, string>>,
): string {
  let path: string = PLATFORM_INFORMATION_HTTP_OPERATIONS[operationName].path;
  for (const [name, value] of Object.entries(parameters)) {
    path = path.replace("{" + name + "}", encodeURIComponent(value));
  }
  if (/\{[^}]+\}/u.test(path)) {
    throw new Error("platform information route parameters are incomplete");
  }
  return path;
}

export function buildPlatformInformationListQuery(input: unknown): URLSearchParams | null {
  const normalized = normalizePlatformInformationListHttpQuery(input);
  if (!normalized.ok) return null;
  const query = new URLSearchParams({ limit: String(normalized.value.limit) });
  if (normalized.value.cursor !== null) query.set("cursor", normalized.value.cursor);
  return query;
}

export const platformInformationWire = Object.freeze({
  listRequest: normalizePlatformInformationListHttpQuery,
  previewRequest: platformInformationPreviewRestoreHttpRequestSchema,
  confirmRequest: platformInformationConfirmRestoreHttpRequestSchema,
  confirmSemanticRequest: validatePlatformInformationConfirmRestoreHttpRequest,
  retryRequest: platformInformationRetryExtractionHttpRequestSchema,
  listResponse: platformInformationPageSchema,
  branchFilesPageResponse: platformInformationBranchFilesPageSchema,
  detailResponse: platformInformationDetailResponseSchema,
  previewResponse: restoreBranchFilesPreviewReceiptSchema,
  confirmResponse: restoreBranchFilesConfirmedIntentSchema,
  retryResponse: knowledgeExtractionRetryIntentSchema,
});
