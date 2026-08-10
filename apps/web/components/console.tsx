"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import type { DashboardOverview } from "@hunter-harness/contracts";

import {
  browserApi,
  type HunterApi,
  type ProjectSummary
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { apiError, Status } from "./skill-shared";
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    void Promise.all([api.getDashboardOverview(7), api.listProjects()])
      .then(([nextOverview, nextProjects]) => {
        if (!active) return;
        setOverview(nextOverview);
        setProjects(nextProjects);
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
  const coreHealth = overview.health.filter((item) => item.key !== "review_backlog" && item.key !== "review_outcome");
  const serviceIssues = overview.services.filter((item) => item.status !== "operational");
  const healthIssues = coreHealth.filter((item) => item.status !== "healthy");
  const attention = serviceIssues.length > 0 || healthIssues.length > 0;
  const healthyServices = overview.services.length - serviceIssues.length;
  const healthyChecks = coreHealth.length - healthIssues.length;
  const versionedProjects = Math.min(
    projects.filter((project) => project.latest_project_version != null).length,
    overview.metrics.projects
  );
  const recentActivity = overview.activity.slice(0, 5);
  const artifactParts = overview.metrics.project_artifacts + overview.metrics.skill_artifacts;
  const projectArtifactShare = artifactParts === 0 ? 0 : (overview.metrics.project_artifacts / artifactParts) * 100;
  const skillArtifactShare = artifactParts === 0 ? 0 : 100 - projectArtifactShare;
  const projectNames = new Map(projects.map((project) => [project.project_id, project.display_name]));
  const metricCards = [
    {
      label: t.dashboard.registeredProjects,
      value: overview.metrics.projects,
      detail: t.dashboard.registeredProjectsHint.replace("{count}", String(versionedProjects)),
      href: "/projects",
      icon: "projects" as const
    },
    {
      label: t.dashboard.projectVersions,
      value: overview.metrics.project_artifacts,
      detail: t.dashboard.projectVersionsHint,
      href: "/projects",
      icon: "version" as const
    },
    {
      label: t.dashboard.publishedSkills,
      value: overview.metrics.published_skills,
      detail: t.dashboard.publishedSkillsHint.replace("{count}", String(overview.metrics.skills)),
      href: "/skills",
      icon: "skill" as const
    },
    {
      label: t.dashboard.workflows,
      value: overview.metrics.workflows,
      detail: t.dashboard.workflowsHint,
      href: "/workflows",
      icon: "workflow" as const
    }
  ];
  const action = attention
    ? { title: t.dashboard.attentionTitle, hint: t.dashboard.attentionHint }
    : projects.length === 0
      ? { title: t.dashboard.connectProjectTitle, hint: t.dashboard.connectProjectHint }
      : overview.metrics.project_artifacts === 0
        ? { title: t.dashboard.addVersionTitle, hint: t.dashboard.addVersionHint }
        : { title: t.dashboard.platformReady, hint: t.dashboard.platformReadyHint };

  return (
    <section className="stack governance-page page-module-v2 dashboard-stack dashboard-v2">
      <header className="dashboard-hero">
        <div className="dashboard-hero-copy">
          <p className="eyebrow">{t.dashboard.eyebrow}</p>
          <div className="dashboard-heading"><h1>{t.dashboard.title}</h1><Status value={attention ? "attention" : "clear"} /></div>
          <p>{t.dashboard.subtitle}</p>
        </div>
        <div className="dashboard-freshness">
          <span>{t.dashboard.dataUpdated}</span>
          <strong>{new Date(overview.generated_at).toLocaleString(locale)}</strong>
          <small>{attention ? t.dashboard.statusAttentionSummary : t.dashboard.statusClearSummary}</small>
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

      <div className="dashboard-main-grid rise-in" style={{ animationDelay: "60ms" }}>
        <section className="panel dashboard-assets-panel">
          <div className="panel-title dashboard-panel-title">
            <div><p className="eyebrow">{t.dashboard.serverAssets}</p><h2>{t.dashboard.versionsAndCapabilities}</h2></div>
            <span>{t.dashboard.managedAssetsSummary}</span>
          </div>
          <div className="dashboard-assets-body">
            <div className="dashboard-artifact-total">
              <span>{t.dashboard.artifactPackages}</span>
              <strong>{overview.metrics.artifacts}</strong>
              <small>{t.dashboard.artifactTotalHint}</small>
            </div>
            <div className="dashboard-asset-composition">
              <div className="dashboard-asset-bar" aria-label={t.dashboard.assetComposition}>
                <span className="project" style={{ width: `${projectArtifactShare}%` }} />
                <span className="skill" style={{ width: `${skillArtifactShare}%` }} />
              </div>
              <div className="dashboard-asset-legend">
                <div><i className="project" /><span>{t.dashboard.projectArtifacts}</span><strong>{overview.metrics.project_artifacts}</strong></div>
                <div><i className="skill" /><span>{t.dashboard.skillArtifacts}</span><strong>{overview.metrics.skill_artifacts}</strong></div>
              </div>
              <div className="dashboard-capability-row">
                <Link href="/skills"><span>{t.dashboard.skillCoverage}</span><strong>{overview.metrics.published_skills}/{overview.metrics.skills}</strong><small>{t.dashboard.publishedCoverage}</small></Link>
                <Link href="/workflows"><span>{t.dashboard.workflowCoverage}</span><strong>{overview.metrics.workflows}</strong><small>{t.dashboard.workflowsHint}</small></Link>
              </div>
            </div>
          </div>
          <SkillComposition items={overview.distributions.skill_categories} />
        </section>
        <section className="panel dashboard-status-panel">
          <div className="panel-title dashboard-panel-title"><div><p className="eyebrow">{t.dashboard.platformHealth}</p><h2>{t.dashboard.serviceHealth}</h2></div><Status value={attention ? "attention" : "clear"} /></div>
          <div className="dashboard-status-summary">
            <div><span>{t.dashboard.servicesOnline}</span><strong>{healthyServices}/{overview.services.length}</strong><small>{serviceIssues.length === 0 ? t.dashboard.statusNormal : t.dashboard.statusIssue}</small></div>
            <div><span>{t.dashboard.coreChecks}</span><strong>{healthyChecks}/{coreHealth.length}</strong><small>{healthIssues.length === 0 ? t.dashboard.statusNormal : t.dashboard.statusIssue}</small></div>
            <div><span>{t.dashboard.projectVersionCoverage}</span><strong>{versionedProjects}/{overview.metrics.projects}</strong><small>{t.dashboard.remoteVersions}</small></div>
          </div>
          <div className="dashboard-service-list">
            {overview.services.map((service) => <div key={service.key}><span className={`service-dot ${service.status}`} aria-hidden="true" /><strong>{localizeDashboardLabel(service.label, lang)}</strong><Status value={service.status} /></div>)}
          </div>
        </section>
      </div>

      <div className="dashboard-work-grid rise-in" style={{ animationDelay: "120ms" }}>
        <section className="panel dashboard-work-panel dashboard-project-panel">
          <div className="panel-title dashboard-panel-title">
            <div><p className="eyebrow">{t.dashboard.projectsPanelEyebrow}</p><h2>{t.dashboard.recentProjects}</h2></div>
            <Link href="/projects">{t.dashboard.viewAll}</Link>
          </div>
          {projects.length === 0 ? <Empty>{t.dashboard.noProjects}</Empty> : <ul className="dashboard-project-list">
            {projects.slice(0, 4).map((project) => (
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
              <div><strong>{actionLabel(event.action, t)}</strong><p>{event.project_id === null ? t.dashboard.registryScope : projectNames.get(event.project_id) ?? t.dashboard.projectScope}</p></div>
              <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString(locale)}</time>
            </li>)}
          </ol>}
        </section>
      </div>

      <section className="dashboard-actions">
        <div>
          <p className="eyebrow">{t.dashboard.nextAction}</p>
          <strong>{action.title}</strong>
          <span>{action.hint}</span>
        </div>
        <div className="dashboard-action-links">
          <Link href="/projects">{t.dashboard.openRegistry}</Link>
          <Link href="/knowledge">{t.dashboard.browseKnowledge}</Link>
          <Link href="/workflows">{t.dashboard.maintainWorkflows}</Link>
          <Link href="/skills">{t.dashboard.browseSkills}</Link>
        </div>
      </section>
    </section>
  );
}

function localizeDashboardLabel(label: string, lang: "zh" | "en"): string {
  if (lang !== "zh") return label;
  const map: Record<string, string> = {
    "Review backlog": "待处理审核",
    "Review outcome": "审核结果",
    "Artifact traceability": "版本可追溯",
    "Audit evidence": "操作记录",
    "Governance API": "治理接口",
    "Project repository": "项目数据",
    "Skill registry": "技能库",
    "Audit log": "操作日志"
  };
  return map[label] ?? label;
}

// 把枚举值（role / kind / 分类 key 等）映射到当前语言文案，查不到时做可读化兜底
function statusLabel(value: string, t: ReturnType<typeof useI18n>["t"]): string {
  const labels = t.status as Record<string, string>;
  return labels[value] ?? labels[value.replaceAll("_", "-")] ?? value.replaceAll("_", " ");
}

// 活动流 action（如 skill.proposal.created）→ 当前语言文案
function actionLabel(action: string, t: ReturnType<typeof useI18n>["t"]): string {
  const map = t.dashboard.activityActions as Record<string, string>;
  return map[action] ?? action;
}

function DashboardIcon({ name }: { name: "projects" | "version" | "workflow" | "skill" | "activity" }) {
  const map: Record<typeof name, IconName> = {
    projects: "folder",
    version: "package",
    workflow: "workflow",
    skill: "sparkles",
    activity: "activity"
  };
  return <Icon name={map[name]} size={22} className="dashboard-icon" />;
}

function SkillComposition({ items }: { items: DashboardOverview["distributions"]["skill_categories"] }) {
  const { t } = useI18n();
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const palette = ["var(--accent)", "var(--skill)", "var(--success)", "var(--review)"];
  return <div className="dashboard-skill-composition">
    <span>{t.dashboard.skillCategories}</span>
    {total === 0 ? <small>{t.dashboard.noSkillCategories}</small> : <>
      <div className="dashboard-composition-bar" aria-label={t.dashboard.skillCategories}>
        {items.map((item, index) => <i key={item.key} style={{ width: `${(item.count / total) * 100}%`, background: palette[index % palette.length] }} />)}
      </div>
      <div className="dashboard-composition-legend">
        {items.slice(0, 4).map((item, index) => <span key={item.key}><i style={{ background: palette[index % palette.length] }} />{statusLabel(item.key, t)} <b>{item.count}</b></span>)}
      </div>
    </>}
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
