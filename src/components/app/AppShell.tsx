"use client";

import { RefreshCw } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { useSWRConfig } from "swr";
import { api, ApiError, errorText } from "@/client/api";
import { useMe, useMounted } from "@/client/hooks";
import { useT } from "@/client/i18n";
import { registerServiceWorker } from "@/client/pwa";
import { Button } from "@/components/ui/Button";
import { deviceTimeZone } from "@/lib/dates";
import { bootLocal } from "@/local/boot";
import { runMaintenance } from "@/local/maintenance";
import { AmbientBackground } from "./AmbientBackground";
import { BottomNav } from "./BottomNav";
import { Welcome } from "./Welcome";
import { Wordmark } from "./Wordmark";

function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <AmbientBackground calm />
      <Wordmark className="animate-breathe text-[64px]" />
    </div>
  );
}

/** Оболочка приложения: первый запуск, фон, навигация, фоновые дела и Service Worker. */
export function AppShell({ children }: { children: ReactNode }) {
  const t = useT();
  const pathname = usePathname() ?? "/";
  const mounted = useMounted();
  const { mutate } = useSWRConfig();
  const { data: me, error } = useMe();
  const synced = useRef(false);

  useEffect(() => {
    if (!mounted) return;
    void registerServiceWorker();
    void bootLocal().catch(() => {});
  }, [mounted]);

  // Пока приложение открыто — раз в минуту проверяем сроки проектов и время «фильма дня».
  useEffect(() => {
    if (!me) return;
    const tick = () => {
      if (document.visibilityState === "visible") void runMaintenance().catch(() => {});
    };
    tick();
    const timer = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [me]);

  // Часовой пояс следует за устройством.
  useEffect(() => {
    if (!me || synced.current) return;
    synced.current = true;
    const tz = deviceTimeZone();
    if (tz && tz !== me.user.timezone) void api("/api/me", { method: "PATCH", body: { timezone: tz } }).catch(() => {});
  }, [me]);

  if (!mounted || (!me && !error)) return <Splash />;
  if (!me) {
    if (error instanceof ApiError && error.code === "no_profile") return <Welcome />;
    // Хранилище браузера недоступно (например, приватный режим с запретом данных): честно говорим об этом.
    return (
      <div className="grid min-h-dvh place-items-center px-8 text-center">
        <AmbientBackground calm />
        <div role="alert">
          <Wordmark className="text-[56px]" />
          <p className="mx-auto mt-4 max-w-[32ch] text-[15px] leading-snug text-muted-strong">{errorText(t, error)}</p>
          <Button className="mt-5" variant="glass" icon={<RefreshCw aria-hidden="true" size={17} />} onClick={() => void mutate("/api/me")}>
            {t.common.retry}
          </Button>
        </div>
      </div>
    );
  }

  // Запись и «премьера» — на весь экран, без навигации.
  const immersive = pathname.startsWith("/record") || pathname.startsWith("/render");

  return (
    <>
      {!immersive && <AmbientBackground />}
      {children}
      {!immersive && <BottomNav />}
    </>
  );
}
