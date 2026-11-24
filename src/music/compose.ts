// Композитор: по номеру-зерну сочиняет оригинальную пьесу в одном из семи стилей.
// Гармония, ритм и мелодия строятся по правилам (тональность, аккордовые последовательности,
// плавное голосоведение, повторяющиеся мотивы), поэтому каждая композиция уникальна и при этом
// музыкальна. Результат детерминирован: одно зерно — одна и та же пьеса.

import type { MusicStyleId } from "@/lib/constants";
import {
  bass,
  bell,
  crackle,
  kick,
  master,
  Mixer,
  mulberry32,
  pad,
  piano,
  pluck,
  seedNoise,
  shaker,
  SR,
  type MasterOptions,
  type Stereo,
} from "./synth";

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface SessionOptions {
  seed: number;
  bpm: number;
  beatsPerBar: number;
  bars: number;
  /** MIDI-нота тоники (до малой октавы = 48). */
  key: number;
  mode: "major" | "minor";
  tail?: number;
}

class Session {
  readonly mx: Mixer;
  readonly rng: () => number;
  /** Длительность одной доли в секундах. */
  readonly beat: number;
  readonly scale: number[];

  constructor(readonly o: SessionOptions) {
    this.rng = mulberry32(o.seed);
    seedNoise(o.seed);
    this.beat = 60 / o.bpm;
    this.scale = o.mode === "major" ? MAJOR : MINOR;
    this.mx = new Mixer(0.3 + o.bars * o.beatsPerBar * this.beat + (o.tail ?? 7));
  }

  /** Время (с) для позиции в долях от начала пьесы. */
  at(beats: number): number {
    return 0.3 + beats * this.beat;
  }
  bar(n: number): number {
    return n * this.o.beatsPerBar;
  }
  jitter(amount = 0.008): number {
    return (this.rng() - 0.5) * 2 * amount;
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.min(list.length - 1, Math.floor(this.rng() * list.length))];
  }
  /** Смещение ступени лада от тоники в полутонах; ступень может быть любым целым. */
  deg(degree: number): number {
    const n = this.scale.length;
    return this.scale[((degree % n) + n) % n] + 12 * Math.floor(degree / n);
  }
  /** Интервал от основного тона аккорда до его терции (step = 2) или квинты (step = 4). */
  interval(degree: number, step: number): number {
    return this.deg(degree + step) - this.deg(degree);
  }
  private pcsOf(degree: number, ext: number): Set<number> {
    const tones = [this.deg(degree), this.deg(degree + 2), this.deg(degree + 4)];
    if (ext >= 7) tones.push(this.deg(degree + 6));
    if (ext >= 9) tones.push(this.deg(degree + 8));
    return new Set(tones.map((p) => ((p % 12) + 12) % 12));
  }
  chordPitches(degree: number, lo: number, hi: number, ext = 0): number[] {
    const pcs = this.pcsOf(degree, ext);
    const out: number[] = [];
    for (let m = lo; m <= hi; m++) if (pcs.has((((m - this.o.key) % 12) + 12) % 12)) out.push(m);
    return out;
  }
  scalePitches(lo: number, hi: number): number[] {
    const pcs = new Set(this.scale);
    const out: number[] = [];
    for (let m = lo; m <= hi; m++) if (pcs.has((((m - this.o.key) % 12) + 12) % 12)) out.push(m);
    return out;
  }
  /** Основной тон аккорда в басовом регистре: самая низкая нота не ниже lo. */
  root(degree: number, lo: number): number {
    let m = this.o.key + this.deg(((degree % 7) + 7) % 7);
    while (m - 12 >= lo) m -= 12;
    while (m < lo) m += 12;
    return m;
  }
  /** Расположение аккорда около center с минимальным движением голосов от предыдущего аккорда. */
  voicing(degree: number, center: number, count: number, prev?: number[], ext = 0): number[] {
    const pitches = this.chordPitches(degree, center - 11, center + 12, ext);
    let best = pitches.slice(0, count);
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i + count <= pitches.length; i++) {
      const w = pitches.slice(i, i + count);
      let cost: number;
      if (prev && prev.length === count) cost = w.reduce((s, p, k) => s + Math.abs(p - prev[k]), 0);
      else cost = Math.abs(w.reduce((s, p) => s + p, 0) / count - center);
      if (cost < bestCost) {
        bestCost = cost;
        best = w;
      }
    }
    return best;
  }
}

// ── Мелодия ──────────────────────────────────────────────────

interface MNote {
  beat: number;
  len: number;
  /** Нота обязана быть аккордовым звуком (сильная доля). */
  chord: boolean;
  /** Высота внутри диапазона: −1 … 1. */
  h: number;
}

