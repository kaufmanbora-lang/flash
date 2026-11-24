// Небольшой программный синтезатор: инструменты и эффекты для музыкального оформления фильмов.
// Всё считается «в числах» (48 кГц, стерео) без семплов и сторонних записей — поэтому музыка
// полностью оригинальная и её можно свободно использовать в экспортируемых фильмах.

export const SR = 48_000;
const TAU = Math.PI * 2;

export const mtof = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Детерминированный генератор случайных чисел: одна и та же композиция получается при каждом запуске. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let noise: () => number = mulberry32(1);
export function seedNoise(seed: number): void {
  noise = mulberry32(seed ^ 0x9e3779b9);
}

export class Stereo {
  readonly L: Float32Array;
  readonly R: Float32Array;
  constructor(public readonly length: number) {
    this.L = new Float32Array(length);
    this.R = new Float32Array(length);
  }
}

/** Рабочий буфер одной ноты (до 24 секунд). */
const scratch = new Float32Array(SR * 24);

export interface NoteOptions {
  /** −1 (слева) … 1 (справа). */
  pan?: number;
  /** Доля сигнала, уходящая в реверберацию. */
  send?: number;
  /** Доля сигнала, уходящая в эхо. */
  dly?: number;
}

export class Mixer {
  readonly length: number;
  readonly dry: Stereo;
  readonly rev: Stereo;
  readonly dly: Stereo;

  constructor(seconds: number) {
    this.length = Math.ceil(seconds * SR);
    this.dry = new Stereo(this.length);
    this.rev = new Stereo(this.length);
    this.dly = new Stereo(this.length);
  }

  /** Добавляет моно-сигнал из рабочего буфера в общий микс с панорамой и посылами на эффекты. */
  add(src: Float32Array, n: number, start: number, gain: number, pan: number, revSend: number, dlySend: number): void {
    const angle = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
    const gl = gain * Math.cos(angle);
    const gr = gain * Math.sin(angle);
    const from = Math.max(0, start);
    const to = Math.min(this.length, start + n);
    const { L, R } = this.dry;
    const rl = this.rev.L;
    const rr = this.rev.R;
    const dl = this.dly.L;
    const dr = this.dly.R;
    for (let i = from, j = from - start; i < to; i++, j++) {
      const s = src[j];
      const l = s * gl;
      const r = s * gr;
      L[i] += l;
      R[i] += r;
      if (revSend > 0) {
        rl[i] += l * revSend;
        rr[i] += r * revSend;
      }
      if (dlySend > 0) {
        dl[i] += l * dlySend;
        dr[i] += r * dlySend;
      }
    }
  }
}

// ── Строительные блоки ───────────────────────────────────────

interface Partial {
  f: number;
  a: number;
  /** Время затухания в секундах. */
  tau: number;
}

/**
 * Банк затухающих резонаторов: каждая гармоника — рекуррентное уравнение второго порядка
 * y[n] = 2r·cos(w)·y[n−1] − r²·y[n−2]. Ни одного вызова sin() в цикле.
 */
function resonators(out: Float32Array, n: number, parts: Partial[]): void {
  out.fill(0, 0, n);
  for (const p of parts) {
    const w = (TAU * p.f) / SR;
    if (w >= Math.PI * 0.92 || p.a === 0) continue;
    const r = Math.exp(-1 / (p.tau * SR));
    const a1 = 2 * r * Math.cos(w);
    const a2 = -r * r;
    let y1 = (p.a * Math.sin(-w)) / r;
    let y2 = (p.a * Math.sin(-2 * w)) / (r * r);
    for (let i = 0; i < n; i++) {
      const y = a1 * y1 + a2 * y2;
      y2 = y1;
      y1 = y;
      out[i] += y;
    }
  }
}

function fadeIn(buf: Float32Array, n: number, seconds: number): void {
  const m = Math.min(n, Math.max(1, Math.floor(seconds * SR)));
  for (let i = 0; i < m; i++) buf[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / m);
}

function fadeOutEnd(buf: Float32Array, n: number, seconds: number): void {
  const m = Math.min(n, Math.max(1, Math.floor(seconds * SR)));
  for (let i = 0; i < m; i++) buf[n - 1 - i] *= i / m;
}

