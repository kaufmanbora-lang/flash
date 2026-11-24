"use client";

import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, CalendarRange, Check, Infinity as InfinityIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useSWRConfig } from "swr";
import { api, errorText } from "@/client/api";
import { haptic } from "@/client/haptics";
import { useToday } from "@/client/hooks";
import { useLocale, useT } from "@/client/i18n";
import { BackHeader, Page } from "@/components/app/Page";
import { Button } from "@/components/ui/Button";
import { Field, TextArea, Toggle } from "@/components/ui/Controls";
import { useToast } from "@/components/ui/Toast";
import { COVER_GRADIENTS, COVER_PRESETS, PERIOD_KINDS, type CoverPreset, type PeriodKind } from "@/lib/constants";
import { addDays, diffDays, isValidYmd, type Ymd } from "@/lib/dates";
import { fmtFullDate } from "@/lib/format";
import { periodEnd } from "@/lib/projects";

/** Доля круга на карточке: чем длиннее период, тем полнее дуга (логарифмически). */
const ARC: Partial<Record<PeriodKind, number>> = { d1: 0.08, d3: 0.18, d7: 0.3, d14: 0.42, d30: 0.56, m3: 0.72, m6: 0.86, y1: 1 };

const dateInput =
  "min-h-[52px] w-full rounded-[18px] bg-white/80 px-4 text-ink shadow-[inset_0_0_0_1px_rgb(32_48_30/0.1)] outline-none focus:shadow-[inset_0_0_0_2px_var(--color-leaf)]";

