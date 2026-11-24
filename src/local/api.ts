// «Сервер» внутри приложения. Экраны обращаются к данным по тем же адресам, что и в серверной версии
// (/api/home, /api/moments?date=…), но запрос никуда не уходит: его разбирает этот файл и отвечает
// из хранилища на устройстве. Так интерфейс остаётся прежним, а сервер не нужен.

import type { z } from "zod";
import { deviceYmd, isValidYmd, type Ymd } from "@/lib/dates";
import { ApiError, badRequest, notFound } from "@/lib/errors";
import { filmDto, momentDto } from "./core";
import {
  createFilm,
  createFilmSchema,
  createProjectFilm,
  createProjectFilmSchema,
  deleteFilm,
  filmOptionsSchema,
  getFilmRec,
  listFilms,
  rerenderFilm,
} from "./films";
import { homeData, statsData, storageUsage } from "./home";
import { daySummaries, deleteMoment, getMomentRec, listMoments, onThisDay, updateMoment, updateMomentSchema } from "./moments";
import { listMusic } from "./music";
import { createProfile, getMe, patchSettings, updateProfile } from "./profile";
import {
  createProject,
  createProjectSchema,
  deleteProject,
  getProjectDetail,
  getProjectRec,
  listProjects,
  updateProject,
  updateProjectSchema,
} from "./projects";
import { store } from "./store";

export interface LocalInit {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
}

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw badRequest("validation");
  return result.data;
}

function ymdParam(query: URLSearchParams, name: string, fallback?: Ymd): Ymd {
  const value = query.get(name) ?? fallback;
  if (!isValidYmd(value)) throw badRequest("validation");
  return value;
}

const optionalYmd = (query: URLSearchParams, name: string): Ymd | undefined =>
  query.has(name) ? ymdParam(query, name) : undefined;

const intParam = (query: URLSearchParams, name: string): number | undefined => {
  const raw = query.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

type Handler = (ctx: { query: URLSearchParams; body: unknown; params: string[] }) => unknown;

const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
const route = (method: string, pattern: string, handler: Handler) =>
  routes.push({ method, pattern: new RegExp(`^${pattern.replace(/:id/g, "([^/]+)")}/?$`), handler });

// ── Профиль и настройки ──────────────────────────────────────
route("GET", "/api/me", () => getMe());
route("POST", "/api/me", ({ body }) => createProfile((body ?? {}) as Record<string, unknown>));
route("PATCH", "/api/me", async ({ body }) => {
  await updateProfile((body ?? {}) as Record<string, unknown>);
  return { ok: true };
});
route("PATCH", "/api/settings", ({ body }) => patchSettings(body));
route("GET", "/api/account/storage", async () => ({ storage: await storageUsage() }));

// ── Главная, календарь, статистика ───────────────────────────
route("GET", "/api/home", ({ query }) => homeData(ymdParam(query, "today", deviceYmd())));
route("GET", "/api/calendar", async ({ query }) => ({
  days: await daySummaries(ymdParam(query, "from"), ymdParam(query, "to"), query.get("project") ?? undefined),
}));
route("GET", "/api/stats", async ({ query }) => {
  const today = ymdParam(query, "today", deviceYmd());
  return { stats: statsData(today), onThisDay: await onThisDay(today) };
});

// ── Моменты ──────────────────────────────────────────────────
route("GET", "/api/moments", async ({ query }) => ({
  moments: await listMoments({
    date: optionalYmd(query, "date"),
    from: optionalYmd(query, "from"),
    to: optionalYmd(query, "to"),
    search: query.get("q") ?? undefined,
    favorite: query.get("favorite") === "1",
    projectId: query.get("project") ?? undefined,
    limit: intParam(query, "limit"),
    offset: intParam(query, "offset"),
    order: query.get("order") === "asc" ? "asc" : "desc",
  }),
}));
route("GET", "/api/moments/:id", async ({ params }) => ({ moment: await momentDto(getMomentRec(params[0])) }));
route("PATCH", "/api/moments/:id", async ({ params, body }) => ({
  moment: await updateMoment(params[0], parse(updateMomentSchema, body)),
}));
route("DELETE", "/api/moments/:id", async ({ params }) => {
  await deleteMoment(params[0]);
  return { ok: true };
});

// ── Фильмы ───────────────────────────────────────────────────
route("GET", "/api/films", async ({ query }) => ({ films: await listFilms({ projectId: query.get("project") ?? undefined }) }));
route("POST", "/api/films", async ({ body }) => ({ film: await filmDto(await createFilm(parse(createFilmSchema, body))) }));
route("GET", "/api/films/:id", async ({ params }) => ({ film: await filmDto(getFilmRec(params[0])) }));
route("PATCH", "/api/films/:id", async ({ params, body }) => ({
  film: await filmDto(await rerenderFilm(params[0], parse(filmOptionsSchema, body))),
}));
route("DELETE", "/api/films/:id", async ({ params }) => {
  await deleteFilm(params[0]);
  return { ok: true };
});
route("GET", "/api/music", async () => ({ tracks: await listMusic() }));

// ── Проекты ──────────────────────────────────────────────────
route("GET", "/api/projects", async ({ query }) => {
  const status = query.get("status");
  return {
    projects: await listProjects(
      ymdParam(query, "today", deviceYmd()),
      status === "open" || status === "completed" ? status : undefined,
    ),
  };
});
route("POST", "/api/projects", async ({ body }) => ({ id: (await createProject(parse(createProjectSchema, body))).id }));
route("GET", "/api/projects/:id", async ({ params, query }) => ({
  project: await getProjectDetail(params[0], ymdParam(query, "today", deviceYmd())),
}));
route("PATCH", "/api/projects/:id", async ({ params, body }) => {
  const input = parse(updateProjectSchema, body);
  await updateProject(params[0], input);
  return { project: await getProjectDetail(params[0], input.today) };
});
route("DELETE", "/api/projects/:id", async ({ params, query }) => {
  await deleteProject(params[0], query.get("films") === "delete");
  return { ok: true };
});
route("POST", "/api/projects/:id/films", async ({ params, body }) => {
  const { variant, ...options } = parse(createProjectFilmSchema, body);
  const film = await createProjectFilm(getProjectRec(params[0]), variant, options, { today: deviceYmd() });
  return { film: await filmDto(film) };
});

/** Выполняет «запрос» к данным на устройстве. Ошибки — ApiError с машинным кодом, как у сервера. */
export async function localApi<T>(path: string, init: LocalInit = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const [pathname, search = ""] = path.split("?");
  const query = new URLSearchParams(search);
  try {
    await store.ready();
  } catch {
    // Хранилище браузера недоступно (приватный режим, запрет данных сайтов).
    throw new ApiError(503, "storage_unavailable");
  }
  for (const r of routes) {
    if (r.method !== method) continue;
    const match = r.pattern.exec(pathname);
    if (!match) continue;
    return (await r.handler({ query, body: init.body, params: match.slice(1).map(decodeURIComponent) })) as T;
  }
  throw notFound("not_found");
}
