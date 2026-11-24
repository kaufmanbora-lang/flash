// Титры фильма: вступление, главы, финал и подписи с датой.
// Каждая строка рисуется на отдельном прозрачном слое (PNG) — ffmpeg потом проявляет слои по очереди.
// Текст рендерится настоящими шрифтами с кириллицей (Cormorant Garamond и Onest), а не drawtext.

import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createCanvas, GlobalFonts, loadImage, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type { CardTheme, LabelTheme } from "./film-styles";

const require = createRequire(import.meta.url);

const FONT = {
  serif: "FlashSerifMedium",
  serifSemi: "FlashSerifSemiBold",
  serifItalic: "FlashSerifItalic",
  sans: "FlashSansRegular",
  sansMedium: "FlashSansMedium",
  sansSemi: "FlashSansSemiBold",
} as const;
type FontName = (typeof FONT)[keyof typeof FONT];

let fontsReady = false;

function packageDir(name: string): string | null {
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    const guess = path.join(process.cwd(), "node_modules", ...name.split("/"));
    return fs.existsSync(guess) ? guess : null;
  }
}

function listTtf(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTtf(full));
    else if (entry.name.toLowerCase().endsWith(".ttf")) out.push(full);
  }
  return out;
}

export function ensureFonts(): void {
  if (fontsReady) return;
  const wanted: [FontName, string, RegExp][] = [
    [FONT.serif, "@expo-google-fonts/cormorant-garamond", /_500Medium\.ttf$/],
    [FONT.serifSemi, "@expo-google-fonts/cormorant-garamond", /_600SemiBold\.ttf$/],
    [FONT.serifItalic, "@expo-google-fonts/cormorant-garamond", /_500Medium_Italic\.ttf$/],
    [FONT.sans, "@expo-google-fonts/onest", /_400Regular\.ttf$/],
    [FONT.sansMedium, "@expo-google-fonts/onest", /_500Medium\.ttf$/],
    [FONT.sansSemi, "@expo-google-fonts/onest", /_600SemiBold\.ttf$/],
  ];
  const cache = new Map<string, string[]>();
  for (const [alias, pkg, pattern] of wanted) {
    if (!cache.has(pkg)) {
      const dir = packageDir(pkg);
      cache.set(pkg, dir ? listTtf(dir) : []);
    }
    const file = cache.get(pkg)!.find((f) => pattern.test(path.basename(f)));
    if (!file) throw new Error(`Не найден шрифт ${pkg} (${pattern}). Выполните npm install.`);
    // Шрифт читает Node и передаёт байтами: registerFromPath молча возвращает null на длинных путях
    // Windows (> 260 символов), и титры незаметно рисовались бы системным шрифтом.
    const key = GlobalFonts.register(fs.readFileSync(file), alias);
    if (!key) throw new Error(`Шрифт ${path.basename(file)} не удалось загрузить для титров.`);
  }
  fontsReady = true;
}

type Ctx = SKRSContext2D;

interface TextStyle {
  font: FontName;
  size: number;
  color: string;
  /** Межбуквенный интервал в долях кегля. */
  tracking?: number;
  shadow?: { color: string; blur: number; y: number };
}

function setFont(ctx: Ctx, style: TextStyle): void {
  ctx.font = `${Math.round(style.size)}px "${style.font}"`;
  // У Cormorant Garamond цифры по умолчанию старостильные: «30 дней» читается как «зо дней».
  ctx.fontVariantNumeric = "lining-nums";
  ctx.fillStyle = style.color;
  ctx.textBaseline = "alphabetic";
  if (style.shadow) {
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = style.shadow.blur;
    ctx.shadowOffsetY = style.shadow.y;
    ctx.shadowOffsetX = 0;
  } else {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }
}

function measure(ctx: Ctx, text: string, style: TextStyle): number {
  setFont(ctx, style);
  const tracking = (style.tracking ?? 0) * style.size;
  if (!tracking) return ctx.measureText(text).width;
  const chars = Array.from(text);
  let width = 0;
  for (const ch of chars) width += ctx.measureText(ch).width;
  return width + tracking * Math.max(0, chars.length - 1);
}

