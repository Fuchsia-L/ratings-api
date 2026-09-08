import Database from 'better-sqlite3';
import { buildApp, initRatingsSchema } from '../app.js';

export const SYNC_TOKEN = 'sync-token-for-tests-0123456789abcdef';
export const READONLY_TOKEN = 'readonly-token-for-tests-0123456789abcd';
export const INTERNAL_TOKEN = 'internal-token-for-tests-0123456789abcd';
export const WRITE_TOKEN = 'write-token-for-tests-0123456789abcdefg';

export function makeApp(opts = {}) {
  const db = new Database(':memory:');
  initRatingsSchema(db);
  const app = buildApp({
    db,
    syncToken: SYNC_TOKEN,
    readonlyToken: 'readonlyToken' in opts ? opts.readonlyToken : READONLY_TOKEN,
    writeToken: 'writeToken' in opts ? opts.writeToken : WRITE_TOKEN,
    internalToken: INTERNAL_TOKEN,
    logger: false,
  });
  return { app, db };
}

/** audit_log 全部行（按 id 升序），给写端点测试断言留痕用。 */
export function auditRows(db) {
  return db.prepare('SELECT * FROM audit_log ORDER BY id').all();
}

export function auth(token = SYNC_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

export function scheduleEvent(overrides = {}) {
  const now = '2026-09-01T00:00:00.000Z';
  return {
    id: 'evt-1',
    title: '高等数学',
    category: '学习',
    start_time: '2026-09-07T08:00:00.000+08:00',
    end_time: '2026-09-07T09:40:00.000+08:00',
    repeat: 'weekly',
    repeat_until: '2026-12-31',
    location: '教三 401',
    reminder_minutes: 15,
    notes: null,
    source: 'manual',
    is_completed: false,
    created_at: now,
    updated_at: now,
    synced_at: now,
    schema_version: 1,
    ...overrides,
  };
}

export function todoItem(overrides = {}) {
  const now = '2026-09-01T00:00:00.000Z';
  return {
    id: 'todo-1',
    title: '刷 100 道线段树',
    type: 'daily',
    priority: 'high',
    is_completed: false,
    last_reset: '2026-09-07',
    created_at: now,
    updated_at: now,
    synced_at: now,
    schema_version: 1,
    ...overrides,
  };
}

export function insertRating(db, row) {
  db.prepare(`
    INSERT INTO ratings (id, slot_start, slot_end, linked_event_id, rating, efficiency,
      mood, activity, reflection, created_at, updated_at, synced_at, schema_version, deleted_at)
    VALUES (@id, @slot_start, @slot_end, @linked_event_id, @rating, @efficiency,
      @mood, @activity, @reflection, @created_at, @updated_at, @synced_at, @schema_version, @deleted_at)
  `).run({
    linked_event_id: null, mood: null, activity: null, reflection: null,
    created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
    synced_at: null, schema_version: 1, deleted_at: null,
    ...row,
  });
}
