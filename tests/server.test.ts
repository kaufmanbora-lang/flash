import { afterEach, describe, expect, it, vi } from "vitest";
import { computeStreak, parseDateQuery } from "@/lib/moment-service";
import { normalizeSearchText } from "@/lib/search";
import { signMediaUrl, verifyMediaSignature } from "@/lib/signing";
import { isSafeKey, keys } from "@/lib/storage";
import { hashPassword, verifyPassword } from "@/lib/user-service";
import { parseRange } from "@/server/range";

const USER = "0b5c2a6e-1d3f-4a7b-9c8d-2e4f6a8b0c1d";
const MOMENT = "7f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

function parse(url: string) {
  const u = new URL(url, "http://localhost");
  return {
    key: decodeURIComponent(u.pathname.replace("/api/media/", "")),
    exp: Number(u.searchParams.get("e")),
    sig: u.searchParams.get("s") ?? "",
    dl: u.searchParams.get("dl") ?? "",
  };
}

describe("временные подписанные ссылки", () => {
  afterEach(() => vi.useRealTimers());

  it("подпись проверяется и привязана к файлу", () => {
    const key = keys.momentPlayback(USER, MOMENT);
    const { exp, sig } = parse(signMediaUrl(key)!);
    expect(verifyMediaSignature(key, exp, sig)).toBe(true);
    // Та же подпись не открывает чужой файл.
    const other = keys.momentPlayback("11111111-2222-4333-8444-555555555555", MOMENT);
    expect(verifyMediaSignature(other, exp, sig)).toBe(false);
    expect(verifyMediaSignature(key, exp + 3600, sig)).toBe(false);
    expect(verifyMediaSignature(key, exp, sig.slice(0, -2) + "xx")).toBe(false);
  });

  it("имя для скачивания входит в подпись", () => {
    const key = keys.film(USER, MOMENT, 3);
    const { exp, sig, dl } = parse(signMediaUrl(key, { download: "Мой фильм.mp4" })!);
    expect(dl).toBe("Мой фильм.mp4");
    expect(verifyMediaSignature(key, exp, sig, dl)).toBe(true);
    expect(verifyMediaSignature(key, exp, sig, "")).toBe(false);
    expect(verifyMediaSignature(key, exp, sig, "другое.mp4")).toBe(false);
  });

  it("ссылка перестаёт работать после истечения срока", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
    const key = keys.momentPoster(USER, MOMENT);
    const { exp, sig } = parse(signMediaUrl(key, { ttlSec: 3600 })!);
    expect(verifyMediaSignature(key, exp, sig)).toBe(true);
    vi.setSystemTime(new Date("2026-11-23T20:00:00Z"));
    expect(verifyMediaSignature(key, exp, sig)).toBe(false);
  });

  it("для отсутствующего файла ссылки нет", () => {
    expect(signMediaUrl(null)).toBeNull();
  });
});

describe("ключи хранилища", () => {
  it("принимает только ключи вида u/<пользователь>/…", () => {
    expect(isSafeKey(keys.momentOriginal(USER, MOMENT, "mp4"))).toBe(true);
    expect(isSafeKey(keys.film(USER, MOMENT, 1))).toBe(true);
    expect(isSafeKey(`u/${USER}/../../etc/passwd`)).toBe(false);
    expect(isSafeKey(`u/${USER}//x.mp4`)).toBe(false);
    expect(isSafeKey("etc/passwd")).toBe(false);
    expect(isSafeKey(`u/${USER}/moments/x y.mp4`)).toBe(false);
  });

  it("у каждого пользователя своя папка", () => {
    expect(keys.momentOriginal(USER, MOMENT, "mp4").startsWith(`u/${USER}/`)).toBe(true);
    expect(keys.projectCover(USER, MOMENT, 2)).toBe(`u/${USER}/projects/${MOMENT}/cover-2.jpg`);
  });
});

describe("Range-запросы (перемотка видео)", () => {
  it("разбирает диапазоны", () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange("bytes=0-1", 1000)).toEqual({ start: 0, end: 1 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("отклоняет некорректные диапазоны", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("invalid");
    expect(parseRange("bytes=5-2", 1000)).toBe("invalid");
    expect(parseRange("bytes=-", 1000)).toBe("invalid");
    expect(parseRange("items=0-5", 1000)).toBe("invalid");
  });
});

describe("пароли", () => {
  it("хэш проверяется и каждый раз разный", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("wrong password", a)).toBe(false);
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
  });
});

describe("поиск по датам", () => {
  it("понимает разные записи даты", () => {
    expect(parseDateQuery("23.11.2026")).toEqual({ from: "2026-11-23", to: "2026-11-23" });
    expect(parseDateQuery("2026-11-23")).toEqual({ from: "2026-11-23", to: "2026-11-23" });
    expect(parseDateQuery("2026-11")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(parseDateQuery("02.2028")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(parseDateQuery("2026")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(parseDateQuery("23.11")).toEqual({ month: 11, day: 23 });
    expect(parseDateQuery("ноябрь")).toEqual({ month: 11, day: undefined });
    expect(parseDateQuery("23 ноября")).toEqual({ month: 11, day: 23 });
    expect(parseDateQuery("Ноябрь 2026")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(parseDateQuery("23 ноября 2026")).toEqual({ from: "2026-11-23", to: "2026-11-23" });
  });

  it("обычные слова датой не считает", () => {
    expect(parseDateQuery("море")).toBeNull();
    expect(parseDateQuery("31.02.2026")).toBeNull();
    expect(parseDateQuery("прогулка с друзьями")).toBeNull();
  });
});

describe("нормализация текста для поиска", () => {
  it("понижает регистр кириллицы и латиницы", () => {
    expect(normalizeSearchText("Море сегодня СПОКОЙНОЕ")).toBe("море сегодня спокойное");
    expect(normalizeSearchText("Coffee With Анна")).toBe("coffee with анна");
  });

  it("не различает «ё» и «е», схлопывает пробелы", () => {
    expect(normalizeSearchText("  Ёлка   у   моря ")).toBe("елка у моря");
    expect(normalizeSearchText("ёжик")).toBe(normalizeSearchText("Ежик"));
  });

  it("заметка и запрос нормализуются одинаково", () => {
    expect(normalizeSearchText("Утро у моря")).toContain(normalizeSearchText("УТРО"));
  });
});

describe("серия дней", () => {
  it("считает дни подряд до сегодня", () => {
    const dates = ["2026-11-23", "2026-11-22", "2026-11-21", "2026-11-18"];
    expect(computeStreak(dates, "2026-11-23")).toEqual({ current: 3, best: 3, todayDone: true });
  });

  it("сегодняшний день без записи серию ещё не рвёт", () => {
    const dates = ["2026-11-22", "2026-11-21"];
    expect(computeStreak(dates, "2026-11-23")).toEqual({ current: 2, best: 2, todayDone: false });
    expect(computeStreak(dates, "2026-11-24")).toEqual({ current: 0, best: 2, todayDone: false });
  });

  it("помнит лучшую серию", () => {
    const dates = ["2026-11-23", "2026-11-10", "2026-11-09", "2026-11-08", "2026-11-07"];
    expect(computeStreak(dates, "2026-11-23")).toEqual({ current: 1, best: 4, todayDone: true });
    expect(computeStreak([], "2026-11-23")).toEqual({ current: 0, best: 0, todayDone: false });
  });
});
