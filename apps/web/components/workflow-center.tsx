"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  WorkflowFamilyDraftSummary,
  WorkflowFamily,
  WorkflowFamilySource,
  WorkflowFamilySourceInspection,
  WorkflowFamilyVersionSummary
} from "@hunter-harness/contracts";

import { ApiClientError, browserApi, type HunterApi } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { apiError, required, Status } from "./skill-shared";
import { EmptyState } from "./ui/EmptyState";
import { Icon } from "./ui/icons";
import { Modal } from "./ui/Modal";
import { ToastFeedback, useToast } from "./ui/Toast";

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
  const toast = useToast();
  const api = useMemo(() => apiValue ?? resolveApi(), [apiValue]);
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const copy = lang === "zh" ? {
    sync: "检查更新",
    syncing: "检查中…",
    syncUpToDate: "已是最新版本。",
    syncUpdated: "已拉取 {version} 为草稿，可检查后发布。",
    syncPending: "当前客户端不支持来源同步。",
    syncHint: "从已关联的 npm 或 GitHub 来源检查新版本。",
    tags: "标签",
    updatedAt: "更新于",
    createdAt: "创建于",
    latestChange: "最新变更",
    versions: "个版本",
    importWorkflow: "导入工作流",
    importTitle: "从来源导入工作流",
    importIntro: "先读取来源清单与 profile，再创建可检查、可发布的工作流草稿。",
    sourceType: "来源类型",
    sourceReference: "来源标识",
    inspectSource: "预检来源",
    inspecting: "预检中…",
    detected: "已识别来源",
    manifest: "工作流清单",
    detectedYes: "已识别",
    detectedNo: "未识别",
    remoteVersion: "来源版本",
    profiles: "Profiles",
    fileCount: "个文件",
    slug: "工作流标识",
    displayName: "显示名称",
    descriptionField: "描述",
    tagsField: "标签",
    createDraft: "创建草稿",
    creatingDraft: "创建中…",
    cancel: "取消",
    importSuccess: "工作流已导入为草稿，可继续检查并发布。",
    draftTitle: "待发布草稿",
    draftHint: "确认导入的 profile 完整性，通过检查后发布为 registry 版本。",
    runChecks: "运行检查",
    checking: "检查中…",
    checksPending: "尚未运行检查",
    checksPassed: "通过",
    checksWarning: "警告",
    checksBlocked: "阻断",
    releaseVersion: "发布版本号",
    releaseNote: "变更说明",
    publishVersion: "发布版本",
    publishing: "发布中…",
    publishSuccess: "工作流版本 {version} 已发布。"
  } : {
    sync: "Check updates",
    syncing: "Checking…",
    syncUpToDate: "Already up to date.",
    syncUpdated: "Pulled {version} as a draft; review and publish when ready.",
    syncPending: "Source sync is unavailable in this client.",
    syncHint: "Check the linked npm or GitHub source for a newer version.",
    tags: "Tags",
    updatedAt: "Updated",
    createdAt: "Created",
    latestChange: "Latest change",
    versions: "versions",
    importWorkflow: "Import workflow",
    importTitle: "Import workflow from source",
    importIntro: "Inspect the source manifest and profiles before creating a reviewable workflow draft.",
    sourceType: "Source type",
    sourceReference: "Source reference",
    inspectSource: "Inspect source",
    inspecting: "Inspecting…",
    detected: "Source detected",
    manifest: "Workflow manifest",
    detectedYes: "Detected",
    detectedNo: "Not detected",
    remoteVersion: "Source version",
    profiles: "Profiles",
    fileCount: "files",
    slug: "Workflow slug",
    displayName: "Display name",
    descriptionField: "Description",
    tagsField: "Tags",
    createDraft: "Create draft",
    creatingDraft: "Creating…",
    cancel: "Cancel",
    importSuccess: "Workflow imported as a draft. It is ready for checks and publishing.",
    draftTitle: "Pending draft",
    draftHint: "Review imported profiles, run checks, then publish a registry version.",
    runChecks: "Run checks",
    checking: "Checking…",
    checksPending: "Checks have not run",
    checksPassed: "passed",
    checksWarning: "warnings",
    checksBlocked: "blocked",
    releaseVersion: "Release version",
    releaseNote: "Release note",
    publishVersion: "Publish version",
    publishing: "Publishing…",
    publishSuccess: "Workflow version {version} published."
  };
  const [families, setFamilies] = useState<WorkflowFamily[] | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [versions, setVersions] = useState<WorkflowFamilyVersionSummary[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importSource, setImportSource] = useState<WorkflowFamilySource>({ type: "npm", ref: "" });
  const [inspection, setInspection] = useState<WorkflowFamilySourceInspection | null>(null);
  const [importSlug, setImportSlug] = useState("");
  const [importDisplayName, setImportDisplayName] = useState("");
  const [importDescription, setImportDescription] = useState("");
  const [importTags, setImportTags] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [draft, setDraft] = useState<WorkflowFamilyDraftSummary | null>(null);
  const [checkingDraft, setCheckingDraft] = useState(false);
  const [publishingDraft, setPublishingDraft] = useState(false);
  const [publishVersion, setPublishVersion] = useState("");
  const [publishNote, setPublishNote] = useState("");
  const detailRequest = useRef(0);
  const familyListRequest = useRef(0);
  const inspectionRequest = useRef(0);

  const selected = families?.find((family) => family.slug === selectedSlug) ?? null;
  const latestNpmRelease = selected?.npmReleases.find((entry) => entry.version === selected.latest_version) ?? null;

  async function refreshFamilies(): Promise<void> {
    const requestId = ++familyListRequest.current;
    try {
      const items = await required(api, "listWorkflowFamilies")();
      if (requestId !== familyListRequest.current) return;
      setFamilies(items);
      setError(null);
    } catch (reason) {
      if (requestId === familyListRequest.current) setError(apiError(reason, t));
    }
  }

  async function loadFamilyDetail(
    slug: string,
    options: { preserveSyncMessage?: boolean } = {}
  ): Promise<void> {
    const requestId = ++detailRequest.current;
    setSelectedSlug(slug);
    setVersions([]);
    setDraft(null);
    setPublishVersion("");
    setPublishNote("");
    if (options.preserveSyncMessage !== true) setSyncMessage(null);
    setSyncing(false);
    setCheckingDraft(false);
    setPublishingDraft(false);
    setLoadingDetail(true);
    try {
      const vers = await required(api, "listWorkflowFamilyVersions")(slug);
      if (requestId !== detailRequest.current) return;
      setVersions(vers);
      if (api.getWorkflowFamilyDraft !== undefined) {
        try {
          const loadedDraft = await api.getWorkflowFamilyDraft(slug);
          if (requestId !== detailRequest.current) return;
          setDraft(loadedDraft);
          setPublishVersion(loadedDraft.draftVersion ?? "");
          setPublishNote(loadedDraft.releaseNote ?? "");
        } catch (reason) {
          if (requestId !== detailRequest.current) return;
          const notFound = reason instanceof ApiClientError
            ? reason.status === 404
            : typeof reason === "object" && reason !== null && "status" in reason && reason.status === 404;
          if (!notFound) throw reason;
        }
      }
    } catch (reason) {
      if (requestId === detailRequest.current) setError(apiError(reason, t));
    } finally {
      if (requestId === detailRequest.current) setLoadingDetail(false);
    }
  }

  async function syncFamily(): Promise<void> {
    if (selectedSlug === null || syncing) return;
    const slug = selectedSlug;
    const requestId = detailRequest.current;
    setSyncing(true);
    setSyncMessage(null);
    try {
      if (api.syncWorkflowFamily === undefined) {
        // 端点未落地：占位反馈（模拟检查耗时）
        await new Promise((resolve) => setTimeout(resolve, 700));
        if (requestId !== detailRequest.current) return;
        setSyncMessage(copy.syncPending);
        return;
      }
      const result = await api.syncWorkflowFamily(slug);
      if (requestId !== detailRequest.current) return;
      setSyncMessage(
        result.updated
          ? (copy.syncUpdated ?? copy.syncUpToDate).replace("{version}", result.version ?? "")
          : copy.syncUpToDate
      );
      await refreshFamilies();
      if (requestId !== detailRequest.current) return;
      await loadFamilyDetail(slug, { preserveSyncMessage: true });
    } catch (reason) {
      if (requestId === detailRequest.current) setError(apiError(reason, t));
    } finally {
      if (requestId === detailRequest.current) setSyncing(false);
    }
  }

  function resetImport(): void {
    inspectionRequest.current += 1;
    setImportSource({ type: "npm", ref: "" });
    setInspection(null);
    setImportSlug("");
    setImportDisplayName("");
    setImportDescription("");
    setImportTags("");
    setInspecting(false);
  }

  function updateImportSource(source: WorkflowFamilySource): void {
    inspectionRequest.current += 1;
    setImportSource(source);
    setInspection(null);
    setInspecting(false);
  }

  function closeImport(): void {
    inspectionRequest.current += 1;
    setInspecting(false);
    setImportOpen(false);
  }

  async function inspectSource(): Promise<void> {
    if (inspecting || importSource.ref.trim() === "") return;
    const requestId = ++inspectionRequest.current;
    const source = { type: importSource.type, ref: importSource.ref.trim() } satisfies WorkflowFamilySource;
    setInspecting(true);
    setInspection(null);
    setError(null);
    try {
      const result = await required(api, "inspectWorkflowFamilySource")(source);
      if (requestId !== inspectionRequest.current) return;
      setInspection(result);
      setImportSlug(result.suggested.slug);
      setImportDisplayName(result.suggested.displayName);
      setImportDescription(result.suggested.description);
      setImportTags(result.suggested.tags.join(", "));
    } catch (reason) {
      if (requestId === inspectionRequest.current) setError(apiError(reason, t));
    } finally {
      if (requestId === inspectionRequest.current) setInspecting(false);
    }
  }

  async function createImportedDraft(): Promise<void> {
    if (inspection === null || importing) return;
    setImporting(true);
    setError(null);
    try {
      const result = await required(api, "importWorkflowFamilySource")({
        source: inspection.source,
        source_digest: inspection.source_digest,
        slug: importSlug.trim(),
        displayName: importDisplayName.trim(),
        description: importDescription.trim(),
        tags: importTags.split(",").map((item) => item.trim()).filter(Boolean)
      });
      detailRequest.current += 1;
      familyListRequest.current += 1;
      setFamilies((current) => [
        result.family,
        ...(current ?? []).filter((item) => item.slug !== result.family.slug)
      ]);
      setSelectedSlug(result.family.slug);
      setVersions([]);
      setDraft(result.draft);
      setLoadingDetail(false);
      setSyncing(false);
      setCheckingDraft(false);
      setPublishingDraft(false);
      setPublishVersion(result.draft.draftVersion ?? result.inspection.remote_version ?? "");
      setPublishNote(result.draft.releaseNote ?? "");
      setImportOpen(false);
      resetImport();
      toast.success(copy.importSuccess);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setImporting(false);
    }
  }

  async function runDraftChecks(): Promise<void> {
    if (selectedSlug === null || draft === null || draft.family_slug !== selectedSlug || checkingDraft) return;
    const slug = draft.family_slug;
    const requestId = detailRequest.current;
    setCheckingDraft(true);
    try {
      const checks = await required(api, "runWorkflowFamilyDraftChecks")(slug);
      if (requestId !== detailRequest.current) return;
      setDraft((current) => current === null ? null : { ...current, checks });
    } catch (reason) {
      if (requestId === detailRequest.current) setError(apiError(reason, t));
    } finally {
      if (requestId === detailRequest.current) setCheckingDraft(false);
    }
  }

  async function publishDraft(): Promise<void> {
    if (selectedSlug === null || draft === null || draft.family_slug !== selectedSlug || publishingDraft || publishVersion.trim() === "") return;
    const slug = draft.family_slug;
    const requestId = detailRequest.current;
    setPublishingDraft(true);
    try {
      const version = await required(api, "publishWorkflowFamilyDraft")(slug, {
        version: publishVersion.trim(),
        releaseNote: publishNote.trim() || undefined
      });
      if (requestId !== detailRequest.current) return;
      setVersions((current) => [version, ...current.filter((item) => item.version !== version.version)]);
      setFamilies((current) => (current ?? []).map((family) => family.slug === slug ? {
        ...family,
        latest_version: version.version,
        revision: family.revision + 1,
        updated_at: version.created_at
      } : family));
      setDraft(null);
      toast.success(copy.publishSuccess.replace("{version}", version.version));
    } catch (reason) {
      if (requestId === detailRequest.current) setError(apiError(reason, t));
    } finally {
      if (requestId === detailRequest.current) setPublishingDraft(false);
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
        <button type="button" className="primary workflow-import-button" onClick={() => setImportOpen(true)}>
          <Icon name="plus" size={15} />
          {copy.importWorkflow}
        </button>
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
                  title={copy.syncHint}
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

            <ToastFeedback tone="info" message={syncMessage} />

            {draft === null ? null : (
              <section className="workflow-draft-console" data-slot="workflow-draft-console">
                <header>
                  <div>
                    <span className="eyebrow">Draft</span>
                    <h3>{copy.draftTitle} <code>{draft.draftVersion ?? "—"}</code></h3>
                    <p>{copy.draftHint}</p>
                  </div>
                  <button type="button" className="secondary" disabled={checkingDraft} onClick={() => void runDraftChecks()}>
                    <Icon name={checkingDraft ? "loading" : "shield"} size={14} />
                    {checkingDraft ? copy.checking : copy.runChecks}
                  </button>
                </header>

                <div className="workflow-draft-profiles">
                  {draft.required_profiles.map((profile) => {
                    const bundle = draft.profiles.find((item) => item.profile === profile);
                    return (
                      <span className={bundle === undefined ? "missing" : "ready"} key={profile}>
                        <Icon name={bundle === undefined ? "warning" : "workflow"} size={13} />
                        <strong>{profile}</strong>
                        <small>{bundle?.file_count ?? 0} {copy.fileCount}</small>
                      </span>
                    );
                  })}
                </div>

                {draft.checks === null ? (
                  <div className="workflow-check-summary pending"><Icon name="info" size={14} /> {copy.checksPending}</div>
                ) : (
                  <div className="workflow-check-summary">
                    <span className="passed">{draft.checks.summary.green} {copy.checksPassed}</span>
                    <span className="warning">{draft.checks.summary.yellow} {copy.checksWarning}</span>
                    <span className="blocked">{draft.checks.summary.red} {copy.checksBlocked}</span>
                  </div>
                )}

                <div className="workflow-publish-row">
                  <label>
                    <span>{copy.releaseVersion}</span>
                    <input aria-label={copy.releaseVersion} value={publishVersion} onChange={(event) => setPublishVersion(event.target.value)} placeholder="0.1.0" />
                  </label>
                  <label>
                    <span>{copy.releaseNote}</span>
                    <input aria-label={copy.releaseNote} value={publishNote} onChange={(event) => setPublishNote(event.target.value)} placeholder={copy.releaseNote} />
                  </label>
                  <button
                    type="button"
                    className="primary"
                    disabled={publishingDraft || draft.checks === null || draft.checks.summary.red > 0 || publishVersion.trim() === ""}
                    onClick={() => void publishDraft()}
                  >
                    <Icon name={publishingDraft ? "loading" : "upload"} size={14} />
                    {publishingDraft ? copy.publishing : copy.publishVersion}
                  </button>
                </div>
              </section>
            )}

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

      <Modal
        open={importOpen}
        onClose={closeImport}
        title={copy.importTitle}
        closeLabel={lang === "zh" ? "关闭" : "Close"}
        wide
        footer={(
          <>
            <button type="button" className="secondary" onClick={closeImport}>{copy.cancel}</button>
            {inspection === null ? null : (
              <button type="button" className="primary" disabled={!inspection.ready || importing} onClick={() => void createImportedDraft()}>
                {importing ? copy.creatingDraft : copy.createDraft}
              </button>
            )}
          </>
        )}
      >
        <div className="workflow-import-flow" data-slot="workflow-source-import">
          <p className="workflow-import-intro">{copy.importIntro}</p>
          <div className="workflow-import-source">
            <label>
              <span>{copy.sourceType}</span>
              <select
                aria-label="Workflow source type"
                value={importSource.type}
                disabled={importing}
                onChange={(event) => {
                  updateImportSource({ type: event.target.value as WorkflowFamilySource["type"], ref: importSource.ref });
                }}
              >
                <option value="npm">npm</option>
                <option value="github">GitHub</option>
              </select>
            </label>
            <label className="workflow-source-ref">
              <span>{copy.sourceReference}</span>
              <input
                aria-label="Source reference"
                value={importSource.ref}
                disabled={importing}
                onChange={(event) => {
                  updateImportSource({ ...importSource, ref: event.target.value });
                }}
                placeholder={importSource.type === "npm" ? "@hunter-harness/workflow-harness" : "https://github.com/org/repo/tree/main/packages/workflow"}
              />
            </label>
            <button type="button" className="secondary workflow-inspect-button" disabled={inspecting || importSource.ref.trim() === ""} onClick={() => void inspectSource()}>
              <Icon name={inspecting ? "loading" : "search"} size={14} />
              {inspecting ? copy.inspecting : copy.inspectSource}
            </button>
          </div>

          {inspection === null ? null : (
            <div className="workflow-inspection">
              <div className="workflow-inspection-summary">
                <div><span>{copy.manifest}</span><strong>{inspection.manifest_detected ? copy.detectedYes : copy.detectedNo}</strong></div>
                <div><span>{copy.remoteVersion}</span><strong>{inspection.remote_version ?? "—"}</strong></div>
                <div><span>{copy.profiles}</span><strong>{inspection.profiles.length}</strong></div>
              </div>
              <div className="workflow-profile-preview">
                {inspection.profiles.map((profile) => (
                  <span key={profile.profile}><Icon name="workflow" size={13} /><strong>{profile.profile}</strong><small>{profile.file_count} {copy.fileCount}</small></span>
                ))}
              </div>
              {inspection.warnings.length === 0 ? null : (
                <ul className="workflow-import-warnings">{inspection.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              )}
              <div className="workflow-import-metadata">
                <label><span>{copy.slug}</span><input value={importSlug} onChange={(event) => setImportSlug(event.target.value)} /></label>
                <label><span>{copy.displayName}</span><input value={importDisplayName} onChange={(event) => setImportDisplayName(event.target.value)} /></label>
                <label className="span-2"><span>{copy.descriptionField}</span><textarea rows={3} value={importDescription} onChange={(event) => setImportDescription(event.target.value)} /></label>
                <label className="span-2"><span>{copy.tagsField}</span><input value={importTags} onChange={(event) => setImportTags(event.target.value)} /></label>
              </div>
            </div>
          )}
        </div>
      </Modal>

      <ToastFeedback tone="danger" message={error} />
    </section>
  );
}
