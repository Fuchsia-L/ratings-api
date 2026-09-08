import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildSummary, parseSummaryDays } from './summary.js';
import { createStore, runSync, validateSemester, readSemester, markPushed } from './schedule-store.js';
import { buildDay, buildWindow, validateWindow, DATE_RE, isValidDateString } from './schedule-query.js';
import {
  createAuditWriter,
  buildCreateRecord,
  buildPatchRecord,
  buildTombstone,
  touchesTimeFields,
  findConflicts,
  readExpectedUpdatedAt,
} from './schedule-write.js';

/**
 * 只读端点白名单：READONLY_TOKEN 只能碰这两个（设计 §3）。
 * SYNC_TOKEN 能碰全部 /v1。
 */
const READONLY_PATHS = new Set(['/v1/schedule/day', '/v1/schedule/window']);

/**
 * WRITE_TOKEN 能碰的路径（设计 §A.1 权限矩阵）：写端点 + 查询端点 + 单条读。
 * 同步端点（app 的批量 LWW 推送）和 pull 端点不给——那是手机的活，
 * 拿写 token 去推整批记录会绕开这里的服务端时间戳权威与 audit。
 *
 * 精确路径用 Set，带 :id 的用前缀匹配。
 */
const WRITE_TOKEN_PATHS = new Set([
  '/v1/schedule/day',
  '/v1/schedule/window',
  '/v1/schedule/events',
]);
const WRITE_TOKEN_PREFIXES = ['/v1/schedule/events/', '/v1/todos/'];

/**
 * 同步端点是 app 的地盘，写 token 一律挡在门外。
 * 单列出来是因为 `/v1/todos/sync` 恰好落在 `/v1/todos/` 前缀里——
 * 光靠前缀匹配会把批量推送的门也一起开了。
 */
const SYNC_ONLY_PATHS = new Set(['/v1/schedule/sync', '/v1/todos/sync']);

function writeTokenMayAccess(path, method) {
  if (SYNC_ONLY_PATHS.has(path)) return false;
  // POST /v1/todos 是写端点；GET /v1/todos 是 app 的 pull 端点，不给。
  if (path === '/v1/todos') return method === 'POST';
  if (WRITE_TOKEN_PATHS.has(path)) return true;
  return WRITE_TOKEN_PREFIXES.some((prefix) => path.startsWith(prefix));
}

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
 * @param {string} [opts.writeToken] 缺失 = 写端点整体关闭（非 fatal，见 server.js）
 * @param {string} [opts.internalToken]
 */
