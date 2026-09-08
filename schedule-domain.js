/**
 * 课程重复展开 / 冲突检测的服务端移植版。
 *
 * app 侧（klass2 src/features/schedule/domain/repeat.ts、conflicts.ts）跑在手机上，
 * `setDate` / `getFullYear` 这些都取手机本地时区；node 服务端进程默认 UTC。
 * 这里把「本地」显式钉死成 Asia/Shanghai（UTC+8，无夏令时），
 * 所有「本地日期」一律 +8h 后读 UTC 字段，禁止依赖 process.env.TZ。
 * 参考 summary.js 的 `+8 hours` 模式。
 */

export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 86400000;

/**
 * 业务时间字段（start_time / end_time / repeat_until / last_reset）的规范存储格式：
 * 裸本地 `YYYY-MM-DDTHH:mm:ss`，语义是 **floating Asia/Shanghai 钟点**（合约第 20 条）。
 *
 * app（whut-import 导入的真课表）就是这么存这么推的：`2026-09-08T08:00:00`，
 * 无 Z 无 offset 无毫秒。`new Date('2026-09-08T08:00:00')` 会按**进程时区**解析——
 * 服务端 TZ=UTC 时被当成 08:00Z，整条链平移 +8，上海 14:00 的课会显示成 22:00。
 * 所以裸格式一律由 parseShanghai 按上海钟点解释，绝不走 `new Date(裸串)`。
 *
 * 同步字段（created_at / updated_at / synced_at / deleted_at）不在此列：
 * 那些是真 UTC 毫秒 ISO，照常用 Date 解析比较。
 */
const NAIVE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 带 Z 或 ±HH:mm 偏移的输入——由 Date 正确解析成绝对时刻。 */
const HAS_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Date.UTC 会把 2 月 30 日、25:00 等自动滚动；业务时间必须逐分量严格匹配。 */
function strictUtcParts(y, mo, d, h = 0, mi = 0, s = 0, ms = 0) {
  const wallMs = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const wall = new Date(wallMs);
  if (
    wall.getUTCFullYear() !== y
    || wall.getUTCMonth() + 1 !== mo
    || wall.getUTCDate() !== d
    || wall.getUTCHours() !== h
    || wall.getUTCMinutes() !== mi
    || wall.getUTCSeconds() !== s
    || wall.getUTCMilliseconds() !== ms
  ) return NaN;
  return wallMs;
}

/**
 * 业务时间字符串 → epoch ms，一律按 Asia/Shanghai 语义。
 *
 * - 裸格式 `2026-09-08T08:00:00`（可带毫秒、可用空格分隔）→ 上海钟点
 * - 纯日期 `2026-09-08` → 上海当日 00:00
 * - 带 Z / 带 offset → 按其声明时区换算成绝对时刻（再由 formatShanghai* 转成上海钟点）
 * - Date 实例 → 直接取 getTime()
 *
 * 解析失败返回 NaN，由调用方决定拒绝还是跳过。
 */
export function parseShanghai(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') return NaN;
  const text = value.trim();
  if (!text) return NaN;

  const naive = NAIVE_DATETIME_RE.exec(text);
  if (naive) {
    const [, y, mo, d, h, mi, s, ms] = naive;
    const wallMs = strictUtcParts(
      Number(y), Number(mo), Number(d),
      Number(h), Number(mi), Number(s ?? 0), Number((ms ?? '0').padEnd(3, '0')),
    );
    return Number.isFinite(wallMs) ? wallMs - SHANGHAI_OFFSET_MS : NaN;
  }
  if (DATE_ONLY_RE.test(text)) {
    const [, y, mo, d] = DATE_ONLY_RE.exec(text);
    const wallMs = strictUtcParts(Number(y), Number(mo), Number(d));
    return Number.isFinite(wallMs) ? wallMs - SHANGHAI_OFFSET_MS : NaN;
  }
  if (HAS_ZONE_RE.test(text)) return Date.parse(text);
  // 认不出的形状：不猜，交给调用方按无效处理。
  return NaN;
}

