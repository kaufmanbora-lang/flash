// Автоматический монтаж фильма прямо в браузере.
//
// Схема одинаково работает для 3 и для 3000 моментов (память не растёт с числом клипов):
//   1. План: какие отрезки каких моментов, титры, переходы (plan.ts) — в кадрах, 30 в секунду.
//   2. Кадр за кадром: нужные клипы декодируются из исходных файлов, собираются на canvas
//      (вписывание, цветокоррекция, подписи, переходы) и сразу уходят в кодировщик.
//   3. Звук сводится теми же шагами (audio.ts): клипы + музыка, которая уступает речи.
//   4. Готовый файл пишется на диск страницами (writer.ts) и в конце сохраняется в дневник.
// Исходные видео только читаются. Монтаж не привязан к реальному времени: быстрое устройство
// собирает фильм быстрее, чем он длится.

import {
  AudioSample,
  AudioSampleSource,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type OutputFormat,
  type VideoCodec,
} from "mediabunny";
import type { FilmStyleId } from "@/lib/constants";
import { ApiError } from "@/lib/errors";
import { ensureAnalyzed, pauseAnalysis } from "../analyze";
import { filmMoments } from "../core";
import { beginRender, completeRender, failRender, requeueRender } from "../films";
import { MUSIC_CROSSFADE_SEC, pickMusic, trackUrl, type MusicTrack } from "../music";
import { blobKey, newId, store, type FilmRec, type MomentRec } from "../store";
import { Mixer, layoutMusic, silentReader, type ClipTrack, type MusicTrackSpec } from "./audio";
import { Compositor, type Layer } from "./compositor";
import { chooseCanvas, labelFramesFor, lowerCanvas, planFilm, type FilmPlan, type PlanElement, type PlanMoment } from "./plan";
import { FrameReader, TrackAudioReader, openClip, openMusic, type ClipSource } from "./sources";
import { FPS, SAMPLE_RATE, SAMPLES_PER_FRAME, STYLES, rotateStyle } from "./styles";
import { drawCard, labelAlpha, loadFilmFonts, prepareCard, prepareLabel, type PreparedCard, type PreparedLabel } from "./titles";
import { PagedWriter } from "./writer";

export type RenderStage = "prepare" | "clips" | "saving";

export interface RenderProgress {
  stage: RenderStage;
  /** Общая готовность, 0…1. */
  progress: number;
  frame: number;
  totalFrames: number;
  /** Сколько секунд осталось (оценка); null — пока неизвестно. */
  etaSec: number | null;
}

export interface RenderOptions {
  /** Canvas на экране «премьеры»: монтаж идёт прямо на нём, и зритель видит собираемые кадры. */
  canvas?: HTMLCanvasElement | null;
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
}

export interface RenderOutcome {
  film: FilmRec;
  /** Не помешавшие сборке, но заметные зрителю особенности: «no_audio», «no_music», «skipped». */
  warnings: string[];
  /** Сколько моментов не вошло в фильм, потому что браузер не смог их декодировать. */
  skipped: number;
}

export class RenderAborted extends Error {
  constructor() {
    super("aborted");
    this.name = "RenderAborted";
  }
}

/** Умеет ли этот браузер собирать фильмы (нужен WebCodecs: Chrome, Edge, Safari 16.4+, Firefox 130+). */
export function renderSupported(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined" && typeof VideoFrame !== "undefined";
}

interface Encoding {
  format: OutputFormat;
  mime: string;
  video: VideoCodec;
  audio: AudioCodec | null;
  bitrate: number;
}

const AUDIO_BITRATE = 160_000;

/** Постоянный потолок битрейта: ≈4 Мбит/с для 720p, ≈9 Мбит/с для 1080p — фильм остаётся удобным для отправки. */
const videoBitrate = (W: number, H: number): number =>
  Math.round(Math.min(16_000_000, Math.max(2_500_000, W * H * FPS * 0.145)));

/**
 * Подбирает формат файла под возможности устройства. Лучший вариант — MP4 (H.264 + AAC): играет везде.
 * Если чего-то нет, пробуем WebM; в крайнем случае фильм собирается без звука.
 */
