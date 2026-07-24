export interface StorageMigrationResourceEntry {
  readonly filename: string;
  readonly kind: "file" | "other";
}

export interface StorageMigrationManifestEntry {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
}

const MIGRATION_FILENAME =
  /^(?<version>[0-9]{3})-(?<name>[a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/u;

export function parseStorageMigrationManifest(
  entries: readonly StorageMigrationResourceEntry[],
): readonly StorageMigrationManifestEntry[] {
  const sqlEntries = entries.filter(({ filename }) => /\.sql$/iu.test(filename));
  if (
    sqlEntries.some(({ filename, kind }) =>
      kind !== "file" || !MIGRATION_FILENAME.test(filename)
    )
  ) {
    throw new Error("MIGRATION_MANIFEST_FILENAME_INVALID");
  }
  const manifest = sqlEntries
    .map(({ filename }) => {
      const match = MIGRATION_FILENAME.exec(filename);
      if (match?.groups === undefined) {
        throw new Error("MIGRATION_MANIFEST_FILENAME_INVALID");
      }
      return {
        version: Number(match.groups.version),
        name: match.groups.name ?? "",
        filename,
      };
    })
    .sort((left, right) => left.version - right.version);
  if (
    manifest.length === 0
    || manifest.some(({ version }, index) => version !== index + 1)
  ) {
    throw new Error("MIGRATION_MANIFEST_SEQUENCE_INVALID");
  }
  return manifest;
}
