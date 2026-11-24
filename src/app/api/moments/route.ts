import { isValidYmd } from "@/lib/dates";
import { initUpload, initUploadSchema, listMoments } from "@/lib/moment-service";
import { readJson, route, uuidParam } from "@/server/api";

export const GET = route(async ({ req, user }) => {
  const sp = req.nextUrl.searchParams;
  const pick = (name: string) => {
    const v = sp.get(name);
    return v && isValidYmd(v) ? v : undefined;
  };
  const project = sp.get("project");
  const moments = await listMoments(user.id, {
    date: pick("date"),
    from: pick("from"),
    to: pick("to"),
    search: sp.get("q") ?? undefined,
    favorite: sp.get("favorite") === "1",
    projectId: project ? uuidParam(project) : undefined,
    limit: Number(sp.get("limit")) || undefined,
    offset: Number(sp.get("offset")) || undefined,
    order: sp.get("order") === "asc" ? "asc" : "desc",
  });
  return { moments };
});

/** Начало (или продолжение) загрузки момента. */
export const POST = route(async ({ req, user }) => {
  const input = await readJson(req, initUploadSchema);
  return initUpload(user.id, input);
});
