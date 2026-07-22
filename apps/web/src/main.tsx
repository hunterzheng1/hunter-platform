import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  AuthenticatedHunterTransportSchema,
  HunterApi,
  type AuthenticatedHunterTransport,
} from "./api/client.js";
import { ProjectListPage } from "./pages/project-list-page.js";
import { ProjectPage } from "./pages/project-page.js";
import "./styles.css";

function routeProjectId(pathname: string): string | undefined {
  const match = /^\/projects\/([^/]+)$/u.exec(pathname);
  return match?.[1];
}

declare global {
  interface Window {
    readonly hunterAuthenticatedTransport?: unknown;
  }
}

function Workbench({ transport }: { readonly transport: AuthenticatedHunterTransport }) {
  const [api] = useState(() => new HunterApi(transport));
  const [projectId, setProjectId] = useState(() => routeProjectId(window.location.pathname));
  useEffect(() => {
    const synchronizeRoute = () => setProjectId(routeProjectId(window.location.pathname));
    window.addEventListener("popstate", synchronizeRoute);
    return () => window.removeEventListener("popstate", synchronizeRoute);
  }, []);
  const navigate = (nextProjectId?: string) => {
    const path = nextProjectId === undefined ? "/" : `/projects/${nextProjectId}`;
    window.history.pushState({}, "", path);
    setProjectId(nextProjectId);
  };
  return (
    <>
      <header className="topbar">
        <span className="wordmark">Hunter</span>
        <span className="local-status"><span aria-hidden="true" />本地工作台</span>
      </header>
      {projectId === undefined
        ? <ProjectListPage api={api} onOpen={(id) => navigate(id)} />
        : <ProjectPage projectId={projectId} api={api} onBack={() => navigate()} />}
    </>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("WORKBENCH_ROOT_MISSING");
const transport = AuthenticatedHunterTransportSchema.safeParse(window.hunterAuthenticatedTransport);
createRoot(root).render(transport.success
  ? <Workbench transport={transport.data} />
  : <main className="page-shell"><p role="alert" className="message error-message">安全连接尚未配置。请从受信任的 Hunter 桌面宿主打开工作台。</p></main>);
