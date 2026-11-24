// Приложение живёт не в корне сайта, а в подпапке (на GitHub Pages — /flash).
// Ссылки next/link и переходы роутера учитывают её сами; адреса файлов из public нужно дополнять вручную.

export const BASE_PATH: string = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Адрес файла из public с учётом подпапки сайта. */
export function withBase(path: string): string {
  return `${BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;
}
