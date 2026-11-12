import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';

export function openStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const sql = new DatabaseSync(filename);
  sql.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS records (
      entity TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL CHECK (json_valid(data)),
      PRIMARY KEY (entity, id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS audit_no_update
      BEFORE UPDATE ON records WHEN old.entity = 'audit'
      BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete
      BEFORE DELETE ON records WHEN old.entity = 'audit'
      BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;
    PRAGMA user_version = 1;
  `);
  const all = sql.prepare('SELECT data FROM records WHERE entity = ? ORDER BY rowid');
  const one = sql.prepare('SELECT data FROM records WHERE entity = ? AND id = ?');
  const upsert = sql.prepare(`
    INSERT INTO records (entity, id, data) VALUES (?, ?, ?)
    ON CONFLICT(entity, id) DO UPDATE SET data = excluded.data
  `);
  const remove = sql.prepare('DELETE FROM records WHERE entity = ? AND id = ?');
  const types = sql.prepare('SELECT DISTINCT entity FROM records ORDER BY entity');
  const expireSessions = sql.prepare("DELETE FROM records WHERE entity = 'sessions' AND json_extract(data, '$.expiresAt') <= ?");
  let depth = 0;
  return {
    list: (entity) => all.all(entity).map(row => JSON.parse(row.data)),
    get: (entity, id) => id == null ? undefined : JSON.parse(one.get(entity, String(id))?.data ?? 'null') ?? undefined,
    save(entity, record) {
      const stored = { ...record, id: String(record.id ?? randomUUID()) };
      upsert.run(entity, stored.id, JSON.stringify(stored));
      return stored;
    },
    remove: (entity, id) => remove.run(entity, id).changes > 0,
    types: () => types.all().map(row => row.entity),
    expireSessions: (now) => expireSessions.run(now).changes,
    tx(fn) {
      const level = ++depth;
      const marker = 'nested_' + level;
      let started = false;
      try {
        sql.exec(level === 1 ? 'BEGIN IMMEDIATE' : 'SAVEPOINT ' + marker);
        started = true;
        const result = fn();
        if (result && typeof result.then === 'function') throw new Error('Transações devem ser síncronas.');
        sql.exec(level === 1 ? 'COMMIT' : 'RELEASE ' + marker);
        return result;
      } catch (error) {
        if (started) sql.exec(level === 1 ? 'ROLLBACK' : 'ROLLBACK TO ' + marker + '; RELEASE ' + marker);
        throw error;
      } finally {
        depth--;
      }
    },
    backup: (destination) => backup(sql, destination),
    integrity: () => sql.prepare('PRAGMA integrity_check').all().every(row => row.integrity_check === 'ok'),
    ping: () => sql.prepare('SELECT 1 AS ok').get().ok === 1,
    close: () => sql.close()
  };
}
