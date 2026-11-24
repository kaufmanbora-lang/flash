// Анализ момента в фоне: громкость звука и движение в кадре по секундам.
// По этому профилю выбираются самые живые фрагменты для Highlights, трейлеров и мини-фильмов.

import { ALL_FORMATS, AudioSampleSink, BlobSource, CanvasSink, Input } from "mediabunny";
import type { MomentAnalysis } from "@/lib/types";
import { blobKey, store } from "./store";

/** Длиннее этого движение не считаем: пришлось бы декодировать слишком много кадров. */
const MOTION_MAX_SEC = 180;
const THUMB = 32;

let paused = false;
const queue: string[] = [];
let running = false;

/** На время монтажа фоновый анализ приостанавливается, чтобы не отбирать у него декодер. */
export function pauseAnalysis(value: boolean): void {
  paused = value;
  if (!value) void drain();
}

async function audioEnergy(input: Input, seconds: number): Promise<number[]> {
  const energy = new Array<number>(seconds).fill(-90);
  const track = await input.getPrimaryAudioTrack().catch(() => null);
  if (!track || !(await track.canDecode().catch(() => false))) return energy;
  const origin = await track.getFirstTimestamp();
  const sum = new Float64Array(seconds);
  const count = new Float64Array(seconds);
  let buffer = new Float32Array(0);
  for await (const sample of new AudioSampleSink(track).samples()) {
    try {
      const frames = sample.numberOfFrames;
      if (buffer.length < frames) buffer = new Float32Array(frames);
      sample.copyTo(buffer, { planeIndex: 0, format: "f32-planar" });
      const rate = sample.sampleRate;
      const base = sample.timestamp - origin;
      for (let i = 0; i < frames; i++) {
        const second = Math.floor(base + i / rate);
        if (second < 0 || second >= seconds) continue;
        sum[second] += buffer[i] * buffer[i];
        count[second]++;
      }
    } finally {
      sample.close();
    }
  }
  for (let s = 0; s < seconds; s++) {
    if (count[s] > 0) energy[s] = Math.max(-90, Math.min(0, 10 * Math.log10(sum[s] / count[s] + 1e-9)));
  }
  return energy;
}

async function videoMotion(input: Input, seconds: number): Promise<number[]> {
  const motion = new Array<number>(seconds).fill(0);
  if (seconds > MOTION_MAX_SEC) return motion;
  const track = await input.getPrimaryVideoTrack().catch(() => null);
  if (!track || !(await track.canDecode().catch(() => false))) return motion;
  const origin = await track.getFirstTimestamp();
  const sink = new CanvasSink(track, { width: THUMB, height: THUMB, fit: "fill", poolSize: 2 });
  const probe = document.createElement("canvas");
  probe.width = THUMB;
  probe.height = THUMB;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return motion;

  // Два замера в секунду: разница между соседними уменьшенными кадрами.
  const times: number[] = [];
  for (let k = 0; k < seconds * 2; k++) times.push(origin + k / 2 + 0.1);
  let prev: Uint8ClampedArray | null = null;
  let k = 0;
  for await (const wrapped of sink.canvasesAtTimestamps(times)) {
    const index = k++;
    if (!wrapped) continue;
    ctx.drawImage(wrapped.canvas, 0, 0, THUMB, THUMB);
    const data = ctx.getImageData(0, 0, THUMB, THUMB).data;
    if (prev) {
      let diff = 0;
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        const b = prev[i] * 0.299 + prev[i + 1] * 0.587 + prev[i + 2] * 0.114;
        diff += Math.abs(a - b);
      }
      const value = Math.min(1, diff / (THUMB * THUMB) / 255);
      const second = Math.min(seconds - 1, Math.floor(index / 2));
      motion[second] = Math.max(motion[second], value);
    }
    prev = new Uint8ClampedArray(data);
  }
  return motion;
}

/** Считает профиль момента и сохраняет его в запись. Ошибки не мешают остальной работе приложения. */
export async function analyzeNow(momentId: string): Promise<void> {
  const rec = store.moments.get(momentId);
  if (!rec || rec.analysisState !== "pending") return;
  let analysis: MomentAnalysis | null = null;
  let state: "done" | "failed" = "failed";
  try {
    const blob = await store.getBlob(blobKey.momentVideo(momentId));
    if (blob) {
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
      try {
        const seconds = Math.max(1, Math.ceil(rec.durationMs / 1000));
        const energy = await audioEnergy(input, seconds);
        const motion = await videoMotion(input, seconds);
        analysis = { energy, motion };
        state = "done";
      } finally {
        input.dispose();
      }
    }
  } catch {
    /* профиля не будет — фрагменты выберутся равномерно */
  }
  const fresh = store.moments.get(momentId);
  if (!fresh) return;
  await store.putMoment({ ...fresh, analysis, analysisState: state }).catch(() => {});
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0 && !paused) {
      const id = queue.shift()!;
      await analyzeNow(id);
      // Пауза между моментами: интерфейс и съёмка важнее.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } finally {
    running = false;
  }
}

/** Ставит момент в очередь фонового анализа. */
export function queueAnalysis(momentId: string): void {
  if (typeof window === "undefined") return;
  if (!queue.includes(momentId)) queue.push(momentId);
  // Даём интерфейсу закончить текущие дела (сохранение, переход на другой экран).
  setTimeout(() => void drain(), 1200);
}

/** Возвращает в очередь моменты, анализ которых не успел закончиться в прошлый раз. */
export function queuePendingAnalysis(): void {
  for (const m of store.moments.values()) if (m.analysisState === "pending") queueAnalysis(m.id);
}

/**
 * Досчитывает профили нужных моментов прямо сейчас (перед монтажом сокращённой версии).
 * Не дольше budgetMs: что не успели — пойдёт в фильм с равномерным выбором фрагментов.
 */
export async function ensureAnalyzed(momentIds: string[], budgetMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (const id of momentIds) {
    if (signal?.aborted || Date.now() > deadline) return;
    if (store.moments.get(id)?.analysisState === "pending") await analyzeNow(id);
  }
}
