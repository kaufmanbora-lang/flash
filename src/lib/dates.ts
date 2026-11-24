// Календарная арифметика на строках 'YYYY-MM-DD'. Никаких сдвигов из-за часовых поясов:
// дата — это просто день в календаре пользователя.

export type Ymd = string;

const pad = (n: number) => String(n).padStart(2, "0");

export function ymdOf(y: number, m: number, d: number): Ymd {
  return `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
}

export function isValidYmd(s: unknown): s is Ymd {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidHm(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function parseYmd(s: Ymd): { y: number; m: number; d: number } {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

/** Полночь UTC этого календарного дня — удобно для форматирования с timeZone: 'UTC'. */
export function ymdToUtc(s: Ymd): Date {
  const { y, m, d } = parseYmd(s);
  return new Date(Date.UTC(y, m - 1, d));
}

export function utcToYmd(dt: Date): Ymd {
  return ymdOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(s: Ymd, n: number): Ymd {
  const dt = ymdToUtc(s);
  dt.setUTCDate(dt.getUTCDate() + n);
  return utcToYmd(dt);
}

/** a − b в днях. */
export function diffDays(a: Ymd, b: Ymd): number {
  return Math.round((ymdToUtc(a).getTime() - ymdToUtc(b).getTime()) / 86_400_000);
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Сдвиг на n месяцев с сохранением числа (31 января + 1 месяц = 28/29 февраля). */
export function addMonths(s: Ymd, n: number): Ymd {
  const { y, m, d } = parseYmd(s);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const yy = first.getUTCFullYear();
  const mm = first.getUTCMonth() + 1;
  return ymdOf(yy, mm, Math.min(d, daysInMonth(yy, mm)));
}

/** 0 — понедельник … 6 — воскресенье. */
export function weekdayIndex(s: Ymd): number {
  return (ymdToUtc(s).getUTCDay() + 6) % 7;
}

export function startOfWeek(s: Ymd): Ymd {
  return addDays(s, -weekdayIndex(s));
}

export function endOfWeek(s: Ymd): Ymd {
  return addDays(startOfWeek(s), 6);
}

export function startOfMonth(s: Ymd): Ymd {
  const { y, m } = parseYmd(s);
  return ymdOf(y, m, 1);
}

export function endOfMonth(s: Ymd): Ymd {
  const { y, m } = parseYmd(s);
  return ymdOf(y, m, daysInMonth(y, m));
}

export function startOfYear(s: Ymd): Ymd {
  return ymdOf(parseYmd(s).y, 1, 1);
}

export function endOfYear(s: Ymd): Ymd {
  return ymdOf(parseYmd(s).y, 12, 31);
}

export function minYmd(a: Ymd, b: Ymd): Ymd {
  return a <= b ? a : b;
}

export function maxYmd(a: Ymd, b: Ymd): Ymd {
  return a >= b ? a : b;
}

/** Все дни от from до to включительно. */
export function eachDay(from: Ymd, to: Ymd): Ymd[] {
  const out: Ymd[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToHm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

// ── Локальное время устройства (браузер) ─────────────────────

export function deviceYmd(date: Date = new Date()): Ymd {
  return ymdOf(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function deviceHm(date: Date = new Date()): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// ── Часовые пояса ────────────────────────────────────────────

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormat(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  ymd: Ymd;
  hm: string;
  /** Минуты от полуночи по местному времени. */
  minutes: number;
}

/** Календарный день и время в заданном часовом поясе для момента date. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = zonedFormat(timeZone).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const h = get("hour") % 24;
  const mi = get("minute");
  return {
    ymd: ymdOf(get("year"), get("month"), get("day")),
    hm: `${pad(h)}:${pad(mi)}`,
    minutes: h * 60 + mi,
  };
}

/** Момент времени, когда в часовом поясе timeZone на часах ymd + hm. */
export function zonedToUtc(ymd: Ymd, hm: string, timeZone: string): Date {
  const { y, m, d } = parseYmd(ymd);
  const [h, mi] = hm.split(":").map(Number);
  const wanted = Date.UTC(y, m - 1, d, h, mi);
  let guess = wanted;
  // Две итерации хватает даже на границах перехода на летнее время.
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const { y: py, m: pm, d: pd } = parseYmd(p.ymd);
    const shown = Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
    const delta = wanted - shown;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}
