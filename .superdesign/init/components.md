# Shared UI primitives

Framework: React 19 + Next.js App Router. The project uses custom React primitives and vanilla CSS; it is not a shadcn project.

## `apps/web/components/ui/Skeleton.tsx`

Loading placeholder used by the dashboard.

```tsx
"use client";

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
    return <div className="skeleton-text" aria-busy="true" aria-label={label}>
      {Array.from({ length: lines }, (_, index) => <span key={index} style={{ width: `${index === lines - 1 ? 45 : 88 - (index % 3) * 12}%` }} />)}
    </div>;
  }
  if (variant === "metric") {
    return <div className="skeleton-metric" aria-busy="true" aria-label={label}>
      <span className="skeleton-metric-icon" />
      <span className="skeleton-metric-value" />
      <span className="skeleton-metric-label" />
    </div>;
  }
  if (variant === "table") {
    return <div className="skeleton-table" aria-busy="true" aria-label={label}>
      {Array.from({ length: lines }, (_, index) => <div className="skeleton-table-row" key={index}>
        <span style={{ width: "28%" }} /><span style={{ width: "18%" }} />
        <span style={{ width: "34%" }} /><span style={{ width: "12%" }} />
      </div>)}
    </div>;
  }
  return <div className="skeleton-block" aria-busy="true" aria-label={label} />;
}
```

## `apps/web/components/ui/icons.tsx`

Semantic wrapper around Lucide icons. Dashboard uses `folder`, `workflow`, `sparkles`, and `activity`.

```tsx
"use client";

import {
  Activity, ArrowLeft, Bot, Boxes, Brain, Check, ChevronLeft, ChevronRight,
  ChevronsLeft, ChevronsRight, CircleAlert, CircleCheck, CircleX, Clock,
  Copy, Database, Download, Eye, EyeOff, FileText, FolderGit2, Gauge,
  GripVertical, Inbox, Info, Layers, LayoutDashboard, ListChecks, Loader2,
  Package, Pencil, Play, Plus, RefreshCw, Search, Settings, ShieldCheck,
  Sparkles, Tag, Trash2, Upload, Workflow, X, Zap, type LucideIcon
} from "lucide-react";

export type IconName =
  | "activity" | "agent" | "back" | "box" | "brain" | "check" | "chevron-left" | "chevron-right"
  | "chevrons-left" | "chevrons-right" | "clock" | "close" | "copy" | "database" | "download"
  | "edit" | "error" | "eye" | "eye-off" | "file" | "folder" | "gauge" | "grip" | "inbox" | "info"
  | "layers" | "loading" | "overview" | "package" | "play" | "plus" | "refresh" | "search"
  | "settings" | "shield" | "sparkles" | "success" | "tag" | "tasks" | "trash" | "upload"
  | "warning" | "workflow" | "zap";

const ICONS: Record<IconName, LucideIcon> = {
  activity: Activity, agent: Bot, back: ArrowLeft, box: Boxes, brain: Brain,
  check: Check, "chevron-left": ChevronLeft, "chevron-right": ChevronRight,
  "chevrons-left": ChevronsLeft, "chevrons-right": ChevronsRight, clock: Clock,
  close: X, copy: Copy, database: Database, download: Download, edit: Pencil,
  error: CircleX, eye: Eye, "eye-off": EyeOff, file: FileText, folder: FolderGit2,
  gauge: Gauge, grip: GripVertical, inbox: Inbox, info: Info, layers: Layers,
  loading: Loader2, overview: LayoutDashboard, package: Package, play: Play,
  plus: Plus, refresh: RefreshCw, search: Search, settings: Settings,
  shield: ShieldCheck, sparkles: Sparkles, success: CircleCheck, tag: Tag,
  tasks: ListChecks, trash: Trash2, upload: Upload, warning: CircleAlert,
  workflow: Workflow, zap: Zap
};

export function Icon({ name, size = 16, className, strokeWidth = 1.8 }: {
  name: IconName; size?: number; className?: string; strokeWidth?: number;
}) {
  const Glyph = ICONS[name];
  return <Glyph size={size} strokeWidth={strokeWidth}
    className={className === undefined ? "icon" : `icon ${className}`} aria-hidden="true" />;
}
```

## Shared status badge

Source: `apps/web/components/skill-shared.tsx`

```tsx
function Status({ value }: { value: string }) {
  const { t } = useI18n();
  const key = value.replaceAll("_", "-");
  const labels = t.status as Record<string, string>;
  const label = labels[value] ?? labels[key] ?? value.replaceAll("_", " ");
  return <span className={`status status-${key}`}>{label}</span>;
}
```
