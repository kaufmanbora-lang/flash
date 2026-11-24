// Проекты воспоминаний: создание, пауза и продолжение, продление, досрочное завершение, обложки.

import { z } from "zod";
import { COVER_PRESETS, PERIOD_KINDS, type CoverPreset } from "./constants";
import { addDays, diffDays, isValidYmd, maxYmd, minYmd, type Ymd } from "./dates";
import { exec, q, q1, tx } from "./db";
import { filmDto, momentDto } from "./dto";
import { badRequest, conflict, notFound } from "./errors";
import {
  createProjectFilm,
  filmOptionsSchema,
  projectFootage,
  resolveOptions,
  variantInfos,
} from "./film-service";
import { markFilmsStale, refreshProjectCovers } from "./moment-service";
import { pauseShift, periodEnd, projectDays, projectProgress, type PauseSpan } from "./projects";
import { enqueueUnique } from "./queue";
import type { UserSettings } from "./settings";
import { signMediaUrl } from "./signing";
import { keys, storage } from "./storage";
import type { FilmRow, MomentRow, ProjectDetailDto, ProjectDto, ProjectRow } from "./types";

const ymd = z.string().refine(isValidYmd, "Некорректная дата");
const MAX_PROJECT_DAYS = 366 * 5;

export const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  periodKind: z.enum(PERIOD_KINDS),
  startDate: ymd,
  endDate: ymd.nullable().optional(),
  coverPreset: z.enum(COVER_PRESETS).optional(),
  /** Добавить в проект уже записанные моменты, попадающие в период. */
  includeExisting: z.boolean().default(true),
  today: ymd,
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object({
  today: ymd,
  title: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  cover: z
    .object({
      kind: z.enum(["auto", "preset", "moment"]),
      preset: z.enum(COVER_PRESETS).optional(),
      momentId: z.string().uuid().optional(),
    })
    .optional(),
  action: z.enum(["pause", "resume", "complete", "extend", "setEnd", "reopen"]).optional(),
  /** Для extend: на сколько дней продлить. */
  days: z.number().int().min(1).max(366).optional(),
  /** Для setEnd: новая дата окончания; null делает проект бессрочным. */
  endDate: ymd.nullable().optional(),
  filmSettings: filmOptionsSchema.optional(),
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

type ProjectWithStats = ProjectRow & {
  moments_count: number;
  duration_ms: number;
  days_recorded: number;
  today_count: number;
  cover_moment_poster: string | null;
  first_poster: string | null;
};

const SELECT_PROJECT = `
  SELECT p.*,
         COALESCE(s.moments_count, 0) AS moments_count,
         COALESCE(s.duration_ms, 0) AS duration_ms,
         COALESCE(s.days_recorded, 0) AS days_recorded,
         COALESCE(s.today_count, 0) AS today_count,
         s.first_poster,
         (SELECT poster_key FROM moments WHERE id = p.cover_moment_id) AS cover_moment_poster
  FROM projects p
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS moments_count,
           COALESCE(sum(m.duration_ms), 0)::bigint AS duration_ms,
           count(DISTINCT m.local_date)::int AS days_recorded,
           count(*) FILTER (WHERE m.local_date = $2)::int AS today_count,
           (array_agg(m.poster_key ORDER BY m.recorded_at) FILTER (WHERE m.poster_key IS NOT NULL))[1] AS first_poster
    FROM project_moments pm JOIN moments m ON m.id = pm.moment_id
    WHERE pm.project_id = p.id AND m.status IN ('ready', 'processing')
  ) s ON true`;

function coverOf(row: ProjectWithStats): ProjectDto["cover"] {
  let key: string | null = null;
  if (row.cover_kind === "moment") key = row.cover_moment_poster ?? row.cover_key ?? row.first_poster;
  else if (row.cover_kind === "auto") key = row.cover_key ?? row.first_poster;
  return { kind: row.cover_kind, preset: row.cover_preset, url: signMediaUrl(key), momentId: row.cover_moment_id };
}

function projectDto(row: ProjectWithStats, today: Ymd, film: FilmRow | null): ProjectDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    periodKind: row.period_kind,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    progress: projectProgress(row, today),
    cover: coverOf(row),
    momentsCount: row.moments_count,
    durationMs: row.duration_ms,
    daysRecorded: row.days_recorded,
    todayCount: row.today_count,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    film: film ? filmDto(film) : null,
  };
}

