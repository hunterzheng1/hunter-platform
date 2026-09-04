"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import type { AiQuotaUsage, DashboardOverview } from "@hunter-harness/contracts";

import {
  browserApi,
  type HunterApi,
  type ProjectSummary
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { apiError } from "./skill-shared";
import { Icon, type IconName } from "./ui/icons";
import { Skeleton } from "./ui/Skeleton";

export { ProjectRegistry } from "./project-registry";

function resolveApi(): HunterApi {
  return process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi();
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export function DashboardConsole({ api: propApi }: { api?: HunterApi }) {
  const { t, lang } = useI18n();
  const api = useMemo(() => propApi ?? resolveApi(), [propApi]);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [aiUsage, setAiUsage] = useState<AiQuotaUsage[]>([]);
  const [aiRange, setAiRange] = useState<"today" | "7d" | "all">("today");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    void Promise.all([api.getDashboardOverview(7), api.listProjects(), api.getAiUsage?.() ?? Promise.resolve([])])
      .then(([nextOverview, nextProjects, nextAiUsage]) => {
        if (!active) return;
        setOverview(nextOverview);
        setProjects(nextProjects);
        setAiUsage(nextAiUsage);
      })
      .catch((reason: unknown) => {
        if (active) setError(apiError(reason, t));
      });
    return () => {
      active = false;
    };
  }, [api, t]);

  if (error !== null) return <Empty>{error}</Empty>;
  if (overview === null) {
    return (
      <section className="stack governance-page page-module-v2 dashboard-stack dashboard-v2" aria-busy="true" aria-label={t.dashboard.loading}>
        <div className="dashboard-metric-grid">
          <Skeleton variant="metric" />
          <Skeleton variant="metric" />
          <Skeleton variant="metric" />
          <Skeleton variant="metric" />
        </div>
        <div className="dashboard-main-grid">
          <Skeleton variant="block" />
          <Skeleton variant="block" />
        </div>
        <Skeleton variant="table" lines={5} />
      </section>
    );
  }

  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const versionedProjects = Math.min(
    projects.filter((project) => project.latest_project_version != null).length,
    overview.metrics.projects
  );
  const recentActivity = overview.activity.slice(0, 5);
  const projectNames = new Map(projects.map((project) => [project.project_id, project.display_name]));
  const number = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const filteredAiUsage = filterAiUsage(aiUsage, aiRange);
  const selectedAiTotals = sumAiUsage(filteredAiUsage);
  const allAiTotals = sumAiUsage(aiUsage);
  const totalSkills = overview.metrics.local_skills + overview.metrics.external_skills;
  const metricCards = [
    {
      label: t.dashboard.registeredProjects,
      value: overview.metrics.projects,
      detail: t.dashboard.registeredProjectsHint.replace("{count}", String(versionedProjects)),
      href: "/projects",
      icon: "projects" as const
    },
    {
      label: t.dashboard.allSkills,
      value: totalSkills,
      detail: t.dashboard.skillSourceSummary
        .replace("{local}", String(overview.metrics.local_skills))
        .replace("{external}", String(overview.metrics.external_skills)),
      href: "/skills",
      icon: "skill" as const
    },
    {
      label: t.dashboard.knowledgeEntries,
      value: overview.metrics.knowledge_entries,
      detail: t.dashboard.knowledgeRelationsHint.replace("{count}", String(overview.metrics.knowledge_relations)),
      href: "/knowledge",
      icon: "knowledge" as const
    },
    {
      label: t.dashboard.aiRequests,
      value: number.format(aiUsage.length === 0 ? overview.metrics.ai_requests : allAiTotals.requests),
      detail: t.dashboard.aiTokensHint.replace("{count}", number.format(aiUsage.length === 0 ? overview.metrics.ai_tokens : allAiTotals.tokens)),
      href: "/ai-config",
      icon: "ai" as const
    },
    {
      label: t.dashboard.workflows,
      value: overview.metrics.workflows,
      detail: t.dashboard.workflowsHint,
      href: "/workflows",
      icon: "workflow" as const
    }
  ];

  return (
    <section className="stack governance-page page-module-v2 dashboard-stack dashboard-v2">
      <header className="dashboard-hero">
        <div className="dashboard-hero-copy">
          <p className="eyebrow">{t.dashboard.eyebrow}</p>
          <div className="dashboard-heading"><h1>{t.dashboard.title}</h1></div>
          <p>{t.dashboard.subtitle}</p>
        </div>
        <div className="dashboard-freshness">
          <span>{t.dashboard.dataUpdated}</span>
          <strong>{new Date(overview.generated_at).toLocaleString(locale)}</strong>
          <small>{t.dashboard.dashboardWindow.replace("{days}", String(overview.window.days))}</small>
        </div>
      </header>

      <div className="dashboard-metric-grid rise-in">
        {metricCards.map((metric) => (
          <Link className="dashboard-metric" href={metric.href} key={metric.label}>
            <DashboardIcon name={metric.icon} />
            <div><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.detail}</small></div>
            <Icon name="chevron-right" size={15} className="dashboard-metric-arrow" />
          </Link>
        ))}
      </div>

      <div className="dashboard-insight-grid rise-in" style={{ animationDelay: "60ms" }}>
        <section className="panel dashboard-ai-panel">
          <div className="panel-title dashboard-panel-title">
            <div><p className="eyebrow">{t.dashboard.aiUsageHint}</p><h2>{t.dashboard.aiUsage}</h2></div>
            <div className="dashboard-ai-actions">
              <div className="dashboard-range-tabs" role="tablist" aria-label={t.dashboard.aiUsage}>
                {(["today", "7d", "all"] as const).map((range) => <button key={range} type="button" role="tab" aria-selected={aiRange === range} className={aiRange === range ? "active" : ""} onClick={() => setAiRange(range)}>{range === "today" ? t.dashboard.rangeToday : range === "7d" ? t.dashboard.rangeSevenDays : t.dashboard.rangeAll}</button>)}
              </div>
              <Link href="/ai-config">{t.dashboard.viewAiConfig}</Link>
            </div>
          </div>
          <div className="dashboard-ai-summary">
            <div><span>{t.dashboard.aiRequests}</span><strong>{number.format(selectedAiTotals.requests)}</strong></div>
            <div><span>{t.dashboard.aiTokens}</span><strong>{number.format(selectedAiTotals.tokens)}</strong></div>
            <div><span>{t.dashboard.estimatedCost}</span><strong>${selectedAiTotals.cost.toFixed(2)}</strong></div>
          </div>
          <AiUsageChart records={filteredAiUsage} range={aiRange} locale={locale} />
          <AiModelUsage records={filteredAiUsage} />
        </section>
      </div>

      <div className="dashboard-overview-grid rise-in" style={{ animationDelay: "120ms" }}>
        <section className="panel dashboard-work-panel dashboard-resources-panel">
          <div className="panel-title dashboard-panel-title"><div><p className="eyebrow">{t.dashboard.contentOverview}</p><h2>{t.dashboard.platformContent}</h2></div></div>
          <div className="dashboard-resource-groups">
            <Link href="/skills"><span>{t.dashboard.allSkills}</span><strong>{totalSkills}</strong><small>{t.dashboard.skillSourceSummary.replace("{local}", String(overview.metrics.local_skills)).replace("{external}", String(overview.metrics.external_skills))} · {t.dashboard.publishedCount.replace("{count}", String(overview.metrics.published_skills))}</small></Link>
            <Link href="/knowledge"><span>{t.dashboard.knowledgeEntries}</span><strong>{overview.metrics.knowledge_entries}</strong><small>{t.dashboard.knowledgeRelationsHint.replace("{count}", String(overview.metrics.knowledge_relations))}</small></Link>
          </div>
          <KnowledgeComposition items={overview.distributions.knowledge_categories} />
        </section>

        <section className="panel dashboard-work-panel dashboard-project-panel">
          <div className="panel-title dashboard-panel-title">
            <div><p className="eyebrow">{t.dashboard.projectsPanelEyebrow}</p><h2>{t.dashboard.recentProjects}</h2></div>
            <Link href="/projects">{t.dashboard.viewAll}</Link>
          </div>
          {projects.length === 0 ? <Empty>{t.dashboard.noProjects}</Empty> : <ul className="dashboard-project-list">
            {projects.slice(0, 3).map((project) => (
              <li key={project.project_id}><Link href={`/projects/${project.project_id}`}>
                <span className="dashboard-project-mark" aria-hidden="true">{project.display_name.slice(0, 1).toUpperCase()}</span>
                <div><strong>{project.display_name}</strong><small>{project.latest_project_version === null ? t.dashboard.noVersion : t.dashboard.remoteVersionAvailable}{project.current_file_count === undefined ? "" : ` · ${t.dashboard.currentFiles.replace("{count}", String(project.current_file_count))}`}</small></div>
                <span className="dashboard-role">{statusLabel(project.role, t)}</span>
              </Link></li>
            ))}
          </ul>}
        </section>

        <section className="panel dashboard-work-panel dashboard-activity-panel">
          <div className="panel-title dashboard-panel-title">
            <div><p className="eyebrow">{t.dashboard.recentOperations}</p><h2>{t.dashboard.recentActivity}</h2></div>
            <span>{t.dashboard.activityCount.replace("{shown}", String(recentActivity.length)).replace("{total}", String(overview.activity.length))}</span>
          </div>
          {recentActivity.length === 0 ? <Empty>{t.dashboard.noActivity}</Empty> : <ol className="activity-list dashboard-activity-list" aria-label={t.dashboard.recentActivity}>
            {recentActivity.map((event) => <li key={event.event_id} title={event.target_id}>
              <DashboardIcon name="activity" />
              <div><strong>{actionLabel(event.action, t, lang)}</strong><p>{event.project_id === null ? t.dashboard.registryScope : projectNames.get(event.project_id) ?? t.dashboard.projectScope}</p></div>
              <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString(locale)}</time>
            </li>)}
          </ol>}
        </section>
      </div>

      <nav className="dashboard-quick-links" aria-label={t.dashboard.quickNavigation}>
        <Link href="/projects"><DashboardIcon name="projects" />{t.dashboard.openRegistry}</Link>
        <Link href="/knowledge"><DashboardIcon name="knowledge" />{t.dashboard.browseKnowledge}</Link>
        <Link href="/skills"><DashboardIcon name="skill" />{t.dashboard.browseSkills}</Link>
        <Link href="/ai-config"><DashboardIcon name="ai" />{t.dashboard.viewAiConfig}</Link>
      </nav>
    </section>
  );
}