/** Экспоненциальное глушение после отпускания ноты. */
function release(buf: Float32Array, n: number, holdSec: number, tauSec: number): void {
  const from = Math.floor(holdSec * SR);
  if (from >= n) return;
  const k = Math.exp(-1 / (tauSec * SR));
  let g = 1;
  for (let i = Math.max(0, from); i < n; i++) {
    g *= k;
    buf[i] *= g;
  }
}

function noteLength(seconds: number): number {
  return Math.max(64, Math.min(scratch.length, Math.floor(seconds * SR)));
}

// ── Инструменты ──────────────────────────────────────────────

/** Мягкое фортепиано: негармоничные обертоны, две слегка расстроенные «струны», демпфер. */
export function piano(mx: Mixer, t: number, midi: number, dur: number, vel: number, o: NoteOptions & { soft?: number } = {}): void {
  const f = mtof(midi);
  const tau0 = Math.min(6.5, 2.4 * Math.pow(261.63 / f, 0.5));
  const hold = Math.max(0.08, dur);
  const n = noteLength(Math.min(hold + 0.6, tau0 * 5.5));
  const inharm = 0.00035;
  const tilt = 1.25 + (1 - vel) * 0.9 + (o.soft ?? 0);
  const maxK = Math.max(1, Math.min(14, Math.floor(6500 / f)));
  const parts: Partial[] = [];
  for (let k = 1; k <= maxK; k++) {
    const fk = f * k * Math.sqrt(1 + inharm * k * k);
    const amp = Math.pow(k, -tilt) * (k % 7 === 0 ? 0.45 : 1);
    const tau = tau0 / (1 + 0.38 * (k - 1));
    parts.push({ f: fk * 1.00025, a: amp * 0.5, tau }, { f: fk * 0.99975, a: amp * 0.5, tau: tau * 1.08 });
  }
  resonators(scratch, n, parts);
  fadeIn(scratch, n, 0.004);
  release(scratch, n, hold, 0.16);
  fadeOutEnd(scratch, n, 0.03);
  const comp = clamp(Math.pow(f / 261.63, 0.25), 0.72, 1.3);
  const pan = o.pan ?? clamp((midi - 62) / 40, -0.45, 0.45);
  mx.add(scratch, n, Math.round(t * SR), vel * 0.5 * comp, pan, o.send ?? 0.26, o.dly ?? 0);
}

export interface PadOptions extends NoteOptions {
  attack?: number;
  release?: number;
  harmonics?: number;
  /** Спад обертонов: больше — темнее. */
  rolloff?: number;
  /** Расстройка голосов ансамбля в центах. */
  voices?: number[];
  width?: number;
  lfoDepth?: number;
  gain?: number;
}

