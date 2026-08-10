import type { ExternalSkill } from "@hunter-harness/contracts";

function cleanHeading(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export function externalSkillDisplayName(skill: ExternalSkill): string {
  const readmeHeading = skill.snapshot.readme?.match(/^\s*#\s+(.+?)\s*$/m)?.[1];
  const heading = readmeHeading === undefined ? "" : cleanHeading(readmeHeading);
  if (heading.length > 0 && heading.length <= 80) return heading;

  const sourceName = skill.source.ref.split("/").filter(Boolean).at(-1)?.trim() ?? "";
  if (sourceName.length > 0) return sourceName;
  return skill.snapshot.name.trim();
}

export function externalSkillDescription(skill: ExternalSkill): string {
  const generated = skill.aiSummary?.overview.trim() ?? "";
  if (generated.length > 0) return generated;
  const upstream = skill.snapshot.description.trim();
  return upstream.length > 0 ? upstream : skill.curationNote.trim();
}

export function externalSkillSourceName(skill: ExternalSkill): string {
  return skill.source.type === "github" ? "GitHub" : "npm";
}

export function externalSkillRepositoryUrl(skill: ExternalSkill): string | null {
  if (skill.source.type === "github") return `https://github.com/${skill.source.ref}`;
  return skill.snapshot.homepage;
}

export function externalSkillReadmeImageBase(skill: ExternalSkill): string | undefined {
  if (skill.source.type !== "github") return undefined;
  return `https://raw.githubusercontent.com/${skill.source.ref}/HEAD/`;
}

export function externalSkillReadmeLinkBase(skill: ExternalSkill): string | undefined {
  if (skill.source.type !== "github") return skill.snapshot.homepage ?? undefined;
  return `https://github.com/${skill.source.ref}/blob/HEAD/`;
}
