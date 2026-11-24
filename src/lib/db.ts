import pg from "pg";
import type { Pool as PgPool } from "pg";
import { env } from "./env";

const { Pool, types } = pg;

// DATE → строка 'YYYY-MM-DD' (без сдвигов часового пояса), BIGINT → number.
types.setTypeParser(1082, (v: string) => v);
types.setTypeParser(20, (v: string) => Number(v));

type Row = Record<string, unknown>;

const g = globalThis as unknown as { __flashPool?: PgPool };

export function pool(): PgPool {
  if (!g.__flashPool) {
    const p = new Pool({
      connectionString: env.databaseUrl,
      max: 12,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // Оборванное простаивающее соединение не должно ронять процесс.
    p.on("error", (err) => console.error("[db] ошибка пула:", err.message));
    g.__flashPool = p;
  }
  return g.__flashPool;
}

export async function q<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool().query(text, params);
  return res.rows as T[];
}

export async function q1<T = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

export async function exec(text: string, params: unknown[] = []): Promise<number> {
  const res = await pool().query(text, params);
  return res.rowCount ?? 0;
}

export interface Tx {
  q<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  q1<T = Row>(text: string, params?: unknown[]): Promise<T | null>;
  exec(text: string, params?: unknown[]): Promise<number>;
}

export async function tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  const t: Tx = {
    async q<R = Row>(text: string, params: unknown[] = []) {
      return (await client.query(text, params)).rows as R[];
    },
    async q1<R = Row>(text: string, params: unknown[] = []) {
      return ((await client.query(text, params)).rows[0] as R) ?? null;
    },
    async exec(text: string, params: unknown[] = []) {
      return (await client.query(text, params)).rowCount ?? 0;
    },
  };
  try {
    await client.query("BEGIN");
    const out = await fn(t);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (g.__flashPool) {
    const p = g.__flashPool;
    g.__flashPool = undefined;
    await p.end();
  }
}
