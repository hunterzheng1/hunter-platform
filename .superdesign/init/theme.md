# Theme and visual tokens

## Compact token summary

- Direction: dense dark product console, restrained indigo accent, no decorative 3D.
- Font: `Geist`, `Inter`, `PingFang SC`, `Microsoft YaHei`, `Noto Sans SC`, system sans-serif.
- Desktop shell: 240 px sticky sidebar; main content uses a bounded centered workspace.
- Dark surfaces: `--bg #08080f`, `--bg-raised #0e0e17`, `--panel #13131f`, `--panel-hover #1a1a2a`.
- Borders: `--line #21213a`, `--line-strong #2e2e4a`, `--line-dim #18182a`.
- Text: `--text #e0e0f0`, `--text-heading #f0f0ff`, `--muted #b0b0c6`, `--muted-dim #9292aa`.
- Accent: `--accent #829cff`, `--accent-strong #5c7cff`; semantic green `#4ade80`, amber `#fbbf24`, red `#f87171`, violet `#a78bfa`.
- Radii: 6, 10, 14, 18 px; compact cards primarily use 10–14 px.
- Shadows: subtle tinted elevation, from `0 1px 2px rgba(0,0,0,.4)` to `0 12px 40px rgba(0,0,0,.55)`.
- Motion: 120/200/350 ms; reduced-motion media query disables entrance motion.
- Responsive breakpoints relevant to dashboard: 1180, 840 and 720 px.
- Light theme maps the same tokens to white/blue-gray surfaces and `--accent #3e63d3`.

## Raw source locations

- Global tokens/reset/shell: `apps/web/app/globals.css:1:230`
- Existing dashboard rules: `apps/web/app/globals.css:3705:3945`
- Shared page module rules: `apps/web/app/globals.css:4679:4725`
- Shared component rules: `apps/web/app/ui-v4.css`
- Theme provider: `apps/web/lib/theme.tsx`

The design flow must pass these actual ranges as context rather than inventing token values.
