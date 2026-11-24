// Создание музыкальной библиотеки: по три оригинальные композиции на каждый из семи стилей.
// Синтез → WAV → AAC (.m4a) через ffmpeg. Результат — файлы в public/music и library.json рядом с ними:
// приложение скачивает их по мере надобности.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { MUSIC_STYLES, type MusicStyleId } from "@/lib/constants";
import { compose } from "./compose";
import { encodeWav, measure } from "./synth";

/** Версия набора: при изменении синтезатора увеличьте, и библиотека пересоздастся. */
const LIBRARY_VERSION = 2;

export const MUSIC_DIR = path.resolve(process.cwd(), "public", "music");

const TITLES: Record<MusicStyleId, string[]> = {
  "relaxing-piano": ["Morning Window", "Quiet Tea", "Slow Sunday"],
  "soft-ambient": ["First Light", "Still Water", "Open Sky"],
  "warm-memories": ["Old Photographs", "Home Again", "Golden Hour"],
  "chill-acoustic": ["Porch Light", "Coastal Road", "Lazy Afternoon"],
  "dreamy-cinematic": ["Far Horizon", "Night Train", "Snowfall"],
  nostalgia: ["Music Box", "Paper Boats", "Carousel"],
  "happy-moments": ["Sunny Side", "Picnic", "Little Things"],
};

export interface GeneratedTrack {
  id: string;
  style: MusicStyleId;
  title: string;
  file: string;
  durationSec: number;
  bpm?: number;
  key?: string;
}

interface Manifest {
  version: number;
  tracks: GeneratedTrack[];
}

function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const require = createRequire(import.meta.url);
  try {
    const found = require("ffmpeg-static") as string | null;
    // Пакет может быть установлен без самого файла (если установочные скрипты были отключены).
    if (found && existsSync(found)) return found;
  } catch {
    /* пакет не установлен — пробуем системный ffmpeg */
  }
  return "ffmpeg";
}

function ffmpeg(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg завершился с кодом ${code}: ${stderr.slice(-400)}`))));
  });
}

async function readState(dir: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "library.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

export async function generateMusicLibrary(log: (msg: string) => void = console.log): Promise<GeneratedTrack[]> {
  const dir = MUSIC_DIR;
  await fs.mkdir(dir, { recursive: true });
  const tracks: GeneratedTrack[] = [];

  for (const style of MUSIC_STYLES) {
    for (let i = 0; i < TITLES[style].length; i++) {
      const id = `${style}-${i + 1}`;
      // Зерно не зависит от версии набора: композиции остаются теми же, меняется только упаковка.
      const seed = 1009 * (MUSIC_STYLES.indexOf(style) + 1) + 97 * (i + 1) + 1;
      const t0 = Date.now();
      const piece = compose(style, seed);
      const stats = measure(piece.audio);
      if (!(stats.rms > 0.01) || !Number.isFinite(stats.peak)) {
        throw new Error(`Композиция ${id} получилась пустой (rms=${stats.rms})`);
      }
      const wav = path.join(dir, `${id}.wav`);
      await fs.writeFile(wav, encodeWav(piece.audio));
      try {
        // 48 кГц — частота, на которой сводится звук фильма; 160 кбит/с хватает фоновой музыке.
        await ffmpeg(["-i", `${id}.wav`, "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", `${id}.m4a`], dir);
      } finally {
        await fs.rm(wav, { force: true });
      }
      tracks.push({
        id,
        style,
        title: TITLES[style][i],
        file: `${id}.m4a`,
        durationSec: Math.round(piece.durationSec * 10) / 10,
        bpm: piece.bpm,
        key: piece.key,
      });
      log(
        `музыка: ${id} «${TITLES[style][i]}» — ${piece.durationSec.toFixed(0)} с, ${piece.bpm} bpm, ${piece.key}, ` +
          `пик ${stats.peak.toFixed(2)}, rms ${stats.rms.toFixed(3)} (${((Date.now() - t0) / 1000).toFixed(1)} с)`,
      );
    }
  }

  await fs.writeFile(path.join(dir, "library.json"), JSON.stringify({ version: LIBRARY_VERSION, tracks } satisfies Manifest), "utf8");
  return tracks;
}

/** Создаёт библиотеку, если её ещё нет или она устарела. Возвращает true, если пришлось создавать. */
export async function ensureMusicLibrary(log: (msg: string) => void = console.log): Promise<boolean> {
  const state = await readState(MUSIC_DIR);
  if (state && state.version === LIBRARY_VERSION && state.tracks.length > 0) {
    const present = await Promise.all(
      state.tracks.map((t) => fs.access(path.join(MUSIC_DIR, t.file)).then(() => true, () => false)),
    );
    if (present.every(Boolean)) return false;
  }
  log("создаю музыкальную библиотеку (один раз, около минуты)…");
  await generateMusicLibrary(log);
  return true;
}
