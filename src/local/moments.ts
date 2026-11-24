// Моменты: сохранение на устройство, лимит «от 1 до 3 в день», выборки для архива.

import { z } from "zod";
import { MAX_MOMENTS_PER_DAY, MIN_MOMENT_SERVER_MS, NOTE_MAX, VIDEO_EXT_BY_MIME } from "@/lib/constants";
import { addDays, deviceYmd, diffDays, isValidHm, isValidYmd, parseYmd, type Ymd } from "@/lib/dates";
import { ApiError, badRequest, conflict, notFound } from "@/lib/errors";
import { projectCoversDay } from "@/lib/projects";
import { normalizeSearchText, noteMatches, parseDateQuery } from "@/lib/search";
import type { DaySummary, MomentDto, StreakInfo } from "@/lib/types";
import { allMoments, markFilmsStale, momentDto, momentDtos, nowIso } from "./core";
import { blobKey, isQuotaError, newId, projectTiming, store, type MomentRec } from "./store";
import { background, refreshCovers } from "./tasks";

const id = z.string().min(1).max(64);

export const updateMomentSchema = z.object({
  note: z.string().max(NOTE_MAX).optional(),
  favorite: z.boolean().optional(),
  projectIds: z.array(id).max(20).optional(),
});
export type UpdateMomentInput = z.infer<typeof updateMomentSchema>;

export interface SaveMomentInput {
  blob: Blob;
  mime: string;
  /** Момент съёмки, ISO. */
  recordedAt: string;
  /** Календарный день и время по часам устройства. */
  localDate: Ymd;
  localTime: string;
  note: string;
  source: "camera" | "upload";
  durationMs: number;
  width: number;
  height: number;
  poster: Blob | null;
  projectIds: string[];
  /**
   * «Добавить во все идущие проекты»: для записей, у которых выбора проектов не было
   * (восстановление прерванной съёмки). Список projectIds при этом не используется.
   */
  autoProjects?: boolean;
}

function extOf(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  return VIDEO_EXT_BY_MIME[base] ?? "mp4";
}

export function getMomentRec(momentId: string): MomentRec {
  const rec = store.moments.get(momentId);
  if (!rec) throw notFound("moment_not_found");
  return rec;
}

export function countForDay(date: Ymd): number {
  let n = 0;
  for (const m of store.moments.values()) if (m.date === date) n++;
  return n;
}

/**
 * Проекты, в которые можно положить момент, снятый в день date: день должен попадать в их период.
 * Без списка ids — все идущие проекты («добавить во все»).
 */
function projectsForMoment(date: Ymd, opts: { ids?: string[]; allowCompleted?: boolean } = {}): string[] {
  if (opts.ids && opts.ids.length === 0) return [];
  const today = deviceYmd();
  const out: string[] = [];
  for (const project of store.projects.values()) {
    if (opts.ids) {
      if (!opts.ids.includes(project.id)) continue;
      if (!opts.allowCompleted && project.status === "completed") continue;
    } else if (project.status !== "active") {
      continue;
    }
    if (projectCoversDay(projectTiming(project), date, today)) out.push(project.id);
  }
  return out;
}

/** Сохраняет новый момент на устройство. Видео и запись появляются одновременно — или не появляются вовсе. */
export async function saveMoment(input: SaveMomentInput): Promise<MomentDto> {
  const baseMime = input.mime.split(";")[0].trim().toLowerCase();
  if (!baseMime.startsWith("video/")) throw badRequest("unsupported_type");
  if (!isValidYmd(input.localDate) || !isValidHm(input.localTime)) throw badRequest("validation");
  const recordedAt = new Date(input.recordedAt);
  if (Number.isNaN(recordedAt.getTime())) throw badRequest("validation");
  if (input.blob.size === 0) throw badRequest("unreadable_video");

  const today = deviceYmd();
  if (input.localDate > today) throw badRequest("date_in_future");
  if (input.note.length > NOTE_MAX) throw badRequest("validation");

  // Длительность и размер кадра читает браузер: если он не смог — в фильм такое видео не попадёт.
  if (!(input.durationMs > 0) || !(input.width > 0) || !(input.height > 0)) throw badRequest("unreadable_video");
  if (input.durationMs < MIN_MOMENT_SERVER_MS) throw badRequest("too_short");

  if (countForDay(input.localDate) >= MAX_MOMENTS_PER_DAY) {
    throw conflict("daily_limit", { limit: MAX_MOMENTS_PER_DAY, date: input.localDate });
  }

  const projectIds = projectsForMoment(input.localDate, input.autoProjects ? {} : { ids: input.projectIds });
  const now = nowIso();
  const rec: MomentRec = {
    id: newId(),
    recordedAt: recordedAt.toISOString(),
    date: input.localDate,
    time: input.localTime,
    note: input.note.trim(),
    noteNorm: normalizeSearchText(input.note),
    source: input.source,
    mime: baseMime,
    ext: extOf(input.mime),
    sizeBytes: input.blob.size,
    posterBytes: input.poster?.size ?? 0,
    durationMs: Math.round(input.durationMs),
    width: Math.round(input.width),
    height: Math.round(input.height),
    favorite: false,
    projectIds,
    analysis: null,
    analysisState: "pending",
    createdAt: now,
    updatedAt: now,
  };

  const files: Record<string, Blob> = { [blobKey.momentVideo(rec.id)]: input.blob };
  if (input.poster) files[blobKey.momentPoster(rec.id)] = input.poster;
  try {
    await store.putMoment(rec, files);
  } catch (err) {
    if (isQuotaError(err)) throw new ApiError(413, "quota_exceeded");
    throw err;
  }

  await markFilmsStale(rec.date, rec.projectIds);
  refreshCovers(rec.projectIds);
  background.analyzeMoment(rec.id);
  return momentDto(rec);
}

