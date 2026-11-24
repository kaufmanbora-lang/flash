import { z } from "zod";
import { FILM_STYLES, MUSIC_STYLES, ORIENTATIONS, RESOLUTIONS } from "./constants";

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Время в формате ЧЧ:ММ");

export const styleChoice = z.enum(["auto", ...FILM_STYLES]);
export const musicChoice = z.enum(["auto", "none", ...MUSIC_STYLES]);
export type StyleChoice = z.infer<typeof styleChoice>;
export type MusicChoice = z.infer<typeof musicChoice>;

export interface UserSettings {
  notifications: {
    /** Напоминания добавлены в календарь телефона (отметка для подсказок в интерфейсе). */
    enabled: boolean;
    perDay: number;
    mode: "random" | "fixed";
    fixedTimes: string[];
    activeFrom: string;
    activeTo: string;
    quietEnabled: boolean;
    quietFrom: string;
    quietTo: string;
  };
  dailyFilm: {
    enabled: boolean;
    time: string;
    variant: "full" | "highlights";
    notify: boolean;
  };
  film: {
    style: StyleChoice;
    music: MusicChoice;
    musicVolume: number;
    orientation: (typeof ORIENTATIONS)[number];
    resolution: (typeof RESOLUTIONS)[number];
  };
  onboarding: {
    pushPromptDismissed: boolean;
    installHintDismissed: boolean;
  };
}

export const DEFAULT_SETTINGS: UserSettings = {
  notifications: {
    enabled: false,
    perDay: 3,
    mode: "random",
    fixedTimes: ["10:00", "15:00", "20:00"],
    activeFrom: "09:00",
    activeTo: "21:30",
    quietEnabled: true,
    quietFrom: "22:30",
    quietTo: "08:00",
  },
  dailyFilm: {
    enabled: true,
    time: "21:30",
    variant: "full",
    notify: true,
  },
  film: {
    style: "auto",
    music: "auto",
    musicVolume: 0.5,
    orientation: "auto",
    resolution: "auto",
  },
  onboarding: {
    pushPromptDismissed: false,
    installHintDismissed: false,
  },
};

export const settingsPatchSchema = z
  .object({
    notifications: z
      .object({
        enabled: z.boolean(),
        perDay: z.number().int().min(1).max(6),
        mode: z.enum(["random", "fixed"]),
        fixedTimes: z.array(hm).min(1).max(6),
        activeFrom: hm,
        activeTo: hm,
        quietEnabled: z.boolean(),
        quietFrom: hm,
        quietTo: hm,
      })
      .partial(),
    dailyFilm: z
      .object({
        enabled: z.boolean(),
        time: hm,
        variant: z.enum(["full", "highlights"]),
        notify: z.boolean(),
      })
      .partial(),
    film: z
      .object({
        style: styleChoice,
        music: musicChoice,
        musicVolume: z.number().min(0).max(1),
        orientation: z.enum(ORIENTATIONS),
        resolution: z.enum(RESOLUTIONS),
      })
      .partial(),
    onboarding: z
      .object({
        pushPromptDismissed: z.boolean(),
        installHintDismissed: z.boolean(),
      })
      .partial(),
  })
  .partial();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Сохранённые настройки поверх значений по умолчанию; неизвестные и битые поля отбрасываются. */
export function resolveSettings(stored: unknown): UserSettings {
  const out: UserSettings = structuredClone(DEFAULT_SETTINGS);
  if (!isObject(stored)) return out;
  const parsed = settingsPatchSchema.safeParse(stored);
  const src = parsed.success ? parsed.data : {};
  return applyPatch(out, src);
}

export function applyPatch(base: UserSettings, patch: SettingsPatch): UserSettings {
  const next: UserSettings = structuredClone(base);
  if (patch.notifications) Object.assign(next.notifications, patch.notifications);
  if (patch.dailyFilm) Object.assign(next.dailyFilm, patch.dailyFilm);
  if (patch.film) Object.assign(next.film, patch.film);
  if (patch.onboarding) Object.assign(next.onboarding, patch.onboarding);
  next.notifications.fixedTimes = [...new Set(next.notifications.fixedTimes)].sort();
  return next;
}
