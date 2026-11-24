import { completeUpload } from "@/lib/moment-service";
import { route, uuidParam } from "@/server/api";

/** Все части загружены: собираем файл и отправляем момент на обработку. */
export const POST = route<{ id: string }>(async ({ user, params }) => ({
  moment: await completeUpload(user.id, uuidParam(params.id)),
}));
