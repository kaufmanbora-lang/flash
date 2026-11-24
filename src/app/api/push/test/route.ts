import { getDict } from "@/i18n";
import { sendPush } from "@/lib/push";
import { rateLimit, route } from "@/server/api";

/** Пробное уведомление на все устройства пользователя. */
export const POST = route(async ({ user }) => {
  rateLimit(`push-test:${user.id}`, 6, 60_000);
  const t = getDict(user.locale).push;
  const delivered = await sendPush(
    user.id,
    { title: t.testTitle, body: t.testBody, url: "/settings", kind: "test", tag: "flash-test" },
    { ttlSec: 120, urgency: "high" },
  );
  return { delivered: Math.max(0, delivered) };
});
