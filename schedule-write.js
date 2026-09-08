/**
 * v3 写端点：POST/PATCH/DELETE 课程与待办，外加 audit_log。
 *
 * 与同步端点（app 用）的分工：
 *   - /v1/schedule/sync 是 app 的 LWW 批量推送，时间戳由 app 决定（手机是那份数据的作者）。
 *   - 这里的写端点给 Claude／未来任何持 WRITE_TOKEN 的调用方用，**服务端是时间戳权威**：
 *     created_at / updated_at 一律服务端生成，caller 传了也不算数。理由是 mooring 与手机
 *     两个钟不一定同步，让远端 caller 自己写 updated_at 会把 LWW 的胜负交给时钟漂移。
 *
 * 并发控制：PATCH/DELETE 必须带 expected_updated_at（caller 先 GET 单条拿到），
 * 与库里现值不符即 409 stale，把当前记录原样奉还让 caller 重新决策。
 */

import { randomUUID } from 'node:crypto';
import { detectConflicts } from './schedule-domain.js';

const PAYLOAD_SUMMARY_MAX = 500;

/* ------------------------------------------------------------------ */
/* audit_log                                                           */
/* ------------------------------------------------------------------ */

export function initAuditSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      token_kind TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      record_id TEXT,
      payload_summary TEXT,
      outcome TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
  `);
}

/**
 * payload 摘要：JSON 序列化后截断到 500 字符。
 * 只是给人事后翻账用的，不追求可逆——超长就带个省略号，别把整个 body 灌进库。
 */
export function summarizePayload(payload) {
  if (payload == null) return null;
  let text;
  try {
    text = JSON.stringify(payload);
  } catch {
    text = String(payload);
  }
  if (text == null) return null;
  if (text.length <= PAYLOAD_SUMMARY_MAX) return text;
  return `${text.slice(0, PAYLOAD_SUMMARY_MAX - 1)}…`;
}

export function createAuditWriter(db) {
  initAuditSchema(db);
  const insert = db.prepare(`
    INSERT INTO audit_log (ts, token_kind, endpoint, method, record_id, payload_summary, outcome)
    VALUES (@ts, @token_kind, @endpoint, @method, @record_id, @payload_summary, @outcome)
  `);
  return function audit({ tokenKind, endpoint, method, recordId, payload, outcome, ts }) {
    insert.run({
      ts: ts ?? new Date().toISOString(),
      token_kind: tokenKind ?? 'unknown',
      endpoint,
      method,
      record_id: recordId ?? null,
      payload_summary: summarizePayload(payload),
      outcome,
    });
  };
}

/* ------------------------------------------------------------------ */
/* 写操作核心                                                           */
/* ------------------------------------------------------------------ */

/** 服务端接管的字段——caller 传什么都会被覆盖，不报错只是忽略。 */
const SERVER_OWNED = ['created_at', 'updated_at', 'synced_at', 'deleted_at', 'expected_updated_at'];

/** PATCH 时不允许 caller 直接改的字段（id 是主键，其余归服务端）。 */
const PATCH_PROTECTED = new Set([...SERVER_OWNED, 'id']);

/** 改了这些字段就得重跑冲突检测。 */
const TIME_FIELDS = ['start_time', 'end_time', 'repeat', 'repeat_until'];

/**
 * 生成严格晚于当前记录的服务端版本戳。
 *
 * 连续请求可能落在同一毫秒；若 PATCH 沿用与旧记录相同的 updated_at，旧的
 * expected_updated_at 仍会命中，乐观并发就失效。当前值若来自未来时钟，也仍需
 * 保持单调，才能继续参与 LWW 同步。
 */
export function nextVersionTime(currentUpdatedAt, now = new Date()) {
  const nowMs = now.getTime();
  const currentMs = Date.parse(currentUpdatedAt);
  const nextMs = Number.isFinite(currentMs) ? Math.max(nowMs, currentMs + 1) : nowMs;
  return new Date(nextMs).toISOString();
}

/**
 * POST 的记录组装：caller 的业务字段 + 服务端的时间戳与默认值。
 * @param {object} body caller 传的 body
 * @param {string} serverTime 服务端此刻（ISO）
 * @param {object} defaults 实体特有的缺省值（如 schedule 的 source: 'claude'）
 */
export function buildCreateRecord(body, serverTime, defaults = {}) {
  const draft = { ...body };
  for (const field of SERVER_OWNED) delete draft[field];
  return {
    ...defaults,
    ...draft,
    id: typeof body.id === 'string' && body.id ? body.id : randomUUID(),
    created_at: serverTime,
    updated_at: serverTime,
    synced_at: null,
    deleted_at: null,
  };
}

/**
 * PATCH 的记录组装：现有记录 merge caller 给的字段，时间戳换成服务端此刻。
 * caller 显式传 null 视为"清空该字段"（location/notes 这类可空字段要能删掉）。
 */
export function buildPatchRecord(current, body, serverTime) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(body)) {
    if (PATCH_PROTECTED.has(key)) continue;
    merged[key] = value;
  }
  merged.id = current.id;
  merged.created_at = current.created_at;
  merged.updated_at = serverTime;
  merged.synced_at = null;
  merged.deleted_at = null;
  return merged;
}

/** PATCH body 是否动了会影响冲突的字段。 */
export function touchesTimeFields(body) {
  return TIME_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(body, field));
}

/**
 * 对全部活跃事件跑冲突检测。
 * candidate 自身的 id 会被 detectConflicts 排除（PATCH 时正是靠这个不跟旧版自己撞）。
 * 返回的是完整的冲突事件（带 instance_start/instance_end，让 caller 能说清"撞的是哪一节"）。
 */
export function findConflicts(store, candidate) {
  const active = store.schedule.listActive.all().map(store.schedule.hydrate);
  return detectConflicts(candidate, active);
}

/** DELETE：写 tombstone（deleted_at + updated_at 都记服务端此刻）。 */
export function buildTombstone(current, serverTime) {
  return {
    ...current,
    updated_at: serverTime,
    synced_at: null,
    deleted_at: serverTime,
  };
}

/**
 * expected_updated_at 从 body 或 query 里取（DELETE 带 body 不是所有客户端都方便）。
 */
export function readExpectedUpdatedAt(req) {
  const fromBody = req.body && typeof req.body === 'object' ? req.body.expected_updated_at : undefined;
  if (typeof fromBody === 'string') return fromBody;
  const fromQuery = req.query?.expected_updated_at;
  if (typeof fromQuery === 'string') return fromQuery;
  return null;
}
