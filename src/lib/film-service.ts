// Фильмы: создание записи, постановка монтажа в очередь, пересборка, удаление.
// Сам монтаж выполняет отдельный воркер (src/worker/render-film.ts).

import { z } from "zod";
import { getDict } from "@/i18n";
import {
  ORIENTATIONS,
  PROJECT_VARIANTS,
  RESOLUTIONS,
  VARIANT_TARGETS,
  type FilmKind,
  type ProjectVariant,
} from "./constants";
import { diffDays, isValidYmd, parseYmd, type Ymd } from "./dates";
import { exec, q, q1 } from "./db";
import { filmDto } from "./dto";
import { badRequest, notFound } from "./errors";
import { capitalize, fmtFullDate, fmtMonthYear, fmtRange, fmtWeekday } from "./format";
import { enqueue } from "./queue";
import { musicChoice, styleChoice, type UserSettings } from "./settings";
import { keys, storage } from "./storage";
import type { FilmDto, FilmOptions, FilmRow, MomentRow, ProjectRow, VariantInfo } from "./types";

const ymd = z.string().refine(isValidYmd, "Некорректная дата");

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

export function resolveOptions(settings: UserSettings, ...layers: (Partial<FilmOptions> | undefined)[]): FilmOptions {
  const out: FilmOptions = { ...settings.film };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined && v !== null) (out as unknown as Record<string, unknown>)[k] = v;
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

/** Готовые моменты, входящие в фильм, в хронологическом порядке. */
export async function filmMoments(film: Pick<FilmRow, "user_id" | "project_id" | "date_from" | "date_to">): Promise<MomentRow[]> {
  if (film.project_id) {
    return q<MomentRow>(
      `SELECT m.* FROM moments m JOIN project_moments pm ON pm.moment_id = m.id
       WHERE pm.project_id = $1 AND m.user_id = $2 AND m.status = 'ready'
       ORDER BY m.recorded_at, m.id`,
      [film.project_id, film.user_id],
    );
  }
  return q<MomentRow>(
    `SELECT * FROM moments
     WHERE user_id = $1 AND status = 'ready' AND local_date BETWEEN $2 AND $3
     ORDER BY recorded_at, id`,
    [film.user_id, film.date_from, film.date_to],
  );
}

