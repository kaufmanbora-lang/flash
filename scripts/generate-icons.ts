// npm run icons — рисует иконки приложения и заставки запуска для iPhone.
// Результат лежит в public/icons и public/splash и хранится в репозитории;
// запускать заново нужно только при смене логотипа.

import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createCanvas, GlobalFonts, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";

const require = createRequire(import.meta.url);
const FONT = "FlashIconSerif";
const INK = "#20301E";
const LEAF = "#8BC65B";
const MILK = "#F8FAF5";

function findFont(): string {
  const pkg = "@expo-google-fonts/cormorant-garamond";
  let dir: string;
  try {
    dir = path.dirname(require.resolve(`${pkg}/package.json`));
  } catch {
    dir = path.join(process.cwd(), "node_modules", ...pkg.split("/"));
  }
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/_700Bold\.ttf$/.test(entry.name)) return full;
    }
  }
  throw new Error("Шрифт Cormorant Garamond Bold не найден — выполните npm install");
}

function glow(ctx: SKRSContext2D, W: number, H: number, cx: number, cy: number, r: number, color: string): void {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function background(ctx: SKRSContext2D, W: number, H: number): void {
  const L = Math.max(W, H);
  ctx.fillStyle = MILK;
  ctx.fillRect(0, 0, W, H);
  glow(ctx, W, H, W * 0.92, H * 0.02, L * 0.7, "rgba(181,223,131,0.55)");
  glow(ctx, W, H, W * 0.04, H * 0.98, L * 0.62, "rgba(226,242,208,0.95)");
  glow(ctx, W, H, W * 0.5, H * 0.45, L * 0.4, "rgba(255,255,255,0.8)");
}

/** Знак «f.» — первая буква логотипа и салатовая точка. */
function mark(ctx: SKRSContext2D, cx: number, cy: number, size: number, ink = INK, dot = LEAF): void {
  ctx.font = `${Math.round(size)}px "${FONT}"`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const fw = ctx.measureText("f").width;
  const dw = ctx.measureText(".").width;
  const total = fw + dw * 0.92;
  const x = cx - total / 2;
  const y = cy + size * 0.3;
  ctx.fillStyle = ink;
  ctx.fillText("f", x, y);
  ctx.fillStyle = dot;
  ctx.fillText(".", x + fw - dw * 0.08, y);
}

function wordmark(ctx: SKRSContext2D, cx: number, cy: number, size: number): void {
  ctx.font = `${Math.round(size)}px "${FONT}"`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const word = "flash";
  const ww = ctx.measureText(word).width;
  const dw = ctx.measureText(".").width;
  const x = cx - (ww + dw) / 2;
  const y = cy + size * 0.28;
  ctx.fillStyle = INK;
  ctx.fillText(word, x, y);
  ctx.fillStyle = LEAF;
  ctx.fillText(".", x + ww, y);
}

async function save(canvas: Canvas, file: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, await canvas.encode("png"));
  console.log("  ✓", path.relative(process.cwd(), file));
}

async function icon(size: number, file: string, glyphScale: number): Promise<void> {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  background(ctx, size, size);
  mark(ctx, size / 2, size / 2, size * glyphScale);
  await save(canvas, file);
}

async function badge(file: string): Promise<void> {
  // Значок в строке состояния Android: одноцветный силуэт на прозрачном фоне.
  const size = 96;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  mark(ctx, size / 2, size / 2, size * 0.95, "#FFFFFF", "#FFFFFF");
  await save(canvas, file);
}

async function splash(w: number, h: number): Promise<void> {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  background(ctx, w, h);
  wordmark(ctx, w / 2, h * 0.47, Math.min(w, h) * 0.24);
  await save(canvas, path.join("public", "splash", `splash-${w}x${h}.png`));
}

const SPLASH: [number, number, number][] = [
  [440, 956, 3],
  [430, 932, 3],
  [402, 874, 3],
  [393, 852, 3],
  [428, 926, 3],
  [390, 844, 3],
  [375, 812, 3],
  [414, 896, 3],
  [414, 896, 2],
  [375, 667, 2],
];

async function main(): Promise<void> {
  // Байтами, а не путём: registerFromPath молча возвращает null на длинных путях Windows,
  // и логотип нарисовался бы системным шрифтом.
  if (!GlobalFonts.register(fs.readFileSync(findFont()), FONT)) {
    throw new Error("Шрифт Cormorant Garamond не удалось загрузить");
  }
  console.log("Иконки:");
  await icon(192, path.join("public", "icons", "icon-192.png"), 0.78);
  await icon(512, path.join("public", "icons", "icon-512.png"), 0.78);
  // Маскируемая иконка: знак помещается в «безопасный круг», Android обрезает края.
  await icon(512, path.join("public", "icons", "icon-maskable-512.png"), 0.56);
  await icon(180, path.join("public", "icons", "apple-touch-icon.png"), 0.74);
  await icon(64, path.join("src", "app", "icon.png"), 0.82);
  await badge(path.join("public", "icons", "badge-96.png"));
  console.log("Заставки:");
  for (const [w, h, r] of SPLASH) await splash(w * r, h * r);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
