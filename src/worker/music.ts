// Подбор музыки к фильму: стиль и композиции чередуются, чтобы один и тот же трек не звучал постоянно.

import { MUSIC_STYLES, type MusicStyleId } from "@/lib/constants";
import { q } from "@/lib/db";
import { loadMusicLibrary, type MusicTrack } from "@/lib/music-library";
import type { MusicChoice } from "@/lib/settings";

/** Перекрытие соседних композиций при плавном переходе, секунды. */
export const MUSIC_CROSSFADE_SEC = 4;

function hashNumber(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Возвращает плейлист, покрывающий всю длительность фильма.
 * Для длинных фильмов это несколько композиций одного стиля, которые плавно сменяют друг друга.
 */
export async function pickMusic(
  userId: string,
  filmId: string,
  choice: MusicChoice,
  durationSec: number,
): Promise<MusicTrack[]> {
  if (choice === "none") return [];
  const library = await loadMusicLibrary();
  if (library.length === 0) return [];

  const recentRows = await q<{ music_used: string[] }>(
    `SELECT music_used FROM films
     WHERE user_id = $1 AND id <> $2 AND rendered_at IS NOT NULL
     ORDER BY rendered_at DESC LIMIT 20`,
    [userId, filmId],
  );
  // Чем меньше ранг, тем недавнее трек звучал; не звучавшие получают Infinity.
  const rank = new Map<string, number>();
  let position = 0;
  for (const row of recentRows) {
    for (const id of row.music_used ?? []) {
      if (!rank.has(id)) rank.set(id, position++);
    }
  }
  const trackRank = (t: MusicTrack) => rank.get(t.id) ?? Number.POSITIVE_INFINITY;
  const seed = hashNumber(filmId);

  const stylesAvailable = MUSIC_STYLES.filter((s) => library.some((t) => t.style === s));
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
