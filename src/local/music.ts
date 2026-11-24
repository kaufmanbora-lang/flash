// Музыкальная библиотека: оригинальные композиции, созданные скриптом scripts/generate-music.ts.
// Файлы лежат рядом с приложением (public/music) и скачиваются, только когда нужны фильму или прослушиванию.

import { withBase } from "@/lib/base";
import { MUSIC_STYLES, type MusicStyleId } from "@/lib/constants";
import type { MusicChoice } from "@/lib/settings";
import type { MusicTrackDto } from "@/lib/types";
import { store } from "./store";

export interface MusicTrack {
  id: string;
  style: MusicStyleId;
  title: string;
  file: string;
  durationSec: number;
}

/** Перекрытие соседних композиций при плавном переходе, секунды. */
export const MUSIC_CROSSFADE_SEC = 4;

let cache: Promise<MusicTrack[]> | null = null;

function isTrack(t: unknown): t is MusicTrack {
  const x = t as MusicTrack | null;
  return (
    typeof x === "object" &&
    x !== null &&
    typeof x.id === "string" &&
    /^[a-z0-9-]{1,64}$/.test(x.id) &&
    typeof x.file === "string" &&
    /^[a-z0-9-]+\.[a-z0-9]+$/.test(x.file) &&
    (MUSIC_STYLES as readonly string[]).includes(x.style) &&
    Number.isFinite(x.durationSec) &&
    x.durationSec > 5
  );
}

export function loadMusicLibrary(): Promise<MusicTrack[]> {
  cache ??= fetch(withBase("/music/library.json"))
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as { tracks?: unknown };
      return Array.isArray(raw.tracks) ? raw.tracks.filter(isTrack) : [];
    })
    .catch(() => {
      // Библиотека не скачалась (нет сети и она ещё не в кэше) — попробуем в следующий раз.
      cache = null;
      return [];
    });
  return cache;
}

export const trackUrl = (track: Pick<MusicTrack, "file">): string => withBase(`/music/${track.file}`);

export async function listMusic(): Promise<MusicTrackDto[]> {
  return (await loadMusicLibrary()).map((t) => ({
    id: t.id,
    style: t.style,
    title: t.title,
    durationSec: t.durationSec,
    url: trackUrl(t),
  }));
}

function hashNumber(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Плейлист, покрывающий всю длительность фильма: стиль и композиции чередуются, чтобы один и тот же
 * трек не звучал постоянно. Для длинных фильмов это несколько композиций одного стиля.
 */
export function choosePlaylist(
  library: MusicTrack[],
  recentlyUsed: string[][],
  filmId: string,
  choice: MusicChoice,
  durationSec: number,
): MusicTrack[] {
  if (choice === "none" || library.length === 0) return [];

  // Чем меньше ранг, тем недавнее трек звучал; не звучавшие получают Infinity.
  const rank = new Map<string, number>();
  let position = 0;
  for (const used of recentlyUsed) {
    for (const id of used) if (!rank.has(id)) rank.set(id, position++);
  }
  const trackRank = (t: MusicTrack) => rank.get(t.id) ?? Number.POSITIVE_INFINITY;
  const seed = hashNumber(filmId);

  const stylesAvailable = MUSIC_STYLES.filter((s) => library.some((t) => t.style === s));
  if (stylesAvailable.length === 0) return [];
  let style: MusicStyleId;
  if (choice !== "auto" && stylesAvailable.includes(choice)) {
    style = choice;
  } else {
    // «Авто»: стиль, который дольше всех не звучал.
    const styleRank = (s: MusicStyleId) => Math.min(...library.filter((t) => t.style === s).map(trackRank));
    const rotated = stylesAvailable.map((_, i) => stylesAvailable[(i + seed) % stylesAvailable.length]);
    style = rotated.reduce((best, s) => (styleRank(s) > styleRank(best) ? s : best), rotated[0]);
  }

  const tracks = library
    .filter((t) => t.style === style)
    .map((t, i) => ({ t, order: (i + seed) % 997 }))
    .sort((a, b) => {
      const ra = trackRank(a.t);
      const rb = trackRank(b.t);
      if (ra !== rb) return ra > rb ? -1 : 1;
      return a.order - b.order;
    })
    .map((x) => x.t);
  if (tracks.length === 0) return [];

  const playlist: MusicTrack[] = [];
  let covered = 0;
  for (let i = 0; covered < durationSec + 1 && i < 96; i++) {
    const track = tracks[i % tracks.length];
    playlist.push(track);
    covered += track.durationSec - (playlist.length > 1 ? MUSIC_CROSSFADE_SEC : 0);
  }
  return playlist;
}

/** Музыка для фильма с учётом того, что звучало в последних двадцати фильмах. */
export async function pickMusic(filmId: string, choice: MusicChoice, durationSec: number): Promise<MusicTrack[]> {
  if (choice === "none") return [];
  const library = await loadMusicLibrary();
  const recent = [...store.films.values()]
    .filter((f) => f.id !== filmId && f.renderedAt)
    .sort((a, b) => ((a.renderedAt ?? "") < (b.renderedAt ?? "") ? 1 : -1))
    .slice(0, 20)
    .map((f) => f.musicUsed);
  return choosePlaylist(library, recent, filmId, choice, durationSec);
}
