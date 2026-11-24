"use client";

import clsx from "clsx";
import { motion } from "framer-motion";
import { AlertTriangle, Check, Clapperboard, Play, RefreshCw, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { ApiError, codeText, fetcher } from "@/client/api";
import { haptic } from "@/client/haptics";
import { useQueryParam } from "@/client/hooks";
import { useT } from "@/client/i18n";
import { filmHref } from "@/components/films/FilmCard";
import { Button, IconButton } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/Feedback";
import { ConfirmSheet } from "@/components/ui/Sheet";
import type { FilmDto } from "@/lib/types";
import { RenderAborted, renderFilm, renderSupported, type RenderProgress } from "@/local/render/engine";

type Phase = "loading" | "running" | "done" | "error" | "unsupported";

/**
 * «Премьера»: фильм собирается прямо на устройстве, а зритель видит кадры, которые сейчас монтируются.
 * Экран открывается на весь экран, как запись: пока идёт сборка, приложение лучше не закрывать.
 */
export default function RenderPage() {
  const t = useT();
  const r = t.render;
  const router = useRouter();
  const filmId = useQueryParam("film");
  const { data } = useSWR<{ film: FilmDto }>(filmId ? `/api/films/${filmId}` : null, fetcher);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [aspect, setAspect] = useState<[number, number]>([9, 16]);

  const film = data?.film;
  const done = phase === "done";

  const start = useCallback(async () => {
    if (!filmId) return;
    if (!renderSupported()) {
      setPhase("unsupported");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("running");
    setErrorCode(null);
    setProgress(null);
    try {
      const outcome = await renderFilm(filmId, {
        canvas: canvasRef.current,
        signal: controller.signal,
        onProgress: (p) => {
          setProgress(p);
          const canvas = canvasRef.current;
          if (canvas && canvas.width > 2) setAspect((prev) => (prev[0] === canvas.width && prev[1] === canvas.height ? prev : [canvas.width, canvas.height]));
        },
      });
      setWarnings(outcome.warnings);
      setSkipped(outcome.skipped);
      haptic("success");
      setPhase("done");
    } catch (err) {
      if (err instanceof RenderAborted) return;
      setErrorCode(err instanceof ApiError ? err.code : "render_failed");
      setPhase(err instanceof ApiError && err.code === "render_unsupported" ? "unsupported" : "error");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [filmId]);

  // Сборка начинается сама, как только известен фильм. Небольшая задержка — чтобы повторный запуск эффекта
  // (строгий режим React в разработке) не начал её дважды.
  useEffect(() => {
    if (!film || startedRef.current) return;
    if (film.status === "ready" && !film.stale && !film.error) {
      // Собирать нечего: фильм уже готов (например, сюда вернулись кнопкой «назад»).
      router.replace(filmHref(film.id));
      return;
    }
    const timer = setTimeout(() => {
      startedRef.current = true;
      void start();
    }, 80);
    return () => clearTimeout(timer);
  }, [film, router, start]);

  // Уход с экрана прерывает сборку: фильм вернётся в очередь и его можно будет собрать позже.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (phase !== "running") return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  const leave = () => {
    if (filmId && film) router.replace(filmHref(filmId));
    else router.replace("/films");
  };

  const cancel = () => {
    setConfirmCancel(false);
    abortRef.current?.abort();
    leave();
  };

  const pct = Math.round((progress?.progress ?? 0) * 100);
  const stage = progress ? r.stages[progress.stage] : r.stages.prepare;
  const eta = progress?.etaSec != null && phase === "running" ? r.eta(Math.max(1, Math.round(progress.etaSec))) : null;
  const missing = filmId === null;

  return (
    <main className="fixed inset-0 z-[70] flex flex-col bg-[#0B100A] text-white">
      <header className="flex items-center justify-between gap-3 px-4 pb-2 pt-[max(env(safe-area-inset-top),12px)]">
        <IconButton
          label={phase === "running" ? r.cancel : t.common.close}
          tone="dark"
          onClick={() => (phase === "running" ? setConfirmCancel(true) : leave())}
        >
          <X aria-hidden="true" size={22} />
        </IconButton>
        <p className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold text-white/85">{film?.title ?? ""}</p>
        <span aria-hidden="true" className="size-[46px]" />
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-5 py-3">
        {/* Монтаж идёт на этом же canvas: зритель видит кадры, которые сейчас собираются. */}
        <div
          className={clsx(
            "relative max-h-full max-w-full overflow-hidden rounded-[26px] bg-black shadow-[0_30px_70px_-30px_rgb(0_0_0/0.9)] ring-1 ring-white/10",
            (phase === "error" || phase === "unsupported" || missing) && "opacity-25",
          )}
          style={{ aspectRatio: `${aspect[0]} / ${aspect[1]}`, height: aspect[1] >= aspect[0] ? "100%" : undefined, width: aspect[1] >= aspect[0] ? undefined : "100%" }}
        >
          <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 size-full" />
          {phase === "loading" && (
            <span className="absolute inset-0 grid place-items-center text-white/50">
              <Clapperboard aria-hidden="true" size={40} strokeWidth={1.5} className="animate-breathe" />
            </span>
          )}
          {done && (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 grid place-items-center bg-black/45">
              <span className="grid size-20 place-items-center rounded-full bg-lime text-leaf-deep shadow-lime">
                <Check aria-hidden="true" size={38} strokeWidth={2.4} />
              </span>
            </motion.span>
          )}
        </div>

        {(phase === "error" || phase === "unsupported" || missing) && (
          <div role="alert" className="absolute inset-x-8 mx-auto max-w-[360px] text-center">
            <span className="mx-auto mb-4 grid size-16 place-items-center rounded-full bg-white/12 text-white">
              <AlertTriangle aria-hidden="true" size={28} />
            </span>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">
              {missing ? t.films.notFound : phase === "unsupported" ? r.unsupportedTitle : r.failedTitle}
            </h1>
            <p className="mt-2 text-[15px] leading-snug text-white/75">
              {missing ? "" : phase === "unsupported" ? r.unsupportedText : codeText(t, errorCode)}
            </p>
          </div>
        )}
      </div>

      <footer className="px-6 pb-[max(env(safe-area-inset-bottom),20px)] pt-3">
        <div className="mx-auto w-full max-w-[440px]">
          {(phase === "running" || phase === "loading") && (
            <div role="status" aria-live="polite">
              <div className="flex items-baseline justify-between">
                <p className="text-[19px] font-semibold tracking-[-0.015em]">{stage}</p>
                <p className="tabular text-[19px] font-bold text-lime">{pct}%</p>
              </div>
              <ProgressBar value={pct} label={r.aria(pct)} className="mt-3" />
              <p className="mt-3 min-h-[20px] text-[14px] text-white/65">{eta ?? r.hint}</p>
              {eta && <p className="mt-1 text-[13px] leading-snug text-white/45">{r.hint}</p>}
            </div>
          )}

          {done && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <h1 className="text-center text-[24px] font-semibold tracking-[-0.02em]">{r.done}</h1>
              {(warnings.length > 0 || skipped > 0) && (
                <ul className="mt-3 flex flex-col gap-1.5 text-center text-[13.5px] leading-snug text-white/70">
                  {warnings.includes("no_music") && <li>{r.warnings.no_music}</li>}
                  {warnings.includes("no_audio") && <li>{r.warnings.no_audio}</li>}
                  {skipped > 0 && <li>{r.warnings.skipped(skipped)}</li>}
                </ul>
              )}
              <Button size="lg" block className="mt-5" icon={<Play aria-hidden="true" size={20} fill="currentColor" strokeWidth={0} />} onClick={leave}>
                {r.watch}
              </Button>
            </motion.div>
          )}

          {(phase === "error" || phase === "unsupported" || missing) && (
            <div className="flex flex-col gap-3">
              {phase === "error" && (
                <Button
                  size="lg"
                  block
                  icon={<RefreshCw aria-hidden="true" size={19} />}
                  onClick={() => {
                    startedRef.current = true;
                    void start();
                  }}
                >
                  {t.common.retry}
                </Button>
              )}
              <Button size="lg" variant="dark" block onClick={leave}>
                {t.common.back}
              </Button>
            </div>
          )}
        </div>
      </footer>

      <ConfirmSheet
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={cancel}
        title={r.cancelTitle}
        message={r.cancelText}
        confirmLabel={r.cancelConfirm}
        danger
      />
    </main>
  );
}
