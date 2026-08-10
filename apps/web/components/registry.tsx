"use client";

import type {
  DraftState,
  ExternalSkill,
  RegistryAgent,
  RegistrySkillDetail,
  RegistrySkillVersion,
  RegistryTag,
  SkillCatalogOrder
} from "@hunter-harness/contracts";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";

import { browserApi, type HunterApi } from "../lib/api";
import type { DemoAgent } from "../lib/demo-skills/types";
import { findDemoSourceSkill } from "../lib/demo-skills/sap-field-mapper";
import { externalSkillDescription, externalSkillDisplayName, externalSkillSourceName } from "../lib/external-skill-view";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { DemoSystemConfig } from "./demo-system-config";
import { SkillUploadPanel } from "./skill-upload-panel";
import {
  AgentCheckPanel,
  AgentConfigsOverview,
  AgentContextSelector,
  ContractSecurityOverview,
  SkillConfigOverview,
  VersionHistoryPanel
} from "./skill-detail-panels";
import {
  Empty,
  FilePreview,
  SourceFileTree,
  Status,
  UsageExamples,
  agentLabel,
  apiError,
  detailAgents,
  displayValue,
  parseSkillFrontmatter,
  required
} from "./skill-shared";
import { EmptyState } from "./ui/EmptyState";
import { Icon } from "./ui/icons";
import { Modal } from "./ui/Modal";
import { PageHeader } from "./ui/PageHeader";
import { Pagination } from "./ui/Pagination";
import { Skeleton } from "./ui/Skeleton";
import { Spinner } from "./ui/Spinner";

function useApi(value?: HunterApi): HunterApi {
  return useMemo(() => value ?? (
    process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi()
  ), [value]);
}

function skillStatusGroup(status: RegistrySkillDetail["status"]): "published" | "unpublished" {
  return status === "published" ? "published" : "unpublished";
}

function skillStatusLabel(status: RegistrySkillDetail["status"], t: ReturnType<typeof useI18n>["t"]["skills"]): string {
  return skillStatusGroup(status) === "published" ? t.statusPublished : t.statusUnpublished;
}

type SkillDetailTab = "source" | "examples" | "definition" | "checks" | "versions" | "governance";

