// Запуск настоящих ffmpeg / ffprobe как дочерних процессов.
// Бинарники ищутся так: переменные окружения → PATH → npm-пакеты для разработки.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { env } from "@/lib/env";

const require = createRequire(import.meta.url);
const children = new Set<ChildProcess>();

function canRun(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, ["-version"], { stdio: "ignore", windowsHide: true });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

function optionalPackagePath(name: string, pick: (mod: unknown) => unknown): string | null {
  try {
    const value = pick(require(name));
    return typeof value === "string" && fs.existsSync(value) ? value : null;
  } catch {
    return null;
  }
}

let ffmpegBin: Promise<string> | null = null;
let ffprobeBin: Promise<string> | null = null;

export function ffmpegPath(): Promise<string> {
  ffmpegBin ??= (async () => {
    const fromEnv = env.ffmpegPath;
    if (fromEnv) {
      if (await canRun(fromEnv)) return fromEnv;
      throw new Error(`FFMPEG_PATH указывает на нерабочий файл: ${fromEnv}`);
    }
    if (await canRun("ffmpeg")) return "ffmpeg";
    const bundled = optionalPackagePath("ffmpeg-static", (m) => m);
    if (bundled && (await canRun(bundled))) return bundled;
    throw new Error("FFmpeg не найден. Установите ffmpeg или задайте FFMPEG_PATH.");
  })();
  ffmpegBin.catch(() => (ffmpegBin = null));
  return ffmpegBin;
}

export function ffprobePath(): Promise<string> {
  ffprobeBin ??= (async () => {
    const fromEnv = env.ffprobePath;
    if (fromEnv) {
      if (await canRun(fromEnv)) return fromEnv;
      throw new Error(`FFPROBE_PATH указывает на нерабочий файл: ${fromEnv}`);
    }
    if (await canRun("ffprobe")) return "ffprobe";
    // ffprobe часто лежит рядом с ffmpeg.
    const ff = await ffmpegPath().catch(() => null);
    if (ff && path.isAbsolute(ff)) {
      const sibling = path.join(path.dirname(ff), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
      if (fs.existsSync(sibling) && (await canRun(sibling))) return sibling;
    }
    const bundled = optionalPackagePath("@ffprobe-installer/ffprobe", (m) => (m as { path?: string }).path);
    if (bundled && (await canRun(bundled))) return bundled;
    throw new Error("FFprobe не найден. Установите ffmpeg (с ffprobe) или задайте FFPROBE_PATH.");
  })();
  ffprobeBin.catch(() => (ffprobeBin = null));
  return ffprobeBin;
}

export interface RunOptions {
  cwd?: string;
  /** Вызывается с позицией кодирования в секундах (нужен для индикатора прогресса). */
  onProgress?: (seconds: number) => void;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], opts: RunOptions, captureStdout: boolean): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let pending = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (opts.onProgress) {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
          if (m) opts.onProgress(Number(m[1]) / 1_000_000);
        }
      } else if (captureStdout && stdout.length < 8_000_000) {
        stdout += chunk;
      }
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-12_000);
    });
    child.on("error", (err) => {
      children.delete(child);
      reject(err);
    });
    child.on("close", (code, signal) => {
      children.delete(child);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.trim().split(/\r?\n/).slice(-12).join("\n");
        reject(new Error(`${path.basename(bin)} завершился с кодом ${code ?? signal}:\n${tail}`));
      }
    });
  });
}

/** Запускает ffmpeg. Все пути внутри фильтров должны быть относительными к cwd. */
export async function ffmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  const bin = await ffmpegPath();
  const base = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error"];
  if (opts.onProgress) base.push("-progress", "pipe:1", "-nostats");
  await run(bin, [...base, ...args], opts, false);
}

export async function ffprobeJson(args: string[], opts: RunOptions = {}): Promise<unknown> {
  const bin = await ffprobePath();
  const { stdout } = await run(bin, ["-v", "error", "-print_format", "json", ...args], opts, true);
  return JSON.parse(stdout || "{}");
}

