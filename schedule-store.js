/**
 * schedule_events / todos / config 三张新表的 schema、校验、LWW upsert。
 * 同步语义逐条对齐 ratings 表：LWW upsert、tombstone 软删、expected_updated_at 乐观并发。
 */

export const CATEGORY_KEYS = ['学习', '工作', '生活', '运动', '娱乐', '其他'];
export const REPEAT_TYPES = ['none', 'daily', 'weekly'];
export const REMINDER_MINUTES = [5, 15, 30];
// v3 起 app 端 SCHEDULE_EVENT_SOURCES 会加 'claude'，服务端先放行以免届时拒收。
export const EVENT_SOURCES = ['manual', 'whut-import', 'claude'];
export const TODO_TYPES = ['daily', 'weekly', 'longterm'];
export const TODO_PRIORITIES = ['high', 'medium', 'low'];

const MAX_TITLE = 200;
const MAX_LOCATION = 100;
const MAX_NOTES = 500;

export function initScheduleSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedule_events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      repeat TEXT NOT NULL DEFAULT 'none',
      repeat_until TEXT,
      location TEXT,
      reminder_minutes INTEGER,
      notes TEXT,
      source TEXT,
      is_completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT,
      deleted_at TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_schedule_events_updated_at ON schedule_events(updated_at);
    CREATE INDEX IF NOT EXISTS idx_schedule_events_start_time ON schedule_events(start_time);

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL,
      is_completed INTEGER NOT NULL DEFAULT 0,
      last_reset TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT,
      deleted_at TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_todos_updated_at ON todos(updated_at);

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 服务端自己的运行时元数据，跟 config 分表存。
    -- config 是 app 推上来的业务配置（会被 GET /v1/config/* 读出去），
    -- meta 是服务端观测到的事实（last_push_*），不该跟着 config 漏给调用方——
    -- 分表比在 config 上加过滤更保险：将来给 config 加端点也不会不小心带出去。
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/* ------------------------------------------------------------------ */
/* schedule_events                                                     */
/* ------------------------------------------------------------------ */

const SCHEDULE_FIELDS = [
  'id', 'title', 'category', 'start_time', 'end_time', 'repeat', 'repeat_until',
  'location', 'reminder_minutes', 'notes', 'source', 'is_completed',
  'created_at', 'updated_at', 'synced_at', 'deleted_at', 'schema_version',
];

const TODO_FIELDS = [
  'id', 'title', 'type', 'priority', 'is_completed', 'last_reset', 'notes',
  'created_at', 'updated_at', 'synced_at', 'deleted_at', 'schema_version',
];

function buildUpsert(db, table, fields) {
  const cols = fields.join(', ');
  const params = fields.map((f) => `@${f}`).join(', ');
  const setClause = fields
    .filter((f) => f !== 'id')
    .map((f) => `${f} = excluded.${f}`)
    .join(',\n    ');
  return {
    lww: db.prepare(`
      INSERT INTO ${table} (${cols}) VALUES (${params})
      ON CONFLICT(id) DO UPDATE SET
        ${setClause}
      WHERE excluded.updated_at > ${table}.updated_at
    `),
    force: db.prepare(`
      INSERT INTO ${table} (${cols}) VALUES (${params})
      ON CONFLICT(id) DO UPDATE SET
        ${setClause}
    `),
  };
}

export function createStore(db) {
  initScheduleSchema(db);

  const scheduleUpserts = buildUpsert(db, 'schedule_events', SCHEDULE_FIELDS);
  const todoUpserts = buildUpsert(db, 'todos', TODO_FIELDS);

  return {
    db,
    schedule: {
      ...scheduleUpserts,
      listAll: db.prepare('SELECT * FROM schedule_events ORDER BY updated_at DESC'),
      listSince: db.prepare('SELECT * FROM schedule_events WHERE updated_at > ? ORDER BY updated_at DESC'),
      listActive: db.prepare('SELECT * FROM schedule_events WHERE deleted_at IS NULL'),
      findById: db.prepare('SELECT * FROM schedule_events WHERE id = ?'),
      validate: validateScheduleEvent,
      normalize: normalizeScheduleEvent,
      hydrate: hydrateScheduleRow,
    },
    todos: {
      ...todoUpserts,
      listAll: db.prepare('SELECT * FROM todos ORDER BY updated_at DESC'),
      listSince: db.prepare('SELECT * FROM todos WHERE updated_at > ? ORDER BY updated_at DESC'),
      listActive: db.prepare('SELECT * FROM todos WHERE deleted_at IS NULL ORDER BY updated_at DESC'),
      findById: db.prepare('SELECT * FROM todos WHERE id = ?'),
      validate: validateTodo,
      normalize: normalizeTodo,
      hydrate: hydrateTodoRow,
    },
    config: {
      get: db.prepare('SELECT * FROM config WHERE key = ?'),
      upsert: db.prepare(`
        INSERT INTO config (key, value_json, updated_at) VALUES (@key, @value_json, @updated_at)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
        WHERE excluded.updated_at > config.updated_at
      `),
    },
    meta: {
      get: db.prepare('SELECT value FROM meta WHERE key = ?'),
      set: db.prepare(`
        INSERT INTO meta (key, value) VALUES (@key, @value)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `),
    },
  };
}

