import { momentDto } from "@/lib/dto";
import { deleteMoment, getMoment, updateMoment, updateMomentSchema } from "@/lib/moment-service";
import { readJson, route, uuidParam } from "@/server/api";

type Params = { id: string };

export const GET = route<Params>(async ({ user, params }) => ({
  moment: momentDto(await getMoment(user.id, uuidParam(params.id))),
}));

export const PATCH = route<Params>(async ({ req, user, params }) => {
  const input = await readJson(req, updateMomentSchema);
  return { moment: await updateMoment(user.id, uuidParam(params.id), input) };
});

export const DELETE = route<Params>(async ({ user, params }) => {
  await deleteMoment(user.id, uuidParam(params.id));
  return { ok: true };
});
