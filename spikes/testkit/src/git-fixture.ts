import { access, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { NodeCommandRunner } from "./command-runner.js";

export interface TemporaryGitFixture {
  readonly path: string;
  readonly baselineCommit: string;
}

export interface ProbeWorkspaceRequest {
  readonly mutation: "none" | "repository";
  readonly cwd: string;
  readonly fixture?: TemporaryGitFixture;
}

const activeFixtures = new WeakSet<object>();

export function assertProbeWorkspace(request: ProbeWorkspaceRequest): void {
  if (request.mutation === "none") return;
  if (
    request.fixture === undefined ||
    !activeFixtures.has(request.fixture) ||
    resolve(request.cwd) !== resolve(request.fixture.path)
  ) {
    throw new Error("MUTATING_PROBE_REQUIRES_TEMP_GIT_FIXTURE");
  }
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await new NodeCommandRunner().run({
    executable: "git",
    args,
    cwd,
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`TEMP_GIT_FIXTURE_FAILED:${result.spawnError ?? result.exitCode ?? "unknown"}`);
  }
  return result.stdout.trim();
}

function isWithin(parent: string, child: string): boolean {
  const segment = relative(parent, child);
  return (
    segment !== "" &&
    segment !== ".." &&
    !segment.startsWith(`..${sep}`) &&
    !isAbsolute(segment)
  );
}

export async function withTemporaryGitFixture<T>(
  action: (fixture: TemporaryGitFixture) => Promise<T>,
): Promise<T> {
  const temporaryRoot = await realpath(tmpdir());
  const createdPath = await mkdtemp(join(temporaryRoot, "hunter-phase0-"));
  const fixturePath = await realpath(createdPath);
  const fixtureStat = await lstat(fixturePath);
  if (!fixtureStat.isDirectory() || fixtureStat.isSymbolicLink()) {
    throw new Error("TEMP_GIT_FIXTURE_PATH_INVALID");
  }
  if (!isWithin(temporaryRoot, fixturePath) || !basename(fixturePath).startsWith("hunter-phase0-")) {
    throw new Error("TEMP_GIT_FIXTURE_OUTSIDE_TEMP_ROOT");
  }

  let actionResult: T | undefined;
  let actionError: unknown;
  try {
    await runGit(fixturePath, ["init", "--quiet"]);
    await writeFile(join(fixturePath, "README.md"), "# Hunter Phase 0 fixture\n", "utf8");
    await runGit(fixturePath, ["add", "README.md"]);
    await runGit(fixturePath, [
      "-c",
      "user.name=Hunter Phase 0",
      "-c",
      "user.email=phase0@invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture baseline",
    ]);
    const baselineCommit = await runGit(fixturePath, ["rev-parse", "HEAD"]);
    const fixture: TemporaryGitFixture = { path: fixturePath, baselineCommit };
    activeFixtures.add(fixture);
    actionResult = await action(fixture);
  } catch (error: unknown) {
    actionError = error;
  }

  let cleanupError: unknown;
  try {
    await access(fixturePath);
    const verifiedPath = await realpath(fixturePath);
    if (
      !isWithin(temporaryRoot, verifiedPath) ||
      !basename(verifiedPath).startsWith("hunter-phase0-")
    ) {
      throw new Error("TEMP_GIT_FIXTURE_CLEANUP_REFUSED");
    }
    await rm(verifiedPath, { recursive: true, force: false });
  } catch (error: unknown) {
    cleanupError = error;
  }

  if (actionError !== undefined) throw actionError;
  if (cleanupError !== undefined) throw cleanupError;
  return actionResult as T;
}
