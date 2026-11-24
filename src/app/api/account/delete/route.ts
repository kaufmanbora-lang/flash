import { z } from "zod";
import { deleteUserData } from "@/lib/user-service";
import { clearSessionCookies, rateLimit, readJson, route } from "@/server/api";

const schema = z.object({
  password: z.string().min(1).max(200),
  /** data — стереть все записи, фильмы и проекты; account — удалить и сам аккаунт. */
  scope: z.enum(["data", "account"]),
});

export const POST = route(async ({ req, user }) => {
  rateLimit(`delete:${user.id}`, 5, 600_000);
  const input = await readJson(req, schema);
  await deleteUserData(user, input.password, input.scope);
  if (input.scope === "account") await clearSessionCookies();
  return { ok: true };
});
