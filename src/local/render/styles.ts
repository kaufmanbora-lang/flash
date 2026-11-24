// Стили оформления фильма: цветокоррекция, переходы и палитра титров.
// Все длительности переходов кратны 1/30 секунды — монтаж считается в кадрах.

import type { FilmStyleId } from "@/lib/constants";

export const FPS = 30;
export const SAMPLE_RATE = 48_000;
export const SAMPLES_PER_FRAME = SAMPLE_RATE / FPS; // 1600 — ровно, без накопления рассинхрона

/**
 * fade — обычное растворение; fadewhite / fadeblack — через белый или чёрный;
 * fadegrays — через обесцвечивание; smoothleft — мягкая шторка справа налево.
 */
export type TransitionType = "fade" | "fadewhite" | "fadeblack" | "fadegrays" | "smoothleft";

export interface Transition {
  type: TransitionType;
  frames: number;
}

export interface CardTheme {
  /** milk — молочный фон приложения, photo — размытый кадр из видео, plain — заливка цветом. */
  background: "milk" | "photo" | "plain";
  bgColor: string;
  /** Затемнение / тонирование поверх размытого кадра. */
  overlay: string;
  vignette: number;
  ink: string;
  sub: string;
  accent: string;
  titleFont: "serif" | "sans";
  /** Цвет, из которого проявляется вступление и в который уходит финал. */
  fade: "white" | "black";
  /** Декор фона: рамка «старой открытки» или мягкие салатовые пятна. */
  decor: "none" | "frame" | "blobs";
}

export interface LabelTheme {
  position: "bottom-left" | "bottom-center" | "bottom-right" | "top-left";
  kind: "plain" | "serif" | "stamp" | "pill";
  color: string;
}

/**
 * Цветокоррекция кадра — набор простых операций наложения (они есть в любом браузере):
 * каждая рисуется поверх кадра своим режимом смешивания.
 */
export interface Grade {
  /** Контраст и плотность цвета: кадр накладывается сам на себя в режиме soft-light. 0…1. */
  punch: number;
  /** Обесцвечивание: 0 — нет, 1 — чёрно-белый кадр. */
  desaturate: number;
  /** Тонирование: цвет и сила (режим soft-light). */
  tint: { color: string; amount: number } | null;
  /** Подъём теней («выцветшая плёнка»): цвет, до которого поднимается чёрный, и сила. */
  lift: { color: string; amount: number } | null;
  /** Общее осветление белым, 0…1. */
  brighten: number;
  /** Затемнение краёв кадра, 0…1. */
  vignette: number;
  /** Плёночное зерно, 0…1. */
  grain: number;
}

export interface FilmStyle {
  id: FilmStyleId;
  grade: Grade;
  /** Чёрные полосы «кино» для горизонтальных фильмов. */
  letterbox: boolean;
  clip: Transition;
  day: Transition;
  card: CardTheme;
  label: LabelTheme;
}

const NO_GRADE: Grade = { punch: 0, desaturate: 0, tint: null, lift: null, brighten: 0, vignette: 0, grain: 0 };

