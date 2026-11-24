"use client";

import clsx from "clsx";
import { motion } from "framer-motion";
import { Check, Minus, Plus } from "lucide-react";
import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { haptic } from "@/client/haptics";

// ── Переключатель ────────────────────────────────────────────

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        haptic("light");
        onChange(!checked);
      }}
      className={clsx(
        "relative h-[32px] w-[54px] shrink-0 rounded-full transition-colors duration-300",
        checked ? "bg-leaf" : "bg-ink/15",
        disabled && "opacity-45",
      )}
    >
      <motion.span
        className="absolute left-[3px] top-[3px] block size-[26px] rounded-full bg-white shadow-[0_2px_6px_rgb(32_48_30/0.25)]"
        animate={{ x: checked ? 22 : 0 }}
        transition={{ type: "spring", stiffness: 520, damping: 34 }}
      />
    </button>
  );
}

// ── Сегменты ─────────────────────────────────────────────────

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string }[];
  label: string;
  size?: "md" | "sm";
}) {
  const id = useId();
  return (
    <div role="tablist" aria-label={label} className="glass flex w-full gap-1 rounded-full p-1">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              if (!active) haptic("light");
              onChange(opt.value);
            }}
            className={clsx(
              "relative z-[2] flex-1 rounded-full px-3 font-semibold transition-colors",
              size === "md" ? "min-h-[44px] text-[15px]" : "min-h-[38px] text-[13.5px]",
              active ? "text-ink" : "text-muted-strong",
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="btn-lime absolute inset-0 -z-[1] rounded-full"
                transition={{ type: "spring", stiffness: 460, damping: 36 }}
              />
            )}
            <span className="relative">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Чип выбора ───────────────────────────────────────────────

export function Chip({
  selected,
  onClick,
  children,
  icon,
  tone = "light",
  disabled,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  icon?: ReactNode;
  tone?: "light" | "dark";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => {
        haptic("light");
        onClick();
      }}
      className={clsx(
        "press inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[14px] font-semibold",
        tone === "light" && (selected ? "btn-lime" : "glass text-muted-strong"),
        tone === "dark" && (selected ? "bg-lime text-ink" : "glass-dark text-white/90"),
        disabled && "opacity-45",
      )}
    >
      {selected ? <Check aria-hidden="true" size={15} strokeWidth={2.6} /> : icon}
      {children}
    </button>
  );
}

// ── Счётчик ──────────────────────────────────────────────────

export function Stepper({
  value,
  onChange,
  min,
  max,
  labelMinus,
  labelPlus,
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  labelMinus: string;
  labelPlus: string;
}) {
  const btn = "grid size-11 place-items-center rounded-full text-ink disabled:opacity-30";
  return (
    <div className="glass flex items-center gap-1 rounded-full p-1">
      <button type="button" aria-label={labelMinus} disabled={value <= min} className={btn} onClick={() => { haptic("light"); onChange(Math.max(min, value - 1)); }}>
        <Minus aria-hidden="true" size={18} strokeWidth={2.4} />
      </button>
      <span aria-live="polite" className="tabular w-7 text-center text-[17px] font-semibold">
        {value}
      </span>
      <button type="button" aria-label={labelPlus} disabled={value >= max} className={btn} onClick={() => { haptic("light"); onChange(Math.min(max, value + 1)); }}>
        <Plus aria-hidden="true" size={18} strokeWidth={2.4} />
      </button>
    </div>
  );
}

// ── Поля ввода ───────────────────────────────────────────────

const fieldBase =
  "w-full rounded-[18px] bg-white/80 px-4 text-ink placeholder:text-muted shadow-[inset_0_0_0_1px_rgb(32_48_30/0.1)] outline-none transition-shadow focus:shadow-[inset_0_0_0_2px_var(--color-leaf)]";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | null;
  trailing?: ReactNode;
}

export function Field({ label, hint, error, trailing, className, id, ...rest }: FieldProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  const describedBy = error ? `${fieldId}-err` : hint ? `${fieldId}-hint` : undefined;
  return (
    <div className={className}>
      <label htmlFor={fieldId} className="mb-1.5 block text-[13.5px] font-semibold text-muted-strong">
        {label}
      </label>
      <div className="relative">
        <input
          id={fieldId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={clsx(fieldBase, "min-h-[52px]", trailing && "pr-12", error && "shadow-[inset_0_0_0_2px_var(--color-danger)]")}
          {...rest}
        />
        {trailing && <div className="absolute inset-y-0 right-1.5 flex items-center">{trailing}</div>}
      </div>
      {error ? (
        <p id={`${fieldId}-err`} role="alert" className="mt-1.5 text-[13.5px] font-medium text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${fieldId}-hint`} className="t-caption mt-1.5">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
  tone?: "light" | "dark";
}

export function TextArea({ label, hint, tone = "light", className, id, ...rest }: TextAreaProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <div className={className}>
      <label
        htmlFor={fieldId}
        className={clsx("mb-1.5 block text-[13.5px] font-semibold", tone === "light" ? "text-muted-strong" : "text-white/80")}
      >
        {label}
      </label>
      <textarea
        id={fieldId}
        aria-describedby={hint ? `${fieldId}-hint` : undefined}
        className={clsx(
          "min-h-[84px] resize-none py-3 leading-snug",
          tone === "light"
            ? fieldBase
            : "w-full rounded-[18px] bg-white/14 px-4 text-white placeholder:text-white/55 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.2)] outline-none backdrop-blur-xl focus:shadow-[inset_0_0_0_2px_var(--color-lime)]",
        )}
        {...rest}
      />
      {hint && (
        <p id={`${fieldId}-hint`} className={clsx("mt-1.5 text-[13px]", tone === "light" ? "text-muted-strong" : "text-white/70")}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** Строка настроек: подпись слева, элемент управления справа. */
export function Row({
  title,
  hint,
  children,
  icon,
  onClick,
}: {
  title: string;
  hint?: string;
  children?: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      {icon && <span className="grid size-10 shrink-0 place-items-center rounded-full bg-lime-soft text-leaf-deep">{icon}</span>}
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-[16px] font-medium leading-snug">{title}</span>
        {hint && <span className="t-caption mt-0.5 block">{hint}</span>}
      </span>
      {children && <span className="shrink-0">{children}</span>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="press flex min-h-[60px] w-full items-center gap-3 px-4 py-3">
        {body}
      </button>
    );
  }
  return <div className="flex min-h-[60px] items-center gap-3 px-4 py-3">{body}</div>;
}