async function chooseEncoding(W: number, H: number): Promise<Encoding | null> {
  const bitrate = videoBitrate(W, H);
  const videoOpts = { width: W, height: H, bitrate, frameRate: FPS };
  const audioOpts = { numberOfChannels: 2, sampleRate: SAMPLE_RATE, bitrate: AUDIO_BITRATE };
  const avc = await getFirstEncodableVideoCodec(["avc"], videoOpts).catch(() => null);
  const aac = await getFirstEncodableAudioCodec(["aac"], audioOpts).catch(() => null);
  if (avc && aac) return { format: new Mp4OutputFormat({ fastStart: false }), mime: "video/mp4", video: avc, audio: aac, bitrate };

  const vpx = await getFirstEncodableVideoCodec(["vp9", "vp8"], videoOpts).catch(() => null);
  const opus = await getFirstEncodableAudioCodec(["opus"], audioOpts).catch(() => null);
  if (vpx && opus) return { format: new WebMOutputFormat(), mime: "video/webm", video: vpx, audio: opus, bitrate };
  if (avc) return { format: new Mp4OutputFormat({ fastStart: false }), mime: "video/mp4", video: avc, audio: null, bitrate };
  if (vpx) return { format: new WebMOutputFormat(), mime: "video/webm", video: vpx, audio: null, bitrate };
  return null;
}

/** Уступает очередь интерфейсу. Не setTimeout: в фоновой вкладке он срабатывает раз в секунду. */
const yieldChannel = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
function yieldToUi(): Promise<void> {
  if (!yieldChannel) return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    yieldChannel.port1.onmessage = () => resolve();
    yieldChannel.port2.postMessage(0);
  });
}

async function holdWakeLock(): Promise<() => void> {
  type Sentinel = { release(): Promise<void> };
  const api = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<Sentinel> } }).wakeLock;
  if (!api) return () => {};
  let sentinel: Sentinel | null = null;
  let released = false;
  const acquire = async () => {
    if (released || document.visibilityState !== "visible") return;
    sentinel = await api.request("screen").catch(() => null);
  };
  await acquire();
  // Система снимает блокировку, когда приложение уходит в фон; по возвращении берём её снова.
  const onVisible = () => void acquire();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    released = true;
    document.removeEventListener("visibilitychange", onVisible);
    void sentinel?.release().catch(() => {});
  };
}

type ActiveElement =
  | { kind: "card"; card: PreparedCard }
  | { kind: "clip"; source: ClipSource | null; reader: FrameReader | null; label: PreparedLabel | null; labelFrames: number };

function closeActive(active: ActiveElement | undefined): void {
  if (!active || active.kind !== "clip") return;
  active.reader?.close();
  active.source?.dispose();
}

async function posterBitmap(momentId: string | null): Promise<ImageBitmap | null> {
  if (!momentId) return null;
  try {
    const blob = await store.getBlob(blobKey.momentPoster(momentId));
    return blob ? await createImageBitmap(blob) : null;
  } catch {
    return null;
  }
}

/**
 * Собирает фильм. Одновременно идёт только одна сборка (в том числе между вкладками).
 * При отмене фильм возвращается в очередь, при ошибке помечается ошибкой; прежняя версия файла остаётся.
 */
export async function renderFilm(filmId: string, opts: RenderOptions = {}): Promise<RenderOutcome> {
  if (!renderSupported()) throw new ApiError(400, "render_unsupported");
  const run = () => renderLocked(filmId, opts);
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request("flash-render", { ifAvailable: true }, async (lock) => {
      if (!lock) throw new ApiError(409, "render_busy");
      return run();
    });
  }
  return run();
}