async function mainFilms(projectIds: string[]): Promise<Map<string, FilmRow>> {
  if (projectIds.length === 0) return new Map();
  const rows = await q<FilmRow>(
    `SELECT DISTINCT ON (project_id) * FROM films
     WHERE project_id = ANY($1::uuid[]) AND file_key IS NOT NULL
     ORDER BY project_id, array_position(ARRAY['full', 'extended', 'mini', 'trailer'], variant), rendered_at DESC NULLS LAST`,
    [projectIds],
  );
  return new Map(rows.map((r) => [r.project_id!, r]));
}

export async function getProjectRow(userId: string, id: string): Promise<ProjectRow> {
  const row = await q1<ProjectRow>(`SELECT * FROM projects WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!row) throw notFound("project_not_found");
  return row;
}

export async function listProjects(userId: string, today: Ymd, status?: "open" | "completed"): Promise<ProjectDto[]> {
  const cond =
    status === "open" ? `AND p.status <> 'completed'` : status === "completed" ? `AND p.status = 'completed'` : "";
  const rows = await q<ProjectWithStats>(
    `${SELECT_PROJECT} WHERE p.user_id = $1 ${cond}
     ORDER BY (p.status = 'completed'), COALESCE(p.completed_at, p.created_at) DESC`,
    [userId, today],
  );
  const films = await mainFilms(rows.map((r) => r.id));
  return rows.map((r) => projectDto(r, today, films.get(r.id) ?? null));
}

export async function getProjectDetail(userId: string, id: string, today: Ymd, settings: UserSettings): Promise<ProjectDetailDto> {
  const row = await q1<ProjectWithStats>(`${SELECT_PROJECT} WHERE p.user_id = $1 AND p.id = $3`, [userId, today, id]);
  if (!row) throw notFound("project_not_found");

  const moments = await q<MomentRow & { project_ids: string[] }>(
    `SELECT m.*, COALESCE((SELECT array_agg(x.project_id::text) FROM project_moments x WHERE x.moment_id = m.id), '{}') AS project_ids
     FROM moments m JOIN project_moments pm ON pm.moment_id = m.id
     WHERE pm.project_id = $1 AND m.user_id = $2 AND m.status IN ('ready', 'processing', 'failed')
     ORDER BY m.recorded_at DESC, m.id DESC`,
    [id, userId],
  );
  const counts = new Map<Ymd, number>();
  for (const m of moments) {
    if (m.status !== "failed") counts.set(m.local_date, (counts.get(m.local_date) ?? 0) + 1);
  }
  const films = await q<FilmRow>(`SELECT * FROM films WHERE project_id = $1 AND user_id = $2`, [id, userId]);
  const footage = await projectFootage(id);
  const main = (await mainFilms([id])).get(id) ?? null;

  return {
    ...projectDto(row, today, main),
    days: projectDays(row, today, counts),
    moments: moments.map(momentDto),
    variants: variantInfos(footage, films),
    filmSettings: resolveOptions(settings, row.film_settings),
  };
}

export async function createProject(userId: string, input: CreateProjectInput): Promise<ProjectRow> {
  let endDate: Ymd | null;
  if (input.periodKind === "custom") {
    if (!input.endDate) throw badRequest("end_required");
    endDate = input.endDate;
  } else if (input.periodKind === "open") {
    endDate = null;
  } else {
    endDate = periodEnd(input.periodKind, input.startDate);
  }
  if (endDate && endDate < input.startDate) throw badRequest("bad_range");
  if (endDate && diffDays(endDate, input.startDate) > MAX_PROJECT_DAYS) throw badRequest("range_too_long");
  if (endDate && endDate < input.today) throw badRequest("end_in_past");

  const preset: CoverPreset =
    input.coverPreset ?? COVER_PRESETS[Math.floor(Math.random() * (COVER_PRESETS.length - 1))];

  const row = await tx(async (t) => {
    const p = await t.q1<ProjectRow>(
      `INSERT INTO projects (user_id, title, description, period_kind, start_date, end_date, cover_preset)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [userId, input.title, input.description, input.periodKind, input.startDate, endDate, preset],
    );
    if (input.includeExisting) {
      await t.exec(
        `INSERT INTO project_moments (project_id, moment_id)
         SELECT $1, id FROM moments
         WHERE user_id = $2 AND status IN ('ready', 'processing') AND local_date >= $3 AND local_date <= $4
         ON CONFLICT DO NOTHING`,
        [p!.id, userId, input.startDate, endDate ?? input.today],
      );
    }
    return p!;
  });
  await enqueueUnique("project_cover", { projectId: row.id }, 1);
  return row;
}

