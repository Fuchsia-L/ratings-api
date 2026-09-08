/**
 * 查询端点的取数与组装（GET /v1/schedule/day、/v1/schedule/window）。
 * 一切「当天」「本地日期」均按 Asia/Shanghai 解读，见 schedule-domain.js 顶部注释。
 */

import {
  expandRepeatingEvents,
  formatShanghaiDate,
  getSemesterWeek,
  shanghaiDayEnd,
  shanghaiDayStart,
  shanghaiToday,
  shanghaiWeekday,
} from './schedule-domain.js';
import { readSemester } from './schedule-store.js';

export const MAX_WINDOW_DAYS = 62;
const DAY_MS = 86400000;

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  const instStart = Date.parse(instance.instance_start);
  const instEnd = Date.parse(instance.instance_end);
  const instDay = formatShanghaiDate(instance.instance_start);
  return candidates
    .filter((r) => {
      const s = Date.parse(r.slot_start);
      const e = Date.parse(r.slot_end);
      if (Number.isFinite(s) && Number.isFinite(e) && s < instEnd && e > instStart) return true;
      return Number.isFinite(s) && formatShanghaiDate(r.slot_start) === instDay;
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

export function lastSynced(store) {
  return {
    schedule: store.schedule.maxSyncedAt.get()?.v ?? null,
    todos: store.todos.maxSyncedAt.get()?.v ?? null,
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
    start: start.toISOString(),
    end: end.toISOString(),
    semester_week: semester ? getSemesterWeek(semester.start_date, start) : null,
    events: collectEvents(store, start, end),
    last_synced: lastSynced(store),
    server_time: now.toISOString(),
  };
}

/**
 * 窗口参数校验。start/end 接受完整 ISO 时刻或 YYYY-MM-DD（后者按 Asia/Shanghai 当日
 * 00:00 / 23:59:59.999 解读）。时间点查询 = start === end，允许。
 */
export function validateWindow(startRaw, endRaw) {
  if (typeof startRaw !== 'string' || !startRaw) return { error: 'start required' };
  if (typeof endRaw !== 'string' || !endRaw) return { error: 'end required' };

  const start = DATE_RE.test(startRaw) ? shanghaiDayStart(startRaw) : new Date(startRaw);
  const end = DATE_RE.test(endRaw) ? shanghaiDayEnd(endRaw) : new Date(endRaw);

  if (Number.isNaN(start.getTime())) return { error: 'start must be ISO datetime or YYYY-MM-DD' };
  if (Number.isNaN(end.getTime())) return { error: 'end must be ISO datetime or YYYY-MM-DD' };
  if (end.getTime() < start.getTime()) return { error: 'end must not be before start' };
  if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    return { error: `window must not exceed ${MAX_WINDOW_DAYS} days` };
  }
  return { start, end };
}
