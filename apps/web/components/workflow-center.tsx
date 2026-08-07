"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  WorkflowFamily,
  WorkflowFamilyVersion
} from "@hunter-harness/contracts";

import { browserApi, type HunterApi } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { apiError, required, Status } from "./skill-shared";
import { EmptyState } from "./ui/EmptyState";
import { Icon } from "./ui/icons";

function resolveApi(): HunterApi {
  return process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi();
}

/**
 * 工作流目录（只读展示 + 更新）：展示 registry 中已发布的工作流族与版本。
 * 创建 / 上传 / 发布由 harness 管线完成；「检查更新」触发来源同步（npm / GitHub），
 * 端点落地前为占位行为，见 docs/platform-server-gaps.md。
 */
export function WorkflowCenter({ api: apiValue }: { api?: HunterApi }) {
  const { lang, t } = useI18n();
  const api = useMemo(() => apiValue ?? resolveApi(), [apiValue]);
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const copy = lang === "zh" ? {
    sync: "检查更新",
    syncing: "检查中…",
    syncUpToDate: "已是最新版本。",
    syncPending: "同步端点尚未落地；npm / GitHub 关联后可自动检查新版本。",
    tags: "标签",
    updatedAt: "更新于",
    createdAt: "创建于",
    latestChange: "最新变更",
    versions: "个版本"
  } : {
    sync: "Check updates",
    syncing: "Checking…",
    syncUpToDate: "Already up to date.",
    syncPending: "Sync endpoint not available yet; new versions are detected once npm / GitHub association lands.",
    tags: "Tags",
    updatedAt: "Updated",
    createdAt: "Created",
    latestChange: "Latest change",
    versions: "versions"
  };
  const [families, setFamilies] = useState<WorkflowFamily[] | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [versions, setVersions] = useState<WorkflowFamilyVersion[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const selected = families?.find((family) => family.slug === selectedSlug) ?? null;
  const latestNpmRelease = selected?.npmReleases.find((entry) => entry.version === selected.latest_version) ?? null;

  async function refreshFamilies(): Promise<void> {
    try {
      const items = await required(api, "listWorkflowFamilies")();
      setFamilies(items);
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  async function loadFamilyDetail(slug: string): Promise<void> {
    setSelectedSlug(slug);
    setVersions([]);
    setSyncMessage(null);
    setLoadingDetail(true);
    try {
      const vers = await required(api, "listWorkflowFamilyVersions")(slug);
      setVersions(vers);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setLoadingDetail(false);
    }
  }

  async function syncFamily(): Promise<void> {
    if (selectedSlug === null || syncing) return;
    setSyncing(true);
    setSyncMessage(null);
    try {
      if (api.syncWorkflowFamily === undefined) {
        // 端点未落地：占位反馈（模拟检查耗时）
        await new Promise((resolve) => setTimeout(resolve, 700));
        setSyncMessage(copy.syncPending);
        return;
      }
      const result = await api.syncWorkflowFamily(selectedSlug);
      setSyncMessage(result.updated ? copy.syncUpToDate : copy.syncUpToDate);
      await refreshFamilies();
      await loadFamilyDetail(selectedSlug);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => { void refreshFamilies(); }, [api]);

  const needle = query.trim().toLowerCase();
  const filtered = (families ?? []).filter((family) =>
    needle === "" || `${family.displayName} ${family.slug} ${family.description}`.toLowerCase().includes(needle)
  );

  return (
    <section className="stack governance-page page-module-v2">
      <header className="project-registry-hero">
        <div>
          <p className="eyebrow">{t.workflows.eyebrow}</p>
          <h1>{t.workflows.familyTitle}</h1>
          <p>{t.workflows.familyDescription}</p>
        </div>
      </header>

      <div className="workflow-list-toolbar">
        <label className="search-wide">
          <Icon name="search" size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.workflows.searchPlaceholder} />
        </label>
        <span className="muted-stat">{filtered.length} / {families?.length ?? 0}</span>
      </div>

      <div className="workflow-workbench">
        <div className="panel workflow-index">
          <div className="panel-title"><h2>{t.workflows.families}</h2><span>{filtered.length}</span></div>
          {families === null ? <div className="skeleton-block" /> : filtered.length === 0 ? (
            <EmptyState icon="workflow" title={t.workflows.noFamilies} />
          ) : filtered.map((family) => (
            <button
              type="button"
              className={family.slug === selectedSlug ? "selected" : ""}
              key={family.family_id}
              onClick={() => void loadFamilyDetail(family.slug)}
            >
              <strong>{family.displayName}</strong>
              <span><code>{family.slug}</code> · {family.required_profiles.join(", ")}</span>
              <span className="workflow-index-version">
                {family.latest_version === null ? t.workflows.unpublished : `v${family.latest_version}`}
                {" · "}{copy.updatedAt} {new Date(family.updated_at).toLocaleDateString(locale)}
              </span>
              <Status value={family.latest_version === null ? "draft" : "published"} />
            </button>
          ))}
        </div>

        {selected === null ? (
          <div className="panel workflow-editor"><EmptyState icon="workflow" title={t.workflows.selectFamily} /></div>
        ) : (
          <div className="panel workflow-editor">
            <div className="workflow-detail-head">
              <div className="workflow-detail-title">
                <h2>{selected.displayName}</h2>
                <code>{selected.slug}</code>
              </div>
              <div className="workflow-detail-badges">
                {selected.latest_version === null ? (
                  <span className="meta-pill">{t.workflows.unpublished}</span>
                ) : (
                  <span className="workflow-version-badge">v{selected.latest_version}</span>
                )}
                {latestNpmRelease === null ? null : (
                  <span className="meta-pill">
                    {latestNpmRelease.status === "published"
                      ? `${t.workflows.npmBadgePublished} v${latestNpmRelease.version}`
                      : latestNpmRelease.status === "failed"
                        ? t.workflows.npmBadgeFailed
                        : t.workflows.npmBadgeConflict}
                  </span>
                )}
                <button
                  type="button"
                  className="secondary workflow-sync-btn"
                  disabled={syncing}
                  title={copy.syncPending}
                  onClick={() => void syncFamily()}
                >
                  <Icon name="refresh" size={13} />
                  {syncing ? copy.syncing : copy.sync}
                </button>
              </div>
            </div>

            <p className="workflow-detail-desc">{selected.description}</p>

            <div className="workflow-detail-meta">
              <span>{t.workflows.requiredProfiles}: <strong>{selected.required_profiles.join(", ")}</strong></span>
              {selected.tags.length === 0 ? null : <span>{copy.tags}: <strong>{selected.tags.join(", ")}</strong></span>}
              <span>{copy.updatedAt} <strong>{new Date(selected.updated_at).toLocaleDateString(locale)}</strong></span>
              <span>{copy.createdAt} <strong>{new Date(selected.created_at).toLocaleDateString(locale)}</strong></span>
            </div>

            {syncMessage === null ? null : <div className="notice">{syncMessage}</div>}

            {loadingDetail ? <div className="skeleton-block" /> : versions.length === 0 ? null : (
              <div className="workflow-versions">
                <div className="panel-title">
                  <h3>{t.workflows.versionHistory}</h3>
                  <span>{versions.length} {copy.versions}</span>
                </div>
                {versions[0]?.changeNote ? (
                  <p className="workflow-latest-note">
                    {copy.latestChange}: <strong>v{versions[0].version}</strong> — {versions[0].changeNote}
                  </p>
                ) : null}
                <ol className="workflow-version-list">
                  {versions.map((version, index) => (
                    <li key={version.version} className={index === 0 ? "latest" : ""}>
                      <strong>{version.version}</strong>
                      <span className="workflow-version-profiles">{version.profiles.map((item) => item.profile).join(", ")}</span>
                      <span className="workflow-version-note">{version.changeNote ?? t.workflows.changeNoteNone}</span>
                      <time dateTime={version.created_at}>{new Date(version.created_at).toLocaleString(locale)}</time>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
      </div>

      {error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}
