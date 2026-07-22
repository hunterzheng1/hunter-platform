import { useEffect, useState } from "react";

import type { HunterApi } from "../api/client.js";
import { RequirementEditor } from "../components/requirement-editor.js";

type ProjectApi = Pick<HunterApi, "getProject" | "createRequirement" | "approveRequirement">;
type ProjectView = Awaited<ReturnType<ProjectApi["getProject"]>>;
type RequirementView = ProjectView["requirements"][number];

export function ProjectPage({
  projectId,
  api,
  onBack,
}: {
  readonly projectId: string;
  readonly api: ProjectApi;
  readonly onBack: () => void;
}) {
  const [project, setProject] = useState<ProjectView>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busyRevisionId, setBusyRevisionId] = useState<string>();

  useEffect(() => {
    let current = true;
    void api.getProject(projectId)
      .then((response) => { if (current) setProject(response); })
      .catch(() => { if (current) setError("无法加载项目，请返回后重试"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, projectId]);

  const approve = async (revision: RequirementView) => {
    setBusyRevisionId(revision.revisionId);
    setError(undefined);
    try {
      const approved = await api.approveRequirement(projectId, revision.revisionId);
      setProject((current) => current === undefined ? current : {
        ...current,
        requirements: current.requirements.map((item) => item.revisionId === approved.revisionId ? approved : item),
      });
    } catch {
      setError("无法批准此需求版本，请确认它仍是草稿");
    } finally {
      setBusyRevisionId(undefined);
    }
  };

  if (loading) return <main className="page-shell"><p role="status">正在加载项目…</p></main>;
  if (project === undefined) return <main className="page-shell"><p role="alert" className="message error-message">{error ?? "项目不存在"}</p></main>;

  return (
    <main className="page-shell" aria-busy={busyRevisionId !== undefined}>
      <nav aria-label="项目导航">
        <button className="button button-quiet" type="button" onClick={onBack}>← 返回项目</button>
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
          <RequirementEditor onSave={async (input) => {
            const created = await api.createRequirement(projectId, input);
            setProject((current) => current === undefined ? current : {
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
              const approved = revision.status === "approved";
              const busy = busyRevisionId === revision.revisionId;
              return (
                <article className="revision-card" key={revision.revisionId}>
                  <div className="revision-meta">
                    <code>{revision.revisionId}</code>
                    <span className={`status ${approved ? "status-approved" : "status-draft"}`}>{approved ? "已批准" : "草稿"}</span>
                  </div>
                  <h3>{revision.title}</h3>
                  <p>{revision.body}</p>
                  <h4>验收标准</h4>
                  <ul>{revision.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
                  {revision.constraints.length === 0 ? null : <><h4>约束条件</h4><ul>{revision.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}</ul></>}
                  {approved ? (
                    <p className="immutable-note">此版本已批准且不可修改</p>
                  ) : (
                    <button className="button button-primary" type="button" disabled={busy} onClick={() => void approve(revision)}>
                      {busy ? "正在批准…" : "批准此版本"}
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
