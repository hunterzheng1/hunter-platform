-- 中文 FTS 修复：Postgres 的 simple 配置不会切分连续 CJK 文本。
-- 保持现有 search_vector 不变，另建表达式 GIN 索引；避免 DROP/ADD generated
-- column 触发表重写和 AccessExclusiveLock，从而让服务在迁移期间不可用。
CREATE OR REPLACE FUNCTION cjk_bigrams(input_text text) RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  WITH cjk_runs AS (
    SELECT run
    FROM regexp_split_to_table(
      regexp_replace(input_text, '[^一-龥]+', ' ', 'g'),
      E'\\s+'
    ) AS run
    WHERE run <> ''
  ), bigrams AS (
    SELECT substring(run FROM position FOR 2) AS token
    FROM cjk_runs
    CROSS JOIN LATERAL generate_series(1, GREATEST(char_length(run) - 1, 1)) AS position
  )
  SELECT COALESCE(string_agg(token, ' '), '')
  FROM bigrams
$$;

COMMENT ON FUNCTION cjk_bigrams(text) IS
  'CJK runs to overlapping bigrams (问候语 -> 问候 候语) for substring-capable FTS';

-- The expression is intentionally identical to PgSemanticStore.search(). This creates
-- no generated-column rewrite; CREATE INDEX takes a non-exclusive table lock only.
CREATE INDEX IF NOT EXISTS semantic_documents_cjk_search_idx
  ON semantic_documents USING GIN (
    to_tsvector('simple', cjk_bigrams(coalesce(title, '') || ' ' || coalesce(body, '')))
  );
