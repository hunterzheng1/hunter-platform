"use client";

import {
  Activity,
  ArrowLeft,
  Bot,
  Boxes,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  Database,
  Download,
  Eye,
  EyeOff,
  FileText,
  FolderGit2,
  Gauge,
  GripVertical,
  Inbox,
  Info,
  Layers,
  LayoutDashboard,
  ListChecks,
  Loader2,
  Package,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  Workflow,
  X,
  Zap,
  type LucideIcon
} from "lucide-react";

/** 全站统一图标。name 语义化，避免各页面散落内联 SVG / Unicode 符号。 */
export type IconName =
  | "activity" | "agent" | "back" | "box" | "brain" | "check" | "chevron-left" | "chevron-right"
  | "chevrons-left" | "chevrons-right" | "clock" | "close" | "copy" | "database" | "download"
  | "edit" | "error" | "eye" | "eye-off" | "file" | "folder" | "gauge" | "grip" | "inbox" | "info"
  | "layers" | "loading" | "overview" | "package" | "play" | "plus" | "refresh" | "search"
  | "settings" | "shield" | "sparkles" | "success" | "tag" | "tasks" | "trash" | "upload"
  | "warning" | "workflow" | "zap";

const ICONS: Record<IconName, LucideIcon> = {
  activity: Activity,
  agent: Bot,
  back: ArrowLeft,
  box: Boxes,
  brain: Brain,
  check: Check,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevrons-left": ChevronsLeft,
  "chevrons-right": ChevronsRight,
  clock: Clock,
  close: X,
  copy: Copy,
  database: Database,
  download: Download,
  edit: Pencil,
  error: CircleX,
  eye: Eye,
  "eye-off": EyeOff,
  file: FileText,
  folder: FolderGit2,
  gauge: Gauge,
  grip: GripVertical,
  inbox: Inbox,
  info: Info,
  layers: Layers,
  loading: Loader2,
  overview: LayoutDashboard,
  package: Package,
  play: Play,
  plus: Plus,
  refresh: RefreshCw,
  search: Search,
  settings: Settings,
  shield: ShieldCheck,
  sparkles: Sparkles,
  success: CircleCheck,
  tag: Tag,
  tasks: ListChecks,
  trash: Trash2,
  upload: Upload,
  warning: CircleAlert,
  workflow: Workflow,
  zap: Zap
};

export function Icon({
  name,
  size = 16,
  className,
  strokeWidth = 1.8
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      className={className === undefined ? "icon" : `icon ${className}`}
      aria-hidden="true"
    />
  );
}
