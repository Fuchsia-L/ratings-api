import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SYNC_TOKEN = process.env.SYNC_TOKEN;
const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? './data/ratings.db';

if (!SYNC_TOKEN || SYNC_TOKEN.length < 32) {
  console.error('FATAL: SYNC_TOKEN missing or too short (need >= 32 chars)');
  process.exit(1);
}

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

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
const existingCols = db.prepare("PRAGMA table_info(ratings)").all().map(c => c.name);
if (!existingCols.includes('deleted_at')) {
  db.exec('ALTER TABLE ratings ADD COLUMN deleted_at TEXT');
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

// Default path (app sync): last-write-wins. Only overwrite if newer.
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

const listAllStmt = db.prepare(`SELECT * FROM ratings ORDER BY updated_at DESC`);
const listSinceStmt = db.prepare(`SELECT * FROM ratings WHERE updated_at > ? ORDER BY updated_at DESC`);
const findByIdStmt = db.prepare(`SELECT * FROM ratings WHERE id = ?`);

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

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  bodyLimit: 2 * 1024 * 1024,
});

fastify.addHook('onRequest', async (req, reply) => {
  if (req.url === '/v1/healthz') return;
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== SYNC_TOKEN) {
    reply.code(401).send({ error: 'unauthorized' });
  }
});

fastify.get('/v1/healthz', async () => {
  return { ok: true, ts: new Date().toISOString() };
});

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
      // Matched writes bypass LWW — caller has already reconciled.
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

fastify.setErrorHandler((err, req, reply) => {
  req.log.error(err);
  reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'internal error' });
});

fastify.listen({ host: '127.0.0.1', port: PORT }).then((addr) => {
  fastify.log.info(`ratings-api listening on ${addr}`);
}).catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});

const shutdown = async (sig) => {
  fastify.log.info(`${sig} received, shutting down`);
  await fastify.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
