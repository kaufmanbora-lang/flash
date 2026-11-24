"use client";

import { Download, Send } from "lucide-react";
import type { ReactNode } from "react";
import { useLocale, useT } from "@/client/i18n";
import { startDownload } from "@/client/share";
import { formatLabel, qualityLabel } from "@/components/films/FilmCard";
import { useToast } from "@/components/ui/Toast";
import { fmtBytes } from "@/lib/format";
import type { FilmDto } from "@/lib/types";

function Tile({ icon, title, hint, onClick }: { icon: ReactNode; title: string; hint: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="glass press flex min-h-[112px] flex-col items-start justify-between gap-3 p-4 text-left">
      <span className="grid size-10 place-items-center rounded-[14px] bg-lime-soft text-leaf-deep shadow-[inset_0_1px_0_rgb(255_255_255/0.9)]">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[16px] font-semibold leading-tight">{title}</span>
        <span className="t-caption mt-1 block text-[12px] leading-snug">{hint}</span>
      </span>
    </button>
  );
}

/** Две плитки под плеером: сохранить файл и поделиться. Подпись стоит под заголовком и не обрезается. */
export function FilmActionTiles({ film, onShare }: { film: FilmDto; onShare: () => void }) {
  const t = useT();
  const toast = useToast();
  const { locale } = useLocale();
  return (
    <div className="grid grid-cols-2 gap-3">
      <Tile
        icon={<Download aria-hidden="true" size={20} strokeWidth={2} />}
        title={t.share.download}
        hint={t.share.downloadHint(formatLabel(film), qualityLabel(film), fmtBytes(film.sizeBytes, t.fmt.bytes, locale))}
        onClick={() => {
          if (!film.downloadUrl) return;
          startDownload(film.downloadUrl, film.fileName);
          toast(t.share.started, "success");
        }}
      />
      <Tile icon={<Send aria-hidden="true" size={19} strokeWidth={2} />} title={t.share.share} hint={t.share.shareShort} onClick={onShare} />
    </div>
  );
}
