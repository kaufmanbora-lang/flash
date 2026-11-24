// Дела, которые в серверной версии выполнял планировщик: завершить проекты, у которых вышел срок,
// заказать «фильм дня», вернуть в очередь сборки, прерванные закрытием приложения.
// Здесь они выполняются, когда приложение открыто.

import { addDays, deviceHm, deviceYmd, type Ymd } from "@/lib/dates";
import { projectProgress } from "@/lib/projects";
import { createFilm, requeueRender } from "./films";
import { currentSettings } from "./profile";
import { completeProject } from "./projects";
import { cleanupTempPages } from "./render/writer";
import { projectTiming, store } from "./store";

/** Сборки, которые шли в момент закрытия приложения, снова ждут своей очереди. */
export async function recoverInterruptedRenders(): Promise<void> {
  const work = async () => {
    for (const film of [...store.films.values()]) {
      if (film.status === "rendering") await requeueRender(film.id);
    }
    await cleanupTempPages();
  };
  // Если сборка идёт прямо сейчас в другой вкладке, блокировка занята — ничего не трогаем.
  if (typeof navigator !== "undefined" && navigator.locks) {
    await navigator.locks.request("flash-render", { ifAvailable: true }, async (lock) => {
      if (lock) await work();
    });
  } else {
    await work();
  }
}

const DAILY_FILM_KEY = "dailyFilmDoneFor";
let running = false;

async function dailyFilms(today: Ymd, nowHm: string): Promise<void> {
  const settings = currentSettings().dailyFilm;
  if (!settings.enabled) return;
  const done = (await store.getValue<Ymd>(DAILY_FILM_KEY)) ?? "";
  const candidates: Ymd[] = [addDays(today, -1)];
  if (nowHm >= settings.time) candidates.push(today);
  for (const day of candidates) {
    if (day <= done) continue;
    const hasMoments = [...store.moments.values()].some((m) => m.date === day);
    const exists = [...store.films.values()].some((f) => f.projectId === null && f.kind === "day" && f.dateFrom === day);
    if (hasMoments && !exists) {
      await createFilm({ kind: "day", dateFrom: day, dateTo: day, variant: settings.variant }, { auto: true }).catch(() => {});
    }
    await store.setValue(DAILY_FILM_KEY, day);
  }
}

async function overdueProjects(today: Ymd): Promise<void> {
  for (const project of [...store.projects.values()]) {
    if (project.status !== "active") continue;
    if (projectProgress(projectTiming(project), today).overdue) {
      await completeProject(project, today, { early: false }).catch(() => {});
    }
  }
}

/** Вызывается при запуске и время от времени, пока приложение открыто. */
export async function runMaintenance(now: Date = new Date()): Promise<void> {
  if (running || !store.profile) return;
  running = true;
  try {
    const today = deviceYmd(now);
    await overdueProjects(today);
    await dailyFilms(today, deviceHm(now));
  } finally {
    running = false;
  }
}
