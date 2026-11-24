import { clearSessionCookies, route, sessionToken } from "@/server/api";
import { destroySession } from "@/lib/user-service";

export const POST = route(
  async () => {
    await destroySession(await sessionToken());
    await clearSessionCookies();
    return { ok: true };
  },
  { auth: false },
);
