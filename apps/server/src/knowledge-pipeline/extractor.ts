import type { KnowledgeCandidate } from "@hunter-harness/contracts";

import type {
  KnowledgeExtractorInput,
  KnowledgeExtractorPort
} from "./worker-host/index.js";
import type { ArchiveStore } from "./ports.js";
import type { KnowledgeResultDraft } from "./types.js";
import { KnowledgePipelineError } from "./errors.js";

/** 与服务端入库裁决同一阈值（semantic/knowledge-judge 的 DEFAULT_MIN_CONFIDENCE）。 */
const AUTO_PROMOTE_MIN_CONFIDENCE = 0.82;
const MAX_RESULT_DRAFTS = 64;

function displayTitle(candidate: KnowledgeCandidate): string {
  const firstSentence = candidate.summary.split(/[\n。.!！?？]/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  const title = (firstSentence ?? candidate.summary).trim();
  return title.length > 240 ? title.slice(0, 240) : title;
}

/**
 * 生产知识提取器：读取已存储归档的知识候选，按与服务端入库裁决一致的
 * 置信度阈值（0.82）自动放行，产出知识结果草稿。
 * 不重新打分——候选置信度由归档生产侧的提取器计算并随包冻结；
 * 候选缺失/状态非 pending 时不发明知识（fail closed）。
 */
export function createKnowledgeExtractor(dependencies: {
  archive_store: ArchiveStore;
}): KnowledgeExtractorPort {
  return Object.freeze({
    async extract(input: KnowledgeExtractorInput): Promise<readonly KnowledgeResultDraft[]> {
      const job = input.job;
      const archive = await dependencies.archive_store.getByArchiveId(job.archive_id);
      if (archive === null) {
        throw new KnowledgePipelineError("KNOWLEDGE_EXTRACTION_ARCHIVE_NOT_FOUND", true);
      }
      if (archive.project_id !== job.project_id || archive.change_key !== job.change_key) {
        throw new KnowledgePipelineError("KNOWLEDGE_EXTRACTION_ARCHIVE_IDENTITY_MISMATCH", false);
      }
      return archive.knowledge_candidates
        .filter((candidate) =>
          candidate.status === "pending" && candidate.confidence >= AUTO_PROMOTE_MIN_CONFIDENCE)
        .slice(0, MAX_RESULT_DRAFTS)
        .map((candidate) => Object.freeze({
          source_candidate_id: candidate.candidate_id,
          content_hash: candidate.content_hash,
          display_title: displayTitle(candidate),
          summary: candidate.summary,
          reusability_scope: candidate.reusability_scope,
          source_refs: [...candidate.source_refs],
          confidence: candidate.confidence,
          // 原样透传，不补默认值：缺失与"值为某个默认分类"是两回事，
          // 后者会让分类失真且无法在下游区分。
          ...(candidate.entry_type === undefined ? {} : { entry_type: candidate.entry_type }),
          ...(candidate.body === undefined ? {} : { body: candidate.body }),
          ...(candidate.keywords === undefined ? {} : { keywords: [...candidate.keywords] })
        }));
    }
  });
}
