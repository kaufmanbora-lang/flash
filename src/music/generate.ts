// Создание музыкальной библиотеки: по три оригинальные композиции на каждый из семи стилей.
// Синтез → WAV → AAC (.m4a) через ffmpeg. Результат — файлы в assets/music и manifest.json.

import fs from "node:fs/promises";
import path from "node:path";
import { MUSIC_STYLES, type MusicStyleId } from "@/lib/constants";
import { env } from "@/lib/env";
import type { MusicTrack } from "@/lib/music-library";
import { ffmpeg } from "@/worker/ffmpeg";
import { compose } from "./compose";
import { encodeWav, measure } from "./synth";

/** Версия набора: при изменении синтезатора увеличьте, и библиотека пересоздастся. */
const LIBRARY_VERSION = 1;

const TITLES: Record<MusicStyleId, string[]> = {
  "relaxing-piano": ["Morning Window", "Quiet Tea", "Slow Sunday"],
  "soft-ambient": ["First Light", "Still Water", "Open Sky"],
  "warm-memories": ["Old Photographs", "Home Again", "Golden Hour"],
  "chill-acoustic": ["Porch Light", "Coastal Road", "Lazy Afternoon"],
  "dreamy-cinematic": ["Far Horizon", "Night Train", "Snowfall"],
  nostalgia: ["Music Box", "Paper Boats", "Carousel"],
  "happy-moments": ["Sunny Side", "Picnic", "Little Things"],
};

interface Manifest {
  version: number;
  tracks: MusicTrack[];
}

async function readState(dir: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "library.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

export async function generateMusicLibrary(
  log: (msg: string) => void = console.log,
  only?: MusicStyleId[],
): Promise<MusicTrack[]> {
  const dir = env.musicDir;
  await fs.mkdir(dir, { recursive: true });
  const tracks: MusicTrack[] = [];
  const styles = only ?? [...MUSIC_STYLES];

  for (const style of styles) {
    for (let i = 0; i < TITLES[style].length; i++) {
      const id = `${style}-${i + 1}`;
      const seed = 1009 * (MUSIC_STYLES.indexOf(style) + 1) + 97 * (i + 1) + LIBRARY_VERSION;
      const t0 = Date.now();
      const piece = compose(style, seed);
      const stats = measure(piece.audio);
      if (!(stats.rms > 0.01) || !Number.isFinite(stats.peak)) {
        throw new Error(`Композиция ${id} получилась пустой (rms=${stats.rms})`);
      }
      const wav = path.join(dir, `${id}.wav`);
      await fs.writeFile(wav, encodeWav(piece.audio));
      try {
        await ffmpeg(["-i", `${id}.wav`, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", `${id}.m4a`], { cwd: dir });
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
      // Даём циклу событий вздохнуть: воркер продолжает отвечать на health-запросы.
      await new Promise((r) => setImmediate(r));
    }
  }

  if (!only) {
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(tracks, null, 2), "utf8");
    await fs.writeFile(path.join(dir, "library.json"), JSON.stringify({ version: LIBRARY_VERSION, tracks } satisfies Manifest), "utf8");
  }
  return tracks;
}

/** Создаёт библиотеку, если её ещё нет или она устарела. */
export async function ensureMusicLibrary(log: (msg: string) => void = console.log): Promise<void> {
  const dir = env.musicDir;
  const state = await readState(dir);
  if (state && state.version === LIBRARY_VERSION) {
    const present = await Promise.all(
      state.tracks.map((t) => fs.access(path.join(dir, t.file)).then(() => true, () => false)),
    );
    if (present.every(Boolean) && state.tracks.length > 0) return;
  }
  log("создаю музыкальную библиотеку (один раз, около минуты)…");
  await generateMusicLibrary(log);
}
