import { readFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function connect(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 5 });
}

export async function migrate(db: Db) {
  await db.query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
}

export async function withTx<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("begin");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/** Transaction-scoped advisory lock keyed by any string (per run, per sender EOA). */
export async function lock(c: Tx, key: string) {
  await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------------------------- signature encryption at rest

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function seal(keyHex: string, plaintext: string, aad: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  c.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { ciphertext, iv, tag: c.getAuthTag() };
}

export function open(keyHex: string, s: Sealed, aad: string): string {
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), s.iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(s.tag);
  return Buffer.concat([d.update(s.ciphertext), d.final()]).toString("utf8");
}
