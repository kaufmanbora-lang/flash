// Профиль и настройки. Аккаунтов нет: дневник принадлежит тому, у кого в руках устройство.

import { isLocale } from "@/i18n";
import { MAX_MOMENTS_PER_DAY, MIN_MOMENT_MS } from "@/lib/constants";
import { deviceTimeZone, isValidTimeZone } from "@/lib/dates";
import { ApiError, badRequest } from "@/lib/errors";
import { applyPatch, resolveSettings, settingsPatchSchema, type UserSettings } from "@/lib/settings";
import type { MeDto } from "@/lib/types";
import { nowIso } from "./core";
import { store, type ProfileRec } from "./store";

const cleanName = (name: unknown): string => (typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, 60) : "");

export function currentSettings(): UserSettings {
  return resolveSettings(store.profile?.settings);
}

export function currentLocale(): string {
  return store.profile?.locale ?? "ru";
}

function toMe(profile: ProfileRec): MeDto {
  return {
    user: { name: profile.name, timezone: profile.timezone, locale: profile.locale, createdAt: profile.createdAt },
    settings: resolveSettings(profile.settings),
    limits: { maxPerDay: MAX_MOMENTS_PER_DAY, minMomentMs: MIN_MOMENT_MS },
  };
}

/** Профиль ещё не создан — интерфейс покажет приветствие и спросит имя. */
export function getMe(): MeDto {
  if (!store.profile) throw new ApiError(404, "no_profile");
  return toMe(store.profile);
}

export async function createProfile(input: { name?: unknown; timezone?: unknown; locale?: unknown }): Promise<MeDto> {
  const name = cleanName(input.name);
  if (!name) throw badRequest("name_required");
  const existing = store.profile;
  const profile: ProfileRec = {
    name,
    timezone: isValidTimeZone(input.timezone) ? input.timezone : deviceTimeZone(),
    locale: isLocale(input.locale) ? input.locale : (existing?.locale ?? "ru"),
    settings: existing?.settings ?? {},
    createdAt: existing?.createdAt ?? nowIso(),
  };
  await store.saveProfile(profile);
  return toMe(profile);
}

export async function updateProfile(input: { name?: unknown; timezone?: unknown; locale?: unknown }): Promise<MeDto> {
  const profile = store.profile;
  if (!profile) throw new ApiError(404, "no_profile");
  const next: ProfileRec = { ...profile };
  if (input.name !== undefined) {
    const name = cleanName(input.name);
    if (!name) throw badRequest("name_required");
    next.name = name;
  }
  if (isValidTimeZone(input.timezone)) next.timezone = input.timezone;
  if (isLocale(input.locale)) next.locale = input.locale;
  await store.saveProfile(next);
  return toMe(next);
}

export async function patchSettings(patch: unknown): Promise<{ settings: UserSettings }> {
  const profile = store.profile;
  if (!profile) throw new ApiError(404, "no_profile");
  const parsed = settingsPatchSchema.safeParse(patch);
  if (!parsed.success) throw badRequest("validation");
  const settings = applyPatch(resolveSettings(profile.settings), parsed.data);
  await store.saveProfile({ ...profile, settings });
  return { settings };
}
