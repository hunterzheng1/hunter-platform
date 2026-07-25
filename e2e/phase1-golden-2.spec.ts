import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  TaskIdSchema,
  createExecutionPlan,
  type TaskId,
} from "@hunter/domain";
import { deriveTaskFanOut } from "@hunter/flow-engine";
import { expect, test } from "@playwright/test";

const executeFile = promisify(execFile);
const ids = {
  writerA: TaskIdSchema.parse("tsk_golden2writera"),
  writerB: TaskIdSchema.parse("tsk_golden2writerb"),
  join: TaskIdSchema.parse("tsk_golden2join"),
  integration: TaskIdSchema.parse("tsk_golden2integration"),
};

function plan() {
  const writeTask = (
    taskId: TaskId,
    dependsOn: readonly TaskId[] = [],
  ) => ({
    taskId,
    title: taskId,
    objective: "execute",
    acceptanceCriteria: ["verified"],
    repositoryIds: ["rep_golden2repo"],
    moduleScopes: ["fixture"],
    dependsOn,
    readSet: ["fixture"],
    writeSet: ["fixture"],
    access: "write" as const,
    workflowRevisionId: "wfr_golden2workflow",
    defaultAgentProfileId: "apr_golden2agent",
    sessionPolicy: "new" as const,
    workspacePolicy: {
      mode: "write" as const,
      isolation: "worktree" as const,
      reuse: false,
    },
  });
  const integrationTask = {
    ...writeTask(ids.integration, [ids.join]),
    writeSet: [],
    access: "read" as const,
    workspacePolicy: {
      mode: "read" as const,
      isolation: "shared_snapshot" as const,
      reuse: true,
    },
  };
  return createExecutionPlan({
    executionPlanId: "epl_golden2plan",
    projectId: "prj_golden2project",
    changeRevisionId: "crv_golden2change",
    requirementRevisionIds: ["rrv_golden2requirement"],
    tasks: [
      integrationTask,
      writeTask(ids.join, [ids.writerA, ids.writerB]),
      writeTask(ids.writerB),
      writeTask(ids.writerA),
    ],
    publishedAt: "2026-07-25T00:00:00.000Z",
  });
}

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function git(
  cwd: string,
  args: readonly string[],
): Promise<GitResult> {
  try {
    const result = await executeFile("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && typeof error.code === "number"
      && "stdout" in error
      && "stderr" in error
      && typeof error.stdout === "string"
      && typeof error.stderr === "string"
    ) {
      return {
        code: error.code,
        stdout: error.stdout,
        stderr: error.stderr,
      };
    }
    throw error;
  }
}

async function mustGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) throw new Error("GOLDEN2_GIT_COMMAND_FAILED");
  return result.stdout.trim();
}

interface GitFixture {
  readonly root: string;
  readonly repository: string;
  readonly writerA: string;
  readonly writerB: string;
}

async function createGitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "hunter-phase1-golden2-"));
  const repository = join(root, "repository");
  const writerA = join(root, "writer-a");
  const writerB = join(root, "writer-b");
  await mustGit(root, ["init", "--initial-branch=main", repository]);
  await mustGit(repository, ["config", "user.name", "Hunter Test"]);
  await mustGit(repository, [
    "config",
    "user.email",
    "hunter-test@invalid.example",
  ]);
  await mustGit(repository, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repository, "shared.txt"), "base\n", "utf8");
  await mustGit(repository, ["add", "--", "shared.txt"]);
  await mustGit(repository, ["commit", "-m", "fixture: base"]);
  await mustGit(repository, [
    "worktree",
    "add",
    "-b",
    "writer-a",
    writerA,
    "main",
  ]);
  await mustGit(repository, [
    "worktree",
    "add",
    "-b",
    "writer-b",
    writerB,
    "main",
  ]);
  return { root, repository, writerA, writerB };
}

async function disposeGitFixture(fixture: GitFixture): Promise<void> {
  const resolvedRoot = resolve(fixture.root);
  if (
    dirname(resolvedRoot) !== resolve(tmpdir())
    || !resolvedRoot.startsWith(
      join(resolve(tmpdir()), "hunter-phase1-golden2-"),
    )
  ) {
    throw new Error("GOLDEN2_FIXTURE_NOT_OWNED");
  }
  await rm(resolvedRoot, { recursive: true, force: true });
}