export function SkillRegistry({ api: apiValue }: { api?: HunterApi }) {
  const { t } = useI18n();
  const api = useApi(apiValue);
  const [skills, setSkills] = useState<RegistrySkillDetail[] | null>(null);
  const [externalSkills, setExternalSkills] = useState<ExternalSkill[]>([]);
  const [tags, setTags] = useState<RegistryTag[]>([]);
  const [catalogOrder, setCatalogOrder] = useState<SkillCatalogOrder>({ items: [], revision: 0, updated_at: null });
  const [draggedCatalogKey, setDraggedCatalogKey] = useState<string | null>(null);
  const [dragOverCatalogKey, setDragOverCatalogKey] = useState<string | null>(null);
  const [orderSaving, setOrderSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [agent, setAgent] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"" | "registry" | "external" | "npm" | "github">("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [status, setStatus] = useState<"" | "published" | "unpublished">("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deleteModal, setDeleteModal] = useState<RegistrySkillDetail | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importRef, setImportRef] = useState("");
  const [importNote, setImportNote] = useState("");
  const [importing, setImporting] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const [nextSkills, nextTags, nextExternal, nextOrder] = await Promise.all([
        required(api, "listSkills")(),
        required(api, "listTags")(),
        api.listExternalSkills === undefined ? Promise.resolve([]) : required(api, "listExternalSkills")(),
        api.getSkillCatalogOrder === undefined
          ? Promise.resolve({ items: [], revision: 0, updated_at: null } satisfies SkillCatalogOrder)
          : required(api, "getSkillCatalogOrder")()
      ]);
      setSkills(nextSkills);
      setTags(nextTags);
      setExternalSkills(nextExternal);
      setCatalogOrder(nextOrder);
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  useEffect(() => { void refresh(); }, [api]);
  useEffect(() => { setPage(1); }, [search, agent, status, selectedTags, sourceFilter]);

  const activeTags = tags.filter((tag) => tag.active);
  const tagLabelBySlug = new Map(tags.map((tag) => [tag.slug, tag.label]));
  type MixedItem =
    | { kind: "registry"; skill: RegistrySkillDetail; sortKey: string; catalogKey: string }
    | { kind: "external"; skill: ExternalSkill; sortKey: string; catalogKey: string };

  const catalogOrderIndex = new Map(catalogOrder.items.map((key, index) => [key, index]));
  const mixed: MixedItem[] = [
    ...(skills ?? []).map((skill) => ({
      kind: "registry" as const,
      skill,
      sortKey: skill.name.toLowerCase(),
      catalogKey: `registry:${skill.slug}`
    })),
    ...externalSkills.map((skill) => ({
      kind: "external" as const,
      skill,
      sortKey: externalSkillDisplayName(skill).toLowerCase(),
      catalogKey: `external:${skill.id}`
    }))
  ].sort((left, right) => {
    const leftOrder = catalogOrderIndex.get(left.catalogKey);
    const rightOrder = catalogOrderIndex.get(right.catalogKey);
    if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
    if (leftOrder !== undefined) return -1;
    if (rightOrder !== undefined) return 1;
    return left.sortKey.localeCompare(right.sortKey);
  });

  const filtered = mixed.filter((item) => {
    const needle = search.trim().toLowerCase();
    if (item.kind === "registry") {
      if (sourceFilter === "external" || sourceFilter === "npm" || sourceFilter === "github") return false;
      const skill = item.skill;
      return (needle === "" || `${skill.name} ${skill.slug} ${skill.description}`.toLowerCase().includes(needle)) &&
        (selectedTags.length === 0 || selectedTags.every((tag) => skill.tags.includes(tag))) &&
        (agent === "" || skill.agents.some((a) => a.agent === agent)) &&
        (status === "" || skillStatusGroup(skill.status) === status);
    }
    if (sourceFilter === "registry") return false;
    if (sourceFilter === "npm" && item.skill.source.type !== "npm") return false;
    if (sourceFilter === "github" && item.skill.source.type !== "github") return false;
    if (sourceFilter === "" && (agent !== "" || status !== "")) return false;
    const skill = item.skill;
    return (needle === "" || `${skill.snapshot.name} ${skill.source.ref} ${externalSkillDescription(skill)} ${skill.snapshot.description} ${skill.curationNote}`.toLowerCase().includes(needle)) &&
      (selectedTags.length === 0 || selectedTags.every((tag) => skill.tags.includes(tag)));
  });
  const pageSize = 12;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const publishedCount = (skills ?? []).filter((skill) => skill.status === "published").length;
  const unpublishedCount = (skills ?? []).length - publishedCount;
  const configuredAgentCount = new Set((skills ?? []).flatMap((skill) => skill.agents.map((a) => a.agent))).size;

  function toggleTag(slug: string): void {
    setSelectedTags((current) => current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug]);
  }

  async function moveCatalogItem(sourceKey: string, targetKey: string): Promise<void> {
    if (sourceKey === targetKey || orderSaving) return;
    const visibleKeys = pageItems.map((item) => item.catalogKey);
    const sourceIndex = visibleKeys.indexOf(sourceKey);
    const targetIndex = visibleKeys.indexOf(targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const reorderedVisible = [...visibleKeys];
    const [moved] = reorderedVisible.splice(sourceIndex, 1);
    if (moved === undefined) return;
    reorderedVisible.splice(targetIndex, 0, moved);
    const visibleSet = new Set(visibleKeys);
    let visibleIndex = 0;
    const nextItems = mixed.map((item) => visibleSet.has(item.catalogKey)
      ? reorderedVisible[visibleIndex++] ?? item.catalogKey
      : item.catalogKey);
    const previous = catalogOrder;
    setCatalogOrder({ ...previous, items: nextItems });
    setOrderSaving(true);
    setError(null);
    try {
      const saved = await required(api, "updateSkillCatalogOrder")({
        items: nextItems,
        revision: previous.revision
      });
      setCatalogOrder(saved);
      setMessage(t.skills.skillOrderSaved);
    } catch (reason) {
      setCatalogOrder(previous);
      const message = apiError(reason, t);
      await refresh();
      setError(message);
    } finally {
      setOrderSaving(false);
      setDraggedCatalogKey(null);
      setDragOverCatalogKey(null);
    }
  }

  function beginCatalogDrag(event: DragEvent<HTMLButtonElement>, catalogKey: string): void {
    setDraggedCatalogKey(catalogKey);
    setDragOverCatalogKey(null);
    event.dataTransfer?.setData("text/plain", catalogKey);
    if (event.dataTransfer !== undefined) event.dataTransfer.effectAllowed = "move";
  }

  function dropCatalogItem(event: DragEvent<HTMLElement>, targetKey: string): void {
    event.preventDefault();
    const sourceKey = draggedCatalogKey ?? event.dataTransfer?.getData("text/plain") ?? "";
    void moveCatalogItem(sourceKey, targetKey);
  }

  function moveCatalogItemByKeyboard(event: KeyboardEvent<HTMLButtonElement>, catalogKey: string): void {
    const direction = event.key === "ArrowLeft" || event.key === "ArrowUp"
      ? -1
      : event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : 0;
    if (direction === 0) return;
    const visibleKeys = pageItems.map((item) => item.catalogKey);
    const index = visibleKeys.indexOf(catalogKey);
    const targetKey = visibleKeys[index + direction];
    if (targetKey === undefined) return;
    event.preventDefault();
    void moveCatalogItem(catalogKey, targetKey);
  }

  async function submitImport(): Promise<void> {
    const raw = importRef.trim();
    if (raw.length === 0 || importing) return;
    setImporting(true);
    try {
      const type = raw.includes("github.com") || /^[^/\s]+\/[^/\s]+$/.test(raw) ? "github" : "npm";
      const created = await required(api, "createExternalSkill")({
        source: { type, ref: raw },
        curationNote: importNote,
        tags: []
      });
      await refresh();
      setMessage(t.skills.importedExternal.replace("{name}", created.snapshot.name));
      setImportOpen(false);
      setImportRef("");
      setImportNote("");
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setImporting(false);
    }
  }

  function deleteSkill(skill: RegistrySkillDetail): void {
    setDeleteModal(skill);
  }

  async function confirmDelete(): Promise<void> {
    if (deleteModal === null) return;
    try {
      await required(api, "deleteSkill")(deleteModal.slug);
      await refresh();
      setMessage(t.skills.deletedSkill.replace("{name}", deleteModal.name));
      setDeleteModal(null);
    } catch (reason) { setError(apiError(reason, t)); }
  }

  function cancelDelete(): void {
    setDeleteModal(null);
  }

  if (error !== null && skills === null) return <Empty>{error}</Empty>;
  return (
    <section className="stack governance-page page-module-v2 skill-registry-workbench" data-slot="skill-registry-workbench">
      <PageHeader
        eyebrow={t.skills.eyebrow}
        title={t.skills.title}
        lede={t.skills.description}
        actions={<>
          <button type="button" className="secondary" onClick={() => setImportOpen(true)}>
            <Icon name="download" size={14} />
            {t.skills.importExternal}
          </button>
          <button type="button" className="primary" onClick={() => setUploadOpen(true)}>
            <Icon name="upload" size={14} />
            {t.skills.uploadSkill}
          </button>
        </>}
      />

      <div className="skill-metric-strip" data-slot="skill-metric-strip">
        <article><span>{t.skills.totalSkills}</span><strong>{(skills?.length ?? 0) + externalSkills.length}</strong></article>
        <article><span>{t.skills.statusPublished}</span><strong>{publishedCount}</strong></article>
        <article><span>{t.skills.statusUnpublished}</span><strong>{unpublishedCount}</strong></article>
        <article><span>{t.skills.sourceExternal}</span><strong>{externalSkills.length}</strong></article>
        <article><span>{t.skills.activeTags}</span><strong>{activeTags.length}</strong></article>
        <article><span>{t.skills.configuredAgents}</span><strong>{configuredAgentCount}</strong></article>
      </div>

      <div className="registry-toolbar registry-toolbar-expanded skill-workbench-toolbar panel panel-themed panel-toolbar">
        <label className="search-wide">{t.skills.searchSkills}<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t.skills.searchPlaceholder} /></label>
        <label>{t.skills.source}<select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as typeof sourceFilter)}><option value="">{t.skills.sourceAll}</option><option value="registry">{t.skills.sourceRegistry}</option><option value="external">{t.skills.sourceExternal}</option><option value="npm">{t.skills.sourceNpm}</option><option value="github">{t.skills.sourceGithub}</option></select></label>
        <label>{t.skills.agent}<select value={agent} onChange={(event) => setAgent(event.target.value)}><option value="">{t.common.all}</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="cursor">Cursor</option><option value="codebuddy">CodeBuddy</option></select></label>
        <label>{t.skills.status}<select value={status} onChange={(event) => setStatus(event.target.value as "" | "published" | "unpublished")}><option value="">{t.common.all}</option><option value="published">{t.skills.statusPublished}</option><option value="unpublished">{t.skills.statusUnpublished}</option></select></label>
        <div className="tag-filter-panel">
          <span>{t.skills.tag}</span>
          <div className="tag-filter-list">
            {activeTags.map((tag) => <button type="button" className={`tag-filter-chip ${selectedTags.includes(tag.slug) ? "selected" : ""}`} key={tag.tag_id} onClick={() => toggleTag(tag.slug)}>{tag.label}</button>)}
          </div>
        </div>
      </div>

      <div className="panel panel-themed panel-list registry-list skill-workbench-list" data-slot="skill-list">
        <div className="panel-title skill-list-title">
          <div className="skill-list-heading">
            <h2>{t.skills.skillList}</h2>
            <p><Icon name="grip" size={13} /> {t.skills.skillOrderHint}</p>
          </div>
          <span>{filtered.length}</span>
        </div>
        <div className="registry-list-body skill-workbench-body skill-catalog-grid" data-slot="skill-card-grid">
          {skills === null ? <Skeleton variant="table" lines={6} /> : filtered.length === 0 ? <EmptyState
            icon={mixed.length === 0 ? "sparkles" : "search"}
            title={mixed.length === 0 ? t.skills.noSkills : t.skills.noMatch}
            hint={mixed.length === 0 ? t.skills.noSkillsHint : t.skills.noMatchHint}
            action={mixed.length === 0 ? <button type="button" className="primary" onClick={() => setUploadOpen(true)}>{t.skills.uploadSkill}</button> : undefined}
          /> : pageItems.map((item) => {
            if (item.kind === "external") {
              const skill = item.skill;
              const displayName = externalSkillDisplayName(skill);
              const description = externalSkillDescription(skill);
              const sourceName = externalSkillSourceName(skill);
              return (
                <div
                  className={`skill-card-shell external-skill-card-shell has-drag-handle${draggedCatalogKey === item.catalogKey ? " is-dragging" : ""}${dragOverCatalogKey === item.catalogKey ? " is-drop-target" : ""}`}
                  data-slot="external-skill-row"
                  data-catalog-card="true"
                  data-card-kind="external"
                  key={skill.id}
                  onDragEnter={() => setDragOverCatalogKey(item.catalogKey)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => dropCatalogItem(event, item.catalogKey)}
                >
                  <button
                    type="button"
                    className="skill-card-drag-handle"
                    data-slot="skill-card-drag-handle"
                    draggable={!orderSaving}
                    disabled={orderSaving}
                    aria-label={t.skills.dragSkillOrder.replace("{name}", displayName)}
                    title={t.skills.dragSkillOrder.replace("{name}", displayName)}
                    onDragStart={(event) => beginCatalogDrag(event, item.catalogKey)}
                    onDragEnd={() => { setDraggedCatalogKey(null); setDragOverCatalogKey(null); }}
                    onKeyDown={(event) => moveCatalogItemByKeyboard(event, item.catalogKey)}
                  ><Icon name="grip" size={15} /></button>
                  <Link className="skill-catalog-card external-skill-card" data-slot="skill-card" href={`/external-skills/${skill.id}`}>
                    <div className="skill-card-header external-skill-heading">
                        <span className="external-skill-glyph"><Icon name={skill.source.type === "github" ? "folder" : "package"} size={16} /></span>
                        <span className="external-skill-identity">
                          <strong className="skill-card-name">{displayName}</strong>
                          <span className="external-skill-source-ref">{skill.source.ref}</span>
                        </span>
                        <span className="skill-card-status skill-card-status-external">{t.skills.externalBadge}</span>
                    </div>
                    <p className="skill-card-description" title={description}>{description}</p>
                    <div className="skill-card-tags">
                        {skill.updateAvailable ? <span className="tag">{t.skills.updateAvailableBadge}</span> : null}
                        {skill.tags.slice(0, 3).map((tag) => <span className="tag" key={tag}>{tagLabelBySlug.get(tag) ?? tag}</span>)}
                        {skill.tags.length > 3 ? <span className="tag skill-card-tag-more">+{skill.tags.length - 3}</span> : null}
                    </div>
                    <dl className="skill-card-facts" data-slot="external-skill-metadata">
                      <div><dt>{t.skills.version}</dt><dd>{skill.snapshot.version ?? "—"}</dd></div>
                      <div><dt>{t.skills.source}</dt><dd>{sourceName}</dd></div>
                      <div><dt>{t.skills.updated}</dt><dd>{skill.updated_at.slice(0, 10)}</dd></div>
                    </dl>
                  </Link>
                </div>
              );
            }
            const skill = item.skill;
            return (
              <div
                className={`skill-card-shell has-card-action has-drag-handle${draggedCatalogKey === item.catalogKey ? " is-dragging" : ""}${dragOverCatalogKey === item.catalogKey ? " is-drop-target" : ""}`}
                data-slot="registry-skill-card"
                data-catalog-card="true"
                data-card-kind="registry"
                key={skill.skill_id}
                onDragEnter={() => setDragOverCatalogKey(item.catalogKey)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => dropCatalogItem(event, item.catalogKey)}
              >
                <button
                  type="button"
                  className="skill-card-drag-handle"
                  data-slot="skill-card-drag-handle"
                  draggable={!orderSaving}
                  disabled={orderSaving}
                  aria-label={t.skills.dragSkillOrder.replace("{name}", skill.name)}
                  title={t.skills.dragSkillOrder.replace("{name}", skill.name)}
                  onDragStart={(event) => beginCatalogDrag(event, item.catalogKey)}
                  onDragEnd={() => { setDraggedCatalogKey(null); setDragOverCatalogKey(null); }}
                  onKeyDown={(event) => moveCatalogItemByKeyboard(event, item.catalogKey)}
                ><Icon name="grip" size={15} /></button>
                <Link className="skill-catalog-card registry-skill-card" data-slot="skill-card" href={`/skills/${skill.slug}`}>
                  <div className="skill-card-header">
                    <span className="external-skill-glyph"><Icon name="sparkles" size={16} /></span>
                    <span className="skill-card-identity">
                      <strong className="skill-card-name">{skill.name}</strong>
                      <span className="skill-card-slug">{skill.slug === skill.name ? t.skills.sourceRegistry : skill.slug}</span>
                    </span>
                    <span className={`skill-card-status ${skill.status === "published" ? "skill-card-status-published" : "skill-card-status-draft"}`}>{skillStatusLabel(skill.status, t.skills)}</span>
                  </div>
                  <p className="skill-card-description" title={displayValue(skill.description, t.skillDetail)}>{displayValue(skill.description, t.skillDetail)}</p>
                  <div className="skill-card-tags">
                    {skill.tags.slice(0, 3).map((tag) => <span className="tag" key={tag}>{tagLabelBySlug.get(tag) ?? tag}</span>)}
                    {skill.tags.length > 3 ? <span className="tag skill-card-tag-more">+{skill.tags.length - 3}</span> : null}
                  </div>
                  <dl className="skill-card-facts">
                    <div><dt>{t.skills.version}</dt><dd>v{skill.latest_version ?? "0.0.0"}</dd></div>
                    <div><dt>{t.skills.adapters}</dt><dd>{skill.agents.length}</dd></div>
                    <div><dt>{t.skills.updated}</dt><dd>{skill.updated_at.slice(0, 10)}</dd></div>
                  </dl>
                </Link>
                <button type="button" className="skill-card-delete" aria-label={t.common.delete} title={t.common.delete} onClick={(event) => { event.preventDefault(); event.stopPropagation(); deleteSkill(skill); }}><Icon name="trash" size={14} /></button>
              </div>
            );
          })}
        </div>
        {totalPages <= 1 ? null : (
          <Pagination
            page={currentPage}
            totalPages={totalPages}
            total={filtered.length}
            onChange={setPage}
            labels={{
              first: t.skills.firstPage,
              prev: t.skills.prevPage,
              next: t.skills.nextPage,
              last: t.skills.lastPage,
              pageInfo: t.skills.pageInfo
            }}
          />
        )}
      </div>
      {message === null ? null : <div className="notice success">{message}</div>}
      {error === null ? null : <div className="notice danger">{error}</div>}
      <Modal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        title={t.skills.uploadSkill}
        closeLabel={t.common.cancel}
        wide
      >
        <div className="skill-upload-dialog">
          <p>{t.skills.uploadHint}</p>
          <SkillUploadPanel api={api} agent="claude-code" onUploaded={async (draft) => {
            await refresh();
            setMessage(t.skills.uploadedAsDraft.replace("{name}", draft.slug));
            setUploadOpen(false);
          }} />
        </div>
      </Modal>
      <Modal
        open={deleteModal !== null}
        onClose={cancelDelete}
        title={t.common.delete}
        closeLabel={t.common.cancel}
        footer={<>
          <button type="button" className="secondary" onClick={cancelDelete}>{t.common.cancel}</button>
          <button type="button" className="danger" onClick={() => void confirmDelete()}>{t.common.delete}</button>
        </>}
      >
        <p>{deleteModal === null ? "" : t.skills.deleteConfirm.replace("{name}", deleteModal.name)}</p>
      </Modal>
      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={t.skills.importExternal}
        closeLabel={t.common.cancel}
        footer={<>
          <button type="button" className="secondary external-skill-import-cancel" onClick={() => setImportOpen(false)}>{t.common.cancel}</button>
          <button
            type="submit"
            form="external-skill-import-form"
            className="primary external-skill-import-submit"
            disabled={importRef.trim() === "" || importing}
          >
            {importing ? <Spinner size={14} label={t.skills.importingExternal} /> : <Icon name="download" size={14} />}
            {importing ? t.skills.importingExternal : t.skills.importExternalSubmit}
          </button>
        </>}
      >
        <form
          id="external-skill-import-form"
          className="external-skill-import"
          data-slot="external-skill-import"
          onSubmit={(event) => { event.preventDefault(); void submitImport(); }}
        >
          <p id="external-skill-import-intro" className="external-skill-import-intro">{t.skills.importExternalHint}</p>
          <div
            className="external-source-guides"
            data-slot="external-source-guides"
            aria-label={t.skills.importExternalFormats}
          >
            <div className="external-source-guide" data-slot="external-source-guide">
              <span className="external-source-icon"><Icon name="package" size={17} /></span>
              <span><strong>{t.skills.importExternalNpm}</strong><code>@scope/package</code></span>
            </div>
            <div className="external-source-guide" data-slot="external-source-guide">
              <span className="external-source-icon"><Icon name="folder" size={17} /></span>
              <span><strong>{t.skills.importExternalGithub}</strong><code>owner/repo</code></span>
            </div>
          </div>
          <label className="form-field external-skill-import-field" htmlFor="external-skill-source">
            <span className="form-label">{t.skills.importExternalSource}<abbr title={t.skills.requiredField}>*</abbr></span>
            <input
              id="external-skill-source"
              value={importRef}
              onChange={(event) => setImportRef(event.target.value)}
              placeholder={t.skills.importExternalPlaceholder}
              aria-describedby="external-skill-import-intro external-skill-import-trust"
              autoComplete="off"
              required
            />
          </label>
          <label className="form-field external-skill-import-field" htmlFor="external-skill-note">
            <span className="form-label">{t.skills.importExternalNoteOptional}</span>
            <textarea
              id="external-skill-note"
              value={importNote}
              onChange={(event) => setImportNote(event.target.value)}
              placeholder={t.skills.importExternalNotePlaceholder}
              rows={4}
            />
          </label>
          <div
            id="external-skill-import-trust"
            className="external-skill-import-trust"
            data-slot="external-skill-import-trust"
          >
            <Icon name="info" size={16} />
            <p>{t.skills.importExternalTrust}</p>
          </div>
        </form>
      </Modal>
    </section>
  );
}

