"use client";

import clsx from "clsx";
import {
  Archive,
  BellRing,
  Check,
  Clapperboard,
  Globe,
  KeyRound,
  LogOut,
  Palette,
  Plus,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import useSWR, { useSWRConfig } from "swr";
import { api, errorText, fetcher } from "@/client/api";
import { useMe } from "@/client/hooks";
import { useLocale, useT } from "@/client/i18n";
import { allDrafts, deleteDraft } from "@/client/idb";
import {
  canPromptInstall,
  disablePush,
  enablePush,
  getPushState,
  isIos,
  isStandalone,
  onInstallChange,
  promptInstall,
  type PushState,
} from "@/client/pwa";
import { startDownload } from "@/client/share";
import { clearPersistentCache } from "@/app/providers";
import { Page, Reveal, TitleHeader } from "@/components/app/Page";
import { FilmOptionsFields } from "@/components/films/FilmOptions";
import { Button } from "@/components/ui/Button";
import { Field, Row, Segmented, Stepper, Toggle } from "@/components/ui/Controls";
import { Skeleton } from "@/components/ui/Feedback";
import { ConfirmSheet, Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { LOCALES, type Locale } from "@/i18n";
import { APP_VERSION, FILM_STYLE_NAMES, MUSIC_STYLE_NAMES } from "@/lib/constants";
import { isValidHm } from "@/lib/dates";
import { fmtBytes } from "@/lib/format";
import type { UserSettings } from "@/lib/settings";
import type { FilmOptions, MeDto, StorageDto } from "@/lib/types";

type Patch = { [K in keyof UserSettings]?: Partial<UserSettings[K]> };

function merge(settings: UserSettings, patch: Patch): UserSettings {
  return {
    notifications: { ...settings.notifications, ...patch.notifications },
    dailyFilm: { ...settings.dailyFilm, ...patch.dailyFilm },
    film: { ...settings.film, ...patch.film },
    onboarding: { ...settings.onboarding, ...patch.onboarding },
  };
}

const timeInput =
  "tabular min-h-[44px] rounded-[14px] bg-white/85 px-3 text-[16px] font-semibold text-ink shadow-[inset_0_0_0_1px_rgb(32_48_30/0.1)] outline-none focus:shadow-[inset_0_0_0_2px_var(--color-leaf)]";

function Section({ id, title, icon, children, delay = 0 }: { id?: string; title: string; icon: ReactNode; children: ReactNode; delay?: number }) {
  return (
    <Reveal delay={delay}>
      <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="scroll-mt-6">
        <h2 id={id ? `${id}-title` : undefined} className="mb-2.5 flex items-center gap-2 px-1 text-[13px] font-semibold uppercase tracking-[0.1em] text-muted-strong">
          <span className="text-leaf-deep">{icon}</span>
          {title}
        </h2>
        <div className="glass divide-y divide-line overflow-hidden">{children}</div>
      </section>
    </Reveal>
  );
}

function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-[14px] font-medium text-muted-strong">
      <span>{label}</span>
      <input type="time" value={value} onChange={(e) => isValidHm(e.target.value) && onChange(e.target.value)} className={timeInput} />
    </label>
  );
}

