import {
  copyFile,
  mkdir,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";

import { parseStorageMigrationManifest } from "@hunter/storage";

export async function copySqlMigrations(
  sourceDirectory: string,
  targetDirectory: string,
): Promise<readonly string[]> {
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  const filenames = parseStorageMigrationManifest(
    entries.map((entry) => ({
      filename: entry.name,
      kind: entry.isFile() ? "file" : "other",
    })),
  ).map(({ filename }) => filename);
  await mkdir(targetDirectory, { recursive: true });
  for (const filename of filenames) {
    await copyFile(
      join(sourceDirectory, filename),
      join(targetDirectory, filename),
    );
  }
  return filenames;
}
