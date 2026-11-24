// Обложка проекта: автоматически собирается из кадров записанных моментов (начало, середина и конец истории).

import { projectMoments } from "./core";
import { blobKey, store } from "./store";

const W = 1600;
const H = 1000;
const GAP = 8;

type Ctx = CanvasRenderingContext2D;

function cover(ctx: Ctx, img: ImageBitmap, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

function roundedRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function renderCover(images: ImageBitmap[]): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#F8FAF5";
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = "high";

  const portraitMajority = images.filter((i) => i.height > i.width).length * 2 >= images.length;
  if (images.length === 1) {
    const img = images[0];
    if (img.height > img.width) {
      // Вертикальный кадр: мягкий фон из него же и сам кадр по центру.
      ctx.globalAlpha = 0.9;
      cover(ctx, img, -W * 0.1, -H * 0.1, W * 1.2, H * 1.2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(248,250,245,0.55)";
      ctx.fillRect(0, 0, W, H);
      const h = H * 0.92;
      const w = (h * img.width) / img.height;
      ctx.save();
      ctx.shadowColor = "rgba(30,50,20,0.28)";
      ctx.shadowBlur = 48;
      ctx.shadowOffsetY = 14;
      roundedRect(ctx, (W - w) / 2, (H - h) / 2, w, h, 36);
      ctx.fill();
      ctx.restore();
      ctx.save();
      roundedRect(ctx, (W - w) / 2, (H - h) / 2, w, h, 36);
      ctx.clip();
      cover(ctx, img, (W - w) / 2, (H - h) / 2, w, h);
      ctx.restore();
    } else {
      cover(ctx, img, 0, 0, W, H);
    }
  } else if (portraitMajority) {
    // Вертикальные полосы, как кадры на плёнке.
    const n = images.length;
    const w = (W - GAP * (n - 1)) / n;
    images.forEach((img, i) => cover(ctx, img, i * (w + GAP), 0, w, H));
  } else if (images.length === 2) {
    const w = (W - GAP) / 2;
    cover(ctx, images[0], 0, 0, w, H);
    cover(ctx, images[1], w + GAP, 0, w, H);
  } else {
    const left = Math.round(W * 0.62);
    const h = (H - GAP) / 2;
    cover(ctx, images[0], 0, 0, left, H);
    cover(ctx, images[1], left + GAP, 0, W - left - GAP, h);
    cover(ctx, images[2], left + GAP, h + GAP, W - left - GAP, h);
  }
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
}

const pending = new Set<string>();

async function generate(projectId: string): Promise<void> {
  const project = store.projects.get(projectId);
  if (!project || project.coverKind !== "auto") return;
  const withPosters = projectMoments(projectId).filter((m) => m.posterBytes > 0);

  if (withPosters.length === 0) {
    if (project.coverBytes > 0) {
      await store.deleteBlob(blobKey.projectCover(projectId));
      const fresh = store.projects.get(projectId);
      if (fresh) await store.putProject({ ...fresh, coverBytes: 0 });
    }
    return;
  }

  const picks =
    withPosters.length <= 3
      ? withPosters
      : [withPosters[0], withPosters[Math.floor(withPosters.length / 2)], withPosters[withPosters.length - 1]];
  const images: ImageBitmap[] = [];
  for (const m of picks) {
    try {
      const blob = await store.getBlob(blobKey.momentPoster(m.id));
      if (blob) images.push(await createImageBitmap(blob));
    } catch {
      /* кадр не прочитался — пропускаем */
    }
  }
  if (images.length === 0) return;
  try {
    const blob = await renderCover(images);
    const fresh = store.projects.get(projectId);
    if (!blob || !fresh || fresh.coverKind !== "auto") return;
    await store.putProject({ ...fresh, coverBytes: blob.size }, { [blobKey.projectCover(projectId)]: blob });
  } finally {
    images.forEach((img) => img.close());
  }
}

/** Пересобирает обложку проекта чуть позже: несколько изменений подряд дают одну пересборку. */
export function refreshCover(projectId: string): void {
  if (typeof window === "undefined" || pending.has(projectId)) return;
  pending.add(projectId);
  setTimeout(() => {
    pending.delete(projectId);
    void generate(projectId).catch(() => {});
  }, 600);
}
