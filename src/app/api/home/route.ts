import { homeData } from "@/lib/home-service";
import { clientToday, route } from "@/server/api";

export const GET = route(async ({ req, user }) => homeData(user.id, clientToday(req, user)));