/** meta 表里记录「服务端最后一次收到该类数据推送」的 key。 */
export const LAST_PUSH_KEYS = {
  schedule: 'last_push_schedule',
  todos: 'last_push_todos',
};

/**
 * 记下服务端最后一次处理该类同步请求的时刻。
 *
 * 为什么不用 max(synced_at)：`synced_at` 是 app 收到服务端确认后在本地打的标记，
 * 推上来的 pending 记录里它恒为 null，服务端永远看不到非 null 值——照 max(synced_at)
 * 算出来的 last_synced 会永远是 null。真正能证明「手机刚活着推过」的是服务端自己
 * 观测到的这次请求时间，所以由服务端持久记录。
 *
 * records 为空的纯拉取调用也刷新：app 发起了同步就说明它活着，数据是新鲜的。
 */
export function markPushed(store, kind, at) {
  store.meta.set.run({ key: LAST_PUSH_KEYS[kind], value: at });
}

export function readLastPush(store, kind) {
  return store.meta.get.get(LAST_PUSH_KEYS[kind])?.value ?? null;
}

function isIsoish(value) {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

export function validateScheduleEvent(r) {
  if (typeof r !== 'object' || r === null) return 'record must be object';
  if (typeof r.id !== 'string' || !r.id) return 'id required';
  if (typeof r.title !== 'string' || !r.title) return 'title required';
  if (r.title.length > MAX_TITLE) return `title must be string <= ${MAX_TITLE}`;
  if (!CATEGORY_KEYS.includes(r.category)) return `category must be one of ${CATEGORY_KEYS.join('/')}`;
  if (!isIsoish(r.start_time)) return 'start_time must be ISO datetime string';
  if (!isIsoish(r.end_time)) return 'end_time must be ISO datetime string';
  const repeat = r.repeat ?? 'none';
  if (!REPEAT_TYPES.includes(repeat)) return `repeat must be one of ${REPEAT_TYPES.join('/')}`;
  if (r.repeat_until != null && !/^\d{4}-\d{2}-\d{2}$/.test(r.repeat_until)) {
    return 'repeat_until must be YYYY-MM-DD if provided';
  }
  if (r.location != null && (typeof r.location !== 'string' || r.location.length > MAX_LOCATION)) {
    return `location must be string <= ${MAX_LOCATION}`;
  }
  if (r.reminder_minutes != null && !REMINDER_MINUTES.includes(r.reminder_minutes)) {
    return `reminder_minutes must be one of ${REMINDER_MINUTES.join('/')} or null`;
  }
  if (r.notes != null && (typeof r.notes !== 'string' || r.notes.length > MAX_NOTES)) {
    return `notes must be string <= ${MAX_NOTES}`;
  }
  if (r.source != null && !EVENT_SOURCES.includes(r.source)) {
    return `source must be one of ${EVENT_SOURCES.join('/')}`;
  }
  if (r.is_completed != null && typeof r.is_completed !== 'boolean' && !Number.isInteger(r.is_completed)) {
    return 'is_completed must be boolean';
  }
  if (typeof r.created_at !== 'string') return 'created_at required';
  if (typeof r.updated_at !== 'string') return 'updated_at required';
  if (r.expected_updated_at != null && typeof r.expected_updated_at !== 'string') {
    return 'expected_updated_at must be string if provided';
  }
  if (r.deleted_at != null && typeof r.deleted_at !== 'string') {
    return 'deleted_at must be string if provided';
  }
  return null;
}

export function normalizeScheduleEvent(r) {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    start_time: r.start_time,
    end_time: r.end_time,
    repeat: r.repeat ?? 'none',
    repeat_until: r.repeat_until ?? null,
    location: r.location ?? null,
    reminder_minutes: r.reminder_minutes ?? null,
    notes: r.notes ?? null,
    source: r.source ?? null,
    is_completed: r.is_completed ? 1 : 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
    synced_at: r.synced_at ?? null,
    deleted_at: r.deleted_at ?? null,
    schema_version: Number.isInteger(r.schema_version) ? r.schema_version : 1,
  };
}