export async function getFilmRow(userId: string, id: string): Promise<FilmRow> {
  const row = await q1<FilmRow>(`SELECT * FROM films WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!row) throw notFound("film_not_found");
  return row;
}

export async function listFilms(userId: string, opts: { projectId?: string; limit?: number } = {}): Promise<FilmDto[]> {
  const params: unknown[] = [userId];
  let cond = "";
  if (opts.projectId) {
    params.push(opts.projectId);
    cond = `AND project_id = $2`;
  }
  params.push(Math.min(opts.limit ?? 300, 500));
  const rows = await q<FilmRow>(
    `SELECT * FROM films WHERE user_id = $1 ${cond}
     ORDER BY date_to DESC, created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(filmDto);
}

/** Ставит монтаж в очередь. Номер ревизии защищает от гонки: устаревшие задачи воркер пропускает. */
async function queueRender(film: FilmRow, options: FilmOptions): Promise<FilmRow> {
  const row = await q1<FilmRow>(
    `UPDATE films
     SET style = $2, music = $3, music_volume = $4, orientation = $5, resolution = $6,
         status = 'queued', progress = 0, stage = '', error = NULL, stale = false,
         revision = revision + 1, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [film.id, options.style, options.music, options.musicVolume, options.orientation, options.resolution],
  );
  await enqueue("render_film", { filmId: row!.id, revision: row!.revision }, { maxAttempts: 2 });
  return row!;
}

export async function createFilm(
  user: { id: string; locale: string },
  settings: UserSettings,
  input: CreateFilmInput,
  opts: { auto?: boolean } = {},
): Promise<FilmRow> {
  if (input.dateTo < input.dateFrom) throw badRequest("bad_range");
  if (diffDays(input.dateTo, input.dateFrom) > 1100) throw badRequest("range_too_long");

  const count = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM moments WHERE user_id = $1 AND status = 'ready' AND local_date BETWEEN $2 AND $3`,
    [user.id, input.dateFrom, input.dateTo],
  );
  if (!count || count.n === 0) throw badRequest("no_moments");

  const options = resolveOptions(settings, input);
  const { title, subtitle } = filmTitles(input.kind, input.dateFrom, input.dateTo, user.locale);

  // Один фильм на период и вариант: повторное создание пересобирает существующий.
  let film = await q1<FilmRow>(
    `SELECT * FROM films WHERE user_id = $1 AND project_id IS NULL AND kind = $2 AND date_from = $3 AND date_to = $4 AND variant = $5`,
    [user.id, input.kind, input.dateFrom, input.dateTo, input.variant],
  );
  if (!film) {
    film = await q1<FilmRow>(
      `INSERT INTO films (user_id, kind, variant, title, subtitle, date_from, date_to, auto, moments_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [user.id, input.kind, input.variant, title, subtitle, input.dateFrom, input.dateTo, opts.auto ?? false, count.n],
    );
  }
  return queueRender(film!, options);
}

export async function createProjectFilm(
  user: { id: string; locale: string },
  settings: UserSettings,
  project: ProjectRow,
  variant: ProjectVariant,
  input: FilmOptionsInput = {},
  opts: { auto?: boolean; today: Ymd },
): Promise<FilmRow> {
  const footage = await projectFootage(project.id);
  if (footage.count === 0) throw badRequest("no_moments");
  if (variant !== "full" && footage.totalSec < VARIANT_TARGETS[variant].minFootage) {
    throw badRequest("not_enough_footage", undefined, { needSec: VARIANT_TARGETS[variant].minFootage });
  }
  const options = resolveOptions(settings, project.film_settings, input);
  const from = footage.firstDate ?? project.start_date;
  const to = project.end_date ?? footage.lastDate ?? opts.today;
  const dateTo = to < from ? from : to;
  const subtitle = fmtRange(project.start_date, project.end_date ?? footage.lastDate ?? opts.today, user.locale);

  let film = await q1<FilmRow>(`SELECT * FROM films WHERE project_id = $1 AND variant = $2 AND user_id = $3`, [
    project.id,
    variant,
    user.id,
  ]);
  if (!film) {
    film = await q1<FilmRow>(
      `INSERT INTO films (user_id, project_id, kind, variant, title, subtitle, date_from, date_to, auto, moments_count)
       VALUES ($1, $2, 'project', $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [user.id, project.id, variant, project.title, subtitle, from, dateTo, opts.auto ?? false, footage.count],
    );
  } else {
    await exec(`UPDATE films SET title = $2, subtitle = $3, date_from = $4, date_to = $5 WHERE id = $1`, [
      film.id,
      project.title,
      subtitle,
      from,
      dateTo,
    ]);
  }
  return queueRender(film!, options);
}

export async function rerenderFilm(
  user: { id: string; locale: string },
  settings: UserSettings,
  filmId: string,
  input: FilmOptionsInput,
): Promise<FilmRow> {
  const film = await getFilmRow(user.id, filmId);
  const moments = await filmMoments(film);
  if (moments.length === 0) throw badRequest("no_moments");
  const current: FilmOptions = {
    style: film.style,
    music: film.music,
    musicVolume: film.music_volume,
    orientation: film.orientation,
    resolution: film.resolution,
  };
  return queueRender(film, resolveOptions(settings, current, input));
}

export async function deleteFilm(userId: string, filmId: string): Promise<void> {
  const film = await getFilmRow(userId, filmId);
  const store = await storage();
  await store.deletePrefix(keys.filmPrefix(userId, film.id)).catch((err) => {
    console.error("[films] не удалось удалить файлы фильма", film.id, err);
  });
  await exec(`DELETE FROM films WHERE id = $1 AND user_id = $2`, [filmId, userId]);
}

export interface Footage {
  count: number;
  totalSec: number;
  firstDate: Ymd | null;
  lastDate: Ymd | null;
}

export async function projectFootage(projectId: string): Promise<Footage> {
  const row = await q1<{ n: number; total_ms: number; first: Ymd | null; last: Ymd | null }>(
    `SELECT count(*)::int AS n, COALESCE(sum(m.duration_ms), 0)::bigint AS total_ms,
            min(m.local_date) AS first, max(m.local_date) AS last
     FROM project_moments pm JOIN moments m ON m.id = pm.moment_id
     WHERE pm.project_id = $1 AND m.status = 'ready'`,
    [projectId],
  );
  return {
    count: row?.n ?? 0,
    totalSec: Math.round((row?.total_ms ?? 0) / 1000),
    firstDate: row?.first ?? null,
    lastDate: row?.last ?? null,
  };
}

/** Какие версии финального фильма доступны при текущем объёме материала. */
export function variantInfos(footage: Footage, films: FilmRow[]): VariantInfo[] {
  return PROJECT_VARIANTS.map((variant) => {
    const film = films.find((f) => f.variant === variant) ?? null;
    if (variant === "full") {
      return {
        variant,
        available: footage.count > 0,
        needSec: 0,
        estimateSec: footage.totalSec,
        film: film ? filmDto(film) : null,
      };
    }
    const cfg = VARIANT_TARGETS[variant];
    return {
      variant,
      available: footage.totalSec >= cfg.minFootage,
      needSec: cfg.minFootage,
      estimateSec: Math.min(cfg.target, footage.totalSec),
      film: film ? filmDto(film) : null,
    };
  });
}
