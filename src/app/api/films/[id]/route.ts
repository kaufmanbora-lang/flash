import { filmDto } from "@/lib/dto";
import { deleteFilm, filmOptionsSchema, getFilmRow, rerenderFilm } from "@/lib/film-service";
import { readJson, route, uuidParam } from "@/server/api";

type Params = { id: string };

export const GET = route<Params>(async ({ user, params }) => ({
  film: filmDto(await getFilmRow(user.id, uuidParam(params.id))),
}));

/** Пересобирает фильм: с новыми моментами, другой музыкой или стилем. */
export const PATCH = route<Params>(async ({ req, user, settings, params }) => {
  const input = await readJson(req, filmOptionsSchema);
  const film = await rerenderFilm(user, settings, uuidParam(params.id), input);
  return { film: filmDto(film) };
});

export const DELETE = route<Params>(async ({ user, params }) => {
  await deleteFilm(user.id, uuidParam(params.id));
  return { ok: true };
});