/** SQLite 行 → 对外 JSON（is_completed 0/1 还原成 boolean，对齐 app 类型）。 */
export function hydrateScheduleRow(row) {
  return { ...row, is_completed: Boolean(row.is_completed) };
}

/* ------------------------------------------------------------------ */
/* todos                                                               */
/* ------------------------------------------------------------------ */

export function validateTodo(r) {
  if (typeof r !== 'object' || r === null) return 'record must be object';
  if (typeof r.id !== 'string' || !r.id) return 'id required';
  if (typeof r.title !== 'string' || !r.title) return 'title required';
  if (r.title.length > MAX_TITLE) return `title must be string <= ${MAX_TITLE}`;
  if (!TODO_TYPES.includes(r.type)) return `type must be one of ${TODO_TYPES.join('/')}`;
  if (!TODO_PRIORITIES.includes(r.priority)) return `priority must be one of ${TODO_PRIORITIES.join('/')}`;
  if (r.is_completed != null && typeof r.is_completed !== 'boolean' && !Number.isInteger(r.is_completed)) {
    return 'is_completed must be boolean';
  }
  if (typeof r.last_reset !== 'string' || !r.last_reset) return 'last_reset required';
  if (r.notes != null && (typeof r.notes !== 'string' || r.notes.length > MAX_NOTES)) {
    return `notes must be string <= ${MAX_NOTES}`;
  }
  if (typeof r.created_at !== 'string') return 'created_at required';
  if (typeof r.updated_at !== 'string') return 'updated_at required';
  if (r.expected_updated_at != null && typeof r.expected_updated_at !== 'string') {
    return 'expected_updated_at must be string if provided';
  }
  if (r.deleted_at != null && typeof r.deleted_at !== 'string') {
    return 'deleted_at must be string if provided';
  }
  return null;
}

export function normalizeTodo(r) {
  return {
    id: r.id,
    title: r.title,
    type: r.type,
    priority: r.priority,
    is_completed: r.is_completed ? 1 : 0,
    last_reset: r.last_reset,
    notes: r.notes ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    synced_at: r.synced_at ?? null,
    deleted_at: r.deleted_at ?? null,
    schema_version: Number.isInteger(r.schema_version) ? r.schema_version : 1,
  };
}

export function hydrateTodoRow(row) {
  return { ...row, is_completed: Boolean(row.is_completed) };
}

/* ------------------------------------------------------------------ */
/* 同步事务：与 ratings /v1/ratings/sync 的循环逐条对齐                  */
/* ------------------------------------------------------------------ */

export function runSync(db, entity, records) {
  let applied = 0;
  let rejected = 0;
  const errors = [];

  const tx = db.transaction((incoming) => {
    for (const raw of incoming) {
      const err = entity.validate(raw);
      if (err) {
        rejected += 1;
        errors.push({ id: raw?.id ?? null, error: err });
        continue;
      }
      if (raw.expected_updated_at != null) {
        const current = entity.findById.get(raw.id);
        const expected = raw.expected_updated_at;
        const currentUpdatedAt = current ? current.updated_at : null;
        if (currentUpdatedAt !== expected) {
          rejected += 1;
          errors.push({
            id: raw.id,
            error: 'stale',
            expected_updated_at: expected,
            current_record: current ? entity.hydrate(current) : null,
          });
          continue;
        }
        entity.force.run(entity.normalize(raw));
        applied += 1;
        continue;
      }
      const info = entity.lww.run(entity.normalize(raw));
      if (info.changes > 0) applied += 1;
    }
  });
  tx(records);

  return { applied, rejected, errors };
}

/* ------------------------------------------------------------------ */
/* semester config                                                     */
/* ------------------------------------------------------------------ */

export function validateSemester(body) {
  if (typeof body !== 'object' || body === null) return 'body must be object';
  if (typeof body.start_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.start_date)) {
    return 'start_date must be YYYY-MM-DD';
  }
  if (!Number.isInteger(body.total_weeks) || body.total_weeks < 1 || body.total_weeks > 60) {
    return 'total_weeks must be integer 1-60';
  }
  if (typeof body.updated_at !== 'string' || !body.updated_at) return 'updated_at required';
  return null;
}

export function readSemester(store) {
  const row = store.config.get.get('semester');
  if (!row) return null;
  let value;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    return null;
  }
  return { ...value, updated_at: row.updated_at };
}
