import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildSummary, parseSummaryDays } from './summary.js';
import { createStore, runSync, validateSemester, readSemester } from './schedule-store.js';
import { buildDay, buildWindow, validateWindow, DATE_RE } from './schedule-query.js';

/**
 * 只读端点白名单：READONLY_TOKEN 只能碰这两个（设计 §3）。
 * SYNC_TOKEN 能碰全部 /v1。
 */
const READONLY_PATHS = new Set(['/v1/schedule/day', '/v1/schedule/window']);

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  initRatingsSchema(db);
  return db;
}

export function initRatingsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ratings (
      id TEXT PRIMARY KEY,
      slot_start TEXT NOT NULL,
      slot_end TEXT NOT NULL,
      linked_event_id TEXT,
      rating INTEGER NOT NULL,
      efficiency INTEGER NOT NULL,
      mood TEXT,
      activity TEXT,
      reflection TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_ratings_updated_at ON ratings(updated_at);
  `);
  // Idempotent migration: add deleted_at column if missing.
  // Tombstone-style soft delete: null = active, ISO string = deleted at that time.
  const existingCols = db.prepare('PRAGMA table_info(ratings)').all().map((c) => c.name);
  if (!existingCols.includes('deleted_at')) {
    db.exec('ALTER TABLE ratings ADD COLUMN deleted_at TEXT');
  }
}

const UPSERT_COLUMNS = `
    slot_start = excluded.slot_start,
    linked_event_id = excluded.linked_event_id,
    slot_end = excluded.slot_end,
    rating = excluded.rating,
    efficiency = excluded.efficiency,
    mood = excluded.mood,
    activity = excluded.activity,
    reflection = excluded.reflection,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    synced_at = excluded.synced_at,
    schema_version = excluded.schema_version,
    deleted_at = excluded.deleted_at
`;

const MAX_MOOD = 20;
const MAX_ACTIVITY = 50;
const MAX_REFLECTION = 200;

function validateRecord(r) {
  if (typeof r !== 'object' || r === null) return 'record must be object';
  if (typeof r.id !== 'string' || !r.id) return 'id required';
  if (typeof r.slot_start !== 'string') return 'slot_start required';
  if (typeof r.slot_end !== 'string') return 'slot_end required';
  if (!Number.isInteger(r.rating) || r.rating < 1 || r.rating > 5) return 'rating must be 1-5';
  if (!Number.isInteger(r.efficiency) || r.efficiency < 1 || r.efficiency > 5) return 'efficiency must be 1-5';
  if (typeof r.created_at !== 'string') return 'created_at required';
  if (typeof r.updated_at !== 'string') return 'updated_at required';
  if (r.mood != null && (typeof r.mood !== 'string' || r.mood.length > MAX_MOOD)) return `mood must be string <= ${MAX_MOOD}`;
  if (r.activity != null && (typeof r.activity !== 'string' || r.activity.length > MAX_ACTIVITY)) return `activity must be string <= ${MAX_ACTIVITY}`;
  if (r.reflection != null && (typeof r.reflection !== 'string' || r.reflection.length > MAX_REFLECTION)) return `reflection must be string <= ${MAX_REFLECTION}`;
  if (r.expected_updated_at != null && typeof r.expected_updated_at !== 'string') return 'expected_updated_at must be string if provided';
  if (r.deleted_at != null && typeof r.deleted_at !== 'string') return 'deleted_at must be string if provided';
  return null;
}

function normalize(r) {
  return {
    id: r.id,
    slot_start: r.slot_start,
    slot_end: r.slot_end,
    linked_event_id: r.linked_event_id ?? null,
    rating: r.rating,
    efficiency: r.efficiency,
    mood: r.mood ?? null,
    activity: r.activity ?? null,
    reflection: r.reflection ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    synced_at: r.synced_at ?? null,
    schema_version: Number.isInteger(r.schema_version) ? r.schema_version : 1,
    deleted_at: r.deleted_at ?? null,
  };
}

/**
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.syncToken
 * @param {string} [opts.readonlyToken] 缺失 = 只读端点对 READONLY_TOKEN 关闭（非 fatal）
 * @param {string} [opts.internalToken]
 */
export function buildApp({ db, syncToken, readonlyToken, internalToken, logger = false, bodyLimit }) {
  const store = createStore(db);

  const upsertStmt = db.prepare(`
    INSERT INTO ratings (
      id, slot_start, slot_end, linked_event_id,
      rating, efficiency, mood, activity, reflection,
      created_at, updated_at, synced_at, schema_version, deleted_at
    ) VALUES (
      @id, @slot_start, @slot_end, @linked_event_id,
      @rating, @efficiency, @mood, @activity, @reflection,
      @created_at, @updated_at, @synced_at, @schema_version, @deleted_at
    )
    ON CONFLICT(id) DO UPDATE SET
      ${UPSERT_COLUMNS}
    WHERE excluded.updated_at > ratings.updated_at
  `);

  // Conditional path (MCP/Lux): if-match already verified by server,
  // so caller's write is authoritative — skip the LWW guard.
  const forceUpsertStmt = db.prepare(`
    INSERT INTO ratings (
      id, slot_start, slot_end, linked_event_id,
      rating, efficiency, mood, activity, reflection,
      created_at, updated_at, synced_at, schema_version, deleted_at
    ) VALUES (
      @id, @slot_start, @slot_end, @linked_event_id,
      @rating, @efficiency, @mood, @activity, @reflection,
      @created_at, @updated_at, @synced_at, @schema_version, @deleted_at
    )
    ON CONFLICT(id) DO UPDATE SET
      ${UPSERT_COLUMNS}
  `);

  const listAllStmt = db.prepare('SELECT * FROM ratings ORDER BY updated_at DESC');
  const listSinceStmt = db.prepare('SELECT * FROM ratings WHERE updated_at > ? ORDER BY updated_at DESC');
  const findByIdStmt = db.prepare('SELECT * FROM ratings WHERE id = ?');

  const fastify = Fastify({
    logger,
    bodyLimit: bodyLimit ?? 2 * 1024 * 1024,
  });

  fastify.decorate('store', store);

  fastify.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path === '/v1/healthz') return;
    if (path.startsWith('/internal/')) {
      if (!internalToken || internalToken.length < 32) {
        return reply.code(503).send({ error: 'internal_api_not_configured' });
      }
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || auth.slice(7) !== internalToken) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      return;
    }
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const presented = auth.slice(7);
    if (presented === syncToken) return;
    if (readonlyToken && readonlyToken.length >= 32 && presented === readonlyToken) {
      if (READONLY_PATHS.has(path)) return;
      // 认得这把钥匙，但这扇门不归它开。
      return reply.code(403).send({ error: 'forbidden_for_readonly_token' });
    }
    return reply.code(401).send({ error: 'unauthorized' });
  });

  fastify.get('/v1/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));

  // 仅供同机鹊桥直连。nginx 对公网屏蔽 /internal/，此处再用独立 token 做第二道门。
  fastify.get('/internal/summary', async (req, reply) => {
    const days = parseSummaryDays(req.query?.days);
    if (!days) return reply.code(400).send({ error: 'days must be 7 or 28' });
    return buildSummary(db, days);
  });

  /* ---------------- ratings（行为零变化） ---------------- */

  fastify.get('/v1/ratings', async (req, reply) => {
    const since = req.query.since;
    if (since != null && typeof since !== 'string') {
      return reply.code(400).send({ error: 'since must be string if provided' });
    }
    const rows = since ? listSinceStmt.all(since) : listAllStmt.all();
    return { records: rows, server_time: new Date().toISOString() };
  });

  fastify.post('/v1/ratings/sync', async (req, reply) => {
    const body = req.body ?? {};
    if (!Array.isArray(body.records)) {
      return reply.code(400).send({ error: 'records must be array' });
    }
    if (body.since != null && typeof body.since !== 'string') {
      return reply.code(400).send({ error: 'since must be string if provided' });
    }
    const incoming = body.records;
    const since = typeof body.since === 'string' ? body.since : null;

    let applied = 0;
    let rejected = 0;
    const errors = [];

    const tx = db.transaction((records) => {
      for (const raw of records) {
        const err = validateRecord(raw);
        if (err) {
          rejected += 1;
          errors.push({ id: raw?.id ?? null, error: err });
          continue;
        }
        // Optional optimistic-concurrency check: caller declares what version
        // it based its edit on. Server refuses if that snapshot is stale.
        if (raw.expected_updated_at != null) {
          const current = findByIdStmt.get(raw.id);
          const expected = raw.expected_updated_at;
          const currentUpdatedAt = current ? current.updated_at : null;
          if (currentUpdatedAt !== expected) {
            rejected += 1;
            errors.push({
              id: raw.id,
              error: 'stale',
              expected_updated_at: expected,
              current_record: current ?? null,
            });
            continue;
          }
          forceUpsertStmt.run(normalize(raw));
          applied += 1;
          continue;
        }
        const info = upsertStmt.run(normalize(raw));
        if (info.changes > 0) applied += 1;
      }
    });
    tx(incoming);

    const rows = since ? listSinceStmt.all(since) : listAllStmt.all();
    return {
      applied,
      rejected,
      errors: errors.length ? errors : undefined,
      records: rows,
      server_time: new Date().toISOString(),
    };
  });

  /* ---------------- schedule / todos 同步（语义 = ratings） ---------------- */

  function syncHandler(entity) {
    return async (req, reply) => {
      const body = req.body ?? {};
      if (!Array.isArray(body.records)) {
        return reply.code(400).send({ error: 'records must be array' });
      }
      if (body.since != null && typeof body.since !== 'string') {
        return reply.code(400).send({ error: 'since must be string if provided' });
      }
      const since = typeof body.since === 'string' ? body.since : null;
      const { applied, rejected, errors } = runSync(db, entity, body.records);
      const rows = since ? entity.listSince.all(since) : entity.listAll.all();
      return {
        applied,
        rejected,
        errors: errors.length ? errors : undefined,
        records: rows.map(entity.hydrate),
        server_time: new Date().toISOString(),
      };
    };
  }

  function pullHandler(entity) {
    return async (req, reply) => {
      const since = req.query.since;
      if (since != null && typeof since !== 'string') {
        return reply.code(400).send({ error: 'since must be string if provided' });
      }
      const rows = since ? entity.listSince.all(since) : entity.listAll.all();
      return { records: rows.map(entity.hydrate), server_time: new Date().toISOString() };
    };
  }

  fastify.post('/v1/schedule/sync', syncHandler(store.schedule));
  fastify.post('/v1/todos/sync', syncHandler(store.todos));
  fastify.get('/v1/schedule', pullHandler(store.schedule));
  fastify.get('/v1/todos', pullHandler(store.todos));

  /* ---------------- config/semester ---------------- */

  fastify.put('/v1/config/semester', async (req, reply) => {
    const body = req.body ?? {};
    const err = validateSemester(body);
    if (err) return reply.code(400).send({ error: err });
    const info = store.config.upsert.run({
      key: 'semester',
      value_json: JSON.stringify({ start_date: body.start_date, total_weeks: body.total_weeks }),
      updated_at: body.updated_at,
    });
    return {
      applied: info.changes > 0,
      semester: readSemester(store),
      server_time: new Date().toISOString(),
    };
  });

  fastify.get('/v1/config/semester', async () => ({
    semester: readSemester(store),
    server_time: new Date().toISOString(),
  }));

  /* ---------------- 查询端点 ---------------- */

  fastify.get('/v1/schedule/day', async (req, reply) => {
    const date = req.query.date;
    if (date != null) {
      if (typeof date !== 'string' || !DATE_RE.test(date)) {
        return reply.code(400).send({ error: 'date must be YYYY-MM-DD' });
      }
      if (Number.isNaN(Date.parse(`${date}T00:00:00.000+08:00`))) {
        return reply.code(400).send({ error: 'date is not a valid calendar date' });
      }
    }
    return buildDay(store, date ?? null);
  });

  fastify.get('/v1/schedule/window', async (req, reply) => {
    const parsed = validateWindow(req.query.start, req.query.end);
    if (parsed.error) return reply.code(400).send({ error: parsed.error });
    return buildWindow(store, parsed.start, parsed.end);
  });

  fastify.setErrorHandler((err, req, reply) => {
    req.log.error(err);
    reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'internal error' });
  });

  return fastify;
}
