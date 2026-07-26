import { z } from "zod";

import {
  DeviceBindingIdSchema,
  DeviceIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
} from "./ids.js";
import type { DeviceBindingId, DeviceId, ProjectId, RepositoryId } from "./ids.js";
import { assertUnique, compareCanonicalText, deepFreeze } from "./immutable.js";

const MAX_PROJECT_REPOSITORIES = 50;

export interface RepositoryBinding {
  readonly repositoryId: RepositoryId;
  readonly role: "primary" | "secondary";
}

export interface DeviceBinding {
  readonly deviceBindingId: DeviceBindingId;
  readonly deviceId: DeviceId;
  readonly repositoryId: RepositoryId;
  readonly localPath: string;
  readonly availability: "available" | "unavailable" | "unknown";
  readonly lastVerifiedAt?: string | undefined;
}

export interface Project {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly repositoryBindings: readonly RepositoryBinding[];
  readonly deviceBindings: readonly DeviceBinding[];
}

export const RepositoryBindingSchema = z
  .object({
    repositoryId: RepositoryIdSchema,
    role: z.enum(["primary", "secondary"]),
  })
  .strict();

export const DeviceBindingSchema = z
  .object({
    deviceBindingId: DeviceBindingIdSchema,
    deviceId: DeviceIdSchema,
    repositoryId: RepositoryIdSchema,
    localPath: z.string().min(1),
    availability: z.enum(["available", "unavailable", "unknown"]),
    lastVerifiedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const ProjectSchema = z
  .object({
    projectId: ProjectIdSchema,
    name: z.string().trim().min(1),
    repositoryBindings: z
      .array(RepositoryBindingSchema)
      .min(1)
      .max(MAX_PROJECT_REPOSITORIES),
    deviceBindings: z.array(DeviceBindingSchema).min(1),
  })
  .strict();

const AppendRepositoryBindingInputSchema = z
  .object({
    repositoryBinding: RepositoryBindingSchema,
    deviceBinding: DeviceBindingSchema,
  })
  .strict();

export function createProject(input: unknown): Readonly<Project> {
  const parsed = ProjectSchema.parse(input);
  const repositoryIds = parsed.repositoryBindings.map(({ repositoryId }) => repositoryId);
  assertUnique(repositoryIds, "repository_binding");
  assertUnique(parsed.deviceBindings.map(({ deviceBindingId }) => deviceBindingId), "device_binding");

  if (parsed.repositoryBindings.filter(({ role }) => role === "primary").length !== 1) {
    throw new Error("PROJECT_REQUIRES_EXACTLY_ONE_PRIMARY_REPOSITORY");
  }
  const boundRepositories = new Set(repositoryIds);
  if (parsed.deviceBindings.some(({ repositoryId }) => !boundRepositories.has(repositoryId))) {
    throw new Error("DEVICE_BINDING_REPOSITORY_NOT_BOUND");
  }

  return deepFreeze({
    ...parsed,
    repositoryBindings: [...parsed.repositoryBindings].sort((left, right) => {
      if (left.role !== right.role) return left.role === "primary" ? -1 : 1;
      return compareCanonicalText(left.repositoryId, right.repositoryId);
    }),
    deviceBindings: [...parsed.deviceBindings].sort((left, right) =>
      compareCanonicalText(left.deviceBindingId, right.deviceBindingId),
    ),
  });
}

export function appendRepositoryBinding(
  projectInput: unknown,
  input: unknown,
): Readonly<Project> {
  const project = ProjectSchema.parse(projectInput);
  const parsed = AppendRepositoryBindingInputSchema.parse(input);
  if (project.repositoryBindings.length >= MAX_PROJECT_REPOSITORIES) {
    throw new Error("PROJECT_REPOSITORY_BINDING_LIMIT");
  }
  if (parsed.repositoryBinding.role !== "secondary") {
    throw new Error("APPENDED_REPOSITORY_MUST_BE_SECONDARY");
  }
  if (
    parsed.deviceBinding.repositoryId
    !== parsed.repositoryBinding.repositoryId
  ) {
    throw new Error("APPENDED_DEVICE_BINDING_REPOSITORY_MISMATCH");
  }
  return createProject({
    ...project,
    repositoryBindings: [
      ...project.repositoryBindings,
      parsed.repositoryBinding,
    ],
    deviceBindings: [...project.deviceBindings, parsed.deviceBinding],
  });
}
