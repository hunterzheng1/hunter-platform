import { createHash } from "node:crypto";

import type { KnowledgeCandidate } from "@hunter-harness/contracts";

/**
 * Derive knowledge candidates from an archived `reports/final/summary-data.json`.
 *
 * Archives published before the CLI grew a candidate generator carry no
 * `candidates/knowledge.json`, so extraction over them yields nothing — and the
 * server keeps one immutable package per change key, so the client cannot go
 * back and add the file. Deriving here is the only route that reaches those
 * archives, and it needs no re-upload.
 *
 * This is a line-by-line port of `harness/scripts/harness_knowledge_candidates.py`
 * from the Hunter-Harness repository: same sources, same mapping, same
 * `candidate_id` and `content_hash` algorithms. A candidate derived here is
 * therefore byte-identical to the one the CLI would have shipped for the same
 * summary, so an archive that later arrives with its own candidates does not
 * produce a second, competing record.
 *
 * No model is involved. Every emitted field is copied or derived from a real
 * summary field, so the output is reproducible and free of invention.
 */

const SCHEMA_VERSION = 1;
const PRODUCER = "harness-archive";
/** Only these severities carry knowledge; OK is dropped by the spec. */
const SEVERITIES = new Set(["RED", "YELLOW"]);
/** Adjudicated dispositions the spec adopts, mapped to the entry type. */
const DISPOSITION_ENTRY_TYPES = new Map<string, "pitfall" | "risk">([
  ["FIXED", "pitfall"],
  ["ACCEPTED_RISK", "risk"],
  ["DEFERRED", "risk"]
]);
const SEVERITY_CONFIDENCE = new Map([["RED", 0.95], ["YELLOW", 0.85]]);
const KNOWN_RISK_CONFIDENCE = 0.85;

const MAX_KEYWORDS = 32;
const MAX_KEYWORD_CHARS = 80;
const MAX_BODY_CHARS = 20_000;