// 把枚举值（role / kind / 分类 key 等）映射到当前语言文案，查不到时做可读化兜底
function statusLabel(value: string, t: ReturnType<typeof useI18n>["t"]): string {
  const labels = t.status as Record<string, string>;
  return labels[value] ?? labels[value.replaceAll("_", "-")] ?? value.replaceAll("_", " ");
}

// 活动流 action（如 skill.proposal.created）→ 当前语言文案
function actionLabel(action: string, t: ReturnType<typeof useI18n>["t"], lang: "zh" | "en"): string {
  const map = t.dashboard.activityActions as Record<string, string>;
  if (map[action] !== undefined) return map[action];
  return lang === "zh" ? t.dashboard.otherActivity : action.replaceAll("_", " ").replaceAll(".", " · ");
}

function DashboardIcon({ name }: { name: "projects" | "workflow" | "skill" | "activity" | "knowledge" | "ai" }) {
  const map: Record<typeof name, IconName> = {
    projects: "folder",
    workflow: "workflow",
    skill: "sparkles",
    activity: "activity",
    knowledge: "brain",
    ai: "zap"
  };
  return <Icon name={map[name]} size={22} className="dashboard-icon" />;
}

function KnowledgeComposition({ items }: { items: DashboardOverview["distributions"]["knowledge_categories"] }) {
  const { t } = useI18n();
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const visible = items.filter((item) => item.count > 0);
  const palette = ["var(--accent)", "var(--success)", "var(--skill)", "var(--review)", "var(--warning)", "var(--muted)"];
  return <div className="dashboard-skill-composition">
    <span>{t.dashboard.knowledgeComposition}</span>
    {total === 0 ? <small>{t.dashboard.noKnowledge}</small> : <>
      <div className="dashboard-composition-bar" aria-label={t.dashboard.knowledgeComposition}>
        {visible.map((item, index) => <i key={item.key} style={{ width: `${(item.count / total) * 100}%`, background: palette[index % palette.length] }} />)}
      </div>
      <div className="dashboard-composition-legend">
        {visible.map((item, index) => <span key={item.key}><i style={{ background: palette[index % palette.length] }} />{statusLabel(item.key, t)} <b>{item.count}</b></span>)}
      </div>
    </>}
  </div>;
}