/** Пэд / струнный ансамбль: несколько расстроенных голосов с медленной атакой. */
export function pad(mx: Mixer, t: number, midis: number[], dur: number, vel: number, o: PadOptions = {}): void {
  const attack = o.attack ?? 1.2;
  const rel = o.release ?? 2.0;
  const n = noteLength(dur + rel);
  const K = o.harmonics ?? 5;
  const roll = o.rolloff ?? 1.7;
  const voices = o.voices ?? [-6, 0, 6];
  const weights: number[] = [0, 1];
  for (let k = 2; k <= K; k++) weights.push(Math.pow(k, -roll));
  const atkN = Math.max(1, Math.floor(attack * SR));
  const relStart = Math.floor(dur * SR);
  const relN = Math.max(1, n - relStart);
  const depth = o.lfoDepth ?? 0.12;
  const start = Math.round(t * SR);

  for (const midi of midis) {
    for (let v = 0; v < voices.length; v++) {
      const f = mtof(midi) * Math.pow(2, voices[v] / 1200);
      const kmax = Math.max(1, Math.min(K, Math.floor(9000 / f)));
      const d = (TAU * f) / SR;
      const cd = Math.cos(d);
      const sd = Math.sin(d);
      const ph = noise() * TAU;
      let c = Math.cos(ph);
      let s = Math.sin(ph);
      const lfoRate = 0.09 + noise() * 0.12;
      const lfoPhase = noise() * TAU;
      let lfo = 1;
      for (let i = 0; i < n; i++) {
        // Поворот фазора вместо sin/cos на каждом сэмпле.
        const c2 = c * cd - s * sd;
        s = s * cd + c * sd;
        c = c2;
        if ((i & 1023) === 0) {
          const m = 1 / Math.hypot(c, s);
          c *= m;
          s *= m;
        }
        if ((i & 63) === 0) lfo = 1 - depth * (0.5 - 0.5 * Math.cos((TAU * lfoRate * i) / SR + lfoPhase));
        // sin(kθ) по рекуррентной формуле Чебышёва.
        let sum = s;
        let hm2 = 0;
        let hm1 = s;
        const tc = 2 * c;
        for (let k = 2; k <= kmax; k++) {
          const h = tc * hm1 - hm2;
          sum += h * weights[k];
          hm2 = hm1;
          hm1 = h;
        }
        let env = i < atkN ? 0.5 - 0.5 * Math.cos((Math.PI * i) / atkN) : 1;
        if (i >= relStart) env *= 0.5 + 0.5 * Math.cos((Math.PI * (i - relStart)) / relN);
        scratch[i] = sum * env * lfo;
      }
      const pan = (voices.length > 1 ? (v / (voices.length - 1)) * 2 - 1 : 0) * (o.width ?? 0.7) + (o.pan ?? 0);
      mx.add(scratch, n, start, (vel * (o.gain ?? 0.16)) / Math.sqrt(voices.length), pan, o.send ?? 0.45, o.dly ?? 0);
    }
  }
}

/** Щипковая струна (алгоритм Карплуса — Стронга с точной настройкой): гитара, укулеле, арфа. */
export function pluck(
  mx: Mixer,
  t: number,
  midi: number,
  dur: number,
  vel: number,
  o: NoteOptions & { bright?: number; sustain?: number } = {},
): void {
  const f = mtof(midi);
  const period = SR / f;
  const bright = clamp(o.bright ?? 0.3, 0, 1);
  const s = 0.5 - 0.36 * bright;
  const N = Math.max(2, Math.floor(period - s - 0.1));
  const frac = period - s - N;
  const C = (1 - frac) / (1 + frac);
  const t60 = clamp(3.6 * Math.pow(220 / f, 0.4) * (o.sustain ?? 1), 0.7, 7);
  const rho = Math.pow(10, -3 / (f * t60));
  const hold = Math.max(0.05, dur);
  const n = noteLength(Math.min(hold + 0.4, t60 * 1.1));

  // Возбуждение: короткий шум, смягчённый фильтром (чем тише нота, тем мягче щипок).
  const line = new Float32Array(N);
  const coef = 0.18 + 0.55 * vel * (0.4 + 0.6 * bright);
  let lp = 0;
  let mean = 0;
  for (let i = 0; i < N; i++) {
    lp += (noise() * 2 - 1 - lp) * coef;
    line[i] = lp;
    mean += lp;
  }
  mean /= N;
  let peak = 1e-6;
  for (let i = 0; i < N; i++) {
    line[i] -= mean;
    peak = Math.max(peak, Math.abs(line[i]));
  }
  for (let i = 0; i < N; i++) line[i] /= peak;

  const relStart = Math.floor(hold * SR);
  const damp = rho * Math.exp(-period / (0.1 * SR));
  let idx = 0;
  let apX = 0;
  let apY = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const x = line[idx];
    const ap = C * x + apX - C * apY;
    apX = x;
    apY = ap;
    const y = (1 - s) * ap + s * prev;
    prev = ap;
    line[idx] = y * (i < relStart ? rho : damp);
    if (++idx >= N) idx = 0;
    scratch[i] = x;
  }
  fadeIn(scratch, n, 0.0015);
  fadeOutEnd(scratch, n, 0.03);
  const pan = o.pan ?? clamp((midi - 60) / 36, -0.5, 0.5);
  mx.add(scratch, n, Math.round(t * SR), vel * 0.55, pan, o.send ?? 0.22, o.dly ?? 0);
}

