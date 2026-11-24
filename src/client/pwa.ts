// PWA на устройстве: Service Worker, установка на домашний экран, push-подписка.

import { api } from "./api";

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
}

/** Приложение запущено с домашнего экрана. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// ── Service Worker ───────────────────────────────────────────

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(null);
  // В разработке воркер нужен только для push: кэширование в нём отключается параметром dev=1.
  const script = process.env.NODE_ENV === "production" ? "/sw.js" : "/sw.js?dev=1";
  registration ??= navigator.serviceWorker
    .register(script, { scope: "/" })
    .then((reg) => {
      // Раз в час проверяем обновление приложения.
      setInterval(() => void reg.update().catch(() => {}), 3_600_000);
      return reg;
    })
    .catch((err) => {
      console.warn("Service Worker не зарегистрирован:", err);
      return null;
    });
  return registration;
}

/** Просит Service Worker положить в кэш оболочку приложения — она откроется и без сети. */
export async function warmShellCache(paths: string[]): Promise<void> {
  const reg = await registerServiceWorker();
  const worker = reg?.active ?? (await navigator.serviceWorker?.ready.catch(() => null))?.active;
  worker?.postMessage({ type: "cache-shell", paths });
}

// ── Установка на домашний экран ──────────────────────────────

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    installListeners.forEach((fn) => fn());
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installListeners.forEach((fn) => fn());
  });
}

export function canPromptInstall(): boolean {
  return deferredPrompt !== null;
}

export function onInstallChange(fn: () => void): () => void {
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}

export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  const event = deferredPrompt;
  deferredPrompt = null;
  await event.prompt();
  const choice = await event.userChoice;
  installListeners.forEach((fn) => fn());
  return choice.outcome === "accepted";
}

// ── Push ─────────────────────────────────────────────────────

export type PushState =
  /** Браузер не умеет Web Push. */
  | "unsupported"
  /** iPhone: push доступны только приложению, добавленному на домашний экран. */
  | "needs-install"
  /** Разрешение ещё не запрашивали. */
  | "default"
  /** Пользователь запретил уведомления в системе. */
  | "denied"
  /** Разрешение есть, но подписки на этом устройстве нет. */
  | "granted"
  /** Это устройство подписано. */
  | "subscribed";

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function getPushState(): Promise<PushState> {
  if (typeof window === "undefined") return "unsupported";
  if (isIos() && !isStandalone()) return "needs-install";
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") return "default";
  try {
    const reg = await registerServiceWorker();
    const sub = await reg?.pushManager.getSubscription();
    return sub ? "subscribed" : "granted";
  } catch {
    return "granted";
  }
}

function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Включает уведомления на этом устройстве. Вызывать только по нажатию пользователя:
 * системный запрос разрешения показывается в ответ на явное действие.
 */
export async function enablePush(publicKey: string): Promise<PushState> {
  if (isIos() && !isStandalone()) return "needs-install";
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "default";

  const reg = await registerServiceWorker();
  if (!reg) return "unsupported";
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) });
  }
  const json = sub.toJSON();
  await api("/api/push/subscribe", { body: { endpoint: json.endpoint, keys: json.keys } });
  return "subscribed";
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await registerServiceWorker();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api("/api/push/unsubscribe", { body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/** После переустановки или смены ключей подписка могла потеряться — восстанавливаем её молча. */
export async function refreshPushSubscription(publicKey: string | null): Promise<void> {
  if (!publicKey || !pushSupported() || Notification.permission !== "granted") return;
  try {
    const reg = await registerServiceWorker();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    const json = sub.toJSON();
    await api("/api/push/subscribe", { body: { endpoint: json.endpoint, keys: json.keys } });
  } catch {
    /* попробуем при следующем запуске */
  }
}
