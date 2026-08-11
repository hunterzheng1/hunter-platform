"use client";

import type {
  DraftState,
  FixPlan,
  FixPlanItem,
  RegistryAgent,
  SkillTargetAgent,
  SkillCheckResult,
  SkillDiffFile,
  RegistrySkillVersion
} from "@hunter-harness/contracts";
import { SKILL_AI_CHECK_POLICY, SKILL_AI_POLICY_PRINCIPLES } from "@hunter-harness/contracts";
import { useEffect, useRef, useState } from "react";

import { type HunterApi } from "../lib/api";
import type { useI18n } from "../lib/i18n";
import {
  CheckLight,
  Empty,
  apiError,
  computeDiff,
  diffStats,
  required,
  shiftPatchVersion
} from "./skill-shared";
import { SkillUploadPanel } from "./skill-upload-panel";
import { Modal } from "./ui/Modal";
import { useToast } from "./ui/Toast";

const AI_JOB_POLL_INTERVAL_MS = 1_000;
const AI_JOB_POLL_TIMEOUT_MS = 150_000;

function isSkillTargetAgent(agent: RegistryAgent): agent is SkillTargetAgent {
  return agent === "claude-code" || agent === "codex" || agent === "cursor" || agent === "codebuddy";
}

function checkStatusCopy(status: "green" | "yellow" | "red", t: ReturnType<typeof useI18n>["t"]["skillDetail"]): { title: string; description: string } {
  if (status === "green") return { title: t.checkPassed, description: t.checkPassedDescription };
  if (status === "yellow") return { title: t.checkWarning, description: t.checkWarningDescription };
  return { title: t.checkFailed, description: t.checkFailedDescription };
}

const SUGGEST_APPLICABLE: readonly string[] = ["examples", "instructions", "description"];

