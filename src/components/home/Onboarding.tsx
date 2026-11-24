"use client";

import { AnimatePresence, motion } from "framer-motion";
import { BellRing, Share, Smartphone, Video, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useSWRConfig } from "swr";
import { api, errorText } from "@/client/api";
import { useDrafts, useMe } from "@/client/hooks";
import { useT } from "@/client/i18n";
import { clearChunks, findInterrupted, type InterruptedRecording } from "@/client/idb";
import {
  canPromptInstall,
  enablePush,
  getPushState,
  isIos,
  isStandalone,
  onInstallChange,
  promptInstall,
  type PushState,
} from "@/client/pwa";
import { newClientId, uploader } from "@/client/uploader";
import { readVideoMeta } from "@/client/video";
import { Button, IconButton } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { MAX_MOMENTS_PER_DAY, MIN_MOMENT_MS } from "@/lib/constants";
import { deviceHm, deviceYmd } from "@/lib/dates";
import { fmtClock } from "@/lib/format";
import type { MeDto } from "@/lib/types";

function Card({ icon, title, text, children, onDismiss, dismissLabel }: { icon: ReactNode; title: string; text: string; children: ReactNode; onDismiss?: () => void; dismissLabel?: string }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.18 } }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="glass glass-tint relative p-5"
    >
      {onDismiss && dismissLabel && (
        <IconButton label={dismissLabel} tone="plain" size={40} onClick={onDismiss} className="absolute right-2 top-2">
          <X aria-hidden="true" size={18} />
        </IconButton>
      )}
      <div className="flex items-start gap-3.5 pr-8">
        <span className="grid size-12 shrink-0 place-items-center rounded-[16px] bg-white/75 text-leaf-deep shadow-[inset_0_1px_0_#fff]">{icon}</span>
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold leading-tight tracking-[-0.015em]">{title}</h2>
          <p className="mt-1 text-[14.5px] leading-snug text-ink/75">{text}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2.5">{children}</div>
    </motion.div>
  );
}

/**
 * Предложение включить напоминания. Показывается в установленном приложении (на iPhone push
 * работают только так) и только пока пользователь явно не согласился или не отказался.
 */
function PushCard({ me }: { me: MeDto }) {
  const t = useT();
  const o = t.onboarding;
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getPushState().then(setState);
  }, []);

  const dismiss = async () => {
    setState("denied");
    await api("/api/settings", { method: "PATCH", body: { onboarding: { pushPromptDismissed: true } } }).catch(() => {});
    void mutate("/api/me");
  };

  const enable = async () => {
    if (!me.push.publicKey) return;
    setBusy(true);
    try {
      const result = await enablePush(me.push.publicKey);
      if (result === "subscribed") {
        await api("/api/settings", { method: "PATCH", body: { notifications: { enabled: true }, onboarding: { pushPromptDismissed: true } } });
        void mutate("/api/me");
        toast(o.pushEnabled, "success");
      } else if (result === "denied") {
        toast(o.pushDenied, "info");
        await dismiss();
      }
      setState(result);
    } catch (err) {
      toast(errorText(t, err), "error");
    } finally {
      setBusy(false);
    }
  };

  const eligible = (state === "default" || state === "granted") && !me.settings.onboarding.pushPromptDismissed && (!isIos() || isStandalone());
  return (
    <AnimatePresence>
      {eligible && (
        <Card icon={<BellRing aria-hidden="true" size={23} strokeWidth={1.9} />} title={o.pushTitle} text={o.pushText} onDismiss={() => void dismiss()} dismissLabel={o.later}>
          <Button size="sm" loading={busy} onClick={() => void enable()}>
            {o.pushEnable}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void dismiss()}>
            {o.later}
          </Button>
        </Card>
      )}
    </AnimatePresence>
  );
}