export function SkillDetail({ api: apiValue, skillId }: { api?: HunterApi; skillId: string }) {
  const { t } = useI18n();
  const api = useApi(apiValue);
  const [skill, setSkill] = useState<RegistrySkillDetail | null>(null);
  const [versions, setVersions] = useState<RegistrySkillVersion[]>([]);
  const [tags, setTags] = useState<RegistryTag[]>([]);
  const [agent, setAgent] = useState<DemoAgent>("claude-code");
  const [currentAgent, setCurrentAgent] = useState<RegistryAgent>("claude-code");
  const [selectedTag, setSelectedTag] = useState("");
  const [demoDefaultAgent, setDemoDefaultAgent] = useState<DemoAgent | null>(null);
  const [settingDefault, setSettingDefault] = useState(false);
  const [sourcePath, setSourcePath] = useState("SKILL.md");
  const [activeTab, setActiveTab] = useState<SkillDetailTab>("source");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skillDraft, setSkillDraft] = useState<DraftState | null>(null);
  const userTouchedRef = useRef(false);

  async function refresh(forAgent: RegistryAgent = currentAgent): Promise<void> {
    try {
      const [detail, history, allTags] = await Promise.all([
        required(api, "getSkill")(skillId), required(api, "listSkillVersions")(skillId, forAgent),
        required(api, "listTags")()
      ]);
      setSkill(detail); setVersions(history); setTags(allTags);
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  async function refreshVersions(forAgent: RegistryAgent = currentAgent): Promise<void> {
    try {
      const history = await required(api, "listSkillVersions")(skillId, forAgent);
      setVersions(history);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  async function refreshDraft(forAgent: RegistryAgent = currentAgent): Promise<void> {
    try {
      const d = await required(api, "getSkillDraft")(skillId, forAgent);
      setSkillDraft(d);
    } catch {
      setSkillDraft(null);
    }
  }

  function selectCurrentAgent(next: RegistryAgent): void {
    userTouchedRef.current = true;
    setCurrentAgent(next);
    setSkillDraft(null);
    void refreshDraft(next);
    void refreshVersions(next);
  }

  async function setDefaultAgentHandler(next: RegistryAgent): Promise<void> {
    if (skill === null) return;
    if (process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true") {
      setDemoDefaultAgent(next);
      return;
    }
    try {
      setSettingDefault(true);
      const updated = await required(api, "setDefaultAgent")(skillId, next, skill.revision);
      setSkill(updated);
      setMessage(t.skillDetail.defaultAgentUpdated);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setSettingDefault(false);
    }
  }

  function handlePublished(): void {
    void refresh();
    void refreshDraft();
  }

  useEffect(() => {
    userTouchedRef.current = false;
    setCurrentAgent("claude-code");
    const stored = globalThis.localStorage?.getItem("hunter-harness-default-agent");
    if (stored === "claude-code" || stored === "cursor" || stored === "codex" || stored === "codebuddy") setAgent(stored as DemoAgent);
    void refresh("claude-code");
    void refreshDraft("claude-code");
  }, [api, skillId]);

  useEffect(() => {
    if (skill === null || userTouchedRef.current) return;
    const def = skill.defaultAgent ?? skill.agents.find((a) => a.enabled)?.agent ?? "claude-code";
    if (def !== currentAgent) {
      setCurrentAgent(def);
      setSkillDraft(null);
      void refreshDraft(def);
      void refreshVersions(def);
    }
  }, [skill]);

  useEffect(() => { setSourcePath("SKILL.md"); }, [skillId]);
  const command = `npx @hunter-harness/skill-cli install ${skillId} --agent ${agent}`;
  const npmCommand = `npx @hunter-harness/skill-cli install ${skillId} --agent ${agent} --from npm`;
  const latestNpmRelease = skill?.npmReleases.find((entry) => entry.version === skill.latest_version) ?? null;
  const npmBadgeLabel = latestNpmRelease?.status === "published"
    ? `${t.skillDetail.npmBadgePublished} v${latestNpmRelease.version}`
    : latestNpmRelease?.status === "failed"
      ? t.skillDetail.npmBadgeFailed
      : latestNpmRelease?.status === "conflict"
        ? t.skillDetail.npmBadgeConflict
        : t.skillDetail.npmBadgeUnpublished;
  async function copyCommand(): Promise<void> {
    await navigator.clipboard.writeText(command); setMessage(t.skillDetail.installCopied);
  }
  async function download(): Promise<void> {
    try {
      const artifact = await required(api, "downloadSkillArtifact")(skillId, agent);
      const url = URL.createObjectURL(artifact.blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = artifact.filename; anchor.click();
      URL.revokeObjectURL(url); setMessage(`${t.skillDetail.downloadedAudit}${artifact.hash.slice(0, 20)}…`);
    } catch (reason) { setError(apiError(reason, t)); }
  }
  function saveLocalMeta(next: { description: string; tags: string[] }): void {
    setSkill((current) => current === null ? current : {
      ...current,
      description: next.description,
      tags: next.tags,
      updated_at: new Date().toISOString()
    });
    setMessage(t.skillDetail.savedLocalConfig);
  }
  function removeLocalTag(slug: string): void {
    if (skill === null) return;
    saveLocalMeta({
      description: skill.description,
      tags: skill.tags.filter((tag) => tag !== slug)
    });
  }
  async function bindTag(): Promise<void> {
    if (selectedTag === "") return;
    try { setSkill(await required(api, "bindSkillTag")(skillId, selectedTag)); setMessage(t.skills.tagSavedAudit); }
    catch (reason) { setError(apiError(reason, t)); }
  }
  if (error !== null && skill === null) return <Empty>{error}</Empty>;
  if (skill === null) return <Empty>{t.skillDetail.loading}</Empty>;
  const sourceSkill = process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true"
    ? findDemoSourceSkill(skill.slug)
    : undefined;
  const activeDefaultAgent = demoDefaultAgent ?? sourceSkill?.defaultAgent;
  const effectiveDefault = demoDefaultAgent ?? skill.defaultAgent;
  const selectedAgent = sourceSkill?.agents.find((item) => item.agent === agent);
  const defaultAgent = sourceSkill?.agents.find((item) => item.agent === activeDefaultAgent);
  const fallback = selectedAgent !== undefined && selectedAgent.configured === false && defaultAgent !== undefined;
  const sourceFile = sourceSkill?.source.files.find((file) => file.path === sourcePath) ?? sourceSkill?.source.entrypoint;
  const prodSourceFile = skill.sourceFiles.find((file) => file.path === sourcePath) ?? skill.sourceFiles[0];
  const adapterPatch = sourceSkill?.adapters[agent];
  const entryFile = skill.sourceFiles.find((file) => /(^|\/)SKILL\.md$/i.test(file.path)) ?? skill.sourceFiles[0];
  const frontmatter = entryFile !== undefined ? parseSkillFrontmatter(entryFile.content) : null;
  return (
    <section className="stack governance-page">
      <header className="page-heading command-hero skill-detail-hero">
        <div className="page-heading-main">
          <Link className="back-button" href="/skills" aria-label={t.common.back}>
            <span aria-hidden="true">‹</span>
          </Link>
          <div className="page-heading-content">
            <p className="eyebrow">{t.skillDetail.eyebrow}</p>
            <h1>{skill.name}</h1>
            <p className="lede">{displayValue(skill.description, t.skillDetail)}</p>
            <div className="tag-row">{skill.tags.map((tag) => <button type="button" className="tag tag-remove" aria-label={t.skillDetail.removeTagLabel.replace("{tag}", tag)} onClick={() => removeLocalTag(tag)} key={tag}>{tag}<span aria-hidden="true">×</span></button>)}</div>
          </div>
        </div>
        <div className="skill-meta skill-detail-meta">
          <Status value={skill.status} />
          <code className="skill-detail-version">v{skill.latest_version}</code>
          <span className={`npm-badge npm-badge-${latestNpmRelease?.status ?? "unpublished"}`}>{npmBadgeLabel}</span>
        </div>
      </header>

      <div className="command-panel skill-command-panel panel">
        <label>{t.skillDetail.targetAgent}<select value={agent} onChange={(event) => { const value = event.target.value as DemoAgent; setAgent(value); localStorage.setItem("hunter-harness-default-agent", value); }}>{detailAgents.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
        <code className="command-code">{command}</code>
        <button onClick={() => void copyCommand()}>{t.skillDetail.copyCommand}</button>
        <button className="secondary" onClick={() => void download()}>{t.skillDetail.downloadZip}</button>
        <code className="command-code npm-command-code">{npmCommand}</code>
      </div>

      {fallback ? <div className="notice warning agent-fallback-banner">{t.skillDetail.fallbackBanner.replace("{agent}", selectedAgent.label).replace("{defaultAgent}", defaultAgent.label).replace("{path}", selectedAgent.targetPath)}</div> : null}

      <div className="skill-detail-tabs" role="tablist" aria-label={t.skillDetail.detailSectionsLabel}>
        {([
          ["source", t.skillDetail.tabSource],
          ["examples", t.skillDetail.tabExamples],
          ["definition", t.skillDetail.tabDefinition],
          ["checks", t.skillDetail.tabChecks],
          ["versions", t.skillDetail.tabVersions]
        ] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={activeTab === id} className={activeTab === id ? "selected" : ""} onClick={() => setActiveTab(id)}>{label}</button>)}
      </div>

      {activeTab === "source" && sourceSkill !== undefined && sourceFile !== undefined ? <article className="panel source-package">
        <div className="panel-title"><h2>{t.skillDetail.sourceFiles}</h2><span>{t.skillDetail.authoritativeDemoPackage}</span></div>
        <div className="source-package-grid">
          <SourceFileTree files={sourceSkill.source.files} selectedPath={sourceFile.path} onSelect={setSourcePath} />
          <FilePreview key={sourceFile.path} path={sourceFile.path} content={sourceFile.content} showRaw={t.skillDetail.showRaw} showRendered={t.skillDetail.showRendered} />
        </div>
        {adapterPatch === undefined ? null : <div className="adapter-patch"><strong>{t.skillDetail.codexAdaptation}</strong><p>{adapterPatch.patchSummary}</p></div>}
      </article> : null}

      {activeTab === "source" && sourceSkill === undefined && skill.sourceFiles.length > 0 && prodSourceFile !== undefined ? <article className="panel source-package">
        <div className="panel-title"><h2>{t.skillDetail.sourceFiles}</h2><span>{t.skillDetail.configSummary}</span></div>
        <div className="source-package-grid">
          <SourceFileTree files={skill.sourceFiles} selectedPath={prodSourceFile.path} onSelect={setSourcePath} />
          <FilePreview key={prodSourceFile.path} path={prodSourceFile.path} content={prodSourceFile.content} showRaw={t.skillDetail.showRaw} showRendered={t.skillDetail.showRendered} />
        </div>
      </article> : null}

      {activeTab === "source" && sourceSkill === undefined && skill.sourceFiles.length === 0 ? <article className="panel source-package">
        <div className="panel-title"><h2>{t.skillDetail.sourceFiles}</h2><span>{t.skillDetail.configSummary}</span></div>
        <Empty>{t.skillDetail.notAvailable}</Empty>
      </article> : null}

      {activeTab === "examples" ? <article className="panel">
        <div className="panel-title"><h2>{t.skillDetail.usageExamples}</h2><span>{t.skillDetail.usageExamplesSummary}</span></div>
        <UsageExamples examples={sourceSkill !== undefined ? sourceSkill.examples : skill.examples} t={t.skillDetail} />
      </article> : null}

      {activeTab === "definition" && sourceSkill !== undefined ? <div className="detail-grid system-config-layout">
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.systemConfig}</h2><span>{t.skillDetail.configSummary}</span></div><SkillConfigOverview name={skill.name} description={skill.description} version={frontmatter?.version ?? null} agents={skill.agents} t={t.skillDetail} tags={skill.tags} onSaveMeta={saveLocalMeta} top={<DemoSystemConfig agents={sourceSkill.agents} currentAgent={selectedAgent} defaultAgent={activeDefaultAgent ?? sourceSkill.defaultAgent} onSetDefault={setDemoDefaultAgent} t={t.skillDetail} />} /></article>
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.contractsSecurity}</h2><span>{t.skillDetail.contractsSecuritySummary}</span></div><ContractSecurityOverview frontmatter={frontmatter} t={t.skillDetail} /></article>
      </div> : null}

      {activeTab === "definition" && sourceSkill === undefined ? <div className="detail-grid system-config-layout">
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.systemConfig}</h2><span>{t.skillDetail.configSummary}</span></div><SkillConfigOverview name={skill.name} description={skill.description} version={frontmatter?.version ?? null} agents={skill.agents} t={t.skillDetail} tags={skill.tags} onSaveMeta={saveLocalMeta} top={<AgentConfigsOverview agents={skill.agents} t={t.skillDetail} />} /></article>
        <article className="panel"><div className="panel-title"><h2>{t.skillDetail.contractsSecurity}</h2><span>{t.skillDetail.contractsSecuritySummary}</span></div><ContractSecurityOverview frontmatter={frontmatter} t={t.skillDetail} /></article>
      </div> : null}

      {activeTab === "checks" ? <article className="panel">
        <div className="panel-title"><h2>{t.skillDetail.checkPublish}</h2><span>{agentLabel(currentAgent)}</span></div>
        <AgentContextSelector agents={skill.agents} currentAgent={currentAgent} defaultAgent={effectiveDefault} onSelect={selectCurrentAgent} onSetDefault={setDefaultAgentHandler} settingDefault={settingDefault} t={t.skillDetail} />
        <AgentCheckPanel key={currentAgent} api={api} slug={skillId} currentAgent={currentAgent} draft={skillDraft} onPublished={handlePublished} t={t} />
      </article> : null}

      {activeTab === "versions" ? <article className="panel">
        <div className="panel-title"><h2>{t.skillDetail.versionHistory}</h2><span>{agentLabel(currentAgent)}</span></div>
        <AgentContextSelector agents={skill.agents} currentAgent={currentAgent} defaultAgent={effectiveDefault} onSelect={selectCurrentAgent} onSetDefault={setDefaultAgentHandler} settingDefault={settingDefault} t={t.skillDetail} />
        <VersionHistoryPanel key={currentAgent} versions={versions} currentAgent={currentAgent} t={t.skillDetail} />
      </article> : null}

      {activeTab === "governance" ? <>
        <article className="panel compact-form"><div className="panel-title"><h2>{t.skillDetail.tagBinding}</h2><span>{t.skillDetail.noReview}</span></div><div className="inline-form"><select aria-label={t.skillDetail.selectTag} value={selectedTag} onChange={(event) => setSelectedTag(event.target.value)}><option value="">{t.skillDetail.selectTag}</option>{tags.filter((tag) => tag.active && !skill.tags.includes(tag.slug)).map((tag) => <option value={tag.tag_id} key={tag.tag_id}>{tag.label}</option>)}</select><button onClick={() => void bindTag()}>{t.skillDetail.addTag}</button></div></article>
      </> : null}
      {message === null ? null : <div className="notice success">{message}</div>}{error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}
