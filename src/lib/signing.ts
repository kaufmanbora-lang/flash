// Временные подписанные ссылки на файлы. Ссылка — это разрешение на чтение одного объекта
// до момента истечения; сервер проверяет подпись и срок при каждом запросе.

import crypto from "node:crypto";
import { env } from "./env";

/** Окно квантования срока: ссылки на один файл совпадают в пределах окна, и браузер может их кэшировать. */
const WINDOW_SEC = 3 * 3600;
const DEFAULT_TTL_SEC = 6 * 3600;

function hmac(payload: string): string {
  return crypto.createHmac("sha256", env.appSecret).update(payload).digest("base64url");
}

function payloadOf(key: string, exp: number, download: string): string {
  return `media\n${key}\n${exp}\n${download}`;
}

export interface SignOptions {
  /** Минимальное время жизни ссылки в секундах. */
  ttlSec?: number;
  /** Имя файла для сохранения: ссылка отдаёт Content-Disposition: attachment. */
  download?: string;
}

export function signMediaUrl(key: string | null | undefined, opts: SignOptions = {}): string | null {
  if (!key) return null;
  const ttl = opts.ttlSec ?? DEFAULT_TTL_SEC;
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.ceil((now + ttl) / WINDOW_SEC) * WINDOW_SEC;
  const download = opts.download ?? "";
  const sig = hmac(payloadOf(key, exp, download));
  const qs = new URLSearchParams({ e: String(exp), s: sig });
  if (download) qs.set("dl", download);
  return `/api/media/${key}?${qs.toString()}`;
}

export function verifyMediaSignature(key: string, exp: number, sig: string, download = ""): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = hmac(payloadOf(key, exp, download));
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
