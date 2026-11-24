"use client";

import { Download, Heart, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { api, errorText, fetcher } from "@/client/api";
import { useToday } from "@/client/hooks";
import { useLocale, useT } from "@/client/i18n";
import { startDownload } from "@/client/share";
import { VideoPlayer } from "@/components/player/VideoPlayer";
import { Button } from "@/components/ui/Button";
import { Chip, TextArea } from "@/components/ui/Controls";
import { ConfirmSheet, Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { NOTE_MAX } from "@/lib/constants";
import { capitalize, fmtDayMonth, fmtWeekday } from "@/lib/format";
import type { MomentDto, ProjectDto } from "@/lib/types";

/** Просмотр момента: видео, заметка, избранное, проекты, скачивание и удаление. */
export function MomentViewer({ moment, onClose }: { moment: MomentDto | null; onClose: () => void }) {
  const t = useT();
  const m = t.moment;
  const toast = useToast();
  const today = useToday();
  const { locale } = useLocale();
  const { data: projectsData } = useSWR<{ projects: ProjectDto[] }>(moment ? `/api/projects?today=${today}` : null, fetcher);

  const [current, setCurrent] = useState<MomentDto | null>(moment);
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setCurrent(moment);
    setNote(moment?.note ?? "");
  }, [moment]);

  const patch = async (body: Record<string, unknown>) => {
    if (!current) return;
    try {
      const res = await api<{ moment: MomentDto }>(`/api/moments/${current.id}`, { method: "PATCH", body });
      setCurrent(res.moment);
    } catch (err) {
      toast(errorText(t, err), "error");
    }
  };

  const saveNote = async () => {
    if (!current || note.trim() === current.note) return;
    setSavingNote(true);
    await patch({ note: note.trim() });
    setSavingNote(false);
    toast(m.noteSaved, "success");
  };

  const remove = async () => {
    if (!current) return;
    setDeleting(true);
    try {
      await api(`/api/moments/${current.id}`, { method: "DELETE" });
      toast(m.deleted, "success");
      setConfirmDelete(false);
      onClose();
    } catch (err) {
      toast(errorText(t, err), "error");
    } finally {
      setDeleting(false);
    }
  };

  // Предлагаем только проекты, в период которых снят момент (и те, где он уже лежит).
  const projects = (projectsData?.projects ?? []).filter((p) => {
    if (!current) return false;
    if (current.projectIds.includes(p.id)) return true;
    const end = p.progress.expectedEnd ?? p.endDate;
    return p.status !== "completed" && current.date >= p.startDate && (!end || current.date <= end);
  });
  const title = current ? `${fmtDayMonth(current.date, locale)}, ${current.time}` : "";

  return (
    <>
      <Sheet
        open={!!moment}
        onClose={onClose}
        title={title}
        description={current ? capitalize(fmtWeekday(current.date, locale)) + (current.source === "upload" ? ` · ${m.fromGallery}` : "") : undefined}
        tall
      >
        {current && (
          <div className="flex flex-col gap-5 pb-2">
            {current.videoUrl ? (
              <VideoPlayer
                key={current.id}
                src={current.videoUrl}
                poster={current.posterUrl}
                title={title}
                width={current.width || 9}
                height={current.height || 16}
                maxHeight="54dvh"
                loop
              />
            ) : (
              <div className="glass grid min-h-[200px] place-items-center p-6 text-center text-[15px] text-muted-strong">
                {t.player.error}
              </div>
            )}

            <div className="flex gap-3">
              <Button
                variant="glass"
                block
                aria-pressed={current.favorite}
                icon={<Heart aria-hidden="true" size={18} fill={current.favorite ? "currentColor" : "none"} className={current.favorite ? "text-danger" : undefined} />}
                onClick={() => void patch({ favorite: !current.favorite })}
              >
                {current.favorite ? m.inFavorites : m.addFavorite}
              </Button>
              {current.downloadUrl && (
                <Button
                  variant="glass"
                  block
                  icon={<Download aria-hidden="true" size={18} />}
                  onClick={() => startDownload(current.downloadUrl!, current.fileName)}
                >
                  {m.download}
                </Button>
              )}
            </div>

            <div>
              <TextArea
                label={m.note}
                placeholder={m.notePlaceholder}
                value={note}
                maxLength={NOTE_MAX}
                onChange={(e) => setNote(e.target.value)}
                onBlur={() => void saveNote()}
              />
              {note.trim() !== current.note && (
                <Button variant="ghost" size="sm" loading={savingNote} className="mt-1" onClick={() => void saveNote()}>
                  {t.common.save}
                </Button>
              )}
            </div>

            {projects.length > 0 && (
              <div>
                <p className="mb-2 text-[13.5px] font-semibold text-muted-strong">{m.projects}</p>
                <div className="flex flex-wrap gap-2">
                  {projects.map((p) => {
                    const selected = current.projectIds.includes(p.id);
                    return (
                      <Chip
                        key={p.id}
                        selected={selected}
                        onClick={() =>
                          void patch({
                            projectIds: selected ? current.projectIds.filter((id) => id !== p.id) : [...current.projectIds, p.id],
                          })
                        }
                      >
                        {p.title}
                      </Chip>
                    );
                  })}
                </div>
              </div>
            )}

            <Button variant="danger" block icon={<Trash2 aria-hidden="true" size={18} />} onClick={() => setConfirmDelete(true)}>
              {m.delete}
            </Button>
          </div>
        )}
      </Sheet>
      <ConfirmSheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        title={m.deleteTitle}
        message={m.deleteText}
        confirmLabel={t.common.delete}
        danger
        busy={deleting}
      />
    </>
  );
}