/** Колокольчик: музыкальная шкатулка или глокеншпиль. */
export function bell(
  mx: Mixer,
  t: number,
  midi: number,
  vel: number,
  o: NoteOptions & { decay?: number; kind?: "box" | "glock" } = {},
): void {
  const f = mtof(midi);
  const tau = (o.decay ?? 1.3) * Math.pow(523.25 / f, 0.35);
  const parts: Partial[] =
    o.kind === "glock"
      ? [
          { f, a: 1, tau },
          { f: f * 2.756, a: 0.3, tau: tau * 0.45 },
          { f: f * 5.404, a: 0.12, tau: tau * 0.22 },
          { f: f * 8.933, a: 0.05, tau: tau * 0.12 },
        ]
      : [
          { f, a: 1, tau },
          { f: f * 2.0, a: 0.14, tau: tau * 0.6 },
          { f: f * 3.01, a: 0.07, tau: tau * 0.4 },
          { f: f * 6.27, a: 0.08, tau: tau * 0.12 },
        ];
  const n = noteLength(tau * 6);
  resonators(scratch, n, parts);
  fadeIn(scratch, n, 0.001);
  fadeOutEnd(scratch, n, 0.05);
  mx.add(scratch, n, Math.round(t * SR), vel * 0.34, o.pan ?? clamp((midi - 76) / 30, -0.5, 0.5), o.send ?? 0.4, o.dly ?? 0);
}

/** Тёплый бас. */
export function bass(mx: Mixer, t: number, midi: number, dur: number, vel: number, o: NoteOptions = {}): void {
  const f = mtof(midi);
  const n = noteLength(dur + 0.2);
  resonators(scratch, n, [
    { f, a: 1, tau: 1.5 },
    { f: f * 2, a: 0.3, tau: 0.7 },
    { f: f * 3, a: 0.09, tau: 0.35 },
  ]);
  fadeIn(scratch, n, 0.012);
  release(scratch, n, dur, 0.05);
  fadeOutEnd(scratch, n, 0.02);
  mx.add(scratch, n, Math.round(t * SR), vel * 0.5, o.pan ?? 0, o.send ?? 0.06, 0);
}

/** Шейкер: короткий всплеск высокочастотного шума. */
export function shaker(mx: Mixer, t: number, vel: number, pan = 0.3): void {
  const n = noteLength(0.09);
  let prev = 0;
  const tau = 0.02 * SR;
  for (let i = 0; i < n; i++) {
    const x = noise() * 2 - 1;
    scratch[i] = (x - prev) * Math.exp(-i / tau);
    prev = x;
  }
  fadeIn(scratch, n, 0.002);
  mx.add(scratch, n, Math.round(t * SR), vel * 0.1, pan, 0.14, 0);
}

/** Мягкая «бочка». */
export function kick(mx: Mixer, t: number, vel: number): void {
  const n = noteLength(0.36);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = 46 + 78 * Math.exp(-i / (0.024 * SR));
    ph += (TAU * f) / SR;
    scratch[i] = Math.sin(ph) * Math.exp(-i / (0.1 * SR));
  }
  fadeIn(scratch, n, 0.002);
  fadeOutEnd(scratch, n, 0.02);
  mx.add(scratch, n, Math.round(t * SR), vel * 0.5, 0, 0.04, 0);
}

/** Едва слышный треск винила для стиля Nostalgia. */
export function crackle(mx: Mixer, fromSec: number, toSec: number, level: number): void {
  const from = Math.max(0, Math.floor(fromSec * SR));
  const to = Math.min(mx.length, Math.floor(toSec * SR));
  let lpL = 0;
  let lpR = 0;
  for (let i = from; i < to; i++) {
    let x = 0;
    if (noise() < 0.00035) x = (noise() * 2 - 1) * (0.4 + noise() * 0.6);
    const hiss = (noise() * 2 - 1) * 0.012;
    lpL += (x + hiss - lpL) * 0.35;
    lpR += (x * 0.7 + hiss - lpR) * 0.3;
    mx.dry.L[i] += lpL * level;
    mx.dry.R[i] += lpR * level;
  }
}

// ── Эффекты ──────────────────────────────────────────────────

function onePoleLow(buf: Float32Array, hz: number): void {
  const a = 1 - Math.exp((-TAU * hz) / SR);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += (buf[i] - y) * a;
    buf[i] = y;
  }
}

