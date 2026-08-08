BEGIN;

-- 原始 ZIP 是归档的耐久事实源；解包后的 project_files 与语义索引均可重建。
CREATE TABLE IF NOT EXISTS change_archive_packages (
  archive_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  change_key text NOT NULL,
  package_sha256 text NOT NULL,
  manifest_sha256 text NOT NULL,
  artifact_id text REFERENCES artifacts(artifact_id) ON DELETE SET NULL,
  archive_status text NOT NULL CHECK (archive_status = 'durable'),
  knowledge_status text NOT NULL CHECK (knowledge_status IN ('indexing', 'ready', 'failed')),
  stored_files integer NOT NULL CHECK (stored_files >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, change_key)
);

CREATE INDEX IF NOT EXISTS change_archive_packages_project_idx
  ON change_archive_packages(project_id, created_at DESC);

COMMIT;
