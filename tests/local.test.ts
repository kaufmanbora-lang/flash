// Дневник на устройстве: те же сценарии, что раньше проверялись на сервере, теперь выполняются
// поверх IndexedDB (в тестах — её реализация в памяти).

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { addDays, deviceYmd } from "@/lib/dates";
import { ApiError } from "@/lib/errors";
import { localApi } from "@/local/api";
import { exportBackup, importBackup, wipeDiary } from "@/local/backup";
import { completeRender, failRender, getFilmRec } from "@/local/films";
import { runMaintenance } from "@/local/maintenance";
import { computeStreak, saveMoment, type SaveMomentInput } from "@/local/moments";
import { blobKey, store } from "@/local/store";
import type { FilmDto, HomeDto, MeDto, MomentDto, ProjectDetailDto, ProjectDto, StatsDto, StorageDto } from "@/lib/types";

const today = deviceYmd();

function video(seconds = 12, bytes = 2048): Blob {
  return new Blob([new Uint8Array(bytes).fill(seconds)], { type: "video/mp4" });
}

function moment(date: string, time: string, extra: Partial<SaveMomentInput> = {}): SaveMomentInput {
  return {
    blob: video(),
    mime: "video/mp4;codecs=avc1",
    recordedAt: new Date(`${date}T${time}:00`).toISOString(),
    localDate: date,
    localTime: time,
    note: "",
    source: "camera",
    durationMs: 12_000,
    width: 720,
    height: 1280,
    poster: new Blob([new Uint8Array(64)], { type: "image/jpeg" }),
    projectIds: [],
    ...extra,
  };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof ApiError ? err.code : `unexpected:${String(err)}`;
  }
  return "ok";
}

beforeEach(async () => {
  await store.resetForTests();
  globalThis.indexedDB = new IDBFactory();
  await localApi("/api/me", { method: "POST", body: { name: "  Алекс  ", timezone: "Europe/Kyiv" } });
});

describe("профиль без аккаунта", () => {
  it("до первого запуска профиля нет, после — имя и настройки по умолчанию", async () => {
    await store.resetForTests();
    globalThis.indexedDB = new IDBFactory();
    expect(await code(localApi("/api/me"))).toBe("no_profile");
    expect(await code(localApi("/api/me", { method: "POST", body: { name: "  " } }))).toBe("name_required");
    await localApi("/api/me", { method: "POST", body: { name: "Мира" } });
    const me = await localApi<MeDto>("/api/me");
    expect(me.user.name).toBe("Мира");
    expect(me.limits).toEqual({ maxPerDay: 3, minMomentMs: 10_000 });
    expect(me.settings.dailyFilm.enabled).toBe(true);
  });

  it("настройки сохраняются и переживают перезапуск", async () => {
    await localApi("/api/settings", { method: "PATCH", body: { film: { style: "vintage", musicVolume: 0.8 } } });
    expect(await code(localApi("/api/settings", { method: "PATCH", body: { film: { style: "нет такого" } } }))).toBe("validation");
    await store.resetForTests();
    const me = await localApi<MeDto>("/api/me");
    expect(me.user.name).toBe("Алекс");
    expect(me.settings.film.style).toBe("vintage");
    expect(me.settings.film.musicVolume).toBe(0.8);
  });
});

