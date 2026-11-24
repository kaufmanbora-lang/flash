// Моменты: возобновляемая загрузка частями, лимит «от 1 до 3 в день», выборки для архива.

import { z } from "zod";
import {
  MAX_MOMENTS_PER_DAY,
  NOTE_MAX,
  UPLOAD_CHUNK_BYTES,
  VIDEO_EXT_BY_MIME,
} from "./constants";
import { addDays, diffDays, isValidHm, isValidYmd, parseYmd, utcToYmd, ymdOf, daysInMonth, type Ymd } from "./dates";
import { exec, q, q1, tx } from "./db";
import { momentDto } from "./dto";
import { env } from "./env";
import { badRequest, conflict, HttpError, notFound } from "./errors";
import { projectCoversDay } from "./projects";
import { enqueue, enqueueUnique } from "./queue";
import { normalizeSearchText } from "./search";
import { keys, storage, type StoredPart } from "./storage";
import type { DaySummary, MomentDto, MomentRow, ProjectRow, StorageDto, StreakInfo, UploadInitDto } from "./types";
import { signMediaUrl } from "./signing";

type MomentWithProjects = MomentRow & { project_ids: string[] };

const SELECT_MOMENT = `
  SELECT m.*, COALESCE(
    (SELECT array_agg(pm.project_id::text) FROM project_moments pm WHERE pm.moment_id = m.id), '{}'
  ) AS project_ids
  FROM moments m`;

/** Статусы, которые видны в архиве: «uploading» живёт только как черновик на устройстве. */
const VISIBLE = `m.status IN ('ready', 'processing', 'failed')`;
/** Статусы, которые занимают место в дневном лимите. */
const COUNTED = `status <> 'failed'`;

export const initUploadSchema = z.object({
  clientId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  recordedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Некорректная дата"),
  localDate: z.string().refine(isValidYmd, "Некорректная дата"),
  localTime: z.string().refine(isValidHm, "Некорректное время"),
  note: z.string().max(NOTE_MAX).default(""),
  source: z.enum(["camera", "upload"]),
  mime: z.string().max(120),
  sizeBytes: z.number().int().positive(),
  durationMs: z.number().int().nonnegative().default(0),
  width: z.number().int().nonnegative().default(0),
  height: z.number().int().nonnegative().default(0),
  projectIds: z.array(z.string().uuid()).max(20).default([]),
  /**
   * «Добавить во все идущие проекты»: для записей, у которых выбора проектов не было
   * (восстановление прерванной съёмки). Список projectIds при этом не используется.
   */
  autoProjects: z.boolean().default(false),
});
export type InitUploadInput = z.infer<typeof initUploadSchema>;

export const updateMomentSchema = z.object({
  note: z.string().max(NOTE_MAX).optional(),
  favorite: z.boolean().optional(),
  projectIds: z.array(z.string().uuid()).max(20).optional(),
});
export type UpdateMomentInput = z.infer<typeof updateMomentSchema>;

function extOf(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  return VIDEO_EXT_BY_MIME[base] ?? "mp4";
}

export async function getMoment(userId: string, id: string): Promise<MomentWithProjects> {
  const row = await q1<MomentWithProjects>(`${SELECT_MOMENT} WHERE m.id = $1 AND m.user_id = $2`, [id, userId]);
  if (!row) throw notFound("moment_not_found");
  return row;
}