export async function updateMoment(momentId: string, input: UpdateMomentInput): Promise<MomentDto> {
  const rec = getMomentRec(momentId);
  const next: MomentRec = { ...rec, updatedAt: nowIso() };
  if (input.note !== undefined) {
    next.note = input.note.trim();
    next.noteNorm = normalizeSearchText(input.note);
  }
  if (input.favorite !== undefined) next.favorite = input.favorite;

  let touched: string[] = [];
  if (input.projectIds !== undefined) {
    const current = new Set(rec.projectIds);
    // Добавить можно только в проект, в период которого попадает день момента; уже существующие
    // связи при этом не рвутся (например, если срок проекта потом сократили).
    const allowed = projectsForMoment(rec.date, { ids: input.projectIds, allowCompleted: true });
    const wanted = new Set([...allowed, ...input.projectIds.filter((pid) => current.has(pid))]);
    const added = [...wanted].filter((pid) => !current.has(pid));
    const removed = [...current].filter((pid) => !wanted.has(pid));
    next.projectIds = [...wanted];
    touched = [...added, ...removed];
  }

  await store.putMoment(next);
  if (touched.length > 0) {
    await markFilmsStale(null, touched);
    refreshCovers(touched);
  }
  return momentDto(next);
}

export async function deleteMoment(momentId: string): Promise<void> {
  const rec = getMomentRec(momentId);
  await store.removeMoment(momentId);
  await markFilmsStale(rec.date, rec.projectIds);
  refreshCovers(rec.projectIds);
}

// ── Выборки ──────────────────────────────────────────────────

export interface MomentQuery {
  date?: Ymd;
  from?: Ymd;
  to?: Ymd;
  search?: string;
  favorite?: boolean;
  projectId?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

export function findMoments(query: MomentQuery): MomentRec[] {
  let list = allMoments(query.order === "asc" ? "asc" : "desc");
  if (query.date) list = list.filter((m) => m.date === query.date);
  if (query.from) list = list.filter((m) => m.date >= query.from!);
  if (query.to) list = list.filter((m) => m.date <= query.to!);
  if (query.favorite) list = list.filter((m) => m.favorite);
  if (query.projectId) list = list.filter((m) => m.projectIds.includes(query.projectId!));

  const search = query.search?.trim();
  if (search) {
    const needle = normalizeSearchText(search);
    const asDate = parseDateQuery(search);
    const dateHit = (m: MomentRec): boolean => {
      if (!asDate) return false;
      if ("from" in asDate) return m.date >= asDate.from && m.date <= asDate.to;
      const { m: month, d: day } = parseYmd(m.date);
      return month === asDate.month && (asDate.day === undefined || day === asDate.day);
    };
    list = list.filter((m) => noteMatches(m.noteNorm, needle) || dateHit(m));
  }

  const offset = Math.max(query.offset ?? 0, 0);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  return list.slice(offset, offset + limit);
}

export function listMoments(query: MomentQuery): Promise<MomentDto[]> {
  return momentDtos(findMoments(query));
}

export async function daySummaries(from: Ymd, to: Ymd, projectId?: string): Promise<DaySummary[]> {
  const days = new Map<Ymd, { count: number; durationMs: number; posterOf: string | null }>();
  for (const m of allMoments()) {
    if (m.date < from || m.date > to) continue;
    if (projectId && !m.projectIds.includes(projectId)) continue;
    const day = days.get(m.date) ?? { count: 0, durationMs: 0, posterOf: null };
    day.count++;
    day.durationMs += m.durationMs;
    if (!day.posterOf && m.posterBytes > 0) day.posterOf = m.id;
    days.set(m.date, day);
  }
  const out: DaySummary[] = [];
  for (const [date, day] of [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out.push({
      date,
      count: day.count,
      durationMs: day.durationMs,
      posterUrl: day.posterOf ? await store.url(blobKey.momentPoster(day.posterOf)) : null,
    });
  }
  return out;
}

/** Серия дней подряд, в которые записан хотя бы один момент. Сегодняшний пустой день серию ещё не рвёт. */
export function computeStreak(dates: Iterable<Ymd>, today: Ymd): StreakInfo {
  const set = new Set(dates);
  const todayDone = set.has(today);
  let current = 0;
  let cursor = todayDone ? today : addDays(today, -1);
  while (set.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }
  let best = 0;
  let run = 0;
  let prev: Ymd | null = null;
  for (const d of [...set].sort()) {
    run = prev && diffDays(d, prev) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { current, best: Math.max(best, current), todayDone };
}

export function streakFor(today: Ymd): StreakInfo {
  const dates: Ymd[] = [];
  for (const m of store.moments.values()) dates.push(m.date);
  return computeStreak(dates, today);
}

/** Моменты, записанные в этот же день в прошлые годы. */
export async function onThisDay(today: Ymd): Promise<{ year: number; date: Ymd; moments: MomentDto[] }[]> {
  const { m, d, y } = parseYmd(today);
  const groups = new Map<Ymd, MomentRec[]>();
  let taken = 0;
  for (const rec of allMoments("desc")) {
    const parts = parseYmd(rec.date);
    if (parts.m !== m || parts.d !== d || parts.y >= y) continue;
    if (taken++ >= 60) break;
    const list = groups.get(rec.date) ?? [];
    list.push(rec);
    groups.set(rec.date, list);
  }
  const out: { year: number; date: Ymd; moments: MomentDto[] }[] = [];
  for (const [date, list] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    out.push({ year: parseYmd(date).y, date, moments: await momentDtos(list.reverse()) });
  }
  return out;
}
