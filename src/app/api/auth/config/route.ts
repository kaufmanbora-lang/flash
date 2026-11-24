import { env } from "@/lib/env";
import { route } from "@/server/api";

/** Публичные параметры формы регистрации. */
export const GET = route(async () => ({ inviteRequired: !!env.inviteCode }), { auth: false });