/** Ритмические ячейки на такт; отрицательное число — пауза. */
const CELLS_4_SLOW = [[2, 2], [3, 1], [1, 1, 2], [2, 1, 1], [4], [1.5, 0.5, 2], [1, 3], [-1, 1, 2], [2, -1, 1]];
const CELLS_4_MED = [
  [1, 1, 1, 1], [1.5, 0.5, 1, 1], [1, 0.5, 0.5, 2], [0.5, 0.5, 1, 2],
  [1, 1, 0.5, 0.5, 1], [-0.5, 0.5, 1, 2], [2, 1, 1], [1, 1, 2],
];
const CELLS_3 = [[3], [2, 1], [1, 2], [1, 1, 1], [1.5, 0.5, 1], [2, 0.5, 0.5], [-1, 1, 1]];

function makeMotif(s: Session, cells: number[][], bars: number, strongEvery: number): MNote[] {
  const notes: MNote[] = [];
  let h = (s.rng() - 0.5) * 0.6;
  for (let b = 0; b < bars; b++) {
    const cell = s.pick(cells);
    let pos = 0;
    for (const len of cell) {
      const L = Math.abs(len);
      if (len > 0) {
        const strong = Math.abs(pos % strongEvery) < 1e-6;
        h = clamp(h + (s.rng() - 0.5) * 0.7, -1, 1);
        notes.push({ beat: b * s.o.beatsPerBar + pos, len: L, chord: strong || s.rng() < 0.35, h });
      }
      pos += L;
    }
  }
  if (notes.length > 0) notes[notes.length - 1].chord = true;
  return notes;
}

/** Проигрывает мотив, подстраивая ноты под звучащий аккорд; возвращает последнюю высоту. */
function playMelody(
  s: Session,
  motif: MNote[],
  startBeat: number,
  degreeAt: (beatInMotif: number) => number,
  range: [number, number],
  prev: number | null,
  play: (beat: number, midi: number, len: number) => void,
  bias = 0,
): number | null {
  const [lo, hi] = range;
  let last = prev;
  for (const note of motif) {
    const degree = degreeAt(note.beat);
    const candidates = note.chord ? s.chordPitches(degree, lo, hi) : s.scalePitches(lo, hi);
    if (candidates.length === 0) continue;
    const target = (lo + hi) / 2 + clamp(note.h + bias, -1, 1) * ((hi - lo) / 2);
    let best = candidates[0];
    let bestCost = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      let cost = Math.abs(c - target);
      if (last !== null) {
        cost += 0.4 * Math.max(0, Math.abs(c - last) - 7);
        if (c === last) cost += 1.2;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
      }
    }
    play(startBeat + note.beat, best, note.len);
    last = best;
  }
  return last;
}

export interface Composition {
  audio: Stereo;
  bpm: number;
  key: string;
  durationSec: number;
}

function finish(s: Session, m: MasterOptions): Composition {
  const audio = master(s.mx, m);
  const name = NOTE_NAMES[((s.o.key % 12) + 12) % 12] + (s.o.mode === "minor" ? "m" : "");
  return { audio, bpm: s.o.bpm, key: name, durationSec: audio.length / SR };
}

function differentFrom<T>(list: T[], avoid: T, r: () => number): T {
  const others = list.filter((x) => x !== avoid);
  return others[Math.min(others.length - 1, Math.floor(r() * others.length))];
}

// ── 1. Relaxing Piano ────────────────────────────────────────

