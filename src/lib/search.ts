/**
 * Приводит текст к виду для поиска: нижний регистр, «ё» → «е», одиночные пробелы.
 *
 * Регистр понижает приложение, а не база: в PostgreSQL с локалью C функции lower() и ILIKE
 * не трогают кириллицу, и «Море» не находилось бы по запросу «море». Нормализованная копия
 * заметки хранится в moments.note_norm, запрос проходит через эту же функцию.
 */
export function normalizeSearchText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
