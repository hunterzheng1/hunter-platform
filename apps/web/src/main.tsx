import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  AuthenticatedHunterTransportSchema,
  HunterApi,
  type AuthenticatedHunterTransport,
} from "./api/client.js";
import { MobileApplication } from "./mobile/mobile-application.js";
import { createMobileComposition } from "./mobile/mobile-composition.js";
import { MobileUnavailablePage } from "./pages/mobile-cockpit.js";
import { ProjectListPage } from "./pages/project-list-page.js";
import { ProjectPage } from "./pages/project-page.js";
import { KnowledgePage } from "./pages/knowledge-page.js";
import {
  isMobileRoute,
  registerMobileServiceWorker,
} from "./pwa/register-mobile-service-worker.js";
import "./styles.css";

function routeProjectId(pathname: string): string | undefined {
  const match = /^\/projects\/([^/]+)$/u.exec(pathname);
  return match?.[1];
}

function routeKnowledgeProjectId(pathname: string): string | undefined {
  return /^\/projects\/([^/]+)\/knowledge$/u.exec(pathname)?.[1];
}

declare global {
  interface Window {
    readonly hunterAuthenticatedTransport?: unknown;
    readonly hunterMobileConfig?: unknown;
  }
}

function Workbench({ transport }: { readonly transport: AuthenticatedHunterTransport }) {
  const [api] = useState(() => new HunterApi(transport));
  const [projectId, setProjectId] = useState(() => routeProjectId(window.location.pathname));
  const [knowledgeProjectId, setKnowledgeProjectId] = useState(
    () => routeKnowledgeProjectId(window.location.pathname),
  );
  useEffect(() => {
    const synchronizeRoute = () => {
      setProjectId(routeProjectId(window.location.pathname));
      setKnowledgeProjectId(routeKnowledgeProjectId(window.location.pathname));
    };
    window.addEventListener("popstate", synchronizeRoute);
    return () => window.removeEventListener("popstate", synchronizeRoute);
  }, []);
  const navigate = (nextProjectId?: string) => {
    const path = nextProjectId === undefined ? "/" : `/projects/${nextProjectId}`;
    window.history.pushState({}, "", path);
    setProjectId(nextProjectId);
    setKnowledgeProjectId(undefined);
  };
  const navigateToKnowledge = (nextProjectId: string) => {
    window.history.pushState({}, "", `/projects/${nextProjectId}/knowledge`);
    setProjectId(undefined);
    setKnowledgeProjectId(nextProjectId);
  };
  return (
    <>
      <header className="topbar">
        <span className="wordmark">Hunter</span>
        <span className="local-status"><span aria-hidden="true" />本地工作台</span>
      </header>
      {knowledgeProjectId !== undefined
        ? <KnowledgePage projectId={knowledgeProjectId} api={api} onBack={() => navigate(knowledgeProjectId)} />
        : projectId === undefined
        ? <ProjectListPage api={api} onOpen={(id) => navigate(id)} />
        : (
          <ProjectPage
            projectId={projectId}
            api={api}
            onBack={() => navigate()}
            onOpenKnowledge={() => navigateToKnowledge(projectId)}
          />
        )}
    </>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("WORKBENCH_ROOT_MISSING");
if (window.location.pathname === "/mobile") {
  window.history.replaceState(
    window.history.state,
    "",
    `/mobile/${window.location.search}${window.location.hash}`,
  );
}
const mobileRoute = isMobileRoute(window.location.pathname);
const transport = mobileRoute
  ? undefined
  : AuthenticatedHunterTransportSchema.safeParse(window.hunterAuthenticatedTransport);
const mobile = mobileRoute
  ? createMobileComposition(window.hunterMobileConfig, {
      indexedDB: window.indexedDB,
      crypto: window.crypto,
      fetch: globalThis.fetch.bind(globalThis),
    })
  : undefined;
if (mobileRoute) registerMobileServiceWorker();
createRoot(root).render(mobileRoute
  ? mobile === undefined
    ? <MobileUnavailablePage />
    : <MobileApplication runtime={mobile.runtime} outbox={mobile.outbox} />
  : transport?.success === true
  ? <Workbench transport={transport.data} />
  : <main className="page-shell"><p role="alert" className="message error-message">安全连接尚未配置。请从受信任的 Hunter 桌面宿主打开工作台。</p></main>);