/** Рисует строку; x — левая граница, центр или правая граница в зависимости от align. */
function drawText(ctx: Ctx, text: string, x: number, y: number, style: TextStyle, align: "left" | "center" | "right"): void {
  const width = measure(ctx, text, style);
  let cursor = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
  setFont(ctx, style);
  ctx.textAlign = "left";
  const tracking = (style.tracking ?? 0) * style.size;
  if (!tracking) {
    ctx.fillText(text, cursor, y);
    return;
  }
  for (const ch of Array.from(text)) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + tracking;
  }
}

/** Переносит текст по словам, уменьшая кегль, пока он не уместится в maxLines строк. */
function fitLines(ctx: Ctx, text: string, style: TextStyle, maxWidth: number, maxLines: number, minSize: number): { lines: string[]; size: number } {
  let size = style.size;
  for (;;) {
    const current = { ...style, size };
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && measure(ctx, candidate, current) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    const widest = Math.max(0, ...lines.map((l) => measure(ctx, l, current)));
    if ((lines.length <= maxLines && widest <= maxWidth) || size <= minSize) {
      return { lines: lines.slice(0, maxLines), size };
    }
    size = Math.max(minSize, size * 0.93);
  }
}

function roundedRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function radial(ctx: Ctx, cx: number, cy: number, r: number, inner: string, outer: string, W: number, H: number): void {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

async function save(canvas: Canvas, file: string): Promise<void> {
  await fsp.writeFile(file, await canvas.encode("png"));
}

// ── Карточки: вступление, главы, финал ───────────────────────

export type CardRole = "eyebrow" | "title" | "subtitle" | "tagline" | "meta";

export interface CardLine {
  role: CardRole;
  text: string;
}

export interface CardAssets {
  /** Имена файлов внутри рабочей папки. */
  background: string;
  layers: string[];
  /** Фон — размытый кадр: ему идёт медленный наезд камеры. */
  photo: boolean;
}

async function drawBackground(ctx: Ctx, W: number, H: number, theme: CardTheme, photoFile: string | null): Promise<boolean> {
  const L = Math.max(W, H);
  ctx.fillStyle = theme.bgColor;
  ctx.fillRect(0, 0, W, H);
  let usedPhoto = false;

  if (theme.background === "milk") {
    radial(ctx, W * 0.86, H * 0.06, L * 0.62, "rgba(181,223,131,0.50)", "rgba(181,223,131,0)", W, H);
    radial(ctx, W * 0.08, H * 0.96, L * 0.58, "rgba(226,242,208,0.95)", "rgba(226,242,208,0)", W, H);
    radial(ctx, W * 0.5, H * 0.46, L * 0.42, "rgba(255,255,255,0.75)", "rgba(255,255,255,0)", W, H);
  } else if (theme.background === "photo" && photoFile) {
    try {
      const img = await loadImage(photoFile);
      const scale = Math.max(W / img.width, H / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.fillStyle = theme.overlay;
      ctx.fillRect(0, 0, W, H);
      usedPhoto = true;
    } catch {
      /* кадр не прочитался — остаётся заливка */
    }
  }
  if (!usedPhoto && theme.background !== "milk") {
    const light = theme.fade === "white";
    radial(
      ctx, W * 0.5, H * 0.42, L * 0.7,
      light ? "rgba(255,255,255,0.65)" : "rgba(255,240,214,0.10)",
      light ? "rgba(255,255,255,0)" : "rgba(255,240,214,0)",
      W, H,
    );
  }

  if (theme.decor === "blobs") {
    radial(ctx, W * 0.92, H * 0.9, L * 0.5, "rgba(181,223,131,0.62)", "rgba(181,223,131,0)", W, H);
    radial(ctx, W * 0.04, H * 0.05, L * 0.34, "rgba(226,242,208,0.95)", "rgba(226,242,208,0)", W, H);
  }

  if (theme.vignette > 0) {
    const g = ctx.createRadialGradient(W / 2, H / 2, L * 0.28, W / 2, H / 2, L * 0.78);
    const tint = theme.fade === "white" ? "92,70,44" : "0,0,0";
    g.addColorStop(0, `rgba(${tint},0)`);
    g.addColorStop(1, `rgba(${tint},${theme.vignette})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  if (theme.decor === "frame") {
    const u = Math.min(W, H) / 1080;
    ctx.strokeStyle = theme.accent;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(2, 2.5 * u);
    ctx.strokeRect(44 * u, 44 * u, W - 88 * u, H - 88 * u);
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = Math.max(1, 1.2 * u);
    ctx.strokeRect(58 * u, 58 * u, W - 116 * u, H - 116 * u);
    ctx.globalAlpha = 1;
  }
  return usedPhoto;
}

interface LaidLine {
  text: string;
  style: TextStyle;
  /** Высота строки и отступ до следующей. */
  height: number;
  gapAfter: number;
  group: number;
  rule?: boolean;
}

export async function renderCard(opts: {
  dir: string;
  name: string;
  W: number;
  H: number;
  theme: CardTheme;
  lines: CardLine[];
  /** Путь к (уже размытому) кадру для фона. */
  photo?: string | null;
}): Promise<CardAssets> {
  ensureFonts();
  const { W, H, theme } = opts;
  const u = Math.min(W, H) / 1080;
  const portrait = H > W;
  const maxWidth = W * (portrait ? 0.84 : 0.72);

  const bg = createCanvas(W, H);
  const usedPhoto = await drawBackground(bg.getContext("2d"), W, H, theme, opts.photo ?? null);
  const background = `${opts.name}_bg.png`;
  await save(bg, path.join(opts.dir, background));

  const probe = createCanvas(16, 16).getContext("2d");
  const onPhoto = usedPhoto && theme.fade === "black";
  const shadow = onPhoto ? { color: "rgba(0,0,0,0.45)", blur: 24 * u, y: 2 * u } : undefined;
  const laid: LaidLine[] = [];
  let group = -1;

  for (const line of opts.lines) {
    const text = line.text.trim();
    if (!text) continue;
    group++;
    switch (line.role) {
      case "eyebrow": {
        const style: TextStyle = { font: FONT.sansMedium, size: 30 * u, color: theme.sub, tracking: 0.32, shadow };
        const fit = fitLines(probe, text.toLocaleUpperCase(), style, maxWidth, 1, 20 * u);
        laid.push({ text: fit.lines[0], style: { ...style, size: fit.size }, height: fit.size * 1.2, gapAfter: 30 * u, group });
        break;
      }
      case "title": {
        const base = (portrait ? 118 : 108) * u;
        const style: TextStyle = {
          font: theme.titleFont === "serif" ? FONT.serif : FONT.sansSemi,
          size: theme.titleFont === "serif" ? base : base * 0.82,
          color: theme.ink,
          tracking: theme.titleFont === "serif" ? -0.005 : -0.02,
          shadow,
        };
        const fit = fitLines(probe, text, style, maxWidth, 3, 54 * u);
        fit.lines.forEach((l, i) => {
          const last = i === fit.lines.length - 1;
          laid.push({
            text: l,
            style: { ...style, size: fit.size },
            height: fit.size * 1.06,
            gapAfter: last ? 34 * u : 0,
            group,
            rule: last,
          });
        });
        break;
      }
      case "subtitle": {
        const style: TextStyle = { font: FONT.sans, size: 37 * u, color: theme.sub, tracking: 0.01, shadow };
        const fit = fitLines(probe, text, style, maxWidth, 2, 26 * u);
        fit.lines.forEach((l, i) =>
          laid.push({
            text: l,
            style: { ...style, size: fit.size },
            height: fit.size * 1.3,
            gapAfter: i === fit.lines.length - 1 ? 26 * u : 0,
            group,
          }),
        );
        break;
      }
      case "tagline": {
        const style: TextStyle = { font: FONT.serifItalic, size: 50 * u, color: theme.ink, shadow };
        const fit = fitLines(probe, text, style, maxWidth, 2, 32 * u);
        fit.lines.forEach((l, i) =>
          laid.push({
            text: l,
            style: { ...style, size: fit.size },
            height: fit.size * 1.22,
            gapAfter: i === fit.lines.length - 1 ? 26 * u : 0,
            group,
          }),
        );
        break;
      }
      default: {
        const style: TextStyle = { font: FONT.sansMedium, size: 29 * u, color: theme.sub, tracking: 0.06, shadow };
        const fit = fitLines(probe, text, style, maxWidth, 2, 22 * u);
        fit.lines.forEach((l, i) =>
          laid.push({
            text: l,
            style: { ...style, size: fit.size },
            height: fit.size * 1.35,
            gapAfter: i === fit.lines.length - 1 ? 18 * u : 0,
            group,
          }),
        );
      }
    }
  }

  const ruleSpace = 34 * u;
  const total =
    laid.reduce((s, l, i) => s + l.height + (i < laid.length - 1 ? l.gapAfter : 0) + (l.rule ? ruleSpace : 0), 0);
  let y = H * 0.485 - total / 2;

  const layers: string[] = [];
  let canvas = createCanvas(W, H);
  let ctx = canvas.getContext("2d");
  let currentGroup = laid[0]?.group ?? 0;
  const flush = async () => {
    const file = `${opts.name}_l${layers.length}.png`;
    await save(canvas, path.join(opts.dir, file));
    layers.push(file);
    canvas = createCanvas(W, H);
    ctx = canvas.getContext("2d");
  };

  for (const line of laid) {
    if (line.group !== currentGroup) {
      await flush();
      currentGroup = line.group;
    }
    // Базовая линия — примерно 0.8 высоты строки от её верха.
    drawText(ctx, line.text, W / 2, y + line.height * 0.8, line.style, "center");
    y += line.height;
    if (line.rule) {
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.fillStyle = theme.accent;
      roundedRect(ctx, W / 2 - 44 * u, y + ruleSpace * 0.55, 88 * u, Math.max(2, 3 * u), 2 * u);
      ctx.fill();
      y += ruleSpace;
    }
    y += line.gapAfter;
  }
  if (laid.length > 0) await flush();

  return { background, layers, photo: usedPhoto };
}

// ── Подписи с датой поверх видео ─────────────────────────────

export interface LabelText {
  /** «23 ноября» */
  primary: string;
  /** «Понедельник» или время «14:32» */
  secondary?: string;
  /** Числовая дата для стиля Vintage: «23.11.2026 14:32» */
  stamp: string;
}

export async function renderLabel(opts: {
  dir: string;
  name: string;
  W: number;
  H: number;
  theme: LabelTheme;
  text: LabelText;
  /** Высота чёрной полосы снизу (формат «кино»), чтобы подпись встала над ней. */
  barHeight?: number;
}): Promise<string> {
  ensureFonts();
  const { W, H, theme, text } = opts;
  const u = Math.min(W, H) / 1080;
  const portrait = H > W;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const mx = (portrait ? 64 : 84) * u;
  const bottom = H - (portrait ? 150 : 84) * u - (opts.barHeight ?? 0);
  const shadow = { color: "rgba(0,0,0,0.5)", blur: 20 * u, y: 2 * u };

  if (theme.kind === "plain") {
    const primary: TextStyle = { font: FONT.sansSemi, size: 46 * u, color: theme.color, tracking: -0.01, shadow };
    const secondary: TextStyle = { font: FONT.sans, size: 30 * u, color: "rgba(255,255,255,0.86)", shadow };
    let y = bottom;
    if (text.secondary) {
      drawText(ctx, text.secondary, mx, y, secondary, "left");
      y -= 44 * u;
    }
    drawText(ctx, text.primary, mx, y, primary, "left");
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 10 * u;
    ctx.fillStyle = "#B5DF83";
    roundedRect(ctx, mx, y - 70 * u, 46 * u, Math.max(3, 4 * u), 2 * u);
    ctx.fill();
  } else if (theme.kind === "serif") {
    const center = theme.position === "bottom-center";
    const x = center ? W / 2 : mx;
    const align = center ? "center" : "left";
    const primary: TextStyle = { font: FONT.serifSemi, size: 66 * u, color: theme.color, shadow };
    const secondary: TextStyle = {
      font: FONT.sansMedium,
      size: 24 * u,
      color: "rgba(255,255,255,0.88)",
      tracking: 0.3,
      shadow,
    };
    let y = bottom;
    drawText(ctx, text.primary, x, y, primary, align);
    if (text.secondary) {
      y -= 76 * u;
      drawText(ctx, text.secondary.toLocaleUpperCase(), x, y, secondary, align);
    }
  } else if (theme.kind === "stamp") {
    const style: TextStyle = {
      font: FONT.sansMedium,
      size: 40 * u,
      color: theme.color,
      tracking: 0.08,
      shadow: { color: "rgba(255,150,40,0.55)", blur: 14 * u, y: 0 },
    };
    drawText(ctx, text.stamp, W - mx, bottom, style, "right");
  } else {
    // «Пилюля» с матовым стеклом.
    const label = text.secondary ? `${text.primary} · ${text.secondary}` : text.primary;
    const style: TextStyle = { font: FONT.sansMedium, size: 34 * u, color: theme.color };
    const width = measure(ctx, label, style);
    const padX = 28 * u;
    const height = 72 * u;
    const x = mx;
    const y = (portrait ? 120 : 76) * u;
    ctx.shadowColor = "rgba(20,40,10,0.22)";
    ctx.shadowBlur = 26 * u;
    ctx.shadowOffsetY = 6 * u;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    roundedRect(ctx, x, y, width + padX * 2, height, height / 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = "#8BC65B";
    ctx.beginPath();
    ctx.arc(x + padX * 0.85, y + height / 2, 6 * u, 0, Math.PI * 2);
    ctx.fill();
    drawText(ctx, label, x + padX * 1.5, y + height / 2 + style.size * 0.35, style, "left");
  }

  const file = `${opts.name}.png`;
  await save(canvas, path.join(opts.dir, file));
  return file;
}

// ── Обложка проекта ──────────────────────────────────────────

/** Собирает обложку проекта из одного или нескольких кадров (JPEG 1600×1000). */
export async function renderCover(frames: string[], outFile: string): Promise<void> {
  const W = 1600;
  const H = 1000;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#F8FAF5";
  ctx.fillRect(0, 0, W, H);

  const images: Image[] = [];
  for (const file of frames.slice(0, 3)) {
    try {
      images.push(await loadImage(file));
    } catch {
      /* пропускаем нечитаемый кадр */
    }
  }
  if (images.length === 0) throw new Error("Нет кадров для обложки");

  const cover = (img: Image, x: number, y: number, w: number, h: number) => {
    const scale = Math.max(w / img.width, h / img.height);
    const sw = w / scale;
    const sh = h / scale;
    ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
  };

  const portraitMajority = images.filter((i) => i.height > i.width).length * 2 >= images.length;
  const gap = 8;

  if (images.length === 1) {
    const img = images[0];
    if (img.height > img.width) {
      // Вертикальный кадр: мягкий фон из него же и сам кадр по центру.
      ctx.globalAlpha = 0.9;
      cover(img, -W * 0.1, -H * 0.1, W * 1.2, H * 1.2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(248,250,245,0.55)";
      ctx.fillRect(0, 0, W, H);
      const h = H * 0.92;
      const w = (h * img.width) / img.height;
      ctx.shadowColor = "rgba(30,50,20,0.28)";
      ctx.shadowBlur = 48;
      ctx.shadowOffsetY = 14;
      ctx.save();
      roundedRect(ctx, (W - w) / 2, (H - h) / 2, w, h, 36);
      ctx.fill();
      ctx.restore();
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.save();
      roundedRect(ctx, (W - w) / 2, (H - h) / 2, w, h, 36);
      ctx.clip();
      cover(img, (W - w) / 2, (H - h) / 2, w, h);
      ctx.restore();
    } else {
      cover(img, 0, 0, W, H);
    }
  } else if (portraitMajority) {
    // Вертикальные полосы, как кадры на плёнке.
    const n = images.length;
    const w = (W - gap * (n - 1)) / n;
    images.forEach((img, i) => cover(img, i * (w + gap), 0, w, H));
  } else if (images.length === 2) {
    const w = (W - gap) / 2;
    cover(images[0], 0, 0, w, H);
    cover(images[1], w + gap, 0, w, H);
  } else {
    const left = Math.round(W * 0.62);
    const h = (H - gap) / 2;
    cover(images[0], 0, 0, left, H);
    cover(images[1], left + gap, 0, W - left - gap, h);
    cover(images[2], left + gap, h + gap, W - left - gap, h);
  }

  await fsp.writeFile(outFile, await canvas.encode("jpeg", 88));
}
