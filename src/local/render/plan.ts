// План фильма: какие отрезки каких моментов войдут, в каком порядке, с какими титрами и переходами.
// Чистые функции без браузера — план одинаково считается в приложении и в тестах.
// Длительности считаются в кадрах (30 в секунду), звук — в сэмплах (1600 на кадр): рассинхрон не копится.

import { getDict } from "@/i18n";
import { VARIANT_TARGETS, type FilmKind, type FilmStyleId, type FilmVariant, type Orientation, type Resolution } from "@/lib/constants";
import { addDays, diffDays, parseYmd, startOfWeek, type Ymd } from "@/lib/dates";
import { capitalize, fmtDayMonth, fmtFullDate, fmtMonthYear, fmtRange, fmtWeekday } from "@/lib/format";
import { selectSegments, type Segment } from "@/lib/highlights";
import type { FilmChapter, MomentAnalysis } from "@/lib/types";
import { FPS, STYLES, type Transition } from "./styles";

/** Подпись с датой показывается на клипах не короче LABEL_MIN_CLIP кадров и держится не дольше LABEL_MAX. */
const LABEL_MIN_CLIP = 54;
const LABEL_MAX = 96;
const LABEL_TAIL_GAP = 15;
export const labelFramesFor = (clipFrames: number): number =>
  clipFrames >= LABEL_MIN_CLIP ? Math.min(LABEL_MAX, clipFrames - LABEL_TAIL_GAP) : 0;

export type CardRole = "eyebrow" | "title" | "subtitle" | "tagline" | "meta";

export interface CardLine {
  role: CardRole;
  text: string;
}

export interface LabelText {
  /** «23 ноября» */
  primary: string;
  /** «Понедельник» или время «14:32» */
  secondary?: string;
  /** Числовая дата для стиля Vintage: «23.11.2026 14:32» */
  stamp: string;
}

export interface PlanMoment {
  id: string;
  date: Ymd;
  time: string;
  durationMs: number;
  width: number;
  height: number;
  analysis: MomentAnalysis | null;
}

export interface PlanFilm {
  kind: FilmKind;
  variant: FilmVariant;
  title: string;
  subtitle: string;
  dateFrom: Ymd;
  dateTo: Ymd;
  orientation: Orientation;
  resolution: Resolution;
}

export interface PlanProject {
  title: string;
  description: string;
  startDate: Ymd;
  endDate: Ymd | null;
}

export interface ClipPlan {
  momentId: string;
  /** Начало отрезка внутри момента, секунды. */
  start: number;
  frames: number;
  /** Первый клип нового календарного дня. */
  dayStart: boolean;
  chapter: number;
  date: Ymd;
}

export interface CardElement {
  kind: "card";
  role: "intro" | "outro" | "chapter";
  frames: number;
  lines: CardLine[];
  /** Момент, кадр которого станет размытым фоном карточки. */
  photoOf: string | null;
}

export interface ClipElement {
  kind: "clip";
  frames: number;
  clip: ClipPlan;
  label: LabelText | null;
}

export type PlanElement = CardElement | ClipElement;

