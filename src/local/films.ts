// Фильмы: создание записи, заказ сборки, пересборка, удаление.
// Сам монтаж выполняет движок в браузере (src/local/render) на экране «премьеры».

import { z } from "zod";
import { getDict } from "@/i18n";
import {
  ORIENTATIONS,
  PROJECT_VARIANTS,
  RESOLUTIONS,
  VARIANT_TARGETS,
  type FilmKind,
  type FilmStyleId,
  type ProjectVariant,
} from "@/lib/constants";
import { diffDays, isValidYmd, parseYmd, type Ymd } from "@/lib/dates";
import { ApiError, badRequest, notFound } from "@/lib/errors";
import { capitalize, fmtFullDate, fmtMonthYear, fmtRange, fmtWeekday } from "@/lib/format";
import { musicChoice, styleChoice } from "@/lib/settings";
import type { FilmChapter, FilmDto, FilmOptions, VariantInfo } from "@/lib/types";
import { filmDto, filmDtos, filmMoments, nowIso, projectMoments } from "./core";
import { currentLocale, currentSettings } from "./profile";
import { blobKey, isQuotaError, newId, store, type FilmRec, type ProjectRec } from "./store";

const ymd = z.string().refine(isValidYmd);

export const filmOptionsSchema = z.object({
  style: styleChoice.optional(),
  music: musicChoice.optional(),
  musicVolume: z.number().min(0).max(1).optional(),
  orientation: z.enum(ORIENTATIONS).optional(),
  resolution: z.enum(RESOLUTIONS).optional(),
});
export type FilmOptionsInput = z.infer<typeof filmOptionsSchema>;

export const createFilmSchema = filmOptionsSchema.extend({
  kind: z.enum(["day", "week", "month", "year", "custom"]),
  dateFrom: ymd,
  dateTo: ymd,
  variant: z.enum(["full", "highlights"]).default("full"),
});
export type CreateFilmInput = z.infer<typeof createFilmSchema>;

export const createProjectFilmSchema = filmOptionsSchema.extend({
  variant: z.enum(PROJECT_VARIANTS),
});

