import { z } from "zod";
import { exec } from "@/lib/db";
import { readJson, route } from "@/server/api";

const schema = z.object({ endpoint: z.string().max(1000) });

export const POST = route(async ({ req, user }) => {
  const input = await readJson(req, schema);
  await exec(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [user.id, input.endpoint]);
  return { ok: true };
});
