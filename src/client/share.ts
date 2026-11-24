// Сохранение и отправка видео: системное меню «Поделиться» (Telegram, WhatsApp и другие приложения)
// через Web Share API, а там, где передача файлов не поддерживается, — обычное сохранение файла.

import { store } from "@/local/store";

export function canShareFiles(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [new File([new Uint8Array(1)], "film.mp4", { type: "video/mp4" })] });
  } catch {
    return false;
  }
}

/** Файл из хранилища на устройстве, готовый к отправке. Данные не копируются в память. */
export async function storedFile(key: string, fileName: string, type: string): Promise<File | null> {
  const blob = await store.getBlob(key);
  return blob ? new File([blob], fileName, { type: type || blob.type }) : null;
}

export type ShareResult = "shared" | "cancelled" | "needs-gesture" | "unsupported";

/**
 * Открывает системное меню с файлом. Браузер разрешает это только сразу после нажатия:
 * если что-то задержалось, вернётся 'needs-gesture' — нужно ещё одно нажатие.
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

/** Сохраняет файл на устройство: браузер предложит место или положит его в «Загрузки». */
export function startDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Сохраняет на устройство данные, которых ещё нет в хранилище (архив, календарь напоминаний). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  startDownload(url, filename);
  // Адрес нужен браузеру, пока он не начал читать файл; большой архив читается долго.
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
}
