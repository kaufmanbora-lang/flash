// Локализация. Чтобы добавить язык:
//   1. скопируйте ru.ts в <код>.ts и переведите значения (тип Dict не даст пропустить ключ);
//   2. зарегистрируйте словарь в LOCALES ниже.
// Интерфейс, тексты напоминаний и титры фильмов берут строки из одного словаря.

import { ru } from "./ru";

export type Dict = typeof ru;

export const LOCALES = {
  ru: { name: "Русский", dict: ru },
} as const satisfies Record<string, { name: string; dict: Dict }>;

export type Locale = keyof typeof LOCALES;

export const DEFAULT_LOCALE: Locale = "ru";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && value in LOCALES;
}

export function getDict(locale?: string | null): Dict {
  return isLocale(locale) ? LOCALES[locale].dict : LOCALES[DEFAULT_LOCALE].dict;
}
