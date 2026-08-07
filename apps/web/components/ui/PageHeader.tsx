"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Icon } from "./icons";

/**
 * 统一页面头部：返回链接（可选）+ eyebrow + 标题 + 副标题 + 右侧操作区。
 * 统一各页层级结构，替换散落的 .page-header / .project-registry-hero 手写结构。
 */
export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
  backHref,
  backLabel
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <header className="page-hero">
      <div className="page-hero-main">
        {backHref === undefined ? null : (
          <Link className="back-button" href={backHref} aria-label={backLabel ?? "Back"}>
            <Icon name="back" size={15} />
          </Link>
        )}
        <div className="page-hero-copy">
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          {lede === undefined ? null : <p className="lede">{lede}</p>}
        </div>
      </div>
      {actions === undefined ? null : <div className="page-hero-actions">{actions}</div>}
    </header>
  );
}
