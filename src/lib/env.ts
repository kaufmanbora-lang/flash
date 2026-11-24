import path from "node:path";

const DEV_SECRET = "flash-dev-secret-do-not-use-in-production";
let warnedSecret = false;

function read(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function num(name: string, def: number): number {
  const v = read(name);
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Все значения читаются лениво, чтобы сборка Next.js не требовала окружения. */
export const env = {
  get isProd(): boolean {
    return process.env.NODE_ENV === "production";
  },
  get appUrl(): string {
    return (read("APP_URL") ?? "http://localhost:3000").replace(/\/+$/, "");
  },
  get appSecret(): string {
    const v = read("APP_SECRET");
    if (v && v !== "change-me-to-a-long-random-string") return v;
    if (process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
      throw new Error("APP_SECRET не задан. Укажите длинную случайную строку в окружении.");
    }
    if (!warnedSecret) {
      warnedSecret = true;
      console.warn("[env] APP_SECRET не задан — используется небезопасный секрет для разработки.");
    }
    return DEV_SECRET;
  },
  get inviteCode(): string | undefined {
    return read("INVITE_CODE");
  },
  get databaseUrl(): string {
    return read("DATABASE_URL") ?? "postgres://flash:flash@127.0.0.1:15432/flash";
  },
  get storageDriver(): "local" | "s3" {
    return read("STORAGE_DRIVER") === "s3" ? "s3" : "local";
  },
  get storageLocalDir(): string {
    return path.resolve(/*turbopackIgnore: true*/ read("STORAGE_LOCAL_DIR") ?? ".data/storage");
  },
  get s3() {
    return {
      endpoint: read("S3_ENDPOINT"),
      region: read("S3_REGION") ?? "us-east-1",
      bucket: read("S3_BUCKET") ?? "flash",
      accessKey: read("S3_ACCESS_KEY") ?? "",
      secretKey: read("S3_SECRET_KEY") ?? "",
      forcePathStyle: (read("S3_FORCE_PATH_STYLE") ?? "true") !== "false",
    };
  },
  /** Лимит хранилища на пользователя в байтах; 0 — без лимита. */
  get storageQuotaBytes(): number {
    return Math.max(0, num("STORAGE_QUOTA_GB", 0)) * 1024 ** 3;
  },
  get vapid() {
    return {
      publicKey: read("VAPID_PUBLIC_KEY"),
      privateKey: read("VAPID_PRIVATE_KEY"),
      subject: read("VAPID_SUBJECT"),
    };
  },
  get ffmpegPath(): string | undefined {
    return read("FFMPEG_PATH");
  },
  get ffprobePath(): string | undefined {
    return read("FFPROBE_PATH");
  },
  get filmCrf(): number {
    return Math.min(30, Math.max(12, Math.round(num("FILM_CRF", 18))));
  },
  get filmPreset(): string {
    const allowed = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"];
    const v = read("FILM_PRESET") ?? "fast";
    return allowed.includes(v) ? v : "fast";
  },
  get workDir(): string | undefined {
    const v = read("WORK_DIR");
    return v ? path.resolve(/*turbopackIgnore: true*/ v) : undefined;
  },
  get workerPort(): number {
    return num("WORKER_PORT", 3101);
  },
  get musicDir(): string {
    return path.resolve(/*turbopackIgnore: true*/ read("MUSIC_DIR") ?? "assets/music");
  },
};
