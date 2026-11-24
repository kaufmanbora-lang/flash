import { deleteProject, getProjectDetail, updateProject, updateProjectSchema } from "@/lib/project-service";
import { clientToday, readJson, route, uuidParam } from "@/server/api";

type Params = { id: string };

export const GET = route<Params>(async ({ req, user, settings, params }) => ({
  project: await getProjectDetail(user.id, uuidParam(params.id), clientToday(req, user), settings),
}));

/** Правка проекта и действия: пауза, продолжение, продление, досрочное завершение, обложка. */
export const PATCH = route<Params>(async ({ req, user, settings, params }) => {
  const id = uuidParam(params.id);
  const input = await readJson(req, updateProjectSchema);
  const today = clientToday(req, user, input.today);
  await updateProject(user, settings, id, { ...input, today });
  return { project: await getProjectDetail(user.id, id, today, settings) };
});

export const DELETE = route<Params>(async ({ req, user, params }) => {
  const deleteFilms = req.nextUrl.searchParams.get("films") === "delete";
  await deleteProject(user.id, uuidParam(params.id), deleteFilms);
  return { ok: true };
});
