import { loadMusicLibrary } from "@/lib/music-library";
import type { MusicTrackDto } from "@/lib/types";
import { route } from "@/server/api";

/** Список композиций для предпрослушивания в настройках фильма. */
export const GET = route(async () => {
  const tracks = await loadMusicLibrary();
  return {
    tracks: tracks.map(
      (t): MusicTrackDto => ({
        id: t.id,
        style: t.style,
        title: t.title,
        durationSec: t.durationSec,
        url: `/api/music/${t.id}`,
      }),
    ),
  };
});
