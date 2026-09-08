import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expandRepeatingEvents,
  detectConflicts,
  formatShanghaiDate,
  getSemesterWeek,
  shanghaiDayStart,
  shanghaiDayEnd,
  shanghaiToday,
  shanghaiWeekday,
} from '../schedule-domain.js';

/**
 * klass2 src/features/schedule/domain/repeat.test.ts 的服务端复刻。
 * app 用例里 `new Date(2026, 2, 21, ...)` 走的是运行环境本地时区；
 * 服务端钉死 Asia/Shanghai，因此那几处改写成显式 +08:00 时刻，语义等同「手机在国内」。
 */
function createRepeatingEvent(overrides = {}) {
  return {
    id: overrides.id ?? 'event-1',
    title: overrides.title ?? 'Repeating Event',
    category: overrides.category ?? '学习',
    start_time: overrides.start_time ?? '2026-03-19T08:00:00.000Z',
    end_time: overrides.end_time ?? '2026-03-19T09:00:00.000Z',
    repeat: overrides.repeat ?? 'daily',
    repeat_until: overrides.repeat_until,
    is_completed: overrides.is_completed ?? false,
  };
}

const days = (expanded) => expanded.map((e) => e.instance_start.slice(0, 10));

/* ---------- repeat.test.ts 全部 8 个用例 ---------- */

test('expands daily events until the repeat_until date inclusively', () => {
  const events = [createRepeatingEvent({ repeat: 'daily', repeat_until: '2026-03-21' })];
  const expanded = expandRepeatingEvents(
    events,
    new Date('2026-03-19T00:00:00.000Z'),
    new Date('2026-03-25T23:59:59.999Z'),
  );
  assert.deepEqual(days(expanded), ['2026-03-19', '2026-03-20', '2026-03-21']);
});

test('expands weekly events on the same weekday without exceeding repeat_until', () => {
  const events = [createRepeatingEvent({ repeat: 'weekly', repeat_until: '2026-04-02' })];
  const expanded = expandRepeatingEvents(
    events,
    new Date('2026-03-19T00:00:00.000Z'),
    new Date('2026-04-10T23:59:59.999Z'),
  );
  assert.deepEqual(days(expanded), ['2026-03-19', '2026-03-26', '2026-04-02']);
});

test('keeps daily events without repeat_until on the original expansion behavior', () => {
  const events = [createRepeatingEvent({ repeat: 'daily' })];
  const expanded = expandRepeatingEvents(
    events,
    new Date('2026-03-19T00:00:00.000Z'),
    new Date('2026-03-22T23:59:59.999Z'),
  );
  assert.deepEqual(days(expanded), ['2026-03-19', '2026-03-20', '2026-03-21', '2026-03-22']);
});

test('keeps weekly events without repeat_until on the original expansion behavior', () => {
  const events = [createRepeatingEvent({ repeat: 'weekly' })];
  const expanded = expandRepeatingEvents(
    events,
    new Date('2026-03-19T00:00:00.000Z'),
    new Date('2026-04-09T23:59:59.999Z'),
  );
  assert.deepEqual(days(expanded), ['2026-03-19', '2026-03-26', '2026-04-02', '2026-04-09']);
});

test('includes exactly one instance when repeat_until matches the start date', () => {
  // app: new Date(2026, 2, 21, 0, 0) —— 手机本地 3/21 00:00，服务端写成 +08:00
  const start = '2026-03-21T00:00:00.000+08:00';
  const end = '2026-03-21T01:00:00.000+08:00';
  const events = [createRepeatingEvent({
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    repeat: 'daily',
    repeat_until: '2026-03-21',
  })];
  const expanded = expandRepeatingEvents(events, new Date(start), new Date('2026-03-25T23:59:59.999+08:00'));
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].instance_start, events[0].start_time);
});

test('returns no instances when repeat_until is before the visible range', () => {
  const events = [createRepeatingEvent({ repeat: 'daily', repeat_until: '2026-03-20' })];
  const expanded = expandRepeatingEvents(
    events,
    new Date('2026-03-22T00:00:00.000Z'),
    new Date('2026-03-25T23:59:59.999Z'),
  );
  assert.deepEqual(expanded, []);
});