export const STYLES: Record<FilmStyleId, FilmStyle> = {
  minimal: {
    id: "minimal",
    grade: NO_GRADE,
    letterbox: false,
    clip: { type: "fade", frames: 15 },
    day: { type: "fadewhite", frames: 27 },
    card: {
      background: "milk",
      bgColor: "#F8FAF5",
      overlay: "rgba(248,250,245,0)",
      vignette: 0,
      ink: "#20301E",
      sub: "#6B7A64",
      accent: "#8BC65B",
      titleFont: "serif",
      fade: "white",
      decor: "none",
    },
    label: { position: "bottom-left", kind: "plain", color: "#FFFFFF" },
  },
  cinematic: {
    id: "cinematic",
    // Плотнее и чуть теплее в светах, с заметным затемнением краёв.
    grade: { ...NO_GRADE, punch: 0.2, tint: { color: "#FFB27A", amount: 0.07 }, vignette: 0.34 },
    letterbox: true,
    clip: { type: "fade", frames: 18 },
    day: { type: "fadeblack", frames: 30 },
    card: {
      background: "photo",
      bgColor: "#0D120C",
      overlay: "rgba(8,12,8,0.66)",
      vignette: 0.55,
      ink: "#F6F3EA",
      sub: "rgba(246,243,234,0.74)",
      accent: "#D9C9A0",
      titleFont: "serif",
      fade: "black",
      decor: "none",
    },
    label: { position: "bottom-center", kind: "serif", color: "#F6F3EA" },
  },
  memories: {
    id: "memories",
    // Тёплый и мягкий: золотистый тон, слегка приподнятая яркость.
    grade: { ...NO_GRADE, punch: 0.08, tint: { color: "#FFB866", amount: 0.16 }, brighten: 0.025, vignette: 0.2 },
    letterbox: false,
    clip: { type: "fade", frames: 27 },
    day: { type: "fadewhite", frames: 30 },
    card: {
      background: "photo",
      bgColor: "#F6EFE3",
      overlay: "rgba(247,240,228,0.84)",
      vignette: 0.12,
      ink: "#3A2E22",
      sub: "#7C6955",
      accent: "#C9A77A",
      titleFont: "serif",
      fade: "white",
      decor: "none",
    },
    label: { position: "bottom-left", kind: "serif", color: "#FFF8EC" },
  },
  vintage: {
    id: "vintage",
    // Плёнка: приглушённый цвет, выцветшие тени, тёплый тон, зерно и сильная виньетка.
    grade: {
      punch: 0.1,
      desaturate: 0.2,
      tint: { color: "#E0A85A", amount: 0.22 },
      lift: { color: "#3A2A1C", amount: 0.5 },
      brighten: 0,
      vignette: 0.46,
      grain: 0.5,
    },
    letterbox: false,
    clip: { type: "fadegrays", frames: 18 },
    day: { type: "fadeblack", frames: 27 },
    card: {
      background: "plain",
      bgColor: "#241C14",
      overlay: "rgba(36,28,20,0)",
      vignette: 0.5,
      ink: "#F2E3C6",
      sub: "#C9B48E",
      accent: "#E0A85A",
      titleFont: "serif",
      fade: "black",
      decor: "frame",
    },
    label: { position: "bottom-right", kind: "stamp", color: "#FFB44A" },
  },
  clean: {
    id: "clean",
    // Чистый и яркий: чуть больше света и плотности, без тонирования.
    grade: { ...NO_GRADE, punch: 0.1, brighten: 0.03 },
    letterbox: false,
    clip: { type: "smoothleft", frames: 15 },
    day: { type: "fadewhite", frames: 24 },
    card: {
      background: "plain",
      bgColor: "#FFFFFF",
      overlay: "rgba(255,255,255,0)",
      vignette: 0,
      ink: "#1B2A19",
      sub: "#6B7A64",
      accent: "#8BC65B",
      titleFont: "sans",
      fade: "white",
      decor: "blobs",
    },
    label: { position: "top-left", kind: "pill", color: "#1B2A19" },
  },
};

/** Порядок, в котором стили чередуются при выборе «Авто». */
export const STYLE_ROTATION: FilmStyleId[] = ["memories", "minimal", "cinematic", "clean", "vintage"];

/**
 * Стиль для выбора «Авто»: тот, что ещё не встречался среди последних фильмов,
 * а если встречались все — использованный раньше остальных.
 */
export function rotateStyle(recentNewestFirst: FilmStyleId[]): FilmStyleId {
  const unused = STYLE_ROTATION.find((s) => !recentNewestFirst.includes(s));
  if (unused) return unused;
  return STYLE_ROTATION.reduce(
    (best, s) => (recentNewestFirst.indexOf(s) > recentNewestFirst.indexOf(best) ? s : best),
    STYLE_ROTATION[0],
  );
}
