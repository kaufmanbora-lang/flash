// Доступ к данным из интерфейса. Сервера нет: «запрос» выполняется прямо на устройстве (src/local/api.ts),
// но экраны по-прежнему обращаются к данным по адресам вида /api/home — так их проще читать и кэшировать.

import type { Dict } from "@/i18n";
import { ApiError } from "@/lib/errors";
import { localApi, type LocalInit } from "@/local/api";

export { ApiError };
export type ApiInit = LocalInit;

export function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  return localApi<T>(path, init);
}

export const fetcher = <T,>(path: string): Promise<T> => api<T>(path);

/** Понятный текст ошибки на языке интерфейса. */
export function errorText(t: Dict, err: unknown): string {
  if (err instanceof ApiError) return t.errors[err.code] ?? t.errors.generic;
  return t.errors.generic;
}

/** Текст по машинному коду ошибки (например, из статуса фильма). */
export function codeText(t: Dict, code: string | null | undefined): string {
  return (code ? t.errors[code] : undefined) ?? t.errors.generic;
}
