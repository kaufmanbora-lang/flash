"use client";

import { MotionConfig } from "framer-motion";
import type { ReactNode } from "react";
import { SWRConfig, type Cache, type State } from "swr";
import { fetcher } from "@/client/api";
import { I18nProvider } from "@/client/i18n";
import { ToastProvider } from "@/components/ui/Toast";

const CACHE_KEY = "flash-cache-v1";

/**
 * Кэш запросов, который переживает перезапуск: при открытии без сети приложение
 * показывает последние загруженные данные, а не пустые экраны.
 */
function persistentCache(): Cache {
  const map = new Map<string, State>();
  if (typeof window === "undefined") return map as Cache;
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "[]") as [string, State][];
    for (const [key, value] of saved) map.set(key, value);
  } catch {
    /* повреждённый кэш просто игнорируется */
  }
  const save = () => {
    try {
      // Данные сохраняются и тогда, когда последнее обновление не удалось: без сети «устаревшие»
      // данные — единственное, что можно показать при следующем запуске.
      const entries = [...map.entries()]
        .filter(([key, value]) => key.startsWith("/api/") && value?.data !== undefined)
        .slice(-40)
        .map(([key, value]) => [key, { data: value.data }]);
      localStorage.setItem(CACHE_KEY, JSON.stringify(entries));
    } catch {
      /* место закончилось — кэш не критичен */
    }
  };
  window.addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
  });
  return map as Cache;
}

export function clearPersistentCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* не критично */
  }
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher,
        provider: persistentCache,
        revalidateOnFocus: true,
        revalidateIfStale: true,
        keepPreviousData: true,
        shouldRetryOnError: false,
        dedupingInterval: 2000,
      }}
    >
      <MotionConfig reducedMotion="user">
        <I18nProvider>
          <ToastProvider>{children}</ToastProvider>
        </I18nProvider>
      </MotionConfig>
    </SWRConfig>
  );
}