function filterAiUsage(records: AiQuotaUsage[], range: "today" | "7d" | "all"): AiQuotaUsage[] {
  if (range === "all") return records;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (range === "today") return records.filter((record) => record.date === today);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6)).toISOString().slice(0, 10);
  return records.filter((record) => record.date >= start && record.date <= today);
}

function sumAiUsage(records: AiQuotaUsage[]): { requests: number; tokens: number; cost: number } {
  return records.reduce((total, record) => ({
    requests: total.requests + record.requests,
    tokens: total.tokens + record.tokens,
    cost: total.cost + record.cost
  }), { requests: 0, tokens: 0, cost: 0 });
}

function AiUsageChart({ records, range, locale }: { records: AiQuotaUsage[]; range: "today" | "7d" | "all"; locale: string }) {
  const { t } = useI18n();
  const rangeLabel = range === "today" ? t.dashboard.rangeToday : range === "7d" ? t.dashboard.rangeSevenDays : t.dashboard.rangeAll;
  const items = range === "today" ? Array.from({ length: 24 }, (_, hour) => ({
    key: String(hour),
    label: hour % 4 === 0 ? `${String(hour).padStart(2, "0")}:00` : "",
    requests: records.reduce((total, record) => total + (record.hourly?.find((item) => item.hour === hour)?.requests ?? 0), 0)
  })) : aggregateDailyUsage(records, range === "7d" ? 7 : 14, locale);
  const max = Math.max(1, ...items.map((item) => item.requests));
  const width = 720;
  const height = 126;
  const points = items.map((item, index) => {
    const x = items.length <= 1 ? width / 2 : (index / (items.length - 1)) * width;
    const y = height - (item.requests / max) * 92 - 14;
    return `${x},${y}`;
  }).join(" ");
  return <div className="dashboard-ai-chart dashboard-ai-line-chart" role="img" aria-label={`${t.dashboard.aiUsage} · ${rangeLabel}`}>
    {records.length === 0 ? <span className="dashboard-ai-empty">{t.dashboard.noAiUsage}</span> : <>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="aiUsageArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".36"/><stop offset="1" stopColor="var(--accent)" stopOpacity="0"/></linearGradient></defs>
        <polyline className="dashboard-ai-area" points={`0,${height} ${points} ${width},${height}`} />
        <polyline className="dashboard-ai-line" points={points} />
      </svg>
      <div className="dashboard-ai-axis">{items.filter((item) => item.label !== "").map((item) => <span key={item.key}>{item.label}</span>)}</div>
      {range === "today" ? <small>{t.dashboard.hourlyUtc}</small> : null}
    </>}
  </div>;
}