function relaxingPiano(seed: number): Composition {
  const r = mulberry32(seed * 7 + 11);
  const key = [48, 50, 53, 55, 57][Math.floor(r() * 5)];
  const bpm = 64 + Math.floor(r() * 9);
  const progs = [[0, 4, 5, 3], [5, 3, 0, 4], [0, 2, 3, 4], [3, 0, 4, 5], [0, 5, 3, 4]];
  const pa = progs[Math.floor(r() * progs.length)];
  const pb = differentFrom(progs, pa, r);
  const s = new Session({ seed, bpm, beatsPerBar: 4, bars: 33, key, mode: "major", tail: 8 });
  const patterns = [[0, 1, 2, 3, 2, 1, 2, 1], [0, 1, 2, 3, 4, 3, 2, 1], [0, 2, 3, 2, 1, 2, 3, 2]];
  const mA = [makeMotif(s, CELLS_4_SLOW, 2, 2), makeMotif(s, CELLS_4_SLOW, 2, 2)];
  const mB = [makeMotif(s, CELLS_4_SLOW, 2, 2), makeMotif(s, CELLS_4_MED, 2, 2)];
  const sections = [
    { from: 0, bars: 4, prog: pa, motifs: null, level: 0.6, pat: patterns[0], bias: 0 },
    { from: 4, bars: 8, prog: pa, motifs: mA, level: 0.74, pat: s.pick(patterns), bias: 0 },
    { from: 12, bars: 8, prog: pb, motifs: mB, level: 0.86, pat: s.pick(patterns), bias: 0.25 },
    { from: 20, bars: 8, prog: pa, motifs: mA, level: 0.78, pat: s.pick(patterns), bias: 0.05 },
    { from: 28, bars: 4, prog: pa, motifs: null, level: 0.55, pat: patterns[0], bias: 0 },
  ];
  let prev: number | null = null;
  for (const sec of sections) {
    for (let b = 0; b < sec.bars; b++) {
      const bar = sec.from + b;
      const deg = sec.prog[b % sec.prog.length];
      const R = s.root(deg, key - 15);
      const third = s.interval(deg, 2);
      const fifth = s.interval(deg, 4);
      const ladder = [R, R + fifth, R + 12, R + 12 + third, R + 12 + fifth];
      for (let e = 0; e < 8; e++) {
        if (e > 0 && s.rng() > 0.55 + sec.level * 0.5) continue;
        const vel = (e === 0 ? 0.66 : e === 4 ? 0.5 : 0.4 + s.rng() * 0.1) * sec.level;
        // Педаль: нота звучит до конца такта.
        const len = (8 - e) * 0.5 + 0.6;
        piano(s.mx, s.at(s.bar(bar) + e * 0.5) + s.jitter(), ladder[sec.pat[e]], len * s.beat, vel, { send: 0.3 });
      }
    }
    if (sec.motifs) {
      for (let p = 0; p < 4; p++) {
        prev = playMelody(
          s,
          sec.motifs[p % 2],
          s.bar(sec.from + p * 2),
          (beat) => sec.prog[(p * 2 + Math.floor(beat / 4)) % sec.prog.length],
          [key + 24, key + 40],
          prev,
          (bt, midi, len) =>
            piano(s.mx, s.at(bt) + s.jitter(0.012), midi, (len * 1.7 + 0.3) * s.beat, (0.56 + s.rng() * 0.12) * sec.level, {
              send: 0.34,
              soft: 0.15,
            }),
          sec.bias,
        );
      }
    }
  }
  // Финал: тоническое трезвучие, взятое арпеджио.
  const R = s.root(0, key - 15);
  [R, R + 7, R + 12, R + 16, R + 19, R + 24].forEach((m, i) =>
    piano(s.mx, s.at(s.bar(32)) + i * 0.075, m, 7, 0.5 - i * 0.03, { send: 0.4 }),
  );
  return finish(s, { reverb: { size: 0.82, damp: 0.5 }, wet: 1.9, fadeOut: 6 });
}

// ── 2. Soft Ambient ──────────────────────────────────────────

function softAmbient(seed: number): Composition {
  const r = mulberry32(seed * 7 + 23);
  const key = [48, 50, 52, 53, 55][Math.floor(r() * 5)];
  const progs = [[0, 3, 5, 3], [0, 5, 3, 4], [3, 0, 5, 4], [0, 2, 3, 0]];
  const prog = progs[Math.floor(r() * progs.length)];
  const s = new Session({ seed, bpm: 60, beatsPerBar: 4, bars: 26, key, mode: "major", tail: 9 });
  const chords = 13;
  const penta = [0, 1, 2, 4, 5];
  let prevV: number[] | undefined;
  for (let c = 0; c < chords; c++) {
    const deg = prog[c % prog.length];
    const t = s.at(s.bar(c * 2));
    const dur = 8 * s.beat;
    const level = 0.75 + 0.25 * Math.sin((Math.PI * c) / (chords - 1));
    const voicing = s.voicing(deg, key + 16, 4, prevV, c % 2 === 0 ? 7 : 9);
    prevV = voicing;
    pad(s.mx, Math.max(0, t - 1.2), voicing, dur + 0.5, 0.75 * level, {
      attack: 3.2, release: 4.5, harmonics: 4, rolloff: 2.0, voices: [-7, 0, 7], send: 0.6, width: 0.9,
    });
    const R = s.root(deg, key - 14);
    pad(s.mx, Math.max(0, t - 1), [R, R + s.interval(deg, 4)], dur + 0.5, 0.6 * level, {
      attack: 3.5, release: 4.5, harmonics: 3, rolloff: 2.2, voices: [-4, 4], send: 0.4, width: 0.4,
    });
    pad(s.mx, t, [R - 12 >= 28 ? R - 12 : R], dur, 0.5 * level, {
      attack: 2.5, release: 3, harmonics: 1, voices: [0], send: 0.1, width: 0, gain: 0.2,
    });
    if (c >= 4 && c <= 10) {
      pad(s.mx, t, voicing.slice(1).map((m) => m + 12), dur, 0.28 * level, {
        attack: 4, release: 4, harmonics: 2, rolloff: 2.4, voices: [-9, 9], send: 0.8, width: 1,
      });
    }
    const count = 1 + Math.floor(s.rng() * 2.4);
    for (let i = 0; i < count; i++) {
      const midi = key + 24 + s.deg(s.pick(penta)) + (s.rng() < 0.3 ? 12 : 0);
      bell(s.mx, t + 0.6 + s.rng() * (dur - 2), midi, 0.3 + s.rng() * 0.2, { decay: 2.2, send: 0.7, dly: 0.6, kind: "box" });
    }
  }
  return finish(s, {
    reverb: { size: 0.92, damp: 0.45, predelay: 0.03 },
    wet: 2.2,
    delay: { time: 0.75, feedback: 0.45, wet: 0.5 },
    fadeIn: 2.5,
    fadeOut: 7,
  });
}

