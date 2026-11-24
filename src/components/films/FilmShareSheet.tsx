"use client";

import { Download, Link2, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, errorText } from "@/client/api";
import { useLocale, useT } from "@/client/i18n";
import { canShareFiles, copyText, fetchAsFile, SHARE_FILE_LIMIT, shareFile, shareLink, startDownload } from "@/client/share";
import { Spinner } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { safeName } from "@/lib/names";
import { fmtBytes } from "@/lib/format";
import type { FilmDto } from "@/lib/types";
import { qualityLabel } from "./FilmCard";

type Stage = "idle" | "preparing" | "ready";

/** Три способа забрать фильм: системное «Поделиться» с файлом, скачивание, временная ссылка. */
export function FilmShareSheet({ film, open, onClose }: { film: FilmDto; open: boolean; onClose: () => void }) {
  const t = useT();
  const s = t.share;
  const toast = useToast();
  const { locale } = useLocale();
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [linkBusy, setLinkBusy] = useState(false);
  const fileRef = useRef<File | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const filename = `${safeName(film.title)}.mp4`;

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      fileRef.current = null;
      setStage("idle");
      setProgress(0);
    }
  }, [open, film.id]);

  const download = () => {
    if (!film.downloadUrl) return;
    startDownload(film.downloadUrl, filename);
    toast(s.started, "success");
    onClose();
  };

  const share = async () => {
    if (!film.videoUrl) return;
    if (!canShareFiles()) {
      toast(s.unsupported, "info");
      return;
    }
    if (film.sizeBytes > SHARE_FILE_LIMIT) {
      toast(s.tooBig, "info");
      return;
    }
    try {
      if (!fileRef.current) {
        setStage("preparing");
        const controller = new AbortController();
        abortRef.current = controller;
        fileRef.current = await fetchAsFile(film.videoUrl, filename, setProgress, controller.signal);
      }
      // Системное меню открывается только сразу после нажатия. Если файл готовился долго,
      // браузер откажет — тогда кнопка превращается в «Отправить», и хватит второго нажатия.
      const result = await shareFile(fileRef.current, film.title);
      if (result === "shared") onClose();
      else if (result === "needs-gesture" || result === "cancelled") setStage("ready");
      else {
        setStage("idle");
        toast(s.unsupported, "info");
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") toast(s.failed, "error");
      setStage("idle");
    }
  };

  const link = async () => {
    setLinkBusy(true);
    try {
      const res = await api<{ url: string; days: number }>(`/api/films/${film.id}/link`, { method: "POST", body: {} });
      const absolute = new URL(res.url, window.location.origin).toString();
      const shared = await shareLink(absolute, film.title);
      if (shared === "unsupported") {
        if (await copyText(absolute)) toast(s.linkCopied, "success");
        else toast(s.failed, "error");
      }
      if (shared !== "cancelled") onClose();
    } catch (err) {
      toast(errorText(t, err), "error");
    } finally {
      setLinkBusy(false);
    }
  };

  const row = "glass press flex min-h-[72px] w-full items-center gap-3.5 px-4 text-left disabled:opacity-50";
  const iconBox = "grid size-11 shrink-0 place-items-center rounded-full bg-lime-soft text-leaf-deep";

  return (
    <Sheet open={open} onClose={onClose} title={s.title}>
      <div className="flex flex-col gap-3 pb-2">
        <button type="button" className={row} onClick={() => void share()} disabled={stage === "preparing"} aria-busy={stage === "preparing"}>
          <span className={iconBox}>{stage === "preparing" ? <Spinner size={20} /> : <Send aria-hidden="true" size={20} />}</span>
          <span className="min-w-0">
            <span className="block text-[16.5px] font-semibold leading-tight">
              {stage === "preparing" ? s.preparing(Math.round(progress * 100)) : stage === "ready" ? s.ready : s.share}
            </span>
            <span className="t-caption mt-0.5 block">{s.shareHint}</span>
          </span>
        </button>

        <button type="button" className={row} onClick={download}>
          <span className={iconBox}>
            <Download aria-hidden="true" size={20} />
          </span>
          <span className="min-w-0">
            <span className="block text-[16.5px] font-semibold leading-tight">{s.download}</span>
            <span className="t-caption mt-0.5 block">{s.downloadHint(qualityLabel(film), fmtBytes(film.sizeBytes, t.fmt.bytes, locale))}</span>
          </span>
        </button>

        <button type="button" className={row} onClick={() => void link()} disabled={linkBusy} aria-busy={linkBusy}>
          <span className={iconBox}>{linkBusy ? <Spinner size={20} /> : <Link2 aria-hidden="true" size={20} />}</span>
          <span className="min-w-0">
            <span className="block text-[16.5px] font-semibold leading-tight">{s.link}</span>
            <span className="t-caption mt-0.5 block">{s.linkHint(7)}</span>
          </span>
        </button>
      </div>
    </Sheet>
  );
}
