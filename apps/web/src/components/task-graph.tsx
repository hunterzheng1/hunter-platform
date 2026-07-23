import type { TaskDefinitionHttp } from "@hunter/api-contracts";

export function TaskGraph({ tasks }: { readonly tasks: readonly TaskDefinitionHttp[] }) {
  const titles = new Map(tasks.map((task) => [task.taskId, task.title]));
  return (
    <ol className="task-graph" aria-label="任务依赖图">
      {tasks.map((task) => (
        <li className="task-node" key={task.taskId}>
          <div>
            <strong>{task.title}</strong>
            <span className={`status ${task.access === "write" ? "status-review" : "status-approved"}`}>
              {task.access === "write" ? "写入" : "只读"}
            </span>
          </div>
          <p>{task.objective}</p>
          <p className="dependency-label">
            {task.dependsOn.length === 0
              ? "可并行（无依赖）"
              : `依赖：${task.dependsOn.map((dependency) => titles.get(dependency) ?? dependency).join("、")}`}
          </p>
        </li>
      ))}
    </ol>
  );
}
