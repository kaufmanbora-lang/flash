-- Нормализованная копия заметки для поиска (нижний регистр, «ё» → «е»).
-- Её заполняет приложение (src/lib/search.ts): в базе с локалью C функции lower() и ILIKE
-- не понижают регистр кириллицы, и «Море» не находилось бы по запросу «море».

ALTER TABLE moments ADD COLUMN IF NOT EXISTS note_norm TEXT NOT NULL DEFAULT '';

-- Уже существующие заметки: translate() понижает кириллицу независимо от локали, lower() — латиницу.
UPDATE moments
   SET note_norm = lower(translate(
         note,
         'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯІЇЄҐЎё',
         'абвгдеежзийклмнопрстуфхцчшщъыьэюяіїєґўе'))
 WHERE note <> '';
