"use client";

import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { CameraOff, Check, Images, MicOff, RefreshCw, SwitchCamera, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import useSWR from "swr";
import { api, fetcher } from "@/client/api";
import { haptic } from "@/client/haptics";
import { useDrafts, useHome, useToday } from "@/client/hooks";
import { useLocale, useT } from "@/client/i18n";
import { clearChunks, freeSpaceBytes, isQuotaError, putChunk } from "@/client/idb";
import { isIos } from "@/client/pwa";
import { newClientId, uploader } from "@/client/uploader";
import {
  cameraAvailability,
  classifyCameraError,
  openCamera,
  pickRecorderMime,
  readVideoMeta,
  stopStream,
  type CameraFailure,
} from "@/client/video";
import { AmbientBackground } from "@/components/app/AmbientBackground";
import { VideoPlayer } from "@/components/player/VideoPlayer";
import { Button, IconButton, Spinner } from "@/components/ui/Button";
import { Chip, TextArea } from "@/components/ui/Controls";
import { Ring } from "@/components/ui/Feedback";
import { ConfirmSheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { MAX_MOMENTS_PER_DAY, MIN_MOMENT_MS, NOTE_MAX } from "@/lib/constants";
import { deviceHm, deviceYmd } from "@/lib/dates";
import { fmtClock, fmtDayMonth } from "@/lib/format";
import type { DaySummary, ProjectDto } from "@/lib/types";

type Facing = "user" | "environment";
type Phase = "starting" | "ready" | "recording" | "finishing" | "review" | "error" | "limit";

interface Recorded {
  blob: Blob;
  mime: string;
  durationMs: number;
  width: number;
  height: number;
  poster: Blob | null;
  source: "camera" | "upload";
  recordedAt: Date;
  url: string;
  session: string | null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export default function RecordPage() {
  const t = useT();
  const r = t.record;
  const toast = useToast();
  const router = useRouter();
  const today = useToday();
  const { locale } = useLocale();
  const drafts = useDrafts();
  const { data: home, error: homeError } = useHome();
  const { data: projectsData } = useSWR<{ projects: ProjectDto[] }>(`/api/projects?status=open&today=${today}`, fetcher);

  const liveRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sessionRef = useRef("");
  const seqRef = useRef(0);
  const startRef = useRef(0);
  const elapsedRef = useRef(0);
  const recordedAtRef = useRef(new Date());
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeRef = useRef<WakeLockSentinel | null>(null);
  const phaseRef = useRef<Phase>("starting");
  const facingRef = useRef<Facing>("environment");
  const minReachedRef = useRef(false);
  const finalizingRef = useRef(false);
  const aliveRef = useRef(true);
  const initRef = useRef(false);
  const cameraRequestRef = useRef(0);
  const urlRef = useRef<string | null>(null);
  const finalizeRef = useRef<() => Promise<void>>(async () => {});

  const [phase, setPhaseState] = useState<Phase>("starting");
  const [facing, setFacing] = useState<Facing>("environment");
  const [failure, setFailure] = useState<CameraFailure>("unknown");
  const [elapsed, setElapsed] = useState(0);
  const [hasAudio, setHasAudio] = useState(true);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [note, setNote] = useState("");
  const [when, setWhen] = useState<Date>(new Date());
  const [selected, setSelected] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const todayPending = drafts.filter((d) => d.localDate === today && d.state !== "failed").length;
  const todayCount = (home?.today.count ?? 0) + todayPending;
  const limit = home?.today.limit ?? MAX_MOMENTS_PER_DAY;

  // День, к которому относится запись: для съёмки — сегодня, для видео из галереи — выбранная дата.
  // В проект момент попадает, только если этот день входит в период проекта.
  const captureDay = recorded?.source === "upload" ? deviceYmd(when) : today;
  const projects = (projectsData?.projects ?? []).filter((p) => {
    const end = p.progress.expectedEnd ?? p.endDate;
    return p.status === "active" && captureDay >= p.startDate && (!end || captureDay <= end);
  });
  // По умолчанию момент попадает во все активные проекты. Пока пользователь сам не трогал выбор
  // (selected === null), он считается от свежего списка: иначе проект, снятый с паузы, остался бы
  // невыбранным из-за списка, показанного из кэша.
  const activeIds = projects.map((p) => p.id);
  const chosen = (selected ?? activeIds).filter((id) => activeIds.includes(id));

  const releaseWake = useCallback(() => {
    void wakeRef.current?.release().catch(() => {});
    wakeRef.current = null;
  }, []);

  const stopCamera = useCallback(() => {
    stopStream(streamRef.current);
    streamRef.current = null;
    if (liveRef.current) liveRef.current.srcObject = null;
  }, []);

  const finishRecorder = useCallback(() => {
    if (phaseRef.current !== "recording") return;
    setPhase("finishing");
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    const rec = recorderRef.current;
    try {
      if (rec && rec.state !== "inactive") rec.stop();
      else void finalizeRef.current();
    } catch {
      void finalizeRef.current();
    }
    // Страховка: если событие остановки так и не пришло, собираем файл сами.
    setTimeout(() => {
      if (phaseRef.current === "finishing") void finalizeRef.current();
    }, 2500);
  }, [setPhase]);

  const startCamera = useCallback(
    async (wanted: Facing) => {
      // Номер запроса: если, пока камера открывалась, её запросили заново или экран закрыли,
      // «опоздавший» поток сразу гасится — иначе камера осталась бы включённой без присмотра.
      const request = ++cameraRequestRef.current;
      setPhase("starting");
      stopCamera();
      const unavailable = cameraAvailability();
      if (unavailable) {
        setFailure(unavailable);
        setPhase("error");
        return;
      }
      try {
        const stream = await openCamera(wanted);
        if (!aliveRef.current || request !== cameraRequestRef.current) {
          stopStream(stream);
          return;
        }
        streamRef.current = stream;
        facingRef.current = wanted;
        setFacing(wanted);
        setHasAudio(stream.getAudioTracks().length > 0);
        // Система может забрать камеру (звонок, другое приложение): аккуратно завершаем запись.
        stream.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (phaseRef.current === "recording") finishRecorder();
          else if (phaseRef.current === "ready") {
            setFailure("busy");
            setPhase("error");
          }
        });
        const video = liveRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
        }
        setPhase("ready");
      } catch (err) {
        if (!aliveRef.current || request !== cameraRequestRef.current) return;
        setFailure(classifyCameraError(err));
        setPhase("error");
      }
    },
    [finishRecorder, setPhase, stopCamera],
  );

  const showReview = useCallback(
    (next: Recorded) => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = next.url;
      setRecorded(next);
      setWhen(next.recordedAt);
      setPhase("review");
    },
    [setPhase],
  );

  /** Запись остановлена: собираем файл из кусков и показываем предпросмотр. */
  const finalize = useCallback(async () => {
    if (finalizingRef.current) return;
    finalizingRef.current = true;
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    releaseWake();
    const session = sessionRef.current;
    const durationMs = Math.round(elapsedRef.current);
    const type = (recorderRef.current?.mimeType || "video/mp4").split(";")[0] || "video/mp4";
    const blob = new Blob(chunksRef.current, { type });
    recorderRef.current = null;
    chunksRef.current = [];
    stopCamera();
    try {
      if (!aliveRef.current) return;
      if (durationMs < MIN_MOMENT_MS || blob.size === 0) {
        toast(r.interruptedShort, "info");
        await clearChunks(session).catch(() => {});
        void startCamera(facingRef.current);
        return;
      }
      const meta = await readVideoMeta(blob, durationMs);
      if (!aliveRef.current) return;
      showReview({
        blob,
        mime: type,
        durationMs,
        width: meta.width,
        height: meta.height,
        poster: meta.poster,
        source: "camera",
        recordedAt: recordedAtRef.current,
        url: URL.createObjectURL(blob),
        session,
      });
    } finally {
      finalizingRef.current = false;
    }
  }, [r.interruptedShort, releaseWake, showReview, startCamera, stopCamera, toast]);
  finalizeRef.current = finalize;

  const startRecording = useCallback(async () => {
    const stream = streamRef.current;
    if (!stream || phaseRef.current !== "ready") return;
    const mime = pickRecorderMime();
    let recorder: MediaRecorder;
    try {
      // Хорошее качество без агрессивного сжатия: 8 Мбит/с видео, 128 кбит/с звук.
      recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 128_000,
      });
    } catch {
      try {
        recorder = new MediaRecorder(stream);
      } catch {
        setFailure("unsupported");
        setPhase("error");
        return;
      }
    }
    const session = newClientId();
    sessionRef.current = session;
    chunksRef.current = [];
    seqRef.current = 0;
    minReachedRef.current = false;
    elapsedRef.current = 0;
    recordedAtRef.current = new Date();
    const startedAt = recordedAtRef.current.getTime();
    const cam = facingRef.current;

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      chunksRef.current.push(event.data);
      // Каждый кусок сразу ложится в IndexedDB: если приложение закроют, запись не пропадёт.
      void putChunk({
        session,
        seq: seqRef.current++,
        blob: event.data,
        mime: (recorder.mimeType || mime || "video/mp4").split(";")[0],
        startedAt,
        facing: cam,
        elapsedMs: Math.round(performance.now() - startRef.current),
      }).catch(() => {});
    };
    recorder.onstop = () => void finalize();
    recorder.onerror = () => {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        void finalize();
      }
    };

    recorder.start(1000);
    recorderRef.current = recorder;
    startRef.current = performance.now();
    setElapsed(0);
    setPhase("recording");
    haptic("medium");
    tickRef.current = setInterval(() => {
      const ms = performance.now() - startRef.current;
      elapsedRef.current = ms;
      setElapsed(ms);
      if (ms >= MIN_MOMENT_MS && !minReachedRef.current) {
        minReachedRef.current = true;
        haptic("success");
      }
    }, 100);
    try {
      wakeRef.current = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      /* экран может погаснуть — не критично */
    }
  }, [finalize, setPhase]);

  const stopRecording = useCallback(() => {
    if (phaseRef.current !== "recording") return;
    if (elapsedRef.current < MIN_MOMENT_MS) {
      haptic("warning");
      toast(r.minHint, "info");
      return;
    }
    haptic("medium");
    finishRecorder();
  }, [finishRecorder, r.minHint, toast]);

  // Первый запуск: если на сегодня лимит исчерпан — показываем это, иначе включаем камеру.
  useEffect(() => {
    if (initRef.current || (!home && !homeError)) return;
    initRef.current = true;
    if (todayCount >= limit) setPhase("limit");
    else void startCamera("environment");
    void freeSpaceBytes().then((free) => {
      if (free !== null && free < 300 * 1024 * 1024) toast(r.lowSpace, "info");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home, homeError]);

  useEffect(() => {
    aliveRef.current = true;
    const onVisibility = () => {
      // Свернули приложение во время записи: система остановит камеру, сохраняем то, что есть.
      if (document.visibilityState === "hidden" && phaseRef.current === "recording") finishRecorder();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      aliveRef.current = false;
      // Запрос камеры, который ещё в пути, больше не действителен; при повторном запуске эффектов
      // (строгий режим React в разработке) камера откроется заново, а не останется «мёртвой».
      cameraRequestRef.current++;
      initRef.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      if (tickRef.current) clearInterval(tickRef.current);
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
      } catch {
        /* уже остановлена */
      }
      stopStream(streamRef.current);
      streamRef.current = null;
      void wakeRef.current?.release().catch(() => {});
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [finishRecorder]);

  const flip = () => {
    if (phase !== "ready") return;
    void startCamera(facing === "user" ? "environment" : "user");
  };

  const onPick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.type && !file.type.startsWith("video/")) {
      toast(t.errors.unsupported_type, "error");
      return;
    }
    const meta = await readVideoMeta(file);
    if (meta.durationMs > 0 && meta.durationMs < MIN_MOMENT_MS) {
      toast(r.tooShortFile, "error");
      return;
    }
    stopCamera();
    const modified = file.lastModified ? new Date(file.lastModified) : new Date();
    showReview({
      blob: file,
      mime: file.type || "video/mp4",
      durationMs: meta.durationMs,
      width: meta.width,
      height: meta.height,
      poster: meta.poster,
      source: "upload",
      recordedAt: modified > new Date() ? new Date() : modified,
      url: URL.createObjectURL(file),
      session: null,
    });
  };

  const resetAfterReview = async () => {
    const session = recorded?.session;
    if (session) await clearChunks(session).catch(() => {});
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setRecorded(null);
    setNote("");
  };

  const retake = async () => {
    await resetAfterReview();
    if (todayCount >= limit) setPhase("limit");
    else void startCamera(facingRef.current);
  };

  const discard = async () => {
    setConfirmDiscard(false);
    await resetAfterReview();
    router.replace("/");
  };

  const save = async () => {
    if (!recorded || saving) return;
    setSaving(true);
    try {
      const at = recorded.source === "upload" ? when : recorded.recordedAt;
      const localDate = deviceYmd(at);
      const sameDayLocal = drafts.filter((d) => d.localDate === localDate && d.state !== "failed").length;
      let sameDayServer = localDate === today ? (home?.today.count ?? 0) : 0;
      if (localDate !== today && navigator.onLine) {
        const res = await api<{ days: DaySummary[] }>(`/api/calendar?from=${localDate}&to=${localDate}`).catch(() => null);
        sameDayServer = res?.days[0]?.count ?? 0;
      }
      if (sameDayServer + sameDayLocal >= MAX_MOMENTS_PER_DAY) {
        toast(localDate === today ? t.errors.daily_limit : r.limitDay(fmtDayMonth(localDate, locale)), "error");
        return;
      }
      await uploader.add({
        clientId: newClientId(),
        blob: recorded.blob,
        mime: recorded.mime,
        size: recorded.blob.size,
        recordedAt: at.toISOString(),
        localDate,
        localTime: deviceHm(at),
        note: note.trim(),
        projectIds: chosen,
        source: recorded.source,
        durationMs: recorded.durationMs,
        width: recorded.width,
        height: recorded.height,
        poster: recorded.poster,
        state: "queued",
        error: null,
        momentId: null,
        uploadedBytes: 0,
        attempts: 0,
        createdAt: Date.now(),
      });
      if (recorded.session) await clearChunks(recorded.session).catch(() => {});
      haptic("success");
      toast(navigator.onLine ? r.saved : r.savedOffline, "success");
      router.replace("/");
    } catch (err) {
      toast(isQuotaError(err) ? r.noSpace : t.errors.generic, "error");
    } finally {
      setSaving(false);
    }
  };

  const fileInput = (
    <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={(e) => void onPick(e)} tabIndex={-1} aria-hidden="true" />
  );

  // ── Лимит на сегодня ───────────────────────────────────────
  if (phase === "limit") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[520px] flex-col items-center justify-center px-7 pb-safe pt-safe text-center">
        <AmbientBackground />
        {fileInput}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
          <span className="mx-auto mb-6 grid size-24 place-items-center rounded-full bg-gradient-to-br from-lime-soft to-lime text-leaf-deep shadow-lime">
            <Check aria-hidden="true" size={44} strokeWidth={2.2} />
          </span>
          <h1 className="t-display">{r.limitTitle}</h1>
          <p className="mx-auto mt-3 max-w-[30ch] text-[16px] leading-snug text-muted-strong">{r.limitText}</p>
          <div className="mt-8 flex flex-col gap-3">
            <Button size="lg" block onClick={() => router.replace("/")}>
              {r.limitBack}
            </Button>
            <Button variant="glass" block icon={<Images aria-hidden="true" size={18} />} onClick={() => fileRef.current?.click()}>
              {r.galleryOtherDay}
            </Button>
          </div>
        </motion.div>
      </main>
    );
  }

  // ── Предпросмотр ───────────────────────────────────────────
  if (phase === "review" && recorded) {
    return (
      <main className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-night text-white">
        {fileInput}
        <header className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2 pt-safe">
          <IconButton label={r.discard} tone="dark" onClick={() => setConfirmDiscard(true)}>
            <X aria-hidden="true" size={22} />
          </IconButton>
          <div className="text-center">
            <h1 className="text-[16px] font-semibold">{r.review}</h1>
            <p className="tabular text-[13px] text-white/70">
              {recorded.durationMs > 0 ? fmtClock(recorded.durationMs) : ""}
              {recorded.source === "camera" ? ` · ${deviceHm(recorded.recordedAt)}` : ""}
            </p>
          </div>
          <span className="size-[46px]" aria-hidden="true" />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">
          <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}>
            <VideoPlayer
              src={recorded.url}
              title={r.review}
              width={recorded.width || 9}
              height={recorded.height || 16}
              maxHeight="46dvh"
              loop
              className="ring-1 ring-white/15"
            />
          </motion.div>

          <div className="mx-auto mt-5 flex max-w-[560px] flex-col gap-5">
            {recorded.source === "upload" && (
              <div>
                <label htmlFor="recorded-when" className="mb-1.5 block text-[13.5px] font-semibold text-white/80">
                  {r.when}
                </label>
                <input
                  id="recorded-when"
                  type="datetime-local"
                  max={toLocalInput(new Date())}
                  value={toLocalInput(when)}
                  onChange={(e) => {
                    const next = new Date(e.target.value);
                    if (!Number.isNaN(next.getTime()) && next <= new Date()) setWhen(next);
                  }}
                  className="w-full rounded-[18px] bg-white/14 px-4 text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.2)] outline-none [color-scheme:dark] focus:shadow-[inset_0_0_0_2px_var(--color-lime)]"
                />
              </div>
            )}

            <TextArea
              tone="dark"
              label={r.note}
              placeholder={r.notePlaceholder}
              value={note}
              maxLength={NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
            />

            {projects.length > 0 && (
              <div>
                <p className="mb-2 text-[13.5px] font-semibold text-white/80">{r.addTo}</p>
                <div className="flex flex-wrap gap-2">
                  {projects.map((p) => {
                    const on = chosen.includes(p.id);
                    return (
                      <Chip
                        key={p.id}
                        tone="dark"
                        selected={on}
                        onClick={() => setSelected(on ? chosen.filter((id) => id !== p.id) : [...chosen, p.id])}
                      >
                        {p.title}
                      </Chip>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        <footer className="shrink-0 border-t border-white/10 bg-night/80 px-5 pb-safe pt-3 backdrop-blur-xl">
          {/* Удаление — крестиком в шапке; внизу только два действия, чтобы они помещались и на узком экране. */}
          <div className="mx-auto flex max-w-[560px] items-center gap-3">
            <Button variant="dark" size="lg" className="min-w-0 flex-1 px-4" icon={<RefreshCw aria-hidden="true" size={18} />} onClick={() => void retake()} disabled={saving}>
              {recorded.source === "camera" ? r.retake : r.another}
            </Button>
            <Button size="lg" className="min-w-0 flex-[1.25] px-4" loading={saving} icon={<Check aria-hidden="true" size={20} strokeWidth={2.6} />} onClick={() => void save()}>
              {r.save}
            </Button>
          </div>
        </footer>

        <ConfirmSheet
          open={confirmDiscard}
          onClose={() => setConfirmDiscard(false)}
          onConfirm={discard}
          title={r.discardTitle}
          message={r.discardText}
          confirmLabel={t.common.delete}
          danger
        />
      </main>
    );
  }

  // ── Камера ─────────────────────────────────────────────────
  const recording = phase === "recording";
  const canStop = elapsed >= MIN_MOMENT_MS;
  const secondsLeft = Math.max(0, Math.ceil((MIN_MOMENT_MS - elapsed) / 1000));
  const failureText = r.errors[failure];

  return (
    <main className="fixed inset-0 z-40 overflow-hidden bg-night text-white">
      {fileInput}
      <video
        ref={liveRef}
        muted
        playsInline
        autoPlay
        aria-hidden="true"
        className={clsx("absolute inset-0 size-full object-cover transition-opacity duration-500", phase === "starting" || phase === "error" ? "opacity-0" : "opacity-100")}
        style={{ transform: facing === "user" ? "scaleX(-1)" : undefined }}
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/55 to-transparent" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/70 to-transparent" />

      <header className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 px-4 pt-safe">
        <IconButton label={r.close} tone="dark" onClick={() => router.replace("/")} className={recording || phase === "finishing" ? "invisible" : undefined}>
          <X aria-hidden="true" size={22} />
        </IconButton>

        <div role="status" aria-live="polite" className="glass-dark flex min-h-[40px] items-center gap-2 rounded-full px-4 text-[15px] font-semibold">
          {recording || phase === "finishing" ? (
            <>
              <span aria-hidden="true" className="size-2.5 animate-rec rounded-full bg-red-500" />
              <span className="sr-only">{r.rec}</span>
              <span className="tabular">{fmtClock(elapsed)}</span>
            </>
          ) : (
            <span className="tabular">{r.slot(Math.min(limit, todayCount + 1), limit)}</span>
          )}
        </div>

        <IconButton label={r.flip} tone="dark" onClick={flip} disabled={phase !== "ready"} className={recording || phase === "finishing" ? "invisible" : undefined}>
          <SwitchCamera aria-hidden="true" size={21} />
        </IconButton>
      </header>

      {phase === "starting" && (
        <div role="status" className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3 text-white/80">
            <Spinner size={30} />
            <span className="text-[15px]">{r.preparing}</span>
          </div>
        </div>
      )}

      {phase === "error" && (
        <div role="alert" className="absolute inset-0 grid place-items-center px-8 text-center">
          <div className="max-w-[340px]">
            <span className="glass-dark mx-auto mb-5 grid size-20 place-items-center rounded-full">
              <CameraOff aria-hidden="true" size={32} strokeWidth={1.7} />
            </span>
            <h1 className="t-title">{failureText.title}</h1>
            <p className="mt-2 text-[15px] leading-snug text-white/75">{failureText.text}</p>
            {failure === "denied" && isIos() && <p className="mt-2 text-[13.5px] text-white/60">{r.iosHint}</p>}
            <div className="mt-6 flex flex-col gap-3">
              {failure !== "insecure" && failure !== "unsupported" && (
                <Button block icon={<RefreshCw aria-hidden="true" size={18} />} onClick={() => void startCamera(facing)}>
                  {r.tryAgain}
                </Button>
              )}
              <Button variant="dark" block icon={<Images aria-hidden="true" size={18} />} onClick={() => fileRef.current?.click()}>
                {r.gallery}
              </Button>
              <Button variant="dark" block onClick={() => router.replace("/")}>
                {t.common.back}
              </Button>
            </div>
          </div>
        </div>
      )}

      {(phase === "ready" || recording || phase === "finishing") && (
        <footer className="absolute inset-x-0 bottom-0 px-6 pb-safe">
          <AnimatePresence mode="wait">
            <motion.p
              key={recording ? (canStop ? "stop" : "wait") : hasAudio ? "idle" : "mute"}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
              className="mb-4 flex min-h-[22px] items-center justify-center gap-1.5 text-center text-[14.5px] font-medium text-white/90 [text-shadow:0_1px_8px_rgb(0_0_0/0.5)]"
            >
              {recording ? (
                canStop ? (
                  r.canStop
                ) : (
                  r.minLeft(secondsLeft)
                )
              ) : !hasAudio ? (
                <>
                  <MicOff aria-hidden="true" size={15} />
                  {r.noAudio}
                </>
              ) : (
                r.minHint
              )}
            </motion.p>
          </AnimatePresence>

          <div className="mx-auto mb-3 grid max-w-[420px] grid-cols-[64px_1fr_64px] items-center">
            <div className={recording || phase === "finishing" ? "invisible" : undefined}>
              <button
                type="button"
                aria-label={r.gallery}
                onClick={() => {
                  haptic("light");
                  fileRef.current?.click();
                }}
                className="glass-dark press grid size-[58px] place-items-center rounded-full"
              >
                <Images aria-hidden="true" size={23} strokeWidth={1.8} />
              </button>
            </div>

            <div className="flex justify-center">
              {recording || phase === "finishing" ? (
                <button
                  type="button"
                  aria-label={r.stop}
                  aria-disabled={!canStop}
                  onClick={stopRecording}
                  className="relative grid size-[96px] place-items-center rounded-full"
                >
                  <Ring value={Math.min(1, elapsed / MIN_MOMENT_MS)} size={96} stroke={5} tone="dark" label={r.minHint}>
                    {phase === "finishing" ? (
                      <Spinner size={30} />
                    ) : (
                      <motion.span
                        animate={{ scale: canStop ? 1 : 0.86, opacity: canStop ? 1 : 0.55 }}
                        transition={{ type: "spring", stiffness: 380, damping: 26 }}
                        className={clsx("block size-[38px] rounded-[12px]", canStop ? "bg-lime" : "bg-white")}
                      />
                    )}
                  </Ring>
                </button>
              ) : (
                <motion.button
                  type="button"
                  aria-label={r.start}
                  whileTap={{ scale: 0.92 }}
                  transition={{ type: "spring", stiffness: 480, damping: 26 }}
                  onClick={() => void startRecording()}
                  className="relative grid size-[96px] place-items-center rounded-full border-[5px] border-white/90"
                >
                  <span aria-hidden="true" className="absolute -inset-2 animate-ring rounded-full border-2 border-lime/70" />
                  <span className="btn-lime block size-[72px] rounded-full" />
                </motion.button>
              )}
            </div>
            <span aria-hidden="true" />
          </div>
        </footer>
      )}
    </main>
  );
}
