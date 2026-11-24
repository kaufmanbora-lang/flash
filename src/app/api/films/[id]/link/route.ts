import { safeFileName } from "@/lib/dto";
import { conflict } from "@/lib/errors";
import { getFilmRow } from "@/lib/film-service";
import { signMediaUrl } from "@/lib/signing";
import { route, uuidParam } from "@/server/api";

const DAYS = 7;

/**
 * Временная ссылка на фильм, которой владелец может поделиться сам.
 * Ссылка подписана, открывает только этот файл и перестаёт работать через неделю.
 */
export const POST = route<{ id: string }>(async ({ user, params }) => {
  const film = await getFilmRow(user.id, uuidParam(params.id));
  if (!film.file_key) throw conflict("not_ready");
  const url = signMediaUrl(film.file_key, { ttlSec: DAYS * 86_400, download: `${safeFileName(film.title)}.mp4` });
  return { url, days: DAYS };
});
