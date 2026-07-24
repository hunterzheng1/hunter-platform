export const DIAGNOSTIC_REDACTION_SCHEMA_VERSION = 1 as const;

export interface DiagnosticRedactionOptions {
  readonly registeredSecrets?: readonly string[] | undefined;
  readonly privatePathRoots?: readonly string[] | undefined;
  readonly maxDepth?: number | undefined;
  readonly maxStringBytes?: number | undefined;
  readonly maxCollectionItems?: number | undefined;
  readonly maxTotalNodes?: number | undefined;
  readonly maxTotalBytes?: number | undefined;
}

export interface DiagnosticRedactionCounts {
  readonly authorization: number;
  readonly cookie: number;
  readonly credential: number;
  readonly path: number;
  readonly prompt: number;
  readonly registeredSecret: number;
  readonly total: number;
}

export interface DiagnosticRedactionResult {
  readonly schemaVersion: typeof DIAGNOSTIC_REDACTION_SCHEMA_VERSION;
  readonly value: unknown;
  readonly replacements: DiagnosticRedactionCounts;
}

type MutableCounts = {
  -readonly [Key in Exclude<
    keyof DiagnosticRedactionCounts,
    "total"
  >]: number;
};

interface RedactionLimits {
  readonly maxDepth: number;
  readonly maxStringBytes: number;
  readonly maxCollectionItems: number;
  readonly maxTotalNodes: number;
  readonly maxTotalBytes: number;
}

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_STRING_BYTES = 8 * 1024;
const DEFAULT_MAX_COLLECTION_ITEMS = 256;
const DEFAULT_MAX_TOTAL_NODES = 4_096;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024;
const MAX_REGISTERED_SECRETS = 256;
const MAX_PRIVATE_PATH_ROOTS = 64;
const MAX_DIAGNOSTIC_SCAN_BYTES = 2 * 1024 * 1024;
const AUTHORIZATION_KEY = /authorization/iu;
const COOKIE_KEY = /(?:^|[_-])(?:cookie|set_cookie)(?:$|[_-])/iu;
const PROMPT_KEY = /(?:^|[_-])prompt(?:$|[_-])/iu;
const CREDENTIAL_KEY =
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|credential)/iu;

function boundedUtf8ByteLength(
  value: string,
  maxBytes: number,
  errorCode: string,
): number {
  if (value.length > maxBytes) throw new Error(errorCode);
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (byteLength > maxBytes) throw new Error(errorCode);
  return byteLength;
}

function validateOptions(options: DiagnosticRedactionOptions): RedactionLimits {
  const limits = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxStringBytes: options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES,
    maxCollectionItems:
      options.maxCollectionItems ?? DEFAULT_MAX_COLLECTION_ITEMS,
    maxTotalNodes: options.maxTotalNodes ?? DEFAULT_MAX_TOTAL_NODES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };
  const registeredSecrets = options.registeredSecrets ?? [];
  const privatePathRoots = options.privatePathRoots ?? [];
  if (
    !Number.isSafeInteger(limits.maxDepth)
    || limits.maxDepth < 1
    || !Number.isSafeInteger(limits.maxStringBytes)
    || limits.maxStringBytes < 1
    || !Number.isSafeInteger(limits.maxCollectionItems)
    || limits.maxCollectionItems < 1
    || !Number.isSafeInteger(limits.maxTotalNodes)
    || limits.maxTotalNodes < 1
    || !Number.isSafeInteger(limits.maxTotalBytes)
    || limits.maxTotalBytes < 1
    || registeredSecrets.some((secret) => secret.length === 0)
    || privatePathRoots.some((root) => root.length === 0)
  ) {
    throw new Error("REDACTION_OPTIONS_INVALID");
  }
  if (
    limits.maxDepth > DEFAULT_MAX_DEPTH
    || limits.maxStringBytes > DEFAULT_MAX_STRING_BYTES
    || limits.maxCollectionItems > DEFAULT_MAX_COLLECTION_ITEMS
    || limits.maxTotalNodes > DEFAULT_MAX_TOTAL_NODES
    || limits.maxTotalBytes > DEFAULT_MAX_TOTAL_BYTES
    || registeredSecrets.length > MAX_REGISTERED_SECRETS
    || privatePathRoots.length > MAX_PRIVATE_PATH_ROOTS
  ) {
    throw new Error("REDACTION_OPTIONS_LIMIT_EXCEEDED");
  }
  for (const value of [...registeredSecrets, ...privatePathRoots]) {
    boundedUtf8ByteLength(
      value,
      limits.maxStringBytes,
      "REDACTION_OPTIONS_LIMIT_EXCEEDED",
    );
  }
  return limits;
}

