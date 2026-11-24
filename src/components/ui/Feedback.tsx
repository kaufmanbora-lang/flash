"use client";

import clsx from "clsx";
import { motion } from "framer-motion";
import { CloudOff, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "@/client/i18n";
import { Button } from "./Button";

/** Полоса прогресса с плавным заполнением. */
export function ProgressBar({ value, label, className }: { value: number; label: string; className?: string }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={clsx("h-3 w-full overflow-hidden rounded-full bg-ink/8 shadow-[inset_0_1px_2px_rgb(32_48_30/0.08)]", className)}
    >
      <motion.div
        className="h-full origin-left rounded-full bg-gradient-to-r from-leaf to-lime shadow-[inset_0_1px_0_rgb(255_255_255/0.6)]"
        initial={{ scaleX: 0 }}
        animate={{ scaleX: pct / 100 }}
        transition={{ type: "spring", stiffness: 90, damping: 22 }}
        style={{ width: "100%" }}
      />
    </div>
  );
}

/** Круговой индикатор прогресса. */
export function Ring({
  value,
  size = 56,
  stroke = 5,
  label,
  children,
  tone = "light",
}: {
  value: number;
  size?: number;
  stroke?: number;
  label: string;
  children?: ReactNode;
  tone?: "light" | "dark";
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(1, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct * 100)}
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className={tone === "light" ? "stroke-ink/10" : "stroke-white/25"} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          className={tone === "light" ? "stroke-leaf" : "stroke-lime"}
          strokeDasharray={c}
          initial={false}
          animate={{ strokeDashoffset: c * (1 - pct) }}
          transition={{ type: "spring", stiffness: 80, damping: 20 }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={clsx("skeleton", className)} />;
}

/** Пустое состояние: объясняет, что здесь появится, и предлагает действие. */
export function EmptyState({
  icon,
  title,
  text,
  action,
  className,
}: {
  icon: ReactNode;
  title: string;
  text?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className={clsx("glass flex flex-col items-center px-6 py-9 text-center", className)}
    >
      <span className="mb-4 grid size-16 place-items-center rounded-full bg-lime-soft text-leaf-deep shadow-[inset_0_1px_0_rgb(255_255_255/0.9)]">
        {icon}
      </span>
      <h3 className="t-section">{title}</h3>
      {text && <p className="mt-1.5 max-w-[32ch] text-[15px] leading-snug text-muted-strong">{text}</p>}
      {action && <div className="mt-5">{action}</div>}
    </motion.div>
  );
}

/** Ошибка загрузки с понятной причиной и кнопкой повтора. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <EmptyState
      icon={<CloudOff aria-hidden="true" size={26} strokeWidth={1.8} />}
      title={t.common.loadFailed}
      text={message}
      action={
        <Button variant="glass" size="sm" icon={<RefreshCw aria-hidden="true" size={16} />} onClick={onRetry}>
          {t.common.retry}
        </Button>
      }
    />
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex min-h-[32px] items-center justify-between gap-3 px-1">
      <h2 className="t-section">{children}</h2>
      {action}
    </div>
  );
}

/** Плашка состояния: «Проект завершён», «На паузе» и т. п. */
export function Badge({ children, tone = "lime", icon }: { children: ReactNode; tone?: "lime" | "muted" | "danger" | "dark"; icon?: ReactNode }) {
  return (
    <span
      className={clsx(
        "inline-flex min-h-[28px] items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold",
        tone === "lime" && "bg-lime-soft text-leaf-deep",
        tone === "muted" && "bg-ink/7 text-muted-strong",
        tone === "danger" && "bg-danger-soft text-danger",
        tone === "dark" && "bg-black/35 text-white backdrop-blur-md",
      )}
    >
      {icon}
      {children}
    </span>
  );
}
