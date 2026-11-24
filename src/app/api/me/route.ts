import { isLocale } from "@/i18n";
import { MAX_MOMENTS_PER_DAY, MIN_MOMENT_MS, UPLOAD_CHUNK_BYTES } from "@/lib/constants";
import { isValidTimeZone } from "@/lib/dates";
import { exec, q1 } from "@/lib/db";
import { env } from "@/lib/env";
import { getVapid } from "@/lib/push";
import type { MeDto } from "@/lib/types";
import { profileSchema } from "@/lib/user-service";
import { readJson, route } from "@/server/api";

export const GET = route(async ({ user, settings }): Promise<MeDto> => {
  const vapid = await getVapid().catch((err) => {
    console.error("[push] VAPID недоступен:", err);
    return null;
  });
  const devices = await q1<{ n: number }>(`SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1`, [
    user.id,
  ]);
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      timezone: user.timezone,
      locale: user.locale,
      createdAt: user.created_at.toISOString(),
    },
    settings,
    limits: {
      maxPerDay: MAX_MOMENTS_PER_DAY,
      minMomentMs: MIN_MOMENT_MS,
      chunkBytes: UPLOAD_CHUNK_BYTES,
      quotaBytes: env.storageQuotaBytes,
    },
    push: { publicKey: vapid?.publicKey ?? null, devices: devices?.n ?? 0 },
  };
});

export const PATCH = route(async ({ req, user }) => {
  const input = await readJson(req, profileSchema);
  const timezone = isValidTimeZone(input.timezone) ? input.timezone : null;
  const locale = isLocale(input.locale) ? input.locale : null;
  await exec(
    `UPDATE users SET name = COALESCE($2, name), timezone = COALESCE($3, timezone), locale = COALESCE($4, locale) WHERE id = $1`,
    [user.id, input.name ?? null, timezone, locale],
  );
  if (timezone && timezone !== user.timezone) {
    // Часовой пояс изменился — план напоминаний на сегодня пересчитается.
    await exec(`DELETE FROM push_plan WHERE user_id = $1 AND status = 'pending'`, [user.id]);
  }
  return { ok: true };
});
