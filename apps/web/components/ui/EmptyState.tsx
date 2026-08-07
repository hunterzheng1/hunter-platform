"use client";

import type { ReactNode } from "react";

import { Icon, type IconName } from "./icons";

/** 统一空状态：图标 + 标题 + 可选提示/操作。 */
export function EmptyState({
  icon = "inbox",
  title,
  hint,
  action
}: {
  icon?: IconName;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state empty-state-v2">
      <span className="empty-state-icon">
        <Icon name={icon} size={22} strokeWidth={1.5} />
      </span>
      <strong>{title}</strong>
      {hint === undefined ? null : <p>{hint}</p>}
      {action === undefined ? null : <div className="empty-state-action">{action}</div>}
    </div>
  );
}
