// Клиент API: JSON-запросы к собственному серверу, единый формат ошибок.

import type { Dict } from "@/i18n";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message || code);
    this.name = "ApiError";
  }
}

export interface ApiInit {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (hasBody ? "POST" : "GET"),
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network", "network");
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* пустой или не-JSON ответ */
  }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth/")) {
      window.dispatchEvent(new CustomEvent("flash:unauthorized"));
    }
    throw new ApiError(res.status, String(data.error ?? "generic"), String(data.message ?? ""), data);
  }
  return data as T;
}

export const fetcher = <T,>(path: string): Promise<T> => api<T>(path);

/** Понятный текст ошибки на языке интерфейса. */
export function errorText(t: Dict, err: unknown): string {
  if (err instanceof ApiError) {
    const known = t.errors[err.code];
    if (known) return known;
    if (err.code === "validation" && err.message) return err.message;
    return t.errors.generic;
  }
  return t.errors.generic;
}

/** Текст по машинному коду ошибки (например, из статуса момента или черновика). */
export function codeText(t: Dict, code: string | null | undefined): string {
  return (code ? t.errors[code] : undefined) ?? t.errors.generic;
}

export function isOffline(err: unknown): boolean {
  return err instanceof ApiError && err.status === 0;
}
