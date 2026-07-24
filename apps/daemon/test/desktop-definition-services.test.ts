import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  CreateProjectHttpRequestSchema,
  CreateRequirementHttpRequestSchema,
  PublishChangeHttpRequestSchema,
} from "@hunter/api-contracts";
import { describe, expect, it } from "vitest";

import { createApplicationComposition } from "../src/services/composition-root.js";
import { createDesktopDefinitionServices } from "../src/services/desktop-definition-services.js";

describe("desktop definition services", () => {
  it("persists the provider-neutral Project, Requirement, and Change chain", () => {
    const dataDirectory = mkdtempSync(
      join(tmpdir(), "hunter-desktop-definitions-"),
    );
    const database = new DatabaseSync(":memory:");
    try {
      const composition = createApplicationComposition({
        database,
        externalHandler: {
          execute: async () => {
            throw new Error("PRODUCTION_RUNTIME_NOT_CONFIGURED");
          },
        },
        verifier: {
          verify: async () => {
            throw new Error("PRODUCTION_VERIFIER_NOT_CONFIGURED");
          },
        },
        installSecret: "desktop-definition-test-secret",
        allowedHosts: ["hunter-test.localhost"],
        allowedOrigins: ["app://hunter"],
        contentDirectory: dataDirectory,
        now: () => new Date("2026-07-24T03:00:00.000Z"),
      });
      const definitions = createDesktopDefinitionServices({
        database,
        services: composition.services,
        dataDirectory,
        now: () => new Date("2026-07-24T03:00:00.000Z"),
      });
      const actor = {
        actorId: "desktop",
        correlationId: "desktop-definitions",
      };
      const projectCommand = CreateProjectHttpRequestSchema.parse({
        projectId: "prj_desktopdefs1",
        name: "Desktop definitions",
        expectedVersion: 0,
        idempotencyKey: "desktop-project-create-1",
      });

      const created = definitions.createProject(projectCommand, actor);
      expect(
        definitions.createProject(projectCommand, actor),
      ).toEqual(created);
      expect(definitions.listProjectIds()).toEqual([
        projectCommand.projectId,
      ]);
      const project = definitions.getProject(projectCommand.projectId);
      if (project?.planningDefaults === undefined) {
        throw new Error("PLANNING_DEFAULTS_MISSING");
      }

      const draft = definitions.requirements.createRequirement(
        projectCommand.projectId,
        CreateRequirementHttpRequestSchema.parse({
          requirementId: "req_desktopdefs1",
          revisionId: "rrv_desktopdefs1",
          title: "Persist definitions",
          body: "Keep the product chain in Hunter-owned storage.",
          acceptanceCriteria: ["Restart returns the approved revision"],
          constraints: ["Provider-neutral"],
          expectedVersion: 0,
          idempotencyKey: "desktop-requirement-create-1",
        }),
        actor,
      );
      expect(draft.aggregateVersion).toBe(1);
      const approved = definitions.requirements.approveRequirement(
        projectCommand.projectId,
        draft.revisionId,
        {
          expectedVersion: draft.aggregateVersion,
          idempotencyKey: "desktop-requirement-approve-1",
        },
        actor,
      );
      expect(approved).toMatchObject({
        status: "approved",
        aggregateVersion: 2,
      });

      const publishCommand = PublishChangeHttpRequestSchema.parse({
        changeId: "chg_desktopdefs1",
        changeRevisionId: "crv_desktopdefs1",
        executionPlanId: "epl_desktopdefs1",
        title: "Ship desktop composition",
        goal: "Wire the desktop product chain.",
        nonGoals: ["Select a production Provider"],
        requirementRevisionIds: [approved.revisionId],
        repositoryIds: project.planningDefaults.repositoryIds,
        acceptanceCriteria: ["Published plan is persisted"],
        constraints: ["Runtime remains fail-closed"],
        risks: ["Provider unavailable"],
        dependsOnChangeRevisionIds: [],
        tasks: [{
          taskId: "tsk_desktopdefs1",
          title: "Compose",
          objective: "Compose the Hunter-owned application services.",
          acceptanceCriteria: ["Contract suite passes"],
          repositoryIds: project.planningDefaults.repositoryIds,
          moduleScopes: ["apps"],
          dependsOn: [],
          readSet: ["apps"],
          writeSet: ["apps"],
          access: "write",
          workflowRevisionId:
            project.planningDefaults.workflowRevisionId,
          defaultAgentProfileId:
            project.planningDefaults.defaultAgentProfileId,
          sessionPolicy: project.planningDefaults.sessionPolicy,
          workspacePolicy: project.planningDefaults.workspacePolicy,
        }],
        expectedVersion: 0,
        idempotencyKey: "desktop-change-publish-1",
      });
      expect(definitions.changes.publishChange(
        projectCommand.projectId,
        publishCommand,
        actor,
      )).toMatchObject({
        projectId: projectCommand.projectId,
        status: "published",
      });

      const reconstructed = createDesktopDefinitionServices({
        database,
        services: composition.services,
        dataDirectory,
        now: () => new Date("2026-07-24T04:00:00.000Z"),
      }).getProject(projectCommand.projectId);
      expect(reconstructed?.requirements).toEqual([approved]);
    } finally {
      database.close();
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });
});
