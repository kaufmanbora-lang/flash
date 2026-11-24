// npm run dev:db — локальный PostgreSQL для разработки без Docker.
// Настоящий сервер Postgres из npm-пакета embedded-postgres; данные лежат в .data/pg.
//
// На Windows бинарники запускаются напрямую: если проект лежит в очень глубокой папке, Postgres
// упирается в системный предел длины пути (260 символов). В этом случае бинарники (и, при
// необходимости, данные) зеркалируются в короткую временную папку.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const PORT = Number(process.env.DEV_DB_PORT ?? 15432);
const USER = "flash";
const PASSWORD = "flash";
const DATABASE = "flash";
const WINDOWS_PATH_LIMIT = 248;

const log = (message: string) => console.log(`[db] ${message}`);

async function canConnect(database = "postgres"): Promise<boolean> {
  const client = new pg.Client({ host: "127.0.0.1", port: PORT, user: USER, password: PASSWORD, database, connectionTimeoutMillis: 1500 });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}

async function ensureDatabase(): Promise<void> {
  const client = new pg.Client({ host: "127.0.0.1", port: PORT, user: USER, password: PASSWORD, database: "postgres" });
  await client.connect();
  try {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [DATABASE]);
    if (found.rowCount === 0) await client.query(`CREATE DATABASE ${client.escapeIdentifier(DATABASE)}`);
  } finally {
    await client.end();
  }
}

function longestRelativePath(dir: string): number {
  let longest = 0;
  const walk = (current: string, prefix: number) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const length = prefix + entry.name.length + 1;
      if (entry.isDirectory()) walk(path.join(current, entry.name), length);
      else if (length > longest) longest = length;
    }
  };
  walk(dir, 0);
  return longest;
}

// ── Windows: прямой запуск бинарников ────────────────────────

async function windowsBinaries(): Promise<{ bin: string; relocated: boolean }> {
  const packageName = "@embedded-postgres/windows-x64";
  const mod = (await import(packageName)) as { postgres: string };
  const native = path.resolve(path.dirname(mod.postgres), "..");
  if (native.length + longestRelativePath(native) < WINDOWS_PATH_LIMIT) return { bin: path.join(native, "bin"), relocated: false };

  // Слишком длинный путь к проекту: копируем бинарники в короткую временную папку (один раз).
  const tag = crypto.createHash("sha1").update(native).digest("hex").slice(0, 8);
  const target = path.join(os.tmpdir(), `flash-pg-bin-${tag}`);
  const marker = path.join(target, ".complete");
  if (!fs.existsSync(marker)) {
    log("путь к проекту слишком длинный для Postgres — копирую бинарники во временную папку…");
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.cp(native, target, { recursive: true });
    await fsp.writeFile(marker, new Date().toISOString());
  }
  return { bin: path.join(target, "bin"), relocated: true };
}

function runToEnd(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: { ...process.env, LC_MESSAGES: "C" }, windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(file)} завершился с кодом ${code}: ${stderr.trim()}`))));
  });
}

async function startWindows(): Promise<() => Promise<void>> {
  const { bin } = await windowsBinaries();
  let dataDir = path.resolve(".data/pg");
  if (dataDir.length > 185) {
    const tag = crypto.createHash("sha1").update(dataDir).digest("hex").slice(0, 8);
    dataDir = path.join(os.tmpdir(), `flash-pg-data-${tag}`);
    log(`данные базы для этой копии проекта лежат в ${dataDir}`);
  }

  if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
    log("первая инициализация базы…");
    await fsp.mkdir(dataDir, { recursive: true });
    const pwfile = path.join(os.tmpdir(), `flash-pg-pw-${crypto.randomBytes(6).toString("hex")}`);
    await fsp.writeFile(pwfile, `${PASSWORD}\n`);
    try {
      await runToEnd(path.join(bin, "initdb.exe"), [
        `--pgdata=${dataDir}`,
        "--auth=password",
        `--username=${USER}`,
        `--pwfile=${pwfile}`,
        "--encoding=UTF8",
        "--locale=C",
        "--lc-messages=C",
      ]);
    } finally {
      await fsp.rm(pwfile, { force: true });
    }
  }

  const child: ChildProcess = spawn(path.join(bin, "postgres.exe"), ["-D", dataDir, "-p", String(PORT), "-c", "listen_addresses=127.0.0.1"], {
    env: { ...process.env, LC_MESSAGES: "C" },
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      if (/error|fatal|panic/i.test(text)) console.error(`[db] ${text.trim()}`);
      if (text.includes("database system is ready to accept connections")) resolve();
    });
    child.on("error", reject);
    child.on("close", (code) => reject(new Error(`postgres завершился с кодом ${code}: ${output.trim().split(/\r?\n/).slice(-4).join(" | ")}`)));
  });

  return async () => {
    // Аккуратная остановка; если не вышло — принудительная.
    const stopped = spawnSync(path.join(bin, "pg_ctl.exe"), ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "20"], { windowsHide: true });
    if (stopped.status !== 0 && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/f", "/t"], { windowsHide: true });
  };
}

// ── macOS и Linux: штатная обёртка пакета ────────────────────

async function startUnix(): Promise<() => Promise<void>> {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dataDir = path.resolve(".data/pg");
  const fresh = !fs.existsSync(path.join(dataDir, "PG_VERSION"));
  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: (message: unknown) => {
      const text = String(message).trim();
      if (/error|fatal|panic/i.test(text)) console.error(`[db] ${text}`);
    },
    onError: (error: unknown) => console.error("[db]", error),
  });
  if (fresh) {
    log("первая инициализация базы в .data/pg…");
    await fsp.mkdir(path.dirname(dataDir), { recursive: true });
    await server.initialise();
  }
  await server.start();
  return () => server.stop();
}

async function main(): Promise<void> {
  let stop: () => Promise<void> = async () => {};
  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    await stop().catch(() => {});
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGHUP", () => void shutdown());

  if (await canConnect()) {
    log(`PostgreSQL уже запущен на порту ${PORT} — использую его`);
  } else {
    stop = process.platform === "win32" ? await startWindows() : await startUnix();
  }
  await ensureDatabase();
  log(`PostgreSQL готов: postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`);
  // Процесс живёт, пока работает база.
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error("[db] не удалось запустить PostgreSQL:", (err as Error).message ?? err);
  process.exit(1);
});
