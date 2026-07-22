import { canonicalSha256, deepFreeze, type WorkflowStep } from "@hunter/domain";

export interface StoredPolicy {
  readonly policyVersion: number;
  readonly deniedPermissions: readonly string[];
}

export type PolicyDecision = Readonly<{
  decision: "allow" | "deny" | "require_approval";
  reason: string;
  snapshotHash: string;
  policyVersion: number;
  executor: WorkflowStep["executor"];
  agentProfileSelector: WorkflowStep["agentProfileSelector"];
  requiredCapabilities: WorkflowStep["requiredCapabilities"];
  permissionPolicy: WorkflowStep["permissionPolicy"];
  retryPolicy: WorkflowStep["retryPolicy"];
  timeoutPolicy: WorkflowStep["timeoutPolicy"];
  workspacePolicy: WorkflowStep["workspacePolicy"];
  budgetCost: WorkflowStep["budgetCost"];
}>;

export function deriveStepPolicy(
  step: Readonly<WorkflowStep>,
  policy: StoredPolicy,
  callerAuthority: Readonly<Record<string, unknown>> = {},
): PolicyDecision {
  if (Object.keys(callerAuthority).length > 0) throw new Error("CALLER_AUTHORITY_OVERRIDE");
  const denied = step.permissionPolicy.permissions.some((permission) =>
    policy.deniedPermissions.includes(permission),
  );
  const decision = denied
    ? "deny"
    : step.permissionPolicy.decision === "require_approval"
      ? "require_approval"
      : step.permissionPolicy.decision;
  const authoritative = {
    executor: step.executor,
    agentProfileSelector: step.agentProfileSelector,
    requiredCapabilities: step.requiredCapabilities,
    permissionPolicy: step.permissionPolicy,
    retryPolicy: step.retryPolicy,
    timeoutPolicy: step.timeoutPolicy,
    workspacePolicy: step.workspacePolicy,
    budgetCost: step.budgetCost,
  };
  return deepFreeze({
    decision,
    reason: denied ? "permission_denied_by_policy" : "frozen_step_policy",
    snapshotHash: canonicalSha256({ policy, authoritative }),
    policyVersion: policy.policyVersion,
    ...authoritative,
  });
}
