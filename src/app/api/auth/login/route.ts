import { clientIp, rateLimit, readJson, route, setSessionCookies } from "@/server/api";
import { createSession, loginSchema, loginUser } from "@/lib/user-service";

export const POST = route(
  async ({ req }) => {
    const input = await readJson(req, loginSchema);
    // Перебор пароля ограничиваем и по адресу, и по почте.
    rateLimit(`login:ip:${clientIp(req)}`, 40, 600_000);
    rateLimit(`login:email:${input.email}`, 10, 600_000);
    const user = await loginUser(input);
    const { token } = await createSession(user.id, req.headers.get("user-agent") ?? "");
    await setSessionCookies(token);
    return { ok: true };
  },
  { auth: false },
);
