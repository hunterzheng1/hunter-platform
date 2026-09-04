"use client";

import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import { Children, cloneElement, isValidElement, useId, useRef } from "react";

import { Skeleton } from "./ui/Skeleton";

export const PROJECT_WORKSPACE_SECTIONS = [
  "branchFiles",
  "materials",
  "knowledge",
  "apiKeys"
] as const;

export type ProjectWorkspaceSection = typeof PROJECT_WORKSPACE_SECTIONS[number];

export type ProjectWorkspaceLabels = Readonly<Record<ProjectWorkspaceSection, string>>;

export interface ProjectWorkspaceSlot {
  content: ReactNode;
  /** Keep stateful panels mounted after first activation. */
  keepMounted?: boolean;
}

export type ProjectWorkspaceSlots = Partial<Readonly<Record<ProjectWorkspaceSection, ProjectWorkspaceSlot>>>;

export type WorkspaceSurfaceState =
  | { kind: "ready" }
  | { kind: "loading"; label: string }
  | { kind: "empty" | "processing" | "forbidden" | "error"; title: string; description: string; technicalDetails?: readonly WorkspaceTechnicalDetail[] }
  | { kind: "partialFailure"; title: string; description: string; technicalDetails?: readonly WorkspaceTechnicalDetail[] };

export interface WorkspaceTechnicalDetail {
  label: string;
  value: string;
}

function tabId(prefix: string, section: ProjectWorkspaceSection): string {
  return `${prefix}-tab-${section}`;
}

function panelId(prefix: string, section: ProjectWorkspaceSection): string {
  return `${prefix}-panel-${section}`;
}

export function ProjectWorkspaceShell({
  activeSection,
  ariaLabel,
  labels,
  onSectionChange,
  slots,
  fallback
}: {
  activeSection: ProjectWorkspaceSection;
  ariaLabel: string;
  labels: ProjectWorkspaceLabels;
  onSectionChange: (section: ProjectWorkspaceSection) => void;
  slots: ProjectWorkspaceSlots;
  fallback: ReactNode;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const prefix = `project-workspace-${useId().replaceAll(":", "")}`;

  function selectFromKeyboard(event: KeyboardEvent<HTMLButtonElement>, current: ProjectWorkspaceSection): void {
    const currentIndex = PROJECT_WORKSPACE_SECTIONS.indexOf(current);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % PROJECT_WORKSPACE_SECTIONS.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + PROJECT_WORKSPACE_SECTIONS.length) % PROJECT_WORKSPACE_SECTIONS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = PROJECT_WORKSPACE_SECTIONS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = PROJECT_WORKSPACE_SECTIONS[nextIndex];
    if (next === undefined) return;
    onSectionChange(next);
    tabsRef.current?.querySelector<HTMLButtonElement>(`#${tabId(prefix, next)}`)?.focus();
  }

  return <div className="project-workspace-shell" data-slot="project-workspace-shell">
    <div ref={tabsRef} className="project-tabs" data-slot="project-workspace-navigation" role="tablist" aria-label={ariaLabel}>
      {PROJECT_WORKSPACE_SECTIONS.map((section) => <button
        id={tabId(prefix, section)}
        data-slot="project-workspace-tab"
        data-touch-target="true"
        key={section}
        type="button"
        role="tab"
        tabIndex={activeSection === section ? 0 : -1}
        aria-selected={activeSection === section}
        aria-controls={panelId(prefix, section)}
        className={activeSection === section ? "selected" : ""}
        onClick={() => onSectionChange(section)}
        onKeyDown={(event) => selectFromKeyboard(event, section)}
      >{labels[section]}</button>)}
    </div>

    <div className="project-workspace-panels" data-slot="project-workspace-panels">
      {PROJECT_WORKSPACE_SECTIONS.map((section) => {
        const slot = slots[section];
        const hidden = section !== activeSection;
        const content = slot === undefined
          ? fallback
          : (!hidden || slot.keepMounted === true ? slot.content : null);
        return <section
          id={panelId(prefix, section)}
          data-slot="project-workspace-panel"
          key={section}
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={tabId(prefix, section)}
          aria-hidden={hidden || undefined}
          hidden={hidden}
        >
          {content}
        </section>;
      })}
    </div>
  </div>;
}

export function WorkspaceFilterBar({
  label,
  query,
  placeholder,
  onQueryChange,
  children
}: {
  label: string;
  query: string;
  placeholder: string;
  onQueryChange: (query: string) => void;
  children?: ReactNode;
}) {
  return <div className="workspace-filter-bar" data-slot="workspace-filter-bar">
    <label className="workspace-filter-search" data-slot="workspace-filter-search">
      <span className="sr-only">{label}</span>
      <input
        type="search"
        data-touch-target="true"
        aria-label={label}
        placeholder={placeholder}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
    </label>
    {children === undefined ? null : <div className="workspace-filter-actions" data-slot="workspace-filter-actions">{
      Children.map(children, (child) => isValidElement(child)
        ? cloneElement(child as ReactElement<Record<string, unknown>>, { "data-touch-target": "true" })
        : child)
    }</div>}
  </div>;
}

function TechnicalDetails({ details, label }: { details: readonly WorkspaceTechnicalDetail[]; label: string }) {
  if (details.length === 0) return null;
  return <details className="workspace-technical-details" data-slot="workspace-technical-details">
    <summary data-touch-target="true">{label}</summary>
    <dl>
      {details.map((detail) => <div key={`${detail.label}:${detail.value}`}>
        <dt>{detail.label}</dt>
        <dd>{detail.value}</dd>
      </div>)}
    </dl>
  </details>;
}

export function WorkspaceState({
  state,
  children,
  technicalDetailsLabel
}: {
  state: WorkspaceSurfaceState;
  children?: ReactNode;
  technicalDetailsLabel: string;
}) {
  if (state.kind === "ready") return <>{children}</>;
  if (state.kind === "loading") {
    return <section className="workspace-state workspace-state-loading" data-slot="workspace-state" role="status" aria-busy="true" data-state="loading">
      <span>{state.label}</span>
      <Skeleton variant="text" lines={3} label={state.label} />
    </section>;
  }

  const role = state.kind === "forbidden" || state.kind === "error" ? "alert" : "status";
  return <section className={`workspace-state workspace-state-${state.kind}`} data-slot="workspace-state" role={role} data-state={state.kind}>
    <div className="workspace-state-copy">
      <h2>{state.title}</h2>
      <p>{state.description}</p>
      <TechnicalDetails details={state.technicalDetails ?? []} label={technicalDetailsLabel} />
    </div>
    {state.kind === "partialFailure" ? <div className="workspace-partial-content">{children}</div> : null}
  </section>;
}
