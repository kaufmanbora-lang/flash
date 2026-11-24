// Форматирование дат, длительностей и размеров с учётом языка. Работает в браузере и на сервере.

import { parseYmd, ymdToUtc, type Ymd } from "./dates";

const cache = new Map<string, Intl.DateTimeFormat>();

function dtf(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" });
    cache.set(key, f);
  }
  return f;
}

function part(locale: string, ymd: Ymd, opts: Intl.DateTimeFormatOptions, type: Intl.DateTimeFormatPartTypes): string {
  return dtf(locale, opts).formatToParts(ymdToUtc(ymd)).find((p) => p.type === type)?.value ?? "";
}

export function capitalize(s: string): string {
  return s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s;
}

/** «23 ноября» */
export function fmtDayMonth(ymd: Ymd, locale = "ru"): string {
  return dtf(locale, { day: "numeric", month: "long" }).format(ymdToUtc(ymd));
}

/** «23 нояб.» → «23 нояб» */
export function fmtDayMonthShort(ymd: Ymd, locale = "ru"): string {
  return dtf(locale, { day: "numeric", month: "short" }).format(ymdToUtc(ymd)).replace(/\.$/, "");
}

/** «23 ноября 2026» (без «г.») */
export function fmtFullDate(ymd: Ymd, locale = "ru"): string {
  return `${fmtDayMonth(ymd, locale)} ${parseYmd(ymd).y}`;
}

/** «понедельник» */
export function fmtWeekday(ymd: Ymd, locale = "ru"): string {
  return dtf(locale, { weekday: "long" }).format(ymdToUtc(ymd));
}

/** «пн» */
export function fmtWeekdayShort(ymd: Ymd, locale = "ru"): string {
  return dtf(locale, { weekday: "short" }).format(ymdToUtc(ymd)).replace(/\.$/, "");
}

/** Название месяца в именительном падеже: «ноябрь» */
export function fmtMonthName(ymd: Ymd, locale = "ru"): string {
  return part(locale, ymd, { month: "long" }, "month");
}

/** «Ноябрь 2026» */
export function fmtMonthYear(ymd: Ymd, locale = "ru"): string {
  return `${capitalize(fmtMonthName(ymd, locale))} ${parseYmd(ymd).y}`;
}

/** «Понедельник, 23 ноября» */
export function fmtWeekdayDate(ymd: Ymd, locale = "ru"): string {
  return `${capitalize(fmtWeekday(ymd, locale))}, ${fmtDayMonth(ymd, locale)}`;
}

/** Диапазон дат: «23 ноября 2026», «17–23 ноября 2026», «23 октября — 21 ноября 2026», «28 декабря 2026 — 3 января 2027». */
export function fmtRange(from: Ymd, to: Ymd, locale = "ru", withYear = true): string {
  const a = parseYmd(from);
  const b = parseYmd(to);
  if (from === to) return withYear ? fmtFullDate(from, locale) : fmtDayMonth(from, locale);
  if (a.y === b.y && a.m === b.m) {
    const month = dtf(locale, { day: "numeric", month: "long" })
      .formatToParts(ymdToUtc(to))
      .find((p) => p.type === "month")?.value;
    return `${a.d}–${b.d} ${month}${withYear ? ` ${b.y}` : ""}`;
  }
  if (a.y === b.y) {
    return `${fmtDayMonth(from, locale)} — ${fmtDayMonth(to, locale)}${withYear ? ` ${b.y}` : ""}`;
  }
  return `${fmtFullDate(from, locale)} — ${fmtFullDate(to, locale)}`;
}

/** Таймер: 2:48, 1:02:03 */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function fmtNumber(n: number, locale = "ru", fractionDigits = 0): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  }).format(n);
}

export interface ByteUnits {
  b: string;
  kb: string;
  mb: string;
  gb: string;
}

export function fmtBytes(bytes: number, units: ByteUnits, locale = "ru"): string {
  if (bytes < 1024) return `${bytes} ${units.b}`;
  if (bytes < 1024 ** 2) return `${fmtNumber(bytes / 1024, locale)} ${units.kb}`;
  if (bytes < 1024 ** 3) return `${fmtNumber(bytes / 1024 ** 2, locale, bytes < 10 * 1024 ** 2 ? 1 : 0)} ${units.mb}`;
  return `${fmtNumber(bytes / 1024 ** 3, locale, bytes < 100 * 1024 ** 3 ? 1 : 0)} ${units.gb}`;
}

/** Выбор формы множественного числа по правилам языка: plural(5, { one: 'момент', few: 'момента', many: 'моментов' }, 'ru'). */
export function plural(
  n: number,
  forms: { one: string; few?: string; many?: string; other?: string },
  locale = "ru",
): string {
  const rule = new Intl.PluralRules(locale).select(Math.abs(n));
  const map: Record<string, string | undefined> = {
    one: forms.one,
    few: forms.few,
    many: forms.many,
    other: forms.other,
  };
  return map[rule] ?? forms.other ?? forms.many ?? forms.few ?? forms.one;
}