/**
 * Завершает проект и запускает сборку финального фильма (если в проекте есть моменты).
 * Используется и кнопкой «Завершить досрочно», и планировщиком по истечении срока.
 */
export async function completeProject(
  user: { id: string; locale: string },
  settings: UserSettings,
  project: ProjectRow,
  today: Ymd,
  opts: { early: boolean },
): Promise<{ project: ProjectRow; film: FilmRow | null }> {
  if (project.status === "completed") return { project, film: null };
  let pauses = project.pauses;
  let endDate = project.end_date;
  const open = pauses.find((p) => p.to === null);
  if (open) pauses = pauses.map((p) => (p === open ? { ...p, to: today } : p));
  if (opts.early || !endDate) endDate = maxYmd(project.start_date, endDate ? minYmd(endDate, today) : today);

  const updated = (await q1<ProjectRow>(
    `UPDATE projects SET status = 'completed', completed_at = now(), end_date = $2, pauses = $3::jsonb, updated_at = now()
     WHERE id = $1 AND status <> 'completed' RETURNING *`,
    [project.id, endDate, JSON.stringify(pauses)],
  )) ?? { ...project, status: "completed" as const };

  let film: FilmRow | null = null;
  const footage = await projectFootage(project.id);
  if (footage.count > 0) {
    film = await createProjectFilm(user, settings, updated, "full", {}, { auto: true, today });
  }
  return { project: updated, film };
}

