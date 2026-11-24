// Проекты воспоминаний: создание, пауза и продолжение, продление, досрочное завершение, обложки.

import { z } from "zod";
import { COVER_PRESETS, PERIOD_KINDS, type CoverPreset } from "@/lib/constants";
import { addDays, diffDays, isValidYmd, maxYmd, minYmd, type Ymd } from "@/lib/dates";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { pauseShift, periodEnd, projectDays, projectProgress, type PauseSpan } from "@/lib/projects";
import type { ProjectDetailDto, ProjectDto } from "@/lib/types";
import { filmDto, markFilmsStale, momentDtos, nowIso, projectMoments } from "./core";
import { createProjectFilm, filmOptionsSchema, projectFootage, resolveOptions, variantInfos } from "./films";
import { blobKey, newId, projectTiming, store, type FilmRec, type MomentRec, type ProjectRec } from "./store";
import { background } from "./tasks";

const ymd = z.string().refine(isValidYmd);
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
      momentId: z.string().min(1).max(64).optional(),
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

export function getProjectRec(projectId: string): ProjectRec {
  const rec = store.projects.get(projectId);
  if (!rec) throw notFound("project_not_found");
  return rec;
}

async function coverOf(project: ProjectRec, moments: MomentRec[]): Promise<ProjectDto["cover"]> {
  const firstPoster = moments.find((m) => m.posterBytes > 0);
  const collage = () => (project.coverBytes > 0 ? store.url(blobKey.projectCover(project.id)) : Promise.resolve(null));
  const first = () => (firstPoster ? store.url(blobKey.momentPoster(firstPoster.id)) : Promise.resolve(null));
  let url: string | null = null;
  if (project.coverKind === "moment") {
    const chosen = project.coverMomentId ? store.moments.get(project.coverMomentId) : undefined;
    if (chosen && chosen.posterBytes > 0) url = await store.url(blobKey.momentPoster(chosen.id));
    url ??= (await collage()) ?? (await first());
  } else if (project.coverKind === "auto") {
    url = (await collage()) ?? (await first());
  }
  return { kind: project.coverKind, preset: project.coverPreset, url, momentId: project.coverMomentId };
}

const VARIANT_ORDER = ["full", "extended", "mini", "trailer"];

/** Главный готовый фильм проекта: самая полная из собранных версий. */
function mainFilm(projectId: string): FilmRec | null {
  const films = [...store.films.values()].filter((f) => f.projectId === projectId && f.hasFile);
  films.sort((a, b) => {
    const va = VARIANT_ORDER.indexOf(a.variant);
    const vb = VARIANT_ORDER.indexOf(b.variant);
    if (va !== vb) return (va < 0 ? 99 : va) - (vb < 0 ? 99 : vb);
    return (b.renderedAt ?? "") < (a.renderedAt ?? "") ? -1 : 1;
  });
  return films[0] ?? null;
}

async function projectDto(project: ProjectRec, today: Ymd, moments = projectMoments(project.id)): Promise<ProjectDto> {
  const film = mainFilm(project.id);
  return {
    id: project.id,
    title: project.title,
    description: project.description,
    periodKind: project.periodKind,
    startDate: project.startDate,
    endDate: project.endDate,
    status: project.status,
    progress: projectProgress(projectTiming(project), today),
    cover: await coverOf(project, moments),
    momentsCount: moments.length,
    durationMs: moments.reduce((s, m) => s + m.durationMs, 0),
    daysRecorded: new Set(moments.map((m) => m.date)).size,
    todayCount: moments.filter((m) => m.date === today).length,
    createdAt: project.createdAt,
    completedAt: project.completedAt,
    film: film ? await filmDto(film) : null,
  };
}

export async function listProjects(today: Ymd, status?: "open" | "completed"): Promise<ProjectDto[]> {
  const list = [...store.projects.values()].filter((p) =>
    status === "open" ? p.status !== "completed" : status === "completed" ? p.status === "completed" : true,
  );
  // Сначала идущие проекты, затем завершённые; внутри — свежие сверху.
  list.sort((a, b) => {
    const ca = a.status === "completed" ? 1 : 0;
    const cb = b.status === "completed" ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const ta = a.completedAt ?? a.createdAt;
    const tb = b.completedAt ?? b.createdAt;
    return ta < tb ? 1 : ta > tb ? -1 : 0;
  });
  return Promise.all(list.map((p) => projectDto(p, today)));
}

