// Общие константы продукта.

export const APP_VERSION = "2.0.0";

/** В один день можно сохранить от одного до трёх моментов. */
export const MAX_MOMENTS_PER_DAY = 3;

/** Минимальная длина одного момента. */
export const MIN_MOMENT_MS = 10_000;
/** Допуск при сохранении: кодировщики камер иногда отдают на пару кадров меньше. */
export const MIN_MOMENT_SERVER_MS = 9_400;

export const NOTE_MAX = 500;

export const FILM_STYLES = ["minimal", "cinematic", "memories", "vintage", "clean"] as const;
export type FilmStyleId = (typeof FILM_STYLES)[number];

export const MUSIC_STYLES = [
  "relaxing-piano",
  "soft-ambient",
  "warm-memories",
  "chill-acoustic",
  "dreamy-cinematic",
  "nostalgia",
  "happy-moments",
] as const;
export type MusicStyleId = (typeof MUSIC_STYLES)[number];

/** Английские названия стилей — это имена собственные, одинаковые во всех языках. */
export const MUSIC_STYLE_NAMES: Record<MusicStyleId, string> = {
  "relaxing-piano": "Relaxing Piano",
  "soft-ambient": "Soft Ambient",
  "warm-memories": "Warm Memories",
  "chill-acoustic": "Chill Acoustic",
  "dreamy-cinematic": "Dreamy Cinematic",
  nostalgia: "Nostalgia",
  "happy-moments": "Happy Moments",
};

export const FILM_STYLE_NAMES: Record<FilmStyleId, string> = {
  minimal: "Minimal",
  cinematic: "Cinematic",
  memories: "Memories",
  vintage: "Vintage",
  clean: "Clean",
};

export const FILM_KINDS = ["day", "week", "month", "year", "custom", "project"] as const;
export type FilmKind = (typeof FILM_KINDS)[number];

export const FILM_VARIANTS = ["full", "highlights", "trailer", "mini", "extended"] as const;
export type FilmVariant = (typeof FILM_VARIANTS)[number];

/** Версии финального фильма проекта. */
export const PROJECT_VARIANTS = ["trailer", "mini", "extended", "full"] as const;
export type ProjectVariant = (typeof PROJECT_VARIANTS)[number];

/** Целевая длительность версий в секундах: нижняя граница доступности и цель монтажа. */
export const VARIANT_TARGETS: Record<Exclude<FilmVariant, "full">, { minFootage: number; target: number; minSeg: number; maxSeg: number }> = {
  // Трейлер 30–60 секунд.
  trailer: { minFootage: 30, target: 48, minSeg: 2.4, maxSeg: 5 },
  // Мини-фильм 3–5 минут.
  mini: { minFootage: 180, target: 240, minSeg: 4, maxSeg: 14 },
  // Расширенный фильм 10–30 минут.
  extended: { minFootage: 600, target: 1200, minSeg: 6, maxSeg: 40 },
  // Highlights для обычных фильмов: около трети материала, но не длиннее трёх минут.
  highlights: { minFootage: 20, target: 90, minSeg: 3, maxSeg: 9 },
};

export const ORIENTATIONS = ["auto", "portrait", "landscape"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export const RESOLUTIONS = ["auto", "720", "1080", "1440", "2160"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const PERIOD_KINDS = ["d1", "d3", "d7", "d14", "d30", "m3", "m6", "y1", "custom", "open"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export const COVER_PRESETS = ["mint", "dawn", "forest", "sea", "sunset", "milk"] as const;
export type CoverPreset = (typeof COVER_PRESETS)[number];

/** CSS-градиенты встроенных обложек (пока в проекте нет ни одного кадра). */
export const COVER_GRADIENTS: Record<CoverPreset, string> = {
  mint: "linear-gradient(140deg,#DDF3C4 0%,#B5DF83 45%,#7FBF52 100%)",
  dawn: "linear-gradient(140deg,#FFE9C9 0%,#F7C9A1 40%,#B9D99A 100%)",
  forest: "linear-gradient(150deg,#A9D48A 0%,#5E9A49 55%,#2F5B31 100%)",
  sea: "linear-gradient(145deg,#D8F1E4 0%,#9AD6C4 45%,#5BA7A0 100%)",
  sunset: "linear-gradient(150deg,#FFD9A8 0%,#F2A27C 45%,#8E7AA8 100%)",
  milk: "linear-gradient(145deg,#FFFFFF 0%,#EEF6E3 55%,#D7EBBF 100%)",
};

export const VIDEO_EXT_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/3gpp": "3gp",
  "video/x-m4v": "m4v",
  "video/mpeg": "mpg",
  "video/x-msvideo": "avi",
};