export async function updateProject(
  user: { id: string; locale: string },
  settings: UserSettings,
  id: string,
  input: UpdateProjectInput,
): Promise<void> {
  const project = await getProjectRow(user.id, id);
  const today = input.today;

  if (input.title !== undefined || input.description !== undefined) {
    await exec(
      `UPDATE projects SET title = COALESCE($2, title), description = COALESCE($3, description), updated_at = now() WHERE id = $1`,
      [id, input.title ?? null, input.description ?? null],
    );
    if (input.title !== undefined && input.title !== project.title) {
      await exec(`UPDATE films SET title = $2 WHERE project_id = $1`, [id, input.title]);
    }
  }

  if (input.filmSettings) {
    const merged = { ...project.film_settings, ...input.filmSettings };
    await exec(`UPDATE projects SET film_settings = $2::jsonb, updated_at = now() WHERE id = $1`, [
      id,
      JSON.stringify(merged),
    ]);
  }

  if (input.cover) {
    if (input.cover.kind === "moment") {
      if (!input.cover.momentId) throw badRequest("moment_required");
      const owned = await q1(
        `SELECT 1 FROM moments m JOIN project_moments pm ON pm.moment_id = m.id
         WHERE m.id = $1 AND m.user_id = $2 AND pm.project_id = $3`,
        [input.cover.momentId, user.id, id],
      );
      if (!owned) throw badRequest("moment_not_in_project");
      await exec(`UPDATE projects SET cover_kind = 'moment', cover_moment_id = $2, updated_at = now() WHERE id = $1`, [
        id,
        input.cover.momentId,
      ]);
    } else if (input.cover.kind === "preset") {
      await exec(
        `UPDATE projects SET cover_kind = 'preset', cover_preset = COALESCE($2, cover_preset), updated_at = now() WHERE id = $1`,
        [id, input.cover.preset ?? null],
      );
    } else {
      await exec(`UPDATE projects SET cover_kind = 'auto', updated_at = now() WHERE id = $1`, [id]);
      await enqueueUnique("project_cover", { projectId: id });
    }
  }

  switch (input.action) {
    case "pause": {
      if (project.status !== "active") throw conflict("not_active");
      const pauses: PauseSpan[] = [...project.pauses, { from: today, to: null }];
      await exec(`UPDATE projects SET status = 'paused', pauses = $2::jsonb, updated_at = now() WHERE id = $1`, [
        id,
        JSON.stringify(pauses),
      ]);
      break;
    }
    case "resume": {
      if (project.status !== "paused") throw conflict("not_paused");
      const open = project.pauses.find((p) => p.to === null);
      const shift = open ? pauseShift(open, today) : 0;
      const pauses = project.pauses.map((p) => (p.to === null ? { ...p, to: today } : p));
      // Срок сдвигается на длину паузы: запланированное число дней записи сохраняется.
      const endDate = project.end_date ? addDays(project.end_date, shift) : null;
      await exec(
        `UPDATE projects SET status = 'active', pauses = $2::jsonb, end_date = $3, updated_at = now() WHERE id = $1`,
        [id, JSON.stringify(pauses), endDate],
      );
      break;
    }
    case "complete": {
      if (project.status === "completed") throw conflict("already_completed");
      await completeProject(user, settings, project, today, { early: true });
      break;
    }
    case "extend": {
      const days = input.days ?? 7;
      const base = project.end_date ? maxYmd(project.end_date, addDays(today, -1)) : null;
      if (!base) throw conflict("open_ended");
      const endDate = addDays(base, days);
      if (diffDays(endDate, project.start_date) > MAX_PROJECT_DAYS) throw badRequest("range_too_long");
      // Продление завершённого проекта возвращает его в работу.
      await exec(
        `UPDATE projects SET end_date = $2, period_kind = 'custom',
                status = CASE WHEN status = 'completed' THEN 'active' ELSE status END,
                completed_at = CASE WHEN status = 'completed' THEN NULL ELSE completed_at END,
                updated_at = now()
         WHERE id = $1`,
        [id, endDate],
      );
      break;
    }
    case "setEnd": {
      if (project.status === "completed") throw conflict("already_completed");
      if (input.endDate === undefined) throw badRequest("end_required");
      if (input.endDate === null) {
        await exec(`UPDATE projects SET end_date = NULL, period_kind = 'open', updated_at = now() WHERE id = $1`, [id]);
      } else {
        if (input.endDate < project.start_date) throw badRequest("bad_range");
        if (input.endDate < today) throw badRequest("end_in_past");
        if (diffDays(input.endDate, project.start_date) > MAX_PROJECT_DAYS) throw badRequest("range_too_long");
        await exec(`UPDATE projects SET end_date = $2, period_kind = 'custom', updated_at = now() WHERE id = $1`, [
          id,
          input.endDate,
        ]);
      }
      break;
    }
    case "reopen": {
      if (project.status !== "completed") throw conflict("not_completed");
      const endDate = project.end_date && project.end_date >= today ? project.end_date : null;
      await exec(
        `UPDATE projects SET status = 'active', completed_at = NULL, end_date = $2,
                period_kind = CASE WHEN $2::date IS NULL THEN 'open' ELSE period_kind END, updated_at = now()
         WHERE id = $1`,
        [id, endDate],
      );
      break;
    }
    default:
      break;
  }
}

export async function deleteProject(userId: string, id: string, deleteFilms: boolean): Promise<void> {
  const project = await getProjectRow(userId, id);
  const store = await storage();
  if (deleteFilms) {
    const films = await q<FilmRow>(`SELECT * FROM films WHERE project_id = $1 AND user_id = $2`, [id, userId]);
    for (const film of films) {
      await store.deletePrefix(keys.filmPrefix(userId, film.id)).catch(() => {});
    }
    await exec(`DELETE FROM films WHERE project_id = $1 AND user_id = $2`, [id, userId]);
  }
  await store.deletePrefix(keys.projectPrefix(userId, project.id)).catch(() => {});
  // Исходные моменты остаются в архиве: удаляется только связь с проектом.
  await exec(`DELETE FROM projects WHERE id = $1 AND user_id = $2`, [id, userId]);
}

/** Добавляет или убирает момент из проекта вручную. */
export async function setProjectMoment(userId: string, projectId: string, momentId: string, include: boolean): Promise<void> {
  await getProjectRow(userId, projectId);
  const moment = await q1<MomentRow>(`SELECT * FROM moments WHERE id = $1 AND user_id = $2`, [momentId, userId]);
  if (!moment) throw notFound("moment_not_found");
  if (include) {
    await exec(`INSERT INTO project_moments (project_id, moment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      projectId,
      momentId,
    ]);
  } else {
    await exec(`DELETE FROM project_moments WHERE project_id = $1 AND moment_id = $2`, [projectId, momentId]);
  }
  await markFilmsStale(userId, "0001-01-01", [projectId]);
  await refreshProjectCovers([projectId]);
}
