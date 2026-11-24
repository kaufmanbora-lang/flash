// Отдаёт файл из приватного хранилища по временной подписанной ссылке.
// Ссылки выдаются только владельцу (см. src/lib/dto.ts); здесь проверяются подпись и срок действия.

import type { NextRequest } from "next/server";
import { verifyMediaSignature } from "@/lib/signing";
import { contentTypeForKey, isSafeKey, storage } from "@/lib/storage";
import { serveBytes } from "@/server/range";

export async function GET(req: NextRequest, ctx: { params: Promise<{ key: string[] }> }): Promise<Response> {
  const { key: segments } = await ctx.params;
  const key = segments.join("/");
  const sp = req.nextUrl.searchParams;
  const exp = Number(sp.get("e"));
  const sig = sp.get("s") ?? "";
  const download = sp.get("dl") ?? "";

  if (!isSafeKey(key) || !verifyMediaSignature(key, exp, sig, download)) {
    return new Response("Ссылка недействительна или устарела", { status: 403 });
  }

  try {
    const store = await storage();
    const info = await store.head(key);
    if (!info) return new Response("Файл не найден", { status: 404 });
    const maxAge = Math.max(0, Math.min(3 * 3600, exp - Math.floor(Date.now() / 1000)));
    return await serveBytes({
      size: info.size,
      contentType: contentTypeForKey(key),
      rangeHeader: req.headers.get("range"),
      open: (range) => store.getStream(key, range),
      cacheControl: `private, max-age=${maxAge}`,
      downloadName: download || undefined,
    });
  } catch (err) {
    console.error("[media] ошибка отдачи файла:", err);
    return new Response("Не удалось прочитать файл", { status: 500 });
  }
}
