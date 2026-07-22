import type { RouteOutcome, WorkflowRevision } from "@hunter/domain";

export function selectRoute(
  workflow: WorkflowRevision,
  stepId: string,
  outcome: RouteOutcome,
  facts: Readonly<Record<string, string | number | boolean>>,
) {
  const candidates = workflow.routes.filter(
    (route) => route.fromStepId === stepId && route.outcome === outcome,
  );
  const conditioned = candidates
    .filter((route) => route.condition !== undefined)
    .filter((route) => route.condition?.kind === "equals" && facts[route.condition.fact] === route.condition.value)
    .sort((left, right) => right.priority - left.priority);
  const route = conditioned[0] ?? candidates.find(({ condition }) => condition === undefined) ?? null;
  if (route === null) return null;
  return {
    route,
    loop: workflow.loops.find(({ routeId }) => routeId === route.routeId) ?? null,
  };
}
