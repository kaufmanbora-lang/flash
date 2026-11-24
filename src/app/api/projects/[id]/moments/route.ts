import { z } from "zod";
import { setProjectMoment } from "@/lib/project-service";
import { readJson, route, uuidParam } from "@/server/api";

const schema = z.object({ momentId: z.string().uuid(), include: z.boolean() });

/** Добавляет момент в проект или убирает из него. Само видео при этом не копируется. */
export const POST = route<{ id: string }>(async ({ req, user, params }) => {
  const input = await readJson(req, schema);
  await setProjectMoment(user.id, uuidParam(params.id), input.momentId, input.include);
  return { ok: true };
});
