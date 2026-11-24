// Отдача файлов с поддержкой Range-запросов — без неё Safari на iPhone не воспроизводит видео.

import { Readable } from "node:stream";
import type { ByteRange } from "@/lib/storage";

/** Разбирает заголовок Range. null — заголовка нет, 'invalid' — диапазон вне файла. */
export function parseRange(header: string | null, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  if (size === 0) return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    // «Последние N байт».
    const suffix = Number(m[2]);
    if (suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid";
  return { start, end };
}

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface ServeOptions {
  size: number;
  contentType: string;
  rangeHeader: string | null;
  open: (range?: ByteRange) => Promise<Readable>;
  cacheControl: string;
  downloadName?: string;
}

export async function serveBytes(opts: ServeOptions): Promise<Response> {
  const headers = new Headers({
    "Content-Type": opts.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": opts.cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
  if (opts.downloadName) headers.set("Content-Disposition", contentDisposition(opts.downloadName));

  const range = parseRange(opts.rangeHeader, opts.size);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${opts.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    const stream = await opts.open(range);
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${opts.size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 206, headers });
  }
  const stream = await opts.open();
  headers.set("Content-Length", String(opts.size));
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 200, headers });
}