export function buildApp({ db, syncToken, readonlyToken, writeToken, internalToken, logger = false, bodyLimit }) {
  const store = createStore(db);
  const audit = createAuditWriter(db);
  const writeEnabled = Boolean(writeToken && writeToken.length >= 32);

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
    if (presented === syncToken) {
      req.tokenKind = 'sync';
      return;
    }
    if (writeEnabled && presented === writeToken) {
      req.tokenKind = 'write';
      if (writeTokenMayAccess(path, req.method)) return;
      // 认得这把钥匙，但这扇门不归它开。
      return reply.code(403).send({ error: 'forbidden_for_write_token' });
    }
    if (readonlyToken && readonlyToken.length >= 32 && presented === readonlyToken) {
      req.tokenKind = 'readonly';
      if (READONLY_PATHS.has(path)) return;
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

  function syncHandler(entity, kind) {
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
      const serverTime = new Date().toISOString();
      // 请求走到这里就说明 app 活着并完成了一次同步 —— 记为数据新鲜度基准。
      // records 为空的纯拉取调用同样算数（app 在跑就够了），格式错的请求已在上面 400 返回。
      markPushed(store, kind, serverTime);
      const rows = since ? entity.listSince.all(since) : entity.listAll.all();
      return {
        applied,
        rejected,
        errors: errors.length ? errors : undefined,
        records: rows.map(entity.hydrate),
        server_time: serverTime,
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

  fastify.post('/v1/schedule/sync', syncHandler(store.schedule, 'schedule'));
  fastify.post('/v1/todos/sync', syncHandler(store.todos, 'todos'));
  fastify.get('/v1/schedule', pullHandler(store.schedule));
  fastify.get('/v1/todos', pullHandler(store.todos));

  /* ---------------- config/semester ---------------- */

  fastify.put('/v1/config/semester', async (req, reply) => {
    const body = req.body ?? {};
    const { error, value } = validateSemester(body);
    if (error) return reply.code(400).send({ error });
    // value.start_date 已规范化为裸上海日历日（app 发的是 toISOString 形态）
    const info = store.config.upsert.run({
      key: 'semester',
      value_json: JSON.stringify({ start_date: value.start_date, total_weeks: value.total_weeks }),
      updated_at: value.updated_at,
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
      if (!isValidDateString(date)) {
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

  /* ---------------- v3 写端点（WRITE_TOKEN / SYNC_TOKEN） ---------------- */

  /**
   * 写端点的公共骨架。
   *
   * 关键约定（设计 §A.2）：
   *   - 服务端是时间戳权威：created_at/updated_at 一律用这里的 serverTime。
   *   - 每次调用无论成败都往 audit_log 落一行，outcome 记录到底发生了什么。
   *   - 校验走同步端点那套 entity.validate，错误信息与 app 推送时完全一致。
   *
   * @param {object} entity store.schedule 或 store.todos
   * @param {string} endpointBase 记进 audit 的端点名
   * @param {object} createDefaults POST 时的缺省字段
   * @param {boolean} conflictCheck 是否跑冲突检测（只有课程要）
   */
  function registerWriteRoutes({ entity, endpointBase, createDefaults, conflictCheck }) {
    /** 落 audit 并返回 reply，保证任何一条出口都留痕。 */
    function done(req, reply, { code, body, recordId, outcome, payload }) {
      audit({
        tokenKind: req.tokenKind,
        endpoint: endpointBase,
        method: req.method,
        recordId: recordId ?? null,
        payload: payload ?? req.body ?? null,
        outcome,
      });
      return reply.code(code).send(body);
    }

    /** 单条读：含软删记录（caller 要拿 expected_updated_at，墓碑也得看得见）。 */
    fastify.get(`${endpointBase}/:id`, async (req, reply) => {
      const row = entity.findById.get(req.params.id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const record = entity.hydrate(row);
      return {
        record,
        deleted: record.deleted_at != null,
        server_time: new Date().toISOString(),
      };
    });

    fastify.post(endpointBase, async (req, reply) => {
      const serverTime = new Date().toISOString();
      const body = req.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        return done(req, reply, {
          code: 400, outcome: 'validation_error', body: { error: 'body must be object' },
        });
      }

      const record = buildCreateRecord(body, serverTime, createDefaults);
      const err = entity.validate(record);
      if (err) {
        return done(req, reply, {
          code: 400, outcome: 'validation_error', recordId: record.id, body: { error: err },
        });
      }

      // id 撞车：caller 自带 id 但库里已有（含墓碑）。让它显式走 PATCH，别悄悄覆盖。
      if (entity.findById.get(record.id)) {
        return done(req, reply, {
          code: 409, outcome: 'conflict', recordId: record.id,
          body: { error: 'id_exists', current_record: entity.hydrate(entity.findById.get(record.id)) },
        });
      }

      if (conflictCheck) {
        const conflicts = findConflicts(store, record);
        if (conflicts.length > 0) {
          return done(req, reply, {
            code: 409, outcome: 'conflict', recordId: record.id,
            body: { error: 'conflict', conflicts },
          });
        }
      }

      entity.force.run(entity.normalize(record));
      const saved = entity.hydrate(entity.findById.get(record.id));
      return done(req, reply, {
        code: 201, outcome: 'created', recordId: record.id,
        body: { record: saved, server_time: serverTime },
      });
    });

    fastify.patch(`${endpointBase}/:id`, async (req, reply) => {
      const serverTime = new Date().toISOString();
      const id = req.params.id;
      const body = req.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        return done(req, reply, {
          code: 400, outcome: 'validation_error', recordId: id, body: { error: 'body must be object' },
        });
      }

      const expected = readExpectedUpdatedAt(req);
      if (!expected) {
        return done(req, reply, {
          code: 400, outcome: 'validation_error', recordId: id,
          body: { error: 'expected_updated_at required' },
        });
      }

      const row = entity.findById.get(id);
      // 软删的记录当作不存在：改一条已经删掉的课没有意义，让 caller 重新建。
      if (!row || row.deleted_at != null) {
        return done(req, reply, { code: 404, outcome: 'not_found', recordId: id, body: { error: 'not_found' } });
      }

      const current = entity.hydrate(row);
      if (current.updated_at !== expected) {
        return done(req, reply, {
          code: 409, outcome: 'stale', recordId: id,
          body: { error: 'stale', current_record: current },
        });
      }

      const merged = buildPatchRecord(current, body, serverTime);
      const err = entity.validate(merged);
      if (err) {
        return done(req, reply, {
          code: 400, outcome: 'validation_error', recordId: id, body: { error: err },
        });
      }

      if (conflictCheck && touchesTimeFields(body)) {
        const conflicts = findConflicts(store, merged);
        if (conflicts.length > 0) {
          return done(req, reply, {
            code: 409, outcome: 'conflict', recordId: id, body: { error: 'conflict', conflicts },
          });
        }
      }

      entity.force.run(entity.normalize(merged));
      const saved = entity.hydrate(entity.findById.get(id));
      return done(req, reply, {
        code: 200, outcome: 'updated', recordId: id,
        body: { record: saved, server_time: serverTime },
      });
    });

    fastify.delete(`${endpointBase}/:id`, async (req, reply) => {
      const serverTime = new Date().toISOString();
      const id = req.params.id;

      const expected = readExpectedUpdatedAt(req);
      if (!expected) {
        return done(req, reply, {
          code: 400, outcome: 'validation_error', recordId: id,
          body: { error: 'expected_updated_at required' },
        });
      }

      const row = entity.findById.get(id);
      if (!row || row.deleted_at != null) {
        return done(req, reply, { code: 404, outcome: 'not_found', recordId: id, body: { error: 'not_found' } });
      }

      const current = entity.hydrate(row);
      if (current.updated_at !== expected) {
        return done(req, reply, {
          code: 409, outcome: 'stale', recordId: id,
          body: { error: 'stale', current_record: current },
        });
      }

      entity.force.run(entity.normalize(buildTombstone(current, serverTime)));
      const saved = entity.hydrate(entity.findById.get(id));
      return done(req, reply, {
        code: 200, outcome: 'deleted', recordId: id,
        body: { record: saved, server_time: serverTime },
      });
    });
  }

  registerWriteRoutes({
    entity: store.schedule,
    endpointBase: '/v1/schedule/events',
    // source 缺省 'claude'：这些端点的调用方就是 Claude（设计 §A.2）。
    createDefaults: { repeat: 'none', category: '学习', source: 'claude', is_completed: false },
    conflictCheck: true,
  });

  registerWriteRoutes({
    entity: store.todos,
    endpointBase: '/v1/todos',
    createDefaults: { type: 'daily', priority: 'medium', is_completed: false },
    conflictCheck: false,
  });

  fastify.setErrorHandler((err, req, reply) => {
    req.log.error(err);
    reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'internal error' });
  });

  return fastify;
}
