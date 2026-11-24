import { filmDto } from "@/lib/dto";
import { createFilm, createFilmSchema, listFilms } from "@/lib/film-service";
import { readJson, route, uuidParam } from "@/server/api";

export const GET = route(async ({ req, user }) => {
  const project = req.nextUrl.searchParams.get("project");
  return { films: await listFilms(user.id, { projectId: project ? uuidParam(project) : undefined }) };
});

/** Создаёт фильм за период и ставит монтаж в очередь. */
export const POST = route(async ({ req, user, settings }) => {
  const input = await readJson(req, createFilmSchema);
  const film = await createFilm(user, settings, input);
  return { film: filmDto(film) };
});
