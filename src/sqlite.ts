import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
/** One local operator, persistent disk. Never use on ephemeral/multi-instance platforms. */
export class SqliteStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS oauth (key TEXT PRIMARY KEY,value TEXT NOT NULL,expires INTEGER);
      CREATE TABLE IF NOT EXISTS sends (key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);`);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async save(key: string, value: unknown, ttl?: number) {
    this.db
      .prepare('INSERT OR REPLACE INTO oauth VALUES (?,?,?)')
      .run(hash(key), JSON.stringify(value), ttl ? Date.now() + ttl * 1000 : null);
  }
  async get(key: string) {
    const row = this.db.prepare('SELECT value,expires FROM oauth WHERE key=?').get(hash(key));
    return !row || (row.expires !== null && Number(row.expires) <= Date.now())
      ? null
      : JSON.parse(String(row.value));
  }
  async delete(key: string) {
    this.db.prepare('DELETE FROM oauth WHERE key=?').run(hash(key));
  }
  async take(key: string) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT value,expires FROM oauth WHERE key=?').get(hash(key));
      this.db.prepare('DELETE FROM oauth WHERE key=?').run(hash(key));
      return !row || (row.expires !== null && Number(row.expires) <= Date.now())
        ? null
        : JSON.parse(String(row.value));
    });
  }
  async cleanup() {
    this.db.prepare('DELETE FROM oauth WHERE expires IS NOT NULL AND expires<=?').run(Date.now());
    this.db.prepare('DELETE FROM limits WHERE expires<=?').run(Date.now());
  }
  async claim(key: string, payloadHash: string) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM sends WHERE key=?').get(hash(key));
      if (row) {
        if (row.payload_hash !== payloadHash)
          throw Error('Idempotency key already used for a different message');
        return {
          fresh: false,
          state: String(row.state),
          result: row.result ? JSON.parse(String(row.result)) : undefined,
        };
      }
      this.db
        .prepare('INSERT INTO sends VALUES (?,?,?,NULL)')
        .run(hash(key), payloadHash, 'in_progress');
      return { fresh: true, state: 'in_progress' };
    });
  }
  async finish(key: string, state: string, result: unknown) {
    const update = this.db
      .prepare('UPDATE sends SET state=?,result=? WHERE key=?')
      .run(state, JSON.stringify(result), hash(key));
    if (update.changes !== 1) throw Error('Send claim not found');
  }
  async limit(principal: string, action: string, max: number, seconds: number) {
    const window = Math.floor(Date.now() / (seconds * 1000)),
      key = hash(`${principal}:${action}:${window}`);
    this.transaction(() => {
      const count = Number(
        this.db.prepare('SELECT count FROM limits WHERE key=?').get(key)?.count ?? 0,
      );
      if (count >= max) throw Error('Rate limit reached; retry later');
      this.db
        .prepare('INSERT OR REPLACE INTO limits VALUES (?,?,?)')
        .run(key, count + 1, (window + 2) * seconds * 1000);
    });
  }
  async terminate() {
    this.db.close();
  }
}