export async function countForDay(userId: string, date: Ymd): Promise<number> {
  const row = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM moments WHERE user_id = $1 AND local_date = $2 AND ${COUNTED}`,
    [userId, date],
  );
  return row?.n ?? 0;
}

export async function storageUsage(userId: string): Promise<StorageDto> {
  const m = await q1<{ originals: number; playback: number; posters: number; n: number }>(
    `SELECT COALESCE(sum(size_bytes), 0)::bigint AS originals,
            COALESCE(sum(playback_size), 0)::bigint AS playback,
            COALESCE(sum(poster_size), 0)::bigint AS posters,
            count(*) FILTER (WHERE status = 'ready')::int AS n
     FROM moments WHERE user_id = $1`,
    [userId],
  );
  const f = await q1<{ films: number; posters: number; n: number }>(
    `SELECT COALESCE(sum(size_bytes), 0)::bigint AS films, COALESCE(sum(poster_size), 0)::bigint AS posters,
            count(*) FILTER (WHERE file_key IS NOT NULL)::int AS n
     FROM films WHERE user_id = $1`,
    [userId],
  );
  const p = await q1<{ covers: number }>(
    `SELECT COALESCE(sum(cover_size), 0)::bigint AS covers FROM projects WHERE user_id = $1`,
    [userId],
  );
  const other = (m?.posters ?? 0) + (f?.posters ?? 0) + (p?.covers ?? 0);
  const total = (m?.originals ?? 0) + (m?.playback ?? 0) + (f?.films ?? 0) + other;
  return {
    totalBytes: total,
    quotaBytes: env.storageQuotaBytes,
    originalsBytes: m?.originals ?? 0,
    playbackBytes: m?.playback ?? 0,
    filmsBytes: f?.films ?? 0,
    otherBytes: other,
    moments: m?.n ?? 0,
    films: f?.n ?? 0,
  };
}

/**
 * Проекты, в которые можно положить момент, снятый в день date: они принадлежат пользователю,
 * а день попадает в их период. Без списка ids — все идущие проекты («добавить во все»).
 */
async function projectsForMoment(
  userId: string,
  date: Ymd,
  opts: { ids?: string[]; allowCompleted?: boolean } = {},
): Promise<string[]> {
  if (opts.ids && opts.ids.length === 0) return [];
  const rows = opts.ids
    ? await q<ProjectRow>(
        `SELECT * FROM projects WHERE user_id = $1 AND id = ANY($2::uuid[]) ${opts.allowCompleted ? "" : "AND status <> 'completed'"}`,
        [userId, opts.ids],
      )
    : await q<ProjectRow>(`SELECT * FROM projects WHERE user_id = $1 AND status = 'active'`, [userId]);
  const today = utcToYmd(new Date());
  return rows.filter((row) => projectCoversDay(row, date, today)).map((row) => row.id);
}

/**
 * Начинает (или продолжает) загрузку момента. Повторный вызов с тем же clientId безопасен:
 * вернётся та же запись и список уже принятых частей.
 */
export async function initUpload(userId: string, input: InitUploadInput): Promise<UploadInitDto> {
  const baseMime = input.mime.split(";")[0].trim().toLowerCase();
  if (!baseMime.startsWith("video/")) throw badRequest("unsupported_type");

  const recordedAt = new Date(input.recordedAt);
  const utcDay = utcToYmd(recordedAt);
  if (Math.abs(diffDays(input.localDate, utcDay)) > 1) throw badRequest("date_mismatch");
  if (input.localDate > addDays(utcToYmd(new Date()), 1)) throw badRequest("date_in_future");

  const projectIds = await projectsForMoment(userId, input.localDate, input.autoProjects ? {} : { ids: input.projectIds });
  const ext = extOf(input.mime);

  const { row, created } = await tx(async (t) => {
    // Блокировка на пару «пользователь + день»: одновременные загрузки не обойдут лимит.
    await t.q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${userId}:${input.localDate}`]);

    const existing = await t.q1<MomentRow>(`SELECT * FROM moments WHERE user_id = $1 AND client_id = $2`, [
      userId,
      input.clientId,
    ]);
    if (existing) return { row: existing, created: false };

    const day = await t.q1<{ n: number }>(
      `SELECT count(*)::int AS n FROM moments WHERE user_id = $1 AND local_date = $2 AND ${COUNTED}`,
      [userId, input.localDate],
    );
    if ((day?.n ?? 0) >= MAX_MOMENTS_PER_DAY) {
      throw conflict("daily_limit", undefined, { limit: MAX_MOMENTS_PER_DAY, date: input.localDate });
    }

    if (env.storageQuotaBytes > 0) {
      const usage = await storageUsage(userId);
      if (usage.totalBytes + input.sizeBytes > env.storageQuotaBytes) {
        throw new HttpError(413, "quota_exceeded", undefined, {
          quotaBytes: env.storageQuotaBytes,
          usedBytes: usage.totalBytes,
        });
      }
    }

    const inserted = await t.q1<MomentRow>(
      `INSERT INTO moments (user_id, client_id, recorded_at, local_date, local_time, note, source, status,
                            mime, ext, expected_size, duration_ms, width, height, note_norm)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploading', $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        userId,
        input.clientId,
        recordedAt,
        input.localDate,
        input.localTime,
        input.note.trim(),
        input.source,
        baseMime,
        ext,
        input.sizeBytes,
        input.durationMs,
        input.width,
        input.height,
        normalizeSearchText(input.note),
      ],
    );
    for (const pid of projectIds) {
      await t.exec(`INSERT INTO project_moments (project_id, moment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        pid,
        inserted!.id,
      ]);
    }
    return { row: inserted!, created: true };
  });

  let current = row;
  if (created || (!row.upload_id && row.status === "uploading")) {
    const key = keys.momentOriginal(userId, row.id, row.ext);
    try {
      const store = await storage();
      const uploadId = await store.createMultipart(key, row.mime);
      current = (await q1<MomentRow>(
        `UPDATE moments SET upload_id = $2, original_key = $3, updated_at = now() WHERE id = $1 RETURNING *`,
        [row.id, uploadId, key],
      ))!;
    } catch (err) {
      if (created) await exec(`DELETE FROM moments WHERE id = $1`, [row.id]);
      throw err;
    }
  }

  const full = await getMoment(userId, current.id);
  return {
    moment: momentDto(full),
    chunkBytes: UPLOAD_CHUNK_BYTES,
    uploadedParts: (full.parts ?? []).map((p) => p.n).sort((a, b) => a - b),
  };
}