test('stops weekly expansion when repeat_until falls between recurrence dates', () => {
  const events = [createRepeatingEvent({ repeat: 'weekly', repeat_until: '2026-03-30' })];
  const expanded = expandRepeatingEvents(
    events,
    new Date('2026-03-19T00:00:00.000Z'),
    new Date('2026-04-10T23:59:59.999Z'),
  );
  assert.deepEqual(days(expanded), ['2026-03-19', '2026-03-26']);
});

test('includes an instance that starts on repeat_until even if it ends after midnight', () => {
  const start = '2026-03-21T23:00:00.000+08:00';
  const end = '2026-03-22T01:00:00.000+08:00';
  const events = [createRepeatingEvent({
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    repeat: 'daily',
    repeat_until: '2026-03-21',
  })];
  const expanded = expandRepeatingEvents(
    events,
    new Date('2026-03-21T00:00:00.000+08:00'),
    new Date('2026-03-22T23:59:59.999+08:00'),
  );
  assert.equal(expanded.length, 1);
  assert.equal(new Date(expanded[0].instance_end).getTime(), new Date(end).getTime());
});

/* ---------- 时区专项（设计 §6 验收要求） ---------- */

test('timezone: 跨午夜课程按 Asia/Shanghai 归日，不被 UTC 进程时区拆错', () => {
  // 23:00-01:00 (+08) = UTC 15:00-17:00 同一 UTC 日，但本地跨午夜。
  const events = [createRepeatingEvent({
    id: 'night',
    start_time: '2026-03-19T23:00:00.000+08:00',
    end_time: '2026-03-20T01:00:00.000+08:00',
    repeat: 'daily',
    repeat_until: '2026-03-21',
  })];
  const expanded = expandRepeatingEvents(
    events,
    shanghaiDayStart('2026-03-19'),
    shanghaiDayEnd('2026-03-25'),
  );
  // 本地日 3/19、3/20、3/21 各一节；repeat_until=3/21 卡在本地日而不是 UTC 日。
  assert.deepEqual(
    expanded.map((e) => formatShanghaiDate(e.instance_start)),
    ['2026-03-19', '2026-03-20', '2026-03-21'],
  );
  // 每节都跨本地午夜
  for (const inst of expanded) {
    assert.notEqual(formatShanghaiDate(inst.instance_start), formatShanghaiDate(inst.instance_end));
  }
});

test('timezone: repeat_until 边界日在 UTC 与 +08 分属不同日期时以 +08 为准', () => {
  // 本地 3/22 00:30 = UTC 3/21 16:30。若误按 UTC 日判定会被 repeat_until=2026-03-21 放行。
  const events = [createRepeatingEvent({
    id: 'edge',
    start_time: '2026-03-20T00:30:00.000+08:00',
    end_time: '2026-03-20T01:30:00.000+08:00',
    repeat: 'daily',
    repeat_until: '2026-03-21',
  })];
  const expanded = expandRepeatingEvents(
    events,
    shanghaiDayStart('2026-03-20'),
    shanghaiDayEnd('2026-03-25'),
  );
  assert.deepEqual(
    expanded.map((e) => formatShanghaiDate(e.instance_start)),
    ['2026-03-20', '2026-03-21'],
  );
  // UTC 日会是 03-19/03-20，确认我们没走 UTC
  assert.equal(expanded[0].instance_start.slice(0, 10), '2026-03-19');
});

test('timezone: 周界（周日→周一）按 Asia/Shanghai 计算 weekday 与学期周', () => {
  // 本地 2026-03-23 00:30 周一 = UTC 2026-03-22 16:30 周日
  const mondayEarly = new Date('2026-03-23T00:30:00.000+08:00');
  assert.equal(shanghaiWeekday(mondayEarly), 1, '本地是周一');
  assert.equal(new Date(mondayEarly).getUTCDay(), 0, 'UTC 那边还是周日');

  // 学期从 2026-03-16（周一）起算：本地周一 3/23 属第 2 周。
  assert.equal(getSemesterWeek('2026-03-16', mondayEarly), 2);
  // 本地周日 3/22 23:30 仍属第 1 周（周界不能提前跳）
  assert.equal(getSemesterWeek('2026-03-16', new Date('2026-03-22T23:30:00.000+08:00')), 1);
});

