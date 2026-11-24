// Напоминания без сервера. Приложение из браузера не может разбудить телефон, когда оно закрыто,
// зато это умеет календарь телефона: Flash готовит файл с событиями-напоминаниями (.ics),
// который добавляется в календарь одним нажатием.

import { getDict } from "@/i18n";
import { addDays, parseYmd, type Ymd } from "@/lib/dates";
import { projectProgress } from "@/lib/projects";
import { planDay } from "@/lib/reminders";
import type { UserSettings } from "@/lib/settings";
import { projectTiming, store, type ProjectRec } from "./store";

/** На сколько дней вперёд создаются события. */
export const REMINDER_DAYS = 90;
const UNTIL_KEY = "remindersUntil";

const pad = (n: number) => String(n).padStart(2, "0");

/** Экранирование текста по правилам iCalendar. */
const esc = (text: string): string => text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Строки длиннее 75 байт по стандарту переносятся с пробелом в начале продолжения. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 74) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const len = new TextEncoder().encode(ch).length;
    if (size + len > 73) {
      out.push(current);
      current = " ";
      size = 1;
    }
    current += ch;
    size += len;
  }
  out.push(current);
  return out.join("\r\n");
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Текст напоминания на день: про проект, если он идёт, иначе — одна из общих фраз. */
function messageFor(day: Ymd, slot: number, projects: ProjectRec[], locale: string): { title: string; body: string } {
  const p = getDict(locale).push;
  // Проект считается «как будто сегодня — этот день»: так получается номер дня и остаток срока.
  const running = projects
    .filter((x) => x.status === "active")
    .map((x) => ({ project: x, progress: projectProgress(projectTiming(x), day) }))
    .filter((x) => x.progress.started && !x.progress.overdue)
    .sort((a, b) => (a.progress.daysLeft ?? 1e9) - (b.progress.daysLeft ?? 1e9))[0];
  if (running && slot === 0) {
    const { project, progress } = running;
    const title = `Flash · ${project.title}`;
    if (progress.isLastDay) return { title, body: p.projectLastDay };
    if (progress.daysLeft === 3) return { title, body: p.projectThreeLeft };
    if (progress.totalDays && progress.dayIndex === Math.ceil(progress.totalDays / 2)) return { title, body: p.projectHalf };
    return {
      title,
      body: progress.totalDays ? p.projectDay(progress.dayIndex, progress.totalDays) : p.projectDayOpen(progress.dayIndex),
    };
  }
  return { title: `Flash · ${p.genericTitle}`, body: p.generic[hash(`${day}:${slot}`) % p.generic.length] };
}

export interface ReminderCalendar {
  ics: string;
  events: number;
  /** Последний день, на который есть напоминание. */
  until: Ymd;
}

/** Собирает календарь напоминаний на REMINDER_DAYS дней вперёд по настройкам пользователя. */
export function buildReminderCalendar(
  settings: UserSettings["notifications"],
  today: Ymd,
  projects: ProjectRec[],
  locale: string,
  appUrl: string,
  now: Date = new Date(),
): ReminderCalendar {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Flash//Personal Life Diary//RU",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Flash",
  ];
  let events = 0;
  let until = today;
  for (let i = 0; i < REMINDER_DAYS; i++) {
    const day = addDays(today, i);
    const { y, m, d } = parseYmd(day);
    for (const slot of planDay(settings, day)) {
      if (!slot.time) continue;
      const [hh, mm] = slot.time.split(":").map(Number);
      const start = `${y}${pad(m)}${pad(d)}T${pad(hh)}${pad(mm)}00`;
      const endMinutes = hh * 60 + mm + 10;
      const end = `${y}${pad(m)}${pad(d)}T${pad(Math.min(23, Math.floor(endMinutes / 60)))}${pad(endMinutes >= 24 * 60 ? 59 : endMinutes % 60)}00`;
      const { title, body } = messageFor(day, slot.slot, projects, locale);
      lines.push(
        "BEGIN:VEVENT",
        // Один и тот же идентификатор на день и слот: повторное добавление обновляет событие, а не дублирует его.
        `UID:flash-${day}-${slot.slot}@flash.diary`,
        `DTSTAMP:${stamp}`,
        // Время без часового пояса — «по часам телефона», где бы он ни находился.
        `DTSTART:${start}`,
        `DTEND:${end}`,
        `SUMMARY:${esc(title)}`,
        `DESCRIPTION:${esc(`${body}\n${appUrl}`)}`,
        `URL:${appUrl}`,
        "TRANSP:TRANSPARENT",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${esc(body)}`,
        "TRIGGER:PT0S",
        "END:VALARM",
        "END:VEVENT",
      );
      events++;
      until = day;
    }
  }
  lines.push("END:VCALENDAR");
  return { ics: lines.map(fold).join("\r\n") + "\r\n", events, until };
}

/** Запоминает, до какого дня в календаре есть напоминания, чтобы вовремя предложить обновить их. */
export async function rememberRemindersUntil(until: Ymd): Promise<void> {
  await store.ready();
  await store.setValue(UNTIL_KEY, until);
}

export async function remindersUntil(): Promise<Ymd | null> {
  await store.ready();
  return (await store.getValue<Ymd>(UNTIL_KEY)) ?? null;
}
