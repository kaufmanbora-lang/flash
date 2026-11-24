"use client";

import { AnimatePresence, motion } from "framer-motion";
import { RefreshCw, WifiOff } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { useSWRConfig } from "swr";
import { api, ApiError, errorText } from "@/client/api";
import { useMe, useMounted, useOnline } from "@/client/hooks";
import { useT } from "@/client/i18n";
import { requestPersistence } from "@/client/idb";
import { refreshPushSubscription, registerServiceWorker, warmShellCache } from "@/client/pwa";
import { uploader } from "@/client/uploader";
import { AUTH_FLAG_COOKIE } from "@/lib/constants";
import { deviceTimeZone } from "@/lib/dates";
import { Button } from "@/components/ui/Button";
import { AmbientBackground } from "./AmbientBackground";
import { BottomNav } from "./BottomNav";
import { Wordmark } from "./Wordmark";

const SHELL_PATHS = ["/", "/calendar", "/record", "/films", "/settings", "/projects/new"];

function hasAuthFlag(): boolean {
  return document.cookie.split("; ").some((c) => c.startsWith(`${AUTH_FLAG_COOKIE}=`));
}

function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <AmbientBackground calm />
      <Wordmark className="animate-breathe text-[64px]" />
    </div>
  );
}

/** Оболочка приложения: проверка входа, фон, навигация, фоновая загрузка и Service Worker. */
export function AppShell({ children }: { children: ReactNode }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const mounted = useMounted();
  const online = useOnline();
  const { mutate } = useSWRConfig();
  const { data: me, error } = useMe();
  const synced = useRef(false);

  // Без отметки о входе сразу уходим на экран входа, не дожидаясь ответа сервера.
  useEffect(() => {
    if (mounted && !hasAuthFlag()) router.replace("/login");
  }, [mounted, router]);

  useEffect(() => {
    const onUnauthorized = () => router.replace("/login");
    const onUploaded = () => void mutate((key) => typeof key === "string" && key.startsWith("/api/"));
    window.addEventListener("flash:unauthorized", onUnauthorized);
    window.addEventListener("flash:moment-uploaded", onUploaded);
    return () => {
      window.removeEventListener("flash:unauthorized", onUnauthorized);
      window.removeEventListener("flash:moment-uploaded", onUploaded);
    };
  }, [mutate, router]);

  useEffect(() => {
    if (!mounted) return;
    void registerServiceWorker();
    uploader.start();
    void requestPersistence();
  }, [mounted]);

  // После входа: сверяем часовой пояс, восстанавливаем push-подписку, готовим офлайн-оболочку.
  useEffect(() => {
    if (!me || synced.current) return;
    synced.current = true;
    const tz = deviceTimeZone();
    if (tz && tz !== me.user.timezone) {
      void api("/api/me", { method: "PATCH", body: { timezone: tz } })
        .then(() => mutate("/api/me"))
        .catch(() => {});
    }
    void refreshPushSubscription(me.push.publicKey);
    void warmShellCache(SHELL_PATHS);
  }, [me, mutate]);

  if (!mounted || (!me && !error)) return <Splash />;
  if (!me) {
    // Нет ни данных, ни кэша. Если сессия истекла — редирект на вход уже идёт; иначе сервер
    // недоступен, и вместо бесконечной «загрузки» честно говорим об этом и даём повторить.
    const unauthorized = error instanceof ApiError && error.status === 401;
    return (
      <div className="grid min-h-dvh place-items-center px-8 text-center">
        <AmbientBackground calm />
        <div>
          <Wordmark className="text-[56px]" />
          {unauthorized ? (
            <p className="mt-4 text-[15px] text-muted-strong">{t.common.loading}</p>
          ) : (
            <div role="alert">
              <p className="mx-auto mt-4 max-w-[30ch] text-[15px] leading-snug text-muted-strong">{online ? errorText(t, error) : t.errors.network}</p>
              <Button className="mt-5" variant="glass" icon={<RefreshCw aria-hidden="true" size={17} />} onClick={() => void mutate("/api/me")}>
                {t.common.retry}
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const immersive = pathname.startsWith("/record");

  return (
    <>
      {!immersive && <AmbientBackground />}
      <AnimatePresence>
        {!online && !immersive && (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center pt-safe"
          >
            <span className="glass glass-strong flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] font-semibold text-muted-strong shadow-float">
              <WifiOff aria-hidden="true" size={15} />
              {t.common.offline}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
      {children}
      {!immersive && <BottomNav />}
    </>
  );
}