async function commitFile(
  worktree: string,
  filename: string,
  content: string,
): Promise<void> {
  await writeFile(join(worktree, filename), content, "utf8");
  await mustGit(worktree, ["add", "--", filename]);
  await mustGit(worktree, ["commit", "-m", `fixture: ${filename}`]);
}

async function canonicalExistingPath(path: string): Promise<string> {
  const physicalPath = await realpath(path);
  return process.platform === "win32"
    ? physicalPath.toLowerCase()
    : physicalPath;
}

async function expectIsolatedWorktrees(fixture: GitFixture): Promise<void> {
  const roots = await Promise.all(
    [fixture.repository, fixture.writerA, fixture.writerB].map((path) =>
      mustGit(path, ["rev-parse", "--show-toplevel"]),
    ),
  );
  expect(new Set(await Promise.all(roots.map(canonicalExistingPath)))).toEqual(
    new Set(
      await Promise.all(
        [fixture.repository, fixture.writerA, fixture.writerB].map(
          canonicalExistingPath,
        ),
      ),
    ),
  );
  const worktreeList = await mustGit(fixture.repository, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  expect(
    worktreeList
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice("worktree ".length))),
  ).toHaveLength(3);
}

test("Golden-2 preserves isolated writers and blocks integration after an explicit merge conflict", async () => {
  const fixture = await createGitFixture();
  try {
    await expectIsolatedWorktrees(fixture);
    expect(deriveTaskFanOut(plan(), [])).toEqual([
      ids.writerA,
      ids.writerB,
    ]);

    await commitFile(fixture.writerA, "shared.txt", "writer-a\n");
    await commitFile(fixture.writerB, "shared.txt", "writer-b\n");
    const completedWriters = [
      { taskId: ids.writerA, status: "succeeded" as const },
      { taskId: ids.writerB, status: "succeeded" as const },
    ];
    expect(deriveTaskFanOut(plan(), completedWriters)).toEqual([ids.join]);

    await mustGit(fixture.repository, [
      "merge",
      "--no-ff",
      "writer-a",
      "-m",
      "fixture: join writer-a",
    ]);
    const conflict = await git(fixture.repository, [
      "merge",
      "--no-ff",
      "writer-b",
      "-m",
      "fixture: join writer-b",
    ]);
    expect(conflict.code).not.toBe(0);
    expect(await mustGit(fixture.repository, ["status", "--porcelain"]))
      .toContain("UU shared.txt");
    expect(() =>
      deriveTaskFanOut(plan(), [
        ...completedWriters,
        { taskId: ids.join, status: "failed" },
      ]),
    ).toThrowError("DEPENDENCY_FAILURE_DECISION_REQUIRED");
  } finally {
    await disposeGitFixture(fixture);
  }
});

test("Golden-2 schedules integration only after the explicit join succeeds", async () => {
  const fixture = await createGitFixture();
  try {
    await expectIsolatedWorktrees(fixture);
    await commitFile(fixture.writerA, "writer-a.txt", "writer-a\n");
    await commitFile(fixture.writerB, "writer-b.txt", "writer-b\n");
    const completedWriters = [
      { taskId: ids.writerA, status: "succeeded" as const },
      { taskId: ids.writerB, status: "succeeded" as const },
    ];
    expect(deriveTaskFanOut(plan(), completedWriters)).toEqual([ids.join]);
    expect(deriveTaskFanOut(plan(), [
      ...completedWriters,
      { taskId: ids.join, status: "running" },
    ])).toEqual([]);

    await mustGit(fixture.repository, [
      "merge",
      "--no-ff",
      "writer-a",
      "-m",
      "fixture: join writer-a",
    ]);
    await mustGit(fixture.repository, [
      "merge",
      "--no-ff",
      "writer-b",
      "-m",
      "fixture: join writer-b",
    ]);
    expect(deriveTaskFanOut(plan(), [
      ...completedWriters,
      { taskId: ids.join, status: "succeeded" },
    ])).toEqual([ids.integration]);

    expect(await readFile(
      join(fixture.repository, "writer-a.txt"),
      "utf8",
    )).toBe("writer-a\n");
    expect(await readFile(
      join(fixture.repository, "writer-b.txt"),
      "utf8",
    )).toBe("writer-b\n");
    expect((await git(fixture.repository, ["diff", "--check"])).code).toBe(0);
  } finally {
    await disposeGitFixture(fixture);
  }
});
