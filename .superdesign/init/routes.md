# Routes

Next.js App Router; every route uses `apps/web/app/layout.tsx` and `ClientLayout`.

| URL | Entry | Main component |
| --- | --- | --- |
| `/` | `apps/web/app/page.tsx` | `DashboardConsole` |
| `/projects` | `apps/web/app/projects/page.tsx` | Project registry |
| `/projects/[id]` | `apps/web/app/projects/[id]/page.tsx` | Project workspace |
| `/knowledge` | `apps/web/app/knowledge/page.tsx` | Cross-project knowledge search |
| `/workflows` | `apps/web/app/workflows/page.tsx` | Workflow families |
| `/skills` | `apps/web/app/skills/page.tsx` | Skill registry |
| `/skills/[id]` | `apps/web/app/skills/[id]/page.tsx` | Skill detail |
| `/external-skills/[id]` | `apps/web/app/external-skills/[id]/page.tsx` | External skill detail |
| `/ai-config` | `apps/web/app/ai-config/page.tsx` | AI provider settings |
| `/login` | `apps/web/app/login/page.tsx` | Sign-in form |

Dashboard entry source:

```tsx
"use client";
import { DashboardConsole } from "../components/console";
export default function DashboardPage() { return <DashboardConsole />; }
```
