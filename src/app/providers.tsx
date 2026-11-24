"use client";

import { MotionConfig } from "framer-motion";
import { useEffect, type ReactNode } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { fetcher } from "@/client/api";
import { I18nProvider } from "@/client/i18n";
import { ToastProvider } from "@/components/ui/Toast";
import { store } from "@/local/store";

/**
 * Экраны читают данные через SWR по адресам вида /api/…; когда в хранилище на устройстве что-то
 * меняется (в этой вкладке или в соседней), все открытые выборки перечитываются.
 */
function StoreSync() {
  const { mutate } = useSWRConfig();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = store.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void mutate((key) => typeof key === "string" && key.startsWith("/api/")), 30);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [mutate]);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher,
        // Данные лежат на устройстве: перечитывать их при возврате в окно незачем — об изменениях сообщает хранилище.
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        revalidateIfStale: true,
        keepPreviousData: true,
        shouldRetryOnError: false,
        dedupingInterval: 0,
      }}
    >
      <StoreSync />
      <MotionConfig reducedMotion="user">
        <I18nProvider>
          <ToastProvider>{children}</ToastProvider>
        </I18nProvider>
      </MotionConfig>
    </SWRConfig>
  );
}