interface ValidationBudget {
  totalNodes: number;
  totalBytes: number;
}

function validateValue(
  input: unknown,
  limits: ReturnType<typeof validateOptions>,
  options: DiagnosticRedactionOptions,
  ancestors: Set<object>,
  budget: ValidationBudget,
  depth: number,
): void {
  if (depth > limits.maxDepth) throw new Error("REDACTION_DEPTH_EXCEEDED");
  budget.totalNodes += 1;
  if (budget.totalNodes > limits.maxTotalNodes) {
    throw new Error("REDACTION_TOTAL_NODE_LIMIT_EXCEEDED");
  }
  if (typeof input === "string") {
    const byteLength = boundedUtf8ByteLength(
      input,
      limits.maxStringBytes,
      "REDACTION_STRING_LIMIT_EXCEEDED",
    );
    budget.totalBytes += byteLength;
    if (budget.totalBytes > limits.maxTotalBytes) {
      throw new Error("REDACTION_TOTAL_BYTE_LIMIT_EXCEEDED");
    }
    return;
  }
  if (
    input === null
    || typeof input === "boolean"
    || (typeof input === "number" && Number.isFinite(input))
  ) {
    return;
  }
  if (typeof input !== "object") {
    throw new Error("REDACTION_UNSUPPORTED_VALUE");
  }
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    throw new Error("REDACTION_BINARY_FORBIDDEN");
  }
  if (ancestors.has(input)) throw new Error("REDACTION_CIRCULAR_REFERENCE");
  if (Object.getOwnPropertySymbols(input).length > 0) {
    throw new Error("REDACTION_SYMBOL_KEY_FORBIDDEN");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.values(descriptors).some((descriptor) =>
    "get" in descriptor || "set" in descriptor
  )) {
    throw new Error("REDACTION_ACCESSOR_FORBIDDEN");
  }
  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      if (input.length > limits.maxCollectionItems) {
        throw new Error("REDACTION_COLLECTION_LIMIT_EXCEEDED");
      }
      for (const item of input) {
        validateValue(item, limits, options, ancestors, budget, depth + 1);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(input) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("REDACTION_UNKNOWN_OBJECT");
    }
    const entries = Object.entries(input);
    if (entries.length > limits.maxCollectionItems) {
      throw new Error("REDACTION_COLLECTION_LIMIT_EXCEEDED");
    }
    for (const [key, value] of entries) {
      if (
        [...options.registeredSecrets ?? [], ...options.privatePathRoots ?? []]
          .some((sensitiveValue) => key.includes(sensitiveValue))
      ) {
        throw new Error("REDACTION_SENSITIVE_KEY_FORBIDDEN");
      }
      const keyByteLength = boundedUtf8ByteLength(
        key,
        limits.maxStringBytes,
        "REDACTION_STRING_LIMIT_EXCEEDED",
      );
      budget.totalBytes += keyByteLength;
      if (budget.totalBytes > limits.maxTotalBytes) {
        throw new Error("REDACTION_TOTAL_BYTE_LIMIT_EXCEEDED");
      }
      validateValue(value, limits, options, ancestors, budget, depth + 1);
    }
  } finally {
    ancestors.delete(input);
  }
}

function replaceLiteral(
  value: string,
  literal: string,
  replacement: string,
): { readonly value: string; readonly count: number } {
  if (literal.length === 0 || !value.includes(literal)) {
    return { value, count: 0 };
  }
  const pieces = value.split(literal);
  return {
    value: pieces.join(replacement),
    count: pieces.length - 1,
  };
}

function replacePattern(
  value: string,
  pattern: RegExp,
  replacement: string,
): { readonly value: string; readonly count: number } {
  let count = 0;
  return {
    value: value.replace(pattern, (...args: unknown[]) => {
      count += 1;
      const match = String(args[0]);
      return replacement.replace("$MATCH", match);
    }),
    count,
  };
}