// ── 3. Warm Memories ─────────────────────────────────────────

function warmMemories(seed: number): Composition {
  const r = mulberry32(seed * 7 + 37);
  const key = [48, 50, 53, 55][Math.floor(r() * 4)];
  const bpm = 76 + Math.floor(r() * 8);
  const progs = [[0, 4, 5, 3], [0, 5, 3, 4], [3, 4, 5, 0], [0, 3, 5, 4]];
  const pa = progs[Math.floor(r() * progs.length)];
  const pb = differentFrom(progs, pa, r);
  const s = new Session({ seed, bpm, beatsPerBar: 4, bars: 33, key, mode: "major", tail: 8 });
  const mA = [makeMotif(s, CELLS_4_SLOW, 2, 2), makeMotif(s, CELLS_4_MED, 2, 2)];
  const mB = [makeMotif(s, CELLS_4_MED, 2, 2), makeMotif(s, CELLS_4_SLOW, 2, 2)];
  const sections = [
    { from: 0, bars: 4, prog: pa, motifs: null as MNote[][] | null, level: 0.6, strings: 0, bassOn: false, bells: false },
    { from: 4, bars: 8, prog: pa, motifs: mA, level: 0.72, strings: 0, bassOn: false, bells: false },
    { from: 12, bars: 8, prog: pb, motifs: mB, level: 0.84, strings: 0.7, bassOn: true, bells: false },
    { from: 20, bars: 8, prog: pa, motifs: mA, level: 0.9, strings: 1, bassOn: true, bells: true },
    { from: 28, bars: 4, prog: pa, motifs: null, level: 0.6, strings: 0.6, bassOn: false, bells: false },
  ];
  let prev: number | null = null;
  let prevV: number[] | undefined;
  for (const sec of sections) {
    for (let b = 0; b < sec.bars; b++) {
      const bar = sec.from + b;
      const deg = sec.prog[b % sec.prog.length];
      const R = s.root(deg, key - 14);
      const third = s.interval(deg, 2);
      const fifth = s.interval(deg, 4);
      // Левая рука: бас — квинта — терция через октаву — квинта.
      const cell = [R, R + fifth, R + 12 + third, R + fifth];
      for (let e = 0; e < 8; e++) {
        const vel = (e % 4 === 0 ? 0.6 : 0.38 + s.rng() * 0.08) * sec.level;
        piano(s.mx, s.at(s.bar(bar) + e * 0.5) + s.jitter(), cell[e % 4], (e % 4 === 0 ? 2.4 : 1.4) * s.beat, vel, { send: 0.28 });
      }
      if (sec.strings > 0) {
        const v = s.voicing(deg, key + 14, 3, prevV);
        prevV = v;
        pad(s.mx, s.at(s.bar(bar)) - 0.15, v, 4 * s.beat, 0.62 * sec.strings, {
          attack: 0.9, release: 1.6, harmonics: 8, rolloff: 1.35, voices: [-11, -5, 0, 6, 12], send: 0.5, width: 0.85,
        });
      }
      if (sec.bassOn) {
        bass(s.mx, s.at(s.bar(bar)), R - (R - 12 >= 31 ? 12 : 0), 2.6 * s.beat, 0.55 * sec.level);
        bass(s.mx, s.at(s.bar(bar) + 3), R + (s.rng() < 0.5 ? fifth - 12 : 0), 0.9 * s.beat, 0.4 * sec.level);
      }
    }
    if (sec.motifs) {
      for (let p = 0; p < 4; p++) {
        prev = playMelody(
          s,
          sec.motifs[p % 2],
          s.bar(sec.from + p * 2),
          (beat) => sec.prog[(p * 2 + Math.floor(beat / 4)) % sec.prog.length],
          [key + 24, key + 41],
          prev,
          (bt, midi, len) => {
            piano(s.mx, s.at(bt) + s.jitter(0.012), midi, (len * 1.5 + 0.3) * s.beat, (0.6 + s.rng() * 0.1) * sec.level, {
              send: 0.32,
              soft: 0.1,
            });
            if (sec.bells && len >= 1) bell(s.mx, s.at(bt), midi + 12, 0.22, { kind: "glock", decay: 1.0, send: 0.5 });
          },
        );
      }
    }
  }
  const R = s.root(0, key - 14);
  [R, R + 7, R + 12, R + 16, R + 19, R + 24].forEach((m, i) =>
    piano(s.mx, s.at(s.bar(32)) + i * 0.06, m, 7, 0.52 - i * 0.03, { send: 0.4 }),
  );
  pad(s.mx, s.at(s.bar(32)), [R + 12, R + 16, R + 19], 3 * s.beat, 0.4, {
    attack: 0.8, release: 4, harmonics: 8, rolloff: 1.4, voices: [-9, 0, 9], send: 0.6,
  });
  return finish(s, { reverb: { size: 0.8, damp: 0.5 }, wet: 1.8, fadeOut: 6 });
}

