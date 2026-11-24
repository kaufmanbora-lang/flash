import { storageUsage } from "@/lib/moment-service";
import { route } from "@/server/api";

export const GET = route(async ({ user }) => ({ storage: await storageUsage(user.id) }));
