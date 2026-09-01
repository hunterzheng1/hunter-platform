-- 中文 FTS 修复：Postgres 'simple' 配置对 CJK 不做分词——连续中文变成单个 tsvector
-- token（"问候语模块" 是一个 token），子串查询永远匹配不到。语义搜索对中文用户
-- （本平台主要语言）等于不可用。方案：给 CJK 连续段生成重叠 bigram（"问候语" ->
-- "问候 候语"），索引与查询两侧都走 bigram，子串语义（含 AND 组合）即可命中。

CREATE OR REPLACE FUNCTION cjk_bigrams(input_text text) RETURNS text AS $$
DECLARE
  i int;
  ch text;
  run text := '';
  out_parts text[] := '{}';
  cur text;
BEGIN
  IF input_text IS NULL THEN
    RETURN NULL;
  END IF;
  FOR i IN 1..char_length(input_text) LOOP
    ch := substring(input_text FROM i FOR 1);
    IF ch ~ '[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]' THEN
      run := run || ch;
      IF char_length(run) >= 2 THEN
        out_parts := array_append(out_parts, run);
        run := substring(run FROM 2);
      END IF;
    ELSE
      IF char_length(run) = 1 THEN
        out_parts := array_append(out_parts, run);
      END IF;
      run := '';
    END IF;
  END LOOP;
  IF char_length(run) = 1 THEN
    out_parts := array_append(out_parts, run);
  END IF;
  IF array_length(out_parts, 1) IS NULL THEN
    RETURN '';
  END IF;
  cur := '';
  FOR i IN 1..array_length(out_parts, 1) LOOP
    cur := cur || ' ' || out_parts[i];
  END LOOP;
  RETURN cur;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

COMMENT ON FUNCTION cjk_bigrams(text) IS
  'CJK runs to overlapping bigrams (问候语 -> 问候 候语) for substring-capable FTS';

-- 重建 search_vector 生成列：原 to_tsvector 之外并上 bigram 向量。
-- DROP COLUMN 会连带删掉 GIN 索引，随后重建。
ALTER TABLE semantic_documents DROP COLUMN IF EXISTS search_vector;
ALTER TABLE semantic_documents
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, '')) ||
    to_tsvector('simple', cjk_bigrams(coalesce(title, '') || ' ' || coalesce(body, '')))
  ) STORED;

CREATE INDEX IF NOT EXISTS semantic_documents_search_idx
  ON semantic_documents USING GIN (search_vector);