// ── 4. Chill Acoustic ────────────────────────────────────────

function chillAcoustic(seed: number): Composition {
  const r = mulberry32(seed * 7 + 41);
  const key = [43, 45, 48, 50, 40][Math.floor(r() * 5)];
  const bpm = 84 + Math.floor(r() * 10);
  const progs = [[0, 3, 5, 4], [0, 4, 3, 3], [5, 3, 0, 4], [0, 5, 3, 4]];
  const pa = progs[Math.floor(r() * progs.length)];
  const pb = differentFrom(progs, pa, r);
  const s = new Session({ seed, bpm, beatsPerBar: 4, bars: 40, key, mode: "major", tail: 7 });
  const picking = [[0, 2, 1, 3, 4, 2, 1, 3], [0, 1, 2, 3, 4, 3, 2, 1], [0, 3, 1, 2, 4, 3, 1, 2]];
  const mA = [makeMotif(s, CELLS_4_SLOW, 2, 2), makeMotif(s, CELLS_4_SLOW, 2, 2)];
  const mB = [makeMotif(s, CELLS_4_MED, 2, 2), makeMotif(s, CELLS_4_SLOW, 2, 2)];
  const sections = [
    { from: 0, bars: 4, prog: pa, motifs: null as MNote[][] | null, level: 0.7, rhythm: false, pat: picking[0], bias: 0 },
    { from: 4, bars: 8, prog: pa, motifs: mA, level: 0.8, rhythm: false, pat: s.pick(picking), bias: 0 },
    { from: 12, bars: 8, prog: pb, motifs: mB, level: 0.9, rhythm: true, pat: s.pick(picking), bias: 0.1 },
    { from: 20, bars: 8, prog: pa, motifs: mA, level: 0.92, rhythm: true, pat: s.pick(picking), bias: 0 },
    { from: 28, bars: 8, prog: pb, motifs: mB, level: 0.9, rhythm: true, pat: s.pick(picking), bias: 0.3 },
    { from: 36, bars: 4, prog: pa, motifs: null, level: 0.65, rhythm: false, pat: picking[0], bias: 0 },
  ];
  const swing = 0.045;
  let prev: number | null = null;
  let prevV: number[] | undefined;
  for (const sec of sections) {
    for (let b = 0; b < sec.bars; b++) {
      const bar = sec.from + b;
      const deg = sec.prog[b % sec.prog.length];
      const R = s.root(deg, 40);
      const fifthUp = R + s.interval(deg, 4);
      const low5 = fifthUp <= 52 ? fifthUp : fifthUp - 12 >= 40 ? fifthUp - 12 : R;
      const treble = s.voicing(deg, 61, 3, prevV);
      prevV = treble;
      const strings = [R, treble[0], treble[1], treble[2], low5];
      for (let e = 0; e < 8; e++) {
        const isBass = e === 0 || e === 4;
        if (!isBass && s.rng() > 0.6 + sec.level * 0.4) continue;
        const beat = s.bar(bar) + e * 0.5 + (e % 2 === 1 ? swing : 0);
        const vel = (isBass ? 0.72 : 0.44 + s.rng() * 0.12) * sec.level;
        pluck(s.mx, s.at(beat) + s.jitter(0.006), strings[sec.pat[e]], (isBass ? 2 : 1.6) * s.beat, vel, {
          bright: 0.34, send: 0.2, pan: isBass ? -0.12 : -0.3 + 0.18 * sec.pat[e],
        });
        if (sec.rhythm) shaker(s.mx, s.at(beat), e % 2 === 0 ? 0.5 : 0.3, 0.38);
      }
      if (sec.rhythm) {
        bass(s.mx, s.at(s.bar(bar)), R - (R - 12 >= 28 ? 12 : 0), 1.8 * s.beat, 0.5 * sec.level);
        bass(s.mx, s.at(s.bar(bar) + 2), low5 - (low5 - 12 >= 28 ? 12 : 0), 1.4 * s.beat, 0.4 * sec.level);
      }
    }
    if (sec.motifs) {
      for (let p = 0; p < 4; p++) {
        prev = playMelody(
          s,
          sec.motifs[p % 2],
          s.bar(sec.from + p * 2),
          (beat) => sec.prog[(p * 2 + Math.floor(beat / 4)) % sec.prog.length],
          [67, 84],
          prev,
          (bt, midi, len) =>
            pluck(s.mx, s.at(bt) + s.jitter(0.01), midi, (len * 1.3 + 0.4) * s.beat, (0.5 + s.rng() * 0.12) * sec.level, {
              bright: 0.55, send: 0.3, dly: 0.25, pan: 0.32,
            }),
          sec.bias,
        );
      }
    }
  }
  // Финальный аккорд, взятый перебором.
  const R = s.root(0, 40);
  [R, R + 7, R + 12, R + 16, R + 19, R + 24].forEach((m, i) =>
    pluck(s.mx, s.at(s.bar(40)) + i * 0.03, m, 6, 0.6 - i * 0.03, { bright: 0.4, send: 0.35, sustain: 1.4 }),
  );
  return finish(s, {
    reverb: { size: 0.6, damp: 0.55 },
    wet: 1.3,
    delay: { time: 0.75 * s.beat, feedback: 0.3, wet: 0.5 },
    fadeOut: 5,
  });
}