export interface DeriveKnowledgeCandidatesInput {
  readonly summary: unknown;
  readonly changeKey: string;
  readonly archiveId: string;
  readonly producerVersion: string;
  readonly createdAt: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function digest(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

function candidateId(changeKey: string, kind: string, identity: string): string {
  return `kc_${digest(changeKey, kind, identity).slice(0, 32)}`;
}

function contentHash(
  entryType: string,
  summary: string,
  body: string,
  keywords: readonly string[]
): string {
  // Mirrors Python's json.dumps(..., sort_keys=True, separators=(",", ":")).
  const canonical = JSON.stringify({
    body,
    entry_type: entryType,
    keywords,
    summary
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** Deduplicate, preserve order, and honour the contract's bounds. */
function buildKeywords(...values: readonly string[]): string[] {
  const seen: string[] = [];
  for (const value of values) {
    const keyword = text(value).slice(0, MAX_KEYWORD_CHARS);
    if (keyword !== "" && !seen.includes(keyword)) seen.push(keyword);
  }
  return seen.slice(0, MAX_KEYWORDS);
}

function pathSegments(path: string): string[] {
  return path.replaceAll("\\", "/").split("/").filter((segment) => segment !== "");
}

/** `path:line` when the line number is real, otherwise just the path. */
function location(path: string, line: unknown): string {
  if (path === "") return "";
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return path;
  return `${path}:${line}`;
}

function findingCandidate(
  finding: Record<string, unknown>,
  input: DeriveKnowledgeCandidatesInput
): KnowledgeCandidate | null {
  const severity = text(finding.severity);
  const disposition = text(finding.disposition);
  const entryType = DISPOSITION_ENTRY_TYPES.get(disposition);
  const title = text(finding.title);
  // An unadjudicated finding (OPEN / UNKNOWN) is not yet knowledge.
  if (!SEVERITIES.has(severity) || entryType === undefined || title === "") return null;

  const path = text(finding.path);
  const line = finding.line;
  const where = location(path, line);
  const segments = pathSegments(path);
  const findingId = text(finding.id);

  const bodyLines = [title];
  if (where !== "") bodyLines.push(`位置：${where}`);
  bodyLines.push(`严重度：${severity}`);
  bodyLines.push(`裁决：${disposition}`);
  const body = bodyLines.join("\n").slice(0, MAX_BODY_CHARS);

  const keywords = buildKeywords(
    segments.at(-1) ?? "",
    segments.length >= 2 ? segments.at(-2) ?? "" : "",
    severity,
    disposition
  );
  const sourceRef = findingId === ""
    ? `archive:${input.archiveId}`
    : `archive:${input.archiveId}#${findingId}`;
  const sourceRefs = path !== "" && where !== path
    ? [`${path}#L${String(line)}`]
    : path !== "" ? [path] : [`archive:${input.archiveId}`];

  return {
    schema_version: SCHEMA_VERSION,
    candidate_id: candidateId(
      input.changeKey,
      "review",
      findingId === "" ? `${title}\0${path}\0${String(line)}` : findingId
    ),
    source_change_key: input.changeKey,
    source_refs: sourceRefs,
    summary: title,
    reusability_scope: segments[0] ?? "project",
    content_hash: contentHash(entryType, title, body, keywords),
    confidence: SEVERITY_CONFIDENCE.get(severity) ?? KNOWN_RISK_CONFIDENCE,
    status: "pending",
    entry_type: entryType,
    body,
    keywords,
    provenance: {
      source_kind: "review",
      source_ref: sourceRef,
      producer: PRODUCER,
      producer_version: input.producerVersion,
      created_at: input.createdAt
    }
  } as KnowledgeCandidate;
}

function riskCandidate(
  risk: Record<string, unknown>,
  input: DeriveKnowledgeCandidatesInput
): KnowledgeCandidate | null {
  const message = text(risk.message);
  if (message === "") return null;
  const phase = text(risk.phase);
  const severity = text(risk.severity);

  const bodyLines = [message];
  if (phase !== "") bodyLines.push(`阶段：${phase}`);
  if (severity !== "") bodyLines.push(`严重度：${severity}`);
  const body = bodyLines.join("\n").slice(0, MAX_BODY_CHARS);
  const keywords = buildKeywords(phase, severity);

  return {
    schema_version: SCHEMA_VERSION,
    candidate_id: candidateId(input.changeKey, "known_risk", `${phase}\0${message}`),
    source_change_key: input.changeKey,
    source_refs: [`archive:${input.archiveId}`],
    summary: message,
    reusability_scope: phase === "" ? "project" : phase,
    content_hash: contentHash("risk", message, body, keywords),
    confidence: KNOWN_RISK_CONFIDENCE,
    status: "pending",
    entry_type: "risk",
    body,
    keywords,
    provenance: {
      source_kind: "archive",
      source_ref: `archive:${input.archiveId}`,
      producer: PRODUCER,
      producer_version: input.producerVersion,
      created_at: input.createdAt
    }
  } as KnowledgeCandidate;
}

/**
 * Project `reviewFindings` + `knownRisks` into KnowledgeCandidate records.
 *
 * Returns [] for missing or malformed input: an archive with nothing worth
 * persisting must still produce a valid (empty) result.
 */
export function deriveKnowledgeCandidatesFromSummary(
  input: DeriveKnowledgeCandidatesInput
): KnowledgeCandidate[] {
  const summary = input.summary;
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) return [];
  const record = summary as Record<string, unknown>;
  const candidates: KnowledgeCandidate[] = [];
  const seen = new Set<string>();

  const collect = (candidate: KnowledgeCandidate | null): void => {
    if (candidate === null || seen.has(candidate.candidate_id)) return;
    seen.add(candidate.candidate_id);
    candidates.push(candidate);
  };

  const findings = record.reviewFindings;
  if (Array.isArray(findings)) {
    for (const finding of findings) {
      if (finding !== null && typeof finding === "object" && !Array.isArray(finding)) {
        collect(findingCandidate(finding as Record<string, unknown>, input));
      }
    }
  }

  const risks = record.knownRisks;
  if (Array.isArray(risks)) {
    for (const risk of risks) {
      if (risk !== null && typeof risk === "object" && !Array.isArray(risk)) {
        collect(riskCandidate(risk as Record<string, unknown>, input));
      }
    }
  }

  return candidates;
}
