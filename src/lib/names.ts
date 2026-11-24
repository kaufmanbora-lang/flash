/** Имя файла из произвольного заголовка: без символов, запрещённых в файловых системах. */
export function safeName(name: string, fallback = "flash"): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}
