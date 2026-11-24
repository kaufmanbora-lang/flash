import { describe, expect, it } from "vitest";
import { pauseShift, periodEnd, projectCoversDay, projectDays, projectProgress, type ProjectTiming } from "@/lib/projects";

const base: ProjectTiming = { start_date: "2026-11-23", end_date: "2026-12-22", status: "active", pauses: [] };

describe("какие моменты попадают в проект", () => {
  it("только снятые в период проекта", () => {
    expect(projectCoversDay(base, "2026-11-23", "2026-12-01")).toBe(true);
    expect(projectCoversDay(base, "2026-12-22", "2026-12-01")).toBe(true);
    expect(projectCoversDay(base, "2026-11-22", "2026-12-01")).toBe(false);
    expect(projectCoversDay(base, "2026-12-23", "2026-12-01")).toBe(false);
    // Видео из галереи, снятое год назад, в сегодняшний проект не попадает.
    expect(projectCoversDay(base, "2025-11-24", "2026-11-24")).toBe(false);
  });

  it("бессрочный проект принимает всё с дня начала", () => {
    const open: ProjectTiming = { ...base, end_date: null };
    expect(projectCoversDay(open, "2030-01-01", "2026-12-01")).toBe(true);
    expect(projectCoversDay(open, "2026-11-22", "2026-12-01")).toBe(false);
  });

  it("идущая пауза отодвигает окончание", () => {
    const paused: ProjectTiming = { ...base, status: "paused", pauses: [{ from: "2026-12-01", to: null }] };
    // Пауза длится 5 дней — срок сдвинулся на 5 дней, 25 декабря ещё входит в проект.
    expect(projectCoversDay(paused, "2026-12-25", "2026-12-06")).toBe(true);
    expect(projectCoversDay(paused, "2026-12-28", "2026-12-06")).toBe(false);
  });
});

describe("периоды проекта", () => {
  it("вычисляет последний день периода", () => {
    expect(periodEnd("d1", "2026-11-23")).toBe("2026-11-23");
    expect(periodEnd("d7", "2026-11-23")).toBe("2026-11-29");
    expect(periodEnd("d30", "2026-11-23")).toBe("2026-12-22");
    expect(periodEnd("m3", "2026-11-23")).toBe("2027-02-22");
    expect(periodEnd("m6", "2026-08-31")).toBe("2027-02-27");
    expect(periodEnd("y1", "2027-01-01")).toBe("2027-12-31");
    expect(periodEnd("custom", "2026-11-23")).toBeNull();
    expect(periodEnd("open", "2026-11-23")).toBeNull();
  });
});

describe("прогресс проекта", () => {
  it("«День 18 из 30» — 60% и 12 дней до конца", () => {
    const p = projectProgress(base, "2026-12-10");
    expect(p).toMatchObject({ started: true, dayIndex: 18, totalDays: 30, daysLeft: 12, percent: 60, isLastDay: false, overdue: false });
  });

  it("первый, последний день и срок после окончания", () => {
    expect(projectProgress(base, "2026-11-23")).toMatchObject({ dayIndex: 1, daysLeft: 29, isLastDay: false });
    expect(projectProgress(base, "2026-12-22")).toMatchObject({ dayIndex: 30, daysLeft: 0, percent: 100, isLastDay: true, overdue: false });
    expect(projectProgress(base, "2026-12-25")).toMatchObject({ dayIndex: 30, daysLeft: 0, overdue: true });
  });

  it("ещё не начавшийся проект", () => {
    expect(projectProgress(base, "2026-11-20")).toMatchObject({ started: false, dayIndex: 0, totalDays: 30 });
  });

  it("пропущенные дни не сбрасывают счёт: день определяется календарём", () => {
    // Никаких записей не было две недели — проект всё равно на 15-м дне.
    expect(projectProgress(base, "2026-12-07").dayIndex).toBe(15);
  });

  it("бессрочный проект считает дни без процента", () => {
    const p = projectProgress({ ...base, end_date: null }, "2026-12-10");
    expect(p).toMatchObject({ dayIndex: 18, totalDays: null, daysLeft: null, percent: null, expectedEnd: null });
  });

  it("пауза останавливает срок, а продолжение сдвигает дату окончания", () => {
    // Поставили на паузу 25 ноября (это 3-й день), продолжили 30 ноября: выключены 26–29 ноября.
    const pause = { from: "2026-11-25", to: null };
    expect(pauseShift(pause, "2026-11-30")).toBe(4);

    const paused: ProjectTiming = { ...base, status: "paused", pauses: [pause] };
    const during = projectProgress(paused, "2026-11-28");
    expect(during.dayIndex).toBe(3);
    expect(during.totalDays).toBe(30);
    expect(during.expectedEnd).toBe("2026-12-25");

    const resumed: ProjectTiming = {
      ...base,
      end_date: "2026-12-26",
      pauses: [{ from: "2026-11-25", to: "2026-11-30" }],
    };
    expect(projectProgress(resumed, "2026-11-30")).toMatchObject({ dayIndex: 4, totalDays: 30, daysLeft: 26 });
    expect(projectProgress(resumed, "2026-12-26")).toMatchObject({ dayIndex: 30, isLastDay: true });
  });

  it("пауза и продолжение в один день ничего не сдвигают", () => {
    expect(pauseShift({ from: "2026-11-25", to: null }, "2026-11-25")).toBe(0);
    expect(pauseShift({ from: "2026-11-25", to: null }, "2026-11-26")).toBe(0);
  });
});

describe("календарь проекта", () => {
  it("размечает дни: записан, пропущен, сегодня, впереди, пауза", () => {
    const timing: ProjectTiming = {
      start_date: "2026-11-23",
      end_date: "2026-12-01",
      status: "active",
      pauses: [{ from: "2026-11-25", to: "2026-11-28" }],
    };
    const days = projectDays(timing, "2026-11-29", { "2026-11-23": 2, "2026-11-28": 1 });
    expect(days.map((d) => d.state)).toEqual([
      "recorded", // 23
      "missed", // 24
      "missed", // 25 — день паузы ещё активный
      "paused", // 26
      "paused", // 27
      "recorded", // 28 — день возобновления
      "today", // 29
      "future", // 30
      "future", // 1 декабря
    ]);
    expect(days.map((d) => d.index)).toEqual([1, 2, 3, null, null, 4, 5, 6, 7]);
    expect(days[0].count).toBe(2);
  });

  it("принимает количество моментов и как Map", () => {
    const days = projectDays(base, "2026-11-24", new Map([["2026-11-24", 3]]));
    expect(days).toHaveLength(30);
    expect(days[1]).toMatchObject({ date: "2026-11-24", count: 3, state: "recorded", index: 2 });
  });
});
