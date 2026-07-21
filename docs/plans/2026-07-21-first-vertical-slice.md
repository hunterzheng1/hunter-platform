# Hunter Platform First Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one Windows-first Hunter product slice in which a user manages projects and versioned requirements, plans serial/parallel tasks, runs a verified multi-agent workflow with bounded loops, inspects every attempt and artifact, archives the result into long-term knowledge, and controls safe actions from desktop or mobile.

**Architecture:** React and Electron are clients of the local `hunterd` application API; they never own workflow state. The foundation's FlowEngine coordinates root and child WorkflowRuns through runtime contracts, while Orca, Codex, CodeBuddy Code, and Cursor adapters remain replaceable and publish honest capability manifests; archives and knowledge preserve file-based content with SQLite indexes and provenance.

**Tech Stack:** Node.js 24 LTS, TypeScript 5, npm workspaces, React 19, Vite 7, Electron 37, Fastify 5, built-in `node:sqlite`, Zod, Vitest, Testing Library, Playwright, Workbox-compatible service worker APIs, PowerShell 7, and GitHub Actions.

---

## Entry gates and stable dependency rule

1. Complete `docs/plans/2026-07-21-platform-foundation.md`; all foundation tests must pass.
2. Read `docs/validation/phase-0-decision.md` and `docs/adr/0005-orca-runtime-integration.md`. Phase 0 determines a concrete transport configuration, but adapters in this plan implement `RuntimeProvider`/`AgentConnector`; no Flow or domain type may import a Phase 0 spike.
3. If real credentials are unavailable, the deterministic fake drives automated acceptance. Real-provider tests are opt-in and must report `SKIP: credentials unavailable`, not counterfeit success.
4. Root `WorkflowRun` owns the Change delivery. Each schedulable Task gets a child `WorkflowRun` with `parentRunId` and `taskId`; a Subflow may create another child with the same semantics.
5. A successful native command, idle terminal, or returned Agent result remains unverified until its declared Verifier passes.

## Review correction precedence

The remediation Tasks 14-19 below are release-blocking corrections from the internal-design and vertical-security reviews. They execute before Task 13 acceptance and override any conflicting sample in Tasks 2-13. In particular:

- HTTP params, provider JSON, IDs, paths, workspace references, and file names are decoded only by the shared Zod/branded-ID and canonical-path boundary from Task 14. An earlier `String(...)`, type assertion, `isAbsolute + resolve`, or use of `workspaceRef` as a path is non-authoritative and must not be implemented.
- Every side-effecting `create/launch/send/resume/interrupt/open/write` action is dispatched only from the Foundation `outbox` through its stable `operationId`, and completes only after a durable `side_effect_receipts` record. Adapter-local Maps are not idempotency or recovery mechanisms.
- Connector levels are calculated from versioned probe receipts. The literal L3 manifests and the fixed CodeBuddy URL shown later are superseded; neither Codex nor CodeBuddy is L3 unless every L3 atom passes its real contract suite.
- The fixed daemon/API ports, renderer-visible API origin, arbitrary `HUNTER_WEB_URL`, in-memory pairing codes, perpetual HMAC bearer, and unauthenticated EventSource examples are rejected designs. Tasks 16-17 define the only permitted local and remote access paths.
- Archive-to-Knowledge is a persistent job, not a same-process method call. Task 18 owns its manifest, provenance, project scope, crash recovery, and rebuild semantics.
- Task 13 is split into 13A/13B: only Steps 1–4 create the RED E2E contract before remediation; Task 19 then owns composition and `start:e2e`; Task 13B Steps 5–9 cannot start until Task 19's API-chain composition test is green.

No security control in Tasks 14-19 may be deferred, replaced by a manual note, or skipped under the deterministic fake. Real credentials may skip only real-provider interoperability, never boundary, recovery, authentication, authorization, replay, or TLS tests.

## Locked file map

```text
packages/domain/src/ids.ts             # Branded IDs; no external raw string crosses into Core
packages/runtime-contracts/src/        # external-boundary, operations, leases, manifest
packages/storage/src/                  # Foundation journal/outbox/receipts/event-ledger ports
packages/runtime-manager/src/          # Foundation operation worker and lease service consumers
workflow-packs/hunter-default/       # Immutable change/task workflow revisions
apps/web/                            # Desktop and responsive mobile UI
apps/desktop/                        # Electron shell and local daemon supervisor
apps/daemon/src/auth/                # Local IPC capability, remote device proof, authorization
apps/daemon/src/events/              # Durable events.position SSE stream and scoped tail
apps/daemon/src/routes/              # Typed requirements, changes, commands, runs, knowledge, devices
apps/daemon/src/services/            # Real application services and composition root
apps/daemon/src/startup/             # Recovery before listen
packages/knowledge/                  # Persistent archive jobs, manifests, ingest, rebuild
packages/provider-orca/              # Public JSON CLI workspace/process adapter
packages/connector-codex/            # Structured Codex execution adapter
packages/connector-codebuddy/        # ACP/headless CodeBuddy adapter
packages/connector-cursor/           # L0/L1 task-pack handoff and observation
packages/device-gateway/             # Persistent pairing, device proof, rotating credentials
e2e/                                 # Fake full flow and opt-in Windows provider flow
scripts/start-e2e.mjs                # Authenticated deterministic composition launcher
```

### Task 1: Publish the default root and child workflow pack

**Files:**
- Create: `workflow-packs/hunter-default/package.json`
- Create: `workflow-packs/hunter-default/tsconfig.json`
- Create: `workflow-packs/hunter-default/scripts/copy-assets.mjs`
- Create: `workflow-packs/hunter-default/change-delivery.v1.json`
- Create: `workflow-packs/hunter-default/task-delivery.v1.json`
- Create: `workflow-packs/hunter-default/src/load-pack.ts`
- Create: `workflow-packs/hunter-default/src/index.ts`
- Test: `workflow-packs/hunter-default/src/load-pack.test.ts`

- [ ] **Step 1: Write a failing pack contract test**

```ts
// workflow-packs/hunter-default/src/load-pack.test.ts
import { describe, expect, it } from "vitest";
import { loadHunterDefaultPack } from "./load-pack.js";

describe("hunter-default workflow pack", () => {
  it("publishes a root Change run and Task child run", () => {
    const pack = loadHunterDefaultPack();
    expect(pack.workflows.map((workflow) => workflow.workflowId)).toEqual(["hunter.change-delivery", "hunter.task-delivery"]);
    expect(pack.workflows[0]!.steps.map((step) => step.stepId)).toEqual(["plan", "approve_plan", "dispatch_tasks", "integrate", "archive", "ingest_knowledge"]);
  });

  it("bounds test and review feedback loops", () => {
    const child = loadHunterDefaultPack().workflows[1]!;
    expect(child.loops).toEqual([
      { fromStepId: "test", toStepId: "implement", maxAttempts: 3, maxDurationMs: 7_200_000 },
      { fromStepId: "review", toStepId: "implement", maxAttempts: 3, maxDurationMs: 7_200_000 },
    ]);
  });
});
```

- [ ] **Step 2: Run the pack test to verify RED**

Run: `npm test -- --run workflow-packs/hunter-default/src/load-pack.test.ts`

Expected: FAIL with `Failed to resolve import "./load-pack.js"`.

- [ ] **Step 3: Add the immutable root workflow revision**

```json
{
  "workflowId": "hunter.change-delivery",
  "revisionId": "wfr_hunter_change_delivery_v1",
  "entryStepId": "plan",
  "steps": [
    { "stepId": "plan", "kind": "agent", "next": { "onPassed": "approve_plan" }, "outputContract": "execution-plan.v1" },
    { "stepId": "approve_plan", "kind": "human_gate", "next": { "onPassed": "dispatch_tasks", "onCanceled": "archive" }, "outputContract": "approval.v1" },
    { "stepId": "dispatch_tasks", "kind": "subflow", "next": { "onPassed": "integrate", "onFailed": "archive" }, "subflowRevisionId": "wfr_hunter_task_delivery_v1" },
    { "stepId": "integrate", "kind": "verify", "next": { "onPassed": "archive", "onFailed": "dispatch_tasks" }, "outputContract": "integration-verdict.v1" },
    { "stepId": "archive", "kind": "command", "next": { "onPassed": "ingest_knowledge" }, "outputContract": "archive-manifest.v1" },
    { "stepId": "ingest_knowledge", "kind": "context", "next": {}, "outputContract": "knowledge-ingest-receipt.v1" }
  ],
  "loops": [
    { "fromStepId": "integrate", "toStepId": "dispatch_tasks", "maxAttempts": 2, "maxDurationMs": 7200000 }
  ]
}
```

- [ ] **Step 4: Add the immutable Task child workflow revision**

```json
{
  "workflowId": "hunter.task-delivery",
  "revisionId": "wfr_hunter_task_delivery_v1",
  "entryStepId": "prepare_context",
  "steps": [
    { "stepId": "prepare_context", "kind": "context", "next": { "onPassed": "implement" }, "outputContract": "handoff-pack.v1" },
    { "stepId": "implement", "kind": "agent", "next": { "onPassed": "test" }, "outputContract": "implementation-receipt.v1" },
    { "stepId": "test", "kind": "command", "next": { "onPassed": "review", "onFailed": "implement" }, "outputContract": "test-evidence.v1" },
    { "stepId": "review", "kind": "agent", "next": { "onPassed": "complete", "onFailed": "implement" }, "outputContract": "review-verdict.v1", "sessionPolicy": "new" },
    { "stepId": "complete", "kind": "verify", "next": {}, "outputContract": "task-completion.v1" }
  ],
  "loops": [
    { "fromStepId": "test", "toStepId": "implement", "maxAttempts": 3, "maxDurationMs": 7200000 },
    { "fromStepId": "review", "toStepId": "implement", "maxAttempts": 3, "maxDurationMs": 7200000 }
  ]
}
```

- [ ] **Step 5: Load and validate both files through the domain Interface**

```ts
// workflow-packs/hunter-default/src/load-pack.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateWorkflowRevision, type WorkflowRevision } from "@hunter/domain";

export interface HunterDefaultPack { readonly packId: "hunter-default"; readonly version: "1.0.0"; readonly workflows: readonly WorkflowRevision[] }

function readWorkflow(name: string): WorkflowRevision {
  const path = fileURLToPath(new URL(`../${name}`, import.meta.url));
  return validateWorkflowRevision(JSON.parse(readFileSync(path, "utf8")) as WorkflowRevision);
}

export function loadHunterDefaultPack(): HunterDefaultPack {
  return Object.freeze({
    packId: "hunter-default",
    version: "1.0.0",
    workflows: Object.freeze([readWorkflow("change-delivery.v1.json"), readWorkflow("task-delivery.v1.json")]),
  });
}
```

```ts
// workflow-packs/hunter-default/src/index.ts
export * from "./load-pack.js";
```

- [ ] **Step 6: Configure, test, and commit the workflow pack**

```json
// workflow-packs/hunter-default/package.json
{
  "name": "@hunter/workflow-pack-default",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": "./dist/index.js",
  "scripts": { "build": "tsc -b && node scripts/copy-assets.mjs", "typecheck": "tsc -b --pretty false" },
  "dependencies": { "@hunter/domain": "*" }
}
```

```json
// workflow-packs/hunter-default/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "references": [{ "path": "../../packages/domain" }],
  "include": ["src"]
}
```

```js
// workflow-packs/hunter-default/scripts/copy-assets.mjs
import { copyFileSync } from "node:fs";
for (const name of ["change-delivery.v1.json", "task-delivery.v1.json"]) copyFileSync(new URL(`../${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url));
```

Run: `npm test -- --run workflow-packs/hunter-default/src/load-pack.test.ts`

Expected: `2 passed`.

```powershell
git add workflow-packs/hunter-default
git commit -m "流程：发布默认 Change 与 Task 工作流包"
```

### Task 2: Create projects and approve immutable requirements in the Workbench

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/pages/project-list-page.tsx`
- Create: `apps/web/src/pages/project-page.tsx`
- Create: `apps/web/src/components/requirement-editor.tsx`
- Create: `apps/daemon/src/routes/requirements.ts`
- Create: `apps/daemon/test/support/build-test-app.ts`
- Modify: `apps/daemon/src/app.ts`
- Test: `apps/web/src/pages/project-page.test.tsx`
- Test: `apps/daemon/test/requirements.test.ts`

- [ ] **Step 1: Write a failing Workbench interaction test**

```tsx
// apps/web/src/pages/project-page.test.tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectPage } from "./project-page.js";

it("creates and approves a requirement revision without replacing it", async () => {
  const api = {
    getProject: vi.fn(async () => ({ projectId: "prj_01", name: "Hunter", requirements: [] })),
    createRequirement: vi.fn(async () => ({ revisionId: "rr_01", status: "draft" })),
    approveRequirement: vi.fn(async () => ({ revisionId: "rr_01", status: "approved" })),
  };
  render(<ProjectPage projectId="prj_01" api={api} />);
  await screen.findByRole("heading", { name: "Hunter" });
  fireEvent.change(screen.getByLabelText("需求标题"), { target: { value: "移动审批" } });
  fireEvent.change(screen.getByLabelText("验收标准"), { target: { value: "手机批准后恢复同一个 Run" } });
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("rr_01 · draft");
  fireEvent.click(screen.getByRole("button", { name: "批准此版本" }));
  expect(api.approveRequirement).toHaveBeenCalledWith("prj_01", "rr_01");
});
```

- [ ] **Step 2: Write a failing immutable approval API test**

```ts
// apps/daemon/test/requirements.test.ts
import { describe, expect, it } from "vitest";
import { buildTestApp } from "./support/build-test-app.js";

it("rejects replacement content for an approved revision", async () => {
  const app = buildTestApp();
  await app.inject({ method: "POST", url: "/api/v1/projects/prj_01/requirements", payload: { idempotencyKey: "cmd_01", requirementId: "req_01", revisionId: "rr_01", title: "Mobile", body: "Approve remotely", acceptanceCriteria: ["Resume run"] } });
  await app.inject({ method: "POST", url: "/api/v1/requirement-revisions/rr_01/approve", payload: { idempotencyKey: "cmd_02" } });
  const response = await app.inject({ method: "PUT", url: "/api/v1/requirement-revisions/rr_01", payload: { title: "Changed" } });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ code: "APPROVED_REVISION_IMMUTABLE" });
});
```

- [ ] **Step 3: Run both tests to verify RED**

Run: `npm test -- --run apps/web/src/pages/project-page.test.tsx apps/daemon/test/requirements.test.ts`

Expected: FAIL because the Workbench and requirements route do not exist.

- [ ] **Step 4: Implement the typed web API calls**

```ts
// apps/web/src/api/client.ts
export interface AuthenticatedHunterTransport {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}
export class HunterApi {
  constructor(private readonly transport: AuthenticatedHunterTransport) {}
  private request<T>(path: string, init?: RequestInit): Promise<T> { return this.transport.request<T>(path, init); }
  getProject(projectId: string) { return this.request<{ projectId: string; name: string; requirements: readonly { revisionId: string; title: string; status: string }[] }>(`/api/v1/projects/${projectId}`); }
  listProjects() { return this.request<readonly { projectId: string; name: string }[]>("/api/v1/projects"); }
  createProject(name: string) { const projectId = `prj_${crypto.randomUUID()}`; return this.request<{ projectId: string }>("/api/v1/projects", { method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), projectId, name }) }); }
  createRequirement(projectId: string, input: { title: string; acceptanceCriteria: readonly string[] }) { return this.request<{ revisionId: string; status: string }>(`/api/v1/projects/${projectId}/requirements`, { method: "POST", body: JSON.stringify(input) }); }
  approveRequirement(_projectId: string, revisionId: string) { return this.request<{ revisionId: string; status: string }>(`/api/v1/requirement-revisions/${revisionId}/approve`, { method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) }); }
}
```

