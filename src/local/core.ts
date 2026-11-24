// Общие кирпичики локальных сервисов: выборки по записям и превращение записей в объекты для интерфейса.

import type { Ymd } from "@/lib/dates";
import { safeName } from "@/lib/names";
import type { FilmDto, MomentDto } from "@/lib/types";
import { blobKey, store, type FilmRec, type MomentRec } from "./store";

export const nowIso = (): string => new Date().toISOString();

const byTime = (a: MomentRec, b: MomentRec): number =>
  a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Все моменты в хронологическом порядке. */
export function allMoments(order: "asc" | "desc" = "asc"): MomentRec[] {
  const list = [...store.moments.values()].sort(byTime);
  return order === "asc" ? list : list.reverse();
}

export function projectMoments(projectId: string): MomentRec[] {
  return allMoments().filter((m) => m.projectIds.includes(projectId));
}

/** Моменты, входящие в фильм: у проектного — моменты проекта, у обычного — все за период. */
export function filmMoments(film: Pick<FilmRec, "projectId" | "dateFrom" | "dateTo">): MomentRec[] {
  if (film.projectId) return projectMoments(film.projectId);
  return allMoments().filter((m) => m.date >= film.dateFrom && m.date <= film.dateTo);
}

export async function momentDto(rec: MomentRec): Promise<MomentDto> {
  const [videoUrl, posterUrl] = await Promise.all([
    store.url(blobKey.momentVideo(rec.id)),
    store.url(blobKey.momentPoster(rec.id)),
  ]);
  return {
    id: rec.id,
    recordedAt: rec.recordedAt,
    date: rec.date,
    time: rec.time,
    note: rec.note,
    source: rec.source,
    status: "ready",
    error: null,
    durationMs: rec.durationMs,
    width: rec.width,
    height: rec.height,
    sizeBytes: rec.sizeBytes,
    favorite: rec.favorite,
    posterUrl,
    videoUrl,
    downloadUrl: videoUrl,
    fileName: `Flash ${rec.date} ${rec.time.replace(":", "-")}.${rec.ext}`,
    projectIds: [...rec.projectIds],
  };
}

export const momentDtos = (list: MomentRec[]): Promise<MomentDto[]> => Promise.all(list.map(momentDto));

export async function filmDto(rec: FilmRec): Promise<FilmDto> {
  const [videoUrl, posterUrl] = rec.hasFile
    ? await Promise.all([store.url(blobKey.filmVideo(rec.id)), store.url(blobKey.filmPoster(rec.id))])
    : [null, null];
  return {
    id: rec.id,
    projectId: rec.projectId,
    kind: rec.kind,
    variant: rec.variant,
    title: rec.title,
    subtitle: rec.subtitle,
    dateFrom: rec.dateFrom,
    dateTo: rec.dateTo,
    style: rec.style,
    styleUsed: rec.styleUsed,
    music: rec.music,
    musicTracks: rec.musicUsed,
    musicVolume: rec.musicVolume,
    orientation: rec.orientation,
    resolution: rec.resolution,
    status: rec.status,
    hasFile: rec.hasFile && !!videoUrl,
    progress: rec.progress,
    stage: rec.stage,
    error: rec.error,
    width: rec.width,
    height: rec.height,
    durationMs: rec.durationMs,
    sizeBytes: rec.sizeBytes,
    momentsCount: rec.momentsCount,
    posterUrl,
    videoUrl,
    downloadUrl: videoUrl,
    fileName: `${safeName(rec.title, "Flash")}.${rec.mime.includes("webm") ? "webm" : "mp4"}`,
    mime: rec.mime,
    chapters: rec.chapters,
    auto: rec.auto,
    stale: rec.stale,
    createdAt: rec.createdAt,
    renderedAt: rec.renderedAt,
  };
}

export const filmDtos = (list: FilmRec[]): Promise<FilmDto[]> => Promise.all(list.map(filmDto));

/**
 * Помечает фильмы, в которые попадает этот день или эти проекты, как устаревшие:
 * интерфейс предложит обновить их, когда в дневнике что-то изменилось.
 */
export async function markFilmsStale(date: Ymd | null, projectIds: string[]): Promise<void> {
  for (const film of [...store.films.values()]) {
    if (film.stale) continue;
    const hit = film.projectId
      ? projectIds.includes(film.projectId)
      : date !== null && film.dateFrom <= date && film.dateTo >= date;
    if (hit) await store.putFilm({ ...film, stale: true, updatedAt: nowIso() });
  }
}
