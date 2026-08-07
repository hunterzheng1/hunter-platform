"use client";

import { useMemo, useState } from "react";

import { Icon } from "./icons";

export interface PaginationLabels {
  first: string;
  prev: string;
  next: string;
  last: string;
  /** 形如 "第 {page} / {total} 页" */
  pageInfo: string;
  /** 可选，形如 "共 {count} 条" */
  totalCount?: string;
}

/** 页码序列：1 … 4 5 [6] 7 8 … 20，超过 7 个页码时折叠。 */
function pageSequence(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const window = new Set<number>([1, 2, total - 1, total, current - 1, current, current + 1]);
  const pages = [...window].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const result: Array<number | "ellipsis"> = [];
  let previous = 0;
  for (const page of pages) {
    if (previous !== 0 && page - previous > 1) result.push("ellipsis");
    result.push(page);
    previous = page;
  }
  return result;
}

export function Pagination({
  page,
  totalPages,
  total,
  onChange,
  labels
}: {
  page: number;
  totalPages: number;
  total?: number;
  onChange: (page: number) => void;
  labels: PaginationLabels;
}) {
  if (totalPages <= 1 && total === undefined) return null;
  const current = Math.min(Math.max(1, page), totalPages);
  const info = labels.pageInfo
    .replace("{page}", String(current))
    .replace("{total}", String(totalPages));

  return (
    <div className="pagination-bar pagination-v2">
      {total !== undefined && labels.totalCount !== undefined ? (
        <span className="pagination-total">{labels.totalCount.replace("{count}", String(total))}</span>
      ) : null}
      <div className="pagination-controls">
        <button type="button" className="pagination-nav" disabled={current <= 1} onClick={() => onChange(1)} aria-label={labels.first} title={labels.first}>
          <Icon name="chevrons-left" size={14} />
        </button>
        <button type="button" className="pagination-nav" disabled={current <= 1} onClick={() => onChange(current - 1)} aria-label={labels.prev} title={labels.prev}>
          <Icon name="chevron-left" size={14} />
        </button>
        {pageSequence(current, totalPages).map((item, index) =>
          item === "ellipsis" ? (
            <span className="pagination-ellipsis" key={`ellipsis-${index}`}>…</span>
          ) : (
            <button
              type="button"
              key={item}
              className={`pagination-page${item === current ? " active" : ""}`}
              aria-current={item === current ? "page" : undefined}
              onClick={() => onChange(item)}
            >
              {item}
            </button>
          )
        )}
        <button type="button" className="pagination-nav" disabled={current >= totalPages} onClick={() => onChange(current + 1)} aria-label={labels.next} title={labels.next}>
          <Icon name="chevron-right" size={14} />
        </button>
        <button type="button" className="pagination-nav" disabled={current >= totalPages} onClick={() => onChange(totalPages)} aria-label={labels.last} title={labels.last}>
          <Icon name="chevrons-right" size={14} />
        </button>
      </div>
      <span className="pagination-info">{info}</span>
    </div>
  );
}

/** 客户端分页 hook：页码状态 + 过滤条件变化时自动回第 1 页。 */
export function usePagination<T>(items: readonly T[], pageSize: number, resetDeps: readonly unknown[] = []) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => items.slice((current - 1) * pageSize, current * pageSize),
    [items, current, pageSize]
  );
  // 依赖变化（过滤条件等）时回到第一页
  const depsKey = JSON.stringify(resetDeps);
  const [lastKey, setLastKey] = useState(depsKey);
  if (depsKey !== lastKey) {
    setLastKey(depsKey);
    setPage(1);
  }
  return { page: current, totalPages, pageItems, setPage, total: items.length };
}