```tsx
// apps/web/src/pages/project-list-page.tsx
import { useEffect, useState } from "react";
interface ProjectsApi { listProjects(): Promise<readonly { projectId: string; name: string }[]>; createProject(name: string): Promise<{ projectId: string }> }
export function ProjectListPage({ api, onOpen }: { api: ProjectsApi; onOpen(id: string): void }) {
  const [projects, setProjects] = useState<readonly { projectId: string; name: string }[]>([]);
  const [name, setName] = useState("");
  useEffect(() => { void api.listProjects().then(setProjects); }, [api]);
  return <main><h1>项目</h1><form onSubmit={(event) => { event.preventDefault(); void api.createProject(name).then((created) => { setProjects([...projects, { projectId: created.projectId, name }]); setName(""); }); }}><label>项目名称<input aria-label="项目名称" value={name} onChange={(event) => setName(event.target.value)} /></label><button type="submit">创建项目</button></form><ul>{projects.map((project) => <li key={project.projectId}><button onClick={() => onOpen(project.projectId)}>{project.name}</button></li>)}</ul></main>;
}
```

- [ ] **Step 5: Implement the requirement editor and project page**

```tsx
// apps/web/src/components/requirement-editor.tsx
import { useState } from "react";

export function RequirementEditor({ onSave }: { onSave(input: { title: string; acceptanceCriteria: readonly string[] }): Promise<void> }) {
  const [title, setTitle] = useState("");
  const [criterion, setCriterion] = useState("");
  return <form onSubmit={(event) => { event.preventDefault(); void onSave({ title, acceptanceCriteria: [criterion] }); }}>
    <label>需求标题<input aria-label="需求标题" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>验收标准<textarea aria-label="验收标准" value={criterion} onChange={(event) => setCriterion(event.target.value)} /></label>
    <button type="submit">保存草稿</button>
  </form>;
}
```

```tsx
// apps/web/src/pages/project-page.tsx
import { useEffect, useState } from "react";
import { RequirementEditor } from "../components/requirement-editor.js";

interface Api { getProject(id: string): Promise<{ name: string; requirements: readonly { revisionId: string; status: string }[] }>; createRequirement(id: string, input: { title: string; acceptanceCriteria: readonly string[] }): Promise<{ revisionId: string; status: string }>; approveRequirement(id: string, revisionId: string): Promise<unknown> }

export function ProjectPage({ projectId, api }: { projectId: string; api: Api }) {
  const [project, setProject] = useState<{ name: string; requirements: readonly { revisionId: string; status: string }[] }>();
  useEffect(() => { void api.getProject(projectId).then(setProject); }, [api, projectId]);
  if (!project) return <p>正在加载项目</p>;
  return <main><h1>{project.name}</h1>
    <RequirementEditor onSave={async (input) => { const created = await api.createRequirement(projectId, input); setProject({ ...project, requirements: [...project.requirements, created] }); }} />
    {project.requirements.map((revision) => <section key={revision.revisionId}><p>{revision.revisionId} · {revision.status}</p><button onClick={() => void api.approveRequirement(projectId, revision.revisionId)}>批准此版本</button></section>)}
  </main>;
}
```

- [ ] **Step 6: Implement requirement command routes**

```ts
// apps/daemon/src/routes/requirements.ts
import type { FastifyInstance } from "fastify";

export interface RequirementCommands {
  create(input: Record<string, unknown>): Promise<unknown>;
  approve(revisionId: string, idempotencyKey: string): Promise<unknown>;
  isApproved(revisionId: string): Promise<boolean>;
}

export async function requirementRoutes(app: FastifyInstance, commands: RequirementCommands): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: Record<string, unknown> }>("/api/v1/projects/:projectId/requirements", async (request, reply) => reply.code(201).send(await commands.create({ ...request.body, projectId: request.params.projectId })));
  app.post<{ Params: { revisionId: string }; Body: { idempotencyKey: string } }>("/api/v1/requirement-revisions/:revisionId/approve", async (request) => commands.approve(request.params.revisionId, request.body.idempotencyKey));
  app.put<{ Params: { revisionId: string } }>("/api/v1/requirement-revisions/:revisionId", async (request, reply) => (await commands.isApproved(request.params.revisionId)) ? reply.code(409).send({ code: "APPROVED_REVISION_IMMUTABLE" }) : reply.code(405).send({ code: "CREATE_NEW_REVISION" }));
}
```

```ts
// apps/daemon/test/support/build-test-app.ts
import { buildApp } from "../../src/app.js";
export function buildTestApp() {
  const approved = new Set<string>();
  return buildApp({
    createProject: async () => ({}), listProjects: async () => [], startRun: async () => ({}), getRun: async () => undefined,
    requirements: {
      create: async (input) => input,
      approve: async (revisionId) => { approved.add(revisionId); return { revisionId, status: "approved" }; },
      isApproved: async (revisionId) => approved.has(revisionId),
    },
  });
}
```

- [ ] **Step 7: Configure the web package and entry point**

```json
// apps/web/package.json
{
  "name": "@hunter/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "typecheck": "tsc -b --pretty false" },
  "dependencies": { "react": "^19.1.0", "react-dom": "^19.1.0" },
  "devDependencies": { "@testing-library/react": "^16.3.0", "@types/react": "^19.1.8", "@types/react-dom": "^19.1.6", "@vitejs/plugin-react": "^4.6.0", "jsdom": "^26.1.0", "vite": "^7.0.5" }
}
```

```json
// apps/web/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist-types", "composite": true, "jsx": "react-jsx", "lib": ["ES2023", "DOM", "DOM.Iterable"] },
  "include": ["src"]
}
```

```ts
// apps/web/vite.config.ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [react()], build: { outDir: "dist" } });
```

```html
<!-- apps/web/index.html -->
<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/manifest.webmanifest"><title>Hunter</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```

```tsx
// apps/web/src/main.tsx
import { createRoot } from "react-dom/client";
import { HunterApi } from "./api/client.js";
import { ProjectListPage } from "./pages/project-list-page.js";
import { ProjectPage } from "./pages/project-page.js";

const api = new HunterApi();
const projectId = window.location.pathname.match(/^\/projects\/([^/]+)$/)?.[1];
createRoot(document.getElementById("root")!).render(projectId ? <ProjectPage projectId={projectId} api={api} /> : <ProjectListPage api={api} onOpen={(id) => { window.location.href = `/projects/${id}`; }} />);
```

- [ ] **Step 8: Wire the new route in `buildApp`, verify, and commit**

```ts
// extend ApplicationServices and register in apps/daemon/src/app.ts
// interface member: readonly requirements?: import("./routes/requirements.js").RequirementCommands;
if (services.requirements) void requirementRoutes(app, services.requirements);
```

Run: `npm install; npm test -- --run apps/web/src/pages/project-page.test.tsx apps/daemon/test/requirements.test.ts`

Expected: `2 passed`.

```powershell
git add apps/web apps/daemon/src/routes/requirements.ts apps/daemon/src/app.ts apps/daemon/test/requirements.test.ts package-lock.json
git commit -m "工作台：贯通多项目与不可变需求版本"
```

### Task 3: Plan Changes into serial and parallel Task graphs

**Files:**
- Create: `apps/daemon/src/routes/changes.ts`
- Create: `apps/web/src/components/change-planner.tsx`
- Create: `apps/web/src/components/task-graph.tsx`
- Modify: `apps/web/src/pages/project-page.tsx`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/test/support/build-test-app.ts`
- Test: `apps/web/src/components/change-planner.test.tsx`
- Test: `apps/daemon/test/changes.test.ts`

- [ ] **Step 1: Write a failing planner test with parallel and dependent Tasks**

```tsx
// apps/web/src/components/change-planner.test.tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChangePlanner } from "./change-planner.js";

it("publishes two parallel tasks and one dependent integration task", async () => {
  const publish = vi.fn(async () => ({ planId: "plan_01" }));
  render(<ChangePlanner requirementRevisionIds={["rr_01"]} onPublish={publish} />);
  fireEvent.click(screen.getByRole("button", { name: "使用并行客户端模板" }));
  fireEvent.click(screen.getByRole("button", { name: "确认执行计划" }));
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({
    tasks: [
      expect.objectContaining({ taskId: "task_api", dependsOn: [] }),
      expect.objectContaining({ taskId: "task_ui", dependsOn: [] }),
      expect.objectContaining({ taskId: "task_integration", dependsOn: ["task_api", "task_ui"] }),
    ],
  }));
});
```

- [ ] **Step 2: Write a failing API cycle-rejection test**

```ts
// apps/daemon/test/changes.test.ts
import { expect, it } from "vitest";
import { buildTestApp } from "./support/build-test-app.js";

it("rejects cyclic task dependencies", async () => {
  const response = await buildTestApp().inject({ method: "POST", url: "/api/v1/projects/prj_01/changes", payload: {
    idempotencyKey: "cmd_change", changeId: "chg_01", revisionId: "cr_01", requirementRevisionIds: ["rr_01"],
    tasks: [{ taskId: "task_a", title: "A", access: "write", dependsOn: ["task_b"] }, { taskId: "task_b", title: "B", access: "write", dependsOn: ["task_a"] }],
  } });
  expect(response.statusCode).toBe(422);
  expect(response.json()).toEqual({ code: "TASK_GRAPH_CYCLE" });
});
```

- [ ] **Step 3: Run planner tests to verify RED**

Run: `npm test -- --run apps/web/src/components/change-planner.test.tsx apps/daemon/test/changes.test.ts`

Expected: FAIL because the planner and route do not exist.

- [ ] **Step 4: Implement the Change command route using domain validation**

```ts
// apps/daemon/src/routes/changes.ts
import type { FastifyInstance } from "fastify";
import { createChangeRevision, publishChangeRevision, validateTaskGraph, type TaskDefinition } from "@hunter/domain";

export interface ChangeCommands { publish(input: { change: unknown; tasks: readonly TaskDefinition[]; idempotencyKey: string; projectId: string }): Promise<unknown> }

export async function changeRoutes(app: FastifyInstance, commands: ChangeCommands): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: Record<string, unknown> & { idempotencyKey: string; tasks: readonly TaskDefinition[] } }>("/api/v1/projects/:projectId/changes", async (request, reply) => {
    try {
      validateTaskGraph(request.body.tasks);
      const draft = createChangeRevision({
        changeId: String(request.body.changeId),
        revisionId: String(request.body.revisionId),
        title: String(request.body.title),
        requirementRevisionIds: request.body.requirementRevisionIds as readonly string[],
        acceptanceCriteria: request.body.acceptanceCriteria as readonly string[],
      });
      const change = publishChangeRevision(draft, new Date().toISOString());
      return reply.code(201).send(await commands.publish({ change, tasks: request.body.tasks, idempotencyKey: request.body.idempotencyKey, projectId: request.params.projectId }));
    } catch (error) {
      const code = error instanceof Error ? error.message.split(":")[0] : "INVALID_CHANGE";
      return reply.code(422).send({ code });
    }
  });
}
```

- [ ] **Step 5: Implement the planner and accessible Task graph**

```tsx
// apps/web/src/components/task-graph.tsx
export function TaskGraph({ tasks }: { tasks: readonly { taskId: string; title: string; dependsOn: readonly string[] }[] }) {
  return <ol aria-label="任务依赖图">{tasks.map((task) => <li key={task.taskId}><strong>{task.title}</strong><span>{task.dependsOn.length ? `依赖：${task.dependsOn.join("、")}` : "可立即并行"}</span></li>)}</ol>;
}
```

```tsx
// apps/web/src/components/change-planner.tsx
import { useState } from "react";
import { TaskGraph } from "./task-graph.js";

const template = [
  { taskId: "task_api", title: "控制 API", access: "write" as const, dependsOn: [] },
  { taskId: "task_ui", title: "客户端界面", access: "write" as const, dependsOn: [] },
  { taskId: "task_integration", title: "端到端集成", access: "write" as const, dependsOn: ["task_api", "task_ui"] },
];

export function ChangePlanner({ requirementRevisionIds, onPublish }: { requirementRevisionIds: readonly string[]; onPublish(input: unknown): Promise<unknown> }) {
  const [tasks, setTasks] = useState<typeof template>([]);
  return <section><button onClick={() => setTasks(template)}>使用并行客户端模板</button><TaskGraph tasks={tasks} /><button disabled={!tasks.length} onClick={() => void onPublish({ changeId: crypto.randomUUID(), revisionId: crypto.randomUUID(), title: "移动审批交付", requirementRevisionIds, acceptanceCriteria: ["控制 API 与移动界面通过集成测试"], tasks })}>确认执行计划</button></section>;
}
```

```ts
// append to HunterApi in apps/web/src/api/client.ts
publishChange(projectId: string, input: unknown) { return this.request<{ planId: string }>(`/api/v1/projects/${projectId}/changes`, { method: "POST", body: JSON.stringify({ ...(input as object), idempotencyKey: crypto.randomUUID() }) }); }
```

```tsx
// replace apps/web/src/pages/project-page.tsx to bind planning to approved revisions
import { useEffect, useState } from "react";
import { ChangePlanner } from "../components/change-planner.js";
import { RequirementEditor } from "../components/requirement-editor.js";
interface Api { getProject(id: string): Promise<{ name: string; requirements: readonly { revisionId: string; status: string }[] }>; createRequirement(id: string, input: { title: string; acceptanceCriteria: readonly string[] }): Promise<{ revisionId: string; status: string }>; approveRequirement(id: string, revisionId: string): Promise<unknown>; publishChange(id: string, input: unknown): Promise<unknown> }
export function ProjectPage({ projectId, api }: { projectId: string; api: Api }) {
  const [project, setProject] = useState<{ name: string; requirements: readonly { revisionId: string; status: string }[] }>();
  useEffect(() => { void api.getProject(projectId).then(setProject); }, [api, projectId]);
  if (!project) return <p>正在加载项目</p>;
  const approve = async (revisionId: string) => { await api.approveRequirement(projectId, revisionId); setProject({ ...project, requirements: project.requirements.map((revision) => revision.revisionId === revisionId ? { ...revision, status: "approved" } : revision) }); };
  const approved = project.requirements.filter((revision) => revision.status === "approved").map((revision) => revision.revisionId);
  return <main><h1>{project.name}</h1><RequirementEditor onSave={async (input) => { const created = await api.createRequirement(projectId, input); setProject({ ...project, requirements: [...project.requirements, created] }); }} />{project.requirements.map((revision) => <section key={revision.revisionId}><p>{revision.revisionId} · {revision.status}</p>{revision.status !== "approved" && <button onClick={() => void approve(revision.revisionId)}>批准此版本</button>}</section>)}{approved.length > 0 && <ChangePlanner requirementRevisionIds={approved} onPublish={(input) => api.publishChange(projectId, input)} />}</main>;
}
```

- [ ] **Step 6: Register routes, verify, and commit**

```ts
// in apps/daemon/src/app.ts after requirementRoutes registration
// interface member: readonly changes?: import("./routes/changes.js").ChangeCommands;
if (services.changes) void changeRoutes(app, services.changes);
```

```ts
// add to the services object in apps/daemon/test/support/build-test-app.ts
changes: { publish: async (input) => ({ planId: "plan_01", ...input }) },
```

Run: `npm test -- --run apps/web/src/components/change-planner.test.tsx apps/daemon/test/changes.test.ts`

Expected: `2 passed`.

```powershell
git add apps/daemon/src/routes/changes.ts apps/daemon/src/app.ts apps/daemon/test/changes.test.ts apps/web/src/components apps/web/src/pages/project-page.tsx
git commit -m "规划：支持 Change 拆分串并行任务图"
```

### Task 4: Show the live Run line and inspect every StepAttempt

**Files:**
- Create: `apps/web/src/hooks/use-run-events.ts`
- Create: `apps/web/src/components/run-line.tsx`
- Create: `apps/web/src/components/step-detail.tsx`
- Create: `apps/web/src/pages/run-page.tsx`
- Modify: `apps/web/src/api/client.ts`
- Test: `apps/web/src/pages/run-page.test.tsx`

- [ ] **Step 1: Write a failing Run display test**

```tsx
// apps/web/src/pages/run-page.test.tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { RunPage } from "./run-page.js";

