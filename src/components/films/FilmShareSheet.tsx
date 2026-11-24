"use client";

import { Download, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocale, useT } from "@/client/i18n";
import { canShareFiles, shareFile, startDownload, storedFile } from "@/client/share";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { fmtBytes } from "@/lib/format";
import type { FilmDto } from "@/lib/types";
import { blobKey } from "@/local/store";
import { formatLabel, qualityLabel } from "./FilmCard";

/** Два способа забрать фильм: системное «Поделиться» с файлом и сохранение на устройство. */
export function FilmShareSheet({ film, open, onClose }: { film: FilmDto; open: boolean; onClose: () => void }) {
  const t = useT();
  const s = t.share;
  const toast = useToast();
  const { locale } = useLocale();
  const [again, setAgain] = useState(false);
  const fileRef = useRef<File | null>(null);

  // Файл готовится заранее: системное меню открывается только сразу после нажатия.
  useEffect(() => {
    fileRef.current = null;
    setAgain(false);
    if (!open) return;
    let alive = true;
    void storedFile(blobKey.filmVideo(film.id), film.fileName, film.mime).then((file) => {
      if (alive) fileRef.current = file;
    });
    return () => {
      alive = false;
    };
  }, [open, film.id, film.fileName, film.mime]);

  const download = () => {
    if (!film.downloadUrl) return;
    startDownload(film.downloadUrl, film.fileName);
    toast(s.started, "success");
    onClose();
  };

  const share = async () => {
    if (!canShareFiles()) {
      toast(s.unsupported, "info");
      return;
    }
    const file = fileRef.current ?? (await storedFile(blobKey.filmVideo(film.id), film.fileName, film.mime));
    if (!file) {
      toast(s.failed, "error");
      return;
    }
    fileRef.current = file;
    const result = await shareFile(file, film.title);
    if (result === "shared") onClose();
    else if (result === "needs-gesture") setAgain(true);
    else if (result === "unsupported") toast(s.unsupported, "info");
  };

  const row = "glass press flex min-h-[72px] w-full items-center gap-3.5 px-4 text-left disabled:opacity-50";
  const iconBox = "grid size-11 shrink-0 place-items-center rounded-full bg-lime-soft text-leaf-deep";

  return (
    <Sheet open={open} onClose={onClose} title={s.title}>
      <div className="flex flex-col gap-3 pb-2">
        <button type="button" className={row} onClick={() => void share()}>
          <span className={iconBox}>
            <Send aria-hidden="true" size={20} />
          </span>
          <span className="min-w-0">
            <span className="block text-[16.5px] font-semibold leading-tight">{again ? s.ready : s.share}</span>
            <span className="t-caption mt-0.5 block">{s.shareHint}</span>
          </span>
        </button>

        <button type="button" className={row} onClick={download}>
          <span className={iconBox}>
            <Download aria-hidden="true" size={20} />
          </span>
          <span className="min-w-0">
            <span className="block text-[16.5px] font-semibold leading-tight">{s.download}</span>
            <span className="t-caption mt-0.5 block">{s.downloadHint(formatLabel(film), qualityLabel(film), fmtBytes(film.sizeBytes, t.fmt.bytes, locale))}</span>
          </span>
        </button>
      </div>
    </Sheet>
  );
}
