"use client";

/** 骨架屏。variant: block 大块面板 / text 文本行 / metric 指标卡 / table 表格行。 */
export function Skeleton({
  variant = "block",
  lines = 3,
  label
}: {
  variant?: "block" | "text" | "metric" | "table";
  lines?: number;
  label?: string;
}) {
  if (variant === "text") {
    return (
      <div className="skeleton-text" aria-busy="true" aria-label={label}>
        {Array.from({ length: lines }, (_, index) => (
          <span key={index} style={{ width: `${index === lines - 1 ? 45 : 88 - (index % 3) * 12}%` }} />
        ))}
      </div>
    );
  }
  if (variant === "metric") {
    return (
      <div className="skeleton-metric" aria-busy="true" aria-label={label}>
        <span className="skeleton-metric-icon" />
        <span className="skeleton-metric-value" />
        <span className="skeleton-metric-label" />
      </div>
    );
  }
  if (variant === "table") {
    return (
      <div className="skeleton-table" aria-busy="true" aria-label={label}>
        {Array.from({ length: lines }, (_, index) => (
          <div className="skeleton-table-row" key={index}>
            <span style={{ width: "28%" }} />
            <span style={{ width: "18%" }} />
            <span style={{ width: "34%" }} />
            <span style={{ width: "12%" }} />
          </div>
        ))}
      </div>
    );
  }
  return <div className="skeleton-block" aria-busy="true" aria-label={label} />;
}