it("separates execution and verification and retains failed attempts", async () => {
  const api = { getRun: async () => ({
    runId: "run_01", status: "running", steps: [
      { stepRunId: "sr_plan", title: "计划", conclusion: "succeeded", attempts: [{ attemptId: "att_plan", execution: "returned", verification: "passed" }] },
      { stepRunId: "sr_test", title: "测试", conclusion: "active", attempts: [
        { attemptId: "att_test_1", execution: "returned", verification: "failed" },
        { attemptId: "att_test_2", execution: "running", verification: "not_ready" },
      ] },
    ],
  }), subscribeRun: () => () => undefined };
  render(<RunPage runId="run_01" api={api} />);
  await screen.findByRole("heading", { name: "Run run_01" });
  expect(screen.getByText("执行：已返回 · 验证：失败")).toBeTruthy();
  expect(screen.getByText("第 2 次尝试 · 执行中")).toBeTruthy();
  expect(screen.queryByText("测试 · 成功")).toBeNull();
});
```

- [ ] **Step 2: Run the UI test to verify RED**

Run: `npm test -- --run apps/web/src/pages/run-page.test.tsx`

Expected: FAIL with `Failed to resolve import "./run-page.js"`.

- [ ] **Step 3: Implement reconnecting SSE subscription**

```ts
// apps/web/src/hooks/use-run-events.ts
import { useEffect } from "react";

export interface AuthorizedEventStream { subscribe(input: { runId: string; after: number }, onEvent: (event: { position: number; runId?: string }) => void): () => void }
export function useRunEvents(runId: string, onChange: () => void, stream: AuthorizedEventStream): void {
  useEffect(() => {
    let position = Number(sessionStorage.getItem(`hunter-event-${runId}`) ?? 0);
    return stream.subscribe({ runId, after: position }, (event) => {
      position = event.position;
      sessionStorage.setItem(`hunter-event-${runId}`, String(position));
      if (event.runId === runId) onChange();
    });
  }, [onChange, runId, stream]);
}
```

- [ ] **Step 4: Implement accessible Run and Attempt components**

```tsx
// apps/web/src/components/run-line.tsx
export interface RunStepView { stepRunId: string; title: string; conclusion: "pending" | "active" | "succeeded" | "failed" | "blocked"; attempts: readonly AttemptView[] }
export interface AttemptView { attemptId: string; execution: string; verification: string; agentProfile?: string; nativeSessionRef?: string }

export function RunLine({ steps, selected, onSelect }: { steps: readonly RunStepView[]; selected?: string; onSelect(id: string): void }) {
  return <ol aria-label="工作流执行线路">{steps.map((step) => <li key={step.stepRunId} data-conclusion={step.conclusion}><button aria-current={selected === step.stepRunId ? "step" : undefined} onClick={() => onSelect(step.stepRunId)}>{step.title} · {step.conclusion === "succeeded" ? "成功" : step.conclusion === "active" ? "执行中" : step.conclusion}</button></li>)}</ol>;
}
```

```tsx
// apps/web/src/components/step-detail.tsx
import type { RunStepView } from "./run-line.js";
const label = (value: string) => ({ returned: "已返回", running: "执行中", failed: "失败", passed: "通过", not_ready: "未验证" }[value] ?? value);

export function StepDetail({ step }: { step: RunStepView }) {
  return <section aria-label={`${step.title}详情`}><h2>{step.title}</h2>{step.attempts.map((attempt, index) => <article key={attempt.attemptId}>
    <h3>第 {index + 1} 次尝试 · {label(attempt.execution)}</h3>
    <p>执行：{label(attempt.execution)} · 验证：{label(attempt.verification)}</p>
    {attempt.agentProfile && <p>Agent：{attempt.agentProfile}</p>}
  </article>)}</section>;
}
```

- [ ] **Step 5: Compose the Run page and API query**

```tsx
// apps/web/src/pages/run-page.tsx
import { useCallback, useEffect, useState } from "react";
import { RunLine, type RunStepView } from "../components/run-line.js";
import { StepDetail } from "../components/step-detail.js";

interface RunApi { getRun(id: string): Promise<{ runId: string; status: string; steps: readonly RunStepView[] }>; subscribeRun?(id: string, refresh: () => void): () => void }
export function RunPage({ runId, api }: { runId: string; api: RunApi }) {
  const [run, setRun] = useState<Awaited<ReturnType<RunApi["getRun"]>>>();
  const [selected, setSelected] = useState<string>();
  const refresh = useCallback(() => { void api.getRun(runId).then((value) => { setRun(value); setSelected((current) => current ?? value.steps[0]?.stepRunId); }); }, [api, runId]);
  useEffect(refresh, [refresh]);
  useEffect(() => api.subscribeRun?.(runId, refresh), [api, refresh, runId]);
  if (!run) return <p>正在恢复 Run</p>;
  const step = run.steps.find((candidate) => candidate.stepRunId === selected) ?? run.steps[0];
  return <main><h1>Run {run.runId}</h1><RunLine steps={run.steps} selected={step?.stepRunId} onSelect={setSelected} />{step && <StepDetail step={step} />}</main>;
}
```

```ts
// append to HunterApi in apps/web/src/api/client.ts
getRun(runId: string) { return this.request<{ runId: string; status: string; steps: readonly import("../components/run-line.js").RunStepView[] }>(`/api/v1/runs/${runId}`); }
```

- [ ] **Step 6: Verify and commit the execution cockpit**

Run: `npm test -- --run apps/web/src/pages/run-page.test.tsx`

Expected: `1 passed`; the first failed Attempt and current Attempt are both rendered.

```powershell
git add apps/web/src/hooks apps/web/src/components/run-line.tsx apps/web/src/components/step-detail.tsx apps/web/src/pages/run-page.tsx apps/web/src/pages/run-page.test.tsx apps/web/src/api/client.ts
git commit -m "工作台：展示可信 Run 线路与步骤尝试详情"
```

### Task 5: Archive every terminal Run and automatically ingest long-term knowledge

> **Corrected by Task 18:** the same-process `ArchiveWriter.write(); catalog.ingestArchive()` sample below is RED-only illustration. Production code must use the persistent archival job/outbox, versioned manifest, hash verification, mandatory Project scope, and rebuild path defined in Task 18.

**Files:**
- Create: `packages/knowledge/package.json`
- Create: `packages/knowledge/tsconfig.json`
- Create: `packages/knowledge/src/archive-writer.ts`
- Create: `packages/knowledge/src/knowledge-catalog.ts`
- Create: `packages/knowledge/src/resolver.ts`
- Create: `packages/knowledge/src/index.ts`
- Test: `packages/knowledge/src/archive-ingest.test.ts`

- [ ] **Step 1: Write a failing archive-to-knowledge test**

```ts
// packages/knowledge/src/archive-ingest.test.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArchiveWriter, FileKnowledgeCatalog, KnowledgeResolver } from "./index.js";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("archive knowledge ingest", () => {
  it("archives a failed run and indexes traceable historical knowledge", () => {
    root = mkdtempSync(join(tmpdir(), "hunter-knowledge-"));
    const archive = new ArchiveWriter(root).write({ runId: "run_01", outcome: "failed", requirementRevisionIds: ["rr_01"], artifacts: [{ contentRef: "cas:abc", sha256: "abc" }], evidence: [{ kind: "test", passed: false }] });
    const entry = new FileKnowledgeCatalog(root).ingestArchive(archive);
    expect(entry).toMatchObject({ level: "historical", status: "active", source: { type: "archive", id: "run_01" } });
    expect(readFileSync(join(root, "archives", "run_01", "manifest.json"), "utf8")).toContain('"outcome": "failed"');
  });

  it("injects active authoritative knowledge but not raw history", () => {
    root = mkdtempSync(join(tmpdir(), "hunter-knowledge-"));
    const catalog = new FileKnowledgeCatalog(root);
    catalog.put({ entryId: "ke_req", level: "authoritative", status: "active", source: { type: "requirement_revision", id: "rr_01" }, scope: { projectId: "prj_01" }, body: "Mobile approval is required." });
    catalog.put({ entryId: "ke_old", level: "historical", status: "active", source: { type: "archive", id: "run_old" }, scope: { projectId: "prj_01" }, body: "An old attempt failed." });
    expect(new KnowledgeResolver(catalog).resolve({ projectId: "prj_01" }).map((entry) => entry.entryId)).toEqual(["ke_req"]);
  });
});
```

- [ ] **Step 2: Run knowledge tests to verify RED**

Run: `npm test -- --run packages/knowledge/src/archive-ingest.test.ts`

Expected: FAIL with `Failed to resolve import "./index.js"`.

- [ ] **Step 3: Implement atomic archive manifests**

```ts
// packages/knowledge/src/archive-writer.ts
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

export interface ArchiveInput { readonly runId: string; readonly outcome: "succeeded" | "failed" | "canceled"; readonly requirementRevisionIds: readonly string[]; readonly artifacts: readonly unknown[]; readonly evidence: readonly unknown[] }
export interface ArchiveReceipt { readonly runId: string; readonly manifestPath: string; readonly sha256: string }

export class ArchiveWriter {
  constructor(private readonly root: string) {}
  write(input: ArchiveInput): ArchiveReceipt {
    const body = `${JSON.stringify({ schemaVersion: 1, ...input }, null, 2)}\n`;
    const manifestPath = join(this.root, "archives", input.runId, "manifest.json");
    const temporaryPath = `${manifestPath}.writing`;
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(temporaryPath, body, "utf8");
    renameSync(temporaryPath, manifestPath);
    return { runId: input.runId, manifestPath, sha256: createHash("sha256").update(body).digest("hex") };
  }
}
```

- [ ] **Step 4: Implement provenance-preserving catalog and automatic ingest**

```ts
// packages/knowledge/src/knowledge-catalog.ts
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchiveReceipt } from "./archive-writer.js";

export interface KnowledgeEntry { readonly entryId: string; readonly level: "historical" | "authoritative" | "experiential"; readonly status: "active" | "superseded" | "withdrawn"; readonly source: { type: string; id: string }; readonly scope: { projectId?: string }; readonly body: string }

