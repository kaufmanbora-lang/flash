"use client";

import clsx from "clsx";
import { CalendarClock, Check, Flag, ImageIcon, Pause, PencilLine, Play, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { haptic } from "@/client/haptics";
import { useLocale, useT } from "@/client/i18n";
import { Button } from "@/components/ui/Button";
import { Field, TextArea, Toggle } from "@/components/ui/Controls";
import { ConfirmSheet, Sheet } from "@/components/ui/Sheet";
import { COVER_GRADIENTS, COVER_PRESETS, type CoverPreset } from "@/lib/constants";
import { addDays, isValidYmd, type Ymd } from "@/lib/dates";
import { fmtDayMonth } from "@/lib/format";
import type { ProjectDetailDto } from "@/lib/types";

export type ProjectPatch = Record<string, unknown>;

type Panel = null | "end" | "edit" | "cover" | "finish" | "delete";

const dateInput =
  "min-h-[52px] w-full rounded-[18px] bg-white/80 px-4 text-ink shadow-[inset_0_0_0_1px_rgb(32_48_30/0.1)] outline-none focus:shadow-[inset_0_0_0_2px_var(--color-leaf)]";

function Action({ icon, title, hint, onClick, danger }: { icon: ReactNode; title: string; hint?: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic("light");
        onClick();
      }}
      className={clsx("press flex min-h-[64px] w-full items-center gap-3.5 px-4 py-3 text-left", danger && "text-danger")}
    >
      <span className={clsx("grid size-10 shrink-0 place-items-center rounded-full", danger ? "bg-danger-soft" : "bg-lime-soft text-leaf-deep")}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[16px] font-semibold leading-tight">{title}</span>
        {hint && <span className={clsx("mt-0.5 block text-[13px] leading-snug", danger ? "text-danger/80" : "text-muted-strong")}>{hint}</span>}
      </span>
    </button>
  );
}

/**
 * Управление проектом: пауза и продолжение, дата окончания, продление, досрочное завершение,
 * название, обложка и удаление.
 */
