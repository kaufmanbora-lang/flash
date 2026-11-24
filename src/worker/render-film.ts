// Автоматический монтаж фильма настоящим FFmpeg.
//
// Схема, которая одинаково работает для 3 и для 3000 моментов (память не растёт с числом клипов):
//   1. Каждый элемент фильма (вступление, глава, клип, финал) приводится к общему формату
//      (кадр W×H, 30 к/с, H.264 + PCM 48 кГц) и сразу режется на «голову», «тело» и «хвост».
//   2. Переход между соседними элементами — отдельный короткий файл: xfade хвоста и головы.
//   3. Тела и переходы склеиваются без перекодирования (concat), поверх накладывается музыка
//      с автоматическим приглушением под речь (sidechaincompress), звук кодируется в AAC.
// Длительности считаются в кадрах, а звук — в сэмплах (1600 на кадр), поэтому рассинхрон не копится.
// Исходные видео только читаются.

import fs from "node:fs/promises";
import path from "node:path";
import { getDict } from "@/i18n";
import { VARIANT_TARGETS, type FilmStyleId } from "@/lib/constants";
import { addDays, diffDays, parseYmd, startOfWeek, type Ymd } from "@/lib/dates";
import { exec, q, q1 } from "@/lib/db";
import { env } from "@/lib/env";
import { filmMoments } from "@/lib/film-service";
import { capitalize, fmtDayMonth, fmtFullDate, fmtMonthYear, fmtRange, fmtWeekday } from "@/lib/format";
import { selectSegments, type Segment } from "@/lib/highlights";
import { sendPush } from "@/lib/push";
import { resolveSettings } from "@/lib/settings";
import { keys, storage, type StorageDriver } from "@/lib/storage";
import type { FilmChapter, FilmRow, MomentRow, ProjectRow, UserRow } from "@/lib/types";
import { even, ffmpeg, probe, tonemapFilter } from "./ffmpeg";
import {
  FPS,
  SAMPLE_RATE,
  SAMPLES_PER_FRAME,
  STYLE_ROTATION,
  STYLES,
  type FilmStyle,
  type Transition,
} from "./film-styles";
import { MUSIC_CROSSFADE_SEC, pickMusic } from "./music";
import { trackPath } from "@/lib/music-library";
import { renderCard, renderLabel, type CardAssets, type CardLine, type LabelText } from "./titles";
import { makeWorkDir, PermanentError, removeWorkDir } from "./workdir";

/** Подпись с датой показывается на клипах не короче LABEL_MIN_CLIP кадров и держится не дольше LABEL_MAX. */
const LABEL_MIN_CLIP = 54;
const LABEL_MAX = 96;
const LABEL_TAIL_GAP = 15;
const labelFramesFor = (clipFrames: number): number => (clipFrames >= LABEL_MIN_CLIP ? Math.min(LABEL_MAX, clipFrames - LABEL_TAIL_GAP) : 0);

/** Фильм запросили пересобрать или удалили, пока шёл монтаж: текущую работу нужно бросить. */
export class SupersededError extends Error {
  constructor() {
    super("superseded");
    this.name = "SupersededError";
  }
}

interface ClipPlan {
  moment: MomentRow;
  start: number;
  frames: number;
  /** Первый клип нового календарного дня. */
  dayStart: boolean;
  chapter: number;
}

interface CardElement {
  kind: "card";
  role: "intro" | "outro" | "chapter";
  frames: number;
  lines: CardLine[];
  /** Момент, кадр которого станет размытым фоном карточки. */
  photoOf: MomentRow | null;
}

interface ClipElement {
  kind: "clip";
  frames: number;
  clip: ClipPlan;
  label: LabelText | null;
}

type Element = CardElement | ClipElement;

interface ChapterGroup {
  title: string;
  subtitle: string;
}