export class FileKnowledgeCatalog {
  constructor(private readonly root: string) {}
  put(entry: KnowledgeEntry): KnowledgeEntry {
    const directory = join(this.root, "knowledge");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${entry.entryId}.json`), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    return entry;
  }
  ingestArchive(archive: ArchiveReceipt): KnowledgeEntry {
    const manifest = JSON.parse(readFileSync(archive.manifestPath, "utf8")) as { runId: string; projectId: string };
    if (!manifest.projectId) throw new Error("KNOWLEDGE_PROJECT_SCOPE_REQUIRED");
    return this.put({ entryId: `ke_archive_${manifest.runId}`, level: "historical", status: "active", source: { type: "archive", id: manifest.runId }, scope: { projectId: manifest.projectId }, body: `Archived run ${manifest.runId}; manifest sha256 ${archive.sha256}.` });
  }
  all(): KnowledgeEntry[] {
    const directory = join(this.root, "knowledge");
    try { return readdirSync(directory).sort().map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as KnowledgeEntry); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
}
```

- [ ] **Step 5: Resolve only active, scoped, trusted knowledge by default**

```ts
// packages/knowledge/src/resolver.ts
import type { FileKnowledgeCatalog, KnowledgeEntry } from "./knowledge-catalog.js";

export class KnowledgeResolver {
  constructor(private readonly catalog: FileKnowledgeCatalog) {}
  resolve(input: { projectId: string; includeHistorical?: boolean }): KnowledgeEntry[] {
    return this.catalog.all().filter((entry) => entry.status === "active" && (!entry.scope.projectId || entry.scope.projectId === input.projectId) && (input.includeHistorical || entry.level !== "historical"));
  }
}
```

```ts
// packages/knowledge/src/index.ts
export * from "./archive-writer.js";
export * from "./knowledge-catalog.js";
export * from "./resolver.js";
```

- [ ] **Step 6: Configure, verify, and commit knowledge ingestion**

```json
// packages/knowledge/package.json
{
  "name": "@hunter/knowledge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./dist/index.js",
  "scripts": { "build": "tsc -b", "typecheck": "tsc -b --pretty false" }
}
```

```json
// packages/knowledge/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "include": ["src"]
}
```

Run: `npm test -- --run packages/knowledge/src/archive-ingest.test.ts`

Expected: `2 passed`; failed Runs are archived and raw historical entries are not automatically injected.

```powershell
git add packages/knowledge
git commit -m "知识：归档全部 Run 并自动进入可追溯知识体系"
```

### Task 6: Implement the Orca JSON CLI workspace/process provider

**Files:**
- Create: `packages/provider-orca/package.json`
- Create: `packages/provider-orca/tsconfig.json`
- Create: `packages/provider-orca/src/command-runner.ts`
- Create: `packages/provider-orca/src/orca-client.ts`
- Create: `packages/provider-orca/src/orca-workspace-provider.ts`
- Create: `packages/provider-orca/src/index.ts`
- Test: `packages/provider-orca/src/orca-provider.test.ts`

- [ ] **Step 1: Write failing argument-array and idempotency tests**

```ts
// packages/provider-orca/src/orca-provider.test.ts
import { describe, expect, it, vi } from "vitest";
import { OrcaClient, OrcaWorkspaceProvider } from "./index.js";

it("creates a worktree only through Phase 0 verified public JSON commands", async () => {
  const run = vi.fn()
    .mockResolvedValueOnce({ repoId: "repo_01" })
    .mockResolvedValueOnce({ worktreeId: "wt_01", path: "C:\\work\\hunter-wt" });
  const provider = new OrcaWorkspaceProvider(new OrcaClient({ run }));
  const lease = await provider.acquire({ operationId: "op_01", repositoryPath: "C:\\work\\hunter", mode: "write" });
  expect(run.mock.calls).toEqual([
    [["repo", "add", "--path", "C:\\work\\hunter", "--json"]],
    [["worktree", "create", "--repo", "id:repo_01", "--name", "hunter-op_01", "--agent", "codex", "--setup", "skip", "--json"]],
  ]);
  expect(lease).toMatchObject({ workspaceRef: "orca:wt_01", absolutePath: "C:\\work\\hunter-wt", mode: "write" });
});

it("never adds an upstream permission-bypass flag", async () => {
  const run = vi.fn().mockResolvedValue({ terminalId: "term_01" });
  const client = new OrcaClient({ run });
  await client.createTerminal("wt_01", "pwsh");
  expect(run.mock.calls.flat(3).join(" ")).not.toMatch(/dangerously|bypass|yolo/i);
});
```

- [ ] **Step 2: Run Orca tests to verify RED**

Run: `npm test -- --run packages/provider-orca/src/orca-provider.test.ts`

Expected: FAIL with `Failed to resolve import "./index.js"`.

- [ ] **Step 3: Implement a safe executable runner and typed Orca client**

```ts
// packages/provider-orca/src/command-runner.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export interface JsonCommandRunner { run(args: readonly string[]): Promise<unknown> }
export class OrcaCommandRunner implements JsonCommandRunner {
  async run(args: readonly string[]): Promise<unknown> {
    const { stdout } = await execFileAsync("orca", [...args], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout) as unknown;
  }
}
```

```ts
// packages/provider-orca/src/orca-client.ts
import type { JsonCommandRunner } from "./command-runner.js";
export class OrcaClient {
  constructor(private readonly runner: JsonCommandRunner) {}
  async addRepository(path: string) { return this.runner.run(["repo", "add", "--path", path, "--json"]) as Promise<{ repoId: string }>; }
  async createWorktree(repoId: string, operationId: string) { return this.runner.run(["worktree", "create", "--repo", `id:${repoId}`, "--name", `hunter-${operationId}`, "--agent", "codex", "--setup", "skip", "--json"]) as Promise<{ worktreeId: string; path: string }>; }
  async createTerminal(worktreeId: string, command: string) { return this.runner.run(["terminal", "create", "--worktree", `id:${worktreeId}`, "--title", "hunter-managed", "--command", command, "--json"]) as Promise<{ terminalId: string }>; }
  async readTerminal(terminalId: string, cursor: string) { return this.runner.run(["terminal", "read", "--terminal", terminalId, "--cursor", cursor, "--limit", "1000", "--json"]); }
}
```

- [ ] **Step 4: Adapt worktree operations to `WorkspaceProvider`**

```ts
// packages/provider-orca/src/orca-workspace-provider.ts
import type { WorkspaceLease, WorkspaceProvider } from "@hunter/runtime-contracts";
import type { OrcaClient } from "./orca-client.js";

export class OrcaWorkspaceProvider implements WorkspaceProvider {
  constructor(private readonly client: OrcaClient) {}
  async acquire(input: { operationId: string; repositoryPath: string; mode: "read" | "write" }): Promise<WorkspaceLease> {
    // Task 14 replaces this raw request with branded IDs, a verified DeviceBinding,
    // Foundation lease_records, and durable outbox/side_effect_receipts.
    const repository = await this.client.addRepository(input.repositoryPath);
    const worktree = await this.client.createWorktree(repository.repoId, input.operationId);
    const lease = { workspaceRef: `orca:${worktree.worktreeId}`, absolutePath: worktree.path, leaseId: `lease:${input.operationId}`, mode: input.mode, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } as const;
    return lease;
  }
  async release(_leaseId: string): Promise<void> { throw new Error("FOUNDATION_LEASE_SERVICE_REQUIRED"); }
}
```

```ts
// packages/provider-orca/src/index.ts
export * from "./command-runner.js";
export * from "./orca-client.js";
export * from "./orca-workspace-provider.js";
```

- [ ] **Step 5: Configure, run contract tests, and commit**

```json
// packages/provider-orca/package.json
{
  "name": "@hunter/provider-orca",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./dist/index.js",
  "scripts": { "build": "tsc -b", "typecheck": "tsc -b --pretty false" },
  "dependencies": { "@hunter/runtime-contracts": "*" }
}
```

```json
// packages/provider-orca/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "references": [{ "path": "../runtime-contracts" }],
  "include": ["src"]
}
```

Run: `npm test -- --run packages/provider-orca/src/orca-provider.test.ts`

Expected: `2 passed`; command arguments match the Phase 0 evidence and contain no bypass flag.

```powershell
git add packages/provider-orca
git commit -m "适配：接入 Orca 公共 JSON 工作区能力"
```

### Task 7: Add the structured Codex deep Connector

**Files:**
- Create: `packages/connector-codex/package.json`
- Create: `packages/connector-codex/tsconfig.json`
- Create: `packages/connector-codex/src/codex-events.ts`
- Create: `packages/connector-codex/src/codex-connector.ts`
- Create: `packages/connector-codex/src/index.ts`
- Test: `packages/connector-codex/src/codex-connector.test.ts`

- [ ] **Step 1: Write failing structured-event tests**

```ts
// packages/connector-codex/src/codex-connector.test.ts
import { expect, it, vi } from "vitest";
import { CodexConnector } from "./codex-connector.js";

it("returns the native thread id while preserving unknown events", async () => {
  const execute = vi.fn(async () => [
    '{"type":"thread.started","thread_id":"thread_01"}',
    '{"type":"future.event","value":7}',
    '{"type":"turn.completed"}',
  ]);
  const connector = new CodexConnector({ execute, cancel: vi.fn(async () => undefined) });
  const result = await connector.launch({ operationId: "op_01", profileId: "codex_impl", workspaceRef: "ws_01", workspacePath: "C:\\work\\wt", prompt: "Implement task" });
  expect(result.nativeSessionRef).toBe("thread_01");
  expect(connector.events("thread_01")[1]).toMatchObject({ kind: "unknown", raw: { type: "future.event", value: 7 } });
});

it("uses structured resume and never maps exit zero to verification passed", async () => {
  const execute = vi.fn(async () => ['{"type":"thread.started","thread_id":"thread_01"}', '{"type":"turn.completed"}']);
  const connector = new CodexConnector({ execute, cancel: vi.fn(async () => undefined) });
  await connector.resume!("thread_01", { operationId: "op_02", profileId: "codex_impl", workspaceRef: "ws_01", workspacePath: "C:\\work\\wt", prompt: "Address test failure" });
  expect(execute).toHaveBeenCalledWith(["exec", "resume", "thread_01", "--json", "--sandbox", "workspace-write", "Address test failure"], "C:\\work\\wt");
  expect(connector.events("thread_01").at(-1)?.kind).toBe("returned");
});
```

- [ ] **Step 2: Run Codex tests to verify RED**

Run: `npm test -- --run packages/connector-codex/src/codex-connector.test.ts`

Expected: FAIL because `CodexConnector` does not exist.

- [ ] **Step 3: Parse known events and retain raw unknown events**

```ts
// packages/connector-codex/src/codex-events.ts
export interface CodexEvent { readonly kind: "session_started" | "approval" | "returned" | "tool_failed" | "unknown"; readonly raw: Record<string, unknown> }
export function parseCodexEvent(line: string): CodexEvent {
  const raw = JSON.parse(line) as Record<string, unknown>;
  const kind = raw.type === "thread.started" ? "session_started" : raw.type === "approval.requested" ? "approval" : raw.type === "turn.completed" ? "returned" : raw.type === "item.failed" ? "tool_failed" : "unknown";
  return { kind, raw };
}
```

- [ ] **Step 4: Implement launch, resume, interruption, and event snapshots**

```ts
// packages/connector-codex/src/codex-connector.ts
import { computeCapabilityManifest, type AgentConnector, type CapabilityProbeReceipt, type LaunchRequest, type LaunchResult } from "@hunter/runtime-contracts";
import { parseCodexEvent, type CodexEvent } from "./codex-events.js";

export interface CodexTransport { execute(args: readonly string[], cwd: string): Promise<readonly string[]>; cancel(operationId: string): Promise<void> }
export class CodexConnector implements AgentConnector {
  // Task 15 injects a versioned probe receipt and computes this manifest; L3 is never a literal default.
  readonly manifest: import("@hunter/runtime-contracts").CapabilityManifest;
  private readonly bySession = new Map<string, CodexEvent[]>();
  constructor(private readonly transport: CodexTransport, probeReceipt: CapabilityProbeReceipt) { this.manifest = computeCapabilityManifest(probeReceipt); }
  async launch(request: LaunchRequest): Promise<LaunchResult> { return this.run(["exec", "--json", "--sandbox", "workspace-write", request.prompt], request); }
  async resume(nativeSessionRef: string, request: LaunchRequest): Promise<LaunchResult> { return this.run(["exec", "resume", nativeSessionRef, "--json", "--sandbox", "workspace-write", request.prompt], request); }
  async interrupt(_nativeSessionRef: string, operationId: string): Promise<void> { await this.transport.cancel(operationId); }
  events(nativeSessionRef: string): readonly CodexEvent[] { return this.bySession.get(nativeSessionRef) ?? []; }
  private async run(args: readonly string[], request: LaunchRequest): Promise<LaunchResult> {
    const events = (await this.transport.execute(args, request.workspacePath)).map(parseCodexEvent);
    const started = events.find((event) => event.kind === "session_started");
    const nativeSessionRef = String(started?.raw.thread_id ?? "");
    if (!nativeSessionRef) throw new Error("CODEX_SESSION_ID_MISSING");
    this.bySession.set(nativeSessionRef, [...(this.bySession.get(nativeSessionRef) ?? []), ...events]);
    return { nativeSessionRef };
  }
}
```

```ts
// packages/connector-codex/src/index.ts
export * from "./codex-events.js";
export * from "./codex-connector.js";
```

- [ ] **Step 5: Configure, verify, and commit Codex**

```json
// packages/connector-codex/package.json
{
  "name": "@hunter/connector-codex",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./dist/index.js",
  "scripts": { "build": "tsc -b", "typecheck": "tsc -b --pretty false" },
  "dependencies": { "@hunter/runtime-contracts": "*" }
}
```

```json
// packages/connector-codex/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "references": [{ "path": "../runtime-contracts" }],
  "include": ["src"]
}
```

Run: `npm test -- --run packages/connector-codex/src/codex-connector.test.ts`

Expected: `2 passed`; returned events remain execution facts only.

```powershell
git add packages/connector-codex
git commit -m "适配：接入 Codex 结构化会话与恢复"
```

### Task 8: Add the CodeBuddy ACP deep Connector

**Files:**
- Create: `packages/connector-codebuddy/package.json`
- Create: `packages/connector-codebuddy/tsconfig.json`
- Create: `packages/connector-codebuddy/src/acp-transport.ts`
- Create: `packages/connector-codebuddy/src/codebuddy-connector.ts`
- Create: `packages/connector-codebuddy/src/index.ts`
- Test: `packages/connector-codebuddy/src/codebuddy-connector.test.ts`

- [ ] **Step 1: Write failing ACP lifecycle tests**

```ts
// packages/connector-codebuddy/src/codebuddy-connector.test.ts
import { expect, it, vi } from "vitest";
import { CodeBuddyConnector } from "./codebuddy-connector.js";

it("initializes ACP, creates a session, and prompts it", async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ protocolVersion: 1 })
    .mockResolvedValueOnce({ sessionId: "cb_01" })
    .mockResolvedValueOnce({ accepted: true });
  const connector = new CodeBuddyConnector({ request });
  expect(await connector.launch({ operationId: "op_01", profileId: "cb_impl", workspaceRef: "ws_01", workspacePath: "C:\\work\\wt", prompt: "Implement" })).toEqual({ nativeSessionRef: "cb_01" });
  expect(request.mock.calls.map((call) => call[0].method)).toEqual(["initialize", "newSession", "prompt"]);
});

it("resumes by prompting the same session and cancels by run id", async () => {
  const request = vi.fn().mockResolvedValue({ accepted: true });
  const connector = new CodeBuddyConnector({ request });
  await connector.resume!("cb_01", { operationId: "op_02", profileId: "cb_impl", workspaceRef: "ws_01", workspacePath: "C:\\work\\wt", prompt: "Fix tests" });
  await connector.interrupt("cb_01", "op_02");
  expect(request).toHaveBeenNthCalledWith(1, { method: "prompt", params: { sessionId: "cb_01", runId: "op_02", prompt: "Fix tests" } });
  expect(request).toHaveBeenNthCalledWith(2, { method: "cancelRun", params: { sessionId: "cb_01", runId: "op_02" } });
});
```

- [ ] **Step 2: Run CodeBuddy tests to verify RED**

Run: `npm test -- --run packages/connector-codebuddy/src/codebuddy-connector.test.ts`

Expected: FAIL because `CodeBuddyConnector` is missing.

- [ ] **Step 3: Implement the loopback ACP HTTP transport**

```ts
// packages/connector-codebuddy/src/acp-transport.ts
export interface AcpRequest { readonly method: "initialize" | "newSession" | "prompt" | "cancelRun"; readonly params: Record<string, unknown> }
export interface AcpTransport { request(message: AcpRequest): Promise<Record<string, unknown>> }
export class HttpAcpTransport implements AcpTransport {
  constructor(private readonly endpoint: URL, private readonly transportReceipt: { readonly phase0Digest: string }) {
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") throw new Error("CODEBUDDY_TRANSPORT_NOT_PHASE0_LOOPBACK");
    if (!transportReceipt.phase0Digest.startsWith("sha256:")) throw new Error("CODEBUDDY_PHASE0_RECEIPT_REQUIRED");
  }
  async request(message: AcpRequest): Promise<Record<string, unknown>> {
    const response = await fetch(this.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
    if (!response.ok) throw new Error(`CODEBUDDY_ACP_${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  }
}
```

- [ ] **Step 4: Implement governed launch, resume, and cancel**

```ts
// packages/connector-codebuddy/src/codebuddy-connector.ts
import type { AgentConnector, LaunchRequest, LaunchResult } from "@hunter/runtime-contracts";
import type { AcpTransport } from "./acp-transport.js";

export class CodeBuddyConnector implements AgentConnector {
  // Task 15 computes the manifest from the selected Phase 0 transport and atomic probe receipt.
  readonly manifest: import("@hunter/runtime-contracts").CapabilityManifest;
  private initialized = false;
  constructor(private readonly transport: AcpTransport, manifest: import("@hunter/runtime-contracts").CapabilityManifest) { this.manifest = manifest; }
  async launch(request: LaunchRequest): Promise<LaunchResult> {
    if (!this.initialized) { await this.transport.request({ method: "initialize", params: { client: "hunter", protocolVersion: 1 } }); this.initialized = true; }
    const session = await this.transport.request({ method: "newSession", params: { cwd: request.workspacePath, profileId: request.profileId } });
    const nativeSessionRef = String(session.sessionId);
    await this.send(nativeSessionRef, { operationId: request.operationId, prompt: request.prompt });
    return { nativeSessionRef };
  }
  async send(nativeSessionRef: string, input: { operationId: string; prompt: string }): Promise<void> { await this.transport.request({ method: "prompt", params: { sessionId: nativeSessionRef, runId: input.operationId, prompt: input.prompt } }); }
  async resume(nativeSessionRef: string, request: LaunchRequest): Promise<LaunchResult> { await this.send(nativeSessionRef, { operationId: request.operationId, prompt: request.prompt }); return { nativeSessionRef }; }
  async interrupt(nativeSessionRef: string, operationId: string): Promise<void> { await this.transport.request({ method: "cancelRun", params: { sessionId: nativeSessionRef, runId: operationId } }); }
}
```

```ts
// packages/connector-codebuddy/src/index.ts
export * from "./acp-transport.js";
export * from "./codebuddy-connector.js";
```

- [ ] **Step 5: Configure, verify, and commit CodeBuddy**

```json
// packages/connector-codebuddy/package.json
{
  "name": "@hunter/connector-codebuddy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./dist/index.js",
  "scripts": { "build": "tsc -b", "typecheck": "tsc -b --pretty false" },
  "dependencies": { "@hunter/runtime-contracts": "*" }
}
```

```json
// packages/connector-codebuddy/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "references": [{ "path": "../runtime-contracts" }],
  "include": ["src"]
}
```

Run: `npm test -- --run packages/connector-codebuddy/src/codebuddy-connector.test.ts`

Expected: `2 passed` with exact `initialize/newSession/prompt/cancelRun` messages.

```powershell
git add packages/connector-codebuddy
git commit -m "适配：接入 CodeBuddy ACP 深度控制"
```

### Task 9: Add honest Cursor task-pack handoff and manual receipt

**Files:**
- Create: `packages/connector-cursor/package.json`
- Create: `packages/connector-cursor/tsconfig.json`
- Create: `packages/connector-cursor/src/task-pack.ts`
- Create: `packages/connector-cursor/src/cursor-handoff.ts`
- Create: `packages/connector-cursor/src/index.ts`
- Test: `packages/connector-cursor/src/cursor-handoff.test.ts`

- [ ] **Step 1: Write failing handoff-boundary tests**

```ts
// packages/connector-cursor/src/cursor-handoff.test.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CursorHandoff } from "./cursor-handoff.js";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it("opens the exact workspace and declares L1 without session control", async () => {
  root = mkdtempSync(join(tmpdir(), "hunter-cursor-"));
  const open = vi.fn(async () => ({ opened: true }));
  const handoff = new CursorHandoff({ open }, root);
  const result = await handoff.launch({ operationId: "op_01", profileId: "cursor_impl", workspaceRef: root, prompt: "Implement the UI" });
  expect(handoff.manifest).toMatchObject({ level: "L1", capabilities: ["launch", "open_surface", "collect_artifacts"] });
  expect(open).toHaveBeenCalledWith({ operationId: "op_01", workspacePath: root });
  expect(readFileSync(result.taskPackPath, "utf8")).toContain("Implement the UI");
});