function aggregateDailyUsage(records: AiQuotaUsage[], maxPoints: number, locale: string): Array<{ key: string; label: string; requests: number }> {
  const byDate = new Map<string, number>();
  for (const record of records) byDate.set(record.date, (byDate.get(record.date) ?? 0) + record.requests);
  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) return [];
  const chunkSize = Math.max(1, Math.ceil(dates.length / maxPoints));
  return Array.from({ length: Math.ceil(dates.length / chunkSize) }, (_, index) => {
    const group = dates.slice(index * chunkSize, (index + 1) * chunkSize);
    const date = group[group.length - 1] ?? dates[0] ?? "";
    return {
      key: `${group[0]}-${date}`,
      label: new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, { month: "numeric", day: "numeric" }),
      requests: group.reduce((total, item) => total + (byDate.get(item) ?? 0), 0)
    };
  });
}

function AiModelUsage({ records }: { records: AiQuotaUsage[] }) {
  const { t } = useI18n();
  const palette = ["#7f9cff", "#4dd6a4", "#c38cff", "#ffb45f", "#51c8e8", "#ff7597"];
  const models = [...records.reduce((map, record) => {
    const key = record.model || record.provider_id;
    const current = map.get(key) ?? { model: key, requests: 0, tokens: 0, cost: 0 };
    current.requests += record.requests;
    current.tokens += record.tokens;
    current.cost += record.cost;
    map.set(key, current);
    return map;
  }, new Map<string, { model: string; requests: number; tokens: number; cost: number }>()).values()]
    .sort((left, right) => right.requests - left.requests);
  const total = Math.max(1, models.reduce((sum, model) => sum + model.requests, 0));
  if (models.length === 0) return null;
  return <div className="dashboard-model-usage">
    <span>{t.dashboard.usageByModel}</span>
    <div className="dashboard-model-strip">{models.map((model, index) => <i key={model.model} style={{ width: `${(model.requests / total) * 100}%`, background: palette[index % palette.length] }} />)}</div>
    <div className="dashboard-model-legend">{models.slice(0, 6).map((model, index) => <div key={model.model}><i style={{ background: palette[index % palette.length] }} /><strong>{model.model}</strong><span>{model.requests} · {new Intl.NumberFormat().format(model.tokens)} Token</span><b>${model.cost.toFixed(2)}</b></div>)}</div>
  </div>;
}

