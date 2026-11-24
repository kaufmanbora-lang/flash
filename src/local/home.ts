// Данные главного экрана, статистика архива и занятое место.

import { MAX_MOMENTS_PER_DAY } from "@/lib/constants";
import { addDays, parseYmd, startOfWeek, weekdayIndex, type Ymd } from "@/lib/dates";
import type { HomeDto, StatsDto, StorageDto } from "@/lib/types";
import { filmDto, filmDtos } from "./core";
import { daySummaries, listMoments, onThisDay, streakFor } from "./moments";
import { listProjects } from "./projects";
import { store } from "./store";

export async function homeData(today: Ymd): Promise<HomeDto> {
  const activityFrom = addDays(startOfWeek(today), -28);
  const [todayMoments, recent, activity, projects, memories] = await Promise.all([
    listMoments({ date: today, order: "asc" }),
    listMoments({ limit: 12 }),
    daySummaries(activityFrom, today),
    listProjects(today, "open"),
    onThisDay(today),
  ]);

  const films = [...store.films.values()];
  const latest = films
    .filter((f) => f.hasFile)
    .sort((a, b) => ((a.renderedAt ?? "") < (b.renderedAt ?? "") ? 1 : -1))[0];
  const waiting = films
    .filter((f) => f.status === "queued" || f.status === "rendering")
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 5);

  let durationMs = 0;
  const days = new Set<Ymd>();
  for (const m of store.moments.values()) {
    durationMs += m.durationMs;
    days.add(m.date);
  }

  return {
    today: {
      date: today,
      count: todayMoments.length,
      limit: MAX_MOMENTS_PER_DAY,
      durationMs: todayMoments.reduce((s, m) => s + m.durationMs, 0),
      moments: todayMoments,
    },
    streak: streakFor(today),
    activity,
    recent,
    latestFilm: latest ? await filmDto(latest) : null,
    rendering: await filmDtos(waiting),
    projects,
    onThisDay: memories,
    totals: { moments: store.moments.size, durationMs, days: days.size },
  };
}

export function statsData(today: Ymd): StatsDto {
  const moments = [...store.moments.values()];
  const days = new Set<Ymd>();
  const months = new Map<string, { count: number; durationMs: number; days: Set<Ymd> }>();
  const byWeekday = new Array<number>(7).fill(0);
  const byHour = new Array<number>(24).fill(0);
  const years = new Set<number>();
  const monthsFrom = addDays(today, -366);
  let durationMs = 0;
  let favorites = 0;
  let firstDate: Ymd | null = null;

  for (const m of moments) {
    durationMs += m.durationMs;
    days.add(m.date);
    if (m.favorite) favorites++;
    if (firstDate === null || m.date < firstDate) firstDate = m.date;
    byWeekday[weekdayIndex(m.date)]++;
    const hour = Number(m.time.slice(0, 2));
    if (hour >= 0 && hour < 24) byHour[hour]++;
    years.add(parseYmd(m.date).y);
    if (m.date > monthsFrom) {
      const key = m.date.slice(0, 7);
      const month = months.get(key) ?? { count: 0, durationMs: 0, days: new Set<Ymd>() };
      month.count++;
      month.durationMs += m.durationMs;
      month.days.add(m.date);
      months.set(key, month);
    }
  }

  const yearList = [...years].sort((a, b) => b - a);
  const thisYear = parseYmd(today).y;
  if (!yearList.includes(thisYear)) yearList.unshift(thisYear);

  return {
    totals: {
      moments: moments.length,
      durationMs,
      days: days.size,
      favorites,
      films: [...store.films.values()].filter((f) => f.hasFile).length,
      projects: store.projects.size,
    },
    streak: streakFor(today),
    firstDate,
    byMonth: [...months.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([month, v]) => ({ month, count: v.count, durationMs: v.durationMs, days: v.days.size })),
    byWeekday,
    byHour,
    years: yearList,
  };
}

/** Сколько места занимает дневник на этом устройстве и сколько браузер готов дать. */
export async function storageUsage(): Promise<StorageDto> {
  let originals = 0;
  let other = 0;
  let films = 0;
  let filmCount = 0;
  for (const m of store.moments.values()) {
    originals += m.sizeBytes;
    other += m.posterBytes;
  }
  for (const f of store.films.values()) {
    if (!f.hasFile) continue;
    films += f.sizeBytes;
    other += f.posterBytes;
    filmCount++;
  }
  for (const p of store.projects.values()) other += p.coverBytes;

  let quotaBytes = 0;
  let persisted = false;
  try {
    const estimate = await navigator.storage?.estimate?.();
    quotaBytes = estimate?.quota ?? 0;
    persisted = (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    /* браузер не сообщает — покажем только занятое место */
  }

  return {
    totalBytes: originals + films + other,
    quotaBytes,
    originalsBytes: originals,
    filmsBytes: films,
    otherBytes: other,
    moments: store.moments.size,
    films: filmCount,
    persisted,
  };
}
