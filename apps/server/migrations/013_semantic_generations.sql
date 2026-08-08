-- Explicit generation metadata prevents ingest-projected documents from being
-- mistaken for the current full semantic snapshot.
CREATE TABLE IF NOT EXISTS semantic_generations (
  project_id text PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO semantic_generations(project_id, artifact_id)
SELECT project.project_id, project.latest_artifact_id
FROM projects project
WHERE project.latest_artifact_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM semantic_documents document
    WHERE document.project_id = project.project_id
      AND document.artifact_id = project.latest_artifact_id
  )
ON CONFLICT (project_id) DO NOTHING;

COMMENT ON TABLE semantic_generations IS
  'The project artifact generation currently represented by the full semantic snapshot.';