export interface FilmPlan {
  W: number;
  H: number;
  /** Высота чёрной полосы сверху и снизу (формат «кино»), 0 — полос нет. */
  barHeight: number;
  styleId: FilmStyleId;
  elements: PlanElement[];
  /** Переход между элементом i и i + 1. */
  transitions: Transition[];
  /** Кадр, с которого начинается каждый элемент на общей линии времени (с учётом перекрытий). */
  starts: number[];
  totalFrames: number;
  /** Оглавление для плеера. */
  chapters: FilmChapter[];
  clipCount: number;
  /** Кадр для обложки фильма: первый клип, когда подпись с датой уже погасла. */
  posterFrame: number;
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
const pad2 = (n: number) => String(n).padStart(2, "0");

/** Размер кадра фильма: ориентация — по большинству материала, качество — не выше исходного. */
export function chooseCanvas(
  film: Pick<PlanFilm, "orientation" | "resolution">,
  moments: PlanMoment[],
): { W: number; H: number } {
  let portraitMs = 0;
  let totalMs = 0;
  let maxShort = 0;
  for (const m of moments) {
    totalMs += m.durationMs;
    if (m.height > m.width) portraitMs += m.durationMs;
    maxShort = Math.max(maxShort, Math.min(m.width, m.height));
  }
  const portrait = film.orientation === "auto" ? portraitMs * 2 >= totalMs : film.orientation === "portrait";
  const requested = film.resolution === "auto" ? 1080 : Number(film.resolution);
  // Не выше запрошенного и не выше того, что позволяет исходное видео (но не ниже 720p).
  let short = 720;
  for (const tier of [720, 1080, 1440, 2160]) {
    if (tier <= requested && tier <= Math.max(720, maxShort)) short = tier;
  }
  const long = even((short * 16) / 9);
  return portrait ? { W: short, H: long } : { W: long, H: short };
}

/** Тот же кадр ступенью ниже — на случай, если устройство не может кодировать выбранный размер. */
export function lowerCanvas(size: { W: number; H: number }): { W: number; H: number } | null {
  const short = Math.min(size.W, size.H);
  const tiers = [720, 1080, 1440, 2160];
  const index = tiers.indexOf(short);
  if (index <= 0) return null;
  const next = tiers[index - 1];
  const long = even((next * 16) / 9);
  return size.H > size.W ? { W: next, H: long } : { W: long, H: next };
}

type ChapterMode = "day" | "week" | "month";

function chapterKey(mode: ChapterMode, date: Ymd, origin: Ymd): string {
  if (mode === "day") return date;
  if (mode === "month") return date.slice(0, 7);
  return String(Math.floor(diffDays(startOfWeek(date), startOfWeek(origin)) / 7));
}

/** Какие отрезки моментов войдут в фильм этой версии. */
export function planSegments(variant: FilmVariant, moments: PlanMoment[]): Segment[] {
  const inputs = moments.map((m) => ({ id: m.id, durationSec: m.durationMs / 1000, analysis: m.analysis }));
  if (variant === "full") return inputs.map((c) => ({ id: c.id, start: 0, duration: c.durationSec }));
  const totalFootage = inputs.reduce((s, c) => s + c.durationSec, 0);
  const cfg = VARIANT_TARGETS[variant];
  const target = variant === "highlights" ? Math.min(150, Math.max(24, totalFootage * 0.35)) : cfg.target;
  return selectSegments(inputs, { target, minSeg: cfg.minSeg, maxSeg: cfg.maxSeg });
}

export interface PlanInput {
  film: PlanFilm;
  /** Моменты фильма в хронологическом порядке. */
  moments: PlanMoment[];
  project: PlanProject | null;
  styleId: FilmStyleId;
  size: { W: number; H: number };
  userName: string;
  locale: string;
}

export function planFilm(input: PlanInput): FilmPlan {
  const { film, moments, project, locale } = input;
  if (moments.length === 0) throw new Error("no_moments");
  const t = getDict(locale).film;
  const style = STYLES[input.styleId];
  const { W, H } = input.size;
  const barHeight = style.letterbox && W > H ? even((H - W / 2.39) / 2) : 0;
  const trailer = film.variant === "trailer";

  const segments = planSegments(film.variant, moments);
  const byId = new Map(moments.map((m) => [m.id, m]));

  const firstDay = moments[0].date;
  const lastDay = moments[moments.length - 1].date;
  const dayList = [...new Set(segments.map((s) => byId.get(s.id)!.date))];
  const multiDay = dayList.length > 1;
  const spanDays = diffDays(lastDay, firstDay) + 1;
  const mode: ChapterMode = spanDays <= 10 ? "day" : spanDays <= 70 ? "week" : "month";
  const origin = project?.startDate && project.startDate <= firstDay ? project.startDate : firstDay;

  // 1. Клипы и главы.
  const chapters: { title: string; subtitle: string }[] = [];
  const chapterIndex = new Map<string, number>();
  const clips: ClipPlan[] = [];
  let prevDate: Ymd | null = null;
  for (const seg of segments) {
    const moment = byId.get(seg.id)!;
    const date = moment.date;
    const key = chapterKey(mode, date, origin);
    if (!chapterIndex.has(key)) {
      chapterIndex.set(key, chapters.length);
      if (mode === "day") {
        const dayNo = diffDays(date, origin) + 1;
        chapters.push(
          project
            ? { title: t.chapterDay(dayNo), subtitle: `${fmtDayMonth(date, locale)}, ${fmtWeekday(date, locale)}` }
            : { title: fmtDayMonth(date, locale), subtitle: capitalize(fmtWeekday(date, locale)) },
        );
      } else if (mode === "week") {
        const weekStart = startOfWeek(date);
        const from = weekStart < firstDay ? firstDay : weekStart;
        const to = addDays(weekStart, 6) > lastDay ? lastDay : addDays(weekStart, 6);
        chapters.push({ title: t.chapterWeek(Number(key) + 1), subtitle: fmtRange(from, to, locale, false) });
      } else {
        chapters.push({ title: fmtMonthYear(date, locale), subtitle: "" });
      }
    }
    clips.push({
      momentId: moment.id,
      start: seg.start,
      frames: Math.max(45, Math.floor(seg.duration * FPS)),
      dayStart: date !== prevDate,
      chapter: chapterIndex.get(key)!,
      date,
    });
    prevDate = date;
  }
  const clipSeconds = clips.reduce((s, c) => s + c.frames, 0) / FPS;
  // Карточки глав — только для длинных фильмов; в коротких хватает подписей с датой.
  const chapterCards = multiDay && chapters.length >= 2 && clipSeconds >= 300 && !trailer;

  // 2. Титры.
  const statsLine = t.statsLine(clips.length, Math.round(clipSeconds * 1000));
  const rangeText = fmtRange(project?.startDate ?? firstDay, project?.endDate ?? lastDay, locale);
  const variantName = film.variant === "full" ? "" : t.variants[film.variant];

  const introLines: CardLine[] = [];
  if (film.kind === "project") {
    introLines.push(
      { role: "eyebrow", text: variantName || t.projectEyebrow },
      { role: "title", text: project?.title ?? film.title },
      { role: "subtitle", text: rangeText },
      { role: "tagline", text: project?.description?.trim() ? project.description.trim().slice(0, 90) : t.tagline },
    );
  } else if (film.kind === "day") {
    // «23 ноября 2026 / Понедельник / A little piece of my life.»
    introLines.push(
      { role: "eyebrow", text: variantName },
      { role: "title", text: fmtFullDate(film.dateFrom, locale) },
      { role: "subtitle", text: capitalize(fmtWeekday(film.dateFrom, locale)) },
      { role: "tagline", text: t.tagline },
    );
  } else {
    introLines.push(
      { role: "eyebrow", text: variantName || film.subtitle },
      { role: "title", text: film.title },
      { role: "subtitle", text: film.kind === "custom" || film.kind === "week" ? "" : fmtRange(firstDay, lastDay, locale) },
      { role: "tagline", text: t.tagline },
    );
  }

  const outroLines: CardLine[] = [];
  if (film.kind === "project") {
    outroLines.push(
      { role: "title", text: t.outro.project },
      { role: "subtitle", text: project?.title ?? film.title },
      { role: "meta", text: rangeText },
      { role: "meta", text: `${statsLine} · ${t.daysRecorded(dayList.length)}` },
      { role: "tagline", text: trailer ? "" : t.credits.thanks },
      { role: "meta", text: trailer || !input.userName.trim() ? "" : t.credits.by(input.userName.trim()) },
    );
  } else {
    outroLines.push({ role: "title", text: film.kind === "day" ? t.outro.day : t.outro.period }, { role: "meta", text: statsLine });
  }

  const introFrames = trailer ? 75 : film.kind === "project" ? 132 : 108;
  const outroFrames = trailer ? 72 : film.kind === "project" ? 156 : 108;

  // 3. Линия времени.
  const elements: PlanElement[] = [];
  /** Индекс элемента, с которого начинается каждая глава (для оглавления плеера). */
  const chapterStartEl = new Map<number, number>();
  elements.push({ kind: "card", role: "intro", frames: introFrames, lines: introLines, photoOf: clips[0].momentId });
  let currentChapter = -1;
  for (const clip of clips) {
    let afterChapterCard = false;
    if (clip.chapter !== currentChapter) {
      currentChapter = clip.chapter;
      chapterStartEl.set(clip.chapter, elements.length);
      if (chapterCards) {
        const ch = chapters[clip.chapter];
        elements.push({
          kind: "card",
          role: "chapter",
          frames: 66,
          lines: [
            { role: "title", text: ch.title },
            { role: "subtitle", text: ch.subtitle },
          ],
          photoOf: clip.momentId,
        });
        afterChapterCard = mode === "day";
      }
    }
    const moment = byId.get(clip.momentId)!;
    const { y, m, d } = parseYmd(clip.date);
    const stamp = `${pad2(d)}.${pad2(m)}.${y}  ${moment.time}`;
    let label: LabelText | null = null;
    if (!multiDay) {
      label = { primary: moment.time, stamp };
    } else if (clip.dayStart && !afterChapterCard) {
      label = { primary: fmtDayMonth(clip.date, locale), secondary: capitalize(fmtWeekday(clip.date, locale)), stamp };
    }
    elements.push({ kind: "clip", frames: clip.frames, clip, label });
  }
  elements.push({
    kind: "card",
    role: "outro",
    frames: outroFrames,
    lines: outroLines,
    photoOf: clips[clips.length - 1].momentId,
  });

  // 4. Переходы между соседними элементами.
  const transitions: Transition[] = [];
  for (let i = 0; i < elements.length - 1; i++) {
    const a = elements[i];
    const b = elements[i + 1];
    const sameDay = a.kind === "clip" && b.kind === "clip" && a.clip.date === b.clip.date;
    const base = sameDay ? style.clip : style.day;
    transitions.push({ type: base.type, frames: trailer ? (sameDay ? 9 : 15) : base.frames });
  }
  // Элемент должен быть длиннее своих переходов: при необходимости переходы укорачиваются.
  for (let i = 0; i < elements.length; i++) {
    for (let guard = 0; guard < 20; guard++) {
      const head = i > 0 ? transitions[i - 1].frames : 0;
      const tail = i < transitions.length ? transitions[i].frames : 0;
      if (elements[i].frames - head - tail >= 6) break;
      if (head >= tail && head > 6) transitions[i - 1].frames = Math.max(6, head - 3);
      else if (tail > 6) transitions[i].frames = Math.max(6, tail - 3);
      else {
        elements[i].frames = head + tail + 6;
        break;
      }
    }
  }

  const starts: number[] = [];
  let cursor = 0;
  for (let i = 0; i < elements.length; i++) {
    starts.push(cursor);
    cursor += elements[i].frames - (i < transitions.length ? transitions[i].frames : 0);
  }
  const totalFrames = cursor;

  const filmChapters: FilmChapter[] =
    chapters.length >= 2
      ? chapters.map((ch, i) => ({
          title: ch.subtitle && mode !== "day" ? `${ch.title} · ${ch.subtitle}` : ch.title,
          startMs: Math.round((starts[chapterStartEl.get(i) ?? 0] / FPS) * 1000),
        }))
      : [];

  // Кадр для обложки — из первого клипа, когда подпись с датой уже погасла (иначе она попадает
  // на обложку и спорит с элементами управления плеера).
  const firstClipEl = elements.findIndex((e) => e.kind === "clip");
  const firstFrames = elements[firstClipEl].frames;
  const headFrames = transitions[firstClipEl - 1]?.frames ?? 0;
  const labelFrames = elements[firstClipEl].kind === "clip" && (elements[firstClipEl] as ClipElement).label ? labelFramesFor(firstFrames) : 0;
  const intoClip = labelFrames > 0 ? Math.min(firstFrames - 12, labelFrames + 15) : Math.min(60, Math.floor(firstFrames / 2));
  const posterFrame = Math.min(totalFrames - 1, starts[firstClipEl] + Math.max(headFrames + 6, intoClip));

  return {
    W,
    H,
    barHeight,
    styleId: style.id,
    elements,
    transitions,
    starts,
    totalFrames,
    chapters: filmChapters,
    clipCount: clips.length,
    posterFrame: Math.max(0, posterFrame),
  };
}
