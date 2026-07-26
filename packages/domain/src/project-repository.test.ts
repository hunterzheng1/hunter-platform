import { describe, expect, it } from "vitest";

import {
  DeviceBindingIdSchema,
  DeviceIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
} from "./ids.js";
import { createProject } from "./project.js";

const ids = {
  project: ProjectIdSchema.parse("prj_repositoryappend"),
  primary: RepositoryIdSchema.parse("rep_repositoryprimary"),
  secondary: RepositoryIdSchema.parse("rep_repositorysecondary"),
  device: DeviceIdSchema.parse("dvc_repositorydevice"),
  primaryBinding: DeviceBindingIdSchema.parse("dev_repositoryprimary"),
  secondaryBinding: DeviceBindingIdSchema.parse("dev_repositorysecondary"),
};

function project() {
  return createProject({
    projectId: ids.project,
    name: "Repository append",
    repositoryBindings: [
      { repositoryId: ids.primary, role: "primary" },
    ],
    deviceBindings: [
      {
        deviceBindingId: ids.primaryBinding,
        deviceId: ids.device,
        repositoryId: ids.primary,
        localPath: "C:\\fixtures\\primary",
        availability: "available",
      },
    ],
  });
}

describe("Project repository evolution", () => {
  it("immutably appends one secondary repository with its device-local path", async () => {
    const domain = await import("./index.js") as Record<string, unknown>;
    expect(domain.appendRepositoryBinding).toEqual(expect.any(Function));
    const appendRepositoryBinding = domain.appendRepositoryBinding as (
      current: ReturnType<typeof project>,
      input: unknown,
    ) => ReturnType<typeof project>;
    const original = project();

    const next = appendRepositoryBinding(original, {
      repositoryBinding: {
        repositoryId: ids.secondary,
        role: "secondary",
      },
      deviceBinding: {
        deviceBindingId: ids.secondaryBinding,
        deviceId: ids.device,
        repositoryId: ids.secondary,
        localPath: "C:\\fixtures\\secondary",
        availability: "unknown",
      },
    });

    expect(next).not.toBe(original);
    expect(original.repositoryBindings).toHaveLength(1);
    expect(next.repositoryBindings).toEqual([
      { repositoryId: ids.primary, role: "primary" },
      { repositoryId: ids.secondary, role: "secondary" },
    ]);
    expect(next.deviceBindings.map(({ repositoryId }) => repositoryId))
      .toEqual([ids.primary, ids.secondary]);
    expect(Object.isFrozen(next)).toBe(true);
  });

  it("rejects duplicate, primary, and cross-repository append attempts", async () => {
    const domain = await import("./index.js") as Record<string, unknown>;
    expect(domain.appendRepositoryBinding).toEqual(expect.any(Function));
    const appendRepositoryBinding = domain.appendRepositoryBinding as (
      current: ReturnType<typeof project>,
      input: unknown,
    ) => ReturnType<typeof project>;
    const secondary = {
      repositoryBinding: {
        repositoryId: ids.secondary,
        role: "secondary",
      },
      deviceBinding: {
        deviceBindingId: ids.secondaryBinding,
        deviceId: ids.device,
        repositoryId: ids.secondary,
        localPath: "C:\\fixtures\\secondary",
        availability: "unknown",
      },
    };

    expect(() =>
      appendRepositoryBinding(
        appendRepositoryBinding(project(), secondary),
        secondary,
      ),
    ).toThrowError("DUPLICATE_REPOSITORY_BINDING");
    expect(() =>
      appendRepositoryBinding(project(), {
        ...secondary,
        repositoryBinding: {
          repositoryId: ids.secondary,
          role: "primary",
        },
      }),
    ).toThrowError("APPENDED_REPOSITORY_MUST_BE_SECONDARY");
    expect(() =>
      appendRepositoryBinding(project(), {
        ...secondary,
        deviceBinding: {
          ...secondary.deviceBinding,
          repositoryId: ids.primary,
        },
      }),
    ).toThrowError("APPENDED_DEVICE_BINDING_REPOSITORY_MISMATCH");
  });

  it("rejects an append before the public fifty-Repository limit is exceeded", async () => {
    const domain = await import("./index.js") as Record<string, unknown>;
    const appendRepositoryBinding = domain.appendRepositoryBinding as (
      current: ReturnType<typeof project>,
      input: unknown,
    ) => ReturnType<typeof project>;
    const repositoryBindings = Array.from({ length: 50 }, (_, index) => ({
      repositoryId: RepositoryIdSchema.parse(
        `rep_repositorylimit${index.toString().padStart(2, "0")}`,
      ),
      role: index === 0 ? "primary" as const : "secondary" as const,
    }));
    const atLimit = createProject({
      projectId: ProjectIdSchema.parse("prj_repositorylimit"),
      name: "Repository limit",
      repositoryBindings,
      deviceBindings: repositoryBindings.map(
        ({ repositoryId }, index) => ({
          deviceBindingId: DeviceBindingIdSchema.parse(
            `dev_repositorylimit${index.toString().padStart(2, "0")}`,
          ),
          deviceId: ids.device,
          repositoryId,
          localPath: `C:\\fixtures\\limit-${index}`,
          availability: "unknown",
        }),
      ),
    });

    expect(() =>
      appendRepositoryBinding(atLimit, {
        repositoryBinding: {
          repositoryId: "rep_repositorylimit50",
          role: "secondary",
        },
        deviceBinding: {
          deviceBindingId: "dev_repositorylimit50",
          deviceId: ids.device,
          repositoryId: "rep_repositorylimit50",
          localPath: "C:\\fixtures\\limit-50",
          availability: "unknown",
        },
      }),
    ).toThrowError("PROJECT_REPOSITORY_BINDING_LIMIT");
  });
});
