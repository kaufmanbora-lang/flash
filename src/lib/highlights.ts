// Выбор фрагментов для сокращённых версий фильма (Highlights, трейлер, мини, расширенный).
// На входе — моменты с профилем по секундам (громкость звука и движение в кадре),
// на выходе — какие отрезки каких моментов войдут в фильм. Хронология сохраняется.

import type { MomentAnalysis } from "./types";

export interface ClipInput {
  id: string;
  durationSec: number;
  analysis: MomentAnalysis | null;
}

export interface Segment {
  id: string;
  start: number;
  duration: number;
}

export interface SelectConfig {
  /** Целевая суммарная длительность фрагментов в секундах. */
  target: number;
  minSeg: number;
  maxSeg: number;
}

const FPS = 30;
const snap = (sec: number) => Math.round(sec * FPS) / FPS;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Оценка «интересности» каждой секунды: речь и звуки важнее, движение дополняет. */
export function secondScores(clip: ClipInput): number[] {
  const n = Math.max(1, Math.ceil(clip.durationSec));
  const a = clip.analysis;
  if (!a) return new Array<number>(n).fill(0.5);
  const maxMotion = Math.max(0.02, ...a.motion);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    // −60 дБ и тише — тишина, −15 дБ и громче — отчётливый звук.
    const energy = clamp(((a.energy[i] ?? -90) + 60) / 45, 0, 1);
    const motion = clamp((a.motion[i] ?? 0) / maxMotion, 0, 1);
    out.push(0.65 * energy + 0.35 * motion);
  }
  return out;
}

/** Среднее значение профиля на отрезке [start, start + len) с учётом дробных границ. */
function windowMean(scores: number[], start: number, len: number): number {
  const end = start + len;
  let sum = 0;
  for (let i = Math.floor(start); i < Math.ceil(end) && i < scores.length; i++) {
    const overlap = Math.min(end, i + 1) - Math.max(start, i);
    if (overlap > 0) sum += scores[i] * overlap;
  }
  return sum / len;
}

/** Лучшее начало отрезка длиной len внутри момента. */
export function bestWindow(clip: ClipInput, len: number): { start: number; score: number } {
  const d = clip.durationSec;
  if (len >= d - 0.05) return { start: 0, score: windowMean(secondScores(clip), 0, Math.max(0.1, d)) };
  const scores = secondScores(clip);
  // Первые и последние мгновения записи обычно смазаны: телефон поднимают и опускают.
  const edge = Math.min(0.5, (d - len) / 2);
  const lo = edge;
  const hi = d - len - edge;
  if (!clip.analysis) return { start: snap(clamp(d * 0.2, lo, hi)), score: 0.5 };
  let best = { start: lo, score: -1 };
  for (let s = lo; s <= hi + 1e-6; s += 0.5) {
    const score = windowMean(scores, s, len);
    if (score > best.score + 1e-9) best = { start: s, score };
  }
  return { start: snap(best.start), score: best.score };
}

function clipInterest(clip: ClipInput, len: number): number {
  return bestWindow(clip, Math.min(len, clip.durationSec)).score;
}

/**
 * Подбирает фрагменты под целевую длительность.
 * Если материала меньше цели — берётся всё целиком.
 * Если моментов слишком много — они делятся на равные по времени группы и из каждой берётся лучший,
 * так в фильме остаются и начало, и середина, и конец истории.
 */
export function selectSegments(clips: ClipInput[], cfg: SelectConfig): Segment[] {
  const usable = clips.filter((c) => c.durationSec > 0.2);
  const total = usable.reduce((s, c) => s + c.durationSec, 0);
  if (usable.length === 0) return [];
  if (total <= cfg.target * 1.08) {
    return usable.map((c) => ({ id: c.id, start: 0, duration: snap(c.durationSec) }));
  }

  const minSeg = Math.min(cfg.minSeg, cfg.target);
  const maxCount = Math.max(1, Math.floor(cfg.target / minSeg));
  let chosen = usable;
  if (usable.length > maxCount) {
    chosen = [];
    for (let b = 0; b < maxCount; b++) {
      const from = Math.floor((b * usable.length) / maxCount);
      const to = Math.max(from + 1, Math.floor(((b + 1) * usable.length) / maxCount));
      let best = usable[from];
      let bestScore = -1;
      for (let i = from; i < to; i++) {
        const score = clipInterest(usable[i], minSeg);
        if (score > bestScore) {
          best = usable[i];
          bestScore = score;
        }
      }
      chosen.push(best);
    }
  }

  // Длина фрагмента: длинным и «живым» моментам — больше времени.
  const weights = chosen.map((c) => Math.sqrt(c.durationSec) * (0.6 + 0.8 * clipInterest(c, minSeg)));
  const cap = chosen.map((c) => Math.min(cfg.maxSeg, c.durationSec));
  const floor = chosen.map((c) => Math.min(minSeg, c.durationSec));
  const length = new Array<number>(chosen.length).fill(0);
  const fixed = new Array<boolean>(chosen.length).fill(false);
  let remaining = cfg.target;
  for (let pass = 0; pass < 6; pass++) {
    const free = chosen.map((_, i) => i).filter((i) => !fixed[i]);
    if (free.length === 0) break;
    const weightSum = free.reduce((s, i) => s + weights[i], 0) || 1;
    let changed = false;
    for (const i of free) {
      const want = (remaining * weights[i]) / weightSum;
      if (want >= cap[i]) {
        length[i] = cap[i];
        fixed[i] = true;
        changed = true;
      } else if (want <= floor[i]) {
        length[i] = floor[i];
        fixed[i] = true;
        changed = true;
      } else {
        length[i] = want;
      }
    }
    if (!changed) break;
    remaining = cfg.target - length.reduce((s, v, i) => s + (fixed[i] ? v : 0), 0);
    if (remaining <= 0) {
      for (const i of free) if (!fixed[i]) length[i] = floor[i];
      break;
    }
  }

  return chosen.map((c, i) => {
    const duration = snap(clamp(length[i], floor[i], cap[i]));
    const { start } = bestWindow(c, duration);
    return { id: c.id, start: Math.max(0, Math.min(start, snap(c.durationSec - duration))), duration };
  });
}
