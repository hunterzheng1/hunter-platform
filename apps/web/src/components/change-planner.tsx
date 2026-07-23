import {
  TaskDefinitionHttpSchema,
  type ChangePlanningDefaultsHttp,
  type PublishChangeHttpRequest,
  type PublishChangeHttpResponse,
} from "@hunter/api-contracts";
import {
  ChangeIdSchema,
  ChangeRevisionIdSchema,
  ExecutionPlanIdSchema,
  TaskIdSchema,
  type RequirementRevisionId,
} from "@hunter/domain/ids";
import { useState } from "react";

import { TaskGraph } from "./task-graph.js";

export type ChangePlanDraft = Omit<PublishChangeHttpRequest, "expectedVersion" | "idempotencyKey">;

type TemplateTaskRole = "api" | "ui" | "integration";

export interface ChangePlannerIdFactory {
  changeId(): string;
  changeRevisionId(): string;
  executionPlanId(): string;
  taskId(role: TemplateTaskRole): string;
}

const defaultIdFactory: ChangePlannerIdFactory = {
  changeId: () => `chg_${crypto.randomUUID()}`,
  changeRevisionId: () => `crv_${crypto.randomUUID()}`,
  executionPlanId: () => `epl_${crypto.randomUUID()}`,
  taskId: () => `tsk_${crypto.randomUUID()}`,
};

function createParallelPlan(
  requirementRevisionIds: readonly RequirementRevisionId[],
  defaults: ChangePlanningDefaultsHttp,
  ids: ChangePlannerIdFactory,
): ChangePlanDraft {
  const apiTaskId = TaskIdSchema.parse(ids.taskId("api"));
  const uiTaskId = TaskIdSchema.parse(ids.taskId("ui"));
  const integrationTaskId = TaskIdSchema.parse(ids.taskId("integration"));
  const common = {
    acceptanceCriteria: ["任务验收标准与变更目标一致"],
    repositoryIds: defaults.repositoryIds,
    workflowRevisionId: defaults.workflowRevisionId,
    defaultAgentProfileId: defaults.defaultAgentProfileId,
    sessionPolicy: defaults.sessionPolicy,
    workspacePolicy: defaults.workspacePolicy,
    access: "write" as const,
  };
  const tasks = [
    TaskDefinitionHttpSchema.parse({
      ...common,
      taskId: apiTaskId,
      title: "控制 API",
      objective: "实现并验证控制面接口",
      moduleScopes: ["control-api"],
      dependsOn: [],
      readSet: ["control-contract"],
      writeSet: ["control-api"],
    }),
    TaskDefinitionHttpSchema.parse({
      ...common,
      taskId: uiTaskId,
      title: "客户端界面",
      objective: "实现并验证可访问客户端界面",
      moduleScopes: ["client-interface"],
      dependsOn: [],
      readSet: ["client-contract"],
      writeSet: ["client-interface"],
    }),
    TaskDefinitionHttpSchema.parse({
      ...common,
      taskId: integrationTaskId,
      title: "端到端集成",
      objective: "集成并验证两个并行交付结果",
      moduleScopes: ["delivery-integration"],
      dependsOn: [apiTaskId, uiTaskId],
      readSet: ["control-api", "client-interface"],
      writeSet: ["delivery-integration"],
    }),
  ];
  if (new Set(tasks.map(({ taskId }) => taskId)).size !== tasks.length) {
    throw new Error("DUPLICATE_TASK_ID");
  }
  return {
    changeId: ChangeIdSchema.parse(ids.changeId()),
    changeRevisionId: ChangeRevisionIdSchema.parse(ids.changeRevisionId()),
    executionPlanId: ExecutionPlanIdSchema.parse(ids.executionPlanId()),
    title: "并行交付",
    goal: "并行完成控制接口与客户端界面，并在依赖二者的任务中完成集成",
    nonGoals: ["不连接或推定任何真实 Runtime Provider"],
    requirementRevisionIds: [...requirementRevisionIds],
    repositoryIds: [...defaults.repositoryIds],
    acceptanceCriteria: ["控制接口、客户端界面与集成验证全部通过"],
    constraints: ["保持运行时与 Agent provider-neutral"],
    risks: ["并行写入结果可能在集成时发生冲突"],
    dependsOnChangeRevisionIds: [],
    tasks,
  };
}

export function ChangePlanner({
  requirementRevisionIds,
  planningDefaults,
  onPublish,
  idFactory = defaultIdFactory,
}: {
  readonly requirementRevisionIds: readonly RequirementRevisionId[];
  readonly planningDefaults: ChangePlanningDefaultsHttp;
  readonly onPublish: (input: ChangePlanDraft) => Promise<PublishChangeHttpResponse>;
  readonly idFactory?: ChangePlannerIdFactory;
}) {
  const [draft, setDraft] = useState<ChangePlanDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [published, setPublished] = useState<PublishChangeHttpResponse>();

  const chooseTemplate = () => {
    setError(undefined);
    setPublished(undefined);
    try {
      setDraft(createParallelPlan(requirementRevisionIds, planningDefaults, idFactory));
    } catch {
      setDraft(undefined);
      setError("无法生成合法任务标识，请重试");
    }
  };
  const publish = async () => {
    if (draft === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setPublished(await onPublish(draft));
    } catch {
      setError("执行计划尚未确认，请重试；重试会复用同一组标识");
    } finally {
      setBusy(false);
    }
  };

  if (requirementRevisionIds.length === 0) {
    return <div className="empty-state"><strong>暂无可规划的已批准需求</strong><p>先批准至少一个需求版本，再创建 Change。</p></div>;
  }
  return (
    <section className="panel planner-panel" aria-labelledby="change-planner-title" aria-busy={busy}>
      <div className="section-heading">
        <div><p className="eyebrow">Change</p><h2 id="change-planner-title">执行规划</h2></div>
        <span className="count-label">{requirementRevisionIds.length} 个已批准版本</span>
      </div>
      <p className="field-help">规划仅引用领域 ID；本地路径、终端与 Provider 私有字段不会进入请求。</p>
      <button className="button button-quiet" type="button" disabled={busy} onClick={chooseTemplate}>使用并行交付模板</button>
      {draft === undefined ? <div className="empty-state compact-empty"><strong>尚未选择任务模板</strong><p>选择模板后可检查并行与依赖关系。</p></div> : <TaskGraph tasks={draft.tasks} />}
      {error === undefined ? null : <p role="alert" className="message error-message">{error}</p>}
      {published === undefined ? null : <p role="status" className="message notice-message">执行计划已发布：{published.executionPlanId}</p>}
      <button className="button button-primary" type="button" disabled={draft === undefined || busy} onClick={() => void publish()}>
        {busy ? "正在确认…" : "确认执行计划"}
      </button>
    </section>
  );
}