interface RenderContext {
  dir: string;
  store: StorageDriver;
  W: number;
  H: number;
  style: FilmStyle;
  level: string;
  barHeight: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const sec = (frames: number) => (frames / FPS).toFixed(4).replace(/\.?0+$/, "") || "0";

function encodeArgs(ctx: RenderContext): string[] {
  // Постоянное качество (CRF) с потолком битрейта: зернистые и очень подвижные сцены иначе раздувают
  // файл в разы, а фильм должен оставаться удобным для отправки. ≈4 Мбит/с для 720p, ≈9 Мбит/с для 1080p.
  const maxrate = Math.round(Math.min(16_000_000, Math.max(2_500_000, ctx.W * ctx.H * FPS * 0.145)) / 1000);
  return [
    "-c:v", "libx264",
    "-preset", env.filmPreset,
    "-crf", String(env.filmCrf),
    "-maxrate", `${maxrate}k`,
    "-bufsize", `${maxrate * 2}k`,
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level:v", ctx.level,
    "-r", String(FPS),
    "-g", String(FPS * 2),
    "-bf", "0",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-video_track_timescale", "30000",
    "-c:a", "pcm_s16le", "-ar", String(SAMPLE_RATE), "-ac", "2",
    "-f", "mov",
  ];
}

interface PartSpec {
  key: "h" | "b" | "t";
  from: number;
  to: number;
}

function partSpecs(frames: number, head: number, tail: number): PartSpec[] {
  const out: PartSpec[] = [];
  if (head > 0) out.push({ key: "h", from: 0, to: head });
  out.push({ key: "b", from: head, to: frames - tail });
  if (tail > 0) out.push({ key: "t", from: frames - tail, to: frames });
  return out;
}

/** Делит готовые потоки [vfull] и [afull] на части с точностью до кадра и сэмпла. */
function splitGraph(parts: PartSpec[]): string[] {
  if (parts.length === 1) return ["[vfull]null[v_b]", "[afull]anull[a_b]"];
  const g: string[] = [];
  g.push(`[vfull]split=${parts.length}${parts.map((p) => `[vs_${p.key}]`).join("")}`);
  g.push(`[afull]asplit=${parts.length}${parts.map((p) => `[as_${p.key}]`).join("")}`);
  for (const p of parts) {
    g.push(`[vs_${p.key}]trim=start_frame=${p.from}:end_frame=${p.to},setpts=PTS-STARTPTS[v_${p.key}]`);
    g.push(
      `[as_${p.key}]atrim=start_sample=${p.from * SAMPLES_PER_FRAME}:end_sample=${p.to * SAMPLES_PER_FRAME},asetpts=PTS-STARTPTS[a_${p.key}]`,
    );
  }
  return g;
}

function outputArgs(ctx: RenderContext, index: number, parts: PartSpec[]): string[] {
  const args: string[] = [];
  for (const p of parts) {
    args.push("-map", `[v_${p.key}]`, "-map", `[a_${p.key}]`, ...encodeArgs(ctx), `e${index}_${p.key}.mov`);
  }
  return args;
}

// ── Клип ─────────────────────────────────────────────────────

async function renderClip(ctx: RenderContext, index: number, el: ClipElement, head: number, tail: number): Promise<void> {
  const m = el.clip.moment;
  if (!m.original_key) throw new PermanentError("source_missing");
  const src = path.join(ctx.dir, `src_${index}.${m.ext}`);
  await ctx.store.downloadToFile(m.original_key, src);
  try {
    const info = await probe(src);
    if (!info.hasVideo) throw new PermanentError("source_unreadable");
    const { W, H } = ctx;
    const N = el.frames;
    const readSec = (N / FPS + 1.5).toFixed(3);

    const args: string[] = [];
    if (el.clip.start > 0.01) args.push("-ss", el.clip.start.toFixed(3));
    args.push("-t", readSec, "-i", src);
    let nextInput = 1;

    let labelInput = -1;
    let labelFrames = 0;
    if (el.label && labelFramesFor(N) > 0) {
      labelFrames = labelFramesFor(N);
      const file = await renderLabel({
        dir: ctx.dir,
        name: `label_${index}`,
        W,
        H,
        theme: ctx.style.label,
        text: el.label,
        barHeight: ctx.barHeight,
      });
      args.push("-loop", "1", "-framerate", String(FPS), "-t", (labelFrames / FPS + 0.3).toFixed(3), "-i", file);
      labelInput = nextInput++;
    }
    let silentInput = -1;
    if (!info.hasAudio) {
      args.push("-f", "lavfi", "-t", readSec, "-i", `anullsrc=r=${SAMPLE_RATE}:cl=stereo`);
      silentInput = nextInput++;
    }

    const g: string[] = [];
    const pre: string[] = [];
    const tonemap = await tonemapFilter(info);
    if (tonemap) {
      // HDR сначала уменьшается, потом переводится в SDR — так заметно быстрее.
      const L = Math.max(W, H);
      pre.push(`scale=w='min(iw,${L})':h='min(ih,${L})':force_original_aspect_ratio=decrease:force_divisible_by=2`, tonemap);
    }
    pre.push(`fps=${FPS}:start_time=0`, "setsar=1");

    const srcAspect = info.width / info.height;
    const dstAspect = W / H;
    if (Math.abs(srcAspect / dstAspect - 1) < 0.07) {
      g.push(`[0:v]${pre.join(",")},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},format=yuv420p[fit]`);
    } else {
      // Кадр другой ориентации: вписываем целиком, а поля заполняем его же размытой копией.
      const bw = even(W / 8);
      const bh = even(H / 8);
      g.push(`[0:v]${pre.join(",")},split=2[bgsrc][fgsrc]`);
      g.push(
        `[bgsrc]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=5,` +
          `scale=${W}:${H}:flags=bicubic,eq=brightness=-0.07:saturation=1.12[bg]`,
      );
      g.push(`[fgsrc]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos[fg]`);
      g.push(`[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2,format=yuv420p[fit]`);
    }

    const look: string[] = [];
    if (ctx.style.grade) look.push(ctx.style.grade);
    if (ctx.barHeight > 0) {
      look.push(
        `drawbox=x=0:y=0:w=iw:h=${ctx.barHeight}:color=black:t=fill`,
        `drawbox=x=0:y=ih-${ctx.barHeight}:w=iw:h=${ctx.barHeight}:color=black:t=fill`,
      );
    }
    g.push(`[fit]${look.length ? look.join(",") : "null"}[graded]`);

    let last = "[graded]";
    if (labelInput >= 0) {
      const dur = labelFrames / FPS;
      g.push(
        `[${labelInput}:v]format=rgba,fade=t=in:st=0.35:d=0.5:alpha=1,fade=t=out:st=${(dur - 0.6).toFixed(3)}:d=0.55:alpha=1[label]`,
      );
      g.push(`[graded][label]overlay=x=0:y=0:eof_action=pass:format=auto[labeled]`);
      last = "[labeled]";
    }
    g.push(`${last}tpad=stop_mode=clone:stop_duration=3,trim=end_frame=${N},setpts=PTS-STARTPTS,format=yuv420p[vfull]`);

    const audioEnd = N * SAMPLES_PER_FRAME;
    if (silentInput >= 0) {
      g.push(`[${silentInput}:a]atrim=end_sample=${audioEnd},asetpts=PTS-STARTPTS[afull]`);
    } else {
      g.push(
        `[0:a]aresample=${SAMPLE_RATE}:async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=stereo,` +
          `apad,atrim=end_sample=${audioEnd},asetpts=PTS-STARTPTS[afull]`,
      );
    }

    const parts = partSpecs(N, head, tail);
    g.push(...splitGraph(parts));
    await ffmpeg([...args, "-filter_complex", g.join(";"), ...outputArgs(ctx, index, parts)], { cwd: ctx.dir });
  } finally {
    await fs.rm(src, { force: true });
  }
}

// ── Карточка (вступление, глава, финал) ──────────────────────

async function cardPhoto(ctx: RenderContext, index: number, moment: MomentRow | null): Promise<string | null> {
  if (!moment?.poster_key || ctx.style.card.background !== "photo") return null;
  const poster = path.join(ctx.dir, `poster_${index}.jpg`);
  try {
    await ctx.store.downloadToFile(moment.poster_key, poster);
    const bw = even(ctx.W / 3);
    const bh = even(ctx.H / 3);
    const out = `cardphoto_${index}.jpg`;
    await ffmpeg(
      [
        "-i", poster,
        "-vf", `scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=14`,
        "-frames:v", "1", "-update", "1", "-q:v", "4",
        out,
      ],
      { cwd: ctx.dir },
    );
    return path.join(ctx.dir, out);
  } catch {
    return null;
  } finally {
    await fs.rm(poster, { force: true });
  }
}

async function renderCardElement(ctx: RenderContext, index: number, el: CardElement, head: number, tail: number): Promise<void> {
  const { W, H } = ctx;
  const N = el.frames;
  const photo = await cardPhoto(ctx, index, el.photoOf);
  const assets: CardAssets = await renderCard({
    dir: ctx.dir,
    name: `card_${index}`,
    W,
    H,
    theme: ctx.style.card,
    lines: el.lines,
    photo,
  });

  const loopSec = (N / FPS + 0.5).toFixed(3);
  const args: string[] = ["-loop", "1", "-framerate", String(FPS), "-t", loopSec, "-i", assets.background];
  for (const layer of assets.layers) args.push("-loop", "1", "-framerate", String(FPS), "-t", loopSec, "-i", layer);
  args.push("-f", "lavfi", "-t", loopSec, "-i", `anullsrc=r=${SAMPLE_RATE}:cl=stereo`);
  const audioInput = assets.layers.length + 1;

  const g: string[] = [];
  const grain = ctx.style.id === "vintage" ? ",noise=alls=7:allf=t+u" : "";
  if (assets.photo) {
    // Медленный наезд на размытый кадр; увеличенный исходник убирает дрожание zoompan.
    const up = Math.min(W, H) <= 1080 ? 1.5 : 1;
    g.push(
      `[0:v]scale=${even(W * up)}:${even(H * up)}:flags=bicubic,` +
        `zoompan=z='1+0.05*on/${N}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},` +
        `setsar=1,format=yuv420p${grain}[c0]`,
    );
  } else {
    g.push(`[0:v]fps=${FPS},scale=${W}:${H},setsar=1,format=yuv420p${grain}[c0]`);
  }

  const quick = el.role === "chapter";
  const rise = Math.round((Math.min(W, H) / 1080) * 18);
  assets.layers.forEach((_, i) => {
    const k = i + 1;
    const delay = quick ? 0.12 + 0.16 * i : 0.3 + 0.38 * i;
    const fade = quick ? 0.4 : 0.7;
    g.push(`[${k}:v]format=rgba,fade=t=in:st=${delay.toFixed(2)}:d=${fade}:alpha=1[l${k}]`);
    g.push(
      `[c${i}][l${k}]overlay=x=0:y='${rise}*pow(1-min(1,max(0,(t-${delay.toFixed(2)})/${(fade + 0.3).toFixed(2)})),2)':format=auto[c${k}]`,
    );
  });

  const fades: string[] = [];
  const color = ctx.style.card.fade;
  if (el.role === "intro") fades.push(`fade=t=in:st=0:d=0.5:color=${color}`);
  if (el.role === "outro") fades.push(`fade=t=out:st=${((N - 24) / FPS).toFixed(3)}:d=0.8:color=${color}`);
  g.push(
    `[c${assets.layers.length}]${fades.length ? fades.join(",") + "," : ""}` +
      `tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${N},setpts=PTS-STARTPTS,format=yuv420p[vfull]`,
  );
  g.push(`[${audioInput}:a]atrim=end_sample=${N * SAMPLES_PER_FRAME},asetpts=PTS-STARTPTS[afull]`);

  const parts = partSpecs(N, head, tail);
  g.push(...splitGraph(parts));
  await ffmpeg([...args, "-filter_complex", g.join(";"), ...outputArgs(ctx, index, parts)], { cwd: ctx.dir });
}

// ── Переход ──────────────────────────────────────────────────

async function renderTransition(ctx: RenderContext, index: number, tr: Transition): Promise<void> {
  const T = sec(tr.frames);
  const graph =
    `[0:v][1:v]xfade=transition=${tr.type}:duration=${T}:offset=0,tpad=stop_mode=clone:stop_duration=1,` +
    `trim=end_frame=${tr.frames},setpts=PTS-STARTPTS,format=yuv420p[v];` +
    `[0:a][1:a]acrossfade=d=${T}:c1=qsin:c2=qsin,apad,atrim=end_sample=${tr.frames * SAMPLES_PER_FRAME},asetpts=PTS-STARTPTS[a]`;
  await ffmpeg(
    [
      "-i", `e${index}_t.mov`,
      "-i", `e${index + 1}_h.mov`,
      "-filter_complex", graph,
      "-map", "[v]", "-map", "[a]",
      ...encodeArgs(ctx),
      `x${index}.mov`,
    ],
    { cwd: ctx.dir },
  );
}

// ── Планирование ─────────────────────────────────────────────

async function pickStyle(film: FilmRow): Promise<FilmStyleId> {
  if (film.style !== "auto") return film.style;
  const rows = await q<{ style_used: FilmStyleId | null }>(
    `SELECT style_used FROM films
     WHERE user_id = $1 AND id <> $2 AND style_used IS NOT NULL AND rendered_at IS NOT NULL
     ORDER BY rendered_at DESC LIMIT 12`,
    [film.user_id, film.id],
  );
  const recent = rows.map((r) => r.style_used!);
  const unused = STYLE_ROTATION.find((s) => !recent.includes(s));
  if (unused) return unused;
  // Все стили уже были — берём тот, что использовался раньше всех.
  return STYLE_ROTATION.reduce((best, s) => (recent.indexOf(s) > recent.indexOf(best) ? s : best), STYLE_ROTATION[0]);
}

function chooseCanvas(film: FilmRow, moments: MomentRow[]): { W: number; H: number; level: string } {
  let portraitMs = 0;
  let totalMs = 0;
  let maxShort = 0;
  for (const m of moments) {
    totalMs += m.duration_ms;
    if (m.height > m.width) portraitMs += m.duration_ms;
    maxShort = Math.max(maxShort, Math.min(m.width, m.height));
  }
  const portrait =
    film.orientation === "auto" ? portraitMs * 2 >= totalMs : film.orientation === "portrait";
  const requested = film.resolution === "auto" ? 1080 : Number(film.resolution);
  // Не выше запрошенного и не выше того, что позволяет исходное видео (но не ниже 720p).
  let short = 720;
  for (const tier of [720, 1080, 1440, 2160]) {
    if (tier <= requested && tier <= Math.max(720, maxShort)) short = tier;
  }
  const long = even((short * 16) / 9);
  const level = short <= 720 ? "3.1" : short <= 1080 ? "4.1" : short <= 1440 ? "5.0" : "5.1";
  return portrait ? { W: short, H: long, level } : { W: long, H: short, level };
}

type ChapterMode = "day" | "week" | "month";

function chapterKey(mode: ChapterMode, date: Ymd, origin: Ymd): string {
  if (mode === "day") return date;
  if (mode === "month") return date.slice(0, 7);
  return String(Math.floor(diffDays(startOfWeek(date), startOfWeek(origin)) / 7));
}

export async function renderFilm(filmId: string, revision: number, heartbeat: () => Promise<void>): Promise<void> {
  const started = await q1<FilmRow>(
    `UPDATE films SET status = 'rendering', progress = 0.01, stage = 'prepare', error = NULL, stale = false, updated_at = now()
     WHERE id = $1 AND revision = $2 RETURNING *`,
    [filmId, revision],
  );
  if (!started) return; // устаревшая задача: фильм удалён или запрошена новая сборка
  const film = started;
  const user = await q1<UserRow>(`SELECT * FROM users WHERE id = $1`, [film.user_id]);
  if (!user) return;
  const project = film.project_id
    ? await q1<ProjectRow>(`SELECT * FROM projects WHERE id = $1`, [film.project_id])
    : null;
  const dict = getDict(user.locale);
  const t = dict.film;
  const locale = user.locale;

  let lastReport = 0;
  let lastStage = "";
  const report = async (progress: number, stage: string, force = false) => {
    const now = Date.now();
    if (!force && stage === lastStage && now - lastReport < 900) return;
    lastReport = now;
    lastStage = stage;
    const n = await exec(
      `UPDATE films SET progress = $2, stage = $3, updated_at = now() WHERE id = $1 AND revision = $4`,
      [filmId, Math.min(0.99, Math.max(0.01, progress)), stage, revision],
    );
    if (n === 0) throw new SupersededError();
    await heartbeat();
  };

  const moments = await filmMoments(film);
  if (moments.length === 0) throw new PermanentError("no_moments");

  // 1. Какие отрезки каких моментов войдут в фильм.
  const inputs = moments.map((m) => ({ id: m.id, durationSec: m.duration_ms / 1000, analysis: m.analysis }));
  const totalFootage = inputs.reduce((s, c) => s + c.durationSec, 0);
  let segments: Segment[];
  if (film.variant === "full") {
    segments = inputs.map((c) => ({ id: c.id, start: 0, duration: c.durationSec }));
  } else {
    const cfg = VARIANT_TARGETS[film.variant];
    const target =
      film.variant === "highlights" ? Math.min(150, Math.max(24, totalFootage * 0.35)) : cfg.target;
    segments = selectSegments(inputs, { target, minSeg: cfg.minSeg, maxSeg: cfg.maxSeg });
  }
  const byId = new Map(moments.map((m) => [m.id, m]));
  const trailer = film.variant === "trailer";

  // 2. Стиль, размер кадра, главы.
  const style = STYLES[await pickStyle(film)];
  const canvas = chooseCanvas(film, moments);
  const { W, H } = canvas;
  const barHeight = style.letterbox && W > H ? even((H - W / 2.39) / 2) : 0;

  const firstDay = moments[0].local_date;
  const lastDay = moments[moments.length - 1].local_date;
  const dayList = [...new Set(segments.map((s) => byId.get(s.id)!.local_date))];
  const multiDay = dayList.length > 1;
  const spanDays = diffDays(lastDay, firstDay) + 1;
  const mode: ChapterMode = spanDays <= 10 ? "day" : spanDays <= 70 ? "week" : "month";
  const origin = project?.start_date && project.start_date <= firstDay ? project.start_date : firstDay;

  const chapters: ChapterGroup[] = [];
  const chapterIndex = new Map<string, number>();
  const clips: ClipPlan[] = [];
  let prevDate: Ymd | null = null;
  for (const seg of segments) {
    const moment = byId.get(seg.id)!;
    const date = moment.local_date;
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
      moment,
      start: seg.start,
      frames: Math.max(45, Math.floor(seg.duration * FPS)),
      dayStart: date !== prevDate,
      chapter: chapterIndex.get(key)!,
    });
    prevDate = date;
  }
  const clipSeconds = clips.reduce((s, c) => s + c.frames, 0) / FPS;
  // Карточки глав — только для длинных фильмов; в коротких хватает подписей с датой.
  const chapterCards = multiDay && chapters.length >= 2 && clipSeconds >= 300 && !trailer;

  // 3. Музыка.
  const settings = resolveSettings(user.settings);
  const wantMusic = film.music !== "none" && film.music_volume > 0.01;

  // 4. Линия времени.
  const statsLine = t.statsLine(clips.length, Math.round(clipSeconds * 1000));
  const rangeText = fmtRange(project?.start_date ?? firstDay, project?.end_date ?? lastDay, locale);
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
      { role: "title", text: fmtFullDate(film.date_from, locale) },
      { role: "subtitle", text: capitalize(fmtWeekday(film.date_from, locale)) },
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
      { role: "meta", text: trailer ? "" : t.credits.by(user.name) },
    );
  } else {
    outroLines.push(
      { role: "title", text: film.kind === "day" ? t.outro.day : t.outro.period },
      { role: "meta", text: statsLine },
    );
  }

  const introFrames = trailer ? 75 : film.kind === "project" ? 132 : 108;
  const outroFrames = trailer ? 72 : film.kind === "project" ? 156 : 108;

  const elements: Element[] = [];
  /** Индекс элемента, с которого начинается каждая глава (для оглавления плеера). */
  const chapterStartEl = new Map<number, number>();
  elements.push({ kind: "card", role: "intro", frames: introFrames, lines: introLines, photoOf: clips[0].moment });
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
          photoOf: clip.moment,
        });
        afterChapterCard = mode === "day";
      }
    }
    const date = clip.moment.local_date;
    const { y, m, d } = parseYmd(date);
    const stamp = `${pad2(d)}.${pad2(m)}.${y}  ${clip.moment.local_time}`;
    let label: LabelText | null = null;
    if (!multiDay) {
      label = { primary: clip.moment.local_time, stamp };
    } else if (clip.dayStart && !afterChapterCard) {
      label = { primary: fmtDayMonth(date, locale), secondary: capitalize(fmtWeekday(date, locale)), stamp };
    }
    elements.push({ kind: "clip", frames: clip.frames, clip, label });
  }
  elements.push({
    kind: "card",
    role: "outro",
    frames: outroFrames,
    lines: outroLines,
    photoOf: clips[clips.length - 1].moment,
  });

  // 5. Переходы между соседними элементами.
  const transitions: Transition[] = [];
  for (let i = 0; i < elements.length - 1; i++) {
    const a = elements[i];
    const b = elements[i + 1];
    const sameDay =
      a.kind === "clip" && b.kind === "clip" && a.clip.moment.local_date === b.clip.moment.local_date;
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

  const totalFrames =
    elements.reduce((s, e) => s + e.frames, 0) - transitions.reduce((s, tr) => s + tr.frames, 0);
  const totalSec = totalFrames / FPS;

  const playlist = wantMusic ? await pickMusic(film.user_id, film.id, film.music, totalSec) : [];

  const dir = await makeWorkDir("film");
  const store = await storage();
  const ctx: RenderContext = { dir, store, W, H, style, level: canvas.level, barHeight };
  const uploaded: string[] = [];
  try {
    // 6. Элементы: каждый — отдельный запуск ffmpeg.
    const work = elements.reduce((s, e) => s + (e.kind === "clip" ? e.frames : e.frames * 0.4), 0);
    let done = 0;
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      await report(0.04 + 0.78 * (done / work), "clips");
      const head = i > 0 ? transitions[i - 1].frames : 0;
      const tail = i < transitions.length ? transitions[i].frames : 0;
      if (el.kind === "clip") await renderClip(ctx, i, el, head, tail);
      else await renderCardElement(ctx, i, el, head, tail);
      done += el.kind === "clip" ? el.frames : el.frames * 0.4;
    }

    // 7. Переходы.
    for (let i = 0; i < transitions.length; i++) {
      await report(0.82 + 0.08 * (i / transitions.length), "transitions");
      await renderTransition(ctx, i, transitions[i]);
      await fs.rm(path.join(dir, `e${i}_t.mov`), { force: true });
      await fs.rm(path.join(dir, `e${i + 1}_h.mov`), { force: true });
    }

    // 8. Склейка без перекодирования + музыка с приглушением под речь.
    const list = ["ffconcat version 1.0"];
    for (let i = 0; i < elements.length; i++) {
      list.push(`file 'e${i}_b.mov'`);
      if (i < transitions.length) list.push(`file 'x${i}.mov'`);
    }
    await fs.writeFile(path.join(dir, "list.txt"), list.join("\n") + "\n", "utf8");

    await report(0.9, "music", true);
    const mixArgs: string[] = ["-f", "concat", "-safe", "0", "-i", "list.txt"];
    for (const track of playlist) mixArgs.push("-i", trackPath(track));

    const fmt = `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`;
    const ag: string[] = [];
    const endFade = Math.max(0, totalSec - 1.2).toFixed(3);
    if (playlist.length === 0) {
      ag.push(`[0:a]${fmt},afade=t=out:st=${endFade}:d=1.2[aout]`);
    } else {
      playlist.forEach((_, i) => ag.push(`[${i + 1}:a]${fmt}[m${i}]`));
      let bed = "[m0]";
      for (let i = 1; i < playlist.length; i++) {
        ag.push(`${bed}[m${i}]acrossfade=d=${MUSIC_CROSSFADE_SEC}:c1=tri:c2=tri[mx${i}]`);
        bed = `[mx${i}]`;
      }
      // Громкость 0…1 из настроек → усиление; 0.5 даёт спокойный фон.
      const gain = (1.2 * Math.pow(film.music_volume, 1.5)).toFixed(3);
      const musicOut = Math.max(0, totalSec - 3.4).toFixed(3);
      ag.push(
        `${bed}apad,atrim=0:${totalSec.toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain},` +
          `afade=t=in:st=0:d=1.4,afade=t=out:st=${musicOut}:d=3.4[music]`,
      );
      ag.push(`[0:a]${fmt},asplit=2[orig][scraw]`);
      // Детектор слушает диапазон голоса: музыка уступает речи и заметным звукам, а не фоновому шуму.
      ag.push(`[scraw]highpass=f=160,lowpass=f=4500[sc]`);
      ag.push(
        `[music][sc]sidechaincompress=threshold=0.016:ratio=4:attack=40:release=1000:knee=6:detection=rms[ducked]`,
      );
      ag.push(
        `[orig][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,` +
          `alimiter=limit=0.95:level=0:attack=5:release=80,afade=t=out:st=${endFade}:d=1.2[aout]`,
      );
    }

    await ffmpeg(
      [
        ...mixArgs,
        "-filter_complex", ag.join(";"),
        "-map", "0:v:0", "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k", "-ar", String(SAMPLE_RATE), "-ac", "2",
        "-t", totalSec.toFixed(3),
        "-movflags", "+faststart",
        "-video_track_timescale", "30000",
        "-metadata", `title=${film.title}`,
        "-f", "mp4",
        "film.mp4",
      ],
      {
        cwd: dir,
        onProgress: (s) => {
          void report(0.9 + 0.07 * Math.min(1, s / totalSec), "music").catch(() => {});
        },
      },
    );

    // 9. Проверка результата, обложка, загрузка в хранилище.
    await report(0.97, "saving", true);
    const outFile = path.join(dir, "film.mp4");
    const result = await probe(outFile);
    if (!result.hasVideo || result.durationSec < 1) throw new Error("FFmpeg вернул пустой файл");

    // Кадр для обложки — из первого клипа, когда подпись с датой уже погасла (иначе она попадает
    // на обложку и спорит с элементами управления плеера).
    const introEnd = (elements[0].frames - (transitions[0]?.frames ?? 0)) / FPS;
    const firstSec = clips[0].frames / FPS;
    const labelSec = labelFramesFor(clips[0].frames) / FPS;
    const intoClip = labelSec > 0 ? Math.min(firstSec - 0.4, labelSec + 0.5) : Math.min(2, firstSec / 2);
    const posterAt = Math.min(result.durationSec - 0.2, introEnd + Math.max(0.2, intoClip));
    await ffmpeg(
      [
        "-ss", posterAt.toFixed(2), "-i", outFile,
        "-frames:v", "1", "-update", "1",
        "-vf", "scale=w='min(1280,iw)':h=-2:flags=lanczos",
        "-q:v", "3", "poster.jpg",
      ],
      { cwd: dir },
    );

    const fileKey = keys.film(film.user_id, film.id, revision);
    const posterKey = keys.filmPoster(film.user_id, film.id, revision);
    const size = await store.putFile(fileKey, outFile, "video/mp4");
    uploaded.push(fileKey);
    const posterSize = await store.putFile(posterKey, path.join(dir, "poster.jpg"), "image/jpeg");
    uploaded.push(posterKey);

    // Оглавление для плеера.
    const elementStart: number[] = [];
    let cursor = 0;
    for (let i = 0; i < elements.length; i++) {
      elementStart.push(cursor);
      cursor += elements[i].frames - (i < transitions.length ? transitions[i].frames : 0);
    }
    const filmChapters: FilmChapter[] =
      chapters.length >= 2
        ? chapters.map((ch, i) => ({
            title: ch.subtitle && mode !== "day" ? `${ch.title} · ${ch.subtitle}` : ch.title,
            startMs: Math.round((elementStart[chapterStartEl.get(i) ?? 0] / FPS) * 1000),
          }))
        : [];

    const saved = await exec(
      `UPDATE films
       SET status = 'ready', progress = 1, stage = '', error = NULL,
           file_key = $3, poster_key = $4, poster_size = $5, size_bytes = $6, duration_ms = $7,
           width = $8, height = $9, moments_count = $10, chapters = $11::jsonb,
           style_used = $12, music_used = $13::jsonb, rendered_at = now(), updated_at = now()
       WHERE id = $1 AND revision = $2`,
      [
        film.id,
        revision,
        fileKey,
        posterKey,
        posterSize,
        size,
        Math.round(result.durationSec * 1000),
        W,
        H,
        clips.length,
        JSON.stringify(filmChapters),
        style.id,
        JSON.stringify(playlist.map((p) => p.id)),
      ],
    );
    if (saved === 0) throw new SupersededError();
    uploaded.length = 0;

    // Предыдущая версия файла больше не нужна.
    for (const old of [film.file_key, film.poster_key]) {
      if (old && old !== fileKey && old !== posterKey) await store.delete(old).catch(() => {});
    }

    if (settings.notifications.enabled) {
      const p = dict.push;
      const payload =
        film.kind === "project"
          ? { title: p.projectFilmReadyTitle, body: p.projectFilmReady }
          : film.kind === "day" && film.auto
            ? { title: p.dailyFilmReadyTitle, body: p.dailyFilmReady(fmtDayMonth(film.date_from, locale)) }
            : { title: p.filmReadyTitle, body: p.filmReady(film.title) };
      await sendPush(
        film.user_id,
        { ...payload, url: `/films/${film.id}`, kind: "film_ready", tag: `film-${film.id}` },
        { dedupeKey: `film:${film.id}:${revision}`, ttlSec: 12 * 3600 },
      ).catch((err) => console.warn("[film] уведомление не отправлено:", (err as Error).message));
    }
  } catch (err) {
    // Если результат уже загружен, но не сохранён в базе, файлы не должны остаться сиротами.
    for (const key of uploaded) await store.delete(key).catch(() => {});
    throw err;
  } finally {
    await removeWorkDir(dir);
  }
}

/** Фиксирует окончательную неудачу монтажа. Если у фильма есть прошлая версия, она остаётся доступной. */
export async function failFilm(filmId: string, revision: number, message: string): Promise<void> {
  await exec(
    `UPDATE films
     SET status = CASE WHEN file_key IS NOT NULL THEN 'ready' ELSE 'failed' END,
         error = $3, stage = '', progress = 0, updated_at = now()
     WHERE id = $1 AND revision = $2`,
    [filmId, revision, message.slice(0, 500)],
  );
}
