// Очередь загрузки моментов. Видео режется на части и отправляется по одной:
// обрыв связи не сбрасывает загрузку, она продолжается с последней принятой части.
// Очередь переживает перезапуск приложения (черновики лежат в IndexedDB).

import type { MomentDto, UploadInitDto } from "@/lib/types";
import { api, ApiError } from "./api";
import { allDrafts, deleteDraft, getDraft, patchDraft, putDraft, type Draft, type DraftInfo } from "./idb";

type Listener = () => void;

const RETRY_DELAYS = [4_000, 12_000, 30_000, 60_000];

function putPart(url: string, part: Blob, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.timeout = 180_000;
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        /* не JSON */
      }
      reject(new ApiError(xhr.status, String(data.error ?? "generic"), String(data.message ?? ""), data));
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "network"));
    xhr.ontimeout = () => reject(new ApiError(0, "network", "timeout"));
    xhr.onabort = () => reject(new ApiError(0, "aborted", "aborted"));
    xhr.send(part);
  });
}

class UploadManager {
  private listeners = new Set<Listener>();
  private snapshot: DraftInfo[] = [];
  private posterUrls = new Map<string, string>();
  private running = false;
  private started = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = new Set<string>();

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): DraftInfo[] => this.snapshot;
  getServerSnapshot = (): DraftInfo[] => EMPTY;

  /** Запускается один раз при открытии приложения. */
  start(): void {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    window.addEventListener("online", () => this.kick());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.kick();
    });
    void this.refresh().then(() => this.kick());
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  private async refresh(): Promise<void> {
    const drafts = await allDrafts().catch(() => [] as Draft[]);
    const alive = new Set(drafts.map((d) => d.clientId));
    for (const [id, url] of this.posterUrls) {
      if (!alive.has(id)) {
        URL.revokeObjectURL(url);
        this.posterUrls.delete(id);
      }
    }
    this.snapshot = drafts.map((d) => {
      if (d.poster && !this.posterUrls.has(d.clientId)) this.posterUrls.set(d.clientId, URL.createObjectURL(d.poster));
      const { blob: _blob, poster: _poster, ...info } = d;
      return { ...info, posterUrl: this.posterUrls.get(d.clientId) ?? null };
    });
    this.emit();
  }

  private patchLocal(clientId: string, patch: Partial<DraftInfo>): void {
    this.snapshot = this.snapshot.map((d) => (d.clientId === clientId ? { ...d, ...patch } : d));
    this.emit();
  }

  /** Сохраняет новый момент на устройстве и ставит его в очередь загрузки. */
  async add(draft: Draft): Promise<void> {
    await putDraft(draft);
    await this.refresh();
    this.kick();
  }

  async retry(clientId: string): Promise<void> {
    await patchDraft(clientId, { state: "queued", error: null, attempts: 0 });
    await this.refresh();
    this.kick();
  }

  /** Удаляет черновик; начатая на сервере загрузка отменяется. */
  async remove(clientId: string): Promise<void> {
    this.cancelled.add(clientId);
    const draft = await getDraft(clientId);
    await deleteDraft(clientId);
    await this.refresh();
    if (draft?.momentId) await api(`/api/moments/${draft.momentId}`, { method: "DELETE" }).catch(() => {});
  }

  kick(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (!this.running) void this.run();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        if (typeof navigator !== "undefined" && navigator.onLine === false) break;
        const drafts = await allDrafts();
        const next = drafts.find((d) => d.state === "queued" || d.state === "uploading" || d.state === "error");
        if (!next) break;
        const ok = await this.uploadOne(next);
        if (!ok) {
          // Временная ошибка: пауза перед повтором, очередь не теряется.
          const delay = RETRY_DELAYS[Math.min(next.attempts, RETRY_DELAYS.length - 1)];
          this.retryTimer = setTimeout(() => this.kick(), delay);
          break;
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** true — черновик обработан (загружен или отклонён окончательно); false — стоит повторить позже. */
  private async uploadOne(draft: Draft): Promise<boolean> {
    const id = draft.clientId;
    try {
      await patchDraft(id, { state: "uploading", error: null });
      this.patchLocal(id, { state: "uploading", error: null });

      const init = await api<UploadInitDto>("/api/moments", {
        body: {
          clientId: id,
          recordedAt: draft.recordedAt,
          localDate: draft.localDate,
          localTime: draft.localTime,
          note: draft.note,
          source: draft.source,
          mime: draft.mime || "video/mp4",
          sizeBytes: draft.size,
          durationMs: Math.round(draft.durationMs),
          width: draft.width,
          height: draft.height,
          projectIds: draft.projectIds,
          autoProjects: draft.autoProjects ?? false,
        },
      });
      const momentId = init.moment.id;
      await patchDraft(id, { momentId });

      if (init.moment.status === "uploading") {
        const chunk = init.chunkBytes;
        const parts = Math.ceil(draft.size / chunk);
        const have = new Set(init.uploadedParts);
        let uploaded = [...have].reduce((sum, n) => sum + Math.min(chunk, draft.size - (n - 1) * chunk), 0);
        this.patchLocal(id, { uploadedBytes: uploaded, momentId });

        for (let n = 1; n <= parts; n++) {
          if (have.has(n)) continue;
          if (this.cancelled.has(id)) return true;
          const from = (n - 1) * chunk;
          const part = draft.blob.slice(from, Math.min(draft.size, from + chunk));
          const base = uploaded;
          await putPart(`/api/moments/${momentId}/parts/${n}`, part, (loaded) =>
            this.patchLocal(id, { uploadedBytes: Math.min(draft.size, base + loaded) }),
          );
          uploaded += part.size;
          await patchDraft(id, { uploadedBytes: uploaded });
          this.patchLocal(id, { uploadedBytes: uploaded });
        }
        await api<{ moment: MomentDto }>(`/api/moments/${momentId}/complete`, { method: "POST", body: {} });
      }

      // Сервер принял видео целиком — локальная копия больше не нужна.
      await deleteDraft(id);
      await this.refresh();
      window.dispatchEvent(new CustomEvent("flash:moment-uploaded", { detail: { momentId } }));
      return true;
    } catch (err) {
      if (this.cancelled.has(id)) return true;
      const apiErr = err instanceof ApiError ? err : null;
      const status = apiErr?.status ?? 0;
      // 0 — нет сети, 5xx и 401/429 — временно; остальное сервер отклонил окончательно.
      const temporary = !apiErr || status === 0 || status >= 500 || status === 401 || status === 429 || apiErr.code === "upload_incomplete";
      const patch = temporary
        ? { state: "error" as const, error: apiErr?.code ?? "network", attempts: draft.attempts + 1 }
        : { state: "failed" as const, error: apiErr?.code ?? "generic" };
      await patchDraft(id, patch).catch(() => {});
      await this.refresh();
      return !temporary;
    }
  }
}

const EMPTY: DraftInfo[] = [];

export const uploader = new UploadManager();

export function newClientId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `m${Date.now().toString(36)}${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
