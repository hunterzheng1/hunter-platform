# Extractable components

## ClientLayout
- Source: `apps/web/components/client-layout.tsx`
- Category: layout
- Description: Persistent sidebar navigation and main content shell.
- Extractable props: `children`; active route is runtime-derived.
- Hardcoded: brand assets, navigation groups, icon names, settings trigger.

## DashboardMetric
- Source: inline pattern in `apps/web/components/console.tsx`
- Category: basic
- Description: Linked KPI card with semantic icon, value, label and destination hint.
- Extractable props: `label`, `value`, `href`, `icon`, optional `tone`.
- Hardcoded: card structure and interaction styling.

## DashboardPanelHeader
- Source: repeated pattern in `apps/web/components/console.tsx`
- Category: basic
- Description: Compact eyebrow/title header with optional action or status.
- Extractable props: `eyebrow`, `title`, `action`.

## Status
- Source: `apps/web/components/skill-shared.tsx`
- Category: basic
- Description: Localized semantic status badge.
- Extractable props: `value`.

No separate layout component needs extraction into Superdesign: `ClientLayout` is already small enough to pass as direct source context.
