import { useEffect, useState } from "react";

import type { HunterApi, KnowledgeResponse } from "../api/client.js";

type KnowledgeApi = Pick<HunterApi, "getKnowledge">;

export function KnowledgePage({
  projectId,
  api,
  onBack,
}: {
  readonly projectId: string;
  readonly api: KnowledgeApi;
  readonly onBack: () => void;
}) {
  const [knowledge, setKnowledge] = useState<KnowledgeResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    void api.getKnowledge(projectId, true)
      .then((response) => {
        if (current) setKnowledge(response);
      })
      .catch(() => {
        if (current) setError("Knowledge could not be loaded.");
      });
    return () => {
      current = false;
    };
  }, [api, projectId]);

  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Project-scoped</p>
          <h1>Knowledge</h1>
          <p className="page-description">
            Active guidance and explicitly labeled historical Run archives.
          </p>
        </div>
        <button className="button button-secondary" type="button" onClick={onBack}>
          Back to Project
        </button>
      </header>
      {error === undefined ? null : <p role="alert" className="message error-message">{error}</p>}
      {knowledge === undefined && error === undefined ? <p role="status">Loading Knowledge…</p> : null}
      <section className="panel" aria-label="Knowledge entries">
        {knowledge?.entries.length === 0 ? <p>No Knowledge entries yet.</p> : null}
        <ul className="project-list">
          {knowledge?.entries.map((entry) => {
            const provenance = entry.level === "historical"
              ? entry.source
              : undefined;
            return (
              <li className="project-row" key={entry.entryId}>
                <div>
                  <strong>{entry.summary}</strong>
                  <span>{entry.level} · {entry.status}</span>
                  <p>{entry.body}</p>
                  {provenance === undefined ? null : (
                    <footer>
                      <span>archive · {provenance.runId}</span>
                      <code>sha256:{provenance.manifestHash}</code>
                    </footer>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
