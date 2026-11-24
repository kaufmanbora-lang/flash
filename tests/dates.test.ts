import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  diffDays,
  eachDay,
  endOfMonth,
  endOfWeek,
  isValidHm,
  isValidTimeZone,
  isValidYmd,
  minutesToHm,
  startOfWeek,
  weekdayIndex,
  zonedParts,
  zonedToUtc,
} from "@/lib/dates";
import { fmtClock, fmtDayMonth, fmtFullDate, fmtMonthYear, fmtRange, fmtWeekday, plural } from "@/lib/format";
import { ru } from "@/i18n/ru";

describe("календарная арифметика", () => {
  it("складывает и вычитает дни через границы месяцев и лет", () => {
    expect(addDays("2026-11-23", 29)).toBe("2026-12-22");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(diffDays("2026-12-22", "2026-11-23")).toBe(29);
    expect(diffDays("2026-11-23", "2026-12-22")).toBe(-29);
  });

  it("сдвигает месяцы, не выходя за последний день", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonths("2026-03-15", -3)).toBe("2025-12-15");
  });

  it("считает неделю с понедельника", () => {
    // 23 ноября 2026 — понедельник.
    expect(weekdayIndex("2026-11-23")).toBe(0);
    expect(weekdayIndex("2026-11-29")).toBe(6);
    expect(startOfWeek("2026-11-26")).toBe("2026-11-23");
    expect(endOfWeek("2026-11-26")).toBe("2026-11-29");
    expect(endOfMonth("2026-02-10")).toBe("2026-02-28");
    expect(eachDay("2026-11-29", "2026-12-02")).toEqual(["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"]);
  });

  it("проверяет форматы даты, времени и часового пояса", () => {
    expect(isValidYmd("2026-02-29")).toBe(false);
    expect(isValidYmd("2028-02-29")).toBe(true);
    expect(isValidYmd("2026-13-01")).toBe(false);
    expect(isValidYmd("23.11.2026")).toBe(false);
    expect(isValidHm("09:05")).toBe(true);
    expect(isValidHm("24:00")).toBe(false);
    expect(isValidTimeZone("Europe/Kyiv")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(minutesToHm(9 * 60 + 5)).toBe("09:05");
    expect(minutesToHm(24 * 60 + 30)).toBe("00:30");
  });
});

describe("часовые пояса", () => {
  it("переводит момент времени в местные дату и время", () => {
    const utc = new Date("2026-11-23T22:30:00Z");
    expect(zonedParts(utc, "Europe/Kyiv")).toMatchObject({ ymd: "2026-11-24", hm: "00:30" });
    expect(zonedParts(utc, "America/New_York")).toMatchObject({ ymd: "2026-11-23", hm: "17:30" });
    expect(zonedParts(utc, "UTC").minutes).toBe(22 * 60 + 30);
  });

  it("находит момент времени по местным часам, включая летнее время", () => {
    expect(zonedToUtc("2026-11-23", "21:30", "Europe/Kyiv").toISOString()).toBe("2026-11-23T19:30:00.000Z");
    expect(zonedToUtc("2026-07-01", "21:30", "Europe/Kyiv").toISOString()).toBe("2026-07-01T18:30:00.000Z");
    expect(zonedToUtc("2026-07-01", "09:00", "America/New_York").toISOString()).toBe("2026-07-01T13:00:00.000Z");
    for (const tz of ["Europe/Kyiv", "Asia/Tokyo", "America/Los_Angeles", "Australia/Sydney"]) {
      const instant = zonedToUtc("2026-03-14", "08:15", tz);
      expect(zonedParts(instant, tz)).toMatchObject({ ymd: "2026-03-14", hm: "08:15" });
    }
  });
});

describe("форматирование по-русски", () => {
  it("даты", () => {
    expect(fmtDayMonth("2026-11-23")).toBe("23 ноября");
    expect(fmtFullDate("2026-11-23")).toBe("23 ноября 2026");
    expect(fmtWeekday("2026-11-23")).toBe("понедельник");
    expect(fmtMonthYear("2026-11-23")).toBe("Ноябрь 2026");
  });

  it("диапазоны", () => {
    expect(fmtRange("2026-11-23", "2026-11-23")).toBe("23 ноября 2026");
    expect(fmtRange("2026-11-17", "2026-11-23")).toBe("17–23 ноября 2026");
    expect(fmtRange("2026-10-23", "2026-11-21")).toBe("23 октября — 21 ноября 2026");
    expect(fmtRange("2026-12-28", "2027-01-03")).toBe("28 декабря 2026 — 3 января 2027");
    expect(fmtRange("2026-11-23", "2026-12-22", "ru", false)).toBe("23 ноября — 22 декабря");
  });

  it("длительности и множественное число", () => {
    expect(fmtClock(168_000)).toBe("2:48");
    expect(fmtClock(3_723_000)).toBe("1:02:03");
    expect(plural(1, { one: "момент", few: "момента", many: "моментов" })).toBe("момент");
    expect(plural(3, { one: "момент", few: "момента", many: "моментов" })).toBe("момента");
    expect(plural(11, { one: "момент", few: "момента", many: "моментов" })).toBe("моментов");
    expect(ru.fmt.moments(86)).toBe("86 моментов");
    expect(ru.fmt.days(21)).toBe("21 день");
    expect(ru.fmt.duration(222_000)).toBe("3 мин 42 сек");
    expect(ru.fmt.duration(42 * 60_000 + 18_000)).toBe("42 мин");
    expect(ru.fmt.duration(9_000)).toBe("9 сек");
    expect(ru.home.yearsAgo(1)).toBe("Год назад");
    expect(ru.home.yearsAgo(3)).toBe("3 года назад");
    expect(ru.push.projectDay(7, 30)).toBe("День 7 из 30. Сохрани сегодняшний момент!");
  });
});
