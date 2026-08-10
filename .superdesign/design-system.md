# Hunter Platform dashboard design system

## Product context

Hunter Platform is a governance console for projects managed by Hunter Harness. The overview must answer, in order: whether the platform needs attention, what projects and runs are active, how much governed knowledge/version data exists, and what changed recently.

## Visual direction

- Keep the existing dark product-console identity and 240 px sidebar.
- Use the existing Geist/CJK font stack and existing CSS variables only.
- Indigo is the interaction/accent color. Green means completed/healthy, amber means needs attention, red means failed/unavailable, violet identifies skills/knowledge.
- Favor compact, data-dense cards with quiet borders. Avoid glassmorphism, decorative gradients, oversized headings, 3D, heavy animation and redundant charts.
- The dashboard should normally fit within two 1080p screens at desktop widths. Target roughly 1,350–1,650 px of content height below the app shell.

## Information architecture

1. Compact page summary: title, data freshness, one overall status and one recommended next action.
2. One KPI strip for important counts: projects, active/current work, knowledge/version assets, pending attention. Each card links to the relevant page.
3. Primary analysis row: seven-day proposal trend plus a compact operational/governance summary. Do not use a chart without a decision purpose.
4. Work row: recent projects and recent activity. Lists show at most 4–6 rows by default; extra items are accessible through a link or internal compact scroll area.
5. Secondary registry/health information is summarized rather than occupying three full-height columns.

## Layout rules

- Desktop content uses 12-column mental grid; major analytical content gets 7–8 columns, supporting content 4–5.
- Panel padding 14–18 px, row height 38–50 px, vertical gaps 12–16 px.
- Activity must never grow with all server results. Show a bounded recent subset and a clear count/time scope.
- At 1180 px, collapse to two columns; at 840/720 px, use a single column without horizontal overflow.

## Copy rules

- Chinese is the primary visible language. Use plain terms such as「待处理」「运行正常」「近期活动」「项目版本」.
- Avoid exposing internal codes, IDs and hashes in primary text. IDs may appear only as subdued secondary metadata when no readable name exists.
- State what a number means and its time range. Empty states distinguish no data from loading or failure.

## Motion and accessibility

- Retain the existing subtle rise-in transition, maximum 200 ms, and honor reduced motion.
- All links and controls need visible focus states, semantic headings and readable status text in addition to color.
