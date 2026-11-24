// Обёртка для обработчиков API: сессия, проверка источника запроса, единый формат ошибок.

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AUTH_FLAG_COOKIE, SESSION_COOKIE } from "@/lib/constants";
import { isValidYmd, zonedParts, type Ymd } from "@/lib/dates";
import { env } from "@/lib/env";
import { badRequest, forbidden, HttpError, unauthorized } from "@/lib/errors";
import { resolveSettings, type UserSettings } from "@/lib/settings";
import type { UserRow } from "@/lib/types";
import { SESSION_DAYS, userBySessionToken } from "@/lib/user-service";

export interface ApiContext<P> {
  req: NextRequest;
  user: UserRow;
  settings: UserSettings;
  params: P;
  /** Токен текущей сессии (для выхода и смены пароля). */
  token: string;
}

type Handler<P> = (ctx: ApiContext<P>) => Promise<Response | object | void>;

function cookieSecure(): boolean {
  return env.appUrl.startsWith("https://");
}

export async function setSessionCookies(token: string): Promise<void> {
  const jar = await cookies();
  const maxAge = SESSION_DAYS * 86_400;
  jar.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: cookieSecure(), path: "/", maxAge });
  // Несекретный флажок: интерфейс мгновенно понимает, показывать приложение или экран входа.
  jar.set(AUTH_FLAG_COOKIE, "1", { httpOnly: false, sameSite: "lax", secure: cookieSecure(), path: "/", maxAge });
}

export async function clearSessionCookies(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(AUTH_FLAG_COOKIE);
}

export async function sessionToken(): Promise<string> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? "";
}

/** Браузер присылает Origin для изменяющих запросов; чужой источник отклоняем (защита от CSRF). */
function assertSameOrigin(req: NextRequest): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbidden("bad_origin");
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  let appHost = "";
  try {
    appHost = new URL(env.appUrl).host;
  } catch {
    /* APP_URL необязателен */
  }
  if (originHost !== host && originHost !== appHost) throw forbidden("bad_origin");
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.code, message: err.message, ...(err.extra ?? {}) }, { status: err.status });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return NextResponse.json(
      { error: "validation", message: first?.message ?? "Некорректные данные", field: first?.path.join(".") ?? "" },
      { status: 400 },
    );
  }
  if (err instanceof SyntaxError) {
    return NextResponse.json({ error: "bad_json", message: "Некорректный JSON" }, { status: 400 });
  }
  console.error("[api] необработанная ошибка:", err);
  return NextResponse.json({ error: "internal", message: "Внутренняя ошибка сервера" }, { status: 500 });
}

export function route<P = Record<string, never>>(handler: Handler<P>, opts: { auth?: boolean } = {}) {
  return async (req: NextRequest, context: { params: Promise<P> }): Promise<Response> => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
      const params = await context.params;
      let user: UserRow | null = null;
      let token = "";
      if (opts.auth !== false) {
        token = await sessionToken();
        user = token ? await userBySessionToken(token) : null;
        if (!user) throw unauthorized();
      }
      const out = await handler({
        req,
        user: user as UserRow,
        settings: user ? resolveSettings(user.settings) : resolveSettings(null),
        params,
        token,
      });
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function readJson<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw badRequest("bad_json", "Некорректный JSON");
  }
  return schema.parse(body);
}

/**
 * «Сегодня» по часам пользователя. Устройство присылает свою дату; сервер принимает её,
 * если она не расходится с часовым поясом профиля больше чем на день.
 */
export function clientToday(req: NextRequest, user: UserRow, explicit?: string | null): Ymd {
  const serverToday = zonedParts(new Date(), user.timezone).ymd;
  const candidate = explicit ?? req.nextUrl.searchParams.get("today");
  if (candidate && isValidYmd(candidate)) {
    const diff = Math.abs(Date.parse(candidate) - Date.parse(serverToday)) / 86_400_000;
    if (diff <= 1) return candidate;
  }
  return serverToday;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Идентификатор из адреса: мусор вместо UUID — это «не найдено», а не ошибка базы. */
export function uuidParam(value: string | undefined): string {
  if (!value || !UUID_RE.test(value)) throw new HttpError(404, "not_found");
  return value.toLowerCase();
}

// ── Ограничение частоты (в памяти процесса) ──────────────────

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count++;
  if (bucket.count > limit) {
    throw new HttpError(429, "rate_limited", undefined, { retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) });
  }
}

export function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "local"
  );
}