function redactString(
  input: string,
  options: DiagnosticRedactionOptions,
  counts: MutableCounts,
): string {
  let value = input;
  for (const root of options.privatePathRoots ?? []) {
    const replaced = replaceLiteral(value, root, "[PRIVATE_PATH]");
    value = replaced.value;
    counts.path += replaced.count;
  }
  for (const secret of options.registeredSecrets ?? []) {
    const replaced = replaceLiteral(value, secret, "[REDACTED]");
    value = replaced.value;
    counts.registeredSecret += replaced.count;
  }

  const structuredAuthorization = replacePattern(
    value,
    /["']authorization["']\s*:\s*["'](?:bearer|basic)\s+[^"']*["']/giu,
    '"authorization":"[REDACTED]"',
  );
  value = structuredAuthorization.value;
  counts.authorization += structuredAuthorization.count;
  const structuredCookie = replacePattern(
    value,
    /["'](?:cookie|set[_-]cookie)["']\s*:\s*["'][^"']*["']/giu,
    '"cookie":"[REDACTED]"',
  );
  value = structuredCookie.value;
  counts.cookie += structuredCookie.count;
  const structuredCredential = replacePattern(
    value,
    /["'][^"']*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|credential)[^"']*["']\s*:\s*["'][^"']*["']/giu,
    '"credential":"[REDACTED]"',
  );
  value = structuredCredential.value;
  counts.credential += structuredCredential.count;

  const authorization = replacePattern(
    value,
    /authorization\s*:\s*(?:bearer|basic)\s+[^\s,;"'}\]]+/giu,
    "Authorization: [REDACTED]",
  );
  value = authorization.value;
  counts.authorization += authorization.count;

  const cookie = replacePattern(
    value,
    /(?:set-cookie|cookie)\s*:\s*[^\r\n]+/giu,
    "Cookie: [REDACTED]",
  );
  value = cookie.value;
  counts.cookie += cookie.count;

  const credential = replacePattern(
    value,
    /\b[A-Z][A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)\s*=\s*[^\s,;"'}\]]+/giu,
    "[REDACTED_CREDENTIAL]",
  );
  value = credential.value;
  counts.credential += credential.count;

  const queryCredential = replacePattern(
    value,
    /([?&](?:token|access_token|auth|key)=)[^&\s,;"'}\]]+/giu,
    "$MATCH",
  );
  if (queryCredential.count > 0) {
    value = value.replace(
      /([?&](?:token|access_token|auth|key)=)[^&\s,;"'}\]]+/giu,
      "$1[REDACTED]",
    );
    counts.credential += queryCredential.count;
  }

  const windowsPath = replacePattern(
    value,
    /\b[A-Za-z]:\\(?:(?!\s+\|\s+|[\r\n"'<>]).)+/gu,
    "[PRIVATE_PATH]",
  );
  value = windowsPath.value;
  counts.path += windowsPath.count;
  const windowsForwardPath = replacePattern(
    value,
    /\b[A-Za-z]:\/(?:(?!\s+\|\s+|[\r\n"'<>]).)+/gu,
    "[PRIVATE_PATH]",
  );
  value = windowsForwardPath.value;
  counts.path += windowsForwardPath.count;
  const uncPath = replacePattern(
    value,
    /\\\\[^\\\s|"'<>]+\\(?:(?!\s+\|\s+|[\r\n"'<>]).)+/gu,
    "[PRIVATE_PATH]",
  );
  value = uncPath.value;
  counts.path += uncPath.count;
  const unixPath = replacePattern(
    value,
    /(?<![:/])\/(?:(?!\s+\|\s+|[\r\n"'<>]).)+/gu,
    "[PRIVATE_PATH]",
  );
  value = unixPath.value;
  counts.path += unixPath.count;
  return value;
}

function redactValue(
  input: unknown,
  options: DiagnosticRedactionOptions,
  counts: MutableCounts,
): unknown {
  if (typeof input === "string") return redactString(input, options, counts);
  if (
    input === null
    || typeof input === "boolean"
    || typeof input === "number"
  ) {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactValue(item, options, counts));
  }
  if (typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => {
      if (AUTHORIZATION_KEY.test(key)) {
        counts.authorization += 1;
        return [key, "[REDACTED]"];
      }
      if (COOKIE_KEY.test(key)) {
        counts.cookie += 1;
        return [key, "[REDACTED]"];
      }
      if (PROMPT_KEY.test(key)) {
        counts.prompt += 1;
        return [key, "[REDACTED_PROMPT]"];
      }
      if (CREDENTIAL_KEY.test(key)) {
        counts.credential += 1;
        return [key, "[REDACTED]"];
      }
      return [key, redactValue(value, options, counts)];
    }));
  }
  return "[REDACTED_UNSUPPORTED]";
}

export function redactDiagnosticValue(
  input: unknown,
  options: DiagnosticRedactionOptions = {},
): DiagnosticRedactionResult {
  const limits = validateOptions(options);
  validateValue(input, limits, options, new Set(), {
    totalNodes: 0,
    totalBytes: 0,
  }, 0);
  const counts: MutableCounts = {
    authorization: 0,
    cookie: 0,
    credential: 0,
    path: 0,
    prompt: 0,
    registeredSecret: 0,
  };
  const value = redactValue(input, options, counts);
  return {
    schemaVersion: DIAGNOSTIC_REDACTION_SCHEMA_VERSION,
    value,
    replacements: {
      ...counts,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    },
  };
}

export function assertNoSensitiveMaterial(
  bytes: Uint8Array | string,
  canaries: readonly string[] = [],
): void {
  const inputByteLength = typeof bytes === "string"
    ? boundedUtf8ByteLength(
      bytes,
      MAX_DIAGNOSTIC_SCAN_BYTES,
      "DIAGNOSTIC_SCAN_INPUT_LIMIT_EXCEEDED",
    )
    : bytes.byteLength;
  if (
    inputByteLength > MAX_DIAGNOSTIC_SCAN_BYTES
    ||
    canaries.length > MAX_REGISTERED_SECRETS
  ) {
    throw new Error("DIAGNOSTIC_SCAN_INPUT_LIMIT_EXCEEDED");
  }
  for (const canary of canaries) {
    boundedUtf8ByteLength(
      canary,
      DEFAULT_MAX_STRING_BYTES,
      "DIAGNOSTIC_SCAN_INPUT_LIMIT_EXCEEDED",
    );
  }
  const serialized = typeof bytes === "string"
    ? bytes
    : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const normalized = serialized
    .replace(/\\"/gu, '"')
    .replace(/\\\\/gu, "\\");
  const hasCanary = canaries.some((canary) =>
    canary.length > 0
    && (serialized.includes(canary) || normalized.includes(canary))
  );
  if (hasCanary) {
    throw new Error("DIAGNOSTIC_SENSITIVE_MATERIAL_DETECTED_CANARY");
  }
  const unsafePatterns = [
    /authorization\s*:\s*(?:bearer|basic)\s+(?!\[REDACTED\])/iu,
    /(?:set-cookie|cookie)\s*:(?!\s*\[REDACTED\])/iu,
    /\b[A-Z][A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)\s*=\s*(?!\[REDACTED)/u,
    /["']authorization["']\s*:\s*["'](?:bearer|basic)\s+(?!\[REDACTED\])/iu,
    /["'](?:cookie|set[_-]cookie)["']\s*:\s*["'](?!\[REDACTED\])/iu,
    /["'][^"']*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|credential)[^"']*["']\s*:\s*["'](?!\[REDACTED\])/iu,
    /\b[A-Za-z]:\\(?!\[PRIVATE_PATH\])/u,
    /\b[A-Za-z]:\/(?!\[PRIVATE_PATH\])/u,
    /\\\\[^\\\s|"'<>]+\\(?!\[PRIVATE_PATH\])/u,
    /(?<![:/])\/(?!\[PRIVATE_PATH\])/u,
  ];
  const unsafePattern = unsafePatterns.findIndex((pattern) =>
    pattern.test(normalized)
  );
  if (unsafePattern >= 0) {
    throw new Error(
      `DIAGNOSTIC_SENSITIVE_MATERIAL_DETECTED_PATTERN_${unsafePattern + 1}`,
    );
  }
}
