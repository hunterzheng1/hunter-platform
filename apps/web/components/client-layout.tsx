"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { I18nProvider, useI18n } from "../lib/i18n";
import { ThemeProvider, useTheme } from "../lib/theme";
import { SettingsPanel } from "./settings-panel";
import { Icon, type IconName } from "./ui/icons";
import { ToastProvider } from "./ui/Toast";

interface NavItem {
  href: string;
  icon: IconName;
  labelKey: "overview" | "projects" | "knowledge" | "runs" | "workflows" | "skills" | "aiConfig";
}

interface NavGroup {
  sectionKey: "sectionWorkspace" | "sectionRegistry" | "sectionGovernance" | "sectionSystem";
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    sectionKey: "sectionWorkspace",
    items: [
      { href: "/", icon: "overview", labelKey: "overview" },
      { href: "/runs", icon: "activity", labelKey: "runs" }
    ]
  },
  {
    sectionKey: "sectionRegistry",
    items: [
      { href: "/projects", icon: "folder", labelKey: "projects" },
      { href: "/skills", icon: "sparkles", labelKey: "skills" },
      { href: "/knowledge", icon: "brain", labelKey: "knowledge" }
    ]
  },
  {
    sectionKey: "sectionGovernance",
    items: [
      { href: "/workflows", icon: "workflow", labelKey: "workflows" }
    ]
  },
  {
    sectionKey: "sectionSystem",
    items: [
      { href: "/ai-config", icon: "settings", labelKey: "aiConfig" }
    ]
  }
];

function Sidebar() {
  const { t } = useI18n();
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();

  function isActive(href: string) {
    if (href === "/") return pathname === href;
    return pathname.startsWith(href);
  }

  return (
    <aside>
      <Link className="brand" href="/">
        <img
          className="brand-logo"
          src={theme === "dark" ? "/logo-dark-mark.png" : "/logo-light-mark.png"}
          alt="Hunter Harness"
        />
        <span className="brand-copy">
          <strong>{t.brand}</strong>
          <small>{t.brandSub}</small>
        </span>
      </Link>
      <nav>
        {NAV_GROUPS.map((group) => (
          <div className="nav-group" key={group.sectionKey}>
            <p className="nav-section">{t.nav[group.sectionKey]}</p>
            {group.items.map((item) => (
              <Link
                href={item.href}
                className={isActive(item.href) ? "active" : ""}
                key={item.href}
              >
                <Icon name={item.icon} size={15} />
                <span>{t.nav[item.labelKey]}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <SettingsPanel theme={theme} setTheme={setTheme} />
    </aside>
  );
}

export function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <ClientLayoutInner>{children}</ClientLayoutInner>
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

function ClientLayoutInner({ children }: { children: React.ReactNode }) {
  const { lang, t } = useI18n();
  const demo = process.env.NEXT_PUBLIC_HUNTER_HARNESS_DEMO === "true";

  return (
    <div className="shell">
      <Sidebar />
      <main key={lang}>
        {demo ? <div className="demo-banner">{t.demoBanner}</div> : null}
        {children}
      </main>
    </div>
  );
}
