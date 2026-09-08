/**
 * 查询端点的取数与组装（GET /v1/schedule/day、/v1/schedule/window）。
 * 一切「当天」「本地日期」均按 Asia/Shanghai 解读，见 schedule-domain.js 顶部注释。
 */

import {
  expandRepeatingEvents,
  formatShanghaiDate,
  formatShanghaiDateTime,
  getSemesterWeek,
  parseShanghai,
  shanghaiDayEnd,
  shanghaiDayStart,
  shanghaiToday,
  shanghaiWeekday,
} from './schedule-domain.js';
import { readSemester, readLastPush } from './schedule-store.js';

export const MAX_WINDOW_DAYS = 62;
const DAY_MS = 86400000;

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 严格校验 YYYY-MM-DD，避免 Date 把 2 月 30 日静默滚到下个月。 */
export function isValidDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = shanghaiDayStart(value);
  return !Number.isNaN(parsed.getTime()) && formatShanghaiDate(parsed) === value;
}

/**
 * 展开区间内的实例，并挂上关联评分。
 * 评分关联规则（设计 §3）：ratings.linked_event_id = 母事件 id
 * 且 slot 与实例时间重叠，或 slot 落在实例所在的那个 Asia/Shanghai 自然日。
 */
export function collectEvents(store, rangeStart, rangeEnd) {
  const mothers = store.schedule.listActive.all().map(store.schedule.hydrate);
  const instances = expandRepeatingEvents(mothers, rangeStart, rangeEnd);
  instances.sort((a, b) => a.instance_start.localeCompare(b.instance_start));

  const ids = [...new Set(instances.map((e) => e.id))];
  const ratingsByEvent = loadRatings(store.db, ids);

  return instances.map((instance) => ({
    ...instance,
    ratings: matchRatings(ratingsByEvent.get(instance.id) ?? [], instance),
  }));
}

function loadRatings(db, eventIds) {
  const byEvent = new Map();
  if (eventIds.length === 0) return byEvent;
  const placeholders = eventIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT linked_event_id, rating, efficiency, mood, activity, reflection, slot_start, slot_end
    FROM ratings
    WHERE deleted_at IS NULL AND linked_event_id IN (${placeholders})
    ORDER BY slot_start
  `).all(...eventIds);
  for (const row of rows) {
    if (!byEvent.has(row.linked_event_id)) byEvent.set(row.linked_event_id, []);
    byEvent.get(row.linked_event_id).push(row);
  }
  return byEvent;
}

function matchRatings(candidates, instance) {
  // 实例时间是裸上海格式（业务语义），ratings.slot_* 是真 UTC ISO（同步语义）——
  // 比较前必须各按各的语义换成绝对时刻，不能对裸格式用 Date.parse（那会看进程时区）。
  const instStart = parseShanghai(instance.instance_start);
  const instEnd = parseShanghai(instance.instance_end);
  const instDay = formatShanghaiDate(instStart);
  return candidates
    .filter((r) => {
      const s = Date.parse(r.slot_start);
      const e = Date.parse(r.slot_end);
      if (Number.isFinite(s) && Number.isFinite(e) && s < instEnd && e > instStart) return true;
      return Number.isFinite(s) && formatShanghaiDate(s) === instDay;
    })
    .map((r) => ({
      rating: r.rating,
      efficiency: r.efficiency,
      mood: r.mood,
      activity: r.activity,
      reflection: r.reflection,
      slot_start: r.slot_start,
      slot_end: r.slot_end,
    }));
}

/**
 * 数据新鲜度：服务端最后一次收到 app 同步请求的时刻。
 *
 * 注意不是 max(synced_at)——那个字段是 app 收到确认后打的本地标记，推上来时恒为 null，
 * 服务端永远看不到非 null 值。这里返回服务端自己记的 last_push_*（见 schedule-store.js
 * 的 markPushed），null 现在真表示「一次都没推过」。
 */
export function lastSynced(store) {
  return {
    schedule: readLastPush(store, 'schedule'),
    todos: readLastPush(store, 'todos'),
  };
}

/** GET /v1/schedule/day 的响应体。 */
export function buildDay(store, dateStr, now = new Date()) {
  const date = dateStr ?? shanghaiToday(now);
  const rangeStart = shanghaiDayStart(date);
  const rangeEnd = shanghaiDayEnd(date);
  const semester = readSemester(store);

  return {
    date,
    weekday: shanghaiWeekday(rangeStart),
    semester_week: semester ? getSemesterWeek(semester.start_date, rangeStart) : null,
    events: collectEvents(store, rangeStart, rangeEnd),
    todos: store.todos.listActive.all().map(store.todos.hydrate),
    last_synced: lastSynced(store),
    server_time: now.toISOString(),
  };
}

/** GET /v1/schedule/window 的响应体；越界由调用方先用 validateWindow 拦。 */
export function buildWindow(store, startIso, endIso, now = new Date()) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const semester = readSemester(store);

  return {
    // 回显窗口用裸上海格式，与 events 的 instance_* 同语义（消费端是人和 Claude）。
    start: formatShanghaiDateTime(start),
    end: formatShanghaiDateTime(end),
    semester_week: semester ? getSemesterWeek(semester.start_date, start) : null,
    events: collectEvents(store, start, end),
    last_synced: lastSynced(store),
    server_time: now.toISOString(),
  };
}

/**
 * 窗口参数校验。start/end 接受：
 * - `YYYY-MM-DD` —— 按 Asia/Shanghai 当日 00:00 / 23:59:59.999
 * - 裸格式 `YYYY-MM-DDTHH:mm:ss` —— 按上海钟点（与业务字段同语义）
 * - 带 Z / 带 offset 的 ISO —— 按其声明时区
 * 时间点查询 = start === end，允许。
 */
export function validateWindow(startRaw, endRaw) {
  if (typeof startRaw !== 'string' || !startRaw) return { error: 'start required' };
  if (typeof endRaw !== 'string' || !endRaw) return { error: 'end required' };

  if (DATE_RE.test(startRaw) && !isValidDateString(startRaw)) {
    return { error: 'start must be ISO datetime or YYYY-MM-DD' };
  }
  if (DATE_RE.test(endRaw) && !isValidDateString(endRaw)) {
    return { error: 'end must be ISO datetime or YYYY-MM-DD' };
  }

  const start = DATE_RE.test(startRaw) ? shanghaiDayStart(startRaw) : new Date(parseShanghai(startRaw));
  const end = DATE_RE.test(endRaw) ? shanghaiDayEnd(endRaw) : new Date(parseShanghai(endRaw));

  if (Number.isNaN(start.getTime())) {
    return { error: 'start must be YYYY-MM-DD, YYYY-MM-DDTHH:mm:ss (Asia/Shanghai), or a zoned ISO datetime' };
  }
  if (Number.isNaN(end.getTime())) {
    return { error: 'end must be YYYY-MM-DD, YYYY-MM-DDTHH:mm:ss (Asia/Shanghai), or a zoned ISO datetime' };
  }
  if (end.getTime() < start.getTime()) return { error: 'end must not be before start' };
  if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    return { error: `window must not exceed ${MAX_WINDOW_DAYS} days` };
  }
  return { start, end };
}