export async function uploadPart(userId: string, momentId: string, n: number, data: Buffer): Promise<void> {
  if (!Number.isInteger(n) || n < 1 || n > 10_000) throw badRequest("bad_part");
  if (data.length === 0 || data.length > UPLOAD_CHUNK_BYTES) throw badRequest("bad_part_size");
  const row = await q1<MomentRow>(`SELECT * FROM moments WHERE id = $1 AND user_id = $2`, [momentId, userId]);
  if (!row) throw notFound("moment_not_found");
  if (row.status !== "uploading" || !row.upload_id || !row.original_key) throw conflict("upload_closed");

  const store = await storage();
  const etag = await store.uploadPart(row.original_key, row.upload_id, n, data);
  const part: StoredPart = { n, etag, size: data.length };
  await exec(
    `UPDATE moments
     SET parts = COALESCE((SELECT jsonb_agg(p) FROM jsonb_array_elements(parts) p WHERE (p->>'n')::int <> $2), '[]'::jsonb)
                 || $3::jsonb,
         updated_at = now()
     WHERE id = $1`,
    [momentId, n, JSON.stringify([part])],
  );
}

export async function completeUpload(userId: string, momentId: string): Promise<MomentDto> {
  const row = await q1<MomentRow>(`SELECT * FROM moments WHERE id = $1 AND user_id = $2`, [momentId, userId]);
  if (!row) throw notFound("moment_not_found");
  if (row.status !== "uploading") return momentDto(await getMoment(userId, momentId)); // повторный вызов
  if (!row.upload_id || !row.original_key) throw conflict("upload_closed");

  const parts = [...(row.parts ?? [])].sort((a, b) => a.n - b.n);
  const contiguous = parts.every((p, i) => p.n === i + 1);
  const total = parts.reduce((s, p) => s + p.size, 0);
  if (parts.length === 0 || !contiguous || total !== row.expected_size) {
    throw conflict("upload_incomplete", undefined, {
      uploadedParts: parts.map((p) => p.n),
      receivedBytes: total,
      expectedBytes: row.expected_size,
    });
  }

  const store = await storage();
  const size = await store.completeMultipart(row.original_key, row.upload_id, parts);
  await exec(
    `UPDATE moments SET status = 'processing', size_bytes = $2, upload_id = NULL, parts = '[]'::jsonb, updated_at = now()
     WHERE id = $1`,
    [momentId, size],
  );
  await enqueue("process_moment", { momentId }, { maxAttempts: 3 });
  return momentDto(await getMoment(userId, momentId));
}

