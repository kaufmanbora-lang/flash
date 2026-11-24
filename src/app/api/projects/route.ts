import { createProject, createProjectSchema, listProjects } from "@/lib/project-service";
import { clientToday, readJson, route } from "@/server/api";

export const GET = route(async ({ req, user }) => {
  const status = req.nextUrl.searchParams.get("status");
  const filter = status === "open" || status === "completed" ? status : undefined;
  return { projects: await listProjects(user.id, clientToday(req, user), filter) };
});

export const POST = route(async ({ req, user }) => {
  const input = await readJson(req, createProjectSchema);
  const today = clientToday(req, user, input.today);
  const project = await createProject(user.id, { ...input, today });
  return { id: project.id };
});
