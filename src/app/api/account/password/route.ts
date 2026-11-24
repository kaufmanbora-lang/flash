import { changePassword, passwordChangeSchema } from "@/lib/user-service";
import { rateLimit, readJson, route } from "@/server/api";

export const POST = route(async ({ req, user, token }) => {
  rateLimit(`password:${user.id}`, 8, 600_000);
  const input = await readJson(req, passwordChangeSchema);
  await changePassword(user, input.current, input.next, token);
  return { ok: true };
});