function onePoleHigh(buf: Float32Array, hz: number): void {
  const a = 1 - Math.exp((-TAU * hz) / SR);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += (buf[i] - y) * a;
    buf[i] -= y;
  }
}

export interface ReverbOptions {
  /** 0…1 — размер помещения. */
  size: number;
  /** 0…1 — поглощение высоких частот. */
  damp: number;
  predelay?: number;
}

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];

/** Реверберация по схеме Freeverb: 8 гребенчатых фильтров и 4 фазовых на канал. */
export function reverb(input: Stereo, o: ReverbOptions): Stereo {
  const n = input.length;
  const out = new Stereo(n);
  // Посыл очищается от гула и резких верхов — так хвост звучит мягче.
  onePoleHigh(input.L, 170);
  onePoleHigh(input.R, 170);
  onePoleLow(input.L, 5200);
  onePoleLow(input.R, 5200);

  const scale = SR / 44_100;
  const feedback = 0.72 + 0.26 * clamp(o.size, 0, 1);
  const damp1 = clamp(o.damp, 0, 1) * 0.4;
  const damp2 = 1 - damp1;
  const pre = Math.floor((o.predelay ?? 0.02) * SR);

  for (let ch = 0; ch < 2; ch++) {
    const dst = ch === 0 ? out.L : out.R;
    const spread = ch === 0 ? 0 : 23;
    const combBuf = COMBS.map((t) => new Float32Array(Math.round((t + spread) * scale)));
    const combIdx = new Int32Array(COMBS.length);
    const combStore = new Float64Array(COMBS.length);
    const apBuf = ALLPASSES.map((t) => new Float32Array(Math.round((t + spread) * scale)));
    const apIdx = new Int32Array(ALLPASSES.length);
    for (let i = 0; i < n; i++) {
      const j = i - pre;
      const x = j >= 0 ? (input.L[j] + input.R[j]) * 0.015 : 0;
      let acc = 0;
      for (let c = 0; c < combBuf.length; c++) {
        const buf = combBuf[c];
        const k = combIdx[c];
        const y = buf[k];
        const store = y * damp2 + combStore[c] * damp1;
        combStore[c] = store;
        buf[k] = x + store * feedback;
        combIdx[c] = k + 1 >= buf.length ? 0 : k + 1;
        acc += y;
      }
      for (let a = 0; a < apBuf.length; a++) {
        const buf = apBuf[a];
        const k = apIdx[a];
        const y = buf[k];
        buf[k] = acc + y * 0.5;
        apIdx[a] = k + 1 >= buf.length ? 0 : k + 1;
        acc = y - acc;
      }
      dst[i] = acc;
    }
  }
  return out;
}

/** Стерео-эхо «пинг-понг» с затуханием и смягчением повторов. */
export function pingPong(input: Stereo, timeSec: number, feedback: number): Stereo {
  const n = input.length;
  const out = new Stereo(n);
  const d = Math.max(1, Math.floor(timeSec * SR));
  const bufL = new Float32Array(d);
  const bufR = new Float32Array(d);
  let idx = 0;
  let lpL = 0;
  let lpR = 0;
  for (let i = 0; i < n; i++) {
    const dl = bufL[idx];
    const dr = bufR[idx];
    lpL += (dl - lpL) * 0.35;
    lpR += (dr - lpR) * 0.35;
    out.L[i] = lpL;
    out.R[i] = lpR;
    // Левый канал питает правый и наоборот.
    bufL[idx] = input.L[i] + lpR * feedback;
    bufR[idx] = input.R[i] * 0.6 + lpL * feedback;
    if (++idx >= d) idx = 0;
  }
  return out;
}

export interface MasterOptions {
  reverb: ReverbOptions;
  wet: number;
  delay?: { time: number; feedback: number; wet: number };
  /** Общий срез высоких частот («старая плёнка»). */
  lowpassHz?: number;
  fadeIn?: number;
  fadeOut?: number;
  /** Целевой средний уровень (RMS), по умолчанию около −19 дБ. */
  targetRms?: number;
}

