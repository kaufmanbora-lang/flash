"use client";

import clsx from "clsx";
import { Heart, Play, Video } from "lucide-react";
import { haptic } from "@/client/haptics";
import { useT } from "@/client/i18n";
import { fmtClock } from "@/lib/format";
import type { MomentDto } from "@/lib/types";

const tile =
  "relative block overflow-hidden rounded-[22px] bg-lime-soft shadow-[0_12px_26px_-16px_rgb(32_48_30/0.5)] ring-1 ring-white/60";

/** Плитка момента: кадр, длительность и отметка избранного. */
export function MomentThumb({
  moment,
  onClick,
  caption,
  className,
}: {
  moment: MomentDto;
  onClick?: () => void;
  /** Подпись в углу (время или дата). */
  caption?: string;
  className?: string;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => {
        haptic("light");
        onClick?.();
      }}
      aria-label={t.moment.openAria(caption ?? moment.time, fmtClock(moment.durationMs))}
      className={clsx(tile, "press aspect-[4/5]", className)}
    >
      {moment.posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={moment.posterUrl} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 size-full object-cover" />
      ) : (
        <span aria-hidden="true" className="absolute inset-0 grid place-items-center bg-gradient-to-br from-lime-soft to-lime/70 text-leaf-deep/60">
          <Video size={26} strokeWidth={1.7} />
        </span>
      )}
      <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/55 to-transparent" />

      {caption && (
        <span className="absolute left-2 top-2 rounded-full bg-black/45 px-2 py-1 text-[11.5px] font-semibold leading-none text-white">
          {caption}
        </span>
      )}
      {/* Сердечко — в нижнем углу: наверху оно сталкивалось бы с длинной подписью-датой. */}
      {moment.favorite && (
        <span className="absolute bottom-2 right-2 grid size-[26px] place-items-center rounded-full bg-black/50 text-white">
          <Heart aria-hidden="true" size={14} fill="currentColor" strokeWidth={0} />
          <span className="sr-only">{t.moment.favorite}</span>
        </span>
      )}

      <span className="tabular absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/50 px-2 py-1 text-[12px] font-semibold leading-none text-white">
        <Play aria-hidden="true" size={10} fill="currentColor" strokeWidth={0} />
        {fmtClock(moment.durationMs)}
      </span>
    </button>
  );
}
