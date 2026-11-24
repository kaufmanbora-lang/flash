import { z } from "zod";
import { exec } from "@/lib/db";
import { badRequest } from "@/lib/errors";
import { readJson, route } from "@/server/api";

const schema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(20).max(200),
    auth: z.string().min(8).max(100),
  }),
});

// Сервер шлёт запросы только на адреса настоящих push-сервисов браузеров.
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
  ".push.apple.com",
  ".notify.windows.com",
  ".push.services.mozilla.com",
];

function isPushServiceUrl(endpoint: string): boolean {
  if (process.env.PUSH_ALLOW_ANY_ENDPOINT === "1" && process.env.NODE_ENV !== "production") return true;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") return false;
    return PUSH_HOSTS.some((h) => (h.startsWith(".") ? url.hostname.endsWith(h) : url.hostname === h));
  } catch {
    return false;
  }
}

/** Сохраняет push-подписку этого устройства за текущим пользователем. */
export const POST = route(async ({ req, user }) => {
  const input = await readJson(req, schema);
  if (!isPushServiceUrl(input.endpoint)) throw badRequest("bad_push_endpoint");
  await exec(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent, failures = 0`,
    [user.id, input.endpoint, input.keys.p256dh, input.keys.auth, (req.headers.get("user-agent") ?? "").slice(0, 300)],
  );
  return { ok: true };
});
