import type {
  CreateProjectHttpResponse,
  ProjectDetailHttpResponse,
  RequirementRevisionHttpResponse,
} from "@hunter/api-contracts";
import {
  ExecutionPlanIdSchema,
  ProjectIdSchema,
  RequirementIdSchema,
  RequirementRevisionIdSchema,
} from "@hunter/domain";
import { vi } from "vitest";

import { LocalAuthenticator } from "../../src/auth/local-authenticator.js";
import { buildApp } from "../../src/app.js";
import type { ProjectRoutesServices } from "../../src/routes/projects.js";
import type { RequirementRoutesServices } from "../../src/routes/requirements.js";
import type { RunRoutesServices } from "../../src/routes/runs.js";

const host = "hunter-test.localhost";
const origin = "app://hunter";
const csrf = "task2-csrf-proof";

export const projectA = ProjectIdSchema.parse("prj_task2000001");
export const projectB = ProjectIdSchema.parse("prj_task2000002");
const requirementId = RequirementIdSchema.parse("req_task2000001");
const revisionId = RequirementRevisionIdSchema.parse("rrv_task2000001");

type TestServices = ProjectRoutesServices & RunRoutesServices & {
  readonly requirements: RequirementRoutesServices;
};

type TestServiceOverrides = Partial<ProjectRoutesServices & RunRoutesServices> & {
  readonly requirements?: Readonly<Partial<RequirementRoutesServices>>;
};

export function buildTestApp(overrides: Readonly<TestServiceOverrides> = {}) {
  const authenticator = new LocalAuthenticator("task2-install-secret-tests");
  const credential = authenticator.issueSession({
    principalId: "desktop-owner",
    authorizedProjectIds: [projectA],
    expiresAt: new Date(Date.now() + 60_000),
    csrf,
  });
  const { requirements: requirementOverrides, ...rootOverrides } = overrides;
  const services: TestServices = {
    listProjects: vi.fn(async () => []),
    createProject: vi.fn(async (): Promise<CreateProjectHttpResponse> => ({
      projectId: projectB,
      name: "Hunter",
      authorization: "host_session_reissue_required",
    })),
    getProject: vi.fn(async (): Promise<ProjectDetailHttpResponse | null> => null),
    requirements: {
      createRequirement: vi.fn(async (): Promise<RequirementRevisionHttpResponse> => ({
        projectId: projectA,
        requirementId,
        revisionId,
        aggregateVersion: 0,
        title: "Default",
        body: "Default body",
        acceptanceCriteria: ["Default criterion"],
        constraints: [],
        status: "draft",
      })),
      getRequirementRevision: vi.fn(() => null),
      approveRequirement: vi.fn(async (): Promise<RequirementRevisionHttpResponse> => ({
        projectId: projectA,
        requirementId,
        revisionId,
        aggregateVersion: 1,
        title: "Default",
        body: "Default body",
        acceptanceCriteria: ["Default criterion"],
        constraints: [],
        status: "approved",
        approvedAt: "2026-07-23T01:00:00.000Z",
      })),
      ...requirementOverrides,
    },
    projectForExecutionPlan: vi.fn(() => ({
      projectId: projectA,
      executionPlanId: ExecutionPlanIdSchema.parse("epl_task2000001"),
    })),
    startRun: vi.fn(async () => ({ runId: "run_task2000001" })),
    ...rootOverrides,
  };
  const app = buildApp({
    authenticator,
    allowedHosts: [host],
    allowedOrigins: [origin],
    services,
  });
  const headers = {
    host,
    origin,
    authorization: `Bearer ${credential}`,
    "x-csrf-token": csrf,
    "content-type": "application/json",
  };
  return { app, headers, services };
}
