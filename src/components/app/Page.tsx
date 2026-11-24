"use client";

import clsx from "clsx";
import { motion } from "framer-motion";
import { ChevronLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useT } from "@/client/i18n";
import { IconButton } from "@/components/ui/Button";
import { Wordmark } from "./Wordmark";

/** Колонка контента: единая ширина, поля и отступы под вырез и навигацию. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={clsx("mx-auto w-full max-w-[640px] px-5 pt-safe pb-nav", className)}>{children}</main>;
}

/** Шапка раздела верхнего уровня: логотип слева, действия справа. */
export function BrandHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className="flex min-h-[56px] items-center justify-between gap-3 pb-2 pt-1">
      <Wordmark className="text-[42px]" />
      <div className="flex items-center gap-2.5">{actions}</div>
    </header>
  );
}

/** Шапка раздела с крупным заголовком. */
export function TitleHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="flex items-end justify-between gap-3 pb-4 pt-3">
      <div className="min-w-0">
        <h1 className="t-display">{title}</h1>
        {subtitle && <p className="mt-1 text-[15px] text-muted-strong">{subtitle}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2.5 pb-1">{actions}</div>
    </header>
  );
}

/** Шапка вложенного экрана: «назад», логотип по центру, действия справа. */
export function BackHeader({ actions, fallback = "/", title }: { actions?: ReactNode; fallback?: string; title?: string }) {
  const t = useT();
  const router = useRouter();
  const goBack = () => {
    // Экран могли открыть по прямой ссылке (из уведомления) — тогда возвращаться некуда.
    if (window.history.length > 1 && document.referrer.startsWith(window.location.origin)) router.back();
    else router.push(fallback);
  };
  return (
    <header className="grid min-h-[56px] grid-cols-[46px_1fr_auto] items-center gap-3 pb-2 pt-1">
      <IconButton label={t.common.back} onClick={goBack}>
        <ChevronLeft aria-hidden="true" size={24} strokeWidth={2.2} className="-ml-0.5" />
      </IconButton>
      <div className="flex justify-center">
        {title ? <span className="truncate text-[16px] font-semibold">{title}</span> : <Wordmark className="text-[36px]" />}
      </div>
      <div className="flex min-w-[46px] items-center justify-end gap-2">{actions}</div>
    </header>
  );
}

/** Секция, плавно появляющаяся при открытии экрана; delay задаёт очерёдность. */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: delay * 0.055, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.section>
  );
}