export async function getProjectDetail(projectId: string, today: Ymd): Promise<ProjectDetailDto> {
  const project = getProjectRec(projectId);
  const moments = projectMoments(projectId);
  const counts = new Map<Ymd, number>();
  for (const m of moments) counts.set(m.date, (counts.get(m.date) ?? 0) + 1);
  const films = [...store.films.values()].filter((f) => f.projectId === projectId);
  return {
    ...(await projectDto(project, today, moments)),
    days: projectDays(projectTiming(project), today, counts),
    moments: await momentDtos([...moments].reverse()),
    variants: await variantInfos(projectFootage(projectId), films),
    filmSettings: resolveOptions(project.filmSettings),
  };
}

export async function createProject(input: CreateProjectInput): Promise<ProjectRec> {
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

  // «Молоко» — почти белая обложка, случайно её не выбираем.
  const preset: CoverPreset = input.coverPreset ?? COVER_PRESETS[Math.floor(Math.random() * (COVER_PRESETS.length - 1))];
  const now = nowIso();
  const project: ProjectRec = {
    id: newId(),
    title: input.title,
    description: input.description,
    periodKind: input.periodKind,
    startDate: input.startDate,
    endDate,
    status: "active",
    pauses: [],
    completedAt: null,
    coverKind: "auto",
    coverPreset: preset,
    coverMomentId: null,
    coverBytes: 0,
    filmSettings: {},
    createdAt: now,
    updatedAt: now,
  };
  await store.putProject(project);

  if (input.includeExisting) {
    const last = endDate ?? input.today;
    for (const m of [...store.moments.values()]) {
      if (m.date < input.startDate || m.date > last || m.projectIds.includes(project.id)) continue;
      await store.putMoment({ ...m, projectIds: [...m.projectIds, project.id], updatedAt: now });
    }
  }
  background.refreshCover(project.id);
  return project;
}

/**
 * Завершает проект и заказывает финальный фильм (если в проекте есть моменты).
 * Используется и кнопкой «Завершить досрочно», и проверкой сроков при запуске приложения.
 */
export async function completeProject(
  project: ProjectRec,
  today: Ymd,
  opts: { early: boolean },
): Promise<{ project: ProjectRec; film: FilmRec | null }> {
  if (project.status === "completed") return { project, film: null };
  let pauses = project.pauses;
  let endDate = project.endDate;
  if (pauses.some((p) => p.to === null)) pauses = pauses.map((p) => (p.to === null ? { ...p, to: today } : p));
  if (opts.early || !endDate) endDate = maxYmd(project.startDate, endDate ? minYmd(endDate, today) : today);

  const now = nowIso();
  const updated: ProjectRec = { ...project, status: "completed", completedAt: now, endDate, pauses, updatedAt: now };
  await store.putProject(updated);

  let film: FilmRec | null = null;
  if (projectFootage(project.id).count > 0) {
    film = await createProjectFilm(updated, "full", {}, { auto: true, today });
  }
  return { project: updated, film };
}

