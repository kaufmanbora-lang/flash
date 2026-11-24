"use client";

import clsx from "clsx";
import { AnimatePresence, motion, useDragControls } from "framer-motion";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/client/i18n";
import { Button, IconButton } from "./Button";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  /** Кнопки, закреплённые внизу шторки. */
  footer?: ReactNode;
  /** Запретить закрытие смахиванием и тапом по фону (идёт важная операция). */
  locked?: boolean;
  tall?: boolean;
}

let openSheets = 0;

/** Нижняя шторка: выезжает снизу, закрывается смахиванием за «ручку», тапом по фону или Escape. */
export function Sheet({ open, onClose, title, description, children, footer, locked, tall }: SheetProps) {
  const t = useT();
  const controls = useDragControls();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    openSheets++;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !locked) onClose();
    };
    window.addEventListener("keydown", onKey);
    const raf = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      openSheets = Math.max(0, openSheets - 1);
      if (openSheets === 0) document.body.style.overflow = "";
      previous?.focus?.({ preventScroll: true });
    };
  }, [open, locked, onClose]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center">
          <motion.div
            aria-hidden="true"
            className="absolute inset-0 bg-ink/30 backdrop-blur-[5px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.18 } }}
            transition={{ duration: 0.26 }}
            onClick={() => !locked && onClose()}
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-label={title ? undefined : t.common.more}
            tabIndex={-1}
            className={clsx(
              "glass glass-strong relative flex w-full max-w-[640px] flex-col rounded-b-none rounded-t-[32px] shadow-float outline-none",
              tall ? "max-h-[94dvh] min-h-[70dvh]" : "max-h-[92dvh]",
            )}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%", transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } }}
            transition={{ type: "spring", stiffness: 380, damping: 38, mass: 0.9 }}
            drag={locked ? false : "y"}
            dragControls={controls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.7 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 110 || info.velocity.y > 650) onClose();
            }}
          >
            <div
              className="flex shrink-0 touch-none cursor-grab justify-center pb-1 pt-2.5 active:cursor-grabbing"
              onPointerDown={(e) => !locked && controls.start(e)}
            >
              <span className="h-1.5 w-10 rounded-full bg-ink/15" />
            </div>
            {(title || !locked) && (
              <div className="flex shrink-0 items-start gap-3 px-5 pb-2 pt-1">
                <div className="min-w-0 flex-1">
                  {title && (
                    <h2 id={titleId} className="t-title">
                      {title}
                    </h2>
                  )}
                  {description && <p className="t-caption mt-1 text-[14px]">{description}</p>}
                </div>
                {!locked && (
                  <IconButton label={t.common.close} tone="plain" size={40} onClick={onClose} className="-mr-2 -mt-1">
                    <X size={20} strokeWidth={2.2} />
                  </IconButton>
                )}
              </div>
            )}
            <div className={clsx("min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-1", footer ? "pb-4" : "pb-safe")}>
              {children}
              {!footer && <div className="h-3" />}
            </div>
            {footer && <div className="shrink-0 border-t border-line px-5 pb-safe pt-3.5">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

interface ConfirmProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  message?: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  children?: ReactNode;
}

/** Подтверждение необратимого действия. */
export function ConfirmSheet({ open, onClose, onConfirm, title, message, confirmLabel, danger, busy, children }: ConfirmProps) {
  const t = useT();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      description={message}
      locked={busy}
      footer={
        <div className="flex gap-3">
          <Button variant="glass" block onClick={onClose} disabled={busy}>
            {t.common.cancel}
          </Button>
          <Button variant={danger ? "danger" : "primary"} block loading={busy} onClick={() => void onConfirm()}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {children}
    </Sheet>
  );
}