describe("моменты: от одного до трёх в день", () => {
  it("сохраняет момент вместе с видео и превью", async () => {
    const saved = await saveMoment(moment(today, "10:00", { note: " Утро у моря " }));
    expect(saved.note).toBe("Утро у моря");
    expect(saved.videoUrl).toBeTruthy();
    expect(saved.posterUrl).toBeTruthy();
    expect(saved.fileName).toBe(`Flash ${today} 10-00.mp4`);
    expect((await store.getBlob(blobKey.momentVideo(saved.id)))?.size).toBe(2048);
    const home = await localApi<HomeDto>(`/api/home?today=${today}`);
    expect(home.today.count).toBe(1);
    expect(home.today.durationMs).toBe(12_000);
    expect(home.streak).toMatchObject({ current: 1, todayDone: true });
  });

  it("четвёртый момент за день не сохраняется, а на другой день — можно", async () => {
    for (const time of ["09:00", "13:00", "20:00"]) await saveMoment(moment(today, time));
    expect(await code(saveMoment(moment(today, "21:00")))).toBe("daily_limit");
    expect(store.moments.size).toBe(3);
    const yesterday = addDays(today, -1);
    await saveMoment(moment(yesterday, "21:00", { source: "upload" }));
    expect(store.moments.size).toBe(4);
    // После удаления место на сегодня освобождается.
    const { moments } = await localApi<{ moments: MomentDto[] }>(`/api/moments?date=${today}&order=asc`);
    await localApi(`/api/moments/${moments[0].id}`, { method: "DELETE" });
    expect(await code(saveMoment(moment(today, "21:00")))).toBe("ok");
  });

  it("отклоняет слишком короткое, нечитаемое и «будущее» видео", async () => {
    expect(await code(saveMoment(moment(today, "10:00", { durationMs: 9000 })))).toBe("too_short");
    expect(await code(saveMoment(moment(today, "10:00", { durationMs: 0 })))).toBe("unreadable_video");
    expect(await code(saveMoment(moment(today, "10:00", { width: 0 })))).toBe("unreadable_video");
    expect(await code(saveMoment(moment(addDays(today, 1), "10:00")))).toBe("date_in_future");
    expect(await code(saveMoment(moment(today, "10:00", { mime: "image/png" })))).toBe("unsupported_type");
    expect(store.moments.size).toBe(0);
  });

  it("поиск по словам заметки (с формами слова) и по дате, избранное", async () => {
    const a = await saveMoment(moment("2026-11-20", "10:00", { note: "Утро у моря", source: "upload" }));
    await saveMoment(moment("2026-11-21", "12:00", { note: "Прогулка в парке", source: "upload" }));
    await saveMoment(moment("2026-10-05", "12:00", { note: "", source: "upload" }));
    const find = async (q: string) =>
      (await localApi<{ moments: MomentDto[] }>(`/api/moments?q=${encodeURIComponent(q)}`)).moments.map((m) => m.date);
    expect(await find("море")).toEqual(["2026-11-20"]);
    expect(await find("ПРОГУЛКУ")).toEqual(["2026-11-21"]);
    expect(await find("20.11.2026")).toEqual(["2026-11-20"]);
    expect(await find("ноябрь 2026")).toEqual(["2026-11-21", "2026-11-20"]);
    expect(await find("октябрь")).toEqual(["2026-10-05"]);
    expect(await find("зима")).toEqual([]);

    await localApi(`/api/moments/${a.id}`, { method: "PATCH", body: { favorite: true, note: "Море и чайки" } });
    const fav = await localApi<{ moments: MomentDto[] }>("/api/moments?favorite=1");
    expect(fav.moments.map((m) => m.note)).toEqual(["Море и чайки"]);
    expect(await find("чайка")).toEqual(["2026-11-20"]);
  });

  it("календарь, статистика и «в этот день»", async () => {
    await saveMoment(moment("2025-11-24", "10:00", { source: "upload" }));
    await saveMoment(moment("2026-11-23", "10:00", { source: "upload" }));
    await saveMoment(moment("2026-11-23", "19:00", { source: "upload", durationMs: 20_000 }));
    await saveMoment(moment("2026-11-24", "08:30", { source: "upload" }));
    const { days } = await localApi<{ days: { date: string; count: number; durationMs: number }[] }>("/api/calendar?from=2026-11-01&to=2026-11-30");
    expect(days.map((d) => [d.date, d.count, d.durationMs])).toEqual([
      ["2026-11-23", 2, 32_000],
      ["2026-11-24", 1, 12_000],
    ]);
    const { stats, onThisDay } = await localApi<{ stats: StatsDto; onThisDay: { year: number; moments: MomentDto[] }[] }>("/api/stats?today=2026-11-24");
    expect(stats.totals).toMatchObject({ moments: 4, days: 3 });
    expect(stats.streak).toEqual({ current: 2, best: 2, todayDone: true });
    expect(stats.byHour[8]).toBe(1);
    expect(stats.byWeekday.reduce((s, n) => s + n, 0)).toBe(4);
    expect(onThisDay.map((g) => [g.year, g.moments.length])).toEqual([[2025, 1]]);
  });

  it("серия дней: пустое «сегодня» её ещё не рвёт", () => {
    expect(computeStreak(["2026-11-22", "2026-11-23"], "2026-11-24")).toEqual({ current: 2, best: 2, todayDone: false });
    expect(computeStreak(["2026-11-21"], "2026-11-24")).toEqual({ current: 0, best: 1, todayDone: false });
    expect(computeStreak(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-24"], "2026-11-24")).toEqual({ current: 1, best: 3, todayDone: true });
  });
});

describe("проекты воспоминаний", () => {
  const create = (body: Record<string, unknown>) =>
    localApi<{ id: string }>("/api/projects", { body: { title: "30 дней", periodKind: "d30", startDate: today, today, ...body } });
  const detail = async (id: string) => (await localApi<{ project: ProjectDetailDto }>(`/api/projects/${id}?today=${today}`)).project;

  it("момент попадает только в проекты, в период которых он снят", async () => {
    const { id } = await create({});
    const inside = await saveMoment(moment(today, "10:00", { projectIds: [id] }));
    const before = await saveMoment(moment(addDays(today, -40), "10:00", { projectIds: [id], source: "upload" }));
    expect(inside.projectIds).toEqual([id]);
    expect(before.projectIds).toEqual([]);
    const project = await detail(id);
    expect(project.momentsCount).toBe(1);
    expect(project.todayCount).toBe(1);
    expect(project.progress).toMatchObject({ dayIndex: 1, totalDays: 30, daysLeft: 29 });
    expect(project.variants.map((v) => [v.variant, v.available])).toEqual([
      ["trailer", false],
      ["mini", false],
      ["extended", false],
      ["full", true],
    ]);
  });

  it("при создании подхватывает уже записанные моменты периода", async () => {
    await saveMoment(moment(addDays(today, -2), "10:00", { source: "upload" }));
    await saveMoment(moment(addDays(today, -10), "10:00", { source: "upload" }));
    const { id } = await create({ periodKind: "d7", startDate: addDays(today, -3) });
    expect((await detail(id)).momentsCount).toBe(1);
    const skipped = await create({ title: "Без старых", periodKind: "d7", startDate: addDays(today, -3), includeExisting: false });
    expect((await detail(skipped.id)).momentsCount).toBe(0);
  });

  it("пауза сдвигает срок, продление возвращает завершённый проект", async () => {
    const start = addDays(today, -5);
    const { id } = await create({ periodKind: "d7", startDate: start });
    const patch = (body: Record<string, unknown>, at = today) =>
      localApi<{ project: ProjectDetailDto }>(`/api/projects/${id}`, { method: "PATCH", body: { today: at, ...body } });

    await patch({ action: "pause" }, addDays(today, -4));
    expect(await code(patch({ action: "pause" }))).toBe("not_active");
    const resumed = (await patch({ action: "resume" }, addDays(today, -1))).project;
    // Пауза длилась с −4 по −1: два «выключенных» дня, срок сдвинулся на два дня.
    expect(resumed.endDate).toBe(addDays(start, 6 + 2));
    expect(resumed.status).toBe("active");

    await saveMoment(moment(today, "10:00", { projectIds: [id] }));
    const done = (await patch({ action: "complete" })).project;
    expect(done.status).toBe("completed");
    expect(done.endDate).toBe(today);
    // Финальный фильм заказан и ждёт сборки.
    expect(done.variants.find((v) => v.variant === "full")?.film?.status).toBe("queued");
    expect(await code(patch({ action: "complete" }))).toBe("already_completed");

    const extended = (await patch({ action: "extend", days: 3 })).project;
    expect(extended.status).toBe("active");
    expect(extended.endDate).toBe(addDays(today, 3));
  });

  it("при удалении проекта моменты остаются, фильмы — по выбору", async () => {
    const { id } = await create({});
    await saveMoment(moment(today, "10:00", { projectIds: [id] }));
    const { film } = await localApi<{ film: FilmDto }>(`/api/projects/${id}/films`, { body: { variant: "full" } });
    expect(await code(localApi(`/api/projects/${id}/films`, { body: { variant: "trailer" } }))).toBe("not_enough_footage");
    await localApi(`/api/projects/${id}`, { method: "DELETE" });
    expect(store.moments.size).toBe(1);
    expect([...store.moments.values()][0].projectIds).toEqual([]);
    expect(getFilmRec(film.id).projectId).toBeNull();
    const list = await localApi<{ projects: ProjectDto[] }>(`/api/projects?today=${today}`);
    expect(list.projects).toEqual([]);
  });

  it("проверка сроков сама завершает проект и готовит финальный фильм", async () => {
    const { id } = await create({ periodKind: "d3", startDate: today });
    await saveMoment(moment(today, "10:00", { projectIds: [id] }));
    const later = new Date(`${addDays(today, 5)}T12:00:00`);
    await runMaintenance(later);
    expect(store.projects.get(id)?.status).toBe("completed");
    const films = [...store.films.values()].filter((f) => f.projectId === id);
    expect(films.map((f) => [f.variant, f.status, f.auto])).toEqual([["full", "queued", true]]);
  });
});

describe("фильмы", () => {
  const result = (bytes = 4096) => ({
    video: new Blob([new Uint8Array(bytes)], { type: "video/mp4" }),
    poster: new Blob([new Uint8Array(32)], { type: "image/jpeg" }),
    mime: "video/mp4",
    width: 720,
    height: 1280,
    durationMs: 21_600,
    styleUsed: "memories" as const,
    musicUsed: ["relaxing-piano-1"],
    chapters: [],
    momentsCount: 1,
  });

  it("фильм ждёт сборки; один фильм на период и версию", async () => {
    expect(await code(localApi("/api/films", { body: { kind: "day", dateFrom: today, dateTo: today } }))).toBe("no_moments");
    await saveMoment(moment(today, "10:00"));
    const first = (await localApi<{ film: FilmDto }>("/api/films", { body: { kind: "day", dateFrom: today, dateTo: today, style: "clean" } })).film;
    expect(first).toMatchObject({ status: "queued", hasFile: false, style: "clean", variant: "full", videoUrl: null });
    expect(first.subtitle.length).toBeGreaterThan(3);
    const again = (await localApi<{ film: FilmDto }>("/api/films", { body: { kind: "day", dateFrom: today, dateTo: today } })).film;
    expect(again.id).toBe(first.id);
    const other = (await localApi<{ film: FilmDto }>("/api/films", { body: { kind: "day", dateFrom: today, dateTo: today, variant: "highlights" } })).film;
    expect(other.id).not.toBe(first.id);
    const home = await localApi<HomeDto>(`/api/home?today=${today}`);
    expect(home.rendering).toHaveLength(2);
  });

  it("готовый фильм, устаревание и неудачная пересборка", async () => {
    await saveMoment(moment(today, "10:00"));
    const { film } = await localApi<{ film: FilmDto }>("/api/films", { body: { kind: "day", dateFrom: today, dateTo: today } });
    await completeRender(film.id, result());
    let ready = (await localApi<{ film: FilmDto }>(`/api/films/${film.id}`)).film;
    expect(ready).toMatchObject({ status: "ready", hasFile: true, sizeBytes: 4096, stale: false, mime: "video/mp4" });
    expect(ready.videoUrl).toBeTruthy();
    expect(ready.fileName.endsWith(".mp4")).toBe(true);

    // Новый момент того же дня делает фильм устаревшим.
    await saveMoment(moment(today, "18:00"));
    ready = (await localApi<{ film: FilmDto }>(`/api/films/${film.id}`)).film;
    expect(ready.stale).toBe(true);

    // Пересборка заказана, но не удалась: прежняя версия остаётся доступной.
    const queued = (await localApi<{ film: FilmDto }>(`/api/films/${film.id}`, { method: "PATCH", body: { style: "vintage" } })).film;
    expect(queued).toMatchObject({ status: "queued", hasFile: true, style: "vintage", stale: false });
    await failRender(film.id, "render_failed");
    const failed = (await localApi<{ film: FilmDto }>(`/api/films/${film.id}`)).film;
    expect(failed).toMatchObject({ status: "ready", hasFile: true, error: "render_failed" });

    await localApi(`/api/films/${film.id}`, { method: "DELETE" });
    expect(await store.getBlob(blobKey.filmVideo(film.id))).toBeUndefined();
  });

  it("«фильм дня» готовится вечером один раз и не возвращается после удаления", async () => {
    await saveMoment(moment(today, "10:00"));
    await runMaintenance(new Date(`${today}T12:00:00`));
    expect(store.films.size).toBe(0);
    await runMaintenance(new Date(`${today}T21:45:00`));
    const films = [...store.films.values()];
    expect(films.map((f) => [f.kind, f.dateFrom, f.auto, f.status])).toEqual([["day", today, true, "queued"]]);
    await localApi(`/api/films/${films[0].id}`, { method: "DELETE" });
    await runMaintenance(new Date(`${today}T22:30:00`));
    expect(store.films.size).toBe(0);
  });
});

describe("хранилище и резервная копия", () => {
  it("считает занятое место", async () => {
    await saveMoment(moment(today, "10:00"));
    const { storage } = await localApi<{ storage: StorageDto }>("/api/account/storage");
    expect(storage).toMatchObject({ originalsBytes: 2048, otherBytes: 64, filmsBytes: 0, moments: 1, films: 0, totalBytes: 2112 });
  });

  it("архив переносит дневник на «чистое» устройство", async () => {
    const { id: projectId } = await localApi<{ id: string }>("/api/projects", {
      body: { title: "Моё лето", periodKind: "open", startDate: addDays(today, -3), today },
    });
    const kept = await saveMoment(moment(today, "10:00", { note: "Первый", projectIds: [projectId] }));
    await saveMoment(moment(addDays(today, -1), "19:00", { source: "upload", blob: video(15, 5000) }));
    const { film } = await localApi<{ film: FilmDto }>("/api/films", { body: { kind: "day", dateFrom: today, dateTo: today } });
    await completeRender(film.id, {
      video: new Blob([new Uint8Array(3000).fill(7)], { type: "video/mp4" }),
      poster: null,
      mime: "video/mp4",
      width: 720,
      height: 1280,
      durationMs: 20_000,
      styleUsed: "minimal",
      musicUsed: [],
      chapters: [],
      momentsCount: 1,
    });

    const { blob, fileName } = await exportBackup();
    expect(fileName).toMatch(/^flash-archive-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(blob.size).toBeGreaterThan(2048 + 5000 + 3000);

    await wipeDiary(false);
    expect(store.moments.size + store.films.size + store.projects.size).toBe(0);
    expect(await code(localApi("/api/me"))).toBe("no_profile");

    const restored = await importBackup(blob);
    expect(restored).toEqual({ moments: 2, films: 1, projects: 1, skipped: 0 });
    expect((await localApi<MeDto>("/api/me")).user.name).toBe("Алекс");
    const back = store.moments.get(kept.id)!;
    expect(back.note).toBe("Первый");
    expect(back.projectIds).toEqual([projectId]);
    const bytes = new Uint8Array(await (await store.getBlob(blobKey.momentVideo(kept.id)))!.arrayBuffer());
    expect(bytes.length).toBe(2048);
    expect(bytes[100]).toBe(12);
    expect((await store.getBlob(blobKey.filmVideo(film.id)))?.size).toBe(3000);
    expect(getFilmRec(film.id)).toMatchObject({ status: "ready", hasFile: true });

    // Повторное восстановление ничего не дублирует.
    expect(await importBackup(blob)).toEqual({ moments: 0, films: 0, projects: 0, skipped: 4 });
  });

  it("удаление дневника может оставить имя и настройки", async () => {
    await saveMoment(moment(today, "10:00"));
    await wipeDiary(true);
    expect(store.moments.size).toBe(0);
    expect((await localApi<MeDto>("/api/me")).user.name).toBe("Алекс");
    expect((await store.blobKeys()).length).toBe(0);
  });
});