/**
 * Помечает фильмы, в которые попадает этот день или эти проекты, как устаревшие.
 * Флаг ставится и фильмам, которые сейчас монтируются: воркер сбрасывает его в начале сборки,
 * поэтому момент, появившийся во время монтажа, не потеряется незамеченным.
 */
export async function markFilmsStale(userId: string, date: Ymd, projectIds: string[]): Promise<void> {
  await exec(
    `UPDATE films SET stale = true, updated_at = now()
     WHERE user_id = $1 AND stale = false
       AND ((project_id IS NULL AND date_from <= $2 AND date_to >= $2) OR project_id = ANY($3::uuid[]))`,
    [userId, date, projectIds],
  );
}

export async function refreshProjectCovers(projectIds: string[]): Promise<void> {
  for (const projectId of projectIds) {
    await enqueueUnique("project_cover", { projectId }, 2);
  }
}

export async function updateMoment(userId: string, momentId: string, input: UpdateMomentInput): Promise<MomentDto> {
  const row = await getMoment(userId, momentId);
  if (input.note !== undefined || input.favorite !== undefined) {
    await exec(
      `UPDATE moments
          SET note = COALESCE($2, note), note_norm = COALESCE($3, note_norm), favorite = COALESCE($4, favorite), updated_at = now()
        WHERE id = $1`,
      [
        momentId,
        input.note === undefined ? null : input.note.trim(),
        input.note === undefined ? null : normalizeSearchText(input.note),
        input.favorite ?? null,
      ],
    );
  }
  if (input.projectIds !== undefined) {
    const current = new Set(row.project_ids);
    // Добавить можно только в проект, в период которого попадает день момента; уже существующие
    // связи при этом не рвутся (например, если срок проекта потом сократили).
    const allowed = await projectsForMoment(userId, row.local_date, { ids: input.projectIds, allowCompleted: true });
    const wanted = new Set([...allowed, ...input.projectIds.filter((id) => current.has(id))]);
    const added = [...wanted].filter((id) => !current.has(id));
    const removed = [...current].filter((id) => !wanted.has(id));
    for (const pid of added) {
      await exec(`INSERT INTO project_moments (project_id, moment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        pid,
        momentId,
      ]);
    }
    if (removed.length > 0) {
      await exec(`DELETE FROM project_moments WHERE moment_id = $1 AND project_id = ANY($2::uuid[])`, [
        momentId,
        removed,
      ]);
    }
    const touched = [...added, ...removed];
    if (touched.length > 0 && row.status === "ready") {
      await markFilmsStale(userId, "0001-01-01", touched);
      await refreshProjectCovers(touched);
    }
  }
  return momentDto(await getMoment(userId, momentId));
}

export async function deleteMoment(userId: string, momentId: string): Promise<void> {
  const row = await getMoment(userId, momentId);
  const store = await storage();
  if (row.upload_id && row.original_key) {
    await store.abortMultipart(row.original_key, row.upload_id).catch(() => {});
  }
  await store.deletePrefix(keys.momentPrefix(userId, momentId)).catch((err) => {
    console.error("[moments] не удалось удалить файлы момента", momentId, err);
  });
  await exec(`DELETE FROM moments WHERE id = $1 AND user_id = $2`, [momentId, userId]);
  if (row.status === "ready") {
    await markFilmsStale(userId, row.local_date, row.project_ids);
    await refreshProjectCovers(row.project_ids);
  }
}

// ── Выборки ──────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  январ: 1, феврал: 2, март: 3, апрел: 4, мая: 5, май: 5, июн: 6, июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Разбирает поисковый запрос как дату или период: «23.11.2026», «2026-11», «ноябрь 2026», «2025». */
export function parseDateQuery(raw: string): { from: Ymd; to: Ymd } | { month: number; day?: number } | null {
  const s = raw.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const d = ymdOf(+m[1], +m[2], +m[3]);
    return isValidYmd(d) ? { from: d, to: d } : null;
  }
  if ((m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/))) {
    const d = ymdOf(+m[3], +m[2], +m[1]);
    return isValidYmd(d) ? { from: d, to: d } : null;
  }
  const monthRange = (y: number, mo: number) =>
    y >= 1970 && y <= 2200 && mo >= 1 && mo <= 12
      ? { from: ymdOf(y, mo, 1), to: ymdOf(y, mo, daysInMonth(y, mo)) }
      : null;
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) return monthRange(+m[1], +m[2]);
  if ((m = s.match(/^(\d{1,2})[./](\d{4})$/))) return monthRange(+m[2], +m[1]);
  if ((m = s.match(/^(\d{4})$/))) {
    const y = +m[1];
    return y >= 1970 && y <= 2200 ? { from: ymdOf(y, 1, 1), to: ymdOf(y, 12, 31) } : null;
  }
  if ((m = s.match(/^(\d{1,2})[./](\d{1,2})$/))) {
    const day = +m[1];
    const month = +m[2];
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { month, day } : null;
  }
  // «ноябрь», «23 ноября», «ноябрь 2026», «23 ноября 2026»
  if ((m = s.match(/^(?:(\d{1,2})\s+)?([a-zа-яё]+)(?:\s+(\d{4}))?$/))) {
    const word = m[2];
    const entry = Object.entries(MONTHS).find(([stem]) => word.startsWith(stem));
    if (!entry) return null;
    const month = entry[1];
    const day = m[1] ? +m[1] : undefined;
    const year = m[3] ? +m[3] : undefined;
    if (year) {
      if (day) {
        const d = ymdOf(year, month, day);
        return isValidYmd(d) ? { from: d, to: d } : null;
      }
      return { from: ymdOf(year, month, 1), to: ymdOf(year, month, daysInMonth(year, month)) };
    }
    return { month, day };
  }
  return null;
}

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

export async function listMoments(userId: string, query: MomentQuery): Promise<MomentDto[]> {
  const where: string[] = [`m.user_id = $1`, VISIBLE];
  const params: unknown[] = [userId];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (query.date) add(`m.local_date = ?`, query.date);
  if (query.from) add(`m.local_date >= ?`, query.from);
  if (query.to) add(`m.local_date <= ?`, query.to);
  if (query.favorite) where.push(`m.favorite = true`);
  if (query.projectId) {
    add(`EXISTS (SELECT 1 FROM project_moments pm WHERE pm.moment_id = m.id AND pm.project_id = ?)`, query.projectId);
  }
  const search = query.search?.trim();
  if (search) {
    const asDate = parseDateQuery(search);
    // Подстрока плюс полнотекстовый поиск с русской морфологией: «море» находит и «у моря».
    // Сравнение идёт по нормализованной копии заметки — регистр не зависит от локали базы.
    const needle = normalizeSearchText(search);
    params.push(`%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, needle);
    const noteCond = `(m.note_norm LIKE $${params.length - 1} OR to_tsvector('russian', m.note_norm) @@ plainto_tsquery('russian', $${params.length}))`;
    if (asDate && "from" in asDate) {
      params.push(asDate.from, asDate.to);
      where.push(`(${noteCond} OR m.local_date BETWEEN $${params.length - 1} AND $${params.length})`);
    } else if (asDate) {
      params.push(asDate.month);
      let cond = `EXTRACT(MONTH FROM m.local_date) = $${params.length}`;
      if (asDate.day) {
        params.push(asDate.day);
        cond += ` AND EXTRACT(DAY FROM m.local_date) = $${params.length}`;
      }
      where.push(`(${noteCond} OR (${cond}))`);
    } else {
      where.push(noteCond);
    }
  }
  const order = query.order === "asc" ? "ASC" : "DESC";
  params.push(Math.min(Math.max(query.limit ?? 100, 1), 500), Math.max(query.offset ?? 0, 0));
  const rows = await q<MomentWithProjects>(
    `${SELECT_MOMENT} WHERE ${where.join(" AND ")}
     ORDER BY m.recorded_at ${order}, m.id ${order}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map(momentDto);
}

export async function daySummaries(userId: string, from: Ymd, to: Ymd, projectId?: string): Promise<DaySummary[]> {
  const params: unknown[] = [userId, from, to];
  let projectCond = "";
  if (projectId) {
    params.push(projectId);
    projectCond = `AND EXISTS (SELECT 1 FROM project_moments pm WHERE pm.moment_id = m.id AND pm.project_id = $4)`;
  }
  const rows = await q<{ date: Ymd; count: number; duration_ms: number; poster_key: string | null }>(
    `SELECT m.local_date AS date, count(*)::int AS count, COALESCE(sum(m.duration_ms), 0)::int AS duration_ms,
            (array_agg(m.poster_key ORDER BY m.recorded_at) FILTER (WHERE m.poster_key IS NOT NULL))[1] AS poster_key
     FROM moments m
     WHERE m.user_id = $1 AND m.local_date BETWEEN $2 AND $3 AND m.status IN ('ready', 'processing') ${projectCond}
     GROUP BY m.local_date ORDER BY m.local_date`,
    params,
  );
  return rows.map((r) => ({
    date: r.date,
    count: r.count,
    durationMs: r.duration_ms,
    posterUrl: signMediaUrl(r.poster_key),
  }));
}

/** Серия дней подряд, в которые записан хотя бы один момент. Сегодняшний пустой день серию ещё не рвёт. */
export function computeStreak(datesDesc: Ymd[], today: Ymd): StreakInfo {
  const set = new Set(datesDesc);
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

export async function streakFor(userId: string, today: Ymd): Promise<StreakInfo> {
  const rows = await q<{ d: Ymd }>(
    `SELECT DISTINCT local_date AS d FROM moments
     WHERE user_id = $1 AND status IN ('ready', 'processing') ORDER BY d DESC`,
    [userId],
  );
  return computeStreak(rows.map((r) => r.d), today);
}

/** Моменты, записанные в этот же день в прошлые годы. */
export async function onThisDay(userId: string, today: Ymd): Promise<{ year: number; date: Ymd; moments: MomentDto[] }[]> {
  const { m, d, y } = parseYmd(today);
  const rows = await q<MomentWithProjects>(
    `${SELECT_MOMENT}
     WHERE m.user_id = $1 AND m.status = 'ready'
       AND EXTRACT(MONTH FROM m.local_date) = $2 AND EXTRACT(DAY FROM m.local_date) = $3
       AND EXTRACT(YEAR FROM m.local_date) < $4
     ORDER BY m.recorded_at DESC LIMIT 60`,
    [userId, m, d, y],
  );
  const groups = new Map<Ymd, MomentDto[]>();
  for (const row of rows) {
    const list = groups.get(row.local_date) ?? [];
    list.push(momentDto(row));
    groups.set(row.local_date, list);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, moments]) => ({ year: parseYmd(date).y, date, moments: moments.reverse() }));
}

/** Убирает брошенные загрузки, чтобы они не занимали место в дневном лимите. */
export async function cleanupAbandonedUploads(olderThanHours = 24): Promise<number> {
  const rows = await q<MomentRow>(
    `SELECT * FROM moments WHERE status = 'uploading' AND updated_at < now() - make_interval(hours => $1) LIMIT 100`,
    [olderThanHours],
  );
  const store = await storage();
  for (const row of rows) {
    if (row.upload_id && row.original_key) await store.abortMultipart(row.original_key, row.upload_id).catch(() => {});
    await store.deletePrefix(keys.momentPrefix(row.user_id, row.id)).catch(() => {});
    await exec(`DELETE FROM moments WHERE id = $1 AND status = 'uploading'`, [row.id]);
  }
  return rows.length;
}
