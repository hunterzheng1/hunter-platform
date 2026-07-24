import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const LEDGER_URL = new URL(
  "../docs/validation/phase-1-acceptance-ledger.md",
  import.meta.url,
);

const FUNCTIONAL_IDS = [
  "P-01",
  "P-02",
  "R-01",
  "R-02",
  "R-03",
  "C-01",
  "T-01",
  "T-02",
  "W-01",
  "W-02",
  "W-03",
  "W-04",
  "A-01",
  "A-02",
  "X-01",
  "X-02",
  "X-03",
  "X-04",
  "O-01",
  "S-01",
  "S-02",
  "S-03",
  "K-01",
  "K-02",
  "M-01",
  "M-02",
  "SEC-01",
  "SEC-02",
  "LNX-01",
] as const;

const GOLDEN_IDS = [
  "GOLDEN-01",
  "GOLDEN-02",
  "GOLDEN-03",
  "GOLDEN-04",
  "GOLDEN-05",
  "GOLDEN-06",
] as const;

const NON_FUNCTIONAL_IDS = [
  "NFR-REL-01",
  "NFR-REL-02",
  "NFR-REL-03",
  "NFR-REL-04",
  "NFR-PERF-01",
  "NFR-PERF-02",
  "NFR-PERF-03",
  "NFR-PERF-04",
  "NFR-PORT-01",
  "NFR-PORT-02",
  "NFR-PORT-03",
  "NFR-PORT-04",
  "NFR-OBS-01",
  "NFR-OBS-02",
  "NFR-OBS-03",
  "NFR-OBS-04",
] as const;

const RELEASE_BLOCKER_IDS = [
  "BLOCK-01",
  "BLOCK-02",
  "BLOCK-03",
  "BLOCK-04",
  "BLOCK-05",
  "BLOCK-06",
  "BLOCK-07",
  "BLOCK-08",
  "BLOCK-09",
  "BLOCK-10",
] as const;

const SUPPLY_CHAIN_IDS = ["SUP-01", "SUP-02"] as const;

const EXPECTED_IDS = [
  ...FUNCTIONAL_IDS,
  ...GOLDEN_IDS,
  ...NON_FUNCTIONAL_IDS,
  ...RELEASE_BLOCKER_IDS,
  ...SUPPLY_CHAIN_IDS,
] as const;

const ALLOWED_STATUSES = new Set([
  "PASS",
  "FAIL",
  "BLOCKED",
  "NOT_PROVEN",
  "NOT_RUN",
  "CONTRACT_ONLY",
]);

interface LedgerRow {
  readonly id: string;
  readonly status: string;
  readonly scope: string;
  readonly evidence: string;
  readonly nextAction: string;
  readonly owner: string;
}

function parseRows(markdown: string): readonly LedgerRow[] {
  return markdown
    .split(/\r?\n/u)
    .filter((line) => /^\| (?!ID \|)[A-Z][A-Z0-9-]+ \|/u.test(line))
    .map((line) => {
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      expect(cells).toHaveLength(6);
      return {
        id: cells[0] ?? "",
        status: cells[1] ?? "",
        scope: cells[2] ?? "",
        evidence: cells[3] ?? "",
        nextAction: cells[4] ?? "",
        owner: cells[5] ?? "",
      };
    });
}

describe("Phase 1 acceptance ledger", () => {
  it("accounts for every acceptance, non-functional, blocker, and supply-chain item", () => {
    const rows = parseRows(readFileSync(LEDGER_URL, "utf8"));
    const ids = rows.map(({ id }) => id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(EXPECTED_IDS);
    for (const row of rows) {
      expect(ALLOWED_STATUSES.has(row.status), row.id).toBe(true);
      expect(row.scope, row.id).not.toBe("");
      expect(row.evidence, row.id).toMatch(/\[[^\]]+\]\([^)]+\)/u);
      expect(row.nextAction, row.id).not.toBe("");
      expect(row.owner, row.id).not.toBe("");
    }
  });

  it("never upgrades real Provider or real-device acceptance from Fake evidence", () => {
    const byId = new Map(
      parseRows(readFileSync(LEDGER_URL, "utf8")).map((row) => [row.id, row]),
    );
    for (const id of [
      "X-01",
      "X-02",
      "X-03",
      "O-01",
      "M-01",
      "GOLDEN-04",
      "GOLDEN-06",
    ]) {
      expect(byId.get(id)?.status, id).toMatch(/^(BLOCKED|NOT_PROVEN)$/u);
    }
  });

  it("keeps registry audit unproven until dependency metadata transmission is authorized", () => {
    const byId = new Map(
      parseRows(readFileSync(LEDGER_URL, "utf8")).map((row) => [row.id, row]),
    );
    expect(byId.get("SUP-01")?.status).toBe("NOT_PROVEN");
    expect(byId.get("SUP-02")).toMatchObject({
      status: "NOT_RUN",
      owner: "Owner/Security",
    });
    expect(byId.get("SUP-02")?.nextAction).toContain("明确授权");
  });
});
