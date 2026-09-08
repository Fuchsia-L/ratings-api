import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expandRepeatingEvents,
  detectConflicts,
  formatShanghaiDate,
  formatShanghaiDateTime,
  parseShanghai,
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
  // instance_* 现在是裸上海格式（合约第 20 条），母事件 start_time 仍是当初推进来的形态。
  assert.equal(expanded[0].instance_start, '2026-03-21T00:00:00');
  assert.equal(parseShanghai(expanded[0].instance_start), new Date(events[0].start_time).getTime(),
    '换算回绝对时刻应与母值一致');
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
  assert.equal(parseShanghai(expanded[0].instance_end), new Date(end).getTime());
  assert.equal(expanded[0].instance_end, '2026-03-22T01:00:00', '裸上海格式');
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
  // instance_* 是裸上海格式，日期部分直接就是本地日；
  // 对应的 UTC 时刻是 03-19T16:30Z，确认我们输出的不是 UTC。
  assert.equal(expanded[0].instance_start, '2026-03-20T00:30:00');
  assert.equal(new Date(parseShanghai(expanded[0].instance_start)).toISOString(), '2026-03-19T16:30:00.000Z');
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
  // 母值是带 Z 的 ISO（这个 fixture 如此），实例是裸上海格式 —— 指同一时刻。
  assert.equal(parseShanghai(expanded[0].instance_start), new Date(expanded[0].start_time).getTime());
  assert.equal(parseShanghai(expanded[0].instance_end), new Date(expanded[0].end_time).getTime());
  assert.equal(expanded[0].instance_start, '2026-03-19T16:00:00', '08:00Z = 上海 16:00');
});

/* ---------- 合约第 20 条：floating Asia/Shanghai 业务时间语义 ---------- */

test('parseShanghai: 裸格式按上海钟点解释，不看进程时区', () => {
  // 生产实测形态：whut-import 导入的真课表就是这个样子
  assert.equal(new Date(parseShanghai('2026-09-08T08:00:00')).toISOString(), '2026-09-08T00:00:00.000Z');
  // 若误用 new Date(裸串)，TZ=UTC 下会得到 08:00Z —— 正是把 14:00 的课显示成 22:00 的根源
  assert.notEqual(parseShanghai('2026-09-08T08:00:00'), Date.UTC(2026, 8, 8, 8, 0, 0));
});

test('parseShanghai: 四种输入形态归一到同一时刻', () => {
  const expected = Date.UTC(2026, 8, 8, 6, 0, 0); // 上海 14:00 = 06:00Z
  assert.equal(parseShanghai('2026-09-08T14:00:00'), expected, '裸格式');
  assert.equal(parseShanghai('2026-09-08T06:00:00Z'), expected, '带 Z');
  assert.equal(parseShanghai('2026-09-08T14:00:00+08:00'), expected, '带 offset');
  assert.equal(parseShanghai('2026-09-08T14:00:00.000'), expected, '裸格式带毫秒');
  assert.equal(parseShanghai('2026-09-08T06:00:00.000Z'), expected, '带 Z 带毫秒');
  assert.equal(parseShanghai('2026-09-08T15:00:00+09:00'), expected, '别的时区偏移');
});

test('formatShanghaiDateTime: 各种输入都规范化成裸上海格式', () => {
  assert.equal(formatShanghaiDateTime('2026-09-08T06:00:00Z'), '2026-09-08T14:00:00', '带 Z → 上海钟点');
  assert.equal(formatShanghaiDateTime('2026-09-08T14:00:00+08:00'), '2026-09-08T14:00:00', '带 offset');
  assert.equal(formatShanghaiDateTime('2026-09-08T14:00:00'), '2026-09-08T14:00:00', '裸格式原样');
  assert.equal(formatShanghaiDateTime('2026-09-08T14:00:00.500'), '2026-09-08T14:00:00', '毫秒被抹平');
  assert.equal(formatShanghaiDateTime('2026-09-08T15:00:00+09:00'), '2026-09-08T14:00:00', '换算别的时区');
  assert.equal(formatShanghaiDateTime('不是时间'), null, '解析不了返回 null');
});

test('parseShanghai: 纯日期按上海当日 00:00', () => {
  assert.equal(new Date(parseShanghai('2026-09-08')).toISOString(), '2026-09-07T16:00:00.000Z');
});

