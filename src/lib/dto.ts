// Преобразование строк базы в объекты API. Здесь же выдаются временные подписанные ссылки на файлы:
// вызывать только после проверки, что объект принадлежит текущему пользователю.

import { safeName } from "./names";
import { signMediaUrl } from "./signing";
import type { FilmDto, FilmRow, MomentDto, MomentRow } from "./types";

/** Имя файла для скачивания. */
export const safeFileName = safeName;

export function momentDto(row: MomentRow & { project_ids?: string[] | null }): MomentDto {
  const ready = row.status === "ready";
  const stamp = `${row.local_date} ${row.local_time.replace(":", "-")}`;
  return {
    id: row.id,
    clientId: row.client_id,
    recordedAt: row.recorded_at.toISOString(),
    date: row.local_date,
    time: row.local_time,
    note: row.note,
    source: row.source,
    status: row.status,
    error: row.error,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    favorite: row.favorite,
    posterUrl: signMediaUrl(row.poster_key),
    videoUrl: ready ? signMediaUrl(row.playback_key ?? row.original_key) : null,
    downloadUrl: ready ? signMediaUrl(row.original_key, { download: `Flash ${stamp}.${row.ext}` }) : null,
    projectIds: row.project_ids ?? [],
  };
}

export function filmDto(row: FilmRow): FilmDto {
  const hasFile = !!row.file_key;
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    variant: row.variant,
    title: row.title,
    subtitle: row.subtitle,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    style: row.style,
    styleUsed: row.style_used,
    music: row.music,
    musicTracks: row.music_used ?? [],
    musicVolume: row.music_volume,
    orientation: row.orientation,
    resolution: row.resolution,
    status: row.status,
    hasFile,
    progress: row.progress,
    stage: row.stage,
    error: row.error,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    sizeBytes: row.size_bytes,
    momentsCount: row.moments_count,
    posterUrl: signMediaUrl(row.poster_key),
    videoUrl: hasFile ? signMediaUrl(row.file_key) : null,
    downloadUrl: hasFile ? signMediaUrl(row.file_key, { download: `${safeFileName(row.title)}.mp4` }) : null,
    chapters: row.chapters ?? [],
    auto: row.auto,
    stale: row.stale,
    createdAt: row.created_at.toISOString(),
    renderedAt: row.rendered_at ? row.rendered_at.toISOString() : null,
  };
}
