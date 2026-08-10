"use client";

import type { ExternalSkill, ExternalSkillQuickStartStep, RegistryTag } from "@hunter-harness/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { browserApi, type HunterApi } from "../lib/api";
import {
  externalSkillDescription,
  externalSkillDisplayName,
  externalSkillReadmeImageBase,
  externalSkillReadmeLinkBase,
  externalSkillRepositoryUrl,
  externalSkillSourceName
} from "../lib/external-skill-view";
import { useI18n } from "../lib/i18n";
import { mockApi } from "../lib/mock-api";
import { Empty, Status, apiError, required, MarkdownDocument } from "./skill-shared";
import { Icon } from "./ui/icons";

function useApi(value?: HunterApi): HunterApi {
  return useMemo(() => value ?? (
    process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi()
  ), [value]);
}

function SummaryList({
  title,
  items,
  icon,
  tone,
  wide = false
}: {
  title: string;
  items: string[];
  icon: "tasks" | "zap" | "play" | "warning";
  tone?: "warning";
  wide?: boolean;
}) {
  return (
    <section
      className={`external-summary-section${tone === undefined ? "" : ` ${tone}`}${wide ? " external-summary-section-wide" : ""}`}
      data-slot="external-summary-section"
    >
      <h3><Icon name={icon} size={15} /> {title}</h3>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </section>
  );
}