/** Сводит дорожки и эффекты, выравнивает громкость и мягко ограничивает пики. */
export function master(mx: Mixer, o: MasterOptions): Stereo {
  const n = mx.length;
  const out = new Stereo(n);
  out.L.set(mx.dry.L);
  out.R.set(mx.dry.R);

  if (o.delay) {
    const echo = pingPong(mx.dly, o.delay.time, o.delay.feedback);
    for (let i = 0; i < n; i++) {
      out.L[i] += echo.L[i] * o.delay.wet;
      out.R[i] += echo.R[i] * o.delay.wet;
      // Эхо тоже отправляется в реверберацию — так оно «растворяется» в пространстве.
      mx.rev.L[i] += echo.L[i] * o.delay.wet * 0.5;
      mx.rev.R[i] += echo.R[i] * o.delay.wet * 0.5;
    }
  }
  const wet = reverb(mx.rev, o.reverb);
  for (let i = 0; i < n; i++) {
    out.L[i] += wet.L[i] * o.wet;
    out.R[i] += wet.R[i] * o.wet;
  }

  onePoleHigh(out.L, 28);
  onePoleHigh(out.R, 28);
  if (o.lowpassHz) {
    onePoleLow(out.L, o.lowpassHz);
    onePoleLow(out.R, o.lowpassHz);
  }

  const fin = Math.floor((o.fadeIn ?? 0.4) * SR);
  const fout = Math.floor((o.fadeOut ?? 4.5) * SR);
  for (let i = 0; i < Math.min(fin, n); i++) {
    const g = i / fin;
    out.L[i] *= g;
    out.R[i] *= g;
  }
  for (let i = 0; i < Math.min(fout, n); i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fout);
    out.L[n - 1 - i] *= g;
    out.R[n - 1 - i] *= g;
  }

  let sum = 0;
  let peak = 1e-9;
  for (let i = 0; i < n; i++) {
    const l = out.L[i];
    const r = out.R[i];
    sum += l * l + r * r;
    const p = Math.max(Math.abs(l), Math.abs(r));
    if (p > peak) peak = p;
  }
  const rms = Math.sqrt(sum / (2 * n)) || 1e-9;
  const gain = Math.min((o.targetRms ?? 0.11) / rms, (0.89 / peak) * 1.8);
  // Мягкий ограничитель: до 0.6 сигнал не меняется, выше — плавно прижимается к 0.89.
  const knee = 0.6;
  const room = 0.29;
  const limit = (x: number) => {
    const a = Math.abs(x);
    if (a <= knee) return x;
    return Math.sign(x) * (knee + room * Math.tanh((a - knee) / room));
  };
  for (let i = 0; i < n; i++) {
    out.L[i] = limit(out.L[i] * gain);
    out.R[i] = limit(out.R[i] * gain);
  }
  return out;
}

/** WAV 16 бит стерео. */
export function encodeWav(audio: Stereo): Buffer {
  const n = audio.length;
  const data = Buffer.alloc(44 + n * 4);
  data.write("RIFF", 0, "ascii");
  data.writeUInt32LE(36 + n * 4, 4);
  data.write("WAVE", 8, "ascii");
  data.write("fmt ", 12, "ascii");
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36, "ascii");
  data.writeUInt32LE(n * 4, 40);
  let off = 44;
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(clamp(audio.L[i], -1, 1) * 32767), off);
    data.writeInt16LE(Math.round(clamp(audio.R[i], -1, 1) * 32767), off + 2);
    off += 4;
  }
  return data;
}

/** Показатели готовой дорожки — для самопроверки генератора. */
export function measure(audio: Stereo): { peak: number; rms: number; silentTail: boolean } {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < audio.length; i++) {
    const l = audio.L[i];
    const r = audio.R[i];
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    sum += l * l + r * r;
  }
  const tail = Math.max(0, audio.length - Math.floor(0.05 * SR));
  let tailPeak = 0;
  for (let i = tail; i < audio.length; i++) tailPeak = Math.max(tailPeak, Math.abs(audio.L[i]), Math.abs(audio.R[i]));
  return { peak, rms: Math.sqrt(sum / (2 * audio.length || 1)), silentTail: tailPeak < 0.01 };
}
