import { useEffect, useRef, useState } from "react";

import type { HunterApi } from "../api/client.js";
import { ChangePlanner } from "../components/change-planner.js";
import { RequirementEditor } from "../components/requirement-editor.js";

type ProjectApi = Pick<HunterApi, "getProject" | "createRequirement" | "approveRequirement">
  & Partial<Pick<HunterApi, "publishChange">>;
type ProjectView = Awaited<ReturnType<ProjectApi["getProject"]>>;
type RequirementView = ProjectView["requirements"][number];
type RequirementStatus = RequirementView["status"];

type StatusPresentation =
  | { readonly label: string; readonly className: string; readonly approvable: true }
  | { readonly label: string; readonly className: string; readonly approvable: false; readonly terminalNote: string };

const STATUS_PRESENTATION: { readonly [Status in RequirementStatus]: StatusPresentation } = {
  draft: { label: "草稿", className: "status-draft", approvable: true },
  in_review: { label: "评审中", className: "status-review", approvable: true },
  approved: { label: "已批准", className: "status-approved", approvable: false, terminalNote: "此版本已批准且不可修改" },
  superseded: { label: "已被取代", className: "status-superseded", approvable: false, terminalNote: "此版本已被取代，不能再批准或修改" },
  withdrawn: { label: "已撤回", className: "status-withdrawn", approvable: false, terminalNote: "此版本已撤回，不能再批准或修改" },
};

export function ProjectPage({
  projectId,
  api,
  onBack,
  onOpenKnowledge,
}: {
  readonly projectId: string;
  readonly api: ProjectApi;
  readonly onBack: () => void;
  readonly onOpenKnowledge?: (() => void) | undefined;
}) {
  const [project, setProject] = useState<ProjectView>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busyRevisionId, setBusyRevisionId] = useState<string>();
  const projectEpoch = useRef(0);

  useEffect(() => {
    const epoch = projectEpoch.current + 1;
    projectEpoch.current = epoch;
    setProject(undefined);
    setLoading(true);
    setError(undefined);
    setBusyRevisionId(undefined);
    void api.getProject(projectId)
      .then((response) => { if (projectEpoch.current === epoch) setProject(response); })
      .catch(() => { if (projectEpoch.current === epoch) setError("无法加载项目，请返回后重试"); })
      .finally(() => { if (projectEpoch.current === epoch) setLoading(false); });
    return () => {
      if (projectEpoch.current === epoch) projectEpoch.current = epoch + 1;
    };
  }, [api, projectId]);

  const approve = async (revision: RequirementView) => {
    const epoch = projectEpoch.current;
    const targetProjectId = projectId;
    setBusyRevisionId(revision.revisionId);
    setError(undefined);
    try {
      const approved = await api.approveRequirement(projectId, revision.revisionId, revision.aggregateVersion);
      if (projectEpoch.current !== epoch) return;
      setProject((current) => current === undefined || current.projectId !== targetProjectId ? current : {
        ...current,
        requirements: current.requirements.map((item) => item.revisionId === approved.revisionId ? approved : item),
      });
    } catch {
      if (projectEpoch.current === epoch) setError("无法批准此需求版本，请确认它仍是草稿");
    } finally {
      if (projectEpoch.current === epoch) setBusyRevisionId(undefined);
    }
  };

  if (loading || (project !== undefined && project.projectId !== projectId)) return <main className="page-shell"><p role="status">正在加载项目…</p></main>;
  if (project === undefined) return <main className="page-shell"><p role="alert" className="message error-message">{error ?? "项目不存在"}</p></main>;
  const approvedRequirementRevisionIds = project.requirements
    .filter((revision) => revision.status === "approved")
    .map((revision) => revision.revisionId);
  const publishChange = api.publishChange?.bind(api);

  return (
    <main className="page-shell" aria-busy={busyRevisionId !== undefined}>
      <nav aria-label="项目导航">
        <button className="button button-quiet" type="button" onClick={onBack}>← 返回项目</button>
        {onOpenKnowledge === undefined ? null : (
          <button className="button button-secondary" type="button" onClick={onOpenKnowledge}>
            查看 Knowledge
          </button>
        )}
      </nav>
      <header className="page-header detail-header">
        <div>
          <p className="eyebrow">Project</p>
          <h1>{project.name}</h1>
          <code>{project.projectId}</code>
        </div>
        <span className="count-label">{project.requirements.length} 个版本</span>
      </header>
      {error === undefined ? null : <p role="alert" className="message error-message">{error}</p>}

      <div className="detail-grid">
        <section className="panel editor-panel" aria-label="需求编辑器">
          <RequirementEditor key={projectId} onSave={async (input) => {
            const epoch = projectEpoch.current;
            const targetProjectId = projectId;
            const created = await api.createRequirement(projectId, input);
            if (projectEpoch.current !== epoch) return;
            setProject((current) => current === undefined || current.projectId !== targetProjectId ? current : {
              ...current,
              requirements: [...current.requirements, created],
            });
          }} />
        </section>

        <section className="history-panel" aria-labelledby="revision-history-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">History</p>
              <h2 id="revision-history-title">需求版本</h2>
            </div>
          </div>
          {project.requirements.length === 0 ? (
            <div className="empty-state"><strong>暂无需求版本</strong><p>保存左侧草稿后，版本会显示在这里。</p></div>
          ) : null}
          <div className="revision-list">
            {project.requirements.map((revision) => {
              const presentation = STATUS_PRESENTATION[revision.status];
              const busy = busyRevisionId === revision.revisionId;
              return (
                <article className="revision-card" key={revision.revisionId}>
                  <div className="revision-meta">
                    <code>{revision.revisionId}</code>
                    <span className={`status ${presentation.className}`}>{presentation.label}</span>
                  </div>
                  <h3>{revision.title}</h3>
                  <p>{revision.body}</p>
                  <h4>验收标准</h4>
                  <ul>{revision.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
                  {revision.constraints.length === 0 ? null : <><h4>约束条件</h4><ul>{revision.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}</ul></>}
                  {presentation.approvable ? (
                    <button className="button button-primary" type="button" disabled={busy} onClick={() => void approve(revision)}>
                      {busy ? "正在批准…" : "批准此版本"}
                    </button>
                  ) : <p className="immutable-note">{presentation.terminalNote}</p>}
                </article>
              );
            })}
          </div>
        </section>
      </div>
      <section className="planning-section" aria-label="Change 规划">
        {approvedRequirementRevisionIds.length === 0 ? (
          <div className="empty-state"><strong>暂无可规划的已批准需求</strong><p>未批准版本不会进入 Change。批准至少一个需求版本后可继续。</p></div>
        ) : project.planningDefaults === undefined || publishChange === undefined ? (
          <p role="status" className="message notice-message">执行规划上下文尚未配置。请由受信任的 Hunter 宿主提供仓库、工作流与 Agent Profile 的领域 ID。</p>
        ) : (
          <ChangePlanner
            requirementRevisionIds={approvedRequirementRevisionIds}
            planningDefaults={project.planningDefaults}
            onPublish={(input) => publishChange(projectId, input)}
          />
        )}
      </section>
    </main>
  );
}
