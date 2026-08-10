# Page dependency trees

## `/` — dashboard overview

Entry: `apps/web/app/page.tsx`

- `apps/web/components/console.tsx` (`DashboardConsole`, `TrendChart`, `DistributionChart`)
  - `apps/web/lib/api.ts`
  - `apps/web/lib/i18n.tsx`
  - `apps/web/lib/mock-api.ts`
  - `apps/web/components/skill-shared.tsx` (`Status`, `apiError`)
  - `apps/web/components/ui/icons.tsx`
  - `apps/web/components/ui/Skeleton.tsx`
- `apps/web/app/layout.tsx`
  - `apps/web/components/client-layout.tsx`
    - `apps/web/components/settings-panel.tsx`
    - `apps/web/components/ui/icons.tsx`
    - `apps/web/components/ui/Toast.tsx`
    - `apps/web/lib/i18n.tsx`
    - `apps/web/lib/theme.tsx`
  - `apps/web/app/globals.css`
  - `apps/web/app/ui-v4.css`

## `/projects`

- `apps/web/app/projects/page.tsx`
  - `apps/web/components/project-registry.tsx`
  - shared layout, API, i18n and UI primitives

## `/projects/[id]`

- `apps/web/app/projects/[id]/page.tsx`
  - `apps/web/components/project-workspace.tsx`
  - `apps/web/components/runs-monitor.tsx`
  - `apps/web/components/project-semantic-panels.tsx`
  - `apps/web/components/project-api-keys.tsx`

## `/knowledge`

- `apps/web/app/knowledge/page.tsx`
  - `apps/web/components/knowledge-center.tsx`
  - shared layout, API, i18n and UI primitives

## `/workflows`, `/skills`, `/ai-config`

Each entry imports its feature component plus the same `ClientLayout`, API, i18n, theme, icon and shared UI layers. The dashboard redesign must not alter their shell contract.
