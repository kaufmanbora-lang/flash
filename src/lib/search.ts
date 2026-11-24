// Поиск по архиву: по словам заметки (с учётом русских словоформ) и по дате.

import { daysInMonth, isValidYmd, ymdOf, type Ymd } from "./dates";

/** Приводит текст к виду для поиска: нижний регистр, «ё» → «е», одиночные пробелы. */
export function normalizeSearchText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

const ENDINGS = [
  "иями", "ями", "ами", "ыми", "ими", "ого", "его", "ому", "ему", "иях", "ией", "ием",
  "ах", "ях", "ов", "ев", "ей", "ой", "ий", "ый", "ая", "яя", "ое", "ее", "ые", "ие", "ам", "ям", "ом", "ем", "ую", "юю",
  "а", "я", "ы", "и", "у", "ю", "е", "о", "ь",
];

/**
 * Грубая основа русского слова: отбрасывает одно типичное окончание.
 * Этого хватает, чтобы «море» находило «у моря», а «прогулка» — «на прогулке».
 */
export function stemWord(word: string): string {
  if (word.length <= 3 || !/[а-я]/.test(word)) return word;
  for (const ending of ENDINGS) {
    if (word.endsWith(ending) && word.length - ending.length >= 3) return word.slice(0, -ending.length);
  }
  return word;
}

const words = (text: string): string[] => text.split(/[^0-9a-zа-я]+/).filter(Boolean);

/** Подходит ли заметка под запрос: вхождение подстроки или совпадение всех слов запроса по основам. */
export function noteMatches(noteNorm: string, queryNorm: string): boolean {
  if (!queryNorm) return true;
  if (!noteNorm) return false;
  if (noteNorm.includes(queryNorm)) return true;
  const noteStems = words(noteNorm).map(stemWord);
  const queryStems = words(queryNorm).map(stemWord);
  if (queryStems.length === 0) return false;
  return queryStems.every((q) => noteStems.some((n) => n === q || (q.length >= 3 && n.startsWith(q))));
}

const MONTHS: Record<string, number> = {
  январ: 1, феврал: 2, март: 3, апрел: 4, мая: 5, май: 5, июн: 6, июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Разбирает поисковый запрос как дату или период: «23.11.2026», «2026-11», «ноябрь 2026», «2025». */
export function parseDateQuery(raw: string): { from: Ymd; to: Ymd } | { month: number; day?: number } | null {
  const s = raw.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const d = ymdOf(+m[1], +m[2], +m[3]);
    return isValidYmd(d) ? { from: d, to: d } : null;
  }
  if ((m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/))) {
    const d = ymdOf(+m[3], +m[2], +m[1]);
    return isValidYmd(d) ? { from: d, to: d } : null;
  }
  const monthRange = (y: number, mo: number) =>
    y >= 1970 && y <= 2200 && mo >= 1 && mo <= 12 ? { from: ymdOf(y, mo, 1), to: ymdOf(y, mo, daysInMonth(y, mo)) } : null;
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) return monthRange(+m[1], +m[2]);
  if ((m = s.match(/^(\d{1,2})[./](\d{4})$/))) return monthRange(+m[2], +m[1]);
  if ((m = s.match(/^(\d{4})$/))) {
    const y = +m[1];
    return y >= 1970 && y <= 2200 ? { from: ymdOf(y, 1, 1), to: ymdOf(y, 12, 31) } : null;
  }
  if ((m = s.match(/^(\d{1,2})[./](\d{1,2})$/))) {
    const day = +m[1];
    const month = +m[2];
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { month, day } : null;
  }
  // «ноябрь», «23 ноября», «ноябрь 2026», «23 ноября 2026»
  if ((m = s.match(/^(?:(\d{1,2})\s+)?([a-zа-яё]+)(?:\s+(\d{4}))?$/))) {
    const word = m[2];
    const entry = Object.entries(MONTHS).find(([stem]) => word.startsWith(stem));
    if (!entry) return null;
    const month = entry[1];
    const day = m[1] ? +m[1] : undefined;
    const year = m[3] ? +m[3] : undefined;
    if (year) {
      if (day) {
        const d = ymdOf(year, month, day);
        return isValidYmd(d) ? { from: d, to: d } : null;
      }
      return { from: ymdOf(year, month, 1), to: ymdOf(year, month, daysInMonth(year, month)) };
    }
    return { month, day };
  }
  return null;
}
