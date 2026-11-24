import { UPLOAD_CHUNK_BYTES } from "@/lib/constants";
import { HttpError } from "@/lib/errors";
import { uploadPart } from "@/lib/moment-service";
import { route, uuidParam } from "@/server/api";

/** Принимает одну часть видео. Повторная отправка той же части безопасна. */
export const PUT = route<{ id: string; n: string }>(async ({ req, user, params }) => {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > UPLOAD_CHUNK_BYTES) throw new HttpError(413, "bad_part_size");
  const data = Buffer.from(await req.arrayBuffer());
  const n = Number(params.n);
  await uploadPart(user.id, uuidParam(params.id), n, data);
  return { ok: true, n, size: data.length };
});