function PeriodCard({ kind, selected, index, onSelect }: { kind: PeriodKind; selected: boolean; index: number; onSelect: () => void }) {
  const t = useT();
  const info = t.projectNew.periods[kind];
  const arc = ARC[kind];
  const r = 21;
  const c = 2 * Math.PI * r;
  return (
    <motion.button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => {
        haptic("light");
        onSelect();
      }}
      initial={{ opacity: 0, y: 18, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: selected ? 1.02 : 1 }}
      whileTap={{ scale: 0.96 }}
      transition={{ type: "spring", stiffness: 380, damping: 30, delay: selected ? 0 : index * 0.035 }}
      className={clsx("glass relative flex min-h-[132px] flex-col items-start justify-between p-4 text-left", selected && "glass-tint")}
    >
      <span className="relative grid size-[52px] place-items-center">
        {arc !== undefined ? (
          <svg width="52" height="52" viewBox="0 0 52 52" className="-rotate-90" aria-hidden="true">
            <circle cx="26" cy="26" r={r} fill="none" strokeWidth="5" className="stroke-ink/10" />
            <motion.circle
              cx="26"
              cy="26"
              r={r}
              fill="none"
              strokeWidth="5"
              strokeLinecap="round"
              className="stroke-leaf"
              strokeDasharray={c}
              initial={{ strokeDashoffset: c }}
              animate={{ strokeDashoffset: c * (1 - arc) }}
              transition={{ duration: 0.9, delay: 0.15 + index * 0.04, ease: [0.22, 1, 0.36, 1] }}
            />
          </svg>
        ) : (
          <span className="grid size-[52px] place-items-center rounded-full bg-lime-soft text-leaf-deep">
            {kind === "open" ? <InfinityIcon aria-hidden="true" size={24} /> : <CalendarRange aria-hidden="true" size={23} />}
          </span>
        )}
      </span>
      <span>
        <span className="block text-[20px] font-bold leading-tight tracking-[-0.025em]">{info.label}</span>
        <span className="t-caption mt-0.5 block text-[12.5px] leading-tight">{info.hint}</span>
      </span>
      <AnimatePresence>
        {selected && (
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 26 }}
            className="absolute right-3 top-3 grid size-7 place-items-center rounded-full bg-leaf text-white"
          >
            <Check aria-hidden="true" size={16} strokeWidth={3} />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

export default function NewProjectPage() {
  const t = useT();
  const n = t.projectNew;
  const toast = useToast();
  const router = useRouter();
  const today = useToday();
  const { locale } = useLocale();
  const { mutate } = useSWRConfig();

  const [step, setStep] = useState<1 | 2>(1);
  /** Новый шаг всегда открывается с начала, а не с позиции прокрутки предыдущего. */
  const goStep = (next: 1 | 2) => {
    setStep(next);
    window.scrollTo({ top: 0 });
  };
  const [kind, setKind] = useState<PeriodKind | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [start, setStart] = useState<Ymd>(today);
  const [end, setEnd] = useState<Ymd>(addDays(today, 29));
  const [preset, setPreset] = useState<CoverPreset>("mint");
  const [includeExisting, setIncludeExisting] = useState(true);
  const [errors, setErrors] = useState<{ title?: string; end?: string }>({});
  const [busy, setBusy] = useState(false);

  const computedEnd = useMemo<Ymd | null>(() => {
    if (!kind) return null;
    if (kind === "custom") return end;
    if (kind === "open") return null;
    return periodEnd(kind, start);
  }, [kind, start, end]);

  const create = async () => {
    if (!kind) return;
    const nextErrors: typeof errors = {};
    if (!title.trim()) nextErrors.title = n.errName;
    if (kind === "custom" && (!isValidYmd(end) || end < start)) nextErrors.end = n.errEnd;
    if (computedEnd && computedEnd < today) nextErrors.end = t.errors.end_in_past;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setBusy(true);
    try {
      const res = await api<{ id: string }>("/api/projects", {
        body: {
          title: title.trim(),
          description: description.trim(),
          periodKind: kind,
          startDate: start,
          endDate: kind === "custom" ? end : undefined,
          coverPreset: preset,
          includeExisting: includeExisting && start <= today,
          today,
        },
      });
      void mutate((key) => typeof key === "string" && (key.startsWith("/api/projects") || key.startsWith("/api/home")));
      haptic("success");
      toast(n.created, "success");
      router.replace(`/projects/${res.id}`);
    } catch (err) {
      toast(errorText(t, err), "error");
      setBusy(false);
    }
  };

  return (
    <Page>
      <BackHeader fallback="/films?tab=projects" title={n.title} />
      <p className="t-eyebrow pt-2 text-leaf-deep">{n.stepOf(step, 2)}</p>

      <AnimatePresence mode="wait" initial={false}>
        {step === 1 ? (
          <motion.div
            key="step-1"
            initial={{ opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -16, transition: { duration: 0.15 } }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          >
            <h1 className="t-display mt-2">{n.step1}</h1>
            <p className="mt-2 text-[16px] leading-snug text-muted-strong">{n.step1Hint}</p>
            <div role="radiogroup" aria-label={n.step1} className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {PERIOD_KINDS.map((k, i) => (
                <PeriodCard key={k} kind={k} index={i} selected={kind === k} onSelect={() => setKind(k)} />
              ))}
            </div>
            {/* Кнопка закреплена над навигацией, чтобы до неё не приходилось листать. */}
            <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+104px)] z-10 mt-6">
              <Button size="lg" block disabled={!kind} icon={<ArrowRight aria-hidden="true" size={20} />} onClick={() => goStep(2)} className="shadow-float">
                {n.next}
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="step-2"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16, transition: { duration: 0.15 } }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          >
            <h1 className="t-display mt-2">{n.step2}</h1>
            <button type="button" onClick={() => goStep(1)} className="press mt-2 min-h-[36px] rounded-full text-[15px] font-semibold text-leaf-deep">
              {kind ? n.periods[kind].label : ""} · {t.common.edit.toLocaleLowerCase()}
            </button>

            <div className="mt-5 flex flex-col gap-5">
              <div>
                <Field
                  label={n.name}
                  placeholder={n.namePlaceholder}
                  value={title}
                  maxLength={80}
                  onChange={(e) => setTitle(e.target.value)}
                  error={errors.title}
                  required
                />
                <div className="no-scrollbar -mx-5 mt-2.5 flex gap-2 overflow-x-auto px-5">
                  {n.suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        haptic("light");
                        setTitle(s);
                      }}
                      className="glass press min-h-[38px] shrink-0 rounded-full px-3.5 text-[13.5px] font-semibold text-muted-strong"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <TextArea
                label={n.description}
                placeholder={n.descriptionPlaceholder}
                value={description}
                maxLength={500}
                onChange={(e) => setDescription(e.target.value)}
              />

              <div className="flex gap-3">
                <div className="min-w-0 flex-1">
                  <label htmlFor="project-start" className="mb-1.5 block text-[13.5px] font-semibold text-muted-strong">
                    {n.start}
                  </label>
                  <input
                    id="project-start"
                    type="date"
                    value={start}
                    onChange={(e) => isValidYmd(e.target.value) && setStart(e.target.value)}
                    className={dateInput}
                  />
                </div>
                {kind === "custom" && (
                  <div className="min-w-0 flex-1">
                    <label htmlFor="project-end" className="mb-1.5 block text-[13.5px] font-semibold text-muted-strong">
                      {n.end}
                    </label>
                    <input
                      id="project-end"
                      type="date"
                      min={start > today ? start : today}
                      value={end}
                      aria-invalid={errors.end ? true : undefined}
                      onChange={(e) => isValidYmd(e.target.value) && setEnd(e.target.value)}
                      className={dateInput}
                    />
                  </div>
                )}
              </div>
              {errors.end ? (
                <p role="alert" className="-mt-3 text-[13.5px] font-medium text-danger">
                  {errors.end}
                </p>
              ) : (
                <p className="-mt-3 rounded-[16px] bg-lime-soft px-4 py-3 text-[14.5px] font-semibold text-leaf-deep">
                  {computedEnd ? n.endsOn(fmtFullDate(computedEnd, locale), diffDays(computedEnd, start) + 1) : n.openEnded}
                </p>
              )}

              <fieldset>
                <legend className="mb-2 text-[13.5px] font-semibold text-muted-strong">{n.cover}</legend>
                <div role="radiogroup" aria-label={n.cover} className="grid grid-cols-6 gap-2">
                  {COVER_PRESETS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={preset === p}
                      aria-label={n.presets[p]}
                      onClick={() => {
                        haptic("light");
                        setPreset(p);
                      }}
                      style={{ background: COVER_GRADIENTS[p] }}
                      className={clsx(
                        "press grid aspect-square min-h-[44px] place-items-center rounded-[16px] text-white",
                        preset === p ? "shadow-[0_0_0_3px_var(--color-leaf-deep)]" : "shadow-[inset_0_0_0_1px_rgb(32_48_30/0.1)]",
                      )}
                    >
                      {preset === p && <Check aria-hidden="true" size={18} strokeWidth={3} className="drop-shadow" />}
                    </button>
                  ))}
                </div>
                <p className="t-caption mt-2">{n.coverHint}</p>
              </fieldset>

              {start <= today && (
                <div className="glass flex items-center gap-3 px-4 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[16px] font-medium leading-snug">{n.includeExisting}</p>
                    <p className="t-caption mt-0.5">{n.includeExistingHint}</p>
                  </div>
                  <Toggle checked={includeExisting} onChange={setIncludeExisting} label={n.includeExisting} />
                </div>
              )}

              <Button size="lg" block loading={busy} onClick={() => void create()}>
                {n.create}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Page>
  );
}
