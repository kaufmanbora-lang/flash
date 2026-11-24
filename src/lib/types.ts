// Объекты, которыми обмениваются хранилище на устройстве и интерфейс.

import type {
  CoverPreset,
  FilmKind,
  FilmStyleId,
  FilmVariant,
  Orientation,
  PeriodKind,
  ProjectVariant,
  Resolution,
} from "./constants";
import type { Ymd } from "./dates";
import type { ProjectDay, ProjectProgress, ProjectStatus } from "./projects";
import type { MusicChoice, StyleChoice, UserSettings } from "./settings";

export type MomentStatus = "processing" | "ready" | "failed";

/** Профиль «интересности» по секундам: громкость (дБ) и движение в кадре (0…1). */
export interface MomentAnalysis {
  energy: number[];
  motion: number[];
}

/**
 * queued — фильм ждёт сборки («премьеры»); rendering — собирается прямо сейчас;
 * ready — готов; failed — сборка не удалась.
 */
export type FilmStatus = "queued" | "rendering" | "ready" | "failed";

export interface FilmChapter {
  title: string;
  startMs: number;
}

/** Параметры оформления фильма, которые выбирает пользователь. */
export interface FilmOptions {
  style: StyleChoice;
  music: MusicChoice;
  musicVolume: number;
  orientation: Orientation;
  resolution: Resolution;
}

export interface MomentDto {
  id: string;
  recordedAt: string;
  date: Ymd;
  time: string;
  note: string;
  source: "camera" | "upload";
  status: MomentStatus;
  error: string | null;
  durationMs: number;
  width: number;
  height: number;
  sizeBytes: number;
  favorite: boolean;
  posterUrl: string | null;
  videoUrl: string | null;
  downloadUrl: string | null;
  /** Имя файла при сохранении на устройство. */
  fileName: string;
  projectIds: string[];
}

export interface FilmDto {
  id: string;
  projectId: string | null;
  kind: FilmKind;
  variant: FilmVariant;
  title: string;
  subtitle: string;
  dateFrom: Ymd;
  dateTo: Ymd;
  style: StyleChoice;
  styleUsed: FilmStyleId | null;
  music: MusicChoice;
  musicTracks: string[];
  musicVolume: number;
  orientation: Orientation;
  resolution: Resolution;
  status: FilmStatus;
  /** Идёт пересборка, но предыдущая версия ещё доступна для просмотра. */
  hasFile: boolean;
  progress: number;
  stage: string;
  error: string | null;
  width: number;
  height: number;
  durationMs: number;
  sizeBytes: number;
  momentsCount: number;
  posterUrl: string | null;
  videoUrl: string | null;
  downloadUrl: string | null;
  /** Имя файла при сохранении на устройство. */
  fileName: string;
  /** Тип готового файла: video/mp4 или video/webm (зависит от браузера, собравшего фильм). */
  mime: string;
  chapters: FilmChapter[];
  auto: boolean;
  stale: boolean;
  createdAt: string;
  renderedAt: string | null;
}

export interface ProjectDto {
  id: string;
  title: string;
  description: string;
  periodKind: PeriodKind;
  startDate: Ymd;
  endDate: Ymd | null;
  status: ProjectStatus;
  progress: ProjectProgress;
  cover: { kind: "auto" | "preset" | "moment"; preset: CoverPreset; url: string | null; momentId: string | null };
  momentsCount: number;
  durationMs: number;
  daysRecorded: number;
  /** Количество моментов проекта за сегодня. */
  todayCount: number;
  createdAt: string;
  completedAt: string | null;
  /** Главный готовый фильм проекта (для коллекции завершённых проектов). */
  film: FilmDto | null;
}

export interface VariantInfo {
  variant: ProjectVariant;
  available: boolean;
  /** Сколько секунд материала нужно, чтобы версия стала доступна. */
  needSec: number;
  /** Примерная длительность будущего фильма в секундах. */
  estimateSec: number;
  film: FilmDto | null;
}

export interface ProjectDetailDto extends ProjectDto {
  days: ProjectDay[];
  moments: MomentDto[];
  variants: VariantInfo[];
  filmSettings: FilmOptions;
}

export interface DaySummary {
  date: Ymd;
  count: number;
  durationMs: number;
  posterUrl: string | null;
}

export interface StreakInfo {
  current: number;
  best: number;
  /** Сегодня уже записан хотя бы один момент. */
  todayDone: boolean;
}

export interface HomeDto {
  today: {
    date: Ymd;
    count: number;
    limit: number;
    durationMs: number;
    moments: MomentDto[];
  };
  streak: StreakInfo;
  /** Активность за последние недели (для мини-календаря). */
  activity: DaySummary[];
  recent: MomentDto[];
  latestFilm: FilmDto | null;
  /** Фильмы, которые ждут сборки (или собираются прямо сейчас). */
  rendering: FilmDto[];
  projects: ProjectDto[];
  onThisDay: { year: number; date: Ymd; moments: MomentDto[] }[];
  totals: { moments: number; durationMs: number; days: number };
}

export interface MeDto {
  user: { name: string; timezone: string; locale: string; createdAt: string };
  settings: UserSettings;
  limits: { maxPerDay: number; minMomentMs: number };
}

export interface StorageDto {
  totalBytes: number;
  /** Сколько браузер готов выделить приложению (0 — неизвестно). */
  quotaBytes: number;
  originalsBytes: number;
  filmsBytes: number;
  otherBytes: number;
  moments: number;
  films: number;
  /** Браузер пообещал не удалять данные приложения при нехватке места. */
  persisted: boolean;
}

export interface StatsDto {
  totals: { moments: number; durationMs: number; days: number; films: number; favorites: number; projects: number };
  streak: StreakInfo;
  firstDate: Ymd | null;
  byMonth: { month: string; count: number; durationMs: number; days: number }[];
  byWeekday: number[];
  byHour: number[];
  years: number[];
}

export interface MusicTrackDto {
  id: string;
  style: string;
  title: string;
  durationSec: number;
  url: string;
}