async function renderLocked(filmId: string, opts: RenderOptions): Promise<RenderOutcome> {
  const signal = opts.signal;
  const checkAbort = () => {
    if (signal?.aborted) throw new RenderAborted();
  };
  const film = await beginRender(filmId);
  pauseAnalysis(true);
  const releaseWake = await holdWakeLock();
  const writer = new PagedWriter(newId());
  let output: Output | null = null;
  let mixer: Mixer | null = null;
  const active = new Map<number, ActiveElement>();

  try {
    const report = (stage: RenderStage, progress: number, frame = 0, totalFrames = 0, etaSec: number | null = null) =>
      opts.onProgress?.({ stage, progress: Math.min(1, Math.max(0, progress)), frame, totalFrames, etaSec });
    report("prepare", 0);

    // 1. Моменты фильма, которые этот браузер умеет декодировать.
    const all = filmMoments(film);
    if (all.length === 0) throw new ApiError(400, "no_moments");
    const usable: MomentRec[] = [];
    const hasAudio = new Map<string, boolean>();
    for (let i = 0; i < all.length; i++) {
      checkAbort();
      const blob = await store.getBlob(blobKey.momentVideo(all[i].id));
      const source = blob ? await openClip(blob) : null;
      if (source) {
        usable.push(all[i]);
        hasAudio.set(all[i].id, source.audio !== null);
        source.dispose();
      }
      report("prepare", 0.03 * ((i + 1) / all.length));
      if (i % 8 === 7) await yieldToUi();
    }
    if (usable.length === 0) throw new ApiError(400, "source_unreadable");
    const skipped = all.length - usable.length;

    // 2. Стиль, размер кадра и формат файла.
    const styleId: FilmStyleId =
      film.style !== "auto"
        ? film.style
        : rotateStyle(
            [...store.films.values()]
              .filter((f) => f.id !== film.id && f.styleUsed && f.renderedAt)
              .sort((a, b) => ((a.renderedAt ?? "") < (b.renderedAt ?? "") ? 1 : -1))
              .slice(0, 12)
              .map((f) => f.styleUsed!),
          );
    const planMoments: PlanMoment[] = usable.map((m) => ({
      id: m.id,
      date: m.date,
      time: m.time,
      durationMs: m.durationMs,
      width: m.width,
      height: m.height,
      analysis: m.analysis,
    }));
    let size: { W: number; H: number } | null = chooseCanvas(film, planMoments);
    let encoding: Encoding | null = null;
    while (size) {
      encoding = await chooseEncoding(size.W, size.H);
      if (encoding) break;
      size = lowerCanvas(size);
    }
    if (!size || !encoding) throw new ApiError(400, "render_unsupported");

    // 3. Для сокращённых версий нужен профиль «интересности» моментов.
    if (film.variant !== "full") {
      await ensureAnalyzed(usable.map((m) => m.id), 25_000, signal);
      checkAbort();
      for (const pm of planMoments) pm.analysis = store.moments.get(pm.id)?.analysis ?? null;
    }

    // 4. План и титры.
    const project = film.projectId ? (store.projects.get(film.projectId) ?? null) : null;
    const locale = store.profile?.locale ?? "ru";
    const plan: FilmPlan = planFilm({
      film,
      moments: planMoments,
      project: project
        ? { title: project.title, description: project.description, startDate: project.startDate, endDate: project.endDate }
        : null,
      styleId,
      size,
      userName: store.profile?.name ?? "",
      locale,
    });
    const style = STYLES[plan.styleId];
    const { W, H } = plan;
    const totalFrames = plan.totalFrames;
    const totalSamples = totalFrames * SAMPLES_PER_FRAME;
    const totalSec = totalFrames / FPS;
    const texts = plan.elements
      .flatMap((e) => (e.kind === "card" ? e.lines.map((l) => l.text) : e.label ? [e.label.primary, e.label.secondary ?? "", e.label.stamp] : []))
      .join(" ");
    await loadFilmFonts(texts);
    checkAbort();
    report("prepare", 0.04);

    // 5. Музыка: плейлист и файлы композиций.
    const warnings: string[] = [];
    if (skipped > 0) warnings.push("skipped");
    const wantMusic = encoding.audio !== null && film.music !== "none" && film.musicVolume > 0.01;
    let playlist: MusicTrack[] = wantMusic ? await pickMusic(film.id, film.music, totalSec) : [];
    const musicFiles = new Map<string, Blob>();
    for (const track of playlist) {
      if (musicFiles.has(track.id)) continue;
      try {
        const res = await fetch(trackUrl(track));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        musicFiles.set(track.id, await res.blob());
      } catch {
        /* нет сети и композиция не в кэше */
      }
      checkAbort();
    }
    if (wantMusic && (playlist.length === 0 || playlist.some((t) => !musicFiles.has(t.id)))) {
      // Музыка не скачалась — честнее собрать фильм без неё, чем с обрывающейся дорожкой.
      playlist = [];
      warnings.push("no_music");
    }
    if (encoding.audio === null) warnings.push("no_audio");
    report("prepare", 0.05);

    // 6. Звук: клипы на линии времени и музыка.
    const clipTracks: ClipTrack[] = [];
    plan.elements.forEach((el, i) => {
      if (el.kind !== "clip" || !hasAudio.get(el.clip.momentId)) return;
      const head = i > 0 ? plan.transitions[i - 1].frames : 0;
      const tail = i < plan.transitions.length ? plan.transitions[i].frames : 0;
      clipTracks.push({
        start: plan.starts[i] * SAMPLES_PER_FRAME,
        length: el.frames * SAMPLES_PER_FRAME,
        fadeIn: head * SAMPLES_PER_FRAME,
        fadeOut: tail * SAMPLES_PER_FRAME,
        open: async () => {
          const blob = await store.getBlob(blobKey.momentVideo(el.clip.momentId));
          const source = blob ? await openClip(blob) : null;
          if (!source?.audio) {
            source?.dispose();
            return silentReader;
          }
          // Звук читается своим обращением к файлу — независимо от кадров.
          return new TrackAudioReader(source.audio, source.origin + el.clip.start, el.frames / FPS, () => source.dispose());
        },
      });
    });
    const crossfade = MUSIC_CROSSFADE_SEC * SAMPLE_RATE;
    const musicTracks: MusicTrackSpec[] = layoutMusic(playlist, totalSamples, crossfade).map(({ track, start, length }) => ({
      start,
      length,
      open: async () => (await openMusic(musicFiles.get(track.id)!, track.durationSec)) ?? silentReader,
    }));
    mixer = new Mixer({ totalSamples, clips: clipTracks, music: musicTracks, musicVolume: film.musicVolume, crossfade });

    // 7. Кодировщик и файл.
    const compositor = new Compositor(W, H, style, plan.barHeight, opts.canvas);
    output = new Output({
      format: encoding.format,
      target: new StreamTarget(writer.writable(), { chunked: true, chunkSize: 2 * 1024 * 1024 }),
    });
    const videoSource = new CanvasSource(compositor.out.canvas, {
      codec: encoding.video,
      quality: new Quality({ bitrate: encoding.bitrate }),
      keyFrameInterval: 2,
      latencyMode: "quality",
    });
    output.addVideoTrack(videoSource, { frameRate: FPS });
    let audioSource: AudioSampleSource | null = null;
    if (encoding.audio) {
      audioSource = new AudioSampleSource({ codec: encoding.audio, quality: new Quality({ bitrate: AUDIO_BITRATE }) });
      output.addAudioTrack(audioSource);
    }
    output.setMetadataTags({ title: film.title });
    await output.start();

    // 8. Кадр за кадром.
    const prepare = async (index: number): Promise<ActiveElement> => {
      const el: PlanElement = plan.elements[index];
      if (el.kind === "card") {
        const photo = style.card.background === "photo" ? await posterBitmap(el.photoOf) : null;
        try {
          return { kind: "card", card: prepareCard({ W, H, theme: style.card, role: el.role, frames: el.frames, lines: el.lines, photo }) };
        } finally {
          photo?.close();
        }
      }
      const blob = await store.getBlob(blobKey.momentVideo(el.clip.momentId));
      const source = blob ? await openClip(blob) : null;
      const labelFrames = el.label ? labelFramesFor(el.frames) : 0;
      return {
        kind: "clip",
        source,
        reader: source ? new FrameReader(source, el.clip.start, el.frames / FPS) : null,
        label: el.label && labelFrames > 0 ? prepareLabel({ W, H, theme: style.label, text: el.label, barHeight: plan.barHeight }) : null,
        labelFrames,
      };
    };

    const drawElement = async (index: number, local: number, layer: Layer, globalFrame: number): Promise<void> => {
      let state = active.get(index);
      if (!state) {
        state = await prepare(index);
        active.set(index, state);
      }
      if (state.kind === "card") {
        drawCard(layer.ctx, state.card, local, W, H);
        if (style.grade.grain > 0) compositor.applyGrain(layer, style.grade.grain * 0.8, globalFrame);
        return;
      }
      const sample = state.reader ? await state.reader.frameAt(local / FPS) : null;
      compositor.drawClip(layer, sample, globalFrame, state.label, labelAlpha(local, state.labelFrames));
    };

    const { elements, transitions, starts } = plan;
    let current = 0;
    let poster: Blob | null = null;
    let mixed = 0;
    const startedAt = performance.now();

    for (let f = 0; f < totalFrames; f++) {
      checkAbort();
      while (current + 1 < elements.length && starts[current + 1] <= f) current++;
      // Элементы, которые уже отыграли, закрываются: их декодеры и кадры больше не нужны.
      for (const index of [...active.keys()]) {
        if (index < current - 1 || (index === current - 1 && f >= starts[index] + elements[index].frames)) {
          closeActive(active.get(index));
          active.delete(index);
        }
      }

      const prev = current - 1;
      if (prev >= 0 && f < starts[prev] + elements[prev].frames) {
        const tr = transitions[prev];
        const k = f - starts[current];
        await drawElement(prev, f - starts[prev], compositor.layer("a"), f);
        await drawElement(current, k, compositor.layer("b"), f);
        compositor.transition(tr, (k + 1) / (tr.frames + 1));
      } else {
        await drawElement(current, f - starts[current], compositor.layer("out"), f);
      }

      if (f === plan.posterFrame) poster = await compositor.snapshot();
      await videoSource.add(f / FPS, 1 / FPS);

      // Звук идёт вровень с картинкой — кодировщику не приходится держать в памяти целую дорожку.
      if (audioSource && ((f + 1) % 15 === 0 || f === totalFrames - 1)) {
        const target = Math.min(totalSamples, (f + 1) * SAMPLES_PER_FRAME);
        while (mixed < target) {
          const { left, right } = await mixer.next(Math.min(target - mixed, SAMPLE_RATE / 2));
          const interleaved = new Float32Array(left.length * 2);
          for (let i = 0; i < left.length; i++) {
            interleaved[i * 2] = left[i];
            interleaved[i * 2 + 1] = right[i];
          }
          const sample = new AudioSample({
            data: interleaved,
            format: "f32",
            numberOfChannels: 2,
            sampleRate: SAMPLE_RATE,
            timestamp: mixed / SAMPLE_RATE,
          });
          await audioSource.add(sample);
          sample.close();
          mixed += left.length;
        }
      }

      if (f % 6 === 5 || f === totalFrames - 1) {
        const elapsed = (performance.now() - startedAt) / 1000;
        const done = (f + 1) / totalFrames;
        report("clips", 0.05 + 0.9 * done, f + 1, totalFrames, f > 45 ? (elapsed / done) * (1 - done) : null);
        await yieldToUi();
      }
    }
    for (const state of active.values()) closeActive(state);
    active.clear();
    mixer.close();
    mixer = null;

    // 9. Завершение файла и сохранение в дневник.
    report("saving", 0.96, totalFrames, totalFrames, null);
    await output.finalize();
    output = null;
    checkAbort();
    const video = await writer.finish(encoding.mime);
    if (video.size < 1024) throw new Error("empty_output");
    const saved = await completeRender(filmId, {
      video,
      poster,
      mime: encoding.mime,
      width: W,
      height: H,
      durationMs: (totalFrames / FPS) * 1000,
      styleUsed: plan.styleId,
      musicUsed: playlist.map((t) => t.id),
      chapters: plan.chapters,
      momentsCount: plan.clipCount,
    });
    report("saving", 1, totalFrames, totalFrames, 0);
    return { film: saved, warnings, skipped };
  } catch (err) {
    for (const state of active.values()) closeActive(state);
    mixer?.close();
    if (output) await output.cancel().catch(() => {});
    if (err instanceof RenderAborted || signal?.aborted) {
      await requeueRender(filmId);
      throw new RenderAborted();
    }
    const code = err instanceof ApiError ? err.code : "render_failed";
    if (!(err instanceof ApiError)) console.error("[film] сборка не удалась:", err);
    await failRender(filmId, code);
    throw err instanceof ApiError ? err : new ApiError(500, "render_failed");
  } finally {
    await writer.discard();
    releaseWake();
    pauseAnalysis(false);
  }
}