test('parseShanghai: 拒绝会被 Date.UTC 静默滚动的非法日期和钟点', () => {
  for (const value of [
    '2026-02-30',
    '2026-02-30T14:00:00',
    '2026-09-08T25:00:00',
    '2026-09-08T14:60:00',
    '2026-09-08T14:00:60',
  ]) {
    assert.ok(Number.isNaN(parseShanghai(value)), `${value} 应被拒绝`);
  }
});

test('生产回归：上海 14:00 的课不会被平移成 22:00', () => {
  // Iris 真实数据形态：卫星导航原理 start_time: 2026-09-08T08:00:00（真实是上海 8 点）
  const events = [createRepeatingEvent({
    id: 'satnav', title: '卫星导航原理', repeat: 'none',
    start_time: '2026-09-08T14:00:00',
    end_time: '2026-09-08T15:40:00',
  })];
  const expanded = expandRepeatingEvents(
    events, shanghaiDayStart('2026-09-08'), shanghaiDayEnd('2026-09-08'),
  );
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].instance_start, '2026-09-08T14:00:00', '显示就是 14:00，不是 22:00');
  assert.equal(expanded[0].instance_end, '2026-09-08T15:40:00');
});

test('混合格式：裸 / 带 Z / 带 offset / 带毫秒的课在同一天并存且排序正确', () => {
  const events = [
    createRepeatingEvent({ id: 'naive', repeat: 'none', start_time: '2026-09-08T14:00:00', end_time: '2026-09-08T15:00:00' }),
    createRepeatingEvent({ id: 'zulu', repeat: 'none', start_time: '2026-09-08T00:00:00Z', end_time: '2026-09-08T01:00:00Z' }),
    createRepeatingEvent({ id: 'offset', repeat: 'none', start_time: '2026-09-08T10:00:00+08:00', end_time: '2026-09-08T11:00:00+08:00' }),
    createRepeatingEvent({ id: 'millis', repeat: 'none', start_time: '2026-09-08T12:00:00.250', end_time: '2026-09-08T13:00:00.750' }),
  ];
  const expanded = expandRepeatingEvents(
    events, shanghaiDayStart('2026-09-08'), shanghaiDayEnd('2026-09-08'),
  );
  expanded.sort((a, b) => a.instance_start.localeCompare(b.instance_start));
  assert.deepEqual(
    expanded.map((e) => [e.id, e.instance_start]),
    [
      ['zulu', '2026-09-08T08:00:00'],    // 00:00Z = 上海 08:00
      ['offset', '2026-09-08T10:00:00'],
      ['millis', '2026-09-08T12:00:00'],
      ['naive', '2026-09-08T14:00:00'],
    ],
  );
});

test('混合格式：跨午夜课（裸格式）归到起始本地日', () => {
  const events = [createRepeatingEvent({
    id: 'night', repeat: 'daily', repeat_until: '2026-09-09',
    start_time: '2026-09-08T23:00:00',
    end_time: '2026-09-09T01:00:00',
  })];
  const expanded = expandRepeatingEvents(
    events, shanghaiDayStart('2026-09-08'), shanghaiDayEnd('2026-09-10'),
  );
  assert.deepEqual(
    expanded.map((e) => e.instance_start),
    ['2026-09-08T23:00:00', '2026-09-09T23:00:00'],
  );
  // 每节都跨本地午夜，且 repeat_until 按本地日卡
  assert.equal(expanded[0].instance_end, '2026-09-09T01:00:00');
});

test('repeat_until 对裸格式课程按上海本地日生效', () => {
  const events = [createRepeatingEvent({
    id: 'late', repeat: 'daily', repeat_until: '2026-09-09',
    start_time: '2026-09-08T23:30:00',
    end_time: '2026-09-08T23:59:00',
  })];
  const expanded = expandRepeatingEvents(
    events, shanghaiDayStart('2026-09-08'), shanghaiDayEnd('2026-09-12'),
  );
  // 本地 9/8、9/9 两节；若按 UTC 日判定（15:30Z / 9-8）会多放一节
  assert.deepEqual(expanded.map((e) => e.instance_start.slice(0, 10)), ['2026-09-08', '2026-09-09']);
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