it("requires a manual receipt instead of inventing success", async () => {
  root = mkdtempSync(join(tmpdir(), "hunter-cursor-"));
  const handoff = new CursorHandoff({ open: async () => ({ opened: true }) }, root);
  const result = await handoff.launch({ operationId: "op_02", profileId: "cursor_impl", workspaceRef: root, prompt: "Implement" });
  expect(result).toMatchObject({ status: "waiting_input", completionSource: "manual_receipt" });
});
```

- [ ] **Step 2: Run Cursor tests to verify RED**

Run: `npm test -- --run packages/connector-cursor/src/cursor-handoff.test.ts`

Expected: FAIL because `CursorHandoff` is missing.

- [ ] **Step 3: Write a provenance-rich task pack**

```ts
// packages/connector-cursor/src/task-pack.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function writeTaskPack(root: string, input: { operationId: string; prompt: string; workspaceRef: string }): string {
  const directory = join(root, ".hunter", "handoffs");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${input.operationId}.md`);
  writeFileSync(path, `# Hunter Task Handoff\n\nOperation: ${input.operationId}\nWorkspace: ${input.workspaceRef}\n\n## Instruction\n\n${input.prompt}\n\n## Completion\n\nReturn to Hunter and submit a completion receipt; Hunter will verify the declared outputs.\n`, "utf8");
  return path;
}
```

- [ ] **Step 4: Implement L1 launch and manual completion semantics**

```ts
// packages/connector-cursor/src/cursor-handoff.ts
import type { NativeSurfaceOpener } from "@hunter/runtime-contracts";
import { writeTaskPack } from "./task-pack.js";

export class CursorHandoff {
  readonly manifest = { connectorId: "cursor-handoff", level: "L1" as const, capabilities: ["launch", "open_surface", "collect_artifacts"] as const, version: "1" };
  constructor(private readonly opener: NativeSurfaceOpener, private readonly handoffRoot: string) {}
  async launch(request: { operationId: import("@hunter/domain").OperationId; profileId: string; workspaceRef: string; workspacePath: import("@hunter/runtime-contracts").VerifiedWorkspacePath; prompt: string }) {
    const workspacePath = request.workspacePath;
    const taskPackPath = writeTaskPack(this.handoffRoot, { ...request, workspaceRef: workspacePath });
    await this.opener.open({ operationId: request.operationId, workspacePath });
    return { nativeSessionRef: `manual:${request.operationId}`, taskPackPath, status: "waiting_input" as const, completionSource: "manual_receipt" as const };
  }
}
```

```ts
// packages/connector-cursor/src/index.ts
export * from "./task-pack.js";
export * from "./cursor-handoff.js";
```

- [ ] **Step 5: Configure, verify, and commit Cursor handoff**

```json
// packages/connector-cursor/package.json
{
  "name": "@hunter/connector-cursor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./dist/index.js",
  "scripts": { "build": "tsc -b", "typecheck": "tsc -b --pretty false" },
  "dependencies": { "@hunter/runtime-contracts": "*" }
}
```

```json
// packages/connector-cursor/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "references": [{ "path": "../runtime-contracts" }],
  "include": ["src"]
}
```

Run: `npm test -- --run packages/connector-cursor/src/cursor-handoff.test.ts`

Expected: `2 passed`; the result remains `waiting_input` until a receipt and verifier resolve it.

```powershell
git add packages/connector-cursor
git commit -m "适配：实现 Cursor 原生窗口与人工回执交接"
```

### Task 10: Coordinate Task child runs and stop bounded loops safely

**Files:**
- Create: `packages/flow-engine/src/task-scheduler.ts`
- Create: `packages/flow-engine/src/loop-guard.ts`
- Modify: `packages/flow-engine/src/index.ts`
- Create: `apps/daemon/src/services/run-coordinator.ts`
- Test: `packages/flow-engine/src/task-scheduler.test.ts`
- Test: `packages/flow-engine/src/loop-guard.test.ts`
- Test: `apps/daemon/test/run-coordinator.test.ts`

- [ ] **Step 1: Write failing parallel scheduling and root/child identity tests**

```ts
// packages/flow-engine/src/task-scheduler.test.ts
import { expect, it } from "vitest";
import { TaskScheduler } from "./task-scheduler.js";

it("starts independent tasks as child runs and waits for their dependent", () => {
  const scheduler = new TaskScheduler([
    { taskId: "task_api", dependsOn: [] },
    { taskId: "task_ui", dependsOn: [] },
    { taskId: "task_integration", dependsOn: ["task_api", "task_ui"] },
  ]);
  expect(scheduler.ready(new Set())).toEqual(["task_api", "task_ui"]);
  expect(scheduler.childRun("run_root", "task_api")).toEqual({ runId: "run_root:task_api", parentRunId: "run_root", taskId: "task_api" });
  expect(scheduler.ready(new Set(["task_api"]))).toEqual([]);
  expect(scheduler.ready(new Set(["task_api", "task_ui"]))).toEqual(["task_integration"]);
});
```

```ts
// apps/daemon/test/run-coordinator.test.ts
import { expect, it, vi } from "vitest";
import { RunCoordinator } from "../src/services/run-coordinator.js";
it("dispatches each ready Task once into an isolated child Run", async () => {
  const start = vi.fn(async () => undefined);
  const coordinator = new RunCoordinator({ start });
  const ready = await coordinator.dispatch("run_root", [{ taskId: "task_api", dependsOn: [] }, { taskId: "task_ui", dependsOn: [] }], new Set(), new Set());
  expect(ready).toEqual(["task_api", "task_ui"]);
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ parentRunId: "run_root", taskId: "task_api", workspacePolicy: "new_worktree" }));
});
```

- [ ] **Step 2: Write failing loop-stop tests**

```ts
// packages/flow-engine/src/loop-guard.test.ts
import { expect, it } from "vitest";
import { LoopGuard } from "./loop-guard.js";

it("stops on attempt, elapsed-time, cost, or repeated-failure bounds", () => {
  const guard = new LoopGuard({ maxAttempts: 3, maxDurationMs: 60_000, maxCostMicros: 500_000, repeatedFailureLimit: 2 });
  expect(guard.check({ attempts: 3, elapsedMs: 1, costMicros: 1, failureDigests: [] })).toEqual({ proceed: false, reason: "MAX_ATTEMPTS" });
  expect(guard.check({ attempts: 1, elapsedMs: 60_001, costMicros: 1, failureDigests: [] })).toEqual({ proceed: false, reason: "MAX_DURATION" });
  expect(guard.check({ attempts: 1, elapsedMs: 1, costMicros: 500_001, failureDigests: [] })).toEqual({ proceed: false, reason: "MAX_COST" });
  expect(guard.check({ attempts: 2, elapsedMs: 1, costMicros: 1, failureDigests: ["same", "same"] })).toEqual({ proceed: false, reason: "REPEATED_FAILURE" });
});
```

- [ ] **Step 3: Run scheduler and loop tests to verify RED**

Run: `npm test -- --run packages/flow-engine/src/task-scheduler.test.ts packages/flow-engine/src/loop-guard.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement deterministic Task readiness and child-run references**

```ts
// packages/flow-engine/src/task-scheduler.ts
export class TaskScheduler {
  constructor(private readonly tasks: readonly { taskId: string; dependsOn: readonly string[] }[]) {}
  ready(completed: ReadonlySet<string>, active: ReadonlySet<string> = new Set()): string[] {
    return this.tasks.filter((task) => !completed.has(task.taskId) && !active.has(task.taskId) && task.dependsOn.every((dependency) => completed.has(dependency))).map((task) => task.taskId);
  }
  childRun(parentRunId: string, taskId: string): { runId: string; parentRunId: string; taskId: string } {
    if (!this.tasks.some((task) => task.taskId === taskId)) throw new Error(`TASK_NOT_FOUND:${taskId}`);
    return { runId: `${parentRunId}:${taskId}`, parentRunId, taskId };
  }
}
```

- [ ] **Step 5: Implement all four loop stop conditions**

```ts
// packages/flow-engine/src/loop-guard.ts
export interface LoopBudget { readonly maxAttempts: number; readonly maxDurationMs: number; readonly maxCostMicros: number; readonly repeatedFailureLimit: number }
export class LoopGuard {
  constructor(private readonly budget: LoopBudget) {}
  check(state: { attempts: number; elapsedMs: number; costMicros: number; failureDigests: readonly string[] }): { proceed: true } | { proceed: false; reason: string } {
    if (state.attempts >= this.budget.maxAttempts) return { proceed: false, reason: "MAX_ATTEMPTS" };
    if (state.elapsedMs > this.budget.maxDurationMs) return { proceed: false, reason: "MAX_DURATION" };
    if (state.costMicros > this.budget.maxCostMicros) return { proceed: false, reason: "MAX_COST" };
    const tail = state.failureDigests.slice(-this.budget.repeatedFailureLimit);
    if (tail.length === this.budget.repeatedFailureLimit && new Set(tail).size === 1) return { proceed: false, reason: "REPEATED_FAILURE" };
    return { proceed: true };
  }
}
```

- [ ] **Step 6: Coordinate isolated child runs through Interfaces**

```ts
// apps/daemon/src/services/run-coordinator.ts
import { TaskScheduler } from "@hunter/flow-engine";
export interface ChildRunCommands { start(input: { idempotencyKey: string; runId: string; parentRunId: string; taskId: string; workspacePolicy: "new_worktree" }): Promise<void> }
export class RunCoordinator {
  constructor(private readonly commands: ChildRunCommands) {}
  async dispatch(parentRunId: string, tasks: readonly { taskId: string; dependsOn: readonly string[] }[], completed: ReadonlySet<string>, active: ReadonlySet<string>): Promise<string[]> {
    const scheduler = new TaskScheduler(tasks);
    const ready = scheduler.ready(completed, active);
    await Promise.all(ready.map(async (taskId) => { const child = scheduler.childRun(parentRunId, taskId); await this.commands.start({ idempotencyKey: `dispatch:${child.runId}`, ...child, workspacePolicy: "new_worktree" }); }));
    return ready;
  }
}
```

```ts
// append to packages/flow-engine/src/index.ts
export * from "./task-scheduler.js";
export * from "./loop-guard.js";
```

- [ ] **Step 7: Verify bounded orchestration and commit**

Run: `npm test -- --run packages/flow-engine/src/task-scheduler.test.ts packages/flow-engine/src/loop-guard.test.ts apps/daemon/test/run-coordinator.test.ts`

Expected: all tests pass; two child Runs start in parallel, the dependent waits, and repeated failures end at `needs_attention` without creating another Attempt.

```powershell
git add packages/flow-engine apps/daemon/src/services/run-coordinator.ts apps/daemon/test/run-coordinator.test.ts
git commit -m "流程：调度并行子 Run 并限制自动循环"
```

### Task 11: Package the local product as a secure Electron desktop app

> **Corrected by Task 16:** Electron uses a narrow validated IPC bridge. The daemon selects port `0`, receives a per-start capability over a protected pipe, and never exposes its port or secret to the renderer. The fixed-port, renderer `apiOrigin`, arbitrary web URL, and direct renderer HTTP samples below must not ship.

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/preload.ts`
- Create: `apps/desktop/src/daemon-supervisor.ts`
- Test: `apps/desktop/src/daemon-supervisor.test.ts`

- [ ] **Step 1: Write a failing daemon-supervisor test**

```ts
// apps/desktop/src/daemon-supervisor.test.ts
import { expect, it, vi } from "vitest";
import { DaemonSupervisor } from "./daemon-supervisor.js";