/** Подсказка «установить на домашний экран»: кнопка на Android и инструкция для iPhone. */
function InstallCard({ me }: { me: MeDto }) {
  const t = useT();
  const o = t.onboarding;
  const { mutate } = useSWRConfig();
  const [visible, setVisible] = useState(false);
  const [canPrompt, setCanPrompt] = useState(false);
  const ios = isIos();

  useEffect(() => {
    const update = () => {
      setCanPrompt(canPromptInstall());
      setVisible(!isStandalone() && (isIos() || canPromptInstall()));
    };
    update();
    return onInstallChange(update);
  }, []);

  const dismiss = async () => {
    setVisible(false);
    await api("/api/settings", { method: "PATCH", body: { onboarding: { installHintDismissed: true } } }).catch(() => {});
    void mutate("/api/me");
  };

  return (
    <AnimatePresence>
      {visible && !me.settings.onboarding.installHintDismissed && (
        <Card
          icon={ios ? <Share aria-hidden="true" size={22} strokeWidth={1.9} /> : <Smartphone aria-hidden="true" size={23} strokeWidth={1.9} />}
          title={o.installTitle}
          text={ios ? o.installIos : o.installOther}
          onDismiss={() => void dismiss()}
          dismissLabel={o.later}
        >
          {!ios && canPrompt && (
            <Button
              size="sm"
              onClick={async () => {
                if (await promptInstall()) setVisible(false);
              }}
            >
              {o.installCta}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void dismiss()}>
            {o.later}
          </Button>
        </Card>
      )}
    </AnimatePresence>
  );
}

/** Запись, оборвавшаяся из-за закрытия приложения: предлагаем сохранить то, что успело записаться. */
function InterruptedCard({ todayCount }: { todayCount: number }) {
  const t = useT();
  const d = t.draft;
  const toast = useToast();
  const drafts = useDrafts();
  const [found, setFound] = useState<InterruptedRecording | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void findInterrupted()
      .then(setFound)
      .catch(() => {});
  }, []);

  if (!found) return null;
  const startedAt = new Date(found.startedAt);
  const tooShort = found.approxDurationMs < MIN_MOMENT_MS;

  const drop = async () => {
    await clearChunks(found.session).catch(() => {});
    setFound(null);
  };

  const save = async () => {
    setBusy(true);
    try {
      const date = deviceYmd(startedAt);
      const sameDay = drafts.filter((x) => x.localDate === date && x.state !== "failed").length + (date === deviceYmd() ? todayCount : 0);
      if (sameDay >= MAX_MOMENTS_PER_DAY) {
        toast(t.errors.daily_limit, "error");
        return;
      }
      const meta = await readVideoMeta(found.blob, 0);
      const durationMs = meta.durationMs || found.approxDurationMs;
      if (durationMs < MIN_MOMENT_MS) {
        toast(d.interruptedShort, "info");
        await drop();
        return;
      }
      await uploader.add({
        clientId: newClientId(),
        blob: found.blob,
        mime: found.mime,
        size: found.blob.size,
        recordedAt: startedAt.toISOString(),
        localDate: date,
        localTime: deviceHm(startedAt),
        note: "",
        projectIds: [],
        autoProjects: true,
        source: "camera",
        durationMs,
        width: meta.width,
        height: meta.height,
        poster: meta.poster,
        state: "queued",
        error: null,
        momentId: null,
        uploadedBytes: 0,
        attempts: 0,
        createdAt: Date.now(),
      });
      await drop();
      toast(t.record.saved, "success");
    } catch {
      toast(t.errors.generic, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      icon={<Video aria-hidden="true" size={23} strokeWidth={1.9} />}
      title={d.interruptedTitle}
      text={tooShort ? d.interruptedShort : d.interruptedText(deviceHm(startedAt), fmtClock(found.approxDurationMs))}
    >
      {!tooShort && (
        <Button size="sm" loading={busy} onClick={() => void save()}>
          {d.interruptedSave}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => void drop()}>
        {d.interruptedDrop}
      </Button>
    </Card>
  );
}

/** Подсказки первого запуска и восстановление прерванной записи. */
export function Onboarding({ todayCount }: { todayCount: number }) {
  const { data: me } = useMe();
  if (!me) return null;
  return (
    <div className="flex flex-col gap-3 empty:hidden">
      <InterruptedCard todayCount={todayCount} />
      <InstallCard me={me} />
      <PushCard me={me} />
    </div>
  );
}