export function ManageSheet({
  project,
  today,
  open,
  onClose,
  onPatch,
  onDelete,
  busy,
}: {
  project: ProjectDetailDto;
  today: Ymd;
  open: boolean;
  onClose: () => void;
  /** Отправляет изменение; возвращает true при успехе. */
  onPatch: (patch: ProjectPatch, message: string) => Promise<boolean>;
  onDelete: (deleteFilms: boolean) => Promise<void>;
  busy: boolean;
}) {
  const t = useT();
  const pp = t.projectPage;
  const { locale } = useLocale();
  const [panel, setPanel] = useState<Panel>(null);
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description);
  const [end, setEnd] = useState<Ymd>(project.endDate ?? addDays(today, 30));
  const [deleteFilms, setDeleteFilms] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(project.title);
      setDescription(project.description);
      setEnd(project.endDate ?? addDays(today, 30));
      setDeleteFilms(false);
    }
  }, [open, project.title, project.description, project.endDate, today]);

  const go = (next: Panel) => {
    onClose();
    setPanel(next);
  };
  const patchAndClose = async (patch: ProjectPatch, message: string) => {
    if (await onPatch(patch, message)) {
      setPanel(null);
      onClose();
    }
  };

  const completed = project.status === "completed";
  const frames = project.moments.filter((m) => m.posterUrl && m.status === "ready").slice(0, 30);
  const minEnd = project.startDate > today ? project.startDate : today;

  return (
    <>
      <Sheet open={open} onClose={onClose} title={pp.manage}>
        <div className="glass divide-y divide-line overflow-hidden">
          {project.status === "active" && (
            <Action icon={<Pause aria-hidden="true" size={18} />} title={pp.pause} hint={pp.pauseHint} onClick={() => void patchAndClose({ action: "pause" }, pp.paused)} />
          )}
          {project.status === "paused" && (
            <Action icon={<Play aria-hidden="true" size={18} />} title={pp.resume} hint={pp.resumeHint} onClick={() => void patchAndClose({ action: "resume" }, pp.resumed)} />
          )}
          {completed && (
            <Action icon={<RotateCcw aria-hidden="true" size={18} />} title={pp.reopen} hint={pp.reopenHint} onClick={() => void patchAndClose({ action: "reopen" }, pp.resumed)} />
          )}
          {!completed && (
            <Action icon={<CalendarClock aria-hidden="true" size={18} />} title={pp.changeEnd} hint={project.endDate ? fmtDayMonth(project.endDate, locale) : t.project.open} onClick={() => go("end")} />
          )}
          {!completed && <Action icon={<Flag aria-hidden="true" size={18} />} title={pp.finish} hint={pp.finishHint} onClick={() => go("finish")} />}
          <Action icon={<PencilLine aria-hidden="true" size={18} />} title={pp.edit} onClick={() => go("edit")} />
          <Action icon={<ImageIcon aria-hidden="true" size={18} />} title={pp.cover} onClick={() => go("cover")} />
        </div>

        {project.endDate && (
          <div className="mt-4">
            <p className="mb-2 px-1 text-[13.5px] font-semibold text-muted-strong">{pp.extend}</p>
            <div className="grid grid-cols-3 gap-2.5">
              {[7, 14, 30].map((days) => (
                <Button
                  key={days}
                  variant="glass"
                  size="sm"
                  disabled={busy}
                  className="px-2"
                  onClick={() => void patchAndClose({ action: "extend", days }, pp.extended)}
                >
                  {pp.extendBy(days)}
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="glass mt-4 overflow-hidden">
          <Action danger icon={<Trash2 aria-hidden="true" size={18} />} title={pp.delete} hint={pp.deleteHint} onClick={() => go("delete")} />
        </div>
        <div className="h-2" />
      </Sheet>

      <Sheet
        open={panel === "end"}
        onClose={() => setPanel(null)}
        title={pp.changeEnd}
        locked={busy}
        footer={
          <div className="flex gap-3">
            <Button variant="glass" block disabled={busy} onClick={() => void patchAndClose({ action: "setEnd", endDate: null }, pp.endChanged)}>
              {pp.makeOpen}
            </Button>
            <Button block loading={busy} disabled={!isValidYmd(end) || end < minEnd} onClick={() => void patchAndClose({ action: "setEnd", endDate: end }, pp.endChanged)}>
              {t.common.save}
            </Button>
          </div>
        }
      >
        <label htmlFor="manage-end" className="mb-1.5 block text-[13.5px] font-semibold text-muted-strong">
          {pp.endDate}
        </label>
        <input id="manage-end" type="date" min={minEnd} value={end} onChange={(e) => isValidYmd(e.target.value) && setEnd(e.target.value)} className={dateInput} />
        <p className="t-caption mt-2">{pp.endHint}</p>
      </Sheet>

      <Sheet
        open={panel === "edit"}
        onClose={() => setPanel(null)}
        title={pp.edit}
        locked={busy}
        footer={
          <Button block loading={busy} disabled={!title.trim()} onClick={() => void patchAndClose({ title: title.trim(), description: description.trim() }, pp.saved)}>
            {t.common.save}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label={pp.titleLabel} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          <TextArea label={pp.descriptionLabel} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </Sheet>

      <Sheet open={panel === "cover"} onClose={() => setPanel(null)} title={pp.cover} tall locked={busy}>
        <div className="flex flex-col gap-5 pb-2">
          <button
            type="button"
            aria-pressed={project.cover.kind === "auto"}
            onClick={() => void patchAndClose({ cover: { kind: "auto" } }, pp.saved)}
            className={clsx("glass press flex min-h-[68px] items-center gap-3 px-4 text-left", project.cover.kind === "auto" && "glass-tint")}
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-white/70 text-leaf-deep">
              {project.cover.kind === "auto" ? <Check aria-hidden="true" size={18} strokeWidth={2.6} /> : <ImageIcon aria-hidden="true" size={18} />}
            </span>
            <span>
              <span className="block text-[16px] font-semibold leading-tight">{pp.coverAuto}</span>
              <span className="t-caption block">{pp.coverAutoHint}</span>
            </span>
          </button>

          {frames.length > 0 && (
            <div>
              <p className="mb-2 text-[13.5px] font-semibold text-muted-strong">{pp.coverFrame}</p>
              <div className="grid grid-cols-4 gap-2">
                {frames.map((m) => {
                  const active = project.cover.kind === "moment" && project.cover.momentId === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={active}
                      aria-label={`${pp.coverFrame}: ${fmtDayMonth(m.date, locale)}, ${m.time}`}
                      onClick={() => void patchAndClose({ cover: { kind: "moment", momentId: m.id } }, pp.saved)}
                      className={clsx("press relative aspect-[4/5] overflow-hidden rounded-[14px] bg-lime-soft", active && "shadow-[0_0_0_3px_var(--color-leaf-deep)]")}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={m.posterUrl ?? ""} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <p className="mb-2 text-[13.5px] font-semibold text-muted-strong">{pp.coverGradient}</p>
            <div className="grid grid-cols-6 gap-2">
              {COVER_PRESETS.map((preset: CoverPreset) => {
                const active = project.cover.kind === "preset" && project.cover.preset === preset;
                return (
                  <button
                    key={preset}
                    type="button"
                    aria-pressed={active}
                    aria-label={t.projectNew.presets[preset]}
                    onClick={() => void patchAndClose({ cover: { kind: "preset", preset } }, pp.saved)}
                    style={{ background: COVER_GRADIENTS[preset] }}
                    className={clsx(
                      "press grid aspect-square min-h-[44px] place-items-center rounded-[16px] text-white",
                      active ? "shadow-[0_0_0_3px_var(--color-leaf-deep)]" : "shadow-[inset_0_0_0_1px_rgb(32_48_30/0.1)]",
                    )}
                  >
                    {active && <Check aria-hidden="true" size={18} strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </Sheet>

      <ConfirmSheet
        open={panel === "finish"}
        onClose={() => setPanel(null)}
        onConfirm={() => patchAndClose({ action: "complete" }, pp.finished)}
        title={pp.finishTitle}
        message={pp.finishText}
        confirmLabel={pp.finishConfirm}
        busy={busy}
      />

      <ConfirmSheet
        open={panel === "delete"}
        onClose={() => setPanel(null)}
        onConfirm={() => onDelete(deleteFilms)}
        title={pp.deleteTitle}
        message={pp.deleteText}
        confirmLabel={t.common.delete}
        danger
        busy={busy}
      >
        <div className="glass flex items-center gap-3 px-4 py-3.5">
          <p className="min-w-0 flex-1 text-[15.5px] font-medium">{pp.deleteFilms}</p>
          <Toggle checked={deleteFilms} onChange={setDeleteFilms} label={pp.deleteFilms} />
        </div>
      </ConfirmSheet>
    </>
  );
}
