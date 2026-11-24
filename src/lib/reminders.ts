// Планирование напоминаний на день. Чистые функции — их удобно проверять тестами.

import { hmToMinutes, minutesToHm } from "./dates";
import type { UserSettings } from "./settings";

type NotificationSettings = UserSettings["notifications"];

/** Попадает ли минута суток в тихие часы (интервал может переходить через полночь). */
export function inQuietHours(minute: number, n: NotificationSettings): boolean {
  if (!n.quietEnabled) return false;
  const from = hmToMinutes(n.quietFrom);
  const to = hmToMinutes(n.quietTo);
  if (from === to) return false;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** Детерминированный генератор: один и тот же день даёт одно и то же расписание. */
function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlannedSlot {
  slot: number;
  /** Время 'HH:MM' по часам пользователя; null — слот пропущен (например, целиком в тихих часах). */
  time: string | null;
}

/**
 * Расписание напоминаний на один день.
 * fixed  — ровно те часы, что выбрал пользователь;
 * random — perDay случайных моментов внутри активного периода, равномерно по дню и не слишком близко друг к другу.
 */
export function planDay(n: NotificationSettings, seed: string): PlannedSlot[] {
  if (n.mode === "fixed") {
    return [...n.fixedTimes]
      .sort()
      .map((time, slot) => ({ slot, time: inQuietHours(hmToMinutes(time), n) ? null : time }));
  }

  const rand = seeded(seed);
  let from = hmToMinutes(n.activeFrom);
  let to = hmToMinutes(n.activeTo);
  if (to <= from) {
    // Некорректный период — используем весь остаток дня.
    to = 23 * 60 + 59;
    if (to <= from) from = 9 * 60;
  }
  const count = Math.max(1, Math.min(6, n.perDay));
  const span = (to - from) / count;
  const out: PlannedSlot[] = [];
  for (let slot = 0; slot < count; slot++) {
    const lo = from + span * slot + span * 0.15;
    const hi = from + span * (slot + 1) - span * 0.15;
    let time: string | null = null;
    for (let attempt = 0; attempt < 12 && time === null; attempt++) {
      const minute = Math.round(lo + rand() * Math.max(0, hi - lo));
      if (!inQuietHours(minute, n)) time = minutesToHm(minute);
    }
    out.push({ slot, time });
  }
  return out;
}

export function expectedSlots(n: NotificationSettings): number {
  return n.mode === "fixed" ? n.fixedTimes.length : Math.max(1, Math.min(6, n.perDay));
}
