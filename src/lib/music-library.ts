// Музыкальная библиотека: оригинальные композиции, созданные скриптом scripts/generate-music.ts,
// плюс собственные треки пользователя сервера (assets/music/custom.json — тот же формат).

import fs from "node:fs/promises";
import path from "node:path";
import { MUSIC_STYLES, type MusicStyleId } from "./constants";
import { env } from "./env";

export interface MusicTrack {
  id: string;
  style: MusicStyleId;
  title: string;
  file: string;
  durationSec: number;
  bpm?: number;
  key?: string;
}

let cache: { at: number; tracks: MusicTrack[] } | null = null;

async function readManifest(file: string): Promise<MusicTrack[]> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (t): t is MusicTrack =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as MusicTrack).id === "string" &&
        /^[a-z0-9-]{1,64}$/.test((t as MusicTrack).id) &&
        typeof (t as MusicTrack).file === "string" &&
        !(t as MusicTrack).file.includes("..") &&
        (MUSIC_STYLES as readonly string[]).includes((t as MusicTrack).style) &&
        Number.isFinite((t as MusicTrack).durationSec),
    );
  } catch {
    return [];
  }
}

export async function loadMusicLibrary(force = false): Promise<MusicTrack[]> {
  if (!force && cache && Date.now() - cache.at < 30_000) return cache.tracks;
  const dir = env.musicDir;
  const all = [
    ...(await readManifest(path.join(dir, "manifest.json"))),
    ...(await readManifest(path.join(dir, "custom.json"))),
  ];
  const tracks: MusicTrack[] = [];
  const seen = new Set<string>();
  for (const t of all) {
    if (seen.has(t.id)) continue;
    try {
      await fs.access(path.join(dir, t.file));
      tracks.push(t);
      seen.add(t.id);
    } catch {
      /* файла нет — трек пропускаем */
    }
  }
  cache = { at: Date.now(), tracks };
  return tracks;
}

export function trackPath(track: MusicTrack): string {
  return path.join(env.musicDir, track.file);
}
