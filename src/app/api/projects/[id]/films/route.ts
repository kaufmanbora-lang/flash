import { filmDto } from "@/lib/dto";
import { createProjectFilm, createProjectFilmSchema } from "@/lib/film-service";
import { getProjectRow } from "@/lib/project-service";
import { clientToday, readJson, route, uuidParam } from "@/server/api";

/** Создаёт (или пересобирает) версию фильма проекта: трейлер, мини, расширенный или полный. */
export const POST = route<{ id: string }>(async ({ req, user, settings, params }) => {
  const input = await readJson(req, createProjectFilmSchema);
  const project = await getProjectRow(user.id, uuidParam(params.id));
  const { variant, ...options } = input;
  const film = await createProjectFilm(user, settings, project, variant, options, {
    today: clientToday(req, user),
  });
  return { film: filmDto(film) };
});
