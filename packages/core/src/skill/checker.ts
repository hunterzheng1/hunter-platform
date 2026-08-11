import {
  type RegistryAgent,
  type SkillCheckItem,
  type SkillCheckResult,
  type SkillFrontmatter,
  type SourceFile
} from "@hunter-harness/contracts";

import { scanSensitiveFiles } from "../security/scanner.js";
import { compareSemver } from "../skill-ir/semver.js";

import { SkillEntryError } from "./errors.js";
import { findEntryFile, parseFrontmatter } from "./frontmatter.js";

const DANGEROUS_PATH = /(^|[/\\])\.\.([/\\]|$)|^\/|^\\|^[a-zA-Z]:/;
const DANGEROUS_CMD = /rm\s+-rf|drop\s+table|curl\s+|wget\s+|sudo\s+/i;
const DANGEROUS_CAPABILITY = /^Bash\(/i;

/**
 * 源文件驱动检查（取代旧 checkSkill 的 ir 入参）。
 * entry 存在性 / frontmatter 合法性 / 路径安全 / 命名 / 描述 / 结构 / 权限 / 敏感信息 / 版本前进。
 */
export function checkSkill(input: {
  sourceFiles: SourceFile[];
  agent: RegistryAgent;
  latestVersion?: string | null;
  compilerVersion: string;
  checkedAt: string;
}): SkillCheckResult {
  const { sourceFiles, agent, latestVersion = null, checkedAt } = input;
  const items: SkillCheckItem[] = [];

  let entryPath: string | null = null;
  let meta: SkillFrontmatter | null = null;
  let entryError: SkillEntryError | null = null;
  try {
    const entry = findEntryFile(sourceFiles, agent);
    entryPath = entry.path;
    meta = parseFrontmatter(entry.content);
  } catch (error) {
    if (error instanceof SkillEntryError) {
      entryError = error;
    } else {
      throw error;
    }
  }

  const hasEntry = entryPath !== null && entryError?.code !== "SKILL_ENTRY_NOT_FOUND";
  items.push({
    id: "ENTRY_SKILL_MD",
    label: "入口文件",
    status: hasEntry ? "green" : "red",
    message: hasEntry ? `已找到入口文件：${entryPath}` : "未找到当前工具所需的技能入口文件",
    filePath: entryPath,
    fixable: false
  });

  const fmOk = meta !== null;
  items.push({
    id: "FRONTMATTER_VALID",
    label: "配置格式",
    status: fmOk ? "green" : "red",
    message: fmOk ? "入口文件的 YAML 配置格式正确" : "入口文件的 YAML 配置无法解析，请检查头部字段",
    filePath: entryPath,
    fixable: false
  });

  const unsafe = sourceFiles.find((f) => DANGEROUS_PATH.test(f.path));
  items.push({
    id: "FILE_PATH",
    label: "文件路径安全",
    status: unsafe ? "red" : "green",
    message: unsafe ? "检测到不安全的文件路径：" + unsafe.path : "未发现路径穿越或绝对路径",
    filePath: unsafe?.path ?? null,
    fixable: false
  });

  const name = meta?.name ?? null;
  items.push({
    id: "NAMING",
    label: "命名规范",
    status: name ? "green" : "red",
    message: name ? `技能标识“${name}”已配置` : "缺少技能标识，请在入口文件中补充 name",
    filePath: entryPath,
    fixable: true
  });

  const descLen = (meta?.description ?? "").trim().length;
  const descStatus = descLen === 0 ? "yellow" : (descLen > 2000 ? "red" : (descLen > 500 ? "yellow" : "green"));
  items.push({
    id: "DESCRIPTION",
    label: "描述完整",
    status: descStatus,
    message: descLen === 0
      ? "技能描述为空，建议说明适用场景和主要作用"
      : descLen > 2000
        ? `技能描述过长（${descLen} 个字符），请压缩到 2000 个字符以内`
        : descLen > 500
          ? `技能描述较长（${descLen} 个字符），建议进一步精简`
          : `技能描述完整（${descLen} 个字符）`,
    filePath: entryPath,
    fixable: false
  });

  const paths = sourceFiles.map((f) => f.path);
  const hasRefs = paths.some((p) => /(^|\/)references\//.test(p));
  const hasScripts = paths.some((p) => /(^|\/)scripts\//.test(p));
  const structureScore = [hasRefs, hasScripts].filter(Boolean).length;
  items.push({
    id: "STRUCTURE",
    label: "结构完整",
    status: structureScore >= 1 ? "green" : "yellow",
    message: hasRefs && hasScripts
      ? "已包含参考资料目录和脚本目录"
      : hasRefs
        ? "已包含参考资料目录；当前未包含脚本目录"
        : hasScripts
          ? "已包含脚本目录；当前未包含参考资料目录"
          : "当前未包含参考资料或脚本目录，可按技能需要补充",
    filePath: null,
    fixable: false
  });

  // 权限：frontmatter forbidden_actions + body 危险命令。无 forbidden_actions 时降为 suggestion（fixable=true，不 red）—— UT-012。
  const caps = meta?.forbidden_actions ?? [];
  const bodyText = sourceFiles.map((f) => f.content).join("\n");
  const dangerousCap = caps.find((c) => DANGEROUS_CAPABILITY.test(c));
  const dangerousCmd = DANGEROUS_CMD.test(bodyText);
  const permStatus = dangerousCmd ? "red" : (dangerousCap ? "yellow" : "green");
  items.push({
    id: "PERMISSIONS",
    label: "权限声明",
    status: permStatus,
    message: dangerousCmd
      ? "技能内容中检测到高风险命令，请确认是否应移除"
      : dangerousCap
        ? "检测到需要重点确认的能力声明：" + dangerousCap
        : "未发现危险命令或高风险能力",
    filePath: null,
    fixable: caps.length === 0
  });

  const fileMap: Record<string, string> = {};
  for (const f of sourceFiles) {
    if (!DANGEROUS_PATH.test(f.path)) fileMap[f.path] = f.content;
  }
  const sensitive = scanSensitiveFiles(fileMap);
  const highCount = sensitive.findings.filter((f) => f.severity === "high").length;
  const medCount = sensitive.findings.filter((f) => f.severity === "medium").length;
  const sensitiveStatus = highCount > 0 ? "red" : (medCount > 0 ? "yellow" : "green");
  items.push({
    id: "SENSITIVE",
    label: "敏感信息",
    status: sensitiveStatus,
    message: highCount > 0
      ? `发现 ${highCount} 项高风险敏感信息和 ${medCount} 项中风险敏感信息`
      : medCount > 0
        ? `发现 ${medCount} 项中风险敏感信息，需要人工确认`
        : "未发现高风险或中风险敏感信息",
    filePath: sensitive.findings[0]?.path ?? null,
    fixable: false
  });

  const version = meta?.version ?? null;
  const latest = latestVersion ?? null;
  const versionStatus = version === null || latest === null
    ? "green"
    : (compareSemver(version, latest) > 0 ? "green" : "red");
  items.push({
    id: "VERSION",
    label: "版本前进",
    status: versionStatus,
    message: version === null && latest === null
      ? "当前技能未声明版本，且暂无已发布版本可比较"
      : version === null
        ? `当前技能未声明版本；已发布版本为 ${latest}`
        : latest === null
          ? `当前技能版本为 ${version}，暂无已发布版本可比较`
          : compareSemver(version, latest) > 0
            ? `当前版本 ${version} 高于已发布版本 ${latest}`
            : `当前版本 ${version} 未高于已发布版本 ${latest}`,
    filePath: entryPath,
    fixable: true
  });

  const summary = {
    green: items.filter((i) => i.status === "green").length,
    yellow: items.filter((i) => i.status === "yellow").length,
    red: items.filter((i) => i.status === "red").length
  };
  return { items, summary, checkedAt };
}