test('timezone: 展开区间边界用 Asia/Shanghai 自然日', () => {
  const events = [createRepeatingEvent({
    id: 'morning',
    start_time: '2026-03-19T07:00:00.000+08:00',
    end_time: '2026-03-19T08:00:00.000+08:00',
    repeat: 'weekly',
  })];
  const expanded = expandRepeatingEvents(
    events,
    shanghaiDayStart('2026-03-19'),
    shanghaiDayEnd('2026-03-19'),
  );
  assert.equal(expanded.length, 1);
  assert.equal(formatShanghaiDate(expanded[0].instance_start), '2026-03-19');
});

test('母事件 start_time/end_time 在实例上保持母值不变', () => {
  const events = [createRepeatingEvent({ repeat: 'daily', repeat_until: '2026-03-21' })];
  const expanded = expandRepeatingEvents(
    events,
    new Date('2026-03-19T00:00:00.000Z'),
    new Date('2026-03-25T23:59:59.999Z'),
  );
  for (const inst of expanded) {
    assert.equal(inst.start_time, '2026-03-19T08:00:00.000Z');
    assert.equal(inst.end_time, '2026-03-19T09:00:00.000Z');
    assert.equal(inst.id, 'event-1');
  }
  assert.notEqual(expanded[1].instance_start, expanded[1].start_time);
});

test('非重复事件也带 instance_start/instance_end', () => {
  const events = [createRepeatingEvent({ repeat: 'none' })];
  const expanded = expandRepeatingEvents(
    events,
    new Date('2026-03-19T00:00:00.000Z'),
    new Date('2026-03-25T23:59:59.999Z'),
  );
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].instance_start, expanded[0].start_time);
  assert.equal(expanded[0].instance_end, expanded[0].end_time);
});

/* ---------- Asia/Shanghai 辅助函数 ---------- */

test('formatShanghaiDate 不依赖进程时区', () => {
  assert.equal(formatShanghaiDate('2026-03-19T16:00:00.000Z'), '2026-03-20');
  assert.equal(formatShanghaiDate('2026-03-19T15:59:59.999Z'), '2026-03-19');
});

test('shanghaiToday 返回 +08 的今天', () => {
  assert.equal(shanghaiToday(new Date('2026-09-07T16:00:00.000Z')), '2026-09-08');
  assert.equal(shanghaiToday(new Date('2026-09-07T15:59:00.000Z')), '2026-09-07');
});

test('getSemesterWeek 与 app calendar.ts 语义一致', () => {
  // 学期起始 2026-09-01（周二），其所在周的周一是 2026-08-31。
  assert.equal(getSemesterWeek('2026-09-01', shanghaiDayStart('2026-09-01')), 1);
  assert.equal(getSemesterWeek('2026-09-01', shanghaiDayStart('2026-09-06')), 1, '同周周日仍是第 1 周');
  assert.equal(getSemesterWeek('2026-09-01', shanghaiDayStart('2026-09-07')), 2, '下周一进第 2 周');
  assert.equal(getSemesterWeek('2026-09-01', shanghaiDayStart('2026-08-30')), null, '开学前返回 null');
});

/* ---------- conflicts 移植（v3 才开端点，先单测锁住） ---------- */

test('detectConflicts 抓到重叠的重复课', () => {
  const existing = createRepeatingEvent({
    id: 'weekly-class',
    start_time: '2026-03-19T08:00:00.000+08:00',
    end_time: '2026-03-19T10:00:00.000+08:00',
    repeat: 'weekly',
  });
  const candidate = createRepeatingEvent({
    id: 'new-one',
    start_time: '2026-03-26T09:00:00.000+08:00',
    end_time: '2026-03-26T11:00:00.000+08:00',
    repeat: 'none',
  });
  const conflicts = detectConflicts(candidate, [existing, candidate]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].id, 'weekly-class');
});

test('detectConflicts 对相邻不重叠返回空', () => {
  const existing = createRepeatingEvent({
    id: 'a',
    start_time: '2026-03-19T08:00:00.000+08:00',
    end_time: '2026-03-19T10:00:00.000+08:00',
    repeat: 'none',
  });
  const candidate = createRepeatingEvent({
    id: 'b',
    start_time: '2026-03-19T10:00:00.000+08:00',
    end_time: '2026-03-19T11:00:00.000+08:00',
    repeat: 'none',
  });
  assert.deepEqual(detectConflicts(candidate, [existing, candidate]), []);
});

test('detectConflicts 忽略候选自身', () => {
  const candidate = createRepeatingEvent({ id: 'self', repeat: 'weekly' });
  assert.deepEqual(detectConflicts(candidate, [candidate]), []);
});
