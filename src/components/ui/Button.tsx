"use client";

import clsx from "clsx";
import { motion, type HTMLMotionProps } from "framer-motion";
import { forwardRef, type ReactNode } from "react";
import { haptic } from "@/client/haptics";

type Variant = "primary" | "glass" | "ghost" | "danger" | "dark";
type Size = "lg" | "md" | "sm";

export interface ButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  block?: boolean;
  children?: ReactNode;
}

const SIZES: Record<Size, string> = {
  lg: "min-h-[58px] px-6 text-[17px] gap-2.5 rounded-full",
  md: "min-h-[50px] px-5 text-[16px] gap-2 rounded-full",
  sm: "min-h-[44px] px-4 text-[14.5px] gap-1.5 rounded-full",
};

const VARIANTS: Record<Variant, string> = {
  primary: "btn-lime font-semibold",
  glass: "glass font-semibold text-ink",
  ghost: "font-semibold text-leaf-deep hover:bg-lime-soft/60",
  danger: "bg-danger-soft font-semibold text-danger",
  dark: "glass-dark font-semibold",
};

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={clsx("animate-spin", className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, icon, block, className, children, disabled, onClick, type, ...rest },
  ref,
) {
  const inactive = disabled || loading;
  return (
    <motion.button
      ref={ref}
      type={type ?? "button"}
      disabled={inactive}
      aria-busy={loading || undefined}
      whileTap={inactive ? undefined : { scale: 0.965 }}
      transition={{ type: "spring", stiffness: 520, damping: 30 }}
      onClick={(event) => {
        haptic("light");
        onClick?.(event);
      }}
      className={clsx(
        "relative inline-flex select-none items-center justify-center whitespace-nowrap transition-opacity",
        SIZES[size],
        VARIANTS[variant],
        block && "w-full",
        inactive && variant !== "primary" && "opacity-50",
        className,
      )}
      {...rest}
    >
      {/* Обёртка не даёт иконке сжиматься, когда кнопке тесно. */}
      {(loading || icon) && <span className="inline-flex shrink-0">{loading ? <Spinner /> : icon}</span>}
      {children}
    </motion.button>
  );
});

export interface IconButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  label: string;
  children: ReactNode;
  tone?: "glass" | "dark" | "plain";
  size?: number;
}

/** Круглая кнопка-иконка 44×44 с обязательной подписью для экранных дикторов. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, tone = "glass", size = 46, className, onClick, disabled, ...rest },
  ref,
) {
  return (
    <motion.button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.92 }}
      transition={{ type: "spring", stiffness: 520, damping: 28 }}
      onClick={(event) => {
        haptic("light");
        onClick?.(event);
      }}
      style={{ width: size, height: size }}
      className={clsx(
        "relative grid shrink-0 place-items-center rounded-full",
        tone === "glass" && "glass text-ink",
        tone === "dark" && "glass-dark",
        tone === "plain" && "text-ink hover:bg-ink/5",
        disabled && "opacity-45",
        className,
      )}
      {...rest}
    >
      {children}
    </motion.button>
  );
});
