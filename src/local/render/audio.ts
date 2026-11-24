// Звук фильма: сведение клипов и музыки. Чистая математика над массивами сэмплов, без браузера —
// поэтому проверяется обычными тестами.
//
// Схема та же, что была в серверной версии на FFmpeg:
//   клипы с плавными входами и выходами на переходах → детектор речи (полоса голоса 160–4500 Гц) →
//   музыка, которая сама уступает речи → сумма → ограничитель пиков → общее затухание в конце.

import { SAMPLE_RATE } from "./styles";

/** Плавный вход по четверти синуса (равная мощность при встречном затухании). */
export const fadeCurve = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : Math.sin((x * Math.PI) / 2));

/** Кусочно-линейная огибающая: точки [сэмпл, значение] по возрастанию. */
export class Envelope {
  private index = 0;
  constructor(private readonly points: [number, number][]) {}

  /** Значение в позиции pos. Позиции нужно запрашивать по возрастанию. */
  at(pos: number): number {
    const p = this.points;
    if (p.length === 0) return 1;
    while (this.index < p.length - 2 && pos >= p[this.index + 1][0]) this.index++;
    const [x0, y0] = p[this.index];
    if (pos <= x0) return y0;
    const next = p[this.index + 1];
    if (!next) return y0;
    const [x1, y1] = next;
    if (pos >= x1) return y1;
    return y0 + ((y1 - y0) * (pos - x0)) / (x1 - x0);
  }
}

