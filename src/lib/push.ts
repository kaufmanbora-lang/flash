// Web Push: VAPID-ключи и отправка уведомлений на все устройства пользователя.

import https from "node:https";
import * as webPushModule from "web-push";
import { exec, q, q1 } from "./db";
import { env } from "./env";

interface WebPushApi {
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: {
      TTL?: number;
      urgency?: "very-low" | "low" | "normal" | "high";
      topic?: string;
      timeout?: number;
      agent?: https.Agent;
      vapidDetails: { subject: string; publicKey: string; privateKey: string };
    },
  ): Promise<{ statusCode: number }>;
}

// Пакет может экспортировать API и как default, и поимённо — поддерживаем оба варианта.
const webpush: WebPushApi =
  (webPushModule as unknown as { default?: WebPushApi }).default ?? (webPushModule as unknown as WebPushApi);

/**
 * Только для локальной проверки: тестовый «push-сервис» на этом же компьютере работает
 * с самоподписанным сертификатом. В production эта ветка недостижима.
 */
const localTestAgent =
  process.env.PUSH_ALLOW_ANY_ENDPOINT === "1" && process.env.NODE_ENV !== "production"
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

function isLocalEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

export interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let vapidCache: Vapid | null = null;

function vapidSubject(): string {
  const fromEnv = env.vapid.subject;
  if (fromEnv && /^(mailto:|https:\/\/)/.test(fromEnv)) return fromEnv;
  if (env.appUrl.startsWith("https://") && !env.appUrl.includes("localhost")) return env.appUrl;
  return "mailto:admin@example.com";
}

/** Ключи из окружения, иначе — созданные автоматически и сохранённые в базе (общие для сайта и воркера). */
export async function getVapid(): Promise<Vapid> {
  if (vapidCache) return vapidCache;
  const { publicKey, privateKey } = env.vapid;
  if (publicKey && privateKey) {
    vapidCache = { publicKey, privateKey, subject: vapidSubject() };
    return vapidCache;
  }
  let row = await q1<{ value: { publicKey: string; privateKey: string } }>(
    `SELECT value FROM app_config WHERE key = 'vapid'`,
  );
  if (!row) {
    const generated = webpush.generateVAPIDKeys();
    await exec(`INSERT INTO app_config (key, value) VALUES ('vapid', $1::jsonb) ON CONFLICT (key) DO NOTHING`, [
      JSON.stringify(generated),
    ]);
    row = await q1(`SELECT value FROM app_config WHERE key = 'vapid'`);
  }
  vapidCache = { ...row!.value, subject: vapidSubject() };
  return vapidCache;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Путь внутри приложения, который откроется по нажатию. */
  url?: string;
  /** Уведомления с одинаковым тегом заменяют друг друга на устройстве. */
  tag?: string;
  kind: string;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendOptions {
  /** Ключ защиты от дублей: второе уведомление с тем же ключом не отправляется. */
  dedupeKey?: string;
  ttlSec?: number;
  urgency?: "low" | "normal" | "high";
}

/** Возвращает число устройств, принявших уведомление; −1, если сработала защита от дублей. */
export async function sendPush(userId: string, payload: PushPayload, opts: SendOptions = {}): Promise<number> {
  const dedupeKey = opts.dedupeKey ?? `${payload.kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const logged = await q1<{ id: number }>(
    `INSERT INTO push_log (user_id, dedupe_key, kind, title, body) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
    [userId, dedupeKey, payload.kind, payload.title, payload.body],
  );
  if (!logged) return -1;

  const subs = await q<SubscriptionRow>(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    [userId],
  );
  if (subs.length === 0) return 0;

  const vapid = await getVapid();
  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? "/",
    tag: payload.tag ?? payload.kind,
    kind: payload.kind,
  });

  let delivered = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          {
            TTL: opts.ttlSec ?? 3600,
            urgency: opts.urgency ?? "normal",
            timeout: 15_000,
            vapidDetails: vapid,
            ...(localTestAgent && isLocalEndpoint(sub.endpoint) ? { agent: localTestAgent } : {}),
          },
        );
        delivered++;
        await exec(`UPDATE push_subscriptions SET last_success_at = now(), failures = 0 WHERE id = $1`, [sub.id]);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // Подписка отозвана на устройстве — больше она не нужна.
          await exec(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
        } else {
          await exec(`UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1`, [sub.id]);
          console.warn(`[push] не доставлено (${status ?? (err as Error).message})`);
        }
      }
    }),
  );
  await exec(`UPDATE push_log SET delivered = $2 WHERE id = $1`, [logged.id, delivered]);
  return delivered;
}

export async function cleanupPush(): Promise<void> {
  await exec(`DELETE FROM push_log WHERE created_at < now() - interval '120 days'`);
  await exec(`DELETE FROM push_plan WHERE local_date < (now() - interval '7 days')::date`);
  await exec(`DELETE FROM push_subscriptions WHERE failures >= 20`);
}