export async function updateProject(projectId: string, input: UpdateProjectInput): Promise<void> {
  let project = getProjectRec(projectId);
  const today = input.today;
  const save = async (patch: Partial<ProjectRec>) => {
    project = { ...project, ...patch, updatedAt: nowIso() };
    await store.putProject(project);
  };

  if (input.title !== undefined || input.description !== undefined) {
    const renamed = input.title !== undefined && input.title !== project.title;
    await save({ title: input.title ?? project.title, description: input.description ?? project.description });
    if (renamed) {
      for (const film of [...store.films.values()]) {
        if (film.projectId === projectId) await store.putFilm({ ...film, title: project.title });
      }
    }
  }

  if (input.filmSettings) {
    await save({ filmSettings: { ...project.filmSettings, ...input.filmSettings } });
  }

  if (input.cover) {
    if (input.cover.kind === "moment") {
      if (!input.cover.momentId) throw badRequest("moment_required");
      const moment = store.moments.get(input.cover.momentId);
      if (!moment || !moment.projectIds.includes(projectId)) throw badRequest("moment_not_in_project");
      await save({ coverKind: "moment", coverMomentId: moment.id });
    } else if (input.cover.kind === "preset") {
      await save({ coverKind: "preset", coverPreset: input.cover.preset ?? project.coverPreset });
    } else {
      await save({ coverKind: "auto" });
      background.refreshCover(projectId);
    }
  }

  switch (input.action) {
    case "pause": {
      if (project.status !== "active") throw conflict("not_active");
      const pauses: PauseSpan[] = [...project.pauses, { from: today, to: null }];
      await save({ status: "paused", pauses });
      break;
    }
    case "resume": {
      if (project.status !== "paused") throw conflict("not_paused");
      const open = project.pauses.find((p) => p.to === null);
      const shift = open ? pauseShift(open, today) : 0;
      const pauses = project.pauses.map((p) => (p.to === null ? { ...p, to: today } : p));
      // Срок сдвигается на длину паузы: запланированное число дней записи сохраняется.
      await save({ status: "active", pauses, endDate: project.endDate ? addDays(project.endDate, shift) : null });
      break;
    }
    case "complete": {
      if (project.status === "completed") throw conflict("already_completed");
      await completeProject(project, today, { early: true });
      break;
    }
    case "extend": {
      const days = input.days ?? 7;
      const base = project.endDate ? maxYmd(project.endDate, addDays(today, -1)) : null;
      if (!base) throw conflict("open_ended");
      const endDate = addDays(base, days);
      if (diffDays(endDate, project.startDate) > MAX_PROJECT_DAYS) throw badRequest("range_too_long");
      // Продление завершённого проекта возвращает его в работу.
      const reopened = project.status === "completed";
      await save({
        endDate,
        periodKind: "custom",
        status: reopened ? "active" : project.status,
        completedAt: reopened ? null : project.completedAt,
      });
      break;
    }
    case "setEnd": {
      if (project.status === "completed") throw conflict("already_completed");
      if (input.endDate === undefined) throw badRequest("end_required");
      if (input.endDate === null) {
        await save({ endDate: null, periodKind: "open" });
      } else {
        if (input.endDate < project.startDate) throw badRequest("bad_range");
        if (input.endDate < today) throw badRequest("end_in_past");
        if (diffDays(input.endDate, project.startDate) > MAX_PROJECT_DAYS) throw badRequest("range_too_long");
        await save({ endDate: input.endDate, periodKind: "custom" });
      }
      break;
    }
    case "reopen": {
      if (project.status !== "completed") throw conflict("not_completed");
      const endDate = project.endDate && project.endDate >= today ? project.endDate : null;
      await save({ status: "active", completedAt: null, endDate, periodKind: endDate === null ? "open" : project.periodKind });
      break;
    }
    default:
      break;
  }
}

export async function deleteProject(projectId: string, deleteFilms: boolean): Promise<void> {
  getProjectRec(projectId);
  for (const film of [...store.films.values()]) {
    if (film.projectId !== projectId) continue;
    if (deleteFilms) await store.removeFilm(film.id);
    // Оставленный фильм живёт дальше как обычный фильм за свой период.
    else await store.putFilm({ ...film, projectId: null, updatedAt: nowIso() });
  }
  // Исходные моменты остаются в архиве: удаляется только связь с проектом.
  for (const m of [...store.moments.values()]) {
    if (m.projectIds.includes(projectId)) {
      await store.putMoment({ ...m, projectIds: m.projectIds.filter((pid) => pid !== projectId) });
    }
  }
  await store.removeProject(projectId);
}

/** Добавляет или убирает момент из проекта вручную. */
export async function setProjectMoment(projectId: string, momentId: string, include: boolean): Promise<void> {
  getProjectRec(projectId);
  const moment = store.moments.get(momentId);
  if (!moment) throw notFound("moment_not_found");
  const has = moment.projectIds.includes(projectId);
  if (include === has) return;
  const projectIds = include ? [...moment.projectIds, projectId] : moment.projectIds.filter((pid) => pid !== projectId);
  await store.putMoment({ ...moment, projectIds, updatedAt: nowIso() });
  await markFilmsStale(null, [projectId]);
  background.refreshCover(projectId);
}