/** Фильтр второго порядка (RBJ): для полосы голоса в детекторе речи. */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private constructor(
    private b0: number,
    private b1: number,
    private b2: number,
    private a1: number,
    private a2: number,
  ) {}

  static highpass(freq: number, q = Math.SQRT1_2): Biquad {
    const w = (2 * Math.PI * freq) / SAMPLE_RATE;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    return new Biquad((1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  static lowpass(freq: number, q = Math.SQRT1_2): Biquad {
    const w = (2 * Math.PI * freq) / SAMPLE_RATE;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    return new Biquad((1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * Приглушение музыки под речь. Слушает звук клипов в полосе голоса и возвращает множитель громкости музыки:
 * 1 — тишина в кадре, около 0.15 — отчётливая речь. Реагирует быстро (40 мс), отпускает плавно (1 с).
 */
export class Ducker {
  private readonly hp = Biquad.highpass(160);
  private readonly lp = Biquad.lowpass(4500);
  private power = 0;
  private gain = 1;
  private readonly attack = Math.min(1, 1 / ((40 * SAMPLE_RATE) / 4000));
  private readonly release = Math.min(1, 1 / ((1000 * SAMPLE_RATE) / 4000));
  private static readonly THRESHOLD_DB = 20 * Math.log10(0.016);
  private static readonly RATIO = 4;
  private static readonly KNEE_DB = 6;

  /** Принимает очередной сэмпл звука клипов (моно) и отдаёт множитель для музыки. */
  next(sample: number): number {
    const band = this.lp.process(this.hp.process(sample));
    const sq = band * band;
    this.power += (sq - this.power) * (sq > this.power ? this.attack : this.release);
    return this.gain;
  }

  /** Пересчитывает множитель по накопленному уровню; достаточно вызывать раз в несколько сэмплов. */
  update(): void {
    const levelDb = 10 * Math.log10(this.power + 1e-12);
    const over = levelDb - Ducker.THRESHOLD_DB;
    const slope = 1 / Ducker.RATIO - 1;
    const half = Ducker.KNEE_DB / 2;
    let reductionDb = 0;
    if (over >= half) reductionDb = over * slope;
    else if (over > -half) reductionDb = (slope * (over + half) * (over + half)) / (2 * Ducker.KNEE_DB);
    this.gain = Math.pow(10, reductionDb / 20);
  }
}

/** Ограничитель пиков: громкие места не выходят за 0.95 и не искажаются на кодировщике. */
export class Limiter {
  private gain = 1;
  private readonly release = 1 - Math.exp(-1 / (0.08 * SAMPLE_RATE));
  constructor(private readonly limit = 0.95) {}

  /** Обрабатывает стереоблок на месте. */
  process(left: Float32Array, right: Float32Array): void {
    for (let i = 0; i < left.length; i++) {
      const peak = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      const wanted = peak > this.limit ? this.limit / peak : 1;
      // Вниз — мгновенно (пик не проскочит), вверх — плавно.
      this.gain = wanted < this.gain ? wanted : this.gain + (wanted - this.gain) * this.release;
      left[i] *= this.gain;
      right[i] *= this.gain;
    }
  }
}

/**
 * Потоковое приведение звука к 48 кГц (линейная интерполяция с сохранением фазы между кусками).
 * Телефоны обычно пишут 48 кГц, и тогда данные проходят как есть; пересчёт нужен, например, для 44,1 кГц.
 */
export class Resampler {
  private readonly step: number;
  /** Позиция следующего выходного сэмпла во входных сэмплах, относительно начала текущего куска. */
  private phase = 0;
  private lastL = 0;
  private lastR = 0;
  private primed = false;

  constructor(private readonly inputRate: number) {
    this.step = inputRate / SAMPLE_RATE;
  }

  get passthrough(): boolean {
    return this.inputRate === SAMPLE_RATE;
  }

  process(left: Float32Array, right: Float32Array): [Float32Array, Float32Array] {
    if (this.passthrough || left.length === 0) return [left, right];
    const n = left.length;
    // Сэмпл с индексом −1 — последний из предыдущего куска.
    const capacity = Math.max(0, Math.ceil((n - this.phase) / this.step)) + 2;
    const outL = new Float32Array(capacity);
    const outR = new Float32Array(capacity);
    let written = 0;
    let pos = this.phase;
    while (pos <= n - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const l0 = i >= 0 ? left[i] : this.primed ? this.lastL : left[0];
      const r0 = i >= 0 ? right[i] : this.primed ? this.lastR : right[0];
      const l1 = left[Math.min(n - 1, i + 1)];
      const r1 = right[Math.min(n - 1, i + 1)];
      outL[written] = l0 + (l1 - l0) * frac;
      outR[written] = r0 + (r1 - r0) * frac;
      written++;
      pos += this.step;
    }
    this.phase = pos - n;
    this.lastL = left[n - 1];
    this.lastR = right[n - 1];
    this.primed = true;
    return [outL.subarray(0, written), outR.subarray(0, written)];
  }
}

/** Очередь готовых сэмплов 48 кГц с позиционированием по времени: пропуски заполняются тишиной. */
export class SampleQueue {
  private chunks: { l: Float32Array; r: Float32Array; offset: number }[] = [];
  /** Сколько сэмплов уже выдано наружу. */
  private readPos = 0;
  /** Позиция конца последнего принятого куска. */
  private writePos = 0;

  get buffered(): number {
    return this.writePos - this.readPos;
  }

  /**
   * Добавляет кусок, который должен начинаться с позиции pos (в сэмплах от начала отрезка).
   * Небольшие расхождения (до 10 мс) игнорируются, большие — заполняются тишиной или обрезаются.
   */
  push(left: Float32Array, right: Float32Array, pos: number): void {
    let l = left;
    let r = right;
    let at = Math.round(pos);
    const drift = at - this.writePos;
    if (Math.abs(drift) <= SAMPLE_RATE / 100) at = this.writePos;
    if (at < this.readPos) {
      // Кусок начинается раньше, чем нужно (до начала отрезка) — отрезаем лишнее начало.
      const cut = this.readPos - at;
      if (cut >= l.length) return;
      l = l.subarray(cut);
      r = r.subarray(cut);
      at = this.readPos;
    }
    if (at < this.writePos) {
      const cut = this.writePos - at;
      if (cut >= l.length) return;
      l = l.subarray(cut);
      r = r.subarray(cut);
      at = this.writePos;
    }
    if (at > this.writePos) {
      const gap = at - this.writePos;
      this.chunks.push({ l: new Float32Array(gap), r: new Float32Array(gap), offset: 0 });
      this.writePos += gap;
    }
    if (l.length === 0) return;
    this.chunks.push({ l, r, offset: 0 });
    this.writePos += l.length;
  }

  /** Забирает до count сэмплов в начало массивов outL/outR; возвращает, сколько забрано. */
  pull(outL: Float32Array, outR: Float32Array, count: number): number {
    let done = 0;
    while (done < count && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const take = Math.min(count - done, chunk.l.length - chunk.offset);
      outL.set(chunk.l.subarray(chunk.offset, chunk.offset + take), done);
      outR.set(chunk.r.subarray(chunk.offset, chunk.offset + take), done);
      chunk.offset += take;
      done += take;
      if (chunk.offset >= chunk.l.length) this.chunks.shift();
    }
    this.readPos += done;
    return done;
  }
}

/** Источник звука для сведения: отдаёт следующие сэмплы подряд, тишину — если звука нет или он кончился. */
export interface AudioReader {
  /** Заполняет outL/outR (длина count) следующими сэмплами отрезка. */
  read(outL: Float32Array, outR: Float32Array, count: number): Promise<void>;
  close(): void;
}

export const silentReader: AudioReader = {
  async read(outL, outR, count) {
    outL.fill(0, 0, count);
    outR.fill(0, 0, count);
  },
  close() {},
};

export interface ClipTrack {
  /** Начало и длина на линии времени фильма, в сэмплах. */
  start: number;
  length: number;
  /** Длина плавного входа и выхода (переходы с соседями), в сэмплах. */
  fadeIn: number;
  fadeOut: number;
  open(): Promise<AudioReader>;
}

export interface MusicTrackSpec {
  /** Начало на линии времени фильма и длина композиции, в сэмплах. */
  start: number;
  length: number;
  open(): Promise<AudioReader>;
}

export interface MixSpec {
  totalSamples: number;
  clips: ClipTrack[];
  music: MusicTrackSpec[];
  /** Громкость музыки из настроек, 0…1. */
  musicVolume: number;
  /** Перекрытие соседних композиций, в сэмплах. */
  crossfade: number;
}

/** Расставляет композиции плейлиста друг за другом с перекрытием crossfade. */
export function layoutMusic<T extends { durationSec: number }>(
  playlist: T[],
  totalSamples: number,
  crossfade: number,
): { track: T; start: number; length: number }[] {
  const out: { track: T; start: number; length: number }[] = [];
  let cursor = 0;
  for (const track of playlist) {
    if (cursor >= totalSamples) break;
    const length = Math.max(1, Math.floor(track.durationSec * SAMPLE_RATE));
    out.push({ track, start: cursor, length });
    cursor += Math.max(1, length - crossfade);
  }
  return out;
}

interface Active {
  reader: AudioReader;
  start: number;
  length: number;
}

/**
 * Сводит звук фильма блок за блоком. Память не растёт с длиной фильма:
 * одновременно открыты только те клипы и композиции, которые звучат прямо сейчас.
 */
export class Mixer {
  private position = 0;
  private readonly ducker = new Ducker();
  private readonly limiter = new Limiter();
  private readonly musicGain: Envelope;
  private readonly masterGain: Envelope;
  private readonly activeClips = new Map<ClipTrack, Active>();
  private readonly activeMusic = new Map<MusicTrackSpec, Active>();
  private scratchL = new Float32Array(0);
  private scratchR = new Float32Array(0);
  private musicL = new Float32Array(0);
  private musicR = new Float32Array(0);

  constructor(private readonly spec: MixSpec) {
    const total = spec.totalSamples;
    // Громкость 0…1 из настроек → усиление; 0.5 даёт спокойный фон.
    const gain = 1.2 * Math.pow(Math.min(1, Math.max(0, spec.musicVolume)), 1.5);
    const fadeIn = Math.min(Math.round(1.4 * SAMPLE_RATE), Math.floor(total / 3));
    const fadeOutStart = Math.max(fadeIn, total - Math.round(3.4 * SAMPLE_RATE));
    this.musicGain = new Envelope([
      [0, 0],
      [fadeIn, gain],
      [fadeOutStart, gain],
      [total, 0],
    ]);
    const endFade = Math.max(0, total - Math.round(1.2 * SAMPLE_RATE));
    this.masterGain = new Envelope([
      [0, 1],
      [endFade, 1],
      [total, 0],
    ]);
  }

  get done(): boolean {
    return this.position >= this.spec.totalSamples;
  }

  private ensure(size: number): void {
    if (this.scratchL.length >= size) return;
    this.scratchL = new Float32Array(size);
    this.scratchR = new Float32Array(size);
    this.musicL = new Float32Array(size);
    this.musicR = new Float32Array(size);
  }

  /** Сводит следующие count сэмплов (в конце фильма — сколько осталось). */
  async next(count: number): Promise<{ left: Float32Array; right: Float32Array }> {
    const from = this.position;
    const to = Math.min(this.spec.totalSamples, from + count);
    const n = to - from;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    this.ensure(n);
    const { scratchL, scratchR, musicL, musicR } = this;
    musicL.fill(0, 0, n);
    musicR.fill(0, 0, n);

    // Клипы: каждый читается со своего места и входит/выходит плавно на переходах.
    for (const clip of this.spec.clips) {
      const end = clip.start + clip.length;
      if (end <= from || clip.start >= to) continue;
      let active = this.activeClips.get(clip);
      if (!active) {
        active = { reader: await clip.open(), start: clip.start, length: clip.length };
        this.activeClips.set(clip, active);
      }
      const a = Math.max(from, clip.start);
      const b = Math.min(to, end);
      const len = b - a;
      await active.reader.read(scratchL, scratchR, len);
      for (let i = 0; i < len; i++) {
        const local = a + i - clip.start;
        let g = 1;
        if (clip.fadeIn > 0 && local < clip.fadeIn) g = fadeCurve(local / clip.fadeIn);
        const tail = clip.length - local;
        if (clip.fadeOut > 0 && tail < clip.fadeOut) g *= fadeCurve(tail / clip.fadeOut);
        left[a - from + i] += scratchL[i] * g;
        right[a - from + i] += scratchR[i] * g;
      }
      if (b >= end) {
        active.reader.close();
        this.activeClips.delete(clip);
      }
    }

    // Музыка: композиции плавно сменяют друг друга.
    const xf = this.spec.crossfade;
    for (let k = 0; k < this.spec.music.length; k++) {
      const track = this.spec.music[k];
      const end = track.start + track.length;
      if (end <= from || track.start >= to) continue;
      let active = this.activeMusic.get(track);
      if (!active) {
        active = { reader: await track.open(), start: track.start, length: track.length };
        this.activeMusic.set(track, active);
      }
      const a = Math.max(from, track.start);
      const b = Math.min(to, end);
      const len = b - a;
      await active.reader.read(scratchL, scratchR, len);
      const first = k === 0;
      const last = k === this.spec.music.length - 1;
      for (let i = 0; i < len; i++) {
        const local = a + i - track.start;
        let g = 1;
        if (!first && local < xf) g = local / xf;
        const tail = track.length - local;
        if (!last && tail < xf) g *= tail / xf;
        musicL[a - from + i] += scratchL[i] * g;
        musicR[a - from + i] += scratchR[i] * g;
      }
      if (b >= end) {
        active.reader.close();
        this.activeMusic.delete(track);
      }
    }

    // Музыка уступает речи; затем сумма, ограничитель и общее затухание в конце.
    const hasMusic = this.spec.music.length > 0;
    for (let i = 0; i < n; i++) {
      const duck = this.ducker.next((left[i] + right[i]) * 0.5);
      if ((i & 7) === 0) this.ducker.update();
      if (hasMusic) {
        const g = this.musicGain.at(from + i) * duck;
        left[i] += musicL[i] * g;
        right[i] += musicR[i] * g;
      }
    }
    this.limiter.process(left, right);
    for (let i = 0; i < n; i++) {
      const g = this.masterGain.at(from + i);
      if (g !== 1) {
        left[i] *= g;
        right[i] *= g;
      }
    }

    this.position = to;
    return { left, right };
  }

  close(): void {
    for (const a of this.activeClips.values()) a.reader.close();
    for (const a of this.activeMusic.values()) a.reader.close();
    this.activeClips.clear();
    this.activeMusic.clear();
  }
}