function canAdoptSuggestion(item: FixPlanItem): boolean {
  if (item.applicationState === "applied") return false;
  if (item.appliesTo === null || item.appliesTo === undefined) return false;
  if (!SUGGEST_APPLICABLE.includes(item.appliesTo)) return false;
  if (typeof item.suggestedContent !== "string" || item.suggestedContent.length === 0) return false;
  // 数组类字段（examples/allowed_capabilities/instructions）：LLM 返回空数组 "[]" 会清空字段 → 不显示采纳按钮。
  // 与 store.applyFixSuggestion 的空数组 422 纵深对齐；description 是标量，跳过 JSON 解析。
  if (item.appliesTo !== "description") {
    try {
      const parsed: unknown = JSON.parse(item.suggestedContent);
      if (!Array.isArray(parsed) || parsed.length === 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function diffAppliedSuggestion(before: DraftState | null, after: DraftState): SkillDiffFile[] {
  const sourceDiff = computeDiff(before?.sourceFiles ?? [], after.sourceFiles);
  const beforeExamples = JSON.stringify(before?.examples ?? [], null, 2);
  const afterExamples = JSON.stringify(after.examples, null, 2);
  if (beforeExamples === afterExamples) return sourceDiff;
  return [...sourceDiff, {
    path: "examples.json",
    status: (before?.examples.length ?? 0) === 0 ? "added" : after.examples.length === 0 ? "removed" : "modified",
    publishedContent: (before?.examples.length ?? 0) === 0 ? null : beforeExamples,
    draftContent: after.examples.length === 0 ? null : afterExamples
  }];
}

function fixPlanFromAiChecks(result: SkillCheckResult | null, checkIds: readonly string[] | null = null): FixPlan {
  const items: FixPlanItem[] = (result?.items ?? [])
    .filter((check) => check.status !== "green" && check.suggestion !== null && check.suggestion !== undefined)
    .filter((check) => checkIds === null || checkIds.includes(check.id))
    .map((check) => {
      const suggestion = check.suggestion;
      if (suggestion === null || suggestion === undefined) throw new Error("AI suggestion is unexpectedly missing");
      return {
        checkId: check.id,
        action: "suggest",
        label: check.label,
        affectedPaths: check.filePath === null ? [] : [check.filePath],
        riskDelta: null,
        message: check.message,
        suggestedContent: suggestion.suggestedContent,
        explanation: suggestion.explanation,
        appliesTo: suggestion.appliesTo,
        generatedAt: suggestion.generatedAt ?? result?.checkedAt ?? null,
        applicationState: suggestion.applicationState,
        appliedAt: suggestion.appliedAt
      };
    });
  return {
    items,
    mergedFiles: [],
    summary: { autoCount: 0, confirmCount: 0, suggestCount: items.length, changedFiles: 0, changedLines: 0 }
  };
}

function appliesToLabel(appliesTo: NonNullable<FixPlanItem["appliesTo"]>, sd: ReturnType<typeof useI18n>["t"]["skillDetail"]): string {
  switch (appliesTo) {
    case "examples": return sd.appliesToExamples;
    case "allowed_capabilities": return sd.appliesToAllowedCapabilities;
    case "instructions": return sd.appliesToInstructions;
    case "description": return sd.appliesToDescription;
    case "tags": return sd.appliesToTags;
  }
}

function formatSuggestionContent(item: FixPlanItem): string {
  const content = item.suggestedContent ?? "";
  if (item.appliesTo === "description") return content;
  try {
    return JSON.stringify(JSON.parse(content) as unknown, null, 2);
  } catch {
    return content;
  }
}

function AgentCheckPanel({
  api,
  slug,
  sourceAgent,
  draft,
  onPublished,
  t
}: {
  api: HunterApi;
  slug: string;
  sourceAgent: RegistryAgent;
  draft: DraftState | null;
  onPublished: () => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const sd = t.skillDetail;
  const toast = useToast();
  const [checksResult, setChecksResult] = useState<SkillCheckResult | null>(draft?.checks ?? null);
  const [aiChecksResult, setAiChecksResult] = useState<SkillCheckResult | null>(draft?.aiChecks ?? null);
  const [aiChecking, setAiChecking] = useState(false);
  const [diffFiles, setDiffFiles] = useState<readonly SkillDiffFile[]>([]);
  const [suggestionDiffFiles, setSuggestionDiffFiles] = useState<readonly SkillDiffFile[] | null>(null);
  const [diffView, setDiffView] = useState<"release" | "suggestion">("release");
  const [diffLoading, setDiffLoading] = useState(false);
  const [checkDialog, setCheckDialog] = useState<"green" | "yellow" | "red" | "ai" | null>(null);
  const [aiPolicyOpen, setAiPolicyOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState(0);
  const [checking, setChecking] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishPending, setPublishPending] = useState(false);
  const [publishVersion, setPublishVersion] = useState("");
  const [publishNote, setPublishNote] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const [fixPlan, setFixPlan] = useState<FixPlan | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixPreviewRun, setFixPreviewRun] = useState(false);
  const [fixCheckIds, setFixCheckIds] = useState<string[] | null>(null);
  const [generatingReleaseNote, setGeneratingReleaseNote] = useState(false);
  const [fixSuggestions, setFixSuggestions] = useState<FixPlan | null>(null);
  const [adoptingSuggestion, setAdoptingSuggestion] = useState(false);
  const [editingSuggestionId, setEditingSuggestionId] = useState<string | null>(null);
  const [editedSuggestionContent, setEditedSuggestionContent] = useState("");
  const latestDraftRef = useRef<DraftState | null>(draft);

  useEffect(() => {
    latestDraftRef.current = draft;
    setChecksResult(draft?.checks ?? null);
    setAiChecksResult(draft?.aiChecks ?? null);
  }, [draft]);

  useEffect(() => {
    setSuggestionDiffFiles(null);
    setDiffView("release");
    setSelectedFile(0);
  }, [slug, sourceAgent]);

  useEffect(() => {
    if (draft === null) {
      setDiffFiles([]);
      setSuggestionDiffFiles(null);
      setDiffView("release");
      setSelectedFile(0);
      setDiffLoading(false);
      return;
    }
    let active = true;
    setDiffLoading(true);
    void (async () => {
      try {
        const files = await required(api, "diffSkillDraft")(slug, sourceAgent);
        if (!active) return;
        setDiffFiles(files);
        setSelectedFile(0);
      } catch (reason) {
        if (active) toast.danger(apiError(reason, t));
      } finally {
        if (active) setDiffLoading(false);
      }
    })();
    return () => { active = false; };
  }, [api, draft?.revision, slug, sourceAgent]);

  const summary = checksResult?.summary ?? { green: 0, yellow: 0, red: 0 };
  const requiredChecks = checksResult?.items ?? [];
  const aiChecks = aiChecksResult?.items ?? [];
  const autoFixableChecks = requiredChecks.filter((check) => check.fixable && check.status !== "green");
  const defaultPublishVersion = draft?.draftVersion ?? "0.1.0";
  const resolvedPublishVersion = publishVersion || defaultPublishVersion;
  const resolvedPublishNote = publishNote || sd.defaultPublishModalNote;
  const activeDiffFiles = diffView === "suggestion" && suggestionDiffFiles !== null ? suggestionDiffFiles : diffFiles;
  const activeFile = activeDiffFiles[selectedFile] ?? activeDiffFiles[0];
  const stats = diffStats(diffFiles);
  const selectedChecks = checkDialog === null
    ? []
    : checkDialog === "ai"
      ? aiChecks
      : requiredChecks.filter((check) => check.status === checkDialog);
  const checkDialogTitle = checkDialog === null
    ? ""
    : checkDialog === "ai"
      ? sd.aiQualityAdvice
      : checkStatusCopy(checkDialog, sd).title;
  const metricCards = [
    { key: "green" as const, count: summary.green, slot: "required-check-green", ...checkStatusCopy("green", sd) },
    { key: "yellow" as const, count: summary.yellow, slot: "required-check-yellow", ...checkStatusCopy("yellow", sd) },
    { key: "red" as const, count: summary.red, slot: "required-check-red", ...checkStatusCopy("red", sd) },
    { key: "ai" as const, count: aiChecks.length, slot: "ai-quality-advice", title: sd.aiQualityAdvice, description: sd.aiAdvisoryDescription }
  ];
  const publishedLines = (activeFile?.publishedContent ?? "").split("\n");
  const draftLines = (activeFile?.draftContent ?? "").split("\n");

  async function runChecks(): Promise<void> {
    setChecking(true);
    try {
      const result = await required(api, "runSkillDraftChecks")(slug, sourceAgent);
      setChecksResult(result);
    } catch (reason) { toast.danger(apiError(reason, t)); }
    finally { setChecking(false); }
  }

  async function runAiChecks(): Promise<void> {
    setAiChecking(true);
    try {
      // 异步 AI 检查（§3.3）：POST 启动 job → 轮询 GET /ai-jobs/:id 至 completed/failed。
      // 模型通道最长可运行 120s；客户端留出传输余量，并把轮询降为 1s 以避免无意义请求压力。
      const start = await required(api, "runSkillAiChecks")(slug, sourceAgent);
      const deadline = Date.now() + AI_JOB_POLL_TIMEOUT_MS;
      while (Date.now() <= deadline) {
        const job = await required(api, "getAiJob")(start.jobId);
        if (job.status === "completed" && job.result !== null) {
          setAiChecksResult(job.result);
          toast.success(sd.aiCheckCompleted);
          return;
        }
        if (job.status === "failed") {
          toast.danger(sd.aiCheckFailed + " " + (job.error ?? sd.aiJobErrorFallback));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, AI_JOB_POLL_INTERVAL_MS));
      }
      toast.danger(sd.aiCheckFailed + " " + sd.aiPollTimeout);
    } catch (reason) { toast.danger(sd.aiCheckFailed + " " + apiError(reason, t)); }
    finally { setAiChecking(false); }
  }

  async function runDiff(): Promise<void> {
    setDiffLoading(true);
    try {
      const files = await required(api, "diffSkillDraft")(slug, sourceAgent);
      setDiffFiles(files);
      setSelectedFile(0);
    } catch (reason) { toast.danger(apiError(reason, t)); }
    finally { setDiffLoading(false); }
  }

  async function publish(): Promise<void> {
    if (draft === null || publishPending || !isSkillTargetAgent(sourceAgent)) return;
    setPublishPending(true);
    try {
      const result = await required(api, "publishSkill")(slug, {
        version: resolvedPublishVersion,
        sourceAgent,
        draftRevision: draft.revision,
        releaseNote: resolvedPublishNote
      });
      setPublishing(false);
      setPublishVersion("");
      setPublishNote("");
      toast.success(sd.publishCompleted.replace("{version}", result.release.version));
      onPublished();
    } catch (reason) { toast.danger(apiError(reason, t)); }
    finally { setPublishPending(false); }
  }

  async function discard(): Promise<void> {
    try {
      await required(api, "discardSkillDraft")(slug, sourceAgent, draft?.revision ?? 0);
      setDiscarding(false);
      toast.info(sd.draftDiscardedNotice);
      onPublished();
    } catch (reason) { toast.danger(apiError(reason, t)); }
  }

  async function previewFix(checkIds: string[] | null): Promise<void> {
    setCheckDialog(null);
    setFixing(true);
    try {
      const plan = await required(api, "previewSkillFix")(slug, sourceAgent, checkIds);
      setFixPlan(plan);
      setFixCheckIds(checkIds);
      setFixPreviewRun(true);
    } catch (reason) { toast.danger(apiError(reason, t)); }
    finally { setFixing(false); }
  }

  async function applyFix(checkIds: string[] | null): Promise<void> {
    setFixing(true);
    try {
      await required(api, "applySkillFix")(slug, sourceAgent, checkIds);
      setFixPlan(null);
      setFixPreviewRun(false);
      toast.success(sd.fixApplied);
      onPublished();
    } catch (reason) { toast.danger(apiError(reason, t)); }
    finally { setFixing(false); }
  }

  async function aiGenerateReleaseNote(): Promise<void> {
    setGeneratingReleaseNote(true);
    try {
      const result = await required(api, "generateReleaseNote")(slug, sourceAgent);
      if (result.releaseNote === null || result.degraded === true) {
        toast.danger(sd.aiGenerateFailed);
      } else {
        setPublishNote(result.releaseNote);
      }
    } catch {
      toast.danger(sd.aiGenerateFailed);
    } finally {
      setGeneratingReleaseNote(false);
    }
  }

  function openFixSuggestion(checkId: string): void {
    const plan = fixPlanFromAiChecks(aiChecksResult, [checkId]);
    if (plan.items.length === 0) {
      toast.info(sd.suggestionUnavailable);
      return;
    }
    setCheckDialog(null);
    setFixSuggestions(plan);
    setEditingSuggestionId(null);
    setEditedSuggestionContent("");
  }

  async function adoptFixSuggestion(item: FixPlanItem, suggestedContent = item.suggestedContent ?? ""): Promise<void> {
    setAdoptingSuggestion(true);
    try {
      const before = latestDraftRef.current;
      const updated = await required(api, "applyFixSuggestion")(slug, sourceAgent, {
        checkId: item.checkId,
        suggestedContent,
        appliesTo: item.appliesTo ?? null
      });
      latestDraftRef.current = updated;
      setSuggestionDiffFiles(diffAppliedSuggestion(before, updated));
      setDiffView("suggestion");
      setSelectedFile(0);
      setAiChecksResult(updated.aiChecks);
      const visibleIds = fixSuggestions?.items.map((entry) => entry.checkId) ?? [item.checkId];
      const updatedPlan = fixPlanFromAiChecks(updated.aiChecks, visibleIds);
      if (updatedPlan.items.length > 0) {
        setFixSuggestions(updatedPlan);
      } else {
        setFixSuggestions((current) => current === null ? null : ({
          ...current,
          items: current.items.map((entry) => entry.checkId === item.checkId ? {
            ...entry,
            suggestedContent,
            applicationState: "applied",
            appliedAt: new Date().toISOString()
          } : entry)
        }));
      }
      setEditingSuggestionId(null);
      setEditedSuggestionContent("");
      toast.success(sd.suggestionAdopted);
      await runDiff();
      onPublished();
    } catch (reason) { toast.danger(apiError(reason, t)); }
    finally { setAdoptingSuggestion(false); }
  }

  async function copyFixSuggestion(item: FixPlanItem): Promise<void> {
    if (item.suggestedContent === null || item.suggestedContent === undefined || navigator.clipboard === undefined) return;
    await navigator.clipboard.writeText(item.suggestedContent);
    toast.success(sd.suggestionCopied);
  }

  return <div className="check-publish-layout" data-slot="check-publish-layout">
    <div className="check-workbench-toolbar" data-slot="check-workbench-toolbar">
      <section className="check-draft-source" data-slot="draft-source">
        <div className="check-action-heading"><strong>{sd.draftSourceTitle}</strong><span>{sd.draftSourceHint}</span></div>
        {isSkillTargetAgent(sourceAgent)
          ? <SkillUploadPanel className="skill-upload-panel-compact" api={api} agent={sourceAgent} hasDraft={draft !== null} onUploaded={() => onPublished()} />
          : null}
      </section>
      {draft === null ? null : <section className="check-action-board" data-slot="check-action-board">
        <div className="check-action-group check-action-required" data-slot="required-check-actions">
          <div className="check-action-heading"><strong>{sd.requiredChecks}</strong><span>{sd.requiredChecksHint}</span></div>
          <div className="check-action-buttons">
            <button type="button" className="primary" disabled={checking} onClick={() => void runChecks()}>{checking ? sd.checkRunning : sd.checkAction}</button>
            {autoFixableChecks.length === 0 ? null : <button type="button" className="secondary" disabled={fixing} onClick={() => void previewFix(autoFixableChecks.map((check) => check.id))}>{sd.oneClickFix}</button>}
          </div>
        </div>
        <div className="check-action-group check-action-ai" data-slot="ai-advisory-actions">
          <div className="check-action-heading">
            <div className="check-action-title-line"><strong>{sd.optionalAi}</strong><button type="button" className="analysis-policy-chip" onClick={() => setAiPolicyOpen(true)}>{sd.viewAiPolicy}</button></div>
            <span>{sd.optionalAiHint}</span>
          </div>
          <div className="check-action-buttons">
            <button type="button" className="secondary" disabled={aiChecking} onClick={() => void runAiChecks()}>{aiChecking ? sd.aiCheckRunning : sd.aiCheckAction}</button>
          </div>
        </div>
        <div className="check-action-group check-action-release" data-slot="release-actions">
          <div className="check-action-heading"><strong>{sd.releaseActions}</strong><span>{sd.releaseActionsHint}</span></div>
          <div className="check-action-buttons">
            {isSkillTargetAgent(sourceAgent) ? <button type="button" className={summary.red > 0 ? "danger" : "primary"} onClick={() => { setPublishVersion(defaultPublishVersion); setPublishNote(sd.defaultPublishModalNote); setPublishing(true); }}>{sd.publishAction}</button> : null}
            <button type="button" className="secondary" onClick={() => setDiscarding(true)}>{sd.discardAction}</button>
          </div>
          {summary.red > 0 ? <span className="publish-warning">{sd.redPublishWarning}</span> : null}
        </div>
      </section>}
    </div>
    {draft === null ? <Empty>{sd.draftEmpty}</Empty> : <>
    <div className="check-metrics" data-slot="check-metrics">
      {metricCards.map((metric) => <button type="button" data-slot={metric.slot} aria-haspopup="dialog" className={`check-metric-card check-metric-${metric.key}`} key={metric.key} onClick={() => setCheckDialog(metric.key)}>
        <strong>{metric.count}</strong>
        <span>{metric.title}</span>
        <small>{metric.description}</small>
      </button>)}
    </div>
    <section className="default-version-diff" data-slot="default-version-diff" data-diff-view={diffView} aria-busy={diffLoading && diffView === "release"}>
      <div className="default-version-diff-heading">
        <div className="default-version-diff-title"><span className="config-card-label">{diffView === "suggestion" ? sd.suggestionDiffTitle : sd.versionDiff}</span><strong>{sd.changedFiles}</strong></div>
        <div className="default-version-diff-actions" data-slot="diff-view-actions">
          {suggestionDiffFiles === null ? null : <div className="diff-view-switch" data-slot="diff-view-switch" aria-label={sd.diffViewLabel}>
            <button type="button" data-slot="suggestion-diff-view" aria-pressed={diffView === "suggestion"} onClick={() => { setDiffView("suggestion"); setSelectedFile(0); }}>{sd.suggestionDiffView}</button>
            <button type="button" data-slot="release-diff-view" aria-pressed={diffView === "release"} onClick={() => { setDiffView("release"); setSelectedFile(0); }}>{sd.releaseDiffView}</button>
          </div>}
          {diffView === "release" ? <button type="button" className="secondary compact-button" disabled={diffLoading} onClick={() => void runDiff()}>{diffLoading ? sd.loadingDiff : sd.refreshDiff}</button> : null}
        </div>
      </div>
      {diffLoading && diffView === "release" && activeDiffFiles.length === 0
        ? <div className="diff-loading" role="status">{sd.loadingDiff}</div>
        : activeDiffFiles.length === 0
          ? <Empty>{diffView === "suggestion" ? sd.suggestionDiffNoChange : sd.diffNoChange}</Empty>
          : <div className="version-diff-workbench">
            <aside className="version-file-tree" data-slot="version-file-tree-scroll" aria-label={sd.changedFiles}>
              <div className="version-file-tree-title">{sd.changedFiles}</div>
              {activeDiffFiles.map((file, index) => <button type="button" className={index === selectedFile ? "selected" : ""} key={file.path} onClick={() => setSelectedFile(index)}>
                <span className={`file-change-dot file-change-${file.status}`} />
                <span>{file.path}</span>
                <small>{sd.diffStatus[file.status]}</small>
              </button>)}
            </aside>
            <div className="version-diff-pane">
              <div className="diff-column-title"><span>{diffView === "suggestion" ? sd.beforeSuggestion : sd.currentPublishedVersion}</span></div>
              <pre>{publishedLines.map((line, index) => <span className={line !== (draftLines[index] ?? "") ? "diff-line diff-line-old" : "diff-line"} key={`old-${index}`}>{line || " "}</span>)}</pre>
            </div>
            <div className="version-diff-pane">
              <div className="diff-column-title"><span>{diffView === "suggestion" ? sd.afterSuggestion : sd.stagedDraftVersion}</span></div>
              <pre>{draftLines.map((line, index) => <span className={line !== (publishedLines[index] ?? "") ? "diff-line diff-line-new" : "diff-line"} key={`new-${index}`}>{line || " "}</span>)}</pre>
            </div>
          </div>}
    </section>
    </>}
    <Modal open={checkDialog !== null} onClose={() => setCheckDialog(null)} title={checkDialogTitle} closeLabel={sd.close} wide>
      <div className="check-results-dialog" data-slot="check-results-dialog">
        <p className="check-results-intro">{checkDialog === "ai" ? sd.aiResultsHint : sd.requiredResultsHint}</p>
        {selectedChecks.length === 0 ? <Empty>{sd.noCheckResults}</Empty> : <div className="check-list check-dialog-list">
          {selectedChecks.map((check) => <article className={`check-row check-row-${check.status}`} key={check.id}>
            <CheckLight status={check.status} />
            <div>
              <div className="check-row-heading"><strong>{check.label}</strong>{checkDialog === "ai" ? <span className="ai-advisory-badge">{sd.aiAdvisoryBadge}</span> : null}</div>
              <p>{check.message}</p>
              {check.filePath === null ? null : <code>{check.filePath}</code>}
            </div>
            {check.fixable && check.status !== "green" && checkDialog !== "ai"
              ? <button type="button" className="secondary" disabled={fixing} onClick={() => void previewFix([check.id])}>{sd.applyFix}</button>
              : checkDialog !== "ai"
                ? null
                : check.status === "green"
                  ? <span className="ai-suggestion-state ai-suggestion-passed">{sd.suggestionNotNeeded}</span>
                  : check.suggestion === null || check.suggestion === undefined
                    ? <span className="ai-suggestion-state ai-suggestion-missing">{sd.suggestionUnavailableShort}</span>
                    : <button type="button" className="secondary" onClick={() => openFixSuggestion(check.id)}>
                        {check.suggestion.applicationState === "applied"
                          ? sd.viewAppliedSuggestion
                          : check.fixable ? sd.viewAndApplySuggestion : sd.viewSuggestion}
                      </button>}
          </article>)}
        </div>}
      </div>
    </Modal>
    <Modal open={aiPolicyOpen} onClose={() => setAiPolicyOpen(false)} title={sd.aiPolicyTitle} closeLabel={sd.close} wide>
      <div className="ai-policy-dialog" data-slot="ai-policy-dialog">
        <div className="ai-policy-principles">
          <span className="config-card-label">{sd.aiPolicyPrinciples}</span>
          <ul>{SKILL_AI_POLICY_PRINCIPLES.map((principle) => <li key={principle}>{principle}</li>)}</ul>
        </div>
        <div className="ai-policy-grid">
          {SKILL_AI_CHECK_POLICY.map((item, index) => <article key={item.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div><strong>{item.label}</strong><p>{item.description}</p><code>{item.id}</code></div>
          </article>)}
        </div>
        <p className="ai-policy-footnote">{sd.aiPolicyFootnote}</p>
      </div>
    </Modal>
    <Modal
      open={fixPreviewRun && fixPlan !== null}
      onClose={() => { setFixPlan(null); setFixPreviewRun(false); }}
      title={sd.fixPreview}
      closeLabel={sd.close}
      wide
      footer={<>
        <button type="button" disabled={fixing || (fixPlan?.items.length ?? 0) === 0} onClick={() => void applyFix(fixCheckIds)}>{sd.applyFix}</button>
        <button type="button" className="secondary" onClick={() => { setFixPlan(null); setFixPreviewRun(false); }}>{sd.cancelEdit}</button>
      </>}
    >
      {fixPlan === null || fixPlan.items.length === 0 ? <Empty>{sd.fixEmpty}</Empty> : <div className="version-diff-workbench fix-preview-workbench">
        <aside className="version-file-tree">
          <div className="version-file-tree-title">{sd.fixItems}</div>
          {fixPlan.items.map((item) => <div className="check-row" key={item.checkId}>
            <span className={`fix-action fix-action-${item.action}`}>{(t.status as Record<string, string>)[item.action] ?? item.action}</span>
            <div><strong>{item.label}</strong><p>{item.message}</p>{item.riskDelta === null ? null : <small className="risk">{sd.riskDelta}: {item.riskDelta}</small>}{item.riskDelta !== null && item.riskDelta.includes("degraded") ? <p className="degraded-fix-notice" data-testid="degraded-fix-notice">{sd.fixDegradedHint}</p> : null}</div>
          </div>)}
        </aside>
        <div className="version-diff-pane">
          <div className="diff-column-title"><span>{sd.currentPublishedVersion}</span></div>
          <pre>{(fixPlan.mergedFiles[0]?.publishedContent ?? "").split("\n").map((line, index) => <span className="diff-line diff-line-old" key={`fix-old-${index}`}>{line || " "}</span>)}</pre>
        </div>
        <div className="version-diff-pane">
          <div className="diff-column-title"><span>{sd.stagedDraftVersion}</span></div>
          <pre>{(fixPlan.mergedFiles[0]?.draftContent ?? "").split("\n").map((line, index) => <span className="diff-line diff-line-new" key={`fix-new-${index}`}>{line || " "}</span>)}</pre>
        </div>
      </div>}
    </Modal>
    <Modal open={fixSuggestions !== null} onClose={() => { setFixSuggestions(null); setEditingSuggestionId(null); }} title={sd.fixSuggestions} closeLabel={sd.close} wide>
      {fixSuggestions === null || fixSuggestions.items.length === 0 ? <Empty>{sd.fixEmpty}</Empty> : <div className="fix-suggestion-dialog">
        <header className="fix-suggestion-dialog-hero">
          <div><strong>{fixSuggestions.items.length}</strong><span>{sd.fixItems}</span></div>
          <p>{sd.suggestionDialogHint}</p>
        </header>
        <div className="fix-suggestion-list fix-suggestion-dialog-list">
          {fixSuggestions.items.map((item, index) => {
            const editing = editingSuggestionId === item.checkId;
            const editedItem = { ...item, suggestedContent: editedSuggestionContent };
            const applicable = canAdoptSuggestion(item);
            const applied = item.applicationState === "applied";
            const tone = applied ? "applied" : applicable ? "ready" : "manual";
            return <article className={`fix-suggestion-card fix-suggestion-${tone}`} key={item.checkId}>
              <header className="fix-suggestion-card-head">
                <div className="fix-suggestion-title">
                  <span className="fix-suggestion-index">{String(index + 1).padStart(2, "0")}</span>
                  <div><strong>{item.label}</strong><small>{item.affectedPaths.join(" · ") || sd.suggestionFinding}</small></div>
                </div>
                <div className="fix-suggestion-badges">
                  {item.appliesTo === null || item.appliesTo === undefined ? null : <span className="fix-suggestion-target">{appliesToLabel(item.appliesTo, sd)}</span>}
                  <span className={`fix-suggestion-state fix-suggestion-state-${tone}`}>{applied ? sd.suggestionApplied : applicable ? sd.suggestionReady : sd.suggestionManual}</span>
                </div>
              </header>
              <div className="fix-suggestion-grid">
                <section className="fix-suggestion-finding">
                  <span className="config-card-label">{sd.suggestionFinding}</span>
                  <p>{item.message}</p>
                  {item.explanation === null || item.explanation === undefined ? null : <div className="fix-suggestion-explanation"><span>{sd.suggestionExplanation}</span><p>{item.explanation}</p></div>}
                </section>
                <section className="fix-suggestion-proposal">
                  <span className="config-card-label">{sd.suggestionProposal}</span>
                  {item.suggestedContent === null || item.suggestedContent === undefined
                    ? <p className="manual-suggestion-hint">{sd.manualSuggestionHint}</p>
                    : editing
                      ? <label className="fix-suggestion-editor"><span>{sd.suggestionContent}</span><textarea aria-label={sd.suggestionContent} value={editedSuggestionContent} onChange={(event) => setEditedSuggestionContent(event.target.value)} /></label>
                      : <pre>{formatSuggestionContent(item)}</pre>}
                </section>
              </div>
              <footer className="fix-suggestion-footer">
                <span>{applied ? sd.suggestionSnapshotHint : applicable ? sd.suggestionSnapshotHint : sd.manualSuggestionHint}</span>
                <div className="fix-suggestion-actions">
                  {applicable && !editing ? <>
                    <button type="button" disabled={adoptingSuggestion} onClick={() => void adoptFixSuggestion(item)}>{sd.applyDirectly}</button>
                    <button type="button" className="secondary" onClick={() => { setEditingSuggestionId(item.checkId); setEditedSuggestionContent(formatSuggestionContent(item)); }}>{sd.editBeforeApply}</button>
                  </> : null}
                  {editing ? <>
                    <button type="button" disabled={adoptingSuggestion || !canAdoptSuggestion(editedItem)} onClick={() => void adoptFixSuggestion(item, editedSuggestionContent)}>{sd.applyEditedContent}</button>
                    <button type="button" className="secondary" onClick={() => { setEditingSuggestionId(null); setEditedSuggestionContent(""); }}>{sd.cancelEdit}</button>
                  </> : null}
                  {!applicable && !editing && typeof item.suggestedContent === "string" ? <button type="button" className="secondary" onClick={() => void copyFixSuggestion(item)}>{sd.copySuggestion}</button> : null}
                </div>
              </footer>
            </article>;
          })}
        </div>
      </div>}
    </Modal>
    {!publishing ? null : <div className="modal-backdrop" role="presentation" onClick={() => setPublishing(false)}>
      <div className="publish-modal" role="dialog" aria-modal="true" aria-labelledby="publish-modal-title" onClick={(event) => event.stopPropagation()}>
        <div className="panel-title">
          <h2 id="publish-modal-title">{sd.publishConfirmTitle}</h2>
          <button type="button" className="icon-button" aria-label={sd.close} onClick={() => setPublishing(false)}>×</button>
        </div>
        <div className="publish-hero-grid">
          <article className="publish-version-card">
            <div className="publish-version-pair">
              <label className="version-stepper"><span>{sd.newVersion}</span><input value={resolvedPublishVersion} onChange={(event) => setPublishVersion(event.target.value)} /><span className="version-stepper-actions"><button type="button" aria-label={sd.increaseVersion} onClick={() => setPublishVersion(shiftPatchVersion(resolvedPublishVersion, 1))}>↑</button><button type="button" aria-label={sd.decreaseVersion} onClick={() => setPublishVersion(shiftPatchVersion(resolvedPublishVersion, -1))}>↓</button></span></label>
            </div>
          </article>
          <article className="publish-target-card"><span>{sd.publishTarget}</span><strong>{slug}</strong><small>{summary.red > 0 ? sd.publishHasWarnings : sd.publishReady}</small></article>
        </div>
        <div className="publish-summary-grid">
          <article className="summary-changed"><strong>{stats.changedFiles}</strong><span>{sd.changedFiles}</span></article>
          <article className="summary-modified"><strong>{stats.modifiedFiles}</strong><span>{sd.modifiedFiles}</span></article>
          <article className="summary-added"><strong>{stats.addedFiles}</strong><span>{sd.addedFiles}</span></article>
          <article className="summary-lines"><strong>{stats.changedLines}</strong><span>{sd.changedLines}</span></article>
        </div>
        <div className="publish-note-field">
          <div className="publish-note-heading">
            <span className="config-card-label">{sd.releaseNote}</span>
            <button type="button" className="secondary" disabled={generatingReleaseNote} onClick={() => void aiGenerateReleaseNote()}>{sd.aiGenerate}</button>
          </div>
          <label className="release-note-editor">
            <textarea value={resolvedPublishNote} onChange={(event) => setPublishNote(event.target.value)} aria-label={sd.releaseNote} />
          </label>
        </div>
        <div className="publish-modal-footer">
          <span>{sd.publishModalHint}</span>
          <div className="editable-card-actions">
            <button type="button" disabled={publishPending} onClick={() => void publish()}>{publishPending ? "…" : sd.confirmPublish}</button>
            <button type="button" className="secondary" onClick={() => setPublishing(false)}>{sd.cancelEdit}</button>
          </div>
        </div>
      </div>
    </div>}
    {!discarding ? null : <div className="modal-backdrop" role="presentation" onClick={() => setDiscarding(false)}>
      <div className="publish-modal" role="dialog" aria-modal="true" aria-labelledby="discard-modal-title" onClick={(event) => event.stopPropagation()}>
        <div className="panel-title">
          <h2 id="discard-modal-title">{sd.discardAction}</h2>
          <button type="button" className="icon-button" aria-label={sd.close} onClick={() => setDiscarding(false)}>×</button>
        </div>
        <p>{sd.discardConfirm}</p>
        <div className="publish-modal-footer">
          <div className="editable-card-actions">
            <button type="button" onClick={() => void discard()}>{sd.confirmDiscard}</button>
            <button type="button" className="secondary" onClick={() => setDiscarding(false)}>{sd.cancelEdit}</button>
          </div>
        </div>
      </div>
    </div>}
  </div>;
}

function VersionHistoryPanel({ versions, t }: {
  versions: readonly RegistrySkillVersion[];
  t: ReturnType<typeof useI18n>["t"]["skillDetail"];
}) {
  // 按 created_at 倒序（最新在前）；previous = 倒序下一个 = 时序上一版本。
  // 显式 sort 防御 server 返回顺序不确定（设计文档「已有倒序」在此前置为强约束）。
  const seenVersions = new Set<string>();
  const sharedVersions = [...versions]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .filter((version) => {
      if (seenVersions.has(version.version)) return false;
      seenVersions.add(version.version);
      return true;
    });
  const [selectedVersion, setSelectedVersion] = useState(sharedVersions[0]?.version ?? "");
  const [selectedDiffFile, setSelectedDiffFile] = useState(0);
  if (sharedVersions.length === 0) return <Empty>{t.noVersionHistory}</Empty>;
  const currentIndex = sharedVersions.findIndex((v) => v.version === selectedVersion);
  const current = currentIndex >= 0 ? sharedVersions[currentIndex] : sharedVersions[0];
  if (current === undefined) return <Empty>{t.noVersionHistory}</Empty>;
  const previous = currentIndex >= 0 ? sharedVersions[currentIndex + 1] : undefined;
  const diffFiles = previous === undefined ? [] : computeDiff(previous.sourceFiles, current.sourceFiles);
  const stats = diffStats(diffFiles);
  const activeDiffFile = diffFiles[selectedDiffFile] ?? diffFiles[0];
  const publishedLines = (activeDiffFile?.publishedContent ?? "").split("\n");
  const draftLines = (activeDiffFile?.draftContent ?? "").split("\n");

  function selectVersion(version: string): void {
    setSelectedVersion(version);
    setSelectedDiffFile(0);
  }

  return <div className="version-history-workbench">
    <aside className="version-history-list">
      <div className="version-file-tree-title">{t.versionHistory}</div>
      {sharedVersions.map((v) => <button type="button" className={v.version === current.version ? "selected" : ""} key={v.version} onClick={() => selectVersion(v.version)}>
        <strong>v{v.version}</strong>
        <span>{new Date(v.created_at).toLocaleString()}</span>
        <small>{v.source_proposal_id ?? t.bootstrapSource}</small>
      </button>)}
    </aside>
    <section className="version-history-main">
      <article className="release-note-card">
        <div className="editable-card-heading">
          <div><span className="config-card-label">{t.releaseNote}</span><h3>v{current.version}</h3></div>
          <small>v{current.version} · {t.artifactsCount.replace("{count}", String(current.artifacts.length))}</small>
        </div>
        <p>{current.changeNote ?? t.defaultReleaseNote}</p>
      </article>
      {previous === undefined
        ? <Empty>{t.initialVersion}</Empty>
        : diffFiles.length === 0
          ? <Empty>{t.noVersionDiff}</Empty>
          : <div className="version-diff-workbench">
            <div className="version-diff-stats">
              <span><strong>{stats.addedFiles}</strong>{t.addedFiles}</span>
              <span><strong>{stats.modifiedFiles}</strong>{t.modifiedFiles}</span>
              <span><strong>{stats.removedFiles}</strong>{t.removedFiles}</span>
              <span><strong>{stats.changedLines}</strong>{t.changedLines}</span>
            </div>
            <aside className="version-file-tree">
              <div className="version-file-tree-title">{t.changedFiles}</div>
              {diffFiles.map((file, index) => <button type="button" className={index === selectedDiffFile ? "selected" : ""} key={file.path} onClick={() => setSelectedDiffFile(index)}>
                <span className={`file-change-dot file-change-${file.status}`} />
                <span>{file.path}</span>
                <small>{t.diffStatus[file.status]}</small>
              </button>)}
            </aside>
            <div className="version-diff-pane">
              <div className="diff-column-title"><span>{t.previousVersion}</span></div>
              <pre>{publishedLines.map((line, index) => <span className={line !== (draftLines[index] ?? "") ? "diff-line diff-line-old" : "diff-line"} key={`old-${index}`}>{line || " "}</span>)}</pre>
            </div>
            <div className="version-diff-pane">
              <div className="diff-column-title"><span>{t.selectedVersion}</span></div>
              <pre>{draftLines.map((line, index) => <span className={line !== (publishedLines[index] ?? "") ? "diff-line diff-line-new" : "diff-line"} key={`new-${index}`}>{line || " "}</span>)}</pre>
            </div>
          </div>}
      {current.examples.length === 0 ? null : <div className="usage-example-grid">
        {current.examples.map((example, index) => <article className="usage-example-card" key={example.title}>
          <span className="config-card-label">{t.exampleLabel.replace("{index}", String(index + 1).padStart(2, "0"))}</span>
          <h3>{example.title}</h3>
          <p>{example.description}</p>
        </article>)}
      </div>}
    </section>
  </div>;
}

export {
  AgentCheckPanel,
  VersionHistoryPanel
};
