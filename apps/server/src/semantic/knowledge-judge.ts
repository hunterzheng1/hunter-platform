/**
 * Server-side confidence heuristics transplanted from Hunter-Harness
 * `harness_knowledge.py` (calculate_confidence / should_auto_promote).
 * No AI — deterministic scoring only.
 */

export interface KnowledgeConfidenceScore {
  score: number;
  level: "high" | "medium" | "low";
  signals: string[];
  lastCalculatedAt: string;
}

const ALLOWED_AUTO_PROMOTE_TYPES = new Set([
  "decision",
  "api-contract",
  "requirement",
  "pitfall"
]);

const DEFAULT_MIN_CONFIDENCE = 0.82;

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function confidenceLevel(score: number): KnowledgeConfidenceScore["level"] {
  if (score >= 0.82) return "high";
  if (score >= 0.55) return "medium";
  return "low";
}

function archiveDate(entry: Record<string, unknown>): Date | null {
  const source = entry.source as Record<string, unknown> | undefined;
  const archive = typeof source?.archive === "string" ? source.archive : "";
  const match = /(\d{4}-\d{2}-\d{2})/.exec(archive);
  if (match === null || match[1] === undefined) return null;
  const parsed = Date.parse(match[1] + "T00:00:00Z");
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function entryAgeDays(entry: Record<string, unknown>, now: Date): number | null {
  const date = archiveDate(entry);
  if (date === null) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
}

function validationStatus(entry: Record<string, unknown>): string | null {
  const lifecycle = entry.lifecycle as Record<string, unknown> | undefined;
  const validation = lifecycle?.validation as Record<string, unknown> | undefined;
  if (validation === undefined || typeof validation.status !== "string") return null;
  return validation.status;
}

function normalizedEntryText(entry: Record<string, unknown>): string {
  return [entry.title, entry.summary, entry.body]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
}

function hasStabilitySignal(text: string): boolean {
  return /long[- ]?lived|stable|canonical|invariant|always|never break/.test(text);
}

/** Score an ingest entry payload; mutates a copy's confidence field via return value. */
export function calculateConfidence(
  entry: Record<string, unknown>,
  now = new Date()
): KnowledgeConfidenceScore {
  const lifecycle = (entry.lifecycle as Record<string, unknown> | undefined) ?? {};
  const legacy = String(lifecycle.confidence ?? "medium");
  let score = ({ high: 0.76, medium: 0.58, low: 0.36 } as Record<string, number>)[legacy] ?? 0.58;
  const signals: string[] = [`base:${legacy}`];

  const typeBonus: Record<string, number> = {
    decision: 0.14,
    "api-contract": 0.14,
    requirement: 0.12,
    pitfall: 0.1,
    "test-evidence": 0.04,
    implementation: 0,
    risk: -0.04
  };
  const entryType = String(entry.type ?? "");
  const bonus = typeBonus[entryType] ?? 0;
  if (bonus !== 0) {
    score += bonus;
    signals.push(`type_bonus:${entryType}:${bonus >= 0 ? "+" : ""}${bonus.toFixed(2)}`);
  }

  const source = (entry.source as Record<string, unknown> | undefined) ?? {};
  const finalStatus = String(source.finalStatus ?? "").trim().toLowerCase();
  if (["ok", "success", "passed", "pass"].includes(finalStatus)) {
    score += 0.04;
    signals.push("source_final_status_ok:+0.04");
  } else if (["fail", "failed", "error", "warn"].includes(finalStatus)) {
    score -= 0.08;
    signals.push("source_final_status_not_ok:-0.08");
  }

  const scope = (entry.scope as Record<string, unknown> | undefined) ?? {};
  if (Array.isArray(scope.sourceFiles) && scope.sourceFiles.length > 0) {
    score += 0.03;
    signals.push("has_source_files:+0.03");
  }

  const text = normalizedEntryText(entry);
  if (hasStabilitySignal(text) || entryType === "decision" || entryType === "api-contract") {
    score += 0.06;
    signals.push("long_lived_signal:+0.06");
  }

  const status = String(entry.status ?? "");
  const staleReasons = Array.isArray(lifecycle.staleReasons) ? lifecycle.staleReasons : [];
  if (status === "stale") {
    score -= 0.35;
    signals.push("status_stale_penalty");
  }
  if (staleReasons.some((reason) => String(reason).includes("source files changed"))) {
    score -= 0.25;
    signals.push("source_change_penalty");
  }
  if (status === "superseded" || lifecycle.supersededBy) {
    score -= 0.8;
    signals.push("superseded_penalty");
  }
  if (
    status === "conflicted" ||
    (Array.isArray(lifecycle.conflictsWith) && lifecycle.conflictsWith.length > 0)
  ) {
    score -= 0.8;
    signals.push("conflict_penalty");
  }

  const validator = validationStatus(entry);
  if (validator === "passed") {
    score += 0.15;
    signals.push("validator_pass_bonus");
  } else if (validator === "failed") {
    score -= 0.5;
    signals.push("validator_fail_penalty");
  } else if (validator === "skipped") {
    score -= 0.05;
    signals.push("validator_skipped_penalty");
  }

  const ageDays = entryAgeDays(entry, now);
  if (ageDays !== null) {
    const agePenalty = Math.min(0.25, (ageDays / 45) * 0.06);
    if (agePenalty > 0) {
      score -= agePenalty;
      signals.push(`age_penalty:${ageDays}d:-${agePenalty.toFixed(2)}`);
    }
  }

  score = clampScore(score);
  return {
    score: Math.round(score * 1000) / 1000,
    level: confidenceLevel(score),
    signals,
    lastCalculatedAt: now.toISOString()
  };
}

export function shouldAutoPromote(
  entry: Record<string, unknown>,
  options: { minConfidence?: number; enabled?: boolean } = {}
): boolean {
  const enabled = options.enabled ?? true;
  if (!enabled) return false;
  const lifecycle = (entry.lifecycle as Record<string, unknown> | undefined) ?? {};
  if (lifecycle.publishBlocked) return false;
  if (!ALLOWED_AUTO_PROMOTE_TYPES.has(String(entry.type ?? ""))) return false;
  const status = String(entry.status ?? "");
  if (status === "stale") return false;
  if (status !== "candidate") return false;
  if (Array.isArray(lifecycle.staleReasons) && lifecycle.staleReasons.length > 0) return false;
  const confidence = entry.confidence as { score?: number } | undefined;
  const score = Number(confidence?.score ?? 0);
  if (score < (options.minConfidence ?? DEFAULT_MIN_CONFIDENCE)) return false;
  if (
    (Array.isArray(lifecycle.conflictsWith) && lifecycle.conflictsWith.length > 0) ||
    lifecycle.supersededBy
  ) {
    return false;
  }
  return true;
}

/**
 * Apply confidence scoring and auto-promote candidate → active when eligible.
 * Returns a new payload object (does not mutate input).
 */
export function adjudicateKnowledgeEntry(
  payload: Record<string, unknown>,
  now = new Date()
): { payload: Record<string, unknown>; status: string; promoted: boolean } {
  const currentStatus = String(payload.status ?? "candidate");
  // Document/entry already deprecated or terminal — leave status alone.
  if (["deprecated", "superseded", "conflicted", "active"].includes(currentStatus)) {
    const confidence = calculateConfidence({ ...payload, status: currentStatus }, now);
    return {
      payload: { ...payload, status: currentStatus, confidence },
      status: currentStatus,
      promoted: false
    };
  }

  const withConfidence: Record<string, unknown> = {
    ...payload,
    confidence: calculateConfidence(payload, now)
  };
  if (!shouldAutoPromote(withConfidence)) {
    return {
      payload: withConfidence,
      status: String(withConfidence.status ?? "candidate"),
      promoted: false
    };
  }

  const previousLifecycle = (withConfidence.lifecycle as Record<string, unknown> | undefined) ?? {};
  const lifecycle = {
    ...previousLifecycle,
    promotedAt: now.toISOString(),
    promotionNote: `autoPromote: confidence ${(withConfidence.confidence as KnowledgeConfidenceScore).score.toFixed(3)} >= ${DEFAULT_MIN_CONFIDENCE.toFixed(3)}`,
    lastCheckedAt: typeof previousLifecycle.lastCheckedAt === "string"
      ? previousLifecycle.lastCheckedAt
      : now.toISOString()
  };
  const confidence = withConfidence.confidence as KnowledgeConfidenceScore;
  const signals = [...confidence.signals, "auto_promoted"];
  return {
    payload: {
      ...withConfidence,
      status: "active",
      lifecycle,
      confidence: { ...confidence, signals }
    },
    status: "active",
    promoted: true
  };
}