export function AuthTokenForm() {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submitToken(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextToken = token.trim();
    setSaved(false);
    setMessage(null);
    if (nextToken === "") return;
    if (!/^hh_[A-Za-z0-9_-]+$/.test(nextToken)) {
      setMessage(t.token.invalidFormat);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/v1/projects?limit=1", {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + nextToken,
          "X-Request-Id": globalThis.crypto.randomUUID()
        }
      });
      if (!response.ok) {
        setMessage(
          response.status === 401 || response.status === 403
            ? t.token.rejected
            : t.token.httpError + response.status + "."
        );
        return;
      }
      window.sessionStorage.setItem("hunter-harness-token", nextToken);
      setToken("");
      setSaved(true);
      window.location.assign(window.location.pathname + window.location.search);
    } catch {
      setMessage(t.token.networkPolicy);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="token-form" onSubmit={(event) => { void submitToken(event); }}>
      <label htmlFor="api-token">{t.token.label}</label>
      <input
        id="api-token"
        type="password"
        autoComplete="off"
        value={token}
        onChange={(event) => {
          setToken(event.target.value);
          setSaved(false);
          setMessage(null);
        }}
        placeholder={t.token.placeholder}
      />
      <button type="submit" disabled={busy}>{busy ? t.token.checking : t.token.setButton}</button>
      {saved ? <span>{t.token.saved}</span> : null}
      {message === null ? null : <span>{message}</span>}
    </form>
  );
}