/** Настройки по умолчанию, поверх них — слои (проект, выбор пользователя); пустые значения слой не перекрывают. */
export function resolveOptions(...layers: (Partial<FilmOptions> | undefined)[]): FilmOptions {
  const out: FilmOptions = { ...currentSettings().film };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined && v !== null && k in out) (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

export function filmTitles(kind: FilmKind, from: Ymd, to: Ymd, locale: string): { title: string; subtitle: string } {
  const t = getDict(locale).film;
  switch (kind) {
    case "day":
      return { title: fmtFullDate(from, locale), subtitle: capitalize(fmtWeekday(from, locale)) };
    case "week":
      return { title: fmtRange(from, to, locale), subtitle: t.kinds.week };
    case "month":
      return { title: fmtMonthYear(from, locale), subtitle: t.kinds.month };
    case "year":
      return { title: t.yearTitle(parseYmd(from).y), subtitle: t.kinds.year };
    default:
      return { title: fmtRange(from, to, locale), subtitle: t.kinds.custom };
  }
}

export function getFilmRec(filmId: string): FilmRec {
  const rec = store.films.get(filmId);
  if (!rec) throw notFound("film_not_found");
  return rec;
}

export function findFilms(opts: { projectId?: string } = {}): FilmRec[] {
  return [...store.films.values()]
    .filter((f) => !opts.projectId || f.projectId === opts.projectId)
    .sort((a, b) => (a.dateTo !== b.dateTo ? (a.dateTo < b.dateTo ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
}

export function listFilms(opts: { projectId?: string } = {}): Promise<FilmDto[]> {
  return filmDtos(findFilms(opts));
}

function blankFilm(fields: Pick<FilmRec, "projectId" | "kind" | "variant" | "title" | "subtitle" | "dateFrom" | "dateTo" | "auto" | "momentsCount">): FilmRec {
  const now = nowIso();
  return {
    id: newId(),
    ...fields,
    style: "auto",
    styleUsed: null,
    music: "auto",
    musicUsed: [],
    musicVolume: 0.5,
    orientation: "auto",
    resolution: "auto",
    status: "queued",
    progress: 0,
    stage: "",
    error: null,
    width: 0,
    height: 0,
    durationMs: 0,
    sizeBytes: 0,
    posterBytes: 0,
    hasFile: false,
    mime: "video/mp4",
    chapters: [],
    stale: false,
    createdAt: now,
    updatedAt: now,
    renderedAt: null,
  };
}

/** Заказывает сборку: фильм ждёт «премьеры». Прежний файл (если был) остаётся доступным. */
async function queueRender(film: FilmRec, options: FilmOptions): Promise<FilmRec> {
  const next: FilmRec = {
    ...film,
    style: options.style,
    music: options.music,
    musicVolume: options.musicVolume,
    orientation: options.orientation,
    resolution: options.resolution,
    status: "queued",
    progress: 0,
    stage: "",
    error: null,
    stale: false,
    updatedAt: nowIso(),
  };
  await store.putFilm(next);
  return next;
}

export async function createFilm(input: CreateFilmInput, opts: { auto?: boolean } = {}): Promise<FilmRec> {
  if (input.dateTo < input.dateFrom) throw badRequest("bad_range");
  if (diffDays(input.dateTo, input.dateFrom) > 1100) throw badRequest("range_too_long");

  const count = filmMoments({ projectId: null, dateFrom: input.dateFrom, dateTo: input.dateTo }).length;
  if (count === 0) throw badRequest("no_moments");

  const options = resolveOptions(input);
  const { title, subtitle } = filmTitles(input.kind, input.dateFrom, input.dateTo, currentLocale());

  // Один фильм на период и вариант: повторное создание пересобирает существующий.
  const existing = [...store.films.values()].find(
    (f) =>
      f.projectId === null &&
      f.kind === input.kind &&
      f.dateFrom === input.dateFrom &&
      f.dateTo === input.dateTo &&
      f.variant === input.variant,
  );
  const film =
    existing ??
    blankFilm({
      projectId: null,
      kind: input.kind,
      variant: input.variant,
      title,
      subtitle,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      auto: opts.auto ?? false,
      momentsCount: count,
    });
  return queueRender(film, options);
}

export interface Footage {
  count: number;
  totalSec: number;
  firstDate: Ymd | null;
  lastDate: Ymd | null;
}

export function projectFootage(projectId: string): Footage {
  const list = projectMoments(projectId);
  let totalMs = 0;
  let first: Ymd | null = null;
  let last: Ymd | null = null;
  for (const m of list) {
    totalMs += m.durationMs;
    if (first === null || m.date < first) first = m.date;
    if (last === null || m.date > last) last = m.date;
  }
  return { count: list.length, totalSec: Math.round(totalMs / 1000), firstDate: first, lastDate: last };
}

export async function createProjectFilm(
  project: ProjectRec,
  variant: ProjectVariant,
  input: FilmOptionsInput = {},
  opts: { auto?: boolean; today: Ymd },
): Promise<FilmRec> {
  const footage = projectFootage(project.id);
  if (footage.count === 0) throw badRequest("no_moments");
  if (variant !== "full" && footage.totalSec < VARIANT_TARGETS[variant].minFootage) {
    throw badRequest("not_enough_footage", { needSec: VARIANT_TARGETS[variant].minFootage });
  }
  const options = resolveOptions(project.filmSettings, input);
  const from = footage.firstDate ?? project.startDate;
  const to = project.endDate ?? footage.lastDate ?? opts.today;
  const dateTo = to < from ? from : to;
  const subtitle = fmtRange(project.startDate, project.endDate ?? footage.lastDate ?? opts.today, currentLocale());

  const existing = [...store.films.values()].find((f) => f.projectId === project.id && f.variant === variant);
  const film: FilmRec = existing
    ? { ...existing, title: project.title, subtitle, dateFrom: from, dateTo }
    : blankFilm({
        projectId: project.id,
        kind: "project",
        variant,
        title: project.title,
        subtitle,
        dateFrom: from,
        dateTo,
        auto: opts.auto ?? false,
        momentsCount: footage.count,
      });
  return queueRender(film, options);
}

export async function rerenderFilm(filmId: string, input: FilmOptionsInput): Promise<FilmRec> {
  const film = getFilmRec(filmId);
  if (filmMoments(film).length === 0) throw badRequest("no_moments");
  const current: FilmOptions = {
    style: film.style,
    music: film.music,
    musicVolume: film.musicVolume,
    orientation: film.orientation,
    resolution: film.resolution,
  };
  return queueRender(film, resolveOptions(current, input));
}

export async function deleteFilm(filmId: string): Promise<void> {
  getFilmRec(filmId);
  await store.removeFilm(filmId);
}

/** Какие версии финального фильма доступны при текущем объёме материала. */
export async function variantInfos(footage: Footage, films: FilmRec[]): Promise<VariantInfo[]> {
  const out: VariantInfo[] = [];
  for (const variant of PROJECT_VARIANTS) {
    const rec = films.find((f) => f.variant === variant) ?? null;
    const film = rec ? await filmDto(rec) : null;
    if (variant === "full") {
      out.push({ variant, available: footage.count > 0, needSec: 0, estimateSec: footage.totalSec, film });
      continue;
    }
    const cfg = VARIANT_TARGETS[variant];
    out.push({
      variant,
      available: footage.totalSec >= cfg.minFootage,
      needSec: cfg.minFootage,
      estimateSec: Math.min(cfg.target, footage.totalSec),
      film,
    });
  }
  return out;
}

// ── Жизненный цикл сборки (вызывает движок монтажа) ──────────

/** Начало сборки. Флаг «устарел» сбрасывается здесь: момент, появившийся во время монтажа, снова его поставит. */
export async function beginRender(filmId: string): Promise<FilmRec> {
  const film = getFilmRec(filmId);
  const next: FilmRec = { ...film, status: "rendering", progress: 0, stage: "prepare", error: null, stale: false, updatedAt: nowIso() };
  await store.putFilm(next);
  return next;
}

export interface RenderResult {
  video: Blob;
  poster: Blob | null;
  mime: string;
  width: number;
  height: number;
  durationMs: number;
  styleUsed: FilmStyleId;
  musicUsed: string[];
  chapters: FilmChapter[];
  momentsCount: number;
}

export async function completeRender(filmId: string, result: RenderResult): Promise<FilmRec> {
  const film = getFilmRec(filmId);
  const now = nowIso();
  const next: FilmRec = {
    ...film,
    status: "ready",
    progress: 100,
    stage: "",
    error: null,
    hasFile: true,
    mime: result.mime,
    width: result.width,
    height: result.height,
    durationMs: Math.round(result.durationMs),
    sizeBytes: result.video.size,
    posterBytes: result.poster?.size ?? 0,
    styleUsed: result.styleUsed,
    musicUsed: result.musicUsed,
    chapters: result.chapters,
    momentsCount: result.momentsCount,
    renderedAt: now,
    updatedAt: now,
  };
  const files: Record<string, Blob> = { [blobKey.filmVideo(filmId)]: result.video };
  if (result.poster) files[blobKey.filmPoster(filmId)] = result.poster;
  try {
    await store.putFilm(next, files);
  } catch (err) {
    if (isQuotaError(err)) throw new ApiError(413, "quota_exceeded");
    throw err;
  }
  if (!result.poster) await store.deleteBlob(blobKey.filmPoster(filmId));
  return next;
}

/** Сборка не удалась. Если у фильма есть прежняя версия, она остаётся доступной для просмотра. */
export async function failRender(filmId: string, code: string): Promise<void> {
  const film = store.films.get(filmId);
  if (!film) return;
  await store.putFilm({ ...film, status: film.hasFile ? "ready" : "failed", progress: 0, stage: "", error: code, updatedAt: nowIso() });
}

/** Сборку прервали (ушли с экрана, закрыли приложение): фильм снова ждёт своей очереди. */
export async function requeueRender(filmId: string): Promise<void> {
  const film = store.films.get(filmId);
  if (!film || film.status !== "rendering") return;
  await store.putFilm({ ...film, status: "queued", progress: 0, stage: "", updatedAt: nowIso() });
}
