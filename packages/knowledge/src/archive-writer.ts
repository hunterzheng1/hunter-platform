import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  VerifiedArchiveReceiptSchema,
  type VerifiedArchiveReceipt,
} from "./contracts.js";
import {
  verifyArchiveManifest,
  type ArchiveManifest,
} from "./archive-manifest.js";

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || !["EACCES", "EINVAL", "EPERM"].includes(code ?? "")) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export class ArchiveWriter {
  public constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  public publish(
    input: unknown,
    verifiedAt = new Date().toISOString(),
  ): VerifiedArchiveReceipt {
    const manifest = verifyArchiveManifest(input);
    const finalPath = join(this.root, `${manifest.manifestHash}.json`);
    const encoded = `${JSON.stringify(manifest)}\n`;
    if (existsSync(finalPath)) {
      const existing = verifyArchiveManifest(
        JSON.parse(readFileSync(finalPath, "utf8")) as unknown,
      );
      if (
        existing.manifestHash !== manifest.manifestHash ||
        JSON.stringify(existing) !== JSON.stringify(manifest)
      ) {
        throw new Error("ARCHIVE_MANIFEST_CONTENT_CONFLICT");
      }
      return this.receiptFor(manifest, verifiedAt);
    }

    const temporaryPath = join(
      this.root,
      `.${manifest.manifestHash}.${randomBytes(12).toString("hex")}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, encoded, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        renameSync(temporaryPath, finalPath);
      } catch (error) {
        if (!existsSync(finalPath)) throw error;
        unlinkSync(temporaryPath);
        const existing = verifyArchiveManifest(
          JSON.parse(readFileSync(finalPath, "utf8")) as unknown,
        );
        if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
          throw new Error("ARCHIVE_MANIFEST_CONTENT_CONFLICT");
        }
      }
      syncDirectory(this.root);
      const published = verifyArchiveManifest(
        JSON.parse(readFileSync(finalPath, "utf8")) as unknown,
      );
      if (JSON.stringify(published) !== JSON.stringify(manifest)) {
        throw new Error("ARCHIVE_MANIFEST_FINAL_VERIFICATION_FAILED");
      }
      return this.receiptFor(manifest, verifiedAt);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
  }

  private receiptFor(
    manifest: ArchiveManifest,
    verifiedAt: string,
  ): VerifiedArchiveReceipt {
    return VerifiedArchiveReceiptSchema.parse({
      receiptSchemaVersion: 1,
      projectId: manifest.projectId,
      runId: manifest.runGraph.rootRunId,
      outcome: manifest.outcome,
      manifestSchemaVersion: manifest.schemaVersion,
      manifestHash: manifest.manifestHash,
      manifestRef: `cas:sha256:${manifest.manifestHash}`,
      verifiedAt,
    });
  }
}
