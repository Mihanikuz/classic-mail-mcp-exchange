import { createHash } from 'node:crypto';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { SqliteStore } from './sqlite.js';
export type Database = Firestore | SqliteStore;
import type { TokenStorage } from 'fastmcp/auth';

export const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** OAuthProxy encrypts values before they reach this store. No bearer token in document IDs. */
export class FirestoreTokenStore implements TokenStorage {
  constructor(private db: Database) {}
  private ref(key: string) {
    return (this.db as Firestore).collection('oauth').doc(digest(key));
  }
  async save(key: string, value: unknown, ttl?: number) {
    if (this.db instanceof SqliteStore) return this.db.save(key, value, ttl);
    await this.ref(key).set({
      value: JSON.stringify(value),
      expiresAt: ttl ? Timestamp.fromMillis(Date.now() + ttl * 1000) : null,
    });
  }
  private value(data: FirebaseFirestore.DocumentData | undefined): unknown | null {
    if (!data || (data.expiresAt && data.expiresAt.toMillis() <= Date.now())) return null;
    return JSON.parse(data.value);
  }
  async get(key: string) {
    if (this.db instanceof SqliteStore) return this.db.get(key);
    return this.value((await this.ref(key).get()).data());
  }
  async delete(key: string) {
    if (this.db instanceof SqliteStore) return this.db.delete(key);
    await this.ref(key).delete();
  }
  async take(key: string) {
    if (this.db instanceof SqliteStore) return this.db.take(key);
    return this.db.runTransaction(async (tx) => {
      const ref = this.ref(key),
        snap = await tx.get(ref);
      if (snap.exists) tx.delete(ref);
      return this.value(snap.data());
    });
  }
  async cleanup() {
    if (this.db instanceof SqliteStore)
      await this.db.cleanup(); /* Firestore TTL cleans up; reads enforce expiration immediately. */
  }
}

export interface SendLedger {
  claim(
    key: string,
    payloadHash: string,
  ): Promise<{ fresh: boolean; result?: unknown; state: string }>;
  finish(key: string, state: string, result: unknown): Promise<void>;
}
export class FirestoreLedger implements SendLedger {
  constructor(private db: Database) {}
  async claim(key: string, payloadHash: string) {
    if (this.db instanceof SqliteStore) return this.db.claim(key, payloadHash);
    return this.db.runTransaction(async (tx) => {
      const ref = (this.db as Firestore).collection('sends').doc(digest(key));
      const snap = await tx.get(ref);
      if (snap.exists) {
        const data = snap.data()!;
        if (data.payloadHash !== payloadHash)
          throw new Error('Idempotency key already used for a different message');
        return { fresh: false, state: data.state, result: data.result };
      }
      tx.create(ref, { payloadHash, state: 'in_progress', createdAt: Timestamp.now() });
      // Intentionally no TTL: a delayed retry must never silently send again.
      return { fresh: true, state: 'in_progress' };
    });
  }
  async finish(key: string, state: string, result: unknown) {
    if (this.db instanceof SqliteStore) return this.db.finish(key, state, result);
    await (this.db as Firestore)
      .collection('sends')
      .doc(digest(key))
      .update({ state, result: JSON.parse(JSON.stringify(result)), updatedAt: Timestamp.now() });
  }
}

export async function rateLimit(
  db: Database,
  principal: string,
  action: string,
  max: number,
  windowSeconds: number,
) {
  if (db instanceof SqliteStore) return db.limit(principal, action, max, windowSeconds);
  const window = Math.floor(Date.now() / (windowSeconds * 1000));
  const ref = db.collection('limits').doc(digest(`${principal}:${action}:${window}`));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref),
      count = snap.data()?.count ?? 0;
    if (count >= max) throw new Error('Rate limit reached; retry later');
    tx.set(ref, {
      count: count + 1,
      expiresAt: Timestamp.fromMillis((window + 2) * windowSeconds * 1000),
    });
  });
}