// ── 5. Dreamy Cinematic ──────────────────────────────────────

function dreamyCinematic(seed: number): Composition {
  const r = mulberry32(seed * 7 + 53);
  const key = [45, 50, 52, 47][Math.floor(r() * 4)];
  const bpm = 60 + Math.floor(r() * 7);
  const progs = [[0, 5, 2, 6], [0, 3, 5, 4], [5, 6, 0, 0], [0, 6, 5, 6]];
  const prog = progs[Math.floor(r() * progs.length)];
  const s = new Session({ seed, bpm, beatsPerBar: 4, bars: 28, key, mode: "minor", tail: 9 });
  const cellOrder = s.pick([[0, 2, 1, 3], [0, 1, 3, 2], [1, 3, 0, 2]]);
  const hits = s.pick([[0, 0.5, 1.5, 2.5], [0, 1, 1.5, 3], [0.5, 1.5, 2, 3]]);
  let prevV: number[] | undefined;
  for (let bar = 0; bar < 28; bar++) {
    const deg = prog[bar % prog.length];
    // Динамическая дуга: от тихого начала к кульминации и обратно.
    const arc = 0.5 + 0.5 * Math.sin(Math.PI * clamp((bar - 1) / 24, 0, 1));
    const t = s.at(s.bar(bar));
    const barLen = 4 * s.beat;
    const v = s.voicing(deg, key + 19, 4, prevV, bar % 4 === 3 ? 7 : 0);
    prevV = v;
    pad(s.mx, Math.max(0, t - 0.5), v, barLen + 0.3, 0.7 * arc, {
      attack: 1.6, release: 2.5, harmonics: 9, rolloff: 1.3, voices: [-12, -5, 0, 6, 11], send: 0.6, width: 0.95,
    });
    const R = s.root(deg, 33);
    pad(s.mx, Math.max(0, t - 0.4), [R, R + s.interval(deg, 4)], barLen + 0.2, 0.6 * arc, {
      attack: 1.4, release: 2.2, harmonics: 6, rolloff: 1.5, voices: [-6, 6], send: 0.4, width: 0.35,
    });
    if (bar >= 8 && bar < 24) {
      pad(s.mx, t, [R - 12 >= 26 ? R - 12 : R], barLen, 0.6 * arc, {
        attack: 0.6, release: 1.8, harmonics: 1, voices: [0], send: 0.05, width: 0, gain: 0.22,
      });
    }
    const tones = s.chordPitches(deg, key + 26, key + 44);
    const cell = cellOrder.map((i) => tones[Math.min(tones.length - 1, i)]);
    hits.forEach((h, i) => {
      if (bar >= 24 && i > 1) return;
      piano(s.mx, s.at(s.bar(bar) + h) + s.jitter(0.01), cell[i % cell.length], 2.2 * s.beat, 0.36 + 0.16 * arc * (i === 0 ? 1 : 0.7), {
        send: 0.5, dly: 0.5, soft: 0.3,
      });
    });
    if (bar >= 12 && bar < 20) {
      bell(s.mx, t, cell[0] + 12, 0.24, { kind: "box", decay: 1.8, send: 0.7, dly: 0.4 });
      bell(s.mx, s.at(s.bar(bar) + 2), cell[2 % cell.length] + 12, 0.18, { kind: "box", decay: 1.8, send: 0.7, dly: 0.4 });
    }
  }
  const R = s.root(0, 33);
  pad(s.mx, s.at(s.bar(28)) - 0.5, [R, R + 7, R + 12, R + 15, R + 19], 3 * s.beat, 0.5, {
    attack: 1.5, release: 5, harmonics: 8, rolloff: 1.4, voices: [-9, 0, 9], send: 0.7,
  });
  piano(s.mx, s.at(s.bar(28)), R + 24, 6, 0.4, { send: 0.6, dly: 0.5, soft: 0.3 });
  return finish(s, {
    reverb: { size: 0.95, damp: 0.4, predelay: 0.03 },
    wet: 2.4,
    delay: { time: 0.75 * s.beat, feedback: 0.4, wet: 0.45 },
    fadeIn: 2,
    fadeOut: 7,
  });
}

// ── 6. Nostalgia ─────────────────────────────────────────────

