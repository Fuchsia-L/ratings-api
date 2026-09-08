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

/** ISO 字符串或 Date → epoch ms。 */
function toMs(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
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

function withInstance(event, startMs, endMs) {
  return {
    ...event,
    instance_start: new Date(startMs).toISOString(),
    instance_end: new Date(endMs).toISOString(),
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
  const startInput = /^\d{4}-\d{2}-\d{2}$/.test(semesterStart)
    ? shanghaiDayStart(semesterStart)
    : new Date(semesterStart);
  const startMs = shanghaiWeekStartMs(startInput);
  const currentMs = shanghaiWeekStartMs(date);
  if (!Number.isFinite(startMs) || !Number.isFinite(currentMs)) return null;
  const weeks = Math.floor((currentMs - startMs) / (7 * DAY_MS)) + 1;
  return weeks >= 1 ? weeks : null;
}
