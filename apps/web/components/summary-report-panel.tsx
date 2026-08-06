"use client";

import type { SemanticDocument } from "@hunter-harness/contracts";
import { useEffect, useMemo, useState } from "react";

import type { HunterApi } from "../lib/api";
import { useI18n } from "../lib/i18n";

interface SummaryFields {
  changeName: string;
  finalStatus: string;
  knownRisks: string[];
  verificationLines: string[];
  reviewStatus: string | null;
  raw: Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseSummary(document: SemanticDocument): SummaryFields {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(document.body) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const verification = (raw.verification ?? {}) as Record<string, unknown>;
  const verificationLines: string[] = [];
  for (const [key, value] of Object.entries(verification)) {
    if (value !== null && typeof value === "object" && "status" in value) {
      verificationLines.push(`${key}: ${String((value as { status: unknown }).status)}`);
    } else if (typeof value === "string") {
      verificationLines.push(`${key}: ${value}`);
    }
  }
  const risksRaw = raw.knownRisks;
  const knownRisks = Array.isArray(risksRaw)
    ? risksRaw.map((item) => {
      if (typeof item === "string") return item;
      if (item !== null && typeof item === "object" && "summary" in item) {
        return String((item as { summary: unknown }).summary);
      }
      return JSON.stringify(item);
    })
    : [];
  const review = raw.reviewSummary;
  const reviewStatus = review !== null && typeof review === "object" && "status" in review
    ? String((review as { status: unknown }).status)
    : asString(review);
  return {
    changeName: asString(raw.changeName) ?? document.title,
    finalStatus: asString(raw.finalStatus) ?? asString(document.metadata.final_status) ?? "—",
    knownRisks,
    verificationLines,
    reviewStatus,
    raw
  };
}

export function SummaryReportPanel({ api, projectId }: { api: HunterApi; projectId: string }) {
  const { lang } = useI18n();
  const copy = lang === "zh" ? {
    title: "归档摘要报告",
    lede: "只读视图：从 summary-data.json（语义归档记录）提取关键字段，不做 HTML 复刻。",
    empty: "暂无归档摘要。请先 push 含 reports/final/summary-data.json 的归档。",
    loading: "正在加载摘要…",
    failed: "摘要报告暂不可用。",
    status: "最终状态",
    risks: "已知风险",
    verification: "验证摘要",
    review: "评审状态",
    noRisks: "未记录风险",
    noVerification: "无验证字段"
  } : {
    title: "Archive summary report",
    lede: "Read-only view of key fields from summary-data.json (semantic archive records). Not a pixel HTML replica.",
    empty: "No archive summaries yet. Push an archive that includes reports/final/summary-data.json.",
    loading: "Loading summaries…",
    failed: "Summary reports are unavailable.",
    status: "Final status",
    risks: "Known risks",
    verification: "Verification",
    review: "Review status",
    noRisks: "No risks recorded",
    noVerification: "No verification fields"
  };

  const [docs, setDocs] = useState<SemanticDocument[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    void (async () => {
      if (api.listProjectSemanticChanges === undefined) throw new Error("semantic API unavailable");
      const items = await api.listProjectSemanticChanges(projectId);
      if (!active) return;
      setDocs(items);
      setSelectedId(items[0]?.document_id ?? null);
    })().catch(() => {
      if (active) setError(copy.failed);
    });
    return () => { active = false; };
  }, [api, projectId, copy.failed]);

  const selected = useMemo(
    () => docs?.find((item) => item.document_id === selectedId) ?? docs?.[0] ?? null,
    [docs, selectedId]
  );
  const summary = selected === null ? null : parseSummary(selected);

  if (error !== null && docs === null) return <div className="empty-state">{error}</div>;
  if (docs === null) return <div className="empty-state">{copy.loading}</div>;

  return (
    <section className="summary-report-panel">
      <header className="panel-section-header">
        <div>
          <h3>{copy.title}</h3>
          <p className="lede">{copy.lede}</p>
        </div>
      </header>
      {docs.length === 0 ? (
        <div className="knowledge-empty"><span>◇</span><p>{copy.empty}</p></div>
      ) : (
        <div className="knowledge-split">
          <ul className="knowledge-hit-list">
            {docs.map((doc) => (
              <li key={doc.document_id}>
                <button
                  type="button"
                  className={selected?.document_id === doc.document_id ? "active" : ""}
                  onClick={() => setSelectedId(doc.document_id)}
                >
                  <strong>{doc.title}</strong>
                  <small>{String(doc.metadata.final_status ?? doc.source_path)}</small>
                </button>
              </li>
            ))}
          </ul>
          {summary === null ? null : (
            <article className="summary-report-detail">
              <h2>{summary.changeName}</h2>
              <dl className="summary-report-fields">
                <div>
                  <dt>{copy.status}</dt>
                  <dd><span className="status">{summary.finalStatus}</span></dd>
                </div>
                <div>
                  <dt>{copy.review}</dt>
                  <dd>{summary.reviewStatus ?? "—"}</dd>
                </div>
                <div>
                  <dt>{copy.verification}</dt>
                  <dd>
                    {summary.verificationLines.length === 0 ? copy.noVerification : (
                      <ul>{summary.verificationLines.map((line) => <li key={line}>{line}</li>)}</ul>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{copy.risks}</dt>
                  <dd>
                    {summary.knownRisks.length === 0 ? copy.noRisks : (
                      <ul>{summary.knownRisks.map((risk) => <li key={risk}>{risk}</li>)}</ul>
                    )}
                  </dd>
                </div>
              </dl>
            </article>
          )}
        </div>
      )}
    </section>
  );
}
