"use client";

import type { ExternalSkill, ExternalSkillCommandCheatsheetItem, ExternalSkillQuickStartStep, ExternalSkillUpdateRecord, RegistryTag } from "@hunter-harness/contracts";
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
import { Modal } from "./ui/Modal";
import { ToastFeedback } from "./ui/Toast";

function useApi(value?: HunterApi): HunterApi {
  return useMemo(() => value ?? (
    process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true" ? mockApi : browserApi()
  ), [value]);
}

function ShellCommandBlock({
  commands,
  commandLabel,
  copyLabel,
  onCopy,
  dataSlot = "external-workflow-command"
}: {
  commands: string[];
  commandLabel: string;
  copyLabel: string;
  onCopy: (commands: string[]) => void;
  dataSlot?: string;
}) {
  return (
    <div className="external-workflow-command" data-slot={dataSlot}>
      <div className="external-workflow-command-head" data-slot="external-workflow-command-header">
        <span>{commandLabel}</span>
        <button data-slot="external-workflow-command-copy" type="button" aria-label={copyLabel} title={copyLabel} onClick={() => onCopy(commands)}>
          <Icon name="copy" size={13} />
          {copyLabel}
        </button>
      </div>
      <pre><code>{commands.map((command, commandIndex) => (
        <span data-slot="external-workflow-command-line" key={`${commandIndex}-${command}`}>{command}</span>
      ))}</code></pre>
    </div>
  );
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

const SKILL_REFERENCE_PART = /([a-z0-9]+(?:-[a-z0-9]+)+)/giu;
const SKILL_REFERENCE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/iu;

function HighlightedWorkflowInstruction({ children }: { children: string }) {
  return <>{children.split(SKILL_REFERENCE_PART).map((part, index) => SKILL_REFERENCE.test(part)
    ? <code className="external-workflow-skill-reference" data-slot="external-workflow-skill-reference" key={`${part}-${index}`}>{part}</code>
    : part)}</>;
}

function QuickStartWorkflow({
  steps,
  legacyItems,
  title,
  hint,
  missing,
  startLabel,
  stepCountLabel,
  commandLabel,
  copyLabel,
  onCopy
}: {
  steps: ExternalSkillQuickStartStep[];
  legacyItems: string[];
  title: string;
  hint: string;
  missing: string;
  startLabel: string;
  stepCountLabel: string;
  commandLabel: string;
  copyLabel: string;
  onCopy: (commands: string[]) => void;
}) {
  const items = steps.length > 0
    ? steps
    : legacyItems.map((instruction, index) => ({
        title: `步骤 ${index + 1}`,
        instruction,
        commands: []
      }));
  return (
    <section
      className="external-summary-section external-summary-workflow"
      data-slot="external-summary-workflow"
      data-priority="primary"
      aria-labelledby="external-summary-workflow-title"
    >
      <header>
        <div className="external-workflow-heading">
          <span className="external-workflow-icon"><Icon name="play" size={16} /></span>
          <div>
            <div className="external-workflow-title-row">
              <h3 id="external-summary-workflow-title">{title}</h3>
              <span className="external-workflow-start">{startLabel}</span>
            </div>
            <p>{hint}</p>
          </div>
        </div>
        <span className="external-workflow-count">{stepCountLabel.replace("{count}", String(items.length))}</span>
      </header>
      {items.length === 0 ? <p className="external-workflow-empty">{missing}</p> : (
        <ol className="external-workflow-steps">
          {items.map((step, index) => (
            <li key={`${step.title}-${index}`} data-slot="external-workflow-step">
              <span className="external-workflow-index" aria-hidden="true">{index + 1}</span>
              <div className="external-workflow-copy">
                <strong>{step.title}</strong>
                <p><HighlightedWorkflowInstruction>{step.instruction}</HighlightedWorkflowInstruction></p>
                {step.commands.length === 0 ? null : (
                  <ShellCommandBlock commands={step.commands} commandLabel={commandLabel} copyLabel={copyLabel} onCopy={onCopy} />
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CommonCommands({
  items,
  title,
  hint,
  copyLabel,
  onCopy
}: {
  items: ExternalSkillCommandCheatsheetItem[];
  title: string;
  hint: string;
  copyLabel: string;
  onCopy: (commands: string[]) => void;
}) {
  if (items.length === 0) return null;
  return <section className="external-summary-section external-summary-common-commands external-summary-section-wide" data-slot="external-summary-common-commands" data-layout="cheatsheet">
    <header className="external-common-commands-copy">
      <h3><Icon name="zap" size={15} /> {title}</h3>
      <p>{hint}</p>
    </header>
    <div className="external-command-cheatsheet" data-slot="external-command-cheatsheet">
      {items.map((item) => <article data-slot="external-command-cheatsheet-item" key={item.command}>
        <div>
          <code><span aria-hidden="true">$</span>{item.command}</code>
          <p>{item.description}</p>
        </div>
        <button data-slot="external-command-cheatsheet-copy" type="button" aria-label={`${copyLabel}：${item.command}`} title={copyLabel} onClick={() => onCopy([item.command])}>
          <Icon name="copy" size={13} /> <span>{copyLabel}</span>
        </button>
      </article>)}
    </div>
  </section>;
}

function isOperationalCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (/^(?:cd|pushd|popd)\b/.test(normalized)) return false;
  if (/^(?:curl|wget|irm|iwr)\b/.test(normalized)) return false;
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b/.test(normalized)) return false;
  if (/\b(?:install|setup)\b/.test(normalized)) return false;
  return true;
}

function legacyCommandCheatsheet(steps: ExternalSkillQuickStartStep[]): ExternalSkillCommandCheatsheetItem[] {
  const seen = new Set<string>();
  return steps.flatMap((step) => step.commands
    .filter((command) => isOperationalCommand(command) && !seen.has(command))
    .map((command) => {
      seen.add(command);
      return { command, description: `${step.title}：${step.instruction}` };
    })).slice(0, 10);
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

function mergedUpdateLines(record: ExternalSkillUpdateRecord): string[] {
  return [...new Set(record.changes.map((change) => change.replace(/^[-*•]\s*/, "").trim()).filter(Boolean))].slice(0, 8);
}

export function ExternalSkillDetail({ api: apiValue, skillId }: { api?: HunterApi; skillId: string }) {
  const { t } = useI18n();
  const api = useApi(apiValue);
  const router = useRouter();
  const [skill, setSkill] = useState<ExternalSkill | null>(null);
  const [availableTags, setAvailableTags] = useState<RegistryTag[]>([]);
  const [tagSlugs, setTagSlugs] = useState<string[]>([]);
  const [newTagLabel, setNewTagLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summaryGenerating, setSummaryGenerating] = useState(false);
  const [refreshingHistory, setRefreshingHistory] = useState<string | null>(null);
  const [showReadme, setShowReadme] = useState(false);
  const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const [next, tags] = await Promise.all([
        required(api, "getExternalSkill")(skillId),
        api.listTags === undefined ? Promise.resolve([]) : api.listTags().catch(() => [])
      ]);
      setSkill(next);
      setTagSlugs(next.tags);
      setAvailableTags(tags);
      setError(null);
    } catch (reason) {
      setError(apiError(reason, t));
    }
  }

  useEffect(() => { void refresh(); }, [api, skillId]);

  async function saveTags(): Promise<void> {
    if (skill === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await required(api, "patchExternalSkill")(skill.id, {
        tags: [...new Set(tagSlugs)].sort(),
        revision: skill.revision
      });
      setSkill(next);
      setTagSlugs(next.tags);
      setMessage(t.skills.externalTagsSaved);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  async function checkUpstream(): Promise<void> {
    if (skill === null || busy) return;
    setBusy(true);
    try {
      const next = await required(api, "checkExternalSkill")(skill.id);
      setSkill(next);
      setTagSlugs(next.tags);
      if (next.updateAvailable) setUpdateConfirmOpen(true);
      else setMessage(t.skills.externalAlreadyLatest);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  async function applyUpstream(): Promise<void> {
    if (skill === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await required(api, "refreshExternalSkill")(skill.id);
      setSkill(next);
      setTagSlugs(next.tags);
      setUpdateConfirmOpen(false);
      setMessage(t.skills.externalUpdateApplied.replace("{version}", next.snapshot.version ?? "—"));
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setBusy(false);
    }
  }

  async function refreshUpdateHistory(appliedAt: string): Promise<void> {
    if (skill === null || busy) return;
    setBusy(true);
    setRefreshingHistory(appliedAt);
    setError(null);
    try {
      const next = await required(api, "refreshExternalSkillUpdateHistory")(skill.id, appliedAt);
      setSkill(next);
      setTagSlugs(next.tags);
      setMessage(t.skills.externalUpdateNotesRefreshed);
    } catch (reason) {
      setError(apiError(reason, t));
    } finally {
      setRefreshingHistory(null);
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
    setMessage(null);
    try {
      const next = await required(api, "generateExternalSkillSummary")(
        skill.id,
        skill.revision,
        force
      );
      setSkill(next);
      setMessage(t.skills.externalSummaryGenerated);
    } catch (reason) {
      try {
        const reconciled = await required(api, "getExternalSkill")(skill.id);
        const previousGeneratedAt = skill.aiSummary?.generated_at ?? null;
        const reconciledGeneratedAt = reconciled.aiSummary?.generated_at ?? null;
        if (reconciledGeneratedAt !== null && reconciledGeneratedAt !== previousGeneratedAt) {
          setSkill(reconciled);
          setTagSlugs(reconciled.tags);
          setError(null);
          setMessage(t.skills.externalSummaryGenerated);
          return;
        }
      } catch {
        // 原请求失败后只做一次只读对账；对账本身失败时保留原始错误。
      }
      setError(apiError(reason, t));
    } finally {
      setSummaryGenerating(false);
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

  async function copyWorkflowCommands(commands: string[]): Promise<void> {
    try {
      await navigator.clipboard.writeText(commands.join("\n"));
      setMessage(t.skills.externalSummaryCommandCopied);
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
  const commandCheatsheet = summary === null
    ? []
    : summary.command_cheatsheet ?? legacyCommandCheatsheet(summary.quick_start ?? []);
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
        <div className="external-skill-hero-side" data-slot="external-skill-upstream-controls">
          <div className="external-skill-hero-badges">
            <Status value="governed" />
            <span className="tag">{sourceName}</span>
            <span className="meta-pill meta-pill-version">{skill.snapshot.version ?? "—"}</span>
            {skill.updateAvailable ? <span className="tag update-attention"><Icon name="warning" size={13} /> {t.skills.externalUpdateTo.replace("{version}", skill.availableVersion ?? t.skills.externalChanged)}</span> : null}
          </div>
          <div className="external-skill-hero-actions">
            {skill.updateAvailable ? (
              <button data-slot="external-skill-update-now" type="button" className="primary update-now" disabled={busy} onClick={() => setUpdateConfirmOpen(true)}>
                <Icon name="download" size={14} />
                {t.skills.externalUpdateNow.replace("{version}", skill.availableVersion ?? t.skills.externalChanged)}
              </button>
            ) : (
              <button type="button" className="secondary" disabled={busy} onClick={() => void checkUpstream()}><Icon name="refresh" size={14} />{t.skills.externalCheckUpdates}</button>
            )}
            {repositoryUrl === null ? null : <a className="secondary" href={repositoryUrl} target="_blank" rel="noreferrer"><Icon name="folder" size={14} />{t.skills.externalOpenRepository}</a>}
            <button type="button" className="danger icon-button" aria-label={t.skills.externalDelete} title={t.skills.externalDelete} disabled={busy} onClick={() => void remove()}><Icon name="trash" size={14} /></button>
          </div>
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
                <QuickStartWorkflow
                  title={t.skills.externalSummaryGettingStarted}
                  hint={t.skills.externalSummaryWorkflowHint}
                  steps={summary.quick_start ?? []}
                  legacyItems={summary.getting_started}
                  missing={t.skills.externalSummaryGettingStartedMissing}
                  startLabel={t.skills.externalSummaryWorkflowStart}
                  stepCountLabel={t.skills.externalSummaryWorkflowSteps}
                  commandLabel={t.skills.externalSummaryWorkflowCommand}
                  copyLabel={t.skills.externalSummaryCopyCommand}
                  onCopy={(commands) => void copyWorkflowCommands(commands)}
                />
                <CommonCommands
                  items={commandCheatsheet}
                  title={t.skills.externalSummaryCommonCommands}
                  hint={t.skills.externalSummaryCommonCommandsHint}
                  copyLabel={t.skills.externalSummaryCopyCommand}
                  onCopy={(commands) => void copyWorkflowCommands(commands)}
                />
                <SummaryList title={t.skills.externalSummaryCapabilities} items={summary.capabilities} icon="zap" />
                <SummaryList title={t.skills.externalSummaryUseCases} items={summary.use_cases} icon="tasks" />
                {summary.caveats.length === 0 ? null : (
                  <SummaryList title={t.skills.externalSummaryCaveats} items={summary.caveats} icon="warning" tone="warning" wide />
                )}
              </div>
              <p className="external-summary-provenance">
                <span>{t.skills.externalSummaryVersion.replace("{version}", summary.source_version ?? skill.snapshot.version ?? "—")}</span>
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
            {isGithubSource && repositoryUrl !== null ? (
              <a data-slot="external-skill-source-address" className="external-source-address" href={repositoryUrl} target="_blank" rel="noreferrer">
                <Icon name="folder" size={14} />
                <span>{repositoryUrl}</span>
              </a>
            ) : (
              <ShellCommandBlock
                commands={[skill.snapshot.installCommand]}
                commandLabel={t.skills.externalSummaryWorkflowCommand}
                copyLabel={t.skills.externalSummaryCopyCommand}
                onCopy={() => void copyInstall()}
                dataSlot="external-install-command"
              />
            )}
            <div className="external-install-actions">
              {isGithubSource ? <button type="button" className="primary" onClick={() => void copyInstall()}>
                <Icon name="copy" size={14} />{t.skills.externalCopyAddress}
              </button> : null}
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

          {(skill.updateHistory ?? []).length === 0 ? null : <section className="panel panel-themed external-skill-rail-card external-update-history" data-slot="external-skill-update-history" data-testid="external-skill-update-history">
            <div className="panel-title"><h2>{t.skills.externalUpdateHistory}</h2></div>
            <ol>{(skill.updateHistory ?? []).slice(0, 5).map((record) => <li key={`${record.applied_at}-${record.to_version}`}>
              <div className="external-update-transition">
                <div><strong>{record.from_version ?? "—"} → {record.to_version ?? "—"}</strong><time dateTime={record.applied_at}>{record.applied_at.slice(0, 16).replace("T", " ")}</time></div>
                <button
                  data-slot="external-update-notes-refresh"
                  type="button"
                  className="secondary external-update-refresh"
                  disabled={busy}
                  aria-label={t.skills.externalRefreshUpdateNotes}
                  onClick={() => void refreshUpdateHistory(record.applied_at)}
                >
                  <Icon name={refreshingHistory === record.applied_at ? "loading" : "refresh"} size={12} />
                  {refreshingHistory === record.applied_at ? t.skills.externalRefreshingUpdateNotes : t.skills.externalRefreshUpdateNotes}
                </button>
              </div>
              <ul className="external-update-summary" data-slot="external-update-summary">{mergedUpdateLines(record).map((change) => <li key={change}>{change}</li>)}</ul>
              {record.source_url === null ? null : <a className="external-update-source" data-slot="external-update-source" href={record.source_url} target="_blank" rel="noreferrer">{t.skills.externalUpdateSource}</a>}
            </li>)}</ol>
          </section>}

          <section className="panel panel-themed external-skill-rail-card external-tags-card" data-slot="external-skill-tags">
            <div className="panel-title external-tags-title"><div><h2>{t.skills.externalTagsTitle}</h2><p>{t.skills.externalTagsHint}</p></div></div>
            <section className="external-tag-editor" aria-labelledby="external-tag-editor-title">
              <div className="external-tag-group">
                <strong id="external-tag-editor-title">{t.skills.externalSelectedTags}</strong>
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
            <div className="external-curation-actions external-tags-actions" data-slot="external-skill-tags-actions">
              <button type="button" className="primary" disabled={busy} onClick={() => void saveTags()}>{t.skills.externalSaveTags}</button>
            </div>
          </section>
        </aside>
      </div>

      <ToastFeedback tone="success" message={message} />
      <ToastFeedback tone="danger" message={error} />
      <Modal open={updateConfirmOpen} onClose={() => setUpdateConfirmOpen(false)} title={t.skills.externalUpdateAvailableTitle} closeLabel={t.common.cancel}>
        <div className="external-update-confirm" data-slot="external-skill-update-confirmation">
          <p>{t.skills.externalUpdateAvailableBody}</p>
          <div className="external-version-transition"><span>{skill.snapshot.version ?? "—"}</span><strong>→</strong><span>{skill.availableVersion ?? t.skills.externalChanged}</span></div>
          <div className="modal-actions"><button type="button" className="secondary" onClick={() => setUpdateConfirmOpen(false)}>{t.common.cancel}</button><button type="button" className="primary" disabled={busy} onClick={() => void applyUpstream()}>{t.skills.externalApplyUpdate}</button></div>
        </div>
      </Modal>
    </section>
  );
}
