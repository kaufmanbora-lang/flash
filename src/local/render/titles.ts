// Титры фильма: вступление, главы, финал и подписи с датой. Рисуются на canvas теми же шрифтами,
// что и интерфейс (Cormorant Garamond и Onest с кириллицей).

import type { CardLine, LabelText } from "./plan";
import { FPS, type CardTheme, type LabelTheme } from "./styles";

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function makeCanvas(width: number, height: number): AnyCanvas {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

export function ctx2d(canvas: AnyCanvas, opts?: CanvasRenderingContext2DSettings): Ctx {
  const ctx = canvas.getContext("2d", opts) as Ctx | null;
  if (!ctx) throw new Error("canvas_unavailable");
  return ctx;
}

// ── Шрифты ───────────────────────────────────────────────────

/**
 * «Flash Film Serif» — тот же Cormorant Garamond, но с прямыми цифрами (см. film-fonts.css):
 * у него цифры по умолчанию старостильные, и «30 дней» в титрах читалось бы как «зо дней».
 */
const FAMILY = {
  serif: '"Flash Film Serif", "Cormorant Garamond Variable", Georgia, "Times New Roman", serif',
  sans: '"Onest Variable", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
} as const;

interface FontSpec {
  family: keyof typeof FAMILY;
  weight: number;
  italic?: boolean;
}

const FONT = {
  serif: { family: "serif", weight: 500 },
  serifSemi: { family: "serif", weight: 600 },
  serifItalic: { family: "serif", weight: 500, italic: true },
  sans: { family: "sans", weight: 400 },
  sansMedium: { family: "sans", weight: 500 },
  sansSemi: { family: "sans", weight: 600 },
} as const satisfies Record<string, FontSpec>;

const fontString = (font: FontSpec, size: number): string =>
  `${font.italic ? "italic " : ""}${font.weight} ${Math.round(size)}px ${FAMILY[font.family]}`;

/**
 * Дожидается загрузки шрифтов для заданного текста: браузер подгружает нужные наборы символов
 * (кириллица, латиница) только когда они понадобились.
 */
export async function loadFilmFonts(text: string): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const sample = `${text} 0123456789 АаБбЯя Zz`;
  await Promise.all(
    Object.values(FONT).map((font) => document.fonts.load(fontString(font, 48), sample).catch(() => [])),
  );
}

// ── Текст ────────────────────────────────────────────────────

interface TextStyle {
  font: FontSpec;
  size: number;
  color: string;
  /** Межбуквенный интервал в долях кегля. */
  tracking?: number;
  shadow?: { color: string; blur: number; y: number };
}

/** Интервалы меньше этого глазу не видны — такой текст рисуется как есть, с родным кернингом. */
const MIN_TRACKING = 0.03;

function trackingPx(style: TextStyle): number {
  const t = style.tracking ?? 0;
  return Math.abs(t) < MIN_TRACKING ? 0 : t * style.size;
}

