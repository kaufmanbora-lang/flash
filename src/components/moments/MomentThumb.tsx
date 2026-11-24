"use client";

import clsx from "clsx";
import { AlertTriangle, CloudUpload, Heart, Play, RotateCw, Trash2, WifiOff } from "lucide-react";
import { useState } from "react";
import { codeText } from "@/client/api";
import { haptic } from "@/client/haptics";
import { useT } from "@/client/i18n";
import type { DraftInfo } from "@/client/idb";
import { uploader } from "@/client/uploader";
import { Spinner } from "@/components/ui/Button";
import { Ring } from "@/components/ui/Feedback";
import { ConfirmSheet } from "@/components/ui/Sheet";
import { fmtClock } from "@/lib/format";
import type { MomentDto } from "@/lib/types";

const tile =
  "relative block overflow-hidden rounded-[22px] bg-lime-soft shadow-[0_12px_26px_-16px_rgb(32_48_30/0.5)] ring-1 ring-white/60";

/** Плитка момента: кадр, длительность, отметка избранного и состояние обработки. */
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
  const ready = moment.status === "ready";
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
        <span className="skeleton absolute inset-0 rounded-none" />
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

      {ready && (
        <span className="tabular absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/50 px-2 py-1 text-[12px] font-semibold leading-none text-white">
          <Play aria-hidden="true" size={10} fill="currentColor" strokeWidth={0} />
          {fmtClock(moment.durationMs)}
        </span>
      )}
      {moment.status === "processing" && (
        <span className="absolute inset-0 grid place-items-center bg-black/35 text-white">
          <span className="flex flex-col items-center gap-1.5 text-[12px] font-semibold">
            <Spinner size={22} />
            {t.moment.processing}
          </span>
        </span>
      )}
      {moment.status === "failed" && (
        <span className="absolute inset-0 grid place-items-center bg-black/45 p-2 text-center text-white">
          <span className="flex flex-col items-center gap-1.5 text-[12px] font-semibold leading-tight">
            <AlertTriangle aria-hidden="true" size={22} />
            {t.moment.failed}
          </span>
        </span>
      )}
    </button>
  );
}

/** Плитка момента, который ещё лежит на устройстве: прогресс загрузки, повтор, удаление. */
export function DraftTile({ draft, className }: { draft: DraftInfo; className?: string }) {
  const t = useT();
  const d = t.draft;
  const [confirm, setConfirm] = useState(false);
  const progress = draft.size > 0 ? draft.uploadedBytes / draft.size : 0;
  const failed = draft.state === "failed";
  const waiting = draft.state === "error";
  const label = failed
    ? codeText(t, draft.error)
    : waiting
      ? d.waitingNetwork
      : draft.state === "queued"
        ? d.queued
        : d.uploading;

  return (
    <div className={clsx(tile, "aspect-[4/5]", className)}>
      {draft.posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={draft.posterUrl} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
      ) : (
        <span className="skeleton absolute inset-0 rounded-none" />
      )}
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 p-2 text-center text-white">
        {failed ? (
          <AlertTriangle aria-hidden="true" size={24} />
        ) : waiting ? (
          <WifiOff aria-hidden="true" size={24} />
        ) : (
          <Ring value={progress} size={46} stroke={4} tone="dark" label={d.aria(Math.round(progress * 100))}>
            <CloudUpload aria-hidden="true" size={18} />
          </Ring>
        )}
        <span className="text-[11.5px] font-semibold leading-tight">{label}</span>
        {(failed || waiting) && (
          <span className="flex gap-1.5">
            {waiting && (
              <button type="button" aria-label={d.retry} onClick={() => void uploader.retry(draft.clientId)} className="grid size-9 place-items-center rounded-full bg-white/25">
                <RotateCw aria-hidden="true" size={16} />
              </button>
            )}
            <button type="button" aria-label={d.remove} onClick={() => setConfirm(true)} className="grid size-9 place-items-center rounded-full bg-white/25">
              <Trash2 aria-hidden="true" size={16} />
            </button>
          </span>
        )}
      </span>
      <ConfirmSheet
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          await uploader.remove(draft.clientId);
          setConfirm(false);
        }}
        title={d.removeTitle}
        message={d.removeText}
        confirmLabel={t.common.delete}
        danger
      />
    </div>
  );
}
