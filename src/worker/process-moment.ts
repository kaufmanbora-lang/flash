// Обработка загруженного момента: проверка длительности, кадр-превью, версия для воспроизведения
// на любых устройствах и «профиль интересности» для Highlights. Оригинал не изменяется.

import fs from "node:fs/promises";
import path from "node:path";
import { MIN_MOMENT_SERVER_MS } from "@/lib/constants";
import { exec, q, q1 } from "@/lib/db";
import { markFilmsStale, refreshProjectCovers } from "@/lib/moment-service";
import { keys, storage } from "@/lib/storage";
import type { MomentAnalysis, MomentRow } from "@/lib/types";
import { ffmpeg, probe, tonemapFilter, type ProbeResult } from "./ffmpeg";
import { makeWorkDir, PermanentError, removeWorkDir } from "./workdir";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Читает значения «ключ=число» из файла, который пишут фильтры metadata / ametadata. */
function metadataValues(text: string, key: string): number[] {
  const out: number[] = [];
  const prefix = `${key}=`;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    const v = Number(line.slice(prefix.length));
    out.push(Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY);
  }
  return out;
}

/** Громкость звука и количество движения в кадре по секундам — по ним выбираются лучшие фрагменты. */
async function analyze(dir: string, src: string, info: ProbeResult): Promise<MomentAnalysis | null> {
  const seconds = Math.max(1, Math.ceil(info.durationSec));
  let energy: number[] = [];
  let motion: number[] = [];

  if (info.hasAudio) {
    try {
      await ffmpeg(
        [
          "-i", src, "-vn",
          "-af",
          "aresample=16000,aformat=channel_layouts=mono,asetnsamples=n=16000:p=0," +
            "astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=energy.txt",
          "-f", "null", "-",
        ],
        { cwd: dir },
      );
      const text = await fs.readFile(path.join(dir, "energy.txt"), "utf8");
      energy = metadataValues(text, "lavfi.astats.Overall.RMS_level").map((v) => Math.round(clamp(v, -90, 0) * 10) / 10);
    } catch (err) {
      console.warn("[moment] анализ звука не удался:", (err as Error).message.split("\n")[0]);
    }
  }

  try {
    await ffmpeg(
      [
        "-i", src, "-an",
        "-vf",
        "fps=4,scale=160:-2,format=yuv420p,select='gte(scene,0)',metadata=mode=print:key=lavfi.scene_score:file=motion.txt",
        "-f", "null", "-",
      ],
      { cwd: dir },
    );
    const scores = metadataValues(await fs.readFile(path.join(dir, "motion.txt"), "utf8"), "lavfi.scene_score");
    for (let s = 0; s < seconds; s++) {
      const chunk = scores.slice(s * 4, s * 4 + 4).filter((v) => Number.isFinite(v));
      const avg = chunk.length ? chunk.reduce((a, b) => a + b, 0) / chunk.length : 0;
      motion.push(Math.round(clamp(avg, 0, 1) * 1000) / 1000);
    }
  } catch (err) {
    console.warn("[moment] анализ движения не удался:", (err as Error).message.split("\n")[0]);
  }

  if (energy.length === 0 && motion.length === 0) return null;
  const fit = (arr: number[], fill: number) => {
    const out = arr.slice(0, seconds);
    while (out.length < seconds) out.push(fill);
    return out;
  };
  return { energy: fit(energy, -90), motion: fit(motion, 0) };
}

/**
 * Версия для плеера: MP4 (H.264 + AAC), которую одинаково играют Safari на iPhone, Chrome и Android.
 * Если оригинал уже такой — он используется как есть, без второй копии.
 */
async function makePlayback(
  dir: string,
  src: string,
  info: ProbeResult,
  source: MomentRow["source"],
  tonemap: string | null,
): Promise<string | null> {
  const eightBit = info.pixFmt === "yuv420p" || info.pixFmt === "yuvj420p";
  const copyVideo = info.vcodec === "h264" && eightBit && !info.hdr && Math.max(info.width, info.height) <= 1920;
  const copyAudio = !info.hasAudio || info.acodec === "aac";
  const mp4Like = /mp4|mov/.test(info.formatName);

  // Файл из галереи в совместимом формате играется напрямую.
  if (source === "upload" && copyVideo && copyAudio && mp4Like) return null;

  const out = path.join(dir, "playback.mp4");
  const audioArgs = !info.hasAudio
    ? ["-an"]
    : copyAudio
      ? ["-c:a", "copy"]
      : ["-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000"];

  if (copyVideo) {
    try {
      // Быстрая перепаковка без перекодирования: чинит фрагментированные MP4 из MediaRecorder.
      await ffmpeg(["-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", ...audioArgs, "-movflags", "+faststart", "playback.mp4"], {
        cwd: dir,
      });
      return out;
    } catch (err) {
      console.warn("[moment] перепаковка не удалась, перекодирую:", (err as Error).message.split("\n")[0]);
    }
  }

  const fps = info.fps >= 20 && info.fps <= 60 ? Math.round(info.fps * 1000) / 1000 : 30;
  const vf = [
    "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos",
    tonemap,
    `fps=${fps}`,
    "format=yuv420p",
  ]
    .filter(Boolean)
    .join(",");
  await ffmpeg(
    [
      "-i", src,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", vf,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high", "-pix_fmt", "yuv420p",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
      ...(info.hasAudio ? ["-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000"] : ["-an"]),
      "-movflags", "+faststart",
      "playback.mp4",
    ],
    { cwd: dir },
  );
  return out;
}

