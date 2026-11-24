// Аккаунты: регистрация, вход, сессии, удаление данных. Без зависимостей от Next.js.

import crypto from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { isValidTimeZone } from "./dates";
import { exec, q, q1 } from "./db";
import { env } from "./env";
import { badRequest, conflict, forbidden, HttpError } from "./errors";
import { randomToken, sha256Hex } from "./signing";
import { storage, userPrefix } from "./storage";
import type { UserRow } from "./types";

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
export const SESSION_DAYS = 180;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * SCRYPT_N * SCRYPT_R,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  const N = Number(n);
  const R = Number(r);
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N,
    r: R,
    p: Number(p),
    maxmem: 256 * N * R,
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(60),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(200),
  inviteCode: z.string().trim().max(100).optional(),
  timezone: z.string().max(64).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(200),
  password: z.string().min(1).max(200),
  timezone: z.string().max(64).optional(),
});

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(sha256Hex(a));
  const y = Buffer.from(sha256Hex(b));
  return crypto.timingSafeEqual(x, y);
}

export async function registerUser(input: z.infer<typeof registerSchema>): Promise<UserRow> {
  const invite = env.inviteCode;
  if (invite && !safeEqual(input.inviteCode ?? "", invite)) throw forbidden("invite_required");

  const existing = await q1(`SELECT 1 FROM users WHERE email = $1`, [input.email]);
  if (existing) throw conflict("email_taken");

  const hash = await hashPassword(input.password);
  const tz = isValidTimeZone(input.timezone) ? input.timezone : "UTC";
  try {
    const user = await q1<UserRow>(
      `INSERT INTO users (email, name, password_hash, timezone) VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.email, input.name, hash, tz],
    );
    return user!;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw conflict("email_taken");
    throw err;
  }
}

export async function loginUser(input: z.infer<typeof loginSchema>): Promise<UserRow> {
  const user = await q1<UserRow>(`SELECT * FROM users WHERE email = $1`, [input.email]);
  // Хэш считается и для несуществующего адреса: время ответа не выдаёт, есть ли такой аккаунт.
  const ok = user
    ? await verifyPassword(input.password, user.password_hash)
    : (await hashPassword(input.password), false);
  if (!user || !ok) throw new HttpError(401, "bad_credentials");
  if (isValidTimeZone(input.timezone) && input.timezone !== user.timezone) {
    await exec(`UPDATE users SET timezone = $2 WHERE id = $1`, [user.id, input.timezone]);
    user.timezone = input.timezone;
  }
  return user;
}

export async function createSession(userId: string, userAgent: string): Promise<{ token: string; expires: Date }> {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await exec(`INSERT INTO sessions (user_id, token_hash, user_agent, expires_at) VALUES ($1, $2, $3, $4)`, [
    userId,
    sha256Hex(token),
    userAgent.slice(0, 300),
    expires,
  ]);
  return { token, expires };
}

export async function userBySessionToken(token: string): Promise<UserRow | null> {
  if (!token || token.length > 200) return null;
  const hash = sha256Hex(token);
  const user = await q1<UserRow & { last_seen_at: Date; session_id: string }>(
    `SELECT u.*, s.last_seen_at, s.id AS session_id
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hash],
  );
  if (!user) return null;
  if (Date.now() - user.last_seen_at.getTime() > 3_600_000) {
    void exec(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [user.session_id]).catch(() => {});
  }
  return user;
}

export async function destroySession(token: string): Promise<void> {
  if (token) await exec(`DELETE FROM sessions WHERE token_hash = $1`, [sha256Hex(token)]);
}

export async function cleanupSessions(): Promise<void> {
  await exec(`DELETE FROM sessions WHERE expires_at < now()`);
}

export const profileSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  timezone: z.string().max(64).optional(),
  locale: z.string().max(10).optional(),
});

export const passwordChangeSchema = z.object({
  current: z.string().min(1).max(200),
  next: z.string().min(8).max(200),
});

export async function changePassword(user: UserRow, current: string, next: string, keepToken?: string): Promise<void> {
  if (!(await verifyPassword(current, user.password_hash))) throw new HttpError(403, "bad_password");
  await exec(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user.id, await hashPassword(next)]);
  // Остальные устройства выходят из аккаунта.
  await exec(`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, [user.id, sha256Hex(keepToken ?? "")]);
}

/**
 * Удаляет все данные пользователя: файлы в хранилище и записи в базе.
 * scope = 'data' оставляет пустой аккаунт, 'account' удаляет и его.
 */
export async function deleteUserData(user: UserRow, password: string, scope: "data" | "account"): Promise<void> {
  if (!(await verifyPassword(password, user.password_hash))) throw new HttpError(403, "bad_password");
  // Сначала останавливаем фоновые задачи пользователя, чтобы воркер не писал в удаляемые папки.
  await exec(
    `DELETE FROM jobs WHERE status = 'queued' AND (
       payload->>'momentId' IN (SELECT id::text FROM moments WHERE user_id = $1)
       OR payload->>'filmId' IN (SELECT id::text FROM films WHERE user_id = $1)
       OR payload->>'projectId' IN (SELECT id::text FROM projects WHERE user_id = $1))`,
    [user.id],
  );
  const store = await storage();
  const uploading = await q<{ original_key: string; upload_id: string }>(
    `SELECT original_key, upload_id FROM moments WHERE user_id = $1 AND upload_id IS NOT NULL AND original_key IS NOT NULL`,
    [user.id],
  );
  for (const u of uploading) await store.abortMultipart(u.original_key, u.upload_id).catch(() => {});
  await store.deletePrefix(userPrefix(user.id));

  if (scope === "account") {
    await exec(`DELETE FROM users WHERE id = $1`, [user.id]);
    return;
  }
  await exec(`DELETE FROM films WHERE user_id = $1`, [user.id]);
  await exec(`DELETE FROM projects WHERE user_id = $1`, [user.id]);
  await exec(`DELETE FROM moments WHERE user_id = $1`, [user.id]);
  await exec(`DELETE FROM push_plan WHERE user_id = $1`, [user.id]);
  await exec(`DELETE FROM push_log WHERE user_id = $1`, [user.id]);
}

export function assertPasswordStrength(password: string): void {
  if (password.length < 8) throw badRequest("weak_password");
}
