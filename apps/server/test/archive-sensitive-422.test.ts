import { scanSensitiveFiles } from "@hunter-harness/core";
import { describe, expect, it } from "vitest";

import { describeSensitiveRejection } from "../src/archive/package-ingest.js";

/**
 * The 422 that ends an archive upload has to tell the caller what to do next.
 *
 * In the kld-sdd usage-stats-git-identity upload it returned only
 * `{path, rule_id, severity}`. The caller could not tell whether the finding was
 * waivable or had to be redacted, concluded "不可篡改绕过服务端安全策略", and gave
 * up — while an inline waiver was the sanctioned exit all along. That is the
 * same failure shape as a fail-closed gate with no escape hatch: people do not
 * stop at the gate, they go around it or abandon the work.
 */

function scanDesign(text: string) {
  return scanSensitiveFiles({ "plans/demo-design.md": text });
}

describe("archive sensitive-content rejection details", () => {
  it("names the line, column and whether the finding can be waived", () => {
    const scan = scanDesign("# design\n\ndefault endpoint http://10.29.213.80:8080\n");

    const details = describeSensitiveRejection(scan.findings, scan.scanner_version);

    expect(details.scanner_version).toBe("1.1.0");
    expect(details.findings).toHaveLength(1);
    expect(details.findings[0]).toMatchObject({
      path: "plans/demo-design.md",
      rule_id: "HH_INTERNAL_ADDRESS",
      severity: "medium",
      line: 3,
      overridable: true
    });
    expect(details.findings[0]?.column).toBeTypeOf("number");
  });

  it("spells out the sanctioned exit for a waivable finding", () => {
    const scan = scanDesign("# design\n\ndefault endpoint http://10.29.213.80:8080\n");

    const details = describeSensitiveRejection(scan.findings, scan.scanner_version);

    expect(details.next_action).toContain("hunter-harness-ignore");
    expect(details.next_action).toContain("HH_INTERNAL_ADDRESS");
    expect(details.next_action).toContain("plans/demo-design.md:3");
    // 申报不是"想过就过"：另一条出路必须同样写明。
    expect(details.next_action).toContain("脱敏");
  });

  it("refuses to offer a waiver when any finding is non-overridable", () => {
    const scan = scanDesign(
      "# design\n\nDB: postgres://appuser:s3cr3t@dbhost:5432/appdb\n"
    );

    const details = describeSensitiveRejection(scan.findings, scan.scanner_version);

    expect(details.findings[0]).toMatchObject({
      rule_id: "HH_DATABASE_URL",
      overridable: false
    });
    // 泄露的密钥材料不该被引导去加标注。
    expect(details.next_action).not.toContain("hunter-harness-ignore");
    expect(details.next_action).toContain("脱敏");
  });

  it("omits findings a declared inline waiver already cleared", () => {
    const scan = scanDesign(
      "# design\n\n" +
        "<!-- hunter-harness-ignore: HH_INTERNAL_ADDRESS reason=designed-endpoint -->\n" +
        "default endpoint http://10.29.213.80:8080\n"
    );

    expect(scan.blocked).toBe(false);
    expect(describeSensitiveRejection(scan.findings, scan.scanner_version).findings)
      .toHaveLength(0);
  });

  it("does not reject a credential-free connection string at all", () => {
    // 裸连接串曾被判 high——而 high 不接受行内豁免，这份设计文档就永久无法上传。
    const scan = scanDesign("# design\n\nDB: postgres://dbhost:5432/appdb\n");

    const finding = scan.findings.find((item) => item.rule_id === "HH_DATABASE_URL");
    expect(finding).toMatchObject({ severity: "low", overridable: true });
  });
});
