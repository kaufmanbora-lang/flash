import { exec } from "@/lib/db";
import { applyPatch, settingsPatchSchema } from "@/lib/settings";
import { readJson, route } from "@/server/api";

export const PATCH = route(async ({ req, user, settings }) => {
  const patch = await readJson(req, settingsPatchSchema);
  const next = applyPatch(settings, patch);
  await exec(`UPDATE users SET settings = $2::jsonb WHERE id = $1`, [user.id, JSON.stringify(next)]);
  if (patch.notifications) {
    // Ещё не отправленные напоминания планируются заново по новым правилам.
    await exec(`DELETE FROM push_plan WHERE user_id = $1 AND status = 'pending'`, [user.id]);
  }
  return { settings: next };
});
