import { diffDays, isValidYmd } from "@/lib/dates";
import { badRequest } from "@/lib/errors";
import { daySummaries } from "@/lib/moment-service";
import { route, uuidParam } from "@/server/api";

/** Сводка по дням за период: сколько моментов, общая длительность, кадр для превью. */
export const GET = route(async ({ req, user }) => {
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  if (!isValidYmd(from) || !isValidYmd(to) || to < from) throw badRequest("bad_range");
  if (diffDays(to, from) > 800) throw badRequest("range_too_long");
  const project = sp.get("project");
  return { days: await daySummaries(user.id, from, to, project ? uuidParam(project) : undefined) };
});
