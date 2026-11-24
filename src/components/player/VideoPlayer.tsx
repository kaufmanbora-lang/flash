"use client";

import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, ListVideo, Maximize, Minimize, Pause, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { haptic } from "@/client/haptics";
import { useT } from "@/client/i18n";
import { Spinner } from "@/components/ui/Button";
import { fmtClock } from "@/lib/format";
import type { FilmChapter } from "@/lib/types";

export interface VideoPlayerProps {
  src: string;
  poster?: string | null;
  title: string;
  width?: number;
  height?: number;
  chapters?: FilmChapter[];
  autoPlay?: boolean;
  loop?: boolean;
  /** Максимальная высота плеера вне полноэкранного режима (CSS-значение). */
  maxHeight?: string;
  className?: string;
}

type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/**
 * Встроенный плеер: перемотка, громкость, главы, полноэкранный режим.
 * playsInline и собственные элементы управления — чтобы видео играло внутри приложения на iPhone.
 */
export function VideoPlayer({
  src,
  poster,
  title,
  width = 9,
  height = 16,
  chapters = [],
  autoPlay = false,
  loop = false,
  maxHeight = "72dvh",
  className,
}: VideoPlayerProps) {
  const t = useT();
  const p = t.player;
  const videoRef = useRef<FullscreenVideo>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [volumeSupported, setVolumeSupported] = useState(false);
  const [controls, setControls] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);

  const poke = useCallback(() => {
    setControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setControls(false);
    }, 2800);
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // На iPhone громкость управляется только кнопками устройства: ползунок там не показываем.
    try {
      const before = v.volume;
      v.volume = 0.5;
      setVolumeSupported(Math.abs(v.volume - 0.5) < 0.01);
      v.volume = before;
    } catch {
      setVolumeSupported(false);
    }
    const onFs = () => setFullscreen(document.fullscreenElement === boxRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      v.pause();
    };
  }, []);

  useEffect(() => {
    setFailed(false);
    setTime(0);
    setChaptersOpen(false);
    if (autoPlay) void videoRef.current?.play().catch(() => {});
  }, [src, autoPlay]);

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    haptic("light");
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
    poke();
  }, [poke]);

  const seekTo = useCallback((sec: number) => {
    const v = videoRef.current;
    if (!v) return;
    const max = Number.isFinite(v.duration) ? v.duration : sec;
    v.currentTime = Math.min(Math.max(0, sec), Math.max(0, max - 0.05));
    setTime(v.currentTime);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const box = boxRef.current;
    const v = videoRef.current;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (box?.requestFullscreen) {
      box.requestFullscreen().catch(() => v?.webkitEnterFullscreen?.());
    } else {
      // iPhone: полноэкранный режим доступен только самому видео.
      v?.webkitEnterFullscreen?.();
    }
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    poke();
  }, [poke]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === " " || e.key === "k") {
      e.preventDefault();
      toggle();
    } else if (e.key === "ArrowLeft") {
      seekTo(time - 5);
      poke();
    } else if (e.key === "ArrowRight") {
      seekTo(time + 5);
      poke();
    } else if (e.key === "m") {
      toggleMute();
    } else if (e.key === "f") {
      toggleFullscreen();
    }
  };

  const visible = controls || !playing;
  const pct = duration > 0 ? (time / duration) * 100 : 0;
  const currentChapter = chapters.reduce((acc, ch, i) => (ch.startMs / 1000 <= time + 0.2 ? i : acc), 0);

  const boxStyle: CSSProperties | undefined = fullscreen
    ? undefined
    : { aspectRatio: `${width} / ${height}`, width: `min(100%, calc(${maxHeight} * ${(width / height).toFixed(4)}))` };

  return (
    <div
      ref={boxRef}
      tabIndex={0}
      role="group"
      aria-label={title}
      onKeyDown={onKeyDown}
      onPointerMove={poke}
      style={boxStyle}
      className={clsx(
        "player relative mx-auto overflow-hidden bg-night outline-none focus-visible:ring-4 focus-visible:ring-leaf/60",
        fullscreen ? "size-full rounded-none" : "rounded-[28px] shadow-float",
        className,
      )}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster ?? undefined}
        playsInline
        preload="metadata"
        loop={loop}
        className="absolute inset-0 size-full object-contain"
        onClick={() => {
          const v = videoRef.current;
          if (!v) return;
          if (v.paused) toggle();
          else if (controls) setControls(false);
          else poke();
        }}
        onPlay={() => {
          setPlaying(true);
          poke();
        }}
        onPause={() => {
          setPlaying(false);
          setControls(true);
        }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(d);
        }}
        onDurationChange={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(d);
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onVolumeChange={(e) => {
          setMuted(e.currentTarget.muted);
          setVolume(e.currentTarget.volume);
        }}
        onError={() => setFailed(true)}
      />

      {failed ? (
        <div role="alert" className="absolute inset-0 grid place-items-center bg-night/80 p-6 text-center text-white">
          <div>
            <AlertCircle aria-hidden="true" className="mx-auto mb-3" size={30} />
            <p className="text-[15px] font-medium">{p.error}</p>
            <button
              type="button"
              className="glass-dark press mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-full px-4 text-[14.5px] font-semibold"
              onClick={() => {
                setFailed(false);
                videoRef.current?.load();
              }}
            >
              <RotateCcw aria-hidden="true" size={16} />
              {t.common.retry}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* На низком (горизонтальном) видео кнопка меньше и выше — см. .player-center в globals.css. */}
          <div className="player-center">
            <AnimatePresence>
              {visible && (
                <motion.button
                  type="button"
                  aria-label={playing ? p.pause : p.play}
                  onClick={toggle}
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.15 } }}
                  whileTap={{ scale: 0.92 }}
                  transition={{ type: "spring", stiffness: 420, damping: 30 }}
                  className="glass-dark player-play pointer-events-auto grid place-items-center rounded-full"
                >
                  {waiting && playing ? (
                    <Spinner size={28} />
                  ) : playing ? (
                    <Pause aria-hidden="true" size={30} fill="currentColor" strokeWidth={0} />
                  ) : (
                    <Play aria-hidden="true" size={30} fill="currentColor" strokeWidth={0} className="ml-1" />
                  )}
                </motion.button>
              )}
            </AnimatePresence>
          </div>

          <AnimatePresence>
            {chaptersOpen && chapters.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 12, transition: { duration: 0.15 } }}
                className="glass-dark no-scrollbar absolute bottom-[76px] right-3 z-10 max-h-[60%] w-[min(78%,300px)] overflow-y-auto rounded-[22px] p-1.5"
              >
                <ul aria-label={p.chapters}>
                  {chapters.map((ch, i) => (
                    <li key={`${ch.startMs}-${i}`}>
                      <button
                        type="button"
                        aria-current={i === currentChapter ? "true" : undefined}
                        onClick={() => {
                          seekTo(ch.startMs / 1000 + 0.05);
                          setChaptersOpen(false);
                          void videoRef.current?.play().catch(() => {});
                        }}
                        className={clsx(
                          "flex min-h-[44px] w-full items-center justify-between gap-3 rounded-[16px] px-3 text-left text-[14px] font-medium",
                          i === currentChapter ? "bg-white/20" : "hover:bg-white/10",
                        )}
                      >
                        <span className="truncate">{ch.title}</span>
                        <span className="tabular shrink-0 text-white/70">{fmtClock(ch.startMs)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div
            initial={false}
            animate={{ opacity: visible ? 1 : 0 }}
            transition={{ duration: 0.22 }}
            className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent px-3.5 pb-3 pt-12 text-white"
          >
            {/* Затемнение над шкалой не перехватывает нажатия: на низком видео под ним лежит кнопка воспроизведения. */}
            <div className={visible ? "pointer-events-auto" : undefined}>
            <input
              type="range"
              aria-label={p.seek}
              aria-valuetext={`${fmtClock(time * 1000)} / ${fmtClock(duration * 1000)}`}
              min={0}
              max={duration || 0}
              step={0.05}
              value={Math.min(time, duration || 0)}
              onChange={(e) => {
                seekTo(Number(e.target.value));
                poke();
              }}
              className="slider slider-light"
              style={{ "--fill": `${pct}%` } as CSSProperties}
            />
            <div className="mt-0.5 flex items-center gap-1">
              <span className="tabular whitespace-nowrap px-1.5 text-[13px] font-semibold">
                {fmtClock(time * 1000)} <span className="player-total text-white/60">/ {fmtClock(duration * 1000)}</span>
              </span>
              <span className="flex-1" />
              {volumeSupported && (
                <input
                  type="range"
                  aria-label={p.volume}
                  min={0}
                  max={1}
                  step={0.02}
                  value={muted ? 0 : volume}
                  onChange={(e) => {
                    const v = videoRef.current;
                    if (!v) return;
                    v.volume = Number(e.target.value);
                    v.muted = v.volume === 0;
                    poke();
                  }}
                  className="slider slider-light hidden w-[88px] sm:block"
                  style={{ "--fill": `${(muted ? 0 : volume) * 100}%` } as CSSProperties}
                />
              )}
              <button type="button" aria-label={muted ? p.unmute : p.mute} aria-pressed={muted} onClick={toggleMute} className="grid size-11 place-items-center rounded-full hover:bg-white/15">
                {muted ? <VolumeX aria-hidden="true" size={21} /> : <Volume2 aria-hidden="true" size={21} />}
              </button>
              {chapters.length > 0 && (
                <button
                  type="button"
                  aria-label={p.chapters}
                  aria-expanded={chaptersOpen}
                  onClick={() => {
                    setChaptersOpen((v) => !v);
                    poke();
                  }}
                  className="grid size-11 place-items-center rounded-full hover:bg-white/15"
                >
                  <ListVideo aria-hidden="true" size={21} />
                </button>
              )}
              <button type="button" aria-label={fullscreen ? p.exitFullscreen : p.fullscreen} onClick={toggleFullscreen} className="grid size-11 place-items-center rounded-full hover:bg-white/15">
                {fullscreen ? <Minimize aria-hidden="true" size={21} /> : <Maximize aria-hidden="true" size={21} />}
              </button>
            </div>
            </div>
          </motion.div>
        </>
      )}
    </div>
  );
}