function nostalgia(seed: number): Composition {
  const r = mulberry32(seed * 7 + 67);
  const key = [48, 53, 55, 50][Math.floor(r() * 4)];
  const bpm = 96 + Math.floor(r() * 12);
  const progs = [
    [0, 0, 3, 3, 4, 4, 0, 0],
    [0, 5, 1, 4, 0, 5, 1, 4],
    [0, 3, 0, 4, 0, 3, 4, 0],
    [5, 5, 3, 3, 0, 0, 4, 4],
  ];
  const pa = progs[Math.floor(r() * progs.length)];
  const pb = differentFrom(progs, pa, r);
  const s = new Session({ seed, bpm, beatsPerBar: 3, bars: 56, key, mode: "major", tail: 7 });
  const mA = [makeMotif(s, CELLS_3, 2, 3), makeMotif(s, CELLS_3, 2, 3)];
  const mB = [makeMotif(s, CELLS_3, 2, 3), makeMotif(s, CELLS_3, 2, 3)];
  const sections = [
    { from: 0, bars: 4, prog: pa, motifs: null as MNote[][] | null, level: 0.6, double: false },
    { from: 4, bars: 16, prog: pa, motifs: mA, level: 0.8, double: false },
    { from: 20, bars: 16, prog: pb, motifs: mB, level: 0.9, double: false },
    { from: 36, bars: 16, prog: pa, motifs: mA, level: 0.9, double: true },
    { from: 52, bars: 4, prog: pa, motifs: null, level: 0.55, double: false },
  ];
  let prev: number | null = null;
  let prevV: number[] | undefined;
  for (const sec of sections) {
    for (let b = 0; b < sec.bars; b++) {
      const bar = sec.from + b;
      const deg = sec.prog[b % sec.prog.length];
      const R = s.root(deg, key - 14);
      const v = s.voicing(deg, key + 12, 3, prevV);
      prevV = v;
      // Вальсовый аккомпанемент: бас — аккорд — аккорд.
      piano(s.mx, s.at(s.bar(bar)) + s.jitter(), R, 2.6 * s.beat, 0.46 * sec.level, { send: 0.3, soft: 0.2 });
      for (const beat of [1, 2]) {
        for (const m of [v[0], v[2]]) {
          piano(s.mx, s.at(s.bar(bar) + beat) + s.jitter(), m, 0.8 * s.beat, (beat === 1 ? 0.3 : 0.26) * sec.level, {
            send: 0.3, soft: 0.35,
          });
        }
      }
    }
    if (sec.motifs) {
      const phrases = sec.bars / 2;
      for (let p = 0; p < phrases; p++) {
        prev = playMelody(
          s,
          sec.motifs[p % 2],
          s.bar(sec.from + p * 2),
          (beat) => sec.prog[(p * 2 + Math.floor(beat / 3)) % sec.prog.length],
          [key + 24, key + 43],
          prev,
          (bt, midi, len) => {
            bell(s.mx, s.at(bt) + s.jitter(0.012), midi, (0.5 + s.rng() * 0.12) * sec.level, {
              kind: "box", decay: 1.2 + len * 0.25, send: 0.45,
            });
            if (sec.double && len >= 1) bell(s.mx, s.at(bt) + 0.02, midi - 12, 0.2, { kind: "box", decay: 1.4, send: 0.45 });
          },
        );
      }
    }
  }
  const R = s.root(0, key - 14);
  piano(s.mx, s.at(s.bar(56)), R, 6, 0.42, { send: 0.4, soft: 0.2 });
  [R + 24, R + 28, R + 31, R + 36].forEach((m, i) =>
    bell(s.mx, s.at(s.bar(56)) + i * 0.14, m, 0.42 - i * 0.04, { kind: "box", decay: 2.4, send: 0.6 }),
  );
  crackle(s.mx, 0, s.mx.length / SR, 0.06);
  return finish(s, { reverb: { size: 0.7, damp: 0.6 }, wet: 1.6, lowpassHz: 6500, fadeOut: 5 });
}

// ── 7. Happy Moments ─────────────────────────────────────────