/**
 * epoch ms / 任意可解析输入 → 规范存储格式：裸上海 `YYYY-MM-DDTHH:mm:ss`。
 * 带 Z / 带 offset / 带毫秒的输入在这里被换算并抹平成上海钟点。
 */
export function formatShanghaiDateTime(value) {
  const ms = typeof value === 'number' ? value : parseShanghai(value);
  if (!Number.isFinite(ms)) return null;
  const t = new Date(ms + SHANGHAI_OFFSET_MS);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`
    + `T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/** 业务时间字符串 / Date / epoch ms → epoch ms（内部统一入口）。 */
function toMs(value) {
  if (typeof value === 'number') return value;
  return value instanceof Date ? value.getTime() : parseShanghai(value);
}

/**
 * app 的 `formatLocalDate(date)`（手机本地 Y-M-D）在服务端的等价物：
 * 把时刻挪到 UTC+8 再读 UTC 年月日。
 */
export function formatShanghaiDate(value) {
  const shifted = new Date(toMs(value) + SHANGHAI_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Asia/Shanghai 当天 00:00:00.000 对应的 UTC 时刻。 */
export function shanghaiDayStart(dateStr) {
  return new Date(`${dateStr}T00:00:00.000+08:00`);
}

/** Asia/Shanghai 当天 23:59:59.999 对应的 UTC 时刻。 */
export function shanghaiDayEnd(dateStr) {
  return new Date(`${dateStr}T23:59:59.999+08:00`);
}

/** Asia/Shanghai 的「今天」。 */
export function shanghaiToday(now = new Date()) {
  return formatShanghaiDate(now);
}

/**
 * app 的 `getDay()`（0=周日…6=周六）在 Asia/Shanghai 下的等价物。
 */
export function shanghaiWeekday(value) {
  return new Date(toMs(value) + SHANGHAI_OFFSET_MS).getUTCDay();
}

/**
 * app 的 addDays 用 `setDate`，在无夏令时的 UTC+8 下等价于整日毫秒偏移。
 */
function addDaysMs(ms, days) {
  return ms + days * DAY_MS;
}

function isAfterRepeatUntil(ms, repeatUntil) {
  return repeatUntil != null && repeatUntil !== '' && formatShanghaiDate(ms) > repeatUntil;
}

/**
 * 逐行移植 app `expandRepeatingEvents`。
 *
 * 与 app 版的唯一差异：重复实例的时间写进 `instance_start` / `instance_end`，
 * 母事件的 `start_time` / `end_time` 原样保留（设计 §3 要求消费端不迷惑）。
 * 非重复事件也补上 instance_*（= 自身时间），让消费端结构统一。
 *
 * @param {Array} events 母事件数组（调用方负责先滤掉 deleted_at）
 * @param {Date|string} rangeStart
 * @param {Date|string} rangeEnd
 */
export function expandRepeatingEvents(events, rangeStart, rangeEnd) {
  const rangeStartMs = toMs(rangeStart);
  const rangeEndMs = toMs(rangeEnd);
  const result = [];

  for (const event of events) {
    const eventStartMs = toMs(event.start_time);
    const eventEndMs = toMs(event.end_time);
    if (!Number.isFinite(eventStartMs) || !Number.isFinite(eventEndMs)) continue;
    const duration = eventEndMs - eventStartMs;

    if (event.repeat === 'none' || event.repeat == null) {
      if (eventStartMs <= rangeEndMs && eventEndMs >= rangeStartMs) {
        result.push(withInstance(event, eventStartMs, eventEndMs));
      }
      continue;
    }

    const stepDays = event.repeat === 'daily' ? 1 : 7;
    let cursor = eventStartMs;

    while (cursor + duration < rangeStartMs) {
      cursor = addDaysMs(cursor, stepDays);
    }

    if (isAfterRepeatUntil(cursor, event.repeat_until)) {
      continue;
    }

    while (cursor <= rangeEndMs) {
      if (isAfterRepeatUntil(cursor, event.repeat_until)) {
        break;
      }
      const instanceEnd = cursor + duration;
      if (instanceEnd >= rangeStartMs) {
        result.push(withInstance(event, cursor, instanceEnd));
      }
      cursor = addDaysMs(cursor, stepDays);
    }
  }

  return result;
}

/**
 * 实例时间输出为裸上海格式（合约第 20 条）——消费端是人和 Claude，本地钟点最直读。
 * 母事件的 start_time / end_time 原样保留（已是裸上海格式）。
 */
function withInstance(event, startMs, endMs) {
  return {
    ...event,
    instance_start: formatShanghaiDateTime(startMs),
    instance_end: formatShanghaiDateTime(endMs),
  };
}

/**
 * 逐行移植 app `detectConflicts`。
 * app 用 `setMonth(±1)`（本地月），服务端在 UTC+8 上做同样的「本地月」偏移。
 * 第一期不开写端点，此函数仅供 v3 与单测使用。
 */
export function detectConflicts(candidate, allEvents) {
  const candidateStartMs = toMs(candidate.start_time);
  const candidateEndMs = toMs(candidate.end_time);
  const rangeStart = shiftMonthsShanghai(candidateStartMs, -1);
  const rangeEnd = shiftMonthsShanghai(candidateEndMs, 1);

  const expandedEvents = expandRepeatingEvents(
    allEvents.filter((event) => event.id !== candidate.id),
    rangeStart,
    rangeEnd,
  );
  const candidateInstances = expandRepeatingEvents([candidate], rangeStart, rangeEnd);
  const conflicts = [];

  for (const instance of candidateInstances) {
    const instanceStart = toMs(instance.instance_start);
    const instanceEnd = toMs(instance.instance_end);
    for (const event of expandedEvents) {
      const eventStart = toMs(event.instance_start);
      const eventEnd = toMs(event.instance_end);
      if (instanceStart < eventEnd && instanceEnd > eventStart) {
        if (!conflicts.find((conflict) => conflict.id === event.id)) {
          conflicts.push(event);
        }
      }
    }
  }

  return conflicts;
}

/** app `setMonth(getMonth() + n)` 的 UTC+8 等价物（含 JS 月末溢出行为）。 */
function shiftMonthsShanghai(ms, months) {
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS);
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  return shifted.getTime() - SHANGHAI_OFFSET_MS;
}

/**
 * app `getWeekStart`：本周周一 00:00（本地）。返回 UTC ms。
 */
export function shanghaiWeekStartMs(value) {
  const shifted = new Date(toMs(value) + SHANGHAI_OFFSET_MS);
  const day = shifted.getUTCDay();
  const diff = shifted.getUTCDate() - day + (day === 0 ? -6 : 1);
  shifted.setUTCDate(diff);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted.getTime() - SHANGHAI_OFFSET_MS;
}

/**
 * app `getSemesterWeek(semesterStart, date)` 的服务端等价物。
 * semesterStart 是 'YYYY-MM-DD'（app 存的学期起始日），按 Asia/Shanghai 解读。
 */
export function getSemesterWeek(semesterStart, date) {
  if (!semesterStart) return null;
  // parseShanghai 已经统一处理纯日期 / 裸格式 / 带时区三种形状。
  const startMs0 = parseShanghai(semesterStart);
  if (!Number.isFinite(startMs0)) return null;
  const startMs = shanghaiWeekStartMs(startMs0);
  const currentMs = shanghaiWeekStartMs(date);
  if (!Number.isFinite(startMs) || !Number.isFinite(currentMs)) return null;
  const weeks = Math.floor((currentMs - startMs) / (7 * DAY_MS)) + 1;
  return weeks >= 1 ? weeks : null;
}
