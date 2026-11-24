import fs from "node:fs";
import fsp from "node:fs/promises";
import { notFound } from "@/lib/errors";
import { loadMusicLibrary, trackPath } from "@/lib/music-library";
import { contentTypeForKey } from "@/lib/storage";
import { route } from "@/server/api";
import { serveBytes } from "@/server/range";

/** Отдаёт композицию для предпрослушивания (с поддержкой перемотки). */
export const GET = route<{ id: string }>(async ({ req, params }) => {
  const track = (await loadMusicLibrary()).find((t) => t.id === params.id);
  if (!track) throw notFound("track_not_found");
  const file = trackPath(track);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) throw notFound("track_not_found");
  return serveBytes({
    size: stat.size,
    contentType: contentTypeForKey(file),
    rangeHeader: req.headers.get("range"),
    open: async (range) => fs.createReadStream(file, range ? { start: range.start, end: range.end } : undefined),
    cacheControl: "private, max-age=86400",
  });
});