function happyMoments(seed: number): Composition {
  const r = mulberry32(seed * 7 + 79);
  const key = [48, 50, 53, 55, 45][Math.floor(r() * 5)];
  const bpm = 104 + Math.floor(r() * 9);
  const progs = [[0, 4, 5, 3], [0, 3, 0, 4], [0, 5, 3, 4], [0, 3, 4, 3]];
  const pa = progs[Math.floor(r() * progs.length)];
  const pb = differentFrom(progs, pa, r);
  const s = new Session({ seed, bpm, beatsPerBar: 4, bars: 48, key, mode: "major", tail: 6 });
  const mA = [makeMotif(s, CELLS_4_MED, 2, 2), makeMotif(s, CELLS_4_MED, 2, 2)];
  const mB = [makeMotif(s, CELLS_4_MED, 2, 2), makeMotif(s, CELLS_4_SLOW, 2, 2)];
  const sections = [
    { from: 0, bars: 4, prog: pa, motifs: null as MNote[][] | null, level: 0.7, bassOn: false, shake: false, kickOn: false },
    { from: 4, bars: 8, prog: pa, motifs: mA, level: 0.82, bassOn: true, shake: true, kickOn: false },
    { from: 12, bars: 8, prog: pb, motifs: mB, level: 0.9, bassOn: true, shake: true, kickOn: true },
    { from: 20, bars: 8, prog: pa, motifs: mA, level: 0.92, bassOn: true, shake: true, kickOn: true },
    { from: 28, bars: 8, prog: pb, motifs: mB, level: 0.92, bassOn: true, shake: true, kickOn: true },
    { from: 36, bars: 8, prog: pa, motifs: mA, level: 0.95, bassOn: true, shake: true, kickOn: true },
    { from: 44, bars: 4, prog: pa, motifs: null, level: 0.7, bassOn: true, shake: false, kickOn: false },
  ];
  // «Островной» бой: вниз, вниз-вверх, вверх-вниз-вверх.
  const strum: [number, "d" | "u"][] = [[0, "d"], [1, "d"], [1.5, "u"], [2.5, "u"], [3, "d"], [3.5, "u"]];
  let prev: number | null = null;
  let prevV: number[] | undefined;
  for (const sec of sections) {
    for (let b = 0; b < sec.bars; b++) {
      const bar = sec.from + b;
      const deg = sec.prog[b % sec.prog.length];
      const chord = s.voicing(deg, key + 19, 4, prevV);
      prevV = chord;
      for (const [beat, dir] of strum) {
        const notes = dir === "d" ? chord : [...chord].reverse().slice(0, 3);
        notes.forEach((m, i) =>
          pluck(s.mx, s.at(s.bar(bar) + beat) + i * (dir === "d" ? 0.014 : 0.01) + s.jitter(0.004), m, 0.9 * s.beat,
            (dir === "d" ? 0.5 : 0.34) * sec.level * (1 - i * 0.05), { bright: 0.6, sustain: 0.6, send: 0.18, pan: -0.25 + i * 0.12 }),
        );
      }
      const R = s.root(deg, 36);
      if (sec.bassOn) {
        bass(s.mx, s.at(s.bar(bar)), R, 1.4 * s.beat, 0.6 * sec.level);
        bass(s.mx, s.at(s.bar(bar) + 2), R + s.interval(deg, 4) - (R + 7 > 50 ? 12 : 0), 0.9 * s.beat, 0.48 * sec.level);
        bass(s.mx, s.at(s.bar(bar) + 3.5), R, 0.4 * s.beat, 0.4 * sec.level);
      }
      if (sec.shake) {
        for (let e = 0; e < 8; e++) shaker(s.mx, s.at(s.bar(bar) + e * 0.5), e % 2 === 0 ? 0.55 : 0.32, 0.4);
      }
      if (sec.kickOn) {
        kick(s.mx, s.at(s.bar(bar)), 0.55);
        kick(s.mx, s.at(s.bar(bar) + 2), 0.45);
      }
    }
    if (sec.motifs) {
      for (let p = 0; p < 4; p++) {
        prev = playMelody(
          s,
          sec.motifs[p % 2],
          s.bar(sec.from + p * 2),
          (beat) => sec.prog[(p * 2 + Math.floor(beat / 4)) % sec.prog.length],
          [key + 31, key + 48],
          prev,
          (bt, midi, len) => {
            bell(s.mx, s.at(bt) + s.jitter(0.008), midi, (0.5 + s.rng() * 0.1) * sec.level, {
              kind: "glock", decay: 0.8 + len * 0.2, send: 0.35, dly: 0.15,
            });
            if (sec.from >= 36) pluck(s.mx, s.at(bt), midi - 12, len * s.beat, 0.3, { bright: 0.7, send: 0.25, pan: 0.35 });
          },
        );
      }
    }
  }
  const tonic = s.voicing(0, key + 19, 4, prevV);
  tonic.forEach((m, i) => pluck(s.mx, s.at(s.bar(48)) + i * 0.025, m, 5, 0.55, { bright: 0.6, sustain: 1.3, send: 0.3 }));
  bass(s.mx, s.at(s.bar(48)), s.root(0, 36), 3, 0.6);
  bell(s.mx, s.at(s.bar(48)) + 0.1, key + 36, 0.4, { kind: "glock", decay: 1.6, send: 0.5 });
  return finish(s, {
    reverb: { size: 0.5, damp: 0.6 },
    wet: 1.1,
    delay: { time: 0.5 * s.beat, feedback: 0.25, wet: 0.4 },
    fadeOut: 4,
  });
}

const COMPOSERS: Record<MusicStyleId, (seed: number) => Composition> = {
  "relaxing-piano": relaxingPiano,
  "soft-ambient": softAmbient,
  "warm-memories": warmMemories,
  "chill-acoustic": chillAcoustic,
  "dreamy-cinematic": dreamyCinematic,
  nostalgia,
  "happy-moments": happyMoments,
};

export function compose(style: MusicStyleId, seed: number): Composition {
  return COMPOSERS[style](seed);
}