function QuickStartWorkflow({
  steps,
  legacyItems,
  title,
  hint,
  missing
}: {
  steps: ExternalSkillQuickStartStep[];
  legacyItems: string[];
  title: string;
  hint: string;
  missing: string;
}) {
  const items = steps.length > 0
    ? steps
    : legacyItems.map((instruction, index) => ({
        title: `步骤 ${index + 1}`,
        instruction,
        commands: []
      }));
  return (
    <section className="external-summary-section external-summary-workflow" data-slot="external-summary-workflow">
      <header>
        <h3><Icon name="play" size={15} /> {title}</h3>
        <p>{hint}</p>
      </header>
      {items.length === 0 ? <p className="external-workflow-empty">{missing}</p> : (
        <ol className="external-workflow-steps">
          {items.map((step, index) => (
            <li key={`${step.title}-${index}`}>
              <span className="external-workflow-index" aria-hidden="true">{index + 1}</span>
              <div className="external-workflow-copy">
                <strong>{step.title}</strong>
                <p>{step.instruction}</p>
                {step.commands.length === 0 ? null : (
                  <pre><code>{step.commands.join("\n")}</code></pre>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function tagSlugFromLabel(label: string): string {
  const ascii = label.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (ascii.length > 0) return ascii;
  let hash = 2166136261;
  for (const character of label) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `tag-${(hash >>> 0).toString(36)}`;
}

export function ExternalSkillDetail({ api: apiValue, skillId }: { api?: HunterApi; skillId: string }) {
  const { t } = useI18n();
  const api = useApi(apiValue);
  const router = useRouter();
  const [skill, setSkill] = useState<ExternalSkill | null>(null);
  const [note, setNote] = useState("");
  const [availableTags, setAvailableTags] = useState<RegistryTag[]>([]);
  const [tagSlugs, setTagSlugs] = useState<string[]>([]);
  const [newTagLabel, setNewTagLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summaryGenerating, setSummaryGenerating] = useState(false);
  const [showReadme, setShowReadme] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const [next, tags] = await Promise.all([
        required(api, "getExternalSkill")(skillId),
        api.listTags === undefined ? Promise.resolve([]) : api.listTags().catch(() => [])
      ]);
      setSkill(next);
      setNote(next.curationNote);
      setTagSlugs(next.tags);
      setAvailableTags(tags);
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  useEffect(() => { void refresh(); }, [api, skillId]);

  async function saveCuration(): Promise<void> {
    if (skill === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await required(api, "patchExternalSkill")(skill.id, {
        curationNote: note,
        tags: [...new Set(tagSlugs)].sort(),
        revision: skill.revision
      });
      setSkill(next);
      setNote(next.curationNote);
      setTagSlugs(next.tags);
      setMessage(t.skills.externalCurationSaved);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  async function refreshUpstream(): Promise<void> {
    if (skill === null || busy) return;
    setBusy(true);
    try {
      const next = await required(api, "refreshExternalSkill")(skill.id);
      setSkill(next);
      setNote(next.curationNote);
      setTagSlugs(next.tags);
      setMessage(t.skills.externalRefreshed);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  function toggleTag(slug: string): void {
    setTagSlugs((current) => current.includes(slug)
      ? current.filter((value) => value !== slug)
      : [...current, slug]);
  }

  async function createAndSelectTag(): Promise<void> {
    const label = newTagLabel.trim();
    if (label.length === 0 || busy) return;
    const existing = availableTags.find((tag) => tag.label.localeCompare(label, undefined, { sensitivity: "accent" }) === 0);
    if (existing !== undefined) {
      setTagSlugs((current) => current.includes(existing.slug) ? current : [...current, existing.slug]);
      setNewTagLabel("");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await required(api, "createTag")(tagSlugFromLabel(label), label);
      setAvailableTags((current) => [...current.filter((tag) => tag.slug !== created.slug), created]
        .sort((left, right) => left.label.localeCompare(right.label, "zh-CN")));
      setTagSlugs((current) => current.includes(created.slug) ? current : [...current, created.slug]);
      setNewTagLabel("");
      setMessage(t.skills.externalTagCreated);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  async function generateSummary(force: boolean): Promise<void> {
    if (skill === null || busy) return;
    setBusy(true);
    setSummaryGenerating(true);
    setError(null);
    try {
      const next = await required(api, "generateExternalSkillSummary")(
        skill.id,
        skill.revision,
        force
      );
      setSkill(next);
      setMessage(t.skills.externalSummaryGenerated);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setSummaryGenerating(false);
      setBusy(false);
    }
  }

  async function acknowledgeUpdate(): Promise<void> {
    if (skill === null || busy) return;
    setBusy(true);
    try {
      const next = await required(api, "patchExternalSkill")(skill.id, {
        acknowledgeUpdate: true,
        revision: skill.revision
      });
      setSkill(next);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  async function copyInstall(): Promise<void> {
    if (skill === null) return;
    try {
      await navigator.clipboard.writeText(skill.snapshot.installCommand);
      setMessage(t.skills.externalCopied);
    } catch {
      setError(apiError(new Error("clipboard unavailable"), t));
    }
  }

  async function remove(): Promise<void> {
    if (skill === null || busy) return;
    if (!window.confirm(t.skills.externalDeleteConfirm.replace("{name}", skill.snapshot.name))) return;
    setBusy(true);
    try {
      await required(api, "deleteExternalSkill")(skill.id);
      setMessage(t.skills.externalDeleted.replace("{name}", skill.snapshot.name));
      router.push("/skills");
    } catch (reason) {
      setError(apiError(reason, t));
      setBusy(false);
    }
  }

  if (error !== null && skill === null) return <Empty>{error}</Empty>;
  if (skill === null) return <div className="skeleton-block" />;

  const displayName = externalSkillDisplayName(skill);
  const description = externalSkillDescription(skill);
  const sourceName = externalSkillSourceName(skill);
  const repositoryUrl = externalSkillRepositoryUrl(skill);
  const isGithubSource = skill.source.type === "github";
  const summary = skill.aiSummary ?? null;
  const tagBySlug = new Map(availableTags.map((tag) => [tag.slug, tag]));
  const selectedTags = tagSlugs.map((slug) => ({ slug, label: tagBySlug.get(slug)?.label ?? slug }));
  const addableTags = availableTags.filter((tag) => tag.active && !tagSlugs.includes(tag.slug));

  return (
    <section className="stack governance-page external-skill-detail" data-slot="external-skill-detail">
      <header className="panel panel-themed external-skill-detail-hero">
        <div className="external-skill-hero-main">
          <Link className="back-button" href="/skills" aria-label={t.common.back}><Icon name="back" size={17} /></Link>
          <div className="external-skill-hero-copy">
            <p className="eyebrow">{t.skills.externalDetailEyebrow}</p>
            <h1 data-slot="external-skill-title">{displayName}</h1>
            <div className="external-skill-repository-line">
              <span>{t.skills.externalRepository}</span>
              <code>{skill.source.ref}</code>
            </div>
            <p className="lede">{description || t.skills.externalDetailTitle}</p>
          </div>
        </div>
        <div className="external-skill-hero-badges">
          <Status value="governed" />
          <span className="tag">{t.skills.externalBadge}</span>
          <span className="tag">{sourceName}</span>
          <span className="meta-pill meta-pill-version">{skill.snapshot.version ?? "—"}</span>
          {skill.updateAvailable ? <span className="tag">{t.skills.updateAvailableBadge}</span> : null}
        </div>
      </header>

      <div className="external-skill-detail-grid">
        <article className="panel panel-themed external-skill-document" data-slot="external-skill-document">
          <header className="external-skill-document-header">
            <div>
              <p className="eyebrow">{t.skills.externalSummaryEyebrow}</p>
              <h2>{t.skills.externalSummaryTitle}</h2>
              <p>{t.skills.externalSummaryHint}</p>
            </div>
            <div className="external-summary-actions">
              <button
                type="button"
                className="primary"
                disabled={busy}
                aria-busy={summaryGenerating}
                onClick={() => void generateSummary(summary !== null)}
              >
                {summaryGenerating ? <span className="spinner"><Icon name="loading" size={14} /></span> : <Icon name="sparkles" size={14} />}
                {summaryGenerating
                  ? t.skills.externalSummaryGenerating
                  : summary === null
                    ? t.skills.externalSummaryGenerate
                    : t.skills.externalSummaryRegenerate}
              </button>
              {repositoryUrl === null ? null : (
                <a className="secondary external-open-repository" href={repositoryUrl} target="_blank" rel="noreferrer">
                  <Icon name="folder" size={14} />
                  {t.skills.externalOpenRepository}
                </a>
              )}
            </div>
          </header>
          {summaryGenerating ? (
            <section className="external-summary-progress" data-slot="external-summary-progress" role="status" aria-live="polite">
              <span className="spinner external-summary-progress-spinner"><Icon name="loading" size={22} /></span>
              <div>
                <strong>{t.skills.externalSummaryProgressTitle}</strong>
                <p>{t.skills.externalSummaryProgressBody}</p>
              </div>
            </section>
          ) : null}
          {summary === null ? (summaryGenerating ? null : (
            <section className="external-summary-fallback" data-slot="external-summary-fallback">
              <div className="external-summary-fallback-icon"><Icon name="sparkles" size={18} /></div>
              <div>
                <strong>{t.skills.externalSummaryMissing}</strong>
                <p>{t.skills.externalSummaryFallback}</p>
                {skill.snapshot.description.length > 0 ? (
                  <blockquote>{skill.snapshot.description}</blockquote>
                ) : null}
                <Link href="/ai-config" className="external-summary-configure">{t.skills.externalSummaryConfigure}</Link>
              </div>
            </section>
          )) : (
            <section className="external-ai-summary" data-slot="external-skill-summary-template">
              <section className="external-summary-intro">
                <h3><Icon name="overview" size={15} /> {t.skills.externalSummaryWhatIsIt}</h3>
                <p className="external-summary-overview">{summary.overview}</p>
              </section>
              <div className="external-summary-grid">
                <SummaryList title={t.skills.externalSummaryCapabilities} items={summary.capabilities} icon="zap" />
                <SummaryList title={t.skills.externalSummaryUseCases} items={summary.use_cases} icon="tasks" />
                <QuickStartWorkflow
                  title={t.skills.externalSummaryGettingStarted}
                  hint={t.skills.externalSummaryWorkflowHint}
                  steps={summary.quick_start ?? []}
                  legacyItems={summary.getting_started}
                  missing={t.skills.externalSummaryGettingStartedMissing}
                />
                {summary.caveats.length === 0 ? null : (
                  <SummaryList title={t.skills.externalSummaryCaveats} items={summary.caveats} icon="warning" tone="warning" wide />
                )}
              </div>
              <p className="external-summary-provenance">
                <span>{t.skills.externalSummarySource}</span>
                <strong>{summary.provider_id} · {summary.model}</strong>
                <time dateTime={summary.generated_at}>{summary.generated_at.slice(0, 16).replace("T", " ")}</time>
              </p>
            </section>
          )}

          {skill.snapshot.readme === null || skill.snapshot.readme.length === 0 ? null : (
            <section className={`external-readme-source${showReadme ? " open" : ""}`}>
              <button
                type="button"
                className="external-readme-toggle"
                aria-expanded={showReadme}
                onClick={() => setShowReadme((value) => !value)}
              >
                <span><Icon name="file" size={15} /> {showReadme ? t.skills.externalHideReadme : t.skills.externalViewReadme}</span>
                <Icon name="chevron-right" size={15} className="external-readme-chevron" />
              </button>
              {showReadme ? (
                <MarkdownDocument
                  content={skill.snapshot.readme}
                  className="external-readme-reader"
                  dataSlot="external-readme-reader"
                  imageBaseUrl={externalSkillReadmeImageBase(skill)}
                  linkBaseUrl={externalSkillReadmeLinkBase(skill)}
                />
              ) : null}
            </section>
          )}
        </article>

        <aside className="external-skill-detail-rail">
          <section className="panel panel-themed external-skill-rail-card external-install-card">
            <div className="panel-title"><h2>{isGithubSource ? t.skills.externalSourceAddress : t.skills.externalInstallCommand}</h2></div>
            <pre className="external-install-command"><code>{skill.snapshot.installCommand}</code></pre>
            <div className="external-install-actions">
              <button type="button" className="primary" onClick={() => void copyInstall()}>
                <Icon name="copy" size={14} />
                {isGithubSource ? t.skills.externalCopyAddress : t.skills.externalCopyInstall}
              </button>
              {skill.snapshot.releaseUrl ? (
                <a className="secondary" href={skill.snapshot.releaseUrl} target="_blank" rel="noreferrer">{t.skills.externalReleaseLink}</a>
              ) : null}
            </div>
          </section>

          <section className="panel panel-themed external-skill-rail-card external-skill-facts">
            <div className="panel-title"><h2>{t.skills.externalMetadata}</h2></div>
            <dl>
              <div><dt>{t.skills.source}</dt><dd>{sourceName}</dd></div>
              <div><dt>{t.skills.externalRepository}</dt><dd title={skill.source.ref}>{skill.source.ref}</dd></div>
              <div><dt>{t.skills.version}</dt><dd>{skill.snapshot.version ?? "—"}</dd></div>
              <div><dt>{t.skills.externalLicense}</dt><dd>{skill.snapshot.license ?? "—"}</dd></div>
              <div><dt>{t.skills.externalLastChecked}</dt><dd>{skill.lastCheckedAt.slice(0, 19).replace("T", " ")}</dd></div>
            </dl>
          </section>

          <section className="panel panel-themed external-skill-rail-card external-curation-card">
            <div className="panel-title"><h2>{t.skills.externalCuration}</h2></div>
            <section className="external-tag-editor" aria-labelledby="external-tag-editor-title">
              <div className="external-tag-editor-heading">
                <strong id="external-tag-editor-title">{t.skills.externalTagsTitle}</strong>
                <span>{t.skills.externalTagsHint}</span>
              </div>
              <div className="external-tag-options">
                {selectedTags.length === 0 ? <span className="external-tags-empty">{t.skills.externalTagsEmpty}</span> : selectedTags.map((tag) => (
                  <button
                    key={tag.slug}
                    type="button"
                    className="external-tag-option selected"
                    aria-pressed="true"
                    aria-label={t.skills.externalRemoveTagAction.replace("{label}", tag.label)}
                    disabled={busy}
                    onClick={() => toggleTag(tag.slug)}
                  >
                    {tag.label}<span aria-hidden="true">×</span>
                  </button>
                ))}
              </div>
              {addableTags.length === 0 ? null : (
                <div className="external-tag-library">
                  <span>{t.skills.externalAvailableTags}</span>
                  <div className="external-tag-options">
                    {addableTags.map((tag) => (
                      <button
                        key={tag.slug}
                        type="button"
                        className="external-tag-option addable"
                        aria-pressed="false"
                        aria-label={t.skills.externalAddTagAction.replace("{label}", tag.label)}
                        disabled={busy}
                        onClick={() => toggleTag(tag.slug)}
                      >
                        <span aria-hidden="true">+</span>{tag.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <label className="external-new-tag-field">
                <span>{t.skills.externalNewTagLabel}</span>
                <div>
                  <input
                    value={newTagLabel}
                    maxLength={80}
                    placeholder={t.skills.externalNewTagPlaceholder}
                    onChange={(event) => setNewTagLabel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void createAndSelectTag();
                      }
                    }}
                  />
                  <button type="button" className="secondary" disabled={busy || newTagLabel.trim().length === 0} onClick={() => void createAndSelectTag()}>
                    {t.skills.externalCreateTag}
                  </button>
                </div>
              </label>
            </section>
            <label className="external-curation-field">
              <span>{t.skills.importExternalNote}</span>
              <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} />
            </label>
            <div className="external-curation-actions">
              <button type="button" disabled={busy} onClick={() => void saveCuration()}>{t.skills.externalSaveCuration}</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => void refreshUpstream()}>{t.skills.externalRefresh}</button>
              {skill.updateAvailable ? (
                <button type="button" className="secondary span-full" disabled={busy} onClick={() => void acknowledgeUpdate()}>
                  {t.skills.externalAcknowledgeUpdate}
                </button>
              ) : null}
              <button type="button" className="danger span-full" disabled={busy} onClick={() => void remove()}>{t.skills.externalDelete}</button>
            </div>
          </section>
        </aside>
      </div>

      {message === null ? null : <div className="notice success">{message}</div>}
      {error === null ? null : <div className="notice danger">{error}</div>}
    </section>
  );
}
