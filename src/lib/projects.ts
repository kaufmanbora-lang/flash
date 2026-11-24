// Расчёт прогресса проекта воспоминаний. Чистые функции без доступа к базе —
// используются и на сервере, и в интерфейсе, и в планировщике уведомлений.

import type { PeriodKind } from "./constants";
import { addDays, addMonths, diffDays, maxYmd, minYmd, type Ymd } from "./dates";

export interface PauseSpan {
  /** День, когда поставили на паузу (он ещё считается активным). */
  from: Ymd;
  /** День возобновления (уже активный); null — пауза продолжается. */
  to: Ymd | null;
}

export type ProjectStatus = "active" | "paused" | "completed";

export interface ProjectTiming {
  start_date: Ymd;
  end_date: Ymd | null;
  status: ProjectStatus;
  pauses: PauseSpan[];
}

const PERIOD_DAYS: Partial<Record<PeriodKind, number>> = { d1: 1, d3: 3, d7: 7, d14: 14, d30: 30 };
const PERIOD_MONTHS: Partial<Record<PeriodKind, number>> = { m3: 3, m6: 6, y1: 12 };

/** Последний день периода, начинающегося в start. Для custom и open возвращает null. */
export function periodEnd(kind: PeriodKind, start: Ymd): Ymd | null {
  const days = PERIOD_DAYS[kind];
  if (days) return addDays(start, days - 1);
  const months = PERIOD_MONTHS[kind];
  if (months) return addDays(addMonths(start, months), -1);
  return null;
}

/** Первый и последний «выключенный» день паузы. Дни from и to сами остаются активными. */
function pausedRange(p: PauseSpan, today: Ymd): [Ymd, Ymd] {
  return [addDays(p.from, 1), p.to ? addDays(p.to, -1) : today];
}

function pausedDaysWithin(pauses: PauseSpan[], a: Ymd, b: Ymd, today: Ymd): number {
  let n = 0;
  for (const p of pauses) {
    const [first, last] = pausedRange(p, today);
    const lo = maxYmd(first, a);
    const hi = minYmd(last, b);
    if (lo <= hi) n += diffDays(hi, lo) + 1;
  }
  return n;
}

export function isPausedDay(pauses: PauseSpan[], day: Ymd, today: Ymd): boolean {
  return pauses.some((p) => {
    const [first, last] = pausedRange(p, today);
    return day >= first && day <= last;
  });
}

/** Сколько дней добавила бы к сроку пауза, если возобновить проект в день resumeDay. */
export function pauseShift(p: PauseSpan, resumeDay: Ymd): number {
  return Math.max(0, diffDays(resumeDay, p.from) - 1);
}

export interface ProjectProgress {
  started: boolean;
  /** Номер текущего дня проекта (1…totalDays); 0, если проект ещё не начался. */
  dayIndex: number;
  /** Всего дней записи; null для бессрочных проектов. */
  totalDays: number | null;
  daysLeft: number | null;
  percent: number | null;
  /** Ожидаемая дата окончания с учётом идущей паузы. */
  expectedEnd: Ymd | null;
  isLastDay: boolean;
  /** Срок вышел, проект пора завершать. */
  overdue: boolean;
}

export function projectProgress(p: ProjectTiming, today: Ymd): ProjectProgress {
  const started = today >= p.start_date;
  const openPause = p.pauses.find((x) => x.to === null) ?? null;

  let expectedEnd = p.end_date;
  if (expectedEnd && openPause && p.status === "paused") {
    expectedEnd = addDays(expectedEnd, Math.max(0, diffDays(today, openPause.from)));
  }

  const activeDays = (a: Ymd, b: Ymd) => Math.max(0, diffDays(b, a) + 1 - pausedDaysWithin(p.pauses, a, b, today));

  const totalDays = expectedEnd ? Math.max(1, activeDays(p.start_date, expectedEnd)) : null;
  let dayIndex = 0;
  if (started) {
    const ref = expectedEnd ? minYmd(today, expectedEnd) : today;
    dayIndex = Math.max(1, activeDays(p.start_date, ref));
    if (totalDays !== null) dayIndex = Math.min(dayIndex, totalDays);
  }
  const daysLeft = totalDays === null ? null : Math.max(0, totalDays - dayIndex);
  const percent = totalDays === null ? null : Math.min(100, Math.max(0, Math.round((dayIndex / totalDays) * 100)));
  const overdue = p.status === "active" && p.end_date !== null && today > p.end_date;
  const isLastDay = p.status === "active" && started && p.end_date !== null && today === p.end_date;

  return { started, dayIndex, totalDays, daysLeft, percent, expectedEnd, isLastDay, overdue };
}

/**
 * Попадает ли день в период проекта (окончание — с учётом идущей паузы).
 * Момент, снятый вне периода, в проект не добавляется: иначе он оказался бы в его фильме.
 */
export function projectCoversDay(p: ProjectTiming, day: Ymd, today: Ymd): boolean {
  if (day < p.start_date) return false;
  const end = projectProgress(p, today).expectedEnd;
  return end === null || day <= end;
}

export type ProjectDayState = "recorded" | "missed" | "today" | "future" | "paused";

export interface ProjectDay {
  date: Ymd;
  /** Порядковый номер дня записи (паузы не нумеруются). */
  index: number | null;
  count: number;
  state: ProjectDayState;
}

/** Календарь проекта: каждый день периода с пометкой «записан / пропущен / пауза / впереди». */
export function projectDays(
  p: ProjectTiming,
  today: Ymd,
  counts: Map<Ymd, number> | Record<Ymd, number>,
  maxDays = 400,
): ProjectDay[] {
  const get = (d: Ymd) => (counts instanceof Map ? counts.get(d) : counts[d]) ?? 0;
  const progress = projectProgress(p, today);
  let last = progress.expectedEnd ?? maxYmd(today, p.start_date);
  if (diffDays(last, p.start_date) + 1 > maxDays) {
    // Для очень длинных и бессрочных проектов показываем последние maxDays дней.
    const anchor = minYmd(last, maxYmd(today, p.start_date));
    last = anchor;
  }
  const first = diffDays(last, p.start_date) + 1 > maxDays ? addDays(last, -(maxDays - 1)) : p.start_date;

  const out: ProjectDay[] = [];
  let index = Math.max(0, diffDays(first, p.start_date) - pausedDaysWithin(p.pauses, p.start_date, addDays(first, -1), today));
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const count = get(d);
    const paused = isPausedDay(p.pauses, d, today);
    if (!paused) index++;
    let state: ProjectDayState;
    if (count > 0) state = "recorded";
    else if (paused) state = "paused";
    else if (d === today) state = "today";
    else if (d > today) state = "future";
    else state = "missed";
    out.push({ date: d, index: paused ? null : index, count, state });
  }
  return out;
}
