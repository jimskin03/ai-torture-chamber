import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'chamber.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const get = db.prepare('SELECT data FROM sessions WHERE id = ?');
  const put = db.prepare('INSERT INTO sessions(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
  return {
    get(id) { const row = get.get(id); return row ? JSON.parse(row.data) : null; },
    save(session) { put.run(session.id, JSON.stringify(session)); },
    all() { return db.prepare('SELECT data FROM sessions').all().map(row => JSON.parse(row.data)); },
    delete(id) { db.prepare('DELETE FROM sessions WHERE id = ?').run(id); },
    close() { db.close(); }
  };
}
