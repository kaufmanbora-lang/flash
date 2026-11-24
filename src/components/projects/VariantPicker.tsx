"use client";

import clsx from "clsx";
import { motion } from "framer-motion";
import { Check, Clapperboard, Film, Layers, Lock, MonitorPlay, type LucideIcon } from "lucide-react";
import { haptic } from "@/client/haptics";
import { useT } from "@/client/i18n";
import { isRendering } from "@/components/films/FilmCard";
import { Ring } from "@/components/ui/Feedback";
import type { ProjectVariant } from "@/lib/constants";
import type { VariantInfo } from "@/lib/types";

const ICONS: Record<ProjectVariant, LucideIcon> = {
  trailer: Clapperboard,
  mini: Film,
  extended: Layers,
  full: MonitorPlay,
};

/** Выбор версии фильма проекта: трейлер, мини-фильм, расширенный, полный. */
export function VariantPicker({
  variants,
  selected,
  onSelect,
}: {
  variants: VariantInfo[];
  selected: ProjectVariant;
  onSelect: (variant: ProjectVariant) => void;
}) {
  const t = useT();
  const pp = t.projectPage;
  return (
    <div role="radiogroup" aria-label={pp.formats} className="grid grid-cols-2 gap-3">
      {variants.map((info, i) => {
        const Icon = ICONS[info.variant];
        const active = info.variant === selected;
        const film = info.film;
        const rendering = !!film && isRendering(film);
        const ready = !!film?.hasFile;
        let sub: string;
        if (rendering) sub = `${t.films.status.rendering} · ${Math.round((film?.progress ?? 0) * 100)}%`;
        else if (ready && film) sub = t.fmt.duration(film.durationMs);
        else if (!info.available) sub = info.variant === "full" ? pp.needMoments : pp.variantLocked(t.fmt.duration(info.needSec * 1000));
        else if (info.variant === "full") sub = `≈ ${t.fmt.duration(info.estimateSec * 1000)}`;
        else sub = pp.variantApprox[info.variant];

        return (
          <motion.button
            key={info.variant}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => {
              haptic("light");
              onSelect(info.variant);
            }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            whileTap={{ scale: 0.97 }}
            transition={{ duration: 0.35, delay: i * 0.04, ease: [0.22, 1, 0.36, 1] }}
            className={clsx("glass relative flex min-h-[104px] flex-col items-start justify-between p-4 text-left", active && "glass-tint", !info.available && "opacity-70")}
          >
            <span className="flex w-full items-start justify-between">
              <Icon aria-hidden="true" size={26} strokeWidth={1.7} className={active ? "text-leaf-deep" : "text-ink"} />
              {rendering ? (
                <Ring value={film?.progress ?? 0} size={26} stroke={3.5} label={t.films.renderingAria(Math.round((film?.progress ?? 0) * 100))} />
              ) : active ? (
                <span className="grid size-6 place-items-center rounded-full bg-leaf text-white">
                  <Check aria-hidden="true" size={14} strokeWidth={3} />
                </span>
              ) : !info.available ? (
                <Lock aria-hidden="true" size={16} className="text-muted" />
              ) : ready ? (
                <span className="size-2.5 rounded-full bg-leaf" aria-hidden="true" />
              ) : null}
            </span>
            <span>
              <span className="block text-[16.5px] font-semibold leading-tight tracking-[-0.015em]">{t.film.variants[info.variant]}</span>
              <span className={clsx("mt-0.5 block text-[13px] leading-tight", active ? "text-leaf-deep" : "text-muted-strong")}>{sub}</span>
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}
