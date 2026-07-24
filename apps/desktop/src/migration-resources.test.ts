import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copySqlMigrations } from "./migration-resources.js";

const temporaryDirectories = new Set<string>();

async function fixture(): Promise<{
  readonly root: string;
  readonly source: string;
  readonly target: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "hunter-migration-resources-"));
  temporaryDirectories.add(root);
  return {
    root,
    source: join(root, "source"),
    target: join(root, "target"),
  };
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map(async (directory) =>
      await rm(directory, { recursive: true, force: true })
    ),
  );
  temporaryDirectories.clear();
});

describe("copySqlMigrations", () => {
  it("copies every ordered SQL migration and ignores unrelated files", async () => {
    const { source, target } = await fixture();
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "001-core.sql"), "SELECT 1;\n", "utf8");
    await writeFile(
      join(source, "002-events-project-position.sql"),
      "SELECT 2;\n",
      "utf8",
    );
    await writeFile(join(source, "README.md"), "not a migration\n", "utf8");

    await expect(copySqlMigrations(source, target)).resolves.toEqual([
      "001-core.sql",
      "002-events-project-position.sql",
    ]);
    await expect(
      readFile(join(target, "001-core.sql"), "utf8"),
    ).resolves.toBe("SELECT 1;\n");
    await expect(
      readFile(join(target, "002-events-project-position.sql"), "utf8"),
    ).resolves.toBe("SELECT 2;\n");
  });

  it("rejects a migration resource gap without copying a partial set", async () => {
    const { source, target } = await fixture();
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "001-core.sql"), "SELECT 1;\n", "utf8");
    await writeFile(join(source, "003-gap.sql"), "SELECT 3;\n", "utf8");

    await expect(copySqlMigrations(source, target)).rejects.toThrowError(
      "MIGRATION_MANIFEST_SEQUENCE_INVALID",
    );
    await expect(readFile(join(target, "001-core.sql"), "utf8")).rejects
      .toThrow();
  });

  it("rejects malformed SQL filenames without copying a partial set", async () => {
    const { source, target } = await fixture();
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "001-core.sql"), "SELECT 1;\n", "utf8");
    await writeFile(join(source, "002-next.sql"), "SELECT 2;\n", "utf8");
    await writeFile(join(source, "003_bad.sql"), "SELECT 3;\n", "utf8");

    await expect(copySqlMigrations(source, target)).rejects.toThrowError(
      "MIGRATION_MANIFEST_FILENAME_INVALID",
    );
    await expect(readFile(join(target, "001-core.sql"), "utf8")).rejects
      .toThrow();
  });
});
