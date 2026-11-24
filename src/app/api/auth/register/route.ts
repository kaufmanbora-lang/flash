import { clientIp, rateLimit, readJson, route, setSessionCookies } from "@/server/api";
import { createSession, registerSchema, registerUser } from "@/lib/user-service";

export const POST = route(
  async ({ req }) => {
    rateLimit(`register:${clientIp(req)}`, 10, 3_600_000);
    const input = await readJson(req, registerSchema);
    const user = await registerUser(input);
    const { token } = await createSession(user.id, req.headers.get("user-agent") ?? "");
    await setSessionCookies(token);
    return { ok: true };
  },
  { auth: false },
);