it("starts hunterd once and terminates only its owned process", async () => {
  const child = { pid: 1234, kill: vi.fn(), once: vi.fn() };
  const spawn = vi.fn(() => child);
  const supervisor = new DaemonSupervisor(spawn as never, "C:\\Hunter\\daemon.js");
  expect(supervisor.start()).toBe(supervisor.start());
  supervisor.stop();
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});
```

- [ ] **Step 2: Run the desktop test to verify RED**

Run: `npm test -- --run apps/desktop/src/daemon-supervisor.test.ts`

Expected: FAIL because `DaemonSupervisor` is missing.

- [ ] **Step 3: Implement an owned daemon process supervisor**

```ts
// apps/desktop/src/daemon-supervisor.ts
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export class DaemonSupervisor {
  private child?: ChildProcess;
  constructor(private readonly spawn: Spawn = nodeSpawn, private readonly daemonEntry: string) {}
  start(): ChildProcess {
    if (this.child) return this.child;
    this.child = this.spawn(process.execPath, [this.daemonEntry, "--port=0", "--bootstrap-stdin"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.child.once("exit", () => { this.child = undefined; });
    return this.child;
  }
  stop(): void { this.child?.kill("SIGTERM"); }
}
```

- [ ] **Step 4: Create a locked-down Electron window and preload bridge**

```ts
// apps/desktop/src/main.ts
import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { DaemonSupervisor } from "./daemon-supervisor.js";

const supervisor = new DaemonSupervisor(undefined, join(app.getAppPath(), "daemon", "main.js"));
await app.whenReady();
supervisor.start();
const window = new BrowserWindow({ width: 1280, height: 820, webPreferences: { preload: join(import.meta.dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
window.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith("https://")) void shell.openExternal(url); return { action: "deny" }; });
await window.loadFile(join(app.getAppPath(), "web", "index.html"));
app.on("before-quit", () => supervisor.stop());
```

```ts
// apps/desktop/src/preload.ts
import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("hunterDesktop", Object.freeze({ platform: process.platform, request: (method: string, payload: unknown) => ipcRenderer.invoke("hunter:request", { method, payload }) }));
```

- [ ] **Step 5: Configure packaging, verify, and commit**

```json
// apps/desktop/package.json
{
  "name": "@hunter/desktop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/main.js",
  "scripts": { "build": "tsc -b", "typecheck": "tsc -b --pretty false", "pack:win": "electron-builder --win nsis --x64" },
  "devDependencies": { "electron": "^37.2.0", "electron-builder": "^26.0.12" }
}
```

```json
// apps/desktop/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "include": ["src"]
}
```

Run: `npm test -- --run apps/desktop/src/daemon-supervisor.test.ts; npm run build -w @hunter/desktop; npm run pack:win -w @hunter/desktop`

Expected: test passes and `apps/desktop/dist-installers/` contains one Windows NSIS installer; no renderer has Node integration.

```powershell
git add apps/desktop package-lock.json
git commit -m "桌面：封装本地守护进程与安全 Electron 客户端"
```

### Task 12: Add scoped device pairing and a mobile PWA cockpit

> **Corrected by Task 17:** the in-memory code map, perpetual HMAC token, unauthenticated pairing-code route, and `runId`-only UI callbacks below are rejected RED examples. Implement the persistent challenge/device/rotating-refresh model and authenticated command envelope in Task 17.

**Files:**
- Create: `packages/device-gateway/package.json`
- Create: `packages/device-gateway/tsconfig.json`
- Create: `packages/device-gateway/src/index.ts`
- Create: `packages/device-gateway/src/device-gateway.ts`
- Test: `packages/device-gateway/src/device-gateway.test.ts`
- Create: `apps/daemon/src/routes/devices.ts`
- Modify: `apps/daemon/src/app.ts`
- Create: `apps/web/public/manifest.webmanifest`
- Create: `apps/web/public/icons/hunter.svg`
- Create: `apps/web/public/sw.js`
- Create: `apps/web/src/pages/mobile-cockpit.tsx`
- Create: `apps/web/src/styles/mobile.css`
- Test: `apps/web/src/pages/mobile-cockpit.test.tsx`

- [ ] **Step 1: Write failing one-time pairing and scope tests**

```ts
// packages/device-gateway/src/device-gateway.test.ts
import { expect, it } from "vitest";
import { DeviceGateway } from "./device-gateway.js";

it("consumes a pairing code once and limits mobile capabilities", () => {
  const gateway = new DeviceGateway("test-signing-key-that-is-at-least-32-bytes");
  const code = gateway.createPairingCode("desktop_01", 60_000);
  const device = gateway.pair(code.value, "phone");
  expect(device.scopes).toEqual(["runs:read", "artifacts:read", "gates:approve", "runs:control"]);
  expect(() => gateway.pair(code.value, "second-phone")).toThrow("PAIRING_CODE_ALREADY_USED");
  expect(gateway.authorize(device.token, "policy:write")).toBe(false);
});
```

- [ ] **Step 2: Write a failing 390px cockpit test**

```tsx
// apps/web/src/pages/mobile-cockpit.test.tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { MobileCockpit } from "./mobile-cockpit.js";

it("shows waiting Runs and safe controls without workflow editing", () => {
  render(<MobileCockpit runs={[{ runId: "run_01", projectName: "Hunter", currentStep: "approve_plan", attention: "等待审批" }]} onApprove={async () => undefined} onPause={async () => undefined} onResume={async () => undefined} onTerminate={async () => undefined} onSupplement={async () => undefined} />);
  expect(screen.getByText("等待审批")).toBeTruthy();
  expect(screen.getByRole("button", { name: "批准" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "补充指令" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "继续" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "终止" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "编辑工作流" })).toBeNull();
});
```

- [ ] **Step 3: Keep the insecure in-memory pairing sample RED; Task 17 supplies the production implementation**

```ts
// packages/device-gateway/src/device-gateway.ts
// The rejected in-memory/HMAC implementation has been removed.
// DeviceGateway is composed from SqliteDeviceStore, PairingService,
// TokenService, DeviceProofVerifier, and MobileCommandService in Task 17.
export { DeviceGateway } from "./persistent-device-gateway.js";
```

- [ ] **Step 4: Expose pairing without granting desktop-only scopes**

```ts
// apps/daemon/src/routes/devices.ts
import type { FastifyInstance } from "fastify";
import type { DeviceGateway } from "@hunter/device-gateway";
export async function deviceRoutes(app: FastifyInstance, gateway: DeviceGateway): Promise<void> {
  // Pairing challenge creation is registered only on the authenticated desktop IPC service in Task 17.
  app.post<{ Body: { challengeId: string; code: string; name: string; publicKeyJwk: JsonWebKey; proof: string; confirmationId: string } }>("/api/v1/devices/pair", async (request, reply) => {
    try { return reply.code(201).send(await gateway.pair(request.body)); }
    catch (error) { return reply.code(401).send({ code: error instanceof Error ? error.message : "PAIRING_FAILED" }); }
  });
}
```

```ts
// register in apps/daemon/src/app.ts
if (services.deviceGateway) void deviceRoutes(app, services.deviceGateway);
```

- [ ] **Step 5: Implement the focused mobile cockpit**

```tsx
// apps/web/src/pages/mobile-cockpit.tsx
import "../styles/mobile.css";
interface MobileRun { runId: string; projectName: string; currentStep: string; attention: string }
interface MobileActions { onApprove(id: string): Promise<void>; onPause(id: string): Promise<void>; onResume(id: string): Promise<void>; onTerminate(id: string): Promise<void>; onSupplement(id: string): Promise<void> }
export function MobileCockpit({ runs, onApprove, onPause, onResume, onTerminate, onSupplement }: { runs: readonly MobileRun[] } & MobileActions) {
  return <main className="mobile-cockpit"><h1>Hunter</h1>{runs.map((run) => <article key={run.runId}><h2>{run.projectName}</h2><p>{run.currentStep}</p><strong>{run.attention}</strong><div><button onClick={() => void onApprove(run.runId)}>批准</button><button onClick={() => void onSupplement(run.runId)}>补充指令</button><button onClick={() => void onPause(run.runId)}>暂停</button><button onClick={() => void onResume(run.runId)}>继续</button><button onClick={() => void onTerminate(run.runId)}>终止</button></div></article>)}</main>;
}
```

```css
/* apps/web/src/styles/mobile.css */
.mobile-cockpit { max-width: 42rem; margin: 0 auto; padding: 1rem; font: 1rem/1.5 system-ui; }
.mobile-cockpit article { border: 1px solid #cbd5e1; border-radius: .75rem; margin-block: .75rem; padding: 1rem; }
.mobile-cockpit button { min-height: 44px; margin: .5rem .5rem 0 0; padding: .5rem 1rem; }
@media (min-width: 700px) { .mobile-cockpit { padding: 2rem; } }
```

- [ ] **Step 6: Add installable PWA metadata and network behavior**

```json
{
  "name": "Hunter Pocket",
  "short_name": "Hunter",
  "start_url": "/mobile",
  "display": "standalone",
  "background_color": "#0f172a",
  "theme_color": "#0f172a",
  "icons": [{ "src": "/icons/hunter.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable" }]
}
```

```svg
<!-- apps/web/public/icons/hunter.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0f172a"/><path d="M128 112h72v108h112V112h72v288h-72V292H200v108h-72z" fill="#38bdf8"/></svg>
```

```js
// apps/web/public/sw.js
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).catch(() => new Response(JSON.stringify({ offline: true }), { status: 503, headers: { "content-type": "application/json" } })));
});
```

```ts
// append to apps/web/src/main.tsx
if ("serviceWorker" in navigator) window.addEventListener("load", () => { void navigator.serviceWorker.register("/sw.js"); });
```

```ts
// packages/device-gateway/src/index.ts
export * from "./device-gateway.js";
```

```json
// packages/device-gateway/package.json
{
  "name": "@hunter/device-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./dist/index.js",
  "scripts": { "build": "tsc -b", "typecheck": "tsc -b --pretty false" }
}
```

```json
// packages/device-gateway/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "composite": true },
  "include": ["src"]
}
```

- [ ] **Step 7: Verify pairing, responsive UI, and commit**

Run: `npm test -- --run packages/device-gateway/src/device-gateway.test.ts apps/web/src/pages/mobile-cockpit.test.tsx`

Expected: `2 passed`; mobile tokens cannot obtain `policy:write`.

```powershell
git add packages/device-gateway apps/daemon/src/routes/devices.ts apps/web/public apps/web/src/pages/mobile-cockpit.tsx apps/web/src/styles/mobile.css
git commit -m "移动：提供受限配对与 PWA 远程驾驶舱"
```

### Task 13A/13B: Freeze the RED owner story, then prove the complete slice

**Normative order:** after Task 12, execute **13A Steps 1–4 only** to create the
failing owner-story spec, fixture shell, and Playwright configuration. Then
execute Tasks 14–19. Return for **13B Steps 5–9** only after Task 19's API-chain
composition test and authenticated `start:e2e --verify` are green. This split is
a one-way dependency: Task 19 modifies the files created by 13A; 13B never
provides an input to Task 19.

**Files:**
- Create: `e2e/fixtures/fake-runtime-scenario.ts`
- Create: `e2e/vertical-slice.spec.ts`
- Create: `e2e/windows-real-providers.spec.ts`
- Create: `playwright.config.ts`
- Create: `scripts/start-e2e.mjs`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `.github/workflows/ci.yml`
- Create: `docs/validation/vertical-slice-acceptance.md`

- [ ] **13A Step 1: Write the failing owner-story E2E test**

```ts
// e2e/vertical-slice.spec.ts
import { expect, test } from "@playwright/test";

test("Requirement to archived knowledge survives one failed implementation loop", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("项目名称").fill("Hunter E2E");
  await page.getByRole("button", { name: "创建项目" }).click();
  await page.getByRole("button", { name: "Hunter E2E" }).click();
  await page.getByLabel("需求标题").fill("移动审批");
  await page.getByLabel("验收标准").fill("手机批准后恢复 Run");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await page.getByRole("button", { name: "批准此版本" }).click();
  await page.getByRole("button", { name: "使用并行客户端模板" }).click();
  await page.getByRole("button", { name: "确认执行计划" }).click();
  await page.getByRole("button", { name: "启动工作流" }).click();
  await expect(page.getByText("执行：已返回 · 验证：失败")).toBeVisible();
  await expect(page.getByText("第 2 次尝试 · 执行中")).toBeVisible();
  await expect(page.getByText("Run 已归档")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "知识" }).click();
  await expect(page.getByText(/来源：RequirementRevision rr_/)).toBeVisible();
  await expect(page.getByText(/来源：Archive run_/)).toBeVisible();
});
```

- [ ] **13A Step 2: Create the deterministic failure-then-pass fixture shell**

```ts
// e2e/fixtures/fake-runtime-scenario.ts
import { FakeRuntimeProvider } from "@hunter/testkit";
export function createVerticalSliceRuntime(): FakeRuntimeProvider {
  const provider = new FakeRuntimeProvider();
  let verification = 0;
  Object.assign(provider, { verify: async () => ({ status: ++verification === 1 ? "failed" : "passed", evidence: [{ kind: "test", command: "npm test", exitCode: verification === 1 ? 1 : 0 }] }) });
  return provider;
}
```

- [ ] **13A Step 3: Configure a runnable RED scaffold and browser contract**

Create the first `scripts/start-e2e.mjs` as a deliberately incomplete but
runnable test composition. It uses an isolated temporary data directory,
starts the existing Foundation-authenticated daemon on an OS-assigned random
loopback port, and serves test-only Web assets/readiness on fixed loopback port
`4173` under an exclusive `.hunter-e2e/active.lock`. It provisions only a
test-scoped local principal through the same authentication port, then
atomically writes `.hunter-e2e/playwright-state.json` with the scoped session
cookie/origin state and CSRF bootstrap material before publishing readiness;
Windows ACL/POSIX mode must restrict the file to the current user. The launcher
cleans up only processes/data it owns and removes the state/lock on exit. It must render the Project
page and accept the initial Project/Requirement commands, but it intentionally
does **not** wire Flow -> Runtime -> Verifier -> Archive -> Knowledge. It must
not add a production route, bypass authentication, use developer data, or log a
credential. Task 19 modifies this exact scaffold into the full composition.
In the same RED setup, add the root package script
`"start:e2e": "node scripts/start-e2e.mjs"`; the script exists and reaches
readiness before 13A Step 4 runs. Add `.hunter-e2e/` to `.gitignore`; no
credential or state file may be staged or included in a package.

```ts
// playwright.config.ts
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  retries: 0,
  // 4173 serves test-only static assets/readiness. Task 19 keeps the authenticated daemon on port 0.
  use: {
    baseURL: "http://127.0.0.1:4173",
    storageState: ".hunter-e2e/playwright-state.json",
    trace: "retain-on-failure"
  },
  webServer: { command: "npm run start:e2e", url: "http://127.0.0.1:4173/__e2e_ready", reuseExistingServer: false, timeout: 120_000 },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }, { name: "mobile", use: devices["Pixel 7"] }],
});
```

- [ ] **13A Step 4: Run the owner-story contract RED**

Run: `npx playwright test e2e/vertical-slice.spec.ts --project=chromium`

Expected: FAIL inside the owner story at the first unwired Run/verification
transition because the full vertical composition does not exist yet. The web
server, health/readiness, authenticated Project/Requirement setup, and
`chromium` project must all succeed; the failure must not be a missing npm
script, config, project, syntax, import, authentication, or startup error.
The RED evidence must show committed `ProjectCreated` and
`RequirementRevisionApproved` positions followed by the explicit application
error `RUN_COMPOSITION_NOT_WIRED`; a `401`, CSRF error, or failure before those
two events is an invalid RED and must be fixed before Task 14.

- [ ] **13B Step 5: Add opt-in real-provider assertions without weakening CI**

```ts
// e2e/windows-real-providers.spec.ts
import { expect, test } from "@playwright/test";
test.skip(process.platform !== "win32" || process.env.HUNTER_REAL_AGENTS !== "1", "requires owner-approved installed agents");
test("Codex, CodeBuddy, Orca, and Cursor publish honest capability receipts", async ({ request }) => {
  const response = await request.post("/api/v1/validation/real-providers", { data: { repositoryFixture: "e2e-read-only-fixture" } });
  expect(response.ok()).toBe(true);
  const body = await response.json() as { connectors: Record<string, { level: string; computedFromProbe: string; verified: boolean }> };
  expect(body.connectors.codex.level).toBe(body.connectors.codex.computedFromProbe);
  expect(body.connectors.codebuddy.level).toBe(body.connectors.codebuddy.computedFromProbe);
  expect(body.connectors.cursor.level).toBe("L1");
  expect(body.connectors.orca.verified).toBe(true);
});
```

- [ ] **13B Step 6: Extend CI with browser tests on both systems and packaging on Windows**

```yaml
# append jobs in .github/workflows/ci.yml
  vertical-slice:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npx playwright test e2e/vertical-slice.spec.ts
      - if: runner.os == 'Windows'
        run: npm run pack:win -w @hunter/desktop
```

- [ ] **13B Step 7: Run the full Windows acceptance gate**

Run: `npm run lint; npm run typecheck; npm test; npx playwright test e2e/vertical-slice.spec.ts; npm run build; npm run pack:win -w @hunter/desktop`

Expected: every command exits `0`; the E2E run contains at least two implementation Attempts, reaches `archived`, and exposes linked RequirementRevision and Archive knowledge.

- [ ] **13B Step 8: Run owner-approved real Connector checks**

Run: `$env:HUNTER_REAL_AGENTS='1'; npx playwright test e2e/windows-real-providers.spec.ts --project=chromium; Remove-Item Env:HUNTER_REAL_AGENTS`

Expected: PASS only after the installed versions match Phase 0 evidence; otherwise a named Connector fails with its raw capability receipt and no Run is marked successful.

- [ ] **13B Step 9: Record evidence and commit the vertical slice**

```markdown
<!-- docs/validation/vertical-slice-acceptance.md -->
# Vertical Slice Acceptance

