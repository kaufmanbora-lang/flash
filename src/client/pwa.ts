// PWA на устройстве: Service Worker (приложение открывается без сети) и установка на домашний экран.

import { withBase } from "@/lib/base";

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
  // В разработке воркер не нужен: он кэшировал бы постоянно меняющиеся файлы.
  if (process.env.NODE_ENV !== "production") return Promise.resolve(null);
  registration ??= navigator.serviceWorker
    .register(withBase("/sw.js"), { scope: withBase("/") })
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
