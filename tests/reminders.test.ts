import { describe, expect, it } from "vitest";
import { hmToMinutes } from "@/lib/dates";
import { expectedSlots, inQuietHours, planDay } from "@/lib/reminders";
import { applyPatch, DEFAULT_SETTINGS, resolveSettings } from "@/lib/settings";

const base = DEFAULT_SETTINGS.notifications;

describe("тихие часы", () => {
  it("интервал через полночь", () => {
    const n = { ...base, quietEnabled: true, quietFrom: "22:30", quietTo: "08:00" };
    expect(inQuietHours(hmToMinutes("23:00"), n)).toBe(true);
    expect(inQuietHours(hmToMinutes("02:15"), n)).toBe(true);
    expect(inQuietHours(hmToMinutes("07:59"), n)).toBe(true);
    expect(inQuietHours(hmToMinutes("08:00"), n)).toBe(false);
    expect(inQuietHours(hmToMinutes("15:00"), n)).toBe(false);
  });

  it("интервал внутри одного дня и выключенные тихие часы", () => {
    const day = { ...base, quietEnabled: true, quietFrom: "13:00", quietTo: "15:00" };
    expect(inQuietHours(hmToMinutes("14:00"), day)).toBe(true);
    expect(inQuietHours(hmToMinutes("15:00"), day)).toBe(false);
    expect(inQuietHours(hmToMinutes("23:00"), { ...base, quietEnabled: false })).toBe(false);
  });
});

describe("расписание напоминаний", () => {
  it("случайный режим: нужное количество, внутри активного периода, по возрастанию", () => {
    const n = { ...base, mode: "random" as const, perDay: 4, activeFrom: "09:00", activeTo: "21:00", quietEnabled: false };
    const plan = planDay(n, "user-1:2026-11-23");
    expect(plan).toHaveLength(4);
    const minutes = plan.map((p) => hmToMinutes(p.time!));
    for (const m of minutes) {
      expect(m).toBeGreaterThanOrEqual(9 * 60);
      expect(m).toBeLessThanOrEqual(21 * 60);
    }
    expect([...minutes].sort((a, b) => a - b)).toEqual(minutes);
    // Напоминания не слипаются: между соседними не меньше получаса.
    for (let i = 1; i < minutes.length; i++) expect(minutes[i] - minutes[i - 1]).toBeGreaterThanOrEqual(30);
  });

  it("одно и то же зерно даёт то же расписание, другой день — другое", () => {
    const n = { ...base, mode: "random" as const, perDay: 3 };
    expect(planDay(n, "u:2026-11-23")).toEqual(planDay(n, "u:2026-11-23"));
    const days = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"].map((d) => JSON.stringify(planDay(n, `u:${d}`)));
    expect(new Set(days).size).toBeGreaterThan(1);
  });

  it("случайное время не попадает в тихие часы", () => {
    const n = { ...base, mode: "random" as const, perDay: 6, activeFrom: "06:00", activeTo: "23:30", quietEnabled: true, quietFrom: "22:00", quietTo: "08:00" };
    for (const seed of ["a", "b", "c", "d", "e"]) {
      for (const slot of planDay(n, seed)) {
        if (slot.time) expect(inQuietHours(hmToMinutes(slot.time), n)).toBe(false);
      }
    }
  });

  it("режим по расписанию: ровно указанные часы, тихие пропускаются", () => {
    const n = { ...base, mode: "fixed" as const, fixedTimes: ["20:00", "10:00", "23:00"], quietEnabled: true, quietFrom: "22:30", quietTo: "08:00" };
    expect(planDay(n, "x")).toEqual([
      { slot: 0, time: "10:00" },
      { slot: 1, time: "20:00" },
      { slot: 2, time: null },
    ]);
    expect(expectedSlots(n)).toBe(3);
    expect(expectedSlots({ ...base, mode: "random", perDay: 5 })).toBe(5);
  });
});

describe("настройки пользователя", () => {
  it("пустые и повреждённые настройки превращаются в значения по умолчанию", () => {
    expect(resolveSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings("oops")).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings({ notifications: { perDay: 999 } })).toEqual(DEFAULT_SETTINGS);
  });

  it("частичное изменение не затрагивает остальное", () => {
    const next = applyPatch(DEFAULT_SETTINGS, { notifications: { enabled: true, fixedTimes: ["21:00", "09:00", "09:00"] }, film: { music: "none" } });
    expect(next.notifications.enabled).toBe(true);
    expect(next.notifications.fixedTimes).toEqual(["09:00", "21:00"]);
    expect(next.notifications.perDay).toBe(DEFAULT_SETTINGS.notifications.perDay);
    expect(next.film.music).toBe("none");
    expect(next.film.style).toBe("auto");
    expect(DEFAULT_SETTINGS.notifications.enabled).toBe(false);
  });
});
