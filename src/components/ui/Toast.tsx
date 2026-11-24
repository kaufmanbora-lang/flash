"use client";

import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Check, Info } from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { haptic } from "@/client/haptics";

type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

type ToastFn = (message: string, kind?: ToastKind) => void;

const ToastContext = createContext<ToastFn>(() => {});

/** Короткое сообщение о результате действия. Само исчезает и не забирает фокус. */
export function useToast(): ToastFn {
  return useContext(ToastContext);
}

const ICONS = { success: Check, error: AlertCircle, info: Info } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const push = useCallback<ToastFn>((message, kind = "info") => {
    const id = ++counter.current;
    setItems((list) => [...list.slice(-2), { id, message, kind }]);
    if (kind === "error") haptic("warning");
    else if (kind === "success") haptic("success");
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), kind === "error" ? 5200 : 3400);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        role="status"
        className="pointer-events-none fixed inset-x-0 top-0 z-[120] flex flex-col items-center gap-2 px-4 pt-safe"
      >
        <AnimatePresence initial={false}>
          {items.map((item) => {
            const Icon = ICONS[item.kind];
            return (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, y: -18, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -12, scale: 0.96, transition: { duration: 0.16 } }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className="glass glass-strong pointer-events-auto flex max-w-[min(92vw,420px)] items-start gap-2.5 rounded-[22px] px-4 py-3 text-[15px] leading-snug font-medium shadow-float"
              >
                <span
                  className={`mt-px grid size-6 shrink-0 place-items-center rounded-full ${
                    item.kind === "error" ? "bg-danger-soft text-danger" : "bg-lime-soft text-leaf-deep"
                  }`}
                >
                  <Icon aria-hidden="true" size={15} strokeWidth={2.4} />
                </span>
                <span>{item.message}</span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