export async function ffprobeText(args: string[], opts: RunOptions = {}): Promise<string> {
  const bin = await ffprobePath();
  return (await run(bin, ["-v", "error", ...args], opts, true)).stdout;
}

export function killAllFfmpeg(): void {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* уже завершился */
    }
  }
  children.clear();
}

// ── Возможности сборки ffmpeg ────────────────────────────────

let filtersCache: Promise<Set<string>> | null = null;

export function availableFilters(): Promise<Set<string>> {
  filtersCache ??= (async () => {
    const bin = await ffmpegPath();
    const { stdout } = await run(bin, ["-hide_banner", "-filters"], {}, true);
    const names = new Set<string>();
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^\s*[T.][S.][C.]?\s+(\S+)\s+/.exec(line);
      if (m) names.add(m[1]);
    }
    return names;
  })();
  return filtersCache;
}

export async function ffmpegVersion(): Promise<string> {
  const bin = await ffmpegPath();
  const { stdout } = await run(bin, ["-version"], {}, true);
  return stdout.split(/\r?\n/)[0] ?? "ffmpeg";
}

// ── Анализ файла ─────────────────────────────────────────────

export interface ProbeResult {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Размер кадра так, как его видит зритель (с учётом поворота). */
  width: number;
  height: number;
  rotation: number;
  fps: number;
  vcodec: string;
  acodec: string | null;
  pixFmt: string;
  hdr: boolean;
  formatName: string;
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  color_transfer?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number | string }[];
  disposition?: { attached_pic?: number };
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [a, b] = rate.split("/").map(Number);
  if (!Number.isFinite(a) || !b) return Number.isFinite(a) ? a : 0;
  return a / b;
}

export async function probe(file: string): Promise<ProbeResult> {
  const raw = (await ffprobeJson(["-show_format", "-show_streams", file])) as {
    streams?: RawStream[];
    format?: { duration?: string; format_name?: string };
  };
  const streams = raw.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");

  let rotation = 0;
  if (video) {
    const side = video.side_data_list?.find((s) => s.rotation !== undefined);
    rotation = Number(side?.rotation ?? video.tags?.rotate ?? 0) || 0;
  }
  const quarter = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const cw = video?.width ?? 0;
  const ch = video?.height ?? 0;

  let duration = Number(raw.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) duration = Number(video?.duration);
  if ((!Number.isFinite(duration) || duration <= 0) && video) {
    // WebM из MediaRecorder не содержит длительности — берём время последнего пакета.
    const text = await ffprobeText([
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts_time",
      "-of",
      "csv=p=0",
      file,
    ]).catch(() => "");
    let last = 0;
    for (const line of text.split(/\r?\n/)) {
      const t = Number(line.split(",")[0]);
      if (Number.isFinite(t) && t > last) last = t;
    }
    const fpsGuess = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 30;
    duration = last > 0 ? last + 1 / Math.min(Math.max(fpsGuess, 1), 120) : 0;
  }

  let fps = parseRate(video?.avg_frame_rate);
  if (!fps || fps > 240) fps = parseRate(video?.r_frame_rate);
  if (!fps || fps > 240) fps = 30;

  const transfer = video?.color_transfer ?? "";
  return {
    durationSec: Number.isFinite(duration) ? Math.max(0, duration) : 0,
    hasVideo: !!video && cw > 0 && ch > 0,
    hasAudio: !!audio,
    width: quarter ? ch : cw,
    height: quarter ? cw : ch,
    rotation,
    fps,
    vcodec: video?.codec_name ?? "",
    acodec: audio?.codec_name ?? null,
    pixFmt: video?.pix_fmt ?? "",
    hdr: transfer === "smpte2084" || transfer === "arib-std-b67",
    formatName: raw.format?.format_name ?? "",
  };
}

/** Цепочка фильтров, переводящая HDR-видео (HLG / PQ с iPhone) в обычный SDR без «выцветания». */
export const TONEMAP_CHAIN =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

export async function tonemapFilter(info: ProbeResult): Promise<string | null> {
  if (!info.hdr) return null;
  const filters = await availableFilters();
  return filters.has("zscale") && filters.has("tonemap") ? TONEMAP_CHAIN : null;
}

export const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
