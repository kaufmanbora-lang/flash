// Строки базы данных и объекты API. Общие для сервера, воркера и интерфейса.

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
import type { PauseSpan, ProjectDay, ProjectProgress, ProjectStatus } from "./projects";
import type { MusicChoice, StyleChoice, UserSettings } from "./settings";
import type { StoredPart } from "./storage";

// ── Строки таблиц ────────────────────────────────────────────

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  timezone: string;
  locale: string;
  settings: unknown;
  created_at: Date;
}

export type MomentStatus = "uploading" | "processing" | "ready" | "failed";

/** Профиль «интересности» по секундам: громкость (дБ) и движение в кадре (0…1). */
export interface MomentAnalysis {
  energy: number[];
  motion: number[];
}

export interface MomentRow {
  id: string;
  user_id: string;
  client_id: string;
  recorded_at: Date;
  local_date: Ymd;
  local_time: string;
  note: string;
  source: "camera" | "upload";
  status: MomentStatus;
  error: string | null;
  mime: string;
  ext: string;
  expected_size: number;
  size_bytes: number;
  duration_ms: number;
  width: number;
  height: number;
  has_audio: boolean;
  original_key: string | null;
  playback_key: string | null;
  poster_key: string | null;
  playback_size: number;
  poster_size: number;
  favorite: boolean;
  analysis: MomentAnalysis | null;
  upload_id: string | null;
  parts: StoredPart[];
  created_at: Date;
  updated_at: Date;
}

export interface ProjectRow {
  id: string;
  user_id: string;
  title: string;
  description: string;
  period_kind: PeriodKind;
  start_date: Ymd;
  end_date: Ymd | null;
  status: ProjectStatus;
  pauses: PauseSpan[];
  completed_at: Date | null;
  cover_kind: "auto" | "preset" | "moment";
  cover_preset: CoverPreset;
  cover_moment_id: string | null;
  cover_key: string | null;
  cover_size: number;
  cover_version: number;
  film_settings: Partial<FilmOptions>;
  created_at: Date;
  updated_at: Date;
}

export type FilmStatus = "queued" | "rendering" | "ready" | "failed";

export interface FilmChapter {
  title: string;
  startMs: number;
}

export interface FilmRow {
  id: string;
  user_id: string;
  project_id: string | null;
  kind: FilmKind;
  variant: FilmVariant;
  title: string;
  subtitle: string;
  date_from: Ymd;
  date_to: Ymd;
  style: StyleChoice;
  style_used: FilmStyleId | null;
  music: MusicChoice;
  music_used: string[];
  music_volume: number;
  orientation: Orientation;
  resolution: Resolution;
  status: FilmStatus;
  progress: number;
  stage: string;
  error: string | null;
  width: number;
  height: number;
  duration_ms: number;
  size_bytes: number;
  moments_count: number;
  file_key: string | null;
  poster_key: string | null;
  poster_size: number;
  chapters: FilmChapter[];
  auto: boolean;
  stale: boolean;
  revision: number;
  created_at: Date;
  updated_at: Date;
  rendered_at: Date | null;
}

/** Параметры оформления фильма, которые выбирает пользователь. */
export interface FilmOptions {
  style: StyleChoice;
  music: MusicChoice;
  musicVolume: number;
  orientation: Orientation;
  resolution: Resolution;
}

// ── Объекты API ──────────────────────────────────────────────

export interface MomentDto {
  id: string;
  clientId: string;
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
  rendering: FilmDto[];
  projects: ProjectDto[];
  onThisDay: { year: number; date: Ymd; moments: MomentDto[] }[];
  totals: { moments: number; durationMs: number; days: number };
}

export interface MeDto {
  user: { id: string; email: string; name: string; timezone: string; locale: string; createdAt: string };
  settings: UserSettings;
  limits: { maxPerDay: number; minMomentMs: number; chunkBytes: number; quotaBytes: number };
  push: { publicKey: string | null; devices: number };
}

export interface StorageDto {
  totalBytes: number;
  quotaBytes: number;
  originalsBytes: number;
  playbackBytes: number;
  filmsBytes: number;
  otherBytes: number;
  moments: number;
  films: number;
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

export interface UploadInitDto {
  moment: MomentDto;
  chunkBytes: number;
  uploadedParts: number[];
}
