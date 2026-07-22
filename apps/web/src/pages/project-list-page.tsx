import { useEffect, useState, type FormEvent } from "react";

import type { HunterApi } from "../api/client.js";

type ProjectsApi = Pick<HunterApi, "listProjects" | "createProject">;
type ListedProject = Awaited<ReturnType<ProjectsApi["listProjects"]>>["projects"][number];
type ListedProjectId = ListedProject["projectId"];

export function ProjectListPage({
  api,
  onOpen,
}: {
  readonly api: ProjectsApi;
  readonly onOpen: (projectId: string) => void;
}) {
  const [projects, setProjects] = useState<readonly ListedProject[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [checkingAuthorization, setCheckingAuthorization] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pendingAuthorization, setPendingAuthorization] = useState<ReadonlySet<ListedProjectId>>(() => new Set());

  useEffect(() => {
    let current = true;
    void api.listProjects()
      .then((response) => { if (current) setProjects(response.projects); })
      .catch(() => { if (current) setError("无法加载项目，请检查本地 Hunter 服务"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = name.trim();
    if (normalized.length === 0) {
      setError("请输入项目名称");
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const created = await api.createProject(normalized);
      setProjects((current) => [...current, { projectId: created.projectId, name: created.name }]);
      setPendingAuthorization((current) => new Set(current).add(created.projectId));
      setNotice("项目已创建；可信宿主刷新安全会话后即可打开。");
      setName("");
    } catch {
      setError("无法创建项目，请重试");
    } finally {
      setBusy(false);
    }
  };

  const refreshAuthorization = async () => {
    setCheckingAuthorization(true);
    setError(undefined);
    setNotice(undefined);
    const pendingAtStart = pendingAuthorization;
    try {
      const response = await api.listProjects();
      const authorizedIds = new Set(response.projects.map((project) => project.projectId));
      setProjects((current) => [
        ...response.projects,
        ...current.filter((project) => pendingAtStart.has(project.projectId) && !authorizedIds.has(project.projectId)),
      ]);
      setPendingAuthorization((current) => new Set([...current].filter((projectId) => !authorizedIds.has(projectId))));
      setNotice("授权状态已重新检查。");
    } catch {
      setError("无法检查授权，请重试");
    } finally {
      setCheckingAuthorization(false);
    }
  };

  return (
    <main className="page-shell" aria-busy={loading || busy || checkingAuthorization}>
      <header className="page-header">
        <div>
          <p className="eyebrow">Workbench</p>
          <h1>项目</h1>
          <p className="page-description">管理独立的产品空间与它们的需求版本。</p>
        </div>
        <span className="count-label">{projects.length} 个项目</span>
      </header>

      <section className="panel create-panel" aria-labelledby="create-project-title">
        <div>
          <h2 id="create-project-title">创建项目</h2>
          <p className="panel-description">项目是长期工作空间，身份与本地路径分离。</p>
        </div>
        <form className="inline-form" onSubmit={(event) => void submit(event)}>
          <label>
            项目名称
            <input value={name} maxLength={120} disabled={busy} onChange={(event) => setName(event.target.value)} />
          </label>
          <button className="button button-primary" type="submit" disabled={busy}>
            {busy ? "正在创建…" : "创建项目"}
          </button>
        </form>
        {error === undefined ? null : <p role="alert" className="message error-message">{error}</p>}
        {notice === undefined ? null : <p role="status" className="message notice-message">{notice}</p>}
      </section>

      <section className="project-section" aria-labelledby="project-list-title">
        <div className="section-heading">
          <h2 id="project-list-title">全部项目</h2>
          {loading ? <span role="status">正在加载项目…</span> : null}
          {pendingAuthorization.size > 0 ? (
            <button className="button button-secondary" type="button" disabled={checkingAuthorization} onClick={() => void refreshAuthorization()}>
              {checkingAuthorization ? "正在检查授权…" : "重新检查授权"}
            </button>
          ) : null}
        </div>
        {!loading && projects.length === 0 && error === undefined ? (
          <div className="empty-state">
            <strong>还没有项目</strong>
            <p>在上方创建第一个项目，随后可记录并批准需求版本。</p>
          </div>
        ) : null}
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.projectId} className="project-row">
              <div>
                <strong>{project.name}</strong>
                <code>{project.projectId}</code>
              </div>
              <button className="button button-secondary" type="button" disabled={pendingAuthorization.has(project.projectId)} aria-label={pendingAuthorization.has(project.projectId) ? `等待授权 ${project.name}` : `打开 ${project.name}`} onClick={() => onOpen(project.projectId)}>
                {pendingAuthorization.has(project.projectId) ? "等待会话授权" : "打开项目"}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
