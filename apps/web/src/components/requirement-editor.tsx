import { useState, type FormEvent } from "react";

import type { CreateRequirementDraftInput } from "../api/client.js";

function lines(value: string): readonly string[] {
  return value.split(/\r?\n/u).map((item) => item.trim()).filter((item) => item.length > 0);
}

export function RequirementEditor({
  onSave,
}: {
  readonly onSave: (input: CreateRequirementDraftInput) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [constraints, setConstraints] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const criteria = lines(acceptanceCriteria);
    if (title.trim().length === 0 || body.trim().length === 0 || criteria.length === 0) {
      setError("请填写标题、正文和至少一条验收标准");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onSave({
        title: title.trim(),
        body: body.trim(),
        acceptanceCriteria: criteria,
        constraints: lines(constraints),
      });
      setTitle("");
      setBody("");
      setAcceptanceCriteria("");
      setConstraints("");
    } catch {
      setError("无法保存需求草稿，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="editor-form" aria-busy={busy} onSubmit={(event) => void submit(event)}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">新建版本</p>
          <h2>需求草稿</h2>
        </div>
        <span className="status status-draft">草稿</span>
      </div>
      <label>
        需求标题
        <input value={title} maxLength={200} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        需求正文
        <textarea value={body} rows={5} maxLength={20_000} disabled={busy} onChange={(event) => setBody(event.target.value)} />
      </label>
      <label>
        验收标准
        <textarea value={acceptanceCriteria} rows={4} disabled={busy} aria-describedby="criteria-help" onChange={(event) => setAcceptanceCriteria(event.target.value)} />
      </label>
      <p id="criteria-help" className="field-help">每行一条，至少填写一条。</p>
      <label>
        约束条件
        <textarea value={constraints} rows={3} disabled={busy} aria-describedby="constraints-help" onChange={(event) => setConstraints(event.target.value)} />
      </label>
      <p id="constraints-help" className="field-help">可选，每行一条。</p>
      {error === undefined ? null : <p role="alert" className="message error-message">{error}</p>}
      <button className="button button-primary" type="submit" disabled={busy}>
        {busy ? "正在保存…" : "保存草稿"}
      </button>
    </form>
  );
}
