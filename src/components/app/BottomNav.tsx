"use client";

import clsx from "clsx";
import { motion } from "framer-motion";
import { CalendarDays, Clapperboard, Home, Plus, Settings, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { haptic } from "@/client/haptics";
import { useT } from "@/client/i18n";

interface Tab {
  href: string;
  label: string;
  icon: LucideIcon;
  match: (path: string) => boolean;
}

/** Плавающая стеклянная панель навигации: четыре раздела и выделенная кнопка записи по центру. */
export function BottomNav() {
  const t = useT();
  const pathname = usePathname() ?? "/";

  const tabs: Tab[] = [
    { href: "/", label: t.nav.home, icon: Home, match: (p) => p === "/" },
    { href: "/calendar", label: t.nav.calendar, icon: CalendarDays, match: (p) => p.startsWith("/calendar") },
    { href: "/films", label: t.nav.films, icon: Clapperboard, match: (p) => p.startsWith("/films") || p.startsWith("/projects") },
    { href: "/settings", label: t.nav.settings, icon: Settings, match: (p) => p.startsWith("/settings") },
  ];

  const renderTab = (tab: Tab) => {
    const active = tab.match(pathname);
    const Icon = tab.icon;
    return (
      <Link
        key={tab.href}
        href={tab.href}
        aria-current={active ? "page" : undefined}
        onClick={() => !active && haptic("light")}
        className={clsx(
          "relative z-[2] flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-[3px] rounded-[26px] transition-colors",
          active ? "text-ink" : "text-muted-strong",
        )}
      >
        {active && (
          <motion.span
            layoutId="nav-bubble"
            className="glass glass-tint absolute inset-x-0.5 inset-y-1.5 -z-[1] rounded-[24px]"
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
          />
        )}
        <Icon aria-hidden="true" size={23} strokeWidth={active ? 2.2 : 1.9} />
        {/* Размер подписи следует за шириной экрана: «Настройки» и «Календарь» помещаются целиком и на 320 px. */}
        <span className="max-w-full truncate text-[clamp(9.5px,2.95vw,11px)] font-semibold leading-none">{tab.label}</span>
      </Link>
    );
  };

  return (
    <nav
      aria-label={t.nav.aria}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-[max(env(safe-area-inset-bottom),12px)] min-[360px]:px-4"
    >
      <div className="glass glass-strong pointer-events-auto flex h-[74px] w-full max-w-[460px] items-stretch rounded-[37px] px-1.5 shadow-float">
        {tabs.slice(0, 2).map(renderTab)}

        <div className="relative z-[2] flex w-[76px] shrink-0 items-center justify-center">
          <Link
            href="/record"
            aria-label={t.nav.recordAria}
            onClick={() => haptic("medium")}
            className="press relative -mt-7 grid size-[68px] place-items-center rounded-full"
          >
            <span aria-hidden="true" className="absolute inset-0 animate-ring rounded-full border-2 border-leaf/60" />
            <span className="btn-lime grid size-full place-items-center rounded-full ring-4 ring-milk/90">
              <Plus aria-hidden="true" size={31} strokeWidth={2.4} />
            </span>
          </Link>
        </div>

        {tabs.slice(2).map(renderTab)}
      </div>
    </nav>
  );
}
