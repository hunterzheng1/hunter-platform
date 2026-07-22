import { mkdir, writeFile } from "node:fs/promises";
import { arch, release } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import {
  NodeCommandRunner,
  assertSafeEvidence,
  redact,
} from "@hunter/spike-testkit";
import { createDoctorInventory } from "./probes.js";

function parseOutputArgument(argv: readonly string[]): string {
  const outputIndex = argv.indexOf("--output");
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  if (output === undefined || output.trim() === "") {
    throw new Error("USAGE: --output docs/validation/<file>.json");
  }
  return output;
}

function assertValidationOutput(repositoryRoot: string, output: string): string {
  const validationRoot = resolve(repositoryRoot, "docs", "validation");
  const outputPath = resolve(repositoryRoot, output);
  const segment = relative(validationRoot, outputPath);
  if (
    segment === "" ||
    segment === ".." ||
    segment.startsWith(`..${sep}`) ||
    !outputPath.endsWith(".json")
  ) {
    throw new Error("DOCTOR_OUTPUT_MUST_BE_UNDER_DOCS_VALIDATION");
  }
  return outputPath;
}

async function main(): Promise<void> {
  const repositoryRoot = process.cwd();
  const output = parseOutputArgument(process.argv.slice(2));
  const outputPath = assertValidationOutput(repositoryRoot, output);
  const inventory = await createDoctorInventory({
    runner: new NodeCommandRunner(),
    cwd: repositoryRoot,
    now: () => new Date(),
    host: {
      platform: process.platform,
      architecture: arch(),
      release: release(),
    },
  });
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  assertSafeEvidence(serialized);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, "utf8");
  process.stdout.write(
    `Phase 0 doctor: DETECTED=${inventory.summary.detected} BLOCKED=${inventory.summary.blocked} NOT_PROVEN=${inventory.summary.notProven}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Phase 0 doctor failed: ${redact(message)}\n`);
  process.exitCode = 1;
});
