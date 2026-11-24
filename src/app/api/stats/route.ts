import { statsData } from "@/lib/home-service";
import { onThisDay } from "@/lib/moment-service";
import { clientToday, route } from "@/server/api";

/** Статистика архива и подборка «В этот день». */
export const GET = route(async ({ req, user }) => {
  const today = clientToday(req, user);
  const [stats, memories] = await Promise.all([statsData(user.id, today), onThisDay(user.id, today)]);
  return { stats, onThisDay: memories };
});