export default function SettingsPage() {
  const t = useT();
  const s = t.settings;
  const toast = useToast();
  const router = useRouter();
  const { locale, setLocale } = useLocale();
  const { mutate } = useSWRConfig();
  const { data: me, mutate: mutateMe } = useMe();
  const { data: storageData } = useSWR<{ storage: StorageDto }>("/api/account/storage", fetcher);

  const [pushState, setPushState] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [installable, setInstallable] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [nameSheet, setNameSheet] = useState(false);
  const [name, setName] = useState("");
  const [lookSheet, setLookSheet] = useState(false);
  const [look, setLook] = useState<FilmOptions | null>(null);
  const [passwordSheet, setPasswordSheet] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [danger, setDanger] = useState<null | "data" | "account">(null);
  const [dangerPassword, setDangerPassword] = useState("");
  const [logout, setLogout] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newTime, setNewTime] = useState("12:00");

  useEffect(() => {
    void getPushState().then(setPushState);
    const update = () => {
      setInstallable(canPromptInstall());
      setStandalone(isStandalone());
    };
    update();
    return onInstallChange(update);
  }, []);

  // Переход по ссылке «Уведомления» с главного экрана.
  useEffect(() => {
    if (me && window.location.hash) {
      document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [me]);

  if (!me) {
    return (
      <Page>
        <TitleHeader title={s.title} />
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-[130px] rounded-[28px]" />
          <Skeleton className="h-[320px] rounded-[28px]" />
          <Skeleton className="h-[180px] rounded-[28px]" />
        </div>
      </Page>
    );
  }

  const settings = me.settings;
  const n = settings.notifications;

  /** Сохраняет изменение настроек: сразу в интерфейсе, затем на сервере. */
  const update = async (patch: Patch) => {
    const optimistic: MeDto = { ...me, settings: merge(settings, patch) };
    await mutateMe(optimistic, { revalidate: false });
    try {
      await api("/api/settings", { method: "PATCH", body: patch });
    } catch (err) {
      toast(errorText(t, err), "error");
      void mutateMe();
    }
  };

  const toggleNotifications = async (enabled: boolean) => {
    if (!enabled) {
      await update({ notifications: { enabled: false } });
      return;
    }
    setPushBusy(true);
    try {
      let state = pushState;
      // Запрос разрешения идёт только здесь — по явному нажатию пользователя.
      if (me.push.publicKey && state !== "subscribed" && state !== "unsupported" && state !== "needs-install") {
        state = await enablePush(me.push.publicKey);
        setPushState(state);
      }
      await update({ notifications: { enabled: true }, onboarding: { pushPromptDismissed: true } });
      if (state === "denied") toast(s.notifications.device.denied, "info");
      else if (state === "needs-install") toast(s.notifications.device.needsInstall, "info");
      else if (state === "subscribed") void mutateMe();
    } catch (err) {
      toast(errorText(t, err), "error");
    } finally {
      setPushBusy(false);
    }
  };

  const enableDevice = async () => {
    if (!me.push.publicKey) return;
    setPushBusy(true);
    try {
      const state = await enablePush(me.push.publicKey);
      setPushState(state);
      if (state === "subscribed") {
        toast(s.notifications.deviceOn, "success");
        void mutateMe();
      } else if (state === "denied") toast(s.notifications.device.denied, "info");
    } catch (err) {
      toast(errorText(t, err), "error");
    } finally {
      setPushBusy(false);
    }
  };

  const disableDevice = async () => {
    setPushBusy(true);
    await disablePush();
    setPushState(await getPushState());
    void mutateMe();
    setPushBusy(false);
  };

  const testPush = async () => {
    setPushBusy(true);
    try {
      const res = await api<{ delivered: number }>("/api/push/test", { method: "POST", body: {} });
      toast(res.delivered > 0 ? s.notifications.testSent(res.delivered) : s.notifications.testNone, res.delivered > 0 ? "success" : "info");
    } catch (err) {
      toast(errorText(t, err), "error");
    } finally {
      setPushBusy(false);
    }
  };

  const saveName = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api("/api/me", { method: "PATCH", body: { name: name.trim() } });
      await mutateMe();
      setNameSheet(false);
      toast(t.common.saved, "success");
    } catch (err) {
      toast(errorText(t, err), "error");
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    setBusy(true);
    try {
      await api("/api/account/password", { body: { current: currentPassword, next: newPassword } });
      setPasswordSheet(false);
      setCurrentPassword("");
      setNewPassword("");
      toast(s.account.passwordChanged, "success");
    } catch (err) {
      toast(errorText(t, err), "error");
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    clearPersistentCache();
    await mutate(() => true, undefined, { revalidate: false });
    router.replace("/login");
  };

  const doLogout = async () => {
    setBusy(true);
    // Подписка этого устройства снимается: уведомления не должны приходить после выхода.
    await disablePush().catch(() => {});
    await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
    await leave();
  };

  const doDelete = async () => {
    if (!danger) return;
    setBusy(true);
    try {
      await api("/api/account/delete", { body: { password: dangerPassword, scope: danger } });
      // Незагруженные черновики на устройстве тоже относятся к данным пользователя.
      for (const draft of await allDrafts().catch(() => [])) await deleteDraft(draft.clientId).catch(() => {});
      setDangerPassword("");
      if (danger === "account") {
        await disablePush().catch(() => {});
        await leave();
        return;
      }
      setDanger(null);
      clearPersistentCache();
      await mutate((key) => typeof key === "string" && key.startsWith("/api/"));
      toast(s.data.deleted, "success");
    } catch (err) {
      toast(errorText(t, err), "error");
    } finally {
      setBusy(false);
    }
  };

  const storage = storageData?.storage;
  const bytes = (v: number) => fmtBytes(v, t.fmt.bytes, locale);
  const storageParts = storage
    ? [
        { label: s.storage.originals, value: storage.originalsBytes, color: "bg-leaf-deep" },
        { label: s.storage.films, value: storage.filmsBytes, color: "bg-leaf" },
        { label: s.storage.playback, value: storage.playbackBytes, color: "bg-lime" },
        { label: s.storage.other, value: storage.otherBytes, color: "bg-lime-soft" },
      ]
    : [];
  const storageBase = storage ? Math.max(storage.quotaBytes || storage.totalBytes, 1) : 1;

  const deviceText =
    pushState === "subscribed"
      ? s.notifications.device.subscribed
      : pushState === "needs-install"
        ? s.notifications.device.needsInstall
        : pushState === "denied"
          ? s.notifications.device.denied
          : pushState === "unsupported"
            ? s.notifications.device.unsupported
            : s.notifications.device.off;

  const lookSummary = `${settings.film.style === "auto" ? t.options.styleAuto : FILM_STYLE_NAMES[settings.film.style]} · ${
    settings.film.music === "auto" ? t.options.musicAuto : settings.film.music === "none" ? t.options.musicNone : MUSIC_STYLE_NAMES[settings.film.music]
  }`;

  return (
    <Page>
      <TitleHeader title={s.title} />

      <div className="flex flex-col gap-6">
        <Section title={s.profile.title} icon={<UserRound aria-hidden="true" size={15} />}>
          <Row
            title={me.user.name}
            hint={me.user.email}
            icon={<span className="text-[17px] font-bold">{(me.user.name[0] ?? "F").toLocaleUpperCase()}</span>}
            onClick={() => {
              setName(me.user.name);
              setNameSheet(true);
            }}
          >
            <span className="text-[14px] font-semibold text-leaf-deep">{t.common.edit}</span>
          </Row>
          <Row title={s.profile.timezone} hint={s.profile.timezoneHint}>
            <span className="text-[14px] font-medium text-muted-strong">{me.user.timezone}</span>
          </Row>
        </Section>

        <Section id="notifications" title={s.notifications.title} icon={<BellRing aria-hidden="true" size={15} />} delay={1}>
          <Row title={s.notifications.enable} hint={s.notifications.enableHint}>
            <Toggle checked={n.enabled} onChange={(v) => void toggleNotifications(v)} label={s.notifications.enable} disabled={pushBusy} />
          </Row>

          <div className="flex flex-col gap-3 px-4 py-3.5">
            <p className="flex items-start gap-2 text-[14px] leading-snug text-muted-strong" role="status">
              <span className={clsx("mt-[5px] size-2 shrink-0 rounded-full", pushState === "subscribed" ? "bg-leaf" : "bg-ink/25")} aria-hidden="true" />
              {deviceText}
            </p>
            <div className="flex flex-wrap gap-2">
              {(pushState === "default" || pushState === "granted") && (
                <Button size="sm" loading={pushBusy} onClick={() => void enableDevice()}>
                  {s.notifications.deviceEnable}
                </Button>
              )}
              {pushState === "subscribed" && (
                <>
                  <Button size="sm" variant="glass" loading={pushBusy} onClick={() => void testPush()}>
                    {s.notifications.test}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pushBusy} onClick={() => void disableDevice()}>
                    {s.notifications.deviceDisable}
                  </Button>
                </>
              )}
            </div>
          </div>

          {n.enabled && (
            <>
              <div className="px-4 py-3.5">
                <p className="mb-2 text-[13.5px] font-semibold text-muted-strong">{s.notifications.mode}</p>
                <Segmented<"random" | "fixed">
                  label={s.notifications.mode}
                  size="sm"
                  value={n.mode}
                  onChange={(mode) => void update({ notifications: { mode } })}
                  options={[
                    { value: "random", label: s.notifications.modeRandom },
                    { value: "fixed", label: s.notifications.modeFixed },
                  ]}
                />
                <p className="t-caption mt-2">{n.mode === "random" ? s.notifications.randomHint : s.notifications.fixedHint}</p>
              </div>

              {n.mode === "random" ? (
                <>
                  <Row title={s.notifications.perDay}>
                    <Stepper
                      value={n.perDay}
                      min={1}
                      max={6}
                      labelMinus={s.notifications.less}
                      labelPlus={s.notifications.more}
                      onChange={(perDay) => void update({ notifications: { perDay } })}
                    />
                  </Row>
                  <div className="px-4 py-3.5">
                    <p className="mb-2.5 text-[16px] font-medium">{s.notifications.activePeriod}</p>
                    <div className="flex flex-wrap gap-x-5 gap-y-2.5">
                      <TimeField label={s.notifications.from} value={n.activeFrom} onChange={(activeFrom) => void update({ notifications: { activeFrom } })} />
                      <TimeField label={s.notifications.to} value={n.activeTo} onChange={(activeTo) => void update({ notifications: { activeTo } })} />
                    </div>
                  </div>
                </>
              ) : (
                <div className="px-4 py-3.5">
                  <p className="mb-2.5 text-[16px] font-medium">{s.notifications.fixedTimes}</p>
                  <ul className="flex flex-wrap gap-2">
                    {n.fixedTimes.map((time) => (
                      <li key={time} className="tabular flex min-h-[44px] items-center gap-1 rounded-full bg-lime-soft pl-4 pr-1 text-[15.5px] font-semibold text-leaf-deep">
                        {time}
                        <button
                          type="button"
                          aria-label={s.notifications.removeTime(time)}
                          disabled={n.fixedTimes.length <= 1}
                          onClick={() => void update({ notifications: { fixedTimes: n.fixedTimes.filter((x) => x !== time) } })}
                          className="grid size-9 place-items-center rounded-full disabled:opacity-30"
                        >
                          <X aria-hidden="true" size={15} strokeWidth={2.6} />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {n.fixedTimes.length < 6 && (
                    <div className="mt-3 flex items-center gap-2">
                      <label className="sr-only" htmlFor="new-time">
                        {s.notifications.addTime}
                      </label>
                      <input id="new-time" type="time" value={newTime} onChange={(e) => isValidHm(e.target.value) && setNewTime(e.target.value)} className={timeInput} />
                      <Button
                        size="sm"
                        variant="glass"
                        icon={<Plus aria-hidden="true" size={16} />}
                        disabled={n.fixedTimes.includes(newTime)}
                        onClick={() => void update({ notifications: { fixedTimes: [...n.fixedTimes, newTime].sort() } })}
                      >
                        {s.notifications.addTime}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              <Row title={s.notifications.quiet} hint={s.notifications.quietHint}>
                <Toggle checked={n.quietEnabled} onChange={(quietEnabled) => void update({ notifications: { quietEnabled } })} label={s.notifications.quiet} />
              </Row>
              {n.quietEnabled && (
                <div className="flex flex-wrap gap-x-5 gap-y-2.5 px-4 py-3.5">
                  <TimeField label={s.notifications.from} value={n.quietFrom} onChange={(quietFrom) => void update({ notifications: { quietFrom } })} />
                  <TimeField label={s.notifications.to} value={n.quietTo} onChange={(quietTo) => void update({ notifications: { quietTo } })} />
                </div>
              )}
              <p className="t-caption px-4 py-3">{s.notifications.projectsHint}</p>
            </>
          )}
        </Section>

        <Section title={s.dailyFilm.title} icon={<Clapperboard aria-hidden="true" size={15} />} delay={2}>
          <Row title={s.dailyFilm.enable} hint={s.dailyFilm.enableHint}>
            <Toggle checked={settings.dailyFilm.enabled} onChange={(enabled) => void update({ dailyFilm: { enabled } })} label={s.dailyFilm.enable} />
          </Row>
          {settings.dailyFilm.enabled && (
            <>
              <Row title={s.dailyFilm.time} hint={s.dailyFilm.timeHint}>
                <input
                  type="time"
                  aria-label={s.dailyFilm.time}
                  value={settings.dailyFilm.time}
                  onChange={(e) => isValidHm(e.target.value) && void update({ dailyFilm: { time: e.target.value } })}
                  className={timeInput}
                />
              </Row>
              <div className="px-4 py-3.5">
                <p className="mb-2 text-[13.5px] font-semibold text-muted-strong">{t.films.version}</p>
                <Segmented<"full" | "highlights">
                  label={t.films.version}
                  size="sm"
                  value={settings.dailyFilm.variant}
                  onChange={(variant) => void update({ dailyFilm: { variant } })}
                  options={[
                    { value: "full", label: t.films.variantFull },
                    { value: "highlights", label: t.films.variantHighlights },
                  ]}
                />
              </div>
            </>
          )}
          <Row
            title={s.look.title}
            hint={lookSummary}
            icon={<Palette aria-hidden="true" size={18} />}
            onClick={() => {
              setLook(settings.film);
              setLookSheet(true);
            }}
          >
            <span className="text-[14px] font-semibold text-leaf-deep">{t.common.edit}</span>
          </Row>
        </Section>

        <Section title={s.app.title} icon={<Smartphone aria-hidden="true" size={15} />} delay={3}>
          <Row title={s.app.install} hint={standalone ? s.app.installed : isIos() ? t.onboarding.installIos : installable ? t.onboarding.installOther : s.app.installManual}>
            {standalone ? (
              <span className="grid size-9 place-items-center rounded-full bg-lime-soft text-leaf-deep">
                <Check aria-hidden="true" size={18} strokeWidth={2.6} />
              </span>
            ) : installable ? (
              <Button size="sm" onClick={() => void promptInstall()}>
                {t.onboarding.installCta}
              </Button>
            ) : null}
          </Row>
          <Row title={s.app.language} icon={<Globe aria-hidden="true" size={18} />}>
            <select
              aria-label={s.app.language}
              value={locale}
              onChange={(e) => {
                const next = e.target.value as Locale;
                setLocale(next);
                void api("/api/me", { method: "PATCH", body: { locale: next } }).catch(() => {});
              }}
              className="min-h-[44px] rounded-[14px] bg-white/85 px-3 text-[15px] font-semibold shadow-[inset_0_0_0_1px_rgb(32_48_30/0.1)] outline-none"
            >
              {(Object.keys(LOCALES) as Locale[]).map((code) => (
                <option key={code} value={code}>
                  {LOCALES[code].name}
                </option>
              ))}
            </select>
          </Row>
        </Section>

        <Section title={s.storage.title} icon={<Archive aria-hidden="true" size={15} />} delay={4}>
          <div className="px-4 py-4">
            {storage ? (
              <>
                <p className="tabular text-[24px] font-bold leading-none tracking-[-0.03em]">
                  {bytes(storage.totalBytes)}
                  {storage.quotaBytes > 0 && <span className="ml-1.5 text-[15px] font-semibold text-muted-strong">/ {bytes(storage.quotaBytes)}</span>}
                </p>
                <p className="t-caption mt-1">{s.storage.summary(storage.moments, storage.films)}</p>
                <div
                  role="img"
                  aria-label={storageParts.map((p) => `${p.label}: ${bytes(p.value)}`).join(", ")}
                  className="mt-3.5 flex h-3 overflow-hidden rounded-full bg-ink/8"
                >
                  {storageParts.map((p) => (
                    <span key={p.label} className={clsx("h-full", p.color)} style={{ width: `${(p.value / storageBase) * 100}%` }} />
                  ))}
                </div>
                <ul className="mt-3.5 grid grid-cols-1 gap-x-6 gap-y-2 min-[520px]:grid-cols-2">
                  {storageParts.map((p) => (
                    <li key={p.label} className="flex items-center gap-2.5 text-[13.5px]">
                      <span className={clsx("size-2.5 shrink-0 rounded-full", p.color)} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-muted-strong">{p.label}</span>
                      <span className="tabular font-semibold">{bytes(p.value)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <Skeleton className="h-[110px]" />
            )}
          </div>
          <Row
            title={s.data.export}
            hint={s.data.exportHint}
            icon={<Archive aria-hidden="true" size={18} />}
            onClick={() => {
              startDownload("/api/account/export", "flash-archive.zip");
              toast(s.data.exportStarted, "success");
            }}
          />
        </Section>

        <Section title={s.account.title} icon={<ShieldCheck aria-hidden="true" size={15} />} delay={5}>
          <Row title={s.account.changePassword} icon={<KeyRound aria-hidden="true" size={18} />} onClick={() => setPasswordSheet(true)} />
          <Row title={s.account.logout} icon={<LogOut aria-hidden="true" size={18} />} onClick={() => setLogout(true)} />
        </Section>

        {/* Опасные действия отделены от остальных и требуют пароль. */}
        <Reveal delay={6}>
          <h2 className="mb-2.5 px-1 text-[13px] font-semibold uppercase tracking-[0.1em] text-danger">{s.data.dangerTitle}</h2>
          <div className="glass divide-y divide-line overflow-hidden">
            <button type="button" onClick={() => setDanger("data")} className="press flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left text-danger">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-danger-soft">
                <Trash2 aria-hidden="true" size={18} />
              </span>
              <span>
                <span className="block text-[16px] font-semibold leading-tight">{s.data.deleteData}</span>
                <span className="mt-0.5 block text-[13px] text-danger/80">{s.data.deleteDataHint}</span>
              </span>
            </button>
            <button type="button" onClick={() => setDanger("account")} className="press flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left text-danger">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-danger-soft">
                <UserRound aria-hidden="true" size={18} />
              </span>
              <span>
                <span className="block text-[16px] font-semibold leading-tight">{s.data.deleteAccount}</span>
                <span className="mt-0.5 block text-[13px] text-danger/80">{s.data.deleteAccountHint}</span>
              </span>
            </button>
          </div>
        </Reveal>

        <p className="px-4 text-center text-[13px] leading-snug text-muted-strong">
          {s.privacy}
          <br />
          Flash {APP_VERSION}
        </p>
      </div>

      <Sheet
        open={nameSheet}
        onClose={() => setNameSheet(false)}
        title={s.profile.title}
        locked={busy}
        footer={
          <Button block loading={busy} disabled={!name.trim()} onClick={() => void saveName()}>
            {t.common.save}
          </Button>
        }
      >
        <Field label={t.auth.name} value={name} maxLength={60} autoComplete="given-name" onChange={(e) => setName(e.target.value)} />
      </Sheet>

      <Sheet
        open={lookSheet}
        onClose={() => setLookSheet(false)}
        title={s.look.title}
        description={s.look.hint}
        tall
        footer={
          <Button
            size="lg"
            block
            onClick={async () => {
              if (look) await update({ film: look });
              setLookSheet(false);
              toast(t.common.saved, "success");
            }}
          >
            {t.common.save}
          </Button>
        }
      >
        {look && <FilmOptionsFields value={look} onChange={(patch) => setLook((prev) => (prev ? { ...prev, ...patch } : prev))} />}
      </Sheet>

      <Sheet
        open={passwordSheet}
        onClose={() => setPasswordSheet(false)}
        title={s.account.changePassword}
        locked={busy}
        footer={
          <Button block loading={busy} disabled={!currentPassword || newPassword.length < 8} onClick={() => void changePassword()}>
            {t.common.save}
          </Button>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void changePassword();
          }}
        >
          <Field label={s.account.currentPassword} type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
          <Field label={s.account.newPassword} type="password" autoComplete="new-password" hint={t.auth.passwordHint} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        </form>
      </Sheet>

      <ConfirmSheet
        open={danger !== null}
        onClose={() => {
          setDanger(null);
          setDangerPassword("");
        }}
        onConfirm={doDelete}
        title={danger === "account" ? s.data.confirmAccountTitle : s.data.confirmDataTitle}
        message={s.data.confirmText}
        confirmLabel={t.common.delete}
        danger
        busy={busy}
      >
        <Field label={t.auth.password} type="password" autoComplete="current-password" value={dangerPassword} onChange={(e) => setDangerPassword(e.target.value)} />
      </ConfirmSheet>

      <ConfirmSheet
        open={logout}
        onClose={() => setLogout(false)}
        onConfirm={doLogout}
        title={s.account.logoutTitle}
        message={s.account.logoutText}
        confirmLabel={s.account.logout}
        busy={busy}
      />
    </Page>
  );
}
