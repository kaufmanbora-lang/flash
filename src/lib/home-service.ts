// Данные главного экрана и статистика архива.

import { MAX_MOMENTS_PER_DAY } from "./constants";
import { addDays, parseYmd, startOfWeek, type Ymd } from "./dates";
import { q, q1 } from "./db";
import { filmDto } from "./dto";
import { daySummaries, listMoments, onThisDay, streakFor } from "./moment-service";
import { listProjects } from "./project-service";
import type { FilmRow, HomeDto, StatsDto } from "./types";

export async function homeData(userId: string, today: Ymd): Promise<HomeDto> {
  const activityFrom = addDays(startOfWeek(today), -28);

  const [todayMoments, recent, streak, activity, projects, memories, totals, latestFilm, rendering] = await Promise.all([
    listMoments(userId, { date: today, order: "asc" }),
    listMoments(userId, { limit: 12 }),
    streakFor(userId, today),
    daySummaries(userId, activityFrom, today),
    listProjects(userId, today, "open"),
    onThisDay(userId, today),
    q1<{ moments: number; duration_ms: number; days: number }>(
      `SELECT count(*)::int AS moments, COALESCE(sum(duration_ms), 0)::bigint AS duration_ms,
              count(DISTINCT local_date)::int AS days
       FROM moments WHERE user_id = $1 AND status = 'ready'`,
      [userId],
    ),
    q1<FilmRow>(
      `SELECT * FROM films WHERE user_id = $1 AND file_key IS NOT NULL
       ORDER BY rendered_at DESC NULLS LAST LIMIT 1`,
      [userId],
    ),
    q<FilmRow>(
      `SELECT * FROM films WHERE user_id = $1 AND status IN ('queued', 'rendering')
       ORDER BY updated_at DESC LIMIT 5`,
      [userId],
    ),
  ]);

  const counted = todayMoments.filter((m) => m.status !== "failed");
  return {
    today: {
      date: today,
      count: counted.length,
      limit: MAX_MOMENTS_PER_DAY,
      durationMs: counted.reduce((s, m) => s + m.durationMs, 0),
      moments: todayMoments,
    },
    streak,
    activity,
    recent,
    latestFilm: latestFilm ? filmDto(latestFilm) : null,
    rendering: rendering.map(filmDto),
    projects,
    onThisDay: memories,
    totals: {
      moments: totals?.moments ?? 0,
      durationMs: totals?.duration_ms ?? 0,
      days: totals?.days ?? 0,
    },
  };
}

export async function statsData(userId: string, today: Ymd): Promise<StatsDto> {
  const [totals, films, projects, byMonth, byWeekday, byHour, years, streak] = await Promise.all([
    q1<{ moments: number; duration_ms: number; days: number; favorites: number; first: Ymd | null }>(
      `SELECT count(*)::int AS moments, COALESCE(sum(duration_ms), 0)::bigint AS duration_ms,
              count(DISTINCT local_date)::int AS days,
              count(*) FILTER (WHERE favorite)::int AS favorites,
              min(local_date) AS first
       FROM moments WHERE user_id = $1 AND status = 'ready'`,
      [userId],
    ),
    q1<{ n: number }>(`SELECT count(*)::int AS n FROM films WHERE user_id = $1 AND file_key IS NOT NULL`, [userId]),
    q1<{ n: number }>(`SELECT count(*)::int AS n FROM projects WHERE user_id = $1`, [userId]),
    q<{ month: string; count: number; duration_ms: number; days: number }>(
      `SELECT to_char(local_date, 'YYYY-MM') AS month, count(*)::int AS count,
              COALESCE(sum(duration_ms), 0)::bigint AS duration_ms, count(DISTINCT local_date)::int AS days
       FROM moments WHERE user_id = $1 AND status = 'ready' AND local_date > $2
       GROUP BY 1 ORDER BY 1`,
      [userId, addDays(today, -366)],
    ),
    q<{ dow: number; count: number }>(
      `SELECT EXTRACT(ISODOW FROM local_date)::int AS dow, count(*)::int AS count
       FROM moments WHERE user_id = $1 AND status = 'ready' GROUP BY 1`,
      [userId],
    ),
    q<{ hour: number; count: number }>(
      `SELECT split_part(local_time, ':', 1)::int AS hour, count(*)::int AS count
       FROM moments WHERE user_id = $1 AND status = 'ready' GROUP BY 1`,
      [userId],
    ),
    q<{ y: number }>(
      `SELECT DISTINCT EXTRACT(YEAR FROM local_date)::int AS y FROM moments
       WHERE user_id = $1 AND status = 'ready' ORDER BY 1 DESC`,
      [userId],
    ),
    streakFor(userId, today),
  ]);

  const weekday = new Array<number>(7).fill(0);
  for (const r of byWeekday) weekday[r.dow - 1] = r.count;
  const hours = new Array<number>(24).fill(0);
  for (const r of byHour) if (r.hour >= 0 && r.hour < 24) hours[r.hour] = r.count;
  const yearList = years.map((r) => r.y);
  const thisYear = parseYmd(today).y;
  if (!yearList.includes(thisYear)) yearList.unshift(thisYear);

  return {
    totals: {
      moments: totals?.moments ?? 0,
      durationMs: totals?.duration_ms ?? 0,
      days: totals?.days ?? 0,
      favorites: totals?.favorites ?? 0,
      films: films?.n ?? 0,
      projects: projects?.n ?? 0,
    },
    streak,
    firstDate: totals?.first ?? null,
    byMonth: byMonth.map((r) => ({ month: r.month, count: r.count, durationMs: r.duration_ms, days: r.days })),
    byWeekday: weekday,
    byHour: hours,
    years: yearList,
  };
}
