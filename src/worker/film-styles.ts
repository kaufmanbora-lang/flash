// Стили оформления фильма: цветокоррекция, переходы и палитра титров.
// Все длительности переходов кратны 1/30 секунды — монтаж считается в кадрах.

import type { FilmStyleId } from "@/lib/constants";

export const FPS = 30;
export const SAMPLE_RATE = 48_000;
export const SAMPLES_PER_FRAME = SAMPLE_RATE / FPS; // 1600 — ровно, без накопления рассинхрона

export interface Transition {
  /** Имя перехода фильтра xfade. */
  type: string;
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

export interface FilmStyle {
  id: FilmStyleId;
  /** Цветокоррекция видео (цепочка фильтров ffmpeg) или пустая строка. */
  grade: string;
  /** Чёрные полосы «кино» для горизонтальных фильмов. */
  letterbox: boolean;
  clip: Transition;
  day: Transition;
  card: CardTheme;
  label: LabelTheme;
}

export const STYLES: Record<FilmStyleId, FilmStyle> = {
  minimal: {
    id: "minimal",
    grade: "",
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
    grade: "eq=contrast=1.07:saturation=1.05:gamma=0.97,colorbalance=rs=0.03:bs=-0.03:rh=0.02:bh=-0.02,vignette=angle=PI/6",
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
    grade:
      "eq=saturation=1.08:brightness=0.012:gamma=1.03,colorbalance=rs=0.05:gs=0.01:bs=-0.05:rm=0.03:bm=-0.03:rh=0.02:bh=-0.03,vignette=angle=PI/8",
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
    // Зерно лёгкое и только в яркости: сильное зерно во всех плоскостях увеличивало файл в несколько раз
    // (замер на 720p: без зерна ≈1,4 Мбит/с, c0s=5 ≈1,8 Мбит/с, c0s=7 ≈3,6 Мбит/с).
    grade: "curves=preset=vintage,eq=saturation=0.84:contrast=1.04,noise=c0s=5:c0f=t+u,vignette=angle=PI/4.6",
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
    grade: "eq=brightness=0.02:saturation=1.05:contrast=1.02",
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