function setFont(ctx: Ctx, style: TextStyle): void {
  ctx.font = fontString(style.font, style.size);
  ctx.fillStyle = style.color;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
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
  const tracking = trackingPx(style);
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
  const tracking = trackingPx(style);
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

// ── Размытие ─────────────────────────────────────────────────

/**
 * Размытая копия изображения, растянутая на весь кадр («cover»). Сделана через сильное уменьшение
 * и плавное увеличение: работает одинаково во всех браузерах (фильтра blur у canvas в Safari нет).
 */
export function drawBlurred(
  target: Ctx,
  W: number,
  H: number,
  drawCover: (ctx: Ctx, w: number, h: number) => void,
  scratch: { tiny: AnyCanvas; mid: AnyCanvas },
): void {
  const tinyCtx = ctx2d(scratch.tiny);
  tinyCtx.imageSmoothingEnabled = true;
  tinyCtx.imageSmoothingQuality = "high";
  drawCover(tinyCtx, scratch.tiny.width, scratch.tiny.height);
  const midCtx = ctx2d(scratch.mid);
  midCtx.imageSmoothingEnabled = true;
  midCtx.imageSmoothingQuality = "high";
  midCtx.drawImage(scratch.tiny, 0, 0, scratch.mid.width, scratch.mid.height);
  target.imageSmoothingEnabled = true;
  target.imageSmoothingQuality = "high";
  target.drawImage(scratch.mid, 0, 0, W, H);
}

export function blurScratch(W: number, H: number): { tiny: AnyCanvas; mid: AnyCanvas } {
  return {
    // Чем меньше промежуточная картинка, тем сильнее размытие: от кадра остаются только пятна цвета.
    tiny: makeCanvas(Math.ceil(W / 72), Math.ceil(H / 72)),
    mid: makeCanvas(Math.ceil(W / 12), Math.ceil(H / 12)),
  };
}

/** Рисует изображение так, чтобы оно заполнило прямоугольник w×h целиком (лишнее обрезается). */
export function drawCoverImage(ctx: Ctx, image: CanvasImageSource, iw: number, ih: number, w: number, h: number): void {
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

// ── Карточки: вступление, главы, финал ───────────────────────

export interface PreparedCard {
  role: "intro" | "outro" | "chapter";
  frames: number;
  background: AnyCanvas;
  /** Фон — размытый кадр: ему идёт медленный наезд камеры. */
  photo: boolean;
  /** Группы строк: каждая проявляется по очереди. Полоса во всю ширину кадра со смещением y. */
  layers: { canvas: AnyCanvas; y: number }[];
  fade: "white" | "black";
  /** На сколько пикселей строка «всплывает» при появлении. */
  rise: number;
}

function drawBackground(ctx: Ctx, W: number, H: number, theme: CardTheme, photo: ImageBitmap | null): boolean {
  const L = Math.max(W, H);
  ctx.fillStyle = theme.bgColor;
  ctx.fillRect(0, 0, W, H);
  let usedPhoto = false;

  if (theme.background === "milk") {
    radial(ctx, W * 0.86, H * 0.06, L * 0.62, "rgba(181,223,131,0.50)", "rgba(181,223,131,0)", W, H);
    radial(ctx, W * 0.08, H * 0.96, L * 0.58, "rgba(226,242,208,0.95)", "rgba(226,242,208,0)", W, H);
    radial(ctx, W * 0.5, H * 0.46, L * 0.42, "rgba(255,255,255,0.75)", "rgba(255,255,255,0)", W, H);
  } else if (theme.background === "photo" && photo) {
    drawBlurred(ctx, W, H, (c, w, h) => drawCoverImage(c, photo, photo.width, photo.height, w, h), blurScratch(W, H));
    ctx.fillStyle = theme.overlay;
    ctx.fillRect(0, 0, W, H);
    usedPhoto = true;
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

export function prepareCard(opts: {
  W: number;
  H: number;
  theme: CardTheme;
  role: PreparedCard["role"];
  frames: number;
  lines: CardLine[];
  /** Кадр момента для размытого фона (если стиль его использует). */
  photo: ImageBitmap | null;
}): PreparedCard {
  const { W, H, theme } = opts;
  const u = Math.min(W, H) / 1080;
  const portrait = H > W;
  const maxWidth = W * (portrait ? 0.84 : 0.72);

  const background = makeCanvas(W, H);
  const usedPhoto = drawBackground(ctx2d(background), W, H, theme, opts.photo);

  const probe = ctx2d(makeCanvas(16, 16));
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
        const serif = theme.titleFont === "serif";
        const style: TextStyle = { font: serif ? FONT.serif : FONT.sansSemi, size: serif ? base : base * 0.82, color: theme.ink, shadow };
        const fit = fitLines(probe, text, style, maxWidth, 3, 54 * u);
        fit.lines.forEach((l, i) => {
          const last = i === fit.lines.length - 1;
          laid.push({ text: l, style: { ...style, size: fit.size }, height: fit.size * 1.06, gapAfter: last ? 34 * u : 0, group, rule: last });
        });
        break;
      }
      case "subtitle": {
        const style: TextStyle = { font: FONT.sans, size: 37 * u, color: theme.sub, shadow };
        const fit = fitLines(probe, text, style, maxWidth, 2, 26 * u);
        fit.lines.forEach((l, i) =>
          laid.push({ text: l, style: { ...style, size: fit.size }, height: fit.size * 1.3, gapAfter: i === fit.lines.length - 1 ? 26 * u : 0, group }),
        );
        break;
      }
      case "tagline": {
        const style: TextStyle = { font: FONT.serifItalic, size: 50 * u, color: theme.ink, shadow };
        const fit = fitLines(probe, text, style, maxWidth, 2, 32 * u);
        fit.lines.forEach((l, i) =>
          laid.push({ text: l, style: { ...style, size: fit.size }, height: fit.size * 1.22, gapAfter: i === fit.lines.length - 1 ? 26 * u : 0, group }),
        );
        break;
      }
      default: {
        const style: TextStyle = { font: FONT.sansMedium, size: 29 * u, color: theme.sub, tracking: 0.06, shadow };
        const fit = fitLines(probe, text, style, maxWidth, 2, 22 * u);
        fit.lines.forEach((l, i) =>
          laid.push({ text: l, style: { ...style, size: fit.size }, height: fit.size * 1.35, gapAfter: i === fit.lines.length - 1 ? 18 * u : 0, group }),
        );
      }
    }
  }

  const ruleSpace = 34 * u;
  const total = laid.reduce((s, l, i) => s + l.height + (i < laid.length - 1 ? l.gapAfter : 0) + (l.rule ? ruleSpace : 0), 0);
  let y = H * 0.485 - total / 2;

  // Каждая группа строк — своя полоса: целый кадр на строку занимал бы слишком много памяти.
  const pad = Math.ceil(48 * u);
  const groups = new Map<number, { top: number; bottom: number; draw: ((ctx: Ctx) => void)[] }>();
  for (const line of laid) {
    const g = groups.get(line.group) ?? { top: y, bottom: y, draw: [] };
    const baseline = y + line.height * 0.8;
    g.draw.push((ctx) => drawText(ctx, line.text, W / 2, baseline, line.style, "center"));
    y += line.height;
    if (line.rule) {
      const ruleY = y + ruleSpace * 0.55;
      g.draw.push((ctx) => {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.fillStyle = theme.accent;
        roundedRect(ctx, W / 2 - 44 * u, ruleY, 88 * u, Math.max(2, 3 * u), 2 * u);
        ctx.fill();
      });
      y += ruleSpace;
    }
    g.bottom = y;
    groups.set(line.group, g);
    y += line.gapAfter;
  }

  const layers: PreparedCard["layers"] = [];
  for (const g of [...groups.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
    const top = Math.max(0, Math.floor(g.top - pad));
    const bottom = Math.min(H, Math.ceil(g.bottom + pad));
    const canvas = makeCanvas(W, Math.max(1, bottom - top));
    const ctx = ctx2d(canvas);
    ctx.translate(0, -top);
    for (const draw of g.draw) draw(ctx);
    layers.push({ canvas, y: top });
  }

  return { role: opts.role, frames: opts.frames, background, photo: usedPhoto, layers, fade: theme.fade, rise: Math.round(u * 18) };
}

/** Рисует кадр карточки: фон с медленным наездом, строки, проявляющиеся по очереди, вход и выход из цвета. */
export function drawCard(ctx: Ctx, card: PreparedCard, frame: number, W: number, H: number): void {
  const t = frame / FPS;
  const N = card.frames;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  if (card.photo) {
    const zoom = 1 + (0.05 * frame) / N;
    const w = W * zoom;
    const h = H * zoom;
    ctx.drawImage(card.background, (W - w) / 2, (H - h) / 2, w, h);
  } else {
    ctx.drawImage(card.background, 0, 0, W, H);
  }

  const quick = card.role === "chapter";
  card.layers.forEach((layer, i) => {
    const delay = quick ? 0.12 + 0.16 * i : 0.3 + 0.38 * i;
    const fade = quick ? 0.4 : 0.7;
    const alpha = Math.min(1, Math.max(0, (t - delay) / fade));
    if (alpha <= 0) return;
    const k = 1 - Math.min(1, Math.max(0, (t - delay) / (fade + 0.3)));
    ctx.globalAlpha = alpha;
    ctx.drawImage(layer.canvas, 0, layer.y + card.rise * k * k);
  });
  ctx.globalAlpha = 1;

  const color = card.fade === "white" ? "255,255,255" : "0,0,0";
  if (card.role === "intro" && t < 0.5) {
    ctx.fillStyle = `rgba(${color},${1 - t / 0.5})`;
    ctx.fillRect(0, 0, W, H);
  }
  if (card.role === "outro" && frame >= N - 24) {
    ctx.fillStyle = `rgba(${color},${Math.min(1, (frame - (N - 24) + 1) / 24)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

// ── Подписи с датой поверх видео ─────────────────────────────

export interface PreparedLabel {
  canvas: AnyCanvas;
  y: number;
}

export function prepareLabel(opts: {
  W: number;
  H: number;
  theme: LabelTheme;
  text: LabelText;
  /** Высота чёрной полосы снизу (формат «кино»), чтобы подпись встала над ней. */
  barHeight: number;
}): PreparedLabel {
  const { W, H, theme, text } = opts;
  const u = Math.min(W, H) / 1080;
  const portrait = H > W;
  const mx = (portrait ? 64 : 84) * u;
  const bottom = H - (portrait ? 150 : 84) * u - opts.barHeight;
  const shadow = { color: "rgba(0,0,0,0.5)", blur: 20 * u, y: 2 * u };

  // Подпись занимает узкую полосу кадра — рисуем только её.
  const top = theme.kind === "pill" ? Math.max(0, Math.floor((portrait ? 120 : 76) * u - 60 * u)) : Math.max(0, Math.floor(bottom - 230 * u));
  const height = Math.ceil(theme.kind === "pill" ? 200 * u : 300 * u);
  const canvas = makeCanvas(W, Math.min(H - top, height));
  const ctx = ctx2d(canvas);
  ctx.translate(0, -top);

  if (theme.kind === "plain") {
    const primary: TextStyle = { font: FONT.sansSemi, size: 46 * u, color: theme.color, shadow };
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
    const secondary: TextStyle = { font: FONT.sansMedium, size: 24 * u, color: "rgba(255,255,255,0.88)", tracking: 0.3, shadow };
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
    const pillHeight = 72 * u;
    const x = mx;
    const y = (portrait ? 120 : 76) * u;
    ctx.shadowColor = "rgba(20,40,10,0.22)";
    ctx.shadowBlur = 26 * u;
    ctx.shadowOffsetY = 6 * u;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    roundedRect(ctx, x, y, width + padX * 2.3, pillHeight, pillHeight / 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = "#8BC65B";
    ctx.beginPath();
    ctx.arc(x + padX * 0.85, y + pillHeight / 2, 6 * u, 0, Math.PI * 2);
    ctx.fill();
    drawText(ctx, label, x + padX * 1.5, y + pillHeight / 2 + style.size * 0.35, style, "left");
  }

  return { canvas, y: top };
}

/** Прозрачность подписи на кадре frame клипа: плавно появляется и гаснет. */
export function labelAlpha(frame: number, labelFrames: number): number {
  if (labelFrames <= 0 || frame >= labelFrames) return 0;
  const t = frame / FPS;
  const dur = labelFrames / FPS;
  const fadeIn = Math.min(1, Math.max(0, (t - 0.35) / 0.5));
  const fadeOut = Math.min(1, Math.max(0, (dur - 0.05 - t) / 0.55));
  return Math.min(fadeIn, fadeOut);
}
