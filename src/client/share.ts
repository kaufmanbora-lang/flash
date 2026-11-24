// Сохранение и отправка видео: системное меню «Поделиться» (Telegram, WhatsApp и другие приложения)
// через Web Share API, а там, где передача файлов не поддерживается, — обычное скачивание.

/** Больше этого размера файл не грузим в память ради «Поделиться»: браузер на телефоне может не выдержать. */
export const SHARE_FILE_LIMIT = 700 * 1024 * 1024;

export function canShareFiles(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [new File([new Uint8Array(1)], "film.mp4", { type: "video/mp4" })] });
  } catch {
    return false;
  }
}

/** Скачивает файл целиком (с прогрессом), чтобы передать его в системное меню. */
export async function fetchAsFile(
  url: string,
  filename: string,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<File> {
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (total > 0) onProgress(Math.min(1, loaded / total));
  }
  onProgress(1);
  return new File(chunks, filename, { type: "video/mp4" });
}

export type ShareResult = "shared" | "cancelled" | "needs-gesture" | "unsupported";

/**
 * Открывает системное меню с файлом. Браузер разрешает это только сразу после нажатия:
 * если файл готовился долго, вернётся 'needs-gesture' — нужно ещё одно нажатие.
 */
export async function shareFile(file: File, title: string): Promise<ShareResult> {
  if (!canShareFiles() || !navigator.canShare({ files: [file] })) return "unsupported";
  try {
    await navigator.share({ files: [file], title });
    return "shared";
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "AbortError") return "cancelled";
    if (name === "NotAllowedError") return "needs-gesture";
    return "unsupported";
  }
}

export async function shareLink(url: string, title: string): Promise<ShareResult> {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ url, title });
      return "shared";
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return "cancelled";
    }
  }
  return "unsupported";
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Запускает скачивание по ссылке; сервер отдаёт файл с заголовком «сохранить как». */
export function startDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
