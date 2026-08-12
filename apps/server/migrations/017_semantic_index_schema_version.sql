-- Track the indexer contract represented by each published semantic generation.
-- Existing rows deliberately stay at v1 so the first read/retry rebuilds them.
ALTER TABLE semantic_generations
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN semantic_generations.schema_version IS
  'Semantic indexer schema represented by this generation; stale versions are rebuilt lazily.';