- Platform: Windows 11 x64
- Root run: one Change delivery WorkflowRun
- Child runs: one WorkflowRun per Task with parentRunId and taskId
- Loop evidence: first implementation Attempt failed verification; second passed
- Archive: terminal Run manifest written and hashed
- Knowledge: RequirementRevision authoritative entry plus Archive historical entry
- Mobile: 390px approval, pause, and artifact summary verified
- Linux: typecheck, unit, and Chromium E2E passed in CI
```

```powershell
git add e2e playwright.config.ts .github/workflows/ci.yml docs/validation/vertical-slice-acceptance.md package.json package-lock.json
git commit -m "验收：贯通 Hunter 首个多 Agent 纵向切片"
```

### Task 14: Enforce shared trust boundaries, durable operations, and scoped leases

**Execution order:** after Task 13A Steps 1–4, run Tasks 14 -> 15 -> 16 -> 17 -> 18 -> 19, then return to Task 13B Steps 5–9. These tasks consume the Foundation contracts; they must not create a second journal, in-memory outbox, SSE hub, or lease registry.

**Files:**
- Modify: `packages/domain/src/ids.ts`
- Modify: `packages/runtime-contracts/src/external-boundary.ts`
- Modify: `packages/runtime-contracts/src/operations.ts`
- Modify: `packages/runtime-contracts/src/leases.ts`
- Modify: `packages/runtime-contracts/src/index.ts`
- Modify: `packages/runtime-manager/src/lease-service.ts`
- Modify: `packages/provider-orca/src/orca-client.ts`
- Modify: `packages/provider-orca/src/orca-workspace-provider.ts`
- Modify: `packages/connector-cursor/src/task-pack.ts`
- Modify: `packages/connector-cursor/src/cursor-handoff.ts`
- Modify: `packages/api-contracts/src/http.ts`
- Modify: `apps/daemon/src/routes/requirements.ts`
- Modify: `apps/daemon/src/routes/changes.ts`
- Modify: `apps/daemon/src/routes/runs.ts`
- Test: `packages/runtime-contracts/src/external-boundary.test.ts`
- Test: `packages/runtime-manager/src/operation-recovery.contract.test.ts`
- Test: `packages/runtime-manager/src/lease-service.integration.test.ts`
- Test: `apps/daemon/test/domain-route-boundary.test.ts`

- [ ] **Step 1: Write RED boundary tests**

The tests must prove that route params and provider JSON reject an invalid prefix, more than 96 characters, `..`, slash/backslash, NUL, and a forged cross-Project ID before any repository lookup or adapter call. The authenticated HTTP integration test exercises every Requirement, Change, and Run route and proves malformed branded IDs, an unknown field, a RequirementRevision from another Project, a Change/ExecutionPlan mismatch, and a Run/Project mismatch are rejected before the mocked application command is called. Create real filesystem fixtures proving that `realpath.native` rejects a Windows junction escape, a Linux symlink escape, a case/drive alias outside the registered root, a mismatched UNC share, and a long-path alias that resolves outside the issued workspace. Also prove that an opaque `workspaceRef` cannot be passed where a `VerifiedWorkspacePath` is required and that only a branded `OperationId` can become a task-pack filename.

- [ ] **Step 2: Write RED crash and lease tests**

Use the Foundation `SqliteOperationJournal`, `OperationWorker`, `outbox`, `side_effect_receipts`, and `lease_records`. Inject a crash after the fake external system creates a worktree/session/window but before the local receipt commit; reconstruct the database client, worker, and adapter, then assert one external object and the original `operationId` receipt. When the upstream system cannot look up or attach by idempotency key, assert `indeterminate` plus `needs_attention` and zero blind redispatches. Lease tests must cover two parallel writers receiving distinct worktrees, a second writer on one canonical path being rejected, stale generation renew/release being rejected, expiry, wrong DeviceBinding, wrong worktree, and Git HEAD drift during recovery.

Run: `npm test -- --run packages/runtime-contracts/src/external-boundary.test.ts packages/runtime-manager/src/operation-recovery.contract.test.ts packages/runtime-manager/src/lease-service.integration.test.ts apps/daemon/test/domain-route-boundary.test.ts`

Expected RED: failures name `UNBRANDED_ID`, `PATH_SCOPE_VIOLATION`, missing durable recovery, and missing lease generation checks; no test may fail merely because its fixture path does not exist.

- [ ] **Step 3: Implement the minimum shared boundary**

Define prefix-specific Zod schemas and branded `ProjectId`, `RepositoryId`, `RequirementId`, `RequirementRevisionId`, `ChangeId`, `ChangeRevisionId`, `ExecutionPlanId`, `DeviceId`, `RunId`, `StepRunId`, `GateId`, `OperationId`, and lease/session IDs. Only schema decoders construct brands. `external-boundary.ts` must decode every upstream object with strict schemas and size limits, resolve registered repository roots and returned workspace paths with `realpath.native`, normalize Windows drive/UNC/extended-path comparison keys, and check containment with path-segment semantics rather than string prefixes. `packages/api-contracts` owns the strict request/response schemas; each daemon route parses params/body with them, loads the authenticated Project relation, and only then calls an application command. HTTP and mobile inputs contain domain IDs only; RuntimeManager derives repository path, Agent profile, budget, policy, and workspace from persisted Project/DeviceBinding/Step data.

Keep `workspaceRef` opaque. A provider result contains both an opaque ref and a separately verified path. `WorkspaceLease`, `WriterLease`, and `ControllerLease` include Project, Repository, Device, canonical workspace key, Git HEAD, branch, owner Run/Attempt, generation, mode, expiry, and revocation state. The Foundation lease service alone acquires, renews, releases, and recovers them; adapters launch only after a durable lease receipt.

- [ ] **Step 4: Route every side effect through the Foundation operation journal**

`SqliteOperationJournal.commitCommand(...)` is the sole transaction that writes Domain Event + request-fingerprinted command receipt + Outbox. The Foundation `OperationWorker` invokes an injected `ExternalOperationHandler.execute(operation)`; Orca/Codex/CodeBuddy/Cursor/ProcessHost handlers never keep an idempotency Map. Before dispatch, a handler checks the durable receipt and, after an uncertain crash, reconciles by upstream client request ID, deterministic operation label, or attachable native ref. Confirmed success records `side_effect_receipts`, Event, and Evidence before the Outbox row completes. Confirmed absence may dispatch once. Ambiguity is fail-closed as `indeterminate/needs_attention`.

This applies to every side-effecting `create/launch/send/resume/interrupt/open/write/release` operation, including Cursor task-pack publication and native window opening. Read-only probe/observe calls still decode untrusted output through the shared boundary.

- [ ] **Step 5: Verify and checkpoint**

Run: `npm test -- --run packages/runtime-contracts/src/external-boundary.test.ts packages/runtime-manager/src/operation-recovery.contract.test.ts packages/runtime-manager/src/lease-service.integration.test.ts apps/daemon/test/domain-route-boundary.test.ts packages/provider-orca/src/orca-provider.test.ts packages/connector-cursor/src/cursor-handoff.test.ts`

Expected GREEN: every named test exits 0; the fault test reconstructs all process-local objects and still reports one external side effect; every rejected path/ID is rejected before dispatch.

```powershell
git add packages/domain/src/ids.ts packages/runtime-contracts packages/runtime-manager packages/provider-orca packages/connector-cursor packages/api-contracts apps/daemon/src/routes apps/daemon/test/domain-route-boundary.test.ts
git commit -m "安全：统一外部边界、持久副作用回执与租约"
```

**Completion evidence:** test output for `BND-01..08`, `OP-01..04`, and `LEASE-01..06`, plus the persisted Outbox/receipt rows from the crash-after-success case with secrets and absolute user paths redacted.

### Task 15: Compute L0-L3 from real capability probe receipts

**Files:**
- Modify: `packages/runtime-contracts/src/manifest.ts`
- Modify: `packages/runtime-contracts/src/operations.ts`
- Create: `packages/connector-codex/src/codex-probe.ts`
- Modify: `packages/connector-codex/src/codex-connector.ts`
- Create: `packages/connector-codebuddy/src/codebuddy-probe.ts`
- Modify: `packages/connector-codebuddy/src/acp-transport.ts`
- Modify: `packages/connector-codebuddy/src/codebuddy-connector.ts`
- Create: `packages/connector-cursor/src/cursor-probe.ts`
- Test: `packages/runtime-contracts/src/manifest.test.ts`
- Test: `packages/connector-codex/src/codex-connector.test.ts`
- Test: `packages/connector-codebuddy/src/codebuddy-connector.test.ts`
- Test: `packages/connector-cursor/src/cursor-handoff.test.ts`

- [ ] **Step 1: Write RED atomic-probe tests**

A `CapabilityProbeReceipt` records, for each atom, `supported | unsupported | unknown`, evidence source/digest, product and protocol version constraints, schema version, login state, and `probedAt`. Tests must prove: missing executable/login produces only proven lower capabilities; missing `approve` never advertises approval; no event stream never advertises observe; no completion receipt or reliable attach/recovery prevents L3; unknown product/protocol version and schema drift fail closed. Reordering capability fields must not change the computed level.

Define the deterministic ladder: L0 requires discovered launch/handoff plus verified workspace targeting; L1 additionally requires a proven observation or artifact channel; L2 additionally requires structured start/send/interrupt and a result/completion channel; L3 additionally requires permission events, structured tool events, policy hook, reliable attach/recovery, and durable completion receipt. The level is the highest fully satisfied prefix; a product name or target level has no effect.

- [ ] **Step 2: Write RED transport and durable-action tests**

Codex and CodeBuddy tests start from the selected Phase 0 receipt, not hardcoded assumptions. CodeBuddy receives the exact verified transport kind, endpoint, protocol, version range, and receipt digest; a missing or changed selection fails before network I/O. Codex and CodeBuddy `launch/newSession/send/resume/interrupt` are `ExternalOperationHandler` kinds from Task 14, use the Foundation stable `operationId`, and persist native refs. Inject crash-after-session-create and assert a new adapter instance reconciles/attaches or enters `needs_attention` without creating another session.

Run: `npm test -- --run packages/runtime-contracts/src/manifest.test.ts packages/connector-codex/src/codex-connector.test.ts packages/connector-codebuddy/src/codebuddy-connector.test.ts packages/connector-cursor/src/cursor-handoff.test.ts`

Expected RED: literal L3, the fixed CodeBuddy URL, fabricated `approve/observe/collect_artifacts`, and missing probe evidence are each caught by a named assertion.

- [ ] **Step 3: Implement probes and calculated manifests**

Implement versioned `probe()` methods that negotiate the actual selected transport and persist their receipts. `computeCapabilityManifest(receipt)` is the only manifest constructor. Preserve unknown upstream events as bounded raw Evidence, but never count them as capabilities. Cursor computes L0 by default and L1 only when its Git/artifact observer contract passes; manual completion remains a receipt followed by Hunter verification. Codex and CodeBuddy may calculate any L0-L3 value. They are never initialized as L3.

- [ ] **Step 4: Verify exact fixed-version matrices**

Run: `npm test -- --run packages/runtime-contracts/src/manifest.test.ts packages/connector-codex/src/codex-connector.test.ts packages/connector-codebuddy/src/codebuddy-connector.test.ts packages/connector-cursor/src/cursor-handoff.test.ts`

Expected GREEN: all named tests exit 0; downgrade cases assert the exact atom and resulting level. The opt-in real-provider E2E compares the complete receipt with the Phase 0 fixed-version matrix, not `L2|L3`.

```powershell
git add packages/runtime-contracts packages/connector-codex packages/connector-codebuddy packages/connector-cursor
git commit -m "适配：以实测回执计算连接器能力等级"
```

**Completion evidence:** redacted probe receipts for installed, logged-out, unknown-version, and schema-drift fixtures and an exact expected/actual matrix for each fixed real version.

### Task 16: Lock Electron to narrow IPC and an authenticated random-port daemon

**Files:**
- Create: `apps/desktop/src/ipc.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/daemon-supervisor.ts`
- Create: `apps/daemon/src/auth/local-capability.ts`
- Create: `apps/daemon/src/auth/http-boundary.ts`
- Modify: `apps/daemon/src/events/durable-event-stream.ts`
- Modify: `apps/daemon/src/app.ts`
- Test: `apps/desktop/src/ipc-security.test.ts`
- Test: `apps/daemon/test/local-auth-security.test.ts`

- [ ] **Step 1: Write RED desktop/API security tests**

Assert that the daemon binds loopback port `0`; a fresh 256-bit per-start capability travels only over inherited stdin/pipe; stdout readiness contains the selected port but no secret. The renderer global exposes named `projects.list`, `requirements.create/approve`, `changes.publish`, `runs.get/command`, `knowledge.list`, and `events.subscribe` methods with strict request/response schemas, not an origin, token, generic fetch, filesystem, shell, or arbitrary IPC channel.

Integration cases with no local capability, wrong Host, malicious Origin, cross-port POST, oversized/malformed JSON, cookie fallback, and unauthenticated SSE must be rejected. A non-loopback plaintext listen request must fail startup. Verify logs, process args/env, preload object, renderer storage, URL/history, and diagnostic export contain neither capability nor bearer.

Run: `npm test -- --run apps/desktop/src/ipc-security.test.ts apps/daemon/test/local-auth-security.test.ts`

Expected RED: the fixed port, renderer `apiOrigin`, arbitrary `HUNTER_WEB_URL`, direct renderer HTTP, and unscoped SSE are all detected.

- [ ] **Step 2: Implement the protected local channel**

Electron main creates the capability, starts the daemon with `--port=0 --bootstrap-stdin`, writes the capability through the inherited pipe, validates the daemon readiness record, and signs/proxies every request. The renderer loads packaged local assets; development accepts only the checked-in Vite origin when `app.isPackaged === false`. Preload freezes the named IPC surface. Main validates every payload and response with shared Zod schemas.

The daemon remains loopback-only by default, verifies exact runtime Host and desktop Origin, requires the local capability on REST and the Event Ledger stream, enforces payload/rate/connection limits, and uses `events.position` with `Last-Event-ID`. Project/Run authorization is applied before backlog and live-tail emission. A cursor before retention returns explicit `EVENT_CURSOR_GAP` plus snapshot/rebuild instructions.

- [ ] **Step 3: Verify and package**

Run: `npm test -- --run apps/desktop/src/daemon-supervisor.test.ts apps/desktop/src/ipc-security.test.ts apps/daemon/test/local-auth-security.test.ts; npm run build -w @hunter/desktop; npm run pack:win -w @hunter/desktop`

Expected GREEN: tests and build exit 0, an NSIS artifact is produced, two daemon starts select independently assigned ports, and all negative Host/Origin/auth/SSE cases are rejected.

```powershell
git add apps/desktop apps/daemon/src/auth apps/daemon/src/events/durable-event-stream.ts apps/daemon/src/app.ts
git commit -m "桌面：收窄 IPC 并认证随机端口本机守护进程"
```

**Completion evidence:** IPC allowlist snapshot, two redacted readiness records with different ports, negative security-test report, and packaged renderer inspection showing no Node integration or API credential.

### Task 17: Persist device identity and make every mobile action replay-safe over TLS

**Files:**
- Modify: `packages/storage/src/migrations/001-core.sql`
- Create: `packages/device-gateway/src/device-store.ts`
- Create: `packages/device-gateway/src/pairing-service.ts`
- Create: `packages/device-gateway/src/token-service.ts`
- Create: `packages/device-gateway/src/command-envelope.ts`
- Modify: `packages/device-gateway/src/device-gateway.ts`
- Modify: `apps/daemon/src/routes/devices.ts`
- Create: `apps/daemon/src/routes/mobile-commands.ts`
- Create: `apps/daemon/src/auth/remote-device-auth.ts`
- Create: `apps/daemon/src/auth/remote-tls-listener.ts`
- Create: `apps/web/src/mobile/device-key.ts`
- Create: `apps/web/src/mobile/credential-vault.ts`
- Create: `apps/web/src/mobile/command-outbox.ts`
- Modify: `apps/web/src/pages/mobile-cockpit.tsx`
- Test: `packages/device-gateway/src/device-security.test.ts`
- Test: `apps/daemon/test/mobile-command-security.test.ts`
- Test: `apps/web/src/mobile/credential-vault.test.ts`
- Test: `e2e/mobile-security.spec.ts`

- [ ] **Step 1: Write RED persistent pairing/token tests**

Use SQLite plus a fake clock. A pairing challenge is created only by an authenticated desktop IPC action, stored as hash + expiry + consumed state, survives daemon restart, expires after five minutes, and is single-use across concurrent consumers. The PWA generates the P-256 **private key** with WebCrypto `extractable: false`, persists the `CryptoKey` handle in IndexedDB, and exports only the public JWK for registration. Pairing requires a valid private-key signature over the server challenge; desktop confirmation records name, scopes, Project IDs, and expiry before issuance.

Access tokens last five minutes and include validated `iss`, `aud`, `sub=deviceId`, `iat`, `nbf`, `exp`, `jti`, scopes, Project IDs, device version, and `cnf` key thumbprint. Refresh credentials last at most 30 days, are stored hashed on the server, rotate on every use, and revoke the family on reuse. On the PWA, `credential-vault.ts` binds the opaque refresh credential to the non-exportable private-key handle in origin-scoped IndexedDB, never exposes either through application state, service-worker cache, URL, log, export, or task content, and wipes both on logout/revocation. Reinstall or IndexedDB/key loss requires new desktop-confirmed pairing; copying only an access/refresh credential to another browser fails device proof and revokes or rejects the attempted family according to policy. Each request verifies expiry, audience, jti, Project scope, current device version/revocation, and a fresh device-key proof. Tests cover daemon restart, expiration boundaries, old-refresh replay, single-device revocation, logout wipe, reinstall/lost-key recovery, copied access or refresh credential on another key, wrong audience, and cross-Project use. Server signing material is referenced through the OS credential store; raw keys/tokens never enter SQLite, logs, exports, Prompt, or artifacts.

- [ ] **Step 2: Write RED command-envelope and remote-transport tests**

The strict envelope is `projectId, runId, stepRunId or gateId, expectedVersion, idempotencyKey, action, payload`, where action is exactly `approve_gate | reject_gate | supplement_input | pause_run | resume_run | terminate_run`. In one SQLite transaction the service verifies device scope/object relationships/current aggregate version and writes command receipt + Domain Event + any Outbox operation through `SqliteOperationJournal.commitCommand(...)`.

Assert: same key + same fingerprint returns the original receipt; same key + different action/object is rejected; stale version returns 409; double click, offline replay, revoked-token replay, cross-Project/Step replay, and duplicate approval advance the aggregate once. The PWA persists one stable key in IndexedDB until a terminal receipt and never creates a new key for transport retry.

Remote mode is disabled by default. Enabling it creates a separate HTTPS listener with TLS 1.3 configuration, an explicit Origin allowlist, CSP, connection/rate/payload limits, bearer-plus-device-proof auth, and no cookie fallback. Plain HTTP on any non-loopback address, bad Origin, missing proof, unauthenticated SSE, and unauthorized Project events are rejected.

Run: `npm test -- --run packages/device-gateway/src/device-security.test.ts apps/daemon/test/mobile-command-security.test.ts apps/web/src/mobile/credential-vault.test.ts; npx playwright test e2e/mobile-security.spec.ts --project=mobile`

Expected RED: restart loses the old in-memory challenge, perpetual tokens lack required claims, UI callbacks omit expectedVersion/idempotency, and plaintext remote access is rejected by the tests.

- [ ] **Step 3: Implement identity, rotation, authorization, and command delivery**

Add persistent `pairing_challenges`, `devices`, and `refresh_families` records to the migration. Implement challenge proof, desktop confirmation, short access issuance, rotating refresh with reuse detection, revocation/version checks, and device-bound request proof. Implement `device-key.ts` and `credential-vault.ts` with non-exportable private-key persistence, public-JWK export, protected refresh rotation, logout/revocation wipe, and explicit lost-key repair by re-pairing. Implement authenticated routes and command service; the React callbacks accept the complete envelope and use `command-outbox.ts`. The service worker bypasses API/SSE/auth traffic and never caches credentials or command bodies.

- [ ] **Step 4: Verify**

Run: `npm test -- --run packages/device-gateway/src/device-security.test.ts apps/daemon/test/mobile-command-security.test.ts apps/web/src/mobile/credential-vault.test.ts apps/web/src/pages/mobile-cockpit.test.tsx; npx playwright test e2e/mobile-security.spec.ts --project=mobile`

Expected GREEN: all named tests exit 0; every replay scenario returns the specified original receipt or rejection; the real test HTTPS listener is the only non-loopback listener.

```powershell
git add packages/storage/src/migrations/001-core.sql packages/device-gateway apps/daemon/src/auth apps/daemon/src/routes/devices.ts apps/daemon/src/routes/mobile-commands.ts apps/web/src/mobile apps/web/src/pages/mobile-cockpit.tsx e2e/mobile-security.spec.ts
git commit -m "移动：持久设备身份、轮换令牌与幂等控制命令"
```

**Completion evidence:** pairing/restart ledger, claim-validation matrix, refresh-family reuse result, revocation timing, command-receipt replay matrix, TLS listener report, and 390px mobile trace.

### Task 18: Make Archive-to-Knowledge a durable scoped projection

**Files:**
- Modify: `packages/storage/src/migrations/001-core.sql`
- Create: `packages/knowledge/src/archive-manifest.ts`
- Create: `packages/knowledge/src/archive-job.ts`
- Modify: `packages/knowledge/src/archive-writer.ts`
- Modify: `packages/knowledge/src/knowledge-catalog.ts`
- Create: `packages/knowledge/src/rebuild.ts`
- Modify: `packages/knowledge/src/resolver.ts`
- Test: `packages/knowledge/src/archive-job.fault.test.ts`
- Test: `packages/knowledge/src/knowledge-rebuild.test.ts`
- Test: `apps/daemon/test/archive-composition.test.ts`

- [ ] **Step 1: Write RED fault/provenance/scope tests**

When any Run becomes `succeeded | failed | canceled`, the same transaction writes its terminal Event and a persistent `archive_jobs` row. Inject crashes before manifest publication, after atomic manifest publication but before job receipt, and between archive receipt and Knowledge projection; reconstruct all services and assert exactly one immutable manifest and one Knowledge entry.

The versioned manifest must include Project, Repository, DeviceBinding, RequirementRevision IDs, Change/ChangeRevision, ExecutionPlan, Workflow/WorkflowRevision, root/parent/child Run and Task, every StepRun/Attempt, Agent profile and capability-probe digest, native-session reference hash, Workspace/Writer/Controller lease receipts and Git HEAD, Event Ledger position range, Artifact/Evidence content refs and hashes, actor/timestamps, outcome, schema version, and manifest hash. Tests reject a missing Project ID, missing Attempt/Evidence edge, tampered hash, cross-Project query, duplicate ingest, and unknown schema. Success, failure, and cancellation are all historical sources.

Run: `npm test -- --run packages/knowledge/src/archive-job.fault.test.ts packages/knowledge/src/knowledge-rebuild.test.ts apps/daemon/test/archive-composition.test.ts`

Expected RED: the old hand-wired call loses the job at each crash boundary, emits `scope: {}`, and lacks the required provenance.

- [ ] **Step 2: Implement persistent jobs and atomic manifests**

Add `archive_jobs` with stable job/operation ID, Project ID, Run ID, status, attempt count, lease, input fingerprint, receipt digest, and error. The terminal-Run unit of work schedules it. The worker writes content-addressed files to a same-volume temporary path, fsyncs, atomically renames, verifies the final digest, writes the durable receipt, then schedules idempotent Knowledge projection. Unknown/tampered state fails closed as `needs_attention`; existing matching digest is attached, never overwritten.

Knowledge scope requires `projectId`; no wildcard/empty scope is valid. Deduplicate by Project + manifest hash while retaining source identity. `rebuildKnowledge(projectId)` discards only rebuildable indexes for that Project and deterministically reprojects all verified Archives plus active authoritative Requirement revisions. Superseded/withdrawn material remains searchable but is excluded from default handoff resolution.

- [ ] **Step 3: Verify**

Run: `npm test -- --run packages/knowledge/src/archive-ingest.test.ts packages/knowledge/src/archive-job.fault.test.ts packages/knowledge/src/knowledge-rebuild.test.ts apps/daemon/test/archive-composition.test.ts`

Expected GREEN: all named tests exit 0; each crash resumes, cross-Project reads return zero rows, and rebuild before/after snapshots are byte-equivalent after stable ordering.

```powershell
git add packages/storage/src/migrations/001-core.sql packages/knowledge apps/daemon/test/archive-composition.test.ts
git commit -m "知识：持久归档任务与可重建项目级知识索引"
```

**Completion evidence:** three crash-point traces, complete manifest/schema validation, tamper failure, Project isolation query, and identical pre/post rebuild digests.

### Task 19: Compose the real application and define start:e2e

**Files:**
- Create: `apps/daemon/src/services/application-services.ts`
- Create: `apps/daemon/src/services/start-run.ts`
- Create: `apps/daemon/src/services/composition-root.ts`
- Modify: `apps/daemon/src/startup/startup-recovery-coordinator.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/src/main.ts`
- Modify: `apps/web/src/main.tsx`
- Create: `apps/web/src/pages/knowledge-page.tsx`
- Create: `apps/daemon/test/vertical-slice-composition.test.ts`
- Modify: `scripts/start-e2e.mjs`
- Modify: `package.json`
- Modify: `playwright.config.ts`
- Modify: `e2e/fixtures/fake-runtime-scenario.ts`

- [ ] **Step 1: Write the RED API-chain composition test**

Through an authenticated test client, create Project and immutable RequirementRevision, publish Change/Task DAG, issue StartRun, observe a first implementation return followed by failed verification, observe a second Attempt pass, finish the child and root Runs, drain Archive and Knowledge jobs, reconnect the durable event stream from a saved `events.position`, and query the scoped Knowledge entry. Kill/recreate the application after the external launch receipt and again between Archive and Knowledge; no duplicate session or manifest may appear.

The test must fail if StartRun bypasses FlowEngine, if a Task child loses the root frozen bindings, if Runtime/Verifier is dynamically attached to an unrelated Provider object, if events are not committed before SSE, or if any route uses a mock service that production does not wire.

Run: `npm test -- --run apps/daemon/test/vertical-slice-composition.test.ts`

Expected RED: named missing links identify ApplicationServices, StartRun, Flow->Runtime->Verifier, terminal->Archive, Archive->Knowledge, or EventLedger->SSE.

- [ ] **Step 2: Build the explicit composition root**

`composition-root.ts` constructs one SQLite unit of work, Event Ledger reader, Foundation OperationWorker, lease service, PolicyEngine, FlowEngine, RuntimeManager, CompletionVerifier, Archive worker, Knowledge projector, local/remote auth, and route services. Wiring is:

`authenticated HTTP or desktop IPC -> ApplicationServices -> Flow command -> Event + command receipt + Outbox transaction -> OperationWorker -> Runtime Provider/Connector -> side-effect receipt + Evidence -> CompletionVerifier -> Flow transition -> terminal archive job -> Knowledge projection`.

Committed `events.position` feeds the authorized SSE backlog/live tail. `StartRunService` invokes FlowEngine with the frozen Project/Requirement/Change/ExecutionPlan/Workflow/Policy bindings and creates Task/subflow children only through the aggregate rules. StartupRecoveryCoordinator finishes schema/WAL checks, replays/reconciles Outbox, validates active Attempt/lease/workspace/session state, resumes Archive/Knowledge jobs, verifies projections, and only then permits `listen`.

The web router exposes Project, Requirement, Change planner, Run/Attempt, Knowledge, and mobile pages. The deterministic fake implements the same injected runtime and verifier ports as production; it fails verification once and passes once without `Object.assign`.

- [ ] **Step 3: Define an authenticated start:e2e lifecycle**

Task 19 upgrades the runnable RED `scripts/start-e2e.mjs` scaffold created by 13A: it initializes the deterministic fake through constructor injection, starts daemon on a random port, keeps the test-only Web/readiness server on loopback `4173` behind the exclusive run lock, provisions a test-only device through the same pairing/device proof service, atomically replaces `.hunter-e2e/playwright-state.json` with the device-bound session state before readiness, waits for authenticated health/readiness, and cleans up owned processes/data on exit. The web client's authenticated bootstrap consumes the session/CSRF state loaded by Playwright; it may not fall back to an unauthenticated request. The launcher never adds a production route, disables auth/TLS, logs a credential, reuses developer data, or relies on a fixed daemon port.

Retain the root script `"start:e2e": "node scripts/start-e2e.mjs"` created by 13A and upgrade its behavior with the full composition. Playwright obtains base URLs and storage-state paths from the launcher's readiness file, not hardcoded origins. Production build tests assert that the E2E fixture module is absent from shipped bundles.

- [ ] **Step 4: Verify composition before browser acceptance**

Run: `npm test -- --run apps/daemon/test/vertical-slice-composition.test.ts; npm run start:e2e -- --verify; npx playwright test e2e/vertical-slice.spec.ts --project=chromium`

Expected GREEN: API chain and browser story exit 0; the fixture contains two Attempts, one native session per operation, a terminal root/child tree, a verified Archive manifest, Project-scoped Knowledge, and replayable authorized events after restart.

```powershell
git add apps/daemon/src/services apps/daemon/src/startup apps/daemon/src/app.ts apps/daemon/src/main.ts apps/web/src scripts/start-e2e.mjs package.json playwright.config.ts e2e/fixtures/fake-runtime-scenario.ts
git commit -m "集成：接通应用服务全链路与认证 E2E 启动器"
```

**Completion evidence:** composition graph, authenticated API transcript, two restart traces, `start:e2e --verify` readiness/cleanup report, browser trace, and proof that the production bundle excludes the fixture.

## Vertical-slice completion evidence

- One Project contains multiple Requirement entities and immutable approved revisions.
- One Change references one or more RequirementRevision IDs and owns a DAG of serial/parallel Tasks.
- The root Run owns Change delivery; Task executions are child Runs with stable parent/task references.
- Codex, CodeBuddy, Cursor, and Orca publish exact evidence-derived capability receipts. Codex/CodeBuddy may reach L2/L3 only when every required atom passes; Cursor remains L0/L1 until deeper evidence exists and always requires Hunter verification after a manual receipt.
- Every external boundary uses strict shared Zod decoders, branded IDs, canonical `realpath.native` scope checks, persisted DeviceBinding lookup, and opaque `workspaceRef` handling.
- Every side effect is traceable through Foundation Event + command receipt + Outbox + `side_effect_receipts`; crash-after-success with fresh process-local objects does not duplicate an external action.
- Parallel writers have independent worktrees and durable Workspace/Writer/Controller lease owner, generation, expiry, DeviceBinding, and Git HEAD evidence.
- A failed test or review creates a fresh implementation Attempt, preserves the old Attempt, and stops on all configured bounds.
- Run and Step pages display execution and verification separately, plus Session, Agent, artifacts, evidence, and waiting reason.
- Success, failure, and cancellation enqueue a durable Archive job. Its immutable manifest has complete provenance, hash, and Project scope; Knowledge ingestion survives both crash boundaries and rebuilds deterministically.
- Electron uses named schema-validated IPC, a random loopback daemon port, and a per-start pipe-delivered capability; no renderer-visible origin or credential exists.
- Explicit remote mode uses TLS and device-key proof. Persistent pairing, short access tokens, rotating refresh families, revocation/version checks, audience/jti/expiry and Project scopes survive restart.
- Mobile control uses the authenticated expectedVersion/idempotency envelope; duplicate/offline replay returns the original receipt, while stale and cross-object replay is rejected.
- The production composition root wires ApplicationServices, Flow, Runtime, Verifier, Storage, Archive, Knowledge, authorized Event-Ledger SSE, startup recovery, and authenticated `start:e2e`.
- Windows performs product packaging and optional real-provider checks; Ubuntu performs typecheck, unit, and browser E2E against the same contracts.

## Self-review checklist

- [ ] Every approved user story in `docs/08-user-stories-and-acceptance.md` maps to a Task above.
- [ ] `Requirement -> Change -> Task -> Workflow Step` terminology is used consistently.
- [ ] Parent/child WorkflowRuns use one aggregate type and never replace the owning Change or frozen revision set.
- [ ] All GUI status lights include text and keep execution separate from verification.
- [ ] Phase 0 provides evidence and transport selection only; no product UI, archive, knowledge, or Flow implementation is hidden in a spike.
- [ ] No command line contains a permission-bypass, blanket approval, or unsafe shell-composed argument.
- [ ] Every external payload is strict-schema decoded; only branded IDs and verified canonical paths enter Core, with server-side Project/DeviceBinding/path scope checks.
- [ ] Every external side effect consumes the Foundation Outbox with a stable operationId and durable receipt; indeterminate recovery never blindly redispatches.
- [ ] Workspace, Writer, and Controller leases include owner/generation/expiry/HEAD and use the Foundation lease service, never an adapter Map.
- [ ] Capability level equals the highest fully proven atom set; Codex/CodeBuddy have no literal L3 and CodeBuddy transport equals the selected Phase 0 receipt.
- [ ] Electron exposes only named IPC, uses a random loopback port/protected bootstrap pipe, validates Host/Origin, and exposes no token/origin/generic fetch to renderer.
- [ ] Remote access is disabled by default; enabled non-loopback traffic is TLS, device-bound, Origin/CSP/rate/size limited, and SSE is authenticated and Project-filtered.
- [ ] Pairing/device/refresh/revocation state survives restart; access/refresh expiry, jti, aud, device proof, rotation, Project scope, and copied-token rejection have tests.
- [ ] Mobile commands carry expectedVersion and idempotencyKey; double-click, offline replay, stale version, revoked device, and cross-Project/Step cases assert receipts.
- [ ] Archive/Knowledge use a durable job, complete versioned provenance, required Project scope, hash verification, idempotent retry, and byte-stable rebuild.
- [ ] A production composition test proves ApplicationServices and Flow->Runtime->Verifier->Storage->Archive->Knowledge/SSE wiring before Playwright; `start:e2e` is defined and authenticated.
- [ ] Every code-changing step includes concrete code, every verification step names a command and expected result, and every task ends in a focused Chinese commit.