export async function failMoment(momentId: string, code: string): Promise<void> {
  const row = await q1<MomentRow>(
    `UPDATE moments SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [momentId, code],
  );
  if (!row) return;
  // Неудачная запись не занимает место: файлы удаляются, остаётся только отметка об ошибке.
  const store = await storage();
  await store.deletePrefix(keys.momentPrefix(row.user_id, row.id)).catch(() => {});
  await exec(
    `UPDATE moments SET original_key = NULL, playback_key = NULL, poster_key = NULL,
            size_bytes = 0, playback_size = 0, poster_size = 0 WHERE id = $1`,
    [momentId],
  );
}

export async function processMoment(momentId: string): Promise<void> {
  const row = await q1<MomentRow>(`SELECT * FROM moments WHERE id = $1`, [momentId]);
  if (!row || row.status !== "processing" || !row.original_key) return;

  const store = await storage();
  const dir = await makeWorkDir("moment");
  try {
    const src = path.join(dir, `source.${row.ext}`);
    await store.downloadToFile(row.original_key, src);

    let info: ProbeResult;
    try {
      info = await probe(src);
    } catch {
      throw new PermanentError("unreadable_video");
    }
    if (!info.hasVideo) throw new PermanentError("not_video");
    const durationMs = Math.round(info.durationSec * 1000);
    if (durationMs < MIN_MOMENT_SERVER_MS) throw new PermanentError("too_short");

    const tonemap = await tonemapFilter(info);

    const posterAt = Math.min(1, info.durationSec * 0.1);
    const posterVf = ["scale=w='min(960,iw)':h=-2:flags=lanczos", tonemap].filter(Boolean).join(",");
    await ffmpeg(
      ["-ss", posterAt.toFixed(2), "-i", src, "-frames:v", "1", "-update", "1", "-vf", posterVf, "-q:v", "3", "poster.jpg"],
      { cwd: dir },
    );
    const posterFile = path.join(dir, "poster.jpg");

    const playbackFile = await makePlayback(dir, src, info, row.source, tonemap);
    const analysis = await analyze(dir, src, info);

    const posterKey = keys.momentPoster(row.user_id, row.id);
    const posterSize = await store.putFile(posterKey, posterFile, "image/jpeg");
    let playbackKey: string | null = null;
    let playbackSize = 0;
    if (playbackFile) {
      playbackKey = keys.momentPlayback(row.user_id, row.id);
      playbackSize = await store.putFile(playbackKey, playbackFile, "video/mp4");
    }

    const updated = await exec(
      `UPDATE moments
       SET status = 'ready', error = NULL, duration_ms = $2, width = $3, height = $4, has_audio = $5,
           poster_key = $6, poster_size = $7, playback_key = $8, playback_size = $9, analysis = $10::jsonb,
           updated_at = now()
       WHERE id = $1 AND status = 'processing'`,
      [
        row.id,
        durationMs,
        info.width,
        info.height,
        info.hasAudio,
        posterKey,
        posterSize,
        playbackKey,
        playbackSize,
        analysis ? JSON.stringify(analysis) : null,
      ],
    );
    if (updated === 0) {
      // Момент удалили, пока он обрабатывался.
      await store.deletePrefix(keys.momentPrefix(row.user_id, row.id)).catch(() => {});
      return;
    }

    const links = await q<{ project_id: string }>(`SELECT project_id FROM project_moments WHERE moment_id = $1`, [row.id]);
    const projectIds = links.map((l) => l.project_id);
    await markFilmsStale(row.user_id, row.local_date, projectIds);
    await refreshProjectCovers(projectIds);
  } finally {
    await removeWorkDir(dir);
  }
}
