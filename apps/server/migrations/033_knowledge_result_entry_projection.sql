BEGIN;

-- 知识条目投影所需、reusability_scope 无法映射的三个字段。
--
-- 背景：knowledgeIngestEntrySchema 要求 type / body / keywords，而管道此前
-- 一路到落库都只有 summary + reusability_scope（自由文本，实测取值 none/server/x）。
-- 缺了它们，入库桥要么凭空捏造分类，要么写出无法通过 safeParse 的残缺 payload
-- ——后者会在语义投影处被静默跳过（semantic/knowledge-projection.ts）。
--
-- 三列一律可空：候选生成器上线前的归档不带这些字段，走降级路径而不是被拒。
ALTER TABLE knowledge_pipeline_results
  ADD COLUMN IF NOT EXISTS entry_type text
    CHECK (entry_type IS NULL OR entry_type IN (
      'requirement', 'decision', 'implementation', 'risk',
      'test-evidence', 'pitfall', 'api-contract'
    )),
  ADD COLUMN IF NOT EXISTS body text,
  ADD COLUMN IF NOT EXISTS keywords jsonb
    CHECK (keywords IS NULL OR jsonb_typeof(keywords) = 'array');

COMMIT;
