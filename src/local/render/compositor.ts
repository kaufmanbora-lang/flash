// Сборка одного кадра фильма: вписать видео в кадр, цветокоррекция, подпись с датой, переходы.
// Используются только операции canvas, которые есть во всех браузерах (режимы наложения, градиенты).

import type { VideoSample } from "mediabunny";
import type { FilmStyle, Grade, Transition } from "./styles";
import { blurScratch, ctx2d, drawBlurred, makeCanvas, type AnyCanvas, type Ctx, type PreparedLabel } from "./titles";

export interface Layer {
  canvas: AnyCanvas;
  ctx: Ctx;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function makeLayer(W: number, H: number): Layer {
  const canvas = makeCanvas(W, H);
  return { canvas, ctx: ctx2d(canvas, { alpha: false }) };
}

/** Плитка плёночного зерна: серый шум, который накладывается на кадр в режиме overlay. */
function makeGrainTile(size: number, seed: number): AnyCanvas {
  const canvas = makeCanvas(size, size);
  const ctx = ctx2d(canvas);
  const image = ctx.createImageData(size, size);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < image.data.length; i += 4) {
    // xorshift: быстро и одинаково во всех браузерах
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const v = 128 + (((s >>> 0) % 255) - 127) * 0.55;
    image.data[i] = v;
    image.data[i + 1] = v;
    image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function reset(ctx: Ctx): void {
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
}

export class Compositor {
  readonly out: Layer;
  private readonly a: Layer;
  private readonly b: Layer;
  private readonly scratch: Layer;
  private readonly mask: Layer;
  private readonly blur: { tiny: AnyCanvas; mid: AnyCanvas };
  private readonly grain: AnyCanvas[] = [];
  private readonly vignettes = new Map<string, CanvasGradient>();

  constructor(
    readonly W: number,
    readonly H: number,
    private readonly style: FilmStyle,
    private readonly barHeight: number,
    target?: HTMLCanvasElement | null,
  ) {
    let canvas: AnyCanvas;
    if (target) {
      target.width = W;
      target.height = H;
      canvas = target;
    } else {
      canvas = makeCanvas(W, H);
    }
    this.out = { canvas, ctx: ctx2d(canvas, { alpha: false }) };
    this.a = makeLayer(W, H);
    this.b = makeLayer(W, H);
    this.scratch = makeLayer(W, H);
    // Маске шторки нужна прозрачность.
    const maskCanvas = makeCanvas(W, H);
    this.mask = { canvas: maskCanvas, ctx: ctx2d(maskCanvas) };
    this.blur = blurScratch(W, H);
    if (style.grade.grain > 0) {
      for (let i = 0; i < 4; i++) this.grain.push(makeGrainTile(256, 0x9e3779b9 + i * 7919));
    }
  }

  layer(which: "out" | "a" | "b"): Layer {
    return which === "out" ? this.out : which === "a" ? this.a : this.b;
  }

  private vignette(ctx: Ctx, amount: number): CanvasGradient {
    const key = `${amount}`;
    let g = this.vignettes.get(key);
    if (!g) {
      const L = Math.max(this.W, this.H);
      g = ctx.createRadialGradient(this.W / 2, this.H / 2, L * 0.3, this.W / 2, this.H / 2, L * 0.76);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, `rgba(0,0,0,${amount})`);
      this.vignettes.set(key, g);
    }
    return g;
  }

  /** Цветокоррекция слоя на месте. */
  private applyGrade(layer: Layer, grade: Grade, frame: number): void {
    const { ctx } = layer;
    const { W, H } = this;
    if (grade.punch > 0) {
      const s = this.scratch.ctx;
      reset(s);
      s.drawImage(layer.canvas, 0, 0);
      ctx.globalCompositeOperation = "soft-light";
      ctx.globalAlpha = grade.punch;
      ctx.drawImage(this.scratch.canvas, 0, 0);
    }
    if (grade.desaturate > 0) {
      ctx.globalCompositeOperation = "saturation";
      ctx.globalAlpha = grade.desaturate;
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, W, H);
    }
    if (grade.tint) {
      ctx.globalCompositeOperation = "soft-light";
      ctx.globalAlpha = grade.tint.amount;
      ctx.fillStyle = grade.tint.color;
      ctx.fillRect(0, 0, W, H);
    }
    if (grade.lift) {
      ctx.globalCompositeOperation = "lighten";
      ctx.globalAlpha = grade.lift.amount;
      ctx.fillStyle = grade.lift.color;
      ctx.fillRect(0, 0, W, H);
    }
    if (grade.brighten > 0) {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = grade.brighten;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, W, H);
    }
    if (grade.vignette > 0) {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = this.vignette(ctx, grade.vignette);
      ctx.fillRect(0, 0, W, H);
    }
    if (grade.grain > 0 && this.grain.length > 0) this.applyGrain(layer, grade.grain, frame);
    reset(ctx);
  }

  /** Плёночное зерно: каждый кадр — другая плитка с другим сдвигом, поэтому зерно «живое». */
  applyGrain(layer: Layer, amount: number, frame: number): void {
    if (this.grain.length === 0) return;
    const { ctx } = layer;
    const tile = this.grain[frame % this.grain.length];
    const pattern = ctx.createPattern(tile, "repeat");
    if (!pattern) return;
    const dx = (frame * 73) % 256;
    const dy = (frame * 151) % 256;
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = Math.min(1, amount * 0.42);
    ctx.translate(-dx, -dy);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, this.W + 256, this.H + 256);
    ctx.restore();
    reset(ctx);
  }

  /** Кадр клипа: видео вписывается в кадр фильма, затем цветокоррекция, полосы «кино» и подпись. */
  drawClip(
    layer: Layer,
    sample: VideoSample | null,
    frame: number,
    label: PreparedLabel | null,
    labelAlpha: number,
  ): void {
    const { ctx } = layer;
    const { W, H } = this;
    reset(ctx);
    if (!sample) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
    } else {
      const srcAspect = sample.displayWidth / Math.max(1, sample.displayHeight);
      const dstAspect = W / H;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      if (Math.abs(srcAspect / dstAspect - 1) < 0.07) {
        sample.drawWithFit(ctx, { fit: "cover" });
      } else {
        // Кадр другой ориентации: вписываем целиком, а поля заполняем его же размытой копией.
        drawBlurred(ctx, W, H, (c) => sample.drawWithFit(c, { fit: "cover" }), this.blur);
        ctx.fillStyle = "rgba(0,0,0,0.14)";
        ctx.fillRect(0, 0, W, H);
        sample.drawWithFit(ctx, { fit: "contain" });
      }
    }
    this.applyGrade(layer, this.style.grade, frame);
    if (this.barHeight > 0) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, this.barHeight);
      ctx.fillRect(0, H - this.barHeight, W, this.barHeight);
    }
    if (label && labelAlpha > 0) {
      ctx.globalAlpha = labelAlpha;
      ctx.drawImage(label.canvas, 0, label.y);
      ctx.globalAlpha = 1;
    }
  }

  private desaturate(layer: Layer, amount: number): void {
    if (amount <= 0) return;
    const { ctx } = layer;
    ctx.globalCompositeOperation = "saturation";
    ctx.globalAlpha = Math.min(1, amount);
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, this.W, this.H);
    reset(ctx);
  }

  /**
   * Переход между слоями a (уходит) и b (приходит). p — доля пройденного перехода, 0…1.
   * Результат рисуется в выходной кадр.
   */
  transition(tr: Transition, p: number): void {
    const { W, H } = this;
    const out = this.out.ctx;
    reset(out);
    switch (tr.type) {
      case "fadewhite":
      case "fadeblack": {
        // Уходящий кадр растворяется в цвете, приходящий — проявляется из него.
        const color = tr.type === "fadewhite" ? "255,255,255" : "0,0,0";
        const toColor = smoothstep(0, 0.8, p);
        const fromColor = 1 - smoothstep(0.2, 1, p);
        out.drawImage(this.a.canvas, 0, 0);
        out.fillStyle = `rgba(${color},${toColor})`;
        out.fillRect(0, 0, W, H);
        const a2 = p * fromColor;
        const a1 = a2 >= 1 ? 0 : (p * (1 - fromColor)) / (1 - a2);
        out.globalAlpha = Math.min(1, Math.max(0, a1));
        out.drawImage(this.b.canvas, 0, 0);
        out.globalAlpha = 1;
        out.fillStyle = `rgba(${color},${Math.min(1, Math.max(0, a2))})`;
        out.fillRect(0, 0, W, H);
        break;
      }
      case "fadegrays": {
        this.desaturate(this.a, smoothstep(0, 0.8, p));
        this.desaturate(this.b, 1 - smoothstep(0.2, 1, p));
        out.drawImage(this.a.canvas, 0, 0);
        out.globalAlpha = p;
        out.drawImage(this.b.canvas, 0, 0);
        break;
      }
      case "smoothleft": {
        // Мягкая шторка: новый кадр открывается справа налево, край — широкий плавный градиент.
        const m = this.mask.ctx;
        m.globalCompositeOperation = "copy";
        m.globalAlpha = 1;
        m.drawImage(this.b.canvas, 0, 0);
        const x0 = W * (1 - 2 * p);
        const g = m.createLinearGradient(x0, 0, x0 + W, 0);
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(0.25, "rgba(0,0,0,0.16)");
        g.addColorStop(0.5, "rgba(0,0,0,0.5)");
        g.addColorStop(0.75, "rgba(0,0,0,0.84)");
        g.addColorStop(1, "rgba(0,0,0,1)");
        m.globalCompositeOperation = "destination-in";
        m.fillStyle = g;
        m.fillRect(0, 0, W, H);
        m.globalCompositeOperation = "source-over";
        out.drawImage(this.a.canvas, 0, 0);
        out.drawImage(this.mask.canvas, 0, 0);
        break;
      }
      default: {
        out.drawImage(this.a.canvas, 0, 0);
        out.globalAlpha = p;
        out.drawImage(this.b.canvas, 0, 0);
      }
    }
    reset(out);
  }

  /** Уменьшенная копия текущего кадра (JPEG) — обложка фильма. */
  async snapshot(maxSide = 1280): Promise<Blob | null> {
    const scale = Math.min(1, maxSide / Math.max(this.W, this.H));
    const w = Math.max(2, Math.round(this.W * scale));
    const h = Math.max(2, Math.round(this.H * scale));
    const canvas = makeCanvas(w, h);
    const ctx = ctx2d(canvas, { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.out.canvas, 0, 0, w, h);
    try {
      if ("convertToBlob" in canvas) return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.86 });
      return await new Promise<Blob | null>((resolve) => (canvas as HTMLCanvasElement).toBlob(resolve, "image/jpeg", 0.86));
    } catch {
      return null;
    }
  }
}
