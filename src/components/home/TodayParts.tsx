"use client";

import { motion } from "framer-motion";
import { Check, Clock3, Plus, Video } from "lucide-react";
import Link from "next/link";
import { haptic } from "@/client/haptics";
import { useT } from "@/client/i18n";
import { MomentThumb } from "@/components/moments/MomentThumb";
import { useToast } from "@/components/ui/Toast";
import { fmtClock } from "@/lib/format";
import type { MomentDto } from "@/lib/types";

/** Две плитки: сколько моментов записано сегодня (из трёх) и сколько это минут жизни. */
export function TodayStats({ count, limit, durationMs }: { count: number; limit: number; durationMs: number }) {
  const t = useT();
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="glass px-4 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-[15px] bg-lime-soft text-leaf-deep shadow-[inset_0_1px_0_rgb(255_255_255/0.9)]">
            <Video aria-hidden="true" size={21} strokeWidth={1.9} />
          </span>
          <p className="tabular flex min-w-0 items-baseline gap-1 leading-none">
            <span className="text-[32px] font-bold tracking-[-0.04em]">{count}</span>
            <span className="text-[15px] font-semibold text-muted-strong">/ {limit}</span>
          </p>
        </div>
        <p className="t-caption mt-2.5 leading-snug">{t.home.momentsToday}</p>
      </div>
      <div className="glass px-4 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-[15px] bg-lime-soft text-leaf-deep shadow-[inset_0_1px_0_rgb(255_255_255/0.9)]">
            <Clock3 aria-hidden="true" size={21} strokeWidth={1.9} />
          </span>
          <p className="tabular min-w-0 text-[32px] font-bold leading-none tracking-[-0.04em]">{fmtClock(durationMs)}</p>
        </div>
        <p className="t-caption mt-2.5 leading-snug">{t.home.lifeToday}</p>
      </div>
    </div>
  );
}

/** Главная кнопка экрана. Когда три момента уже записаны — спокойное состояние «на сегодня всё». */
export function RecordButton({ count, limit }: { count: number; limit: number }) {
  const t = useT();
  const toast = useToast();
  const full = count >= limit;

  if (full) {
    return (
      <button
        type="button"
        onClick={() => {
          haptic("light");
          toast(t.home.limitHint, "info");
        }}
        className="glass press flex min-h-[84px] w-full items-center justify-center gap-3.5 rounded-full px-6"
      >
        <span className="grid size-12 place-items-center rounded-full bg-lime-soft text-leaf-deep">
          <Check aria-hidden="true" size={24} strokeWidth={2.4} />
        </span>
        <span className="text-left">
          <span className="block text-[19px] font-semibold leading-tight tracking-[-0.02em]">{t.home.limitReached}</span>
          <span className="t-caption block">{t.home.limitShort(limit)}</span>
        </span>
      </button>
    );
  }

  return (
    <motion.div whileTap={{ scale: 0.975 }} transition={{ type: "spring", stiffness: 480, damping: 30 }}>
      <Link
        href="/record"
        onClick={() => haptic("medium")}
        className="btn-lime sheen flex min-h-[88px] w-full items-center justify-center gap-5 rounded-full px-6"
      >
        <span className="relative grid size-[62px] shrink-0 place-items-center">
          <span aria-hidden="true" className="absolute inset-0 animate-ring rounded-full border-2 border-white/80" />
          <span className="grid size-full animate-breathe place-items-center rounded-full bg-gradient-to-b from-leaf to-leaf-dark text-white shadow-[inset_0_2px_0_rgb(255_255_255/0.45),0_6px_14px_-4px_rgb(62_116_32/0.6)] ring-[3px] ring-white/60">
            <Video aria-hidden="true" size={26} strokeWidth={2} />
          </span>
        </span>
        <span aria-hidden="true" className="h-9 w-px bg-ink/15" />
        <span className="text-[22px] font-semibold tracking-[-0.025em]">{count === 0 ? t.home.record : t.home.recordMore}</span>
      </Link>
    </motion.div>
  );
}

/** Три слота сегодняшнего дня: записанные моменты и свободные места. */
export function TodaySlots({ moments, limit, onOpen }: { moments: MomentDto[]; limit: number; onOpen: (moment: MomentDto) => void }) {
  const t = useT();
  const free = Math.max(0, limit - moments.length);

  return (
    <div className="grid grid-cols-3 gap-3">
      {moments.map((moment, i) => (
        <motion.div
          key={moment.id}
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
        >
          <MomentThumb moment={moment} caption={moment.time} onClick={() => onOpen(moment)} className="w-full" />
        </motion.div>
      ))}
      {Array.from({ length: free }, (_, i) => (
        <Link
          key={`free-${i}`}
          href="/record"
          aria-label={t.home.emptySlotAria}
          onClick={() => haptic("light")}
          className="press grid aspect-[4/5] place-items-center rounded-[22px] border-2 border-dashed border-leaf/45 bg-white/35 text-leaf-deep"
        >
          <span className="flex flex-col items-center gap-1.5">
            <span className="grid size-10 place-items-center rounded-full bg-lime-soft">
              <Plus aria-hidden="true" size={20} strokeWidth={2.4} />
            </span>
            <span className="text-[12px] font-semibold text-muted-strong">{t.home.emptySlot}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}
