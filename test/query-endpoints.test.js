import assert from 'node:assert/strict';
import test from 'node:test';
import { makeApp, auth, scheduleEvent, todoItem, insertRating, READONLY_TOKEN, SYNC_TOKEN } from './helpers.js';
import { shanghaiToday } from '../schedule-domain.js';
import { buildApp } from '../app.js';

async function seed(app, { events = [], todos = [], semester } = {}) {
  if (events.length) {
    const r = await app.inject({ method: 'POST', url: '/v1/schedule/sync', headers: auth(), payload: { records: events } });
    assert.equal(r.json().rejected, 0, `seed events rejected: ${JSON.stringify(r.json().errors)}`);
  }
  if (todos.length) {
    const r = await app.inject({ method: 'POST', url: '/v1/todos/sync', headers: auth(), payload: { records: todos } });
    assert.equal(r.json().rejected, 0, `seed todos rejected: ${JSON.stringify(r.json().errors)}`);
  }
  if (semester) {
    await app.inject({ method: 'PUT', url: '/v1/config/semester', headers: auth(), payload: semester });
  }
}

const day = (app, date, token) =>
  app.inject({ url: date ? `/v1/schedule/day?date=${date}` : '/v1/schedule/day', headers: auth(token) });

const win = (app, start, end, token) =>
  app.inject({ url: `/v1/schedule/window?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, headers: auth(token) });

/* ================= /v1/schedule/day ================= */

test('day: 响应结构逐字段符合设计 §3', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, {
    events: [scheduleEvent()],
    todos: [todoItem()],
    semester: { start_date: '2026-09-01', total_weeks: 18, updated_at: '2026-09-01T00:00:00.000Z' },
  });

  const res = await day(app, '2026-09-07');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    Object.keys(body).sort(),
    ['date', 'events', 'last_synced', 'semester_week', 'server_time', 'todos', 'weekday'],
  );
  assert.equal(body.date, '2026-09-07');
  assert.equal(body.weekday, 1, '2026-09-07 是周一');
  assert.equal(body.semester_week, 2);
  assert.equal(body.events.length, 1);
  assert.equal(body.todos.length, 1);
  // last_synced 是服务端记的「最后一次收到同步请求」，不是记录里的 synced_at。
  // seed 刚推过，所以两个都该是刚才那一瞬。
  assert.ok(body.last_synced.schedule, 'schedule 推过就该有值');
  assert.ok(body.last_synced.todos, 'todos 推过就该有值');
  assert.ok(Date.now() - Date.parse(body.last_synced.schedule) < 60_000, 'last_synced 应是刚刚');
  assert.ok(body.server_time);
});

test('day: 重复课在后续周正确展开，母值不变', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, { events: [scheduleEvent()] });

  // 母事件在 9/7（周一），weekly → 9/14、9/21 也该有
  for (const [date, instDate] of [['2026-09-07', '2026-09-07'], ['2026-09-14', '2026-09-14'], ['2026-09-21', '2026-09-21']]) {
    const body = (await day(app, date)).json();
    assert.equal(body.events.length, 1, `${date} 应有一节课`);
    const e = body.events[0];
    assert.equal(e.id, 'evt-1', '实例继承母事件 id');
    assert.equal(e.start_time, '2026-09-07T08:00:00', '母值保持不变（裸上海格式）');
    assert.equal(e.end_time, '2026-09-07T09:40:00');
    // 实例时间同为裸上海格式，直读就是本地钟点
    assert.equal(e.instance_start, `${instDate}T08:00:00`);
    assert.equal(e.instance_end, `${instDate}T09:40:00`);
  }
  // 周二没课
  assert.equal((await day(app, '2026-09-08')).json().events.length, 0);
});

test('day: repeat_until 之后不再出现', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, { events: [scheduleEvent({ repeat_until: '2026-09-14' })] });
  assert.equal((await day(app, '2026-09-14')).json().events.length, 1);
  assert.equal((await day(app, '2026-09-21')).json().events.length, 0);
});

test('day: 软删的课程与待办不出现', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, {
    events: [
      scheduleEvent({ id: 'live' }),
      scheduleEvent({ id: 'dead', deleted_at: '2026-09-02T00:00:00.000Z' }),
    ],
    todos: [
      todoItem({ id: 't-live' }),
      todoItem({ id: 't-dead', deleted_at: '2026-09-02T00:00:00.000Z' }),
    ],
  });
  const body = (await day(app, '2026-09-07')).json();
  assert.deepEqual(body.events.map((e) => e.id), ['live']);
  assert.deepEqual(body.todos.map((t2) => t2.id), ['t-live']);
});

test('day: ratings 关联按 linked_event_id + 实例时间', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, { events: [scheduleEvent()] });

  // 9/7 那节课上的评分
  insertRating(db, {
    id: 'r1', linked_event_id: 'evt-1',
    slot_start: '2026-09-07T08:00:00.000+08:00', slot_end: '2026-09-07T09:40:00.000+08:00',
    rating: 4, efficiency: 5, mood: '清醒', activity: '高数', reflection: '听懂了',
  });
  // 9/14 那节课上的评分
  insertRating(db, {
    id: 'r2', linked_event_id: 'evt-1',
    slot_start: '2026-09-14T08:00:00.000+08:00', slot_end: '2026-09-14T09:40:00.000+08:00',
    rating: 2, efficiency: 2,
  });
  // 别的事件的评分，不该串台
  insertRating(db, {
    id: 'r3', linked_event_id: 'other-event',
    slot_start: '2026-09-07T08:00:00.000+08:00', slot_end: '2026-09-07T09:00:00.000+08:00',
    rating: 5, efficiency: 5,
  });
  // 软删的评分不算
  insertRating(db, {
    id: 'r4', linked_event_id: 'evt-1',
    slot_start: '2026-09-07T08:30:00.000+08:00', slot_end: '2026-09-07T09:00:00.000+08:00',
    rating: 1, efficiency: 1, deleted_at: '2026-09-08T00:00:00.000Z',
  });

  const d7 = (await day(app, '2026-09-07')).json();
  assert.equal(d7.events[0].ratings.length, 1);
  assert.deepEqual(Object.keys(d7.events[0].ratings[0]).sort(), [
    'activity', 'efficiency', 'mood', 'rating', 'reflection', 'slot_end', 'slot_start',
  ]);
  assert.equal(d7.events[0].ratings[0].rating, 4);
  assert.equal(d7.events[0].ratings[0].reflection, '听懂了');

  const d14 = (await day(app, '2026-09-14')).json();
  assert.equal(d14.events[0].ratings.length, 1);
  assert.equal(d14.events[0].ratings[0].rating, 2, '9/14 的实例只拿到自己那天的评分');
});

test('day: date 缺省 = Asia/Shanghai 今天', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const res = await day(app, null);
  assert.equal(res.json().date, shanghaiToday(new Date()));
});

test('day: 非法 date → 400', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  assert.equal((await day(app, '2026-9-7')).statusCode, 400);
  assert.equal((await day(app, 'today')).statusCode, 400);
  assert.equal((await day(app, '2026-02-30')).statusCode, 400);
});

test('day: 无学期配置时 semester_week 为 null', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, { events: [scheduleEvent()] });
  assert.equal((await day(app, '2026-09-07')).json().semester_week, null);
});

test('day: 开学前 semester_week 为 null，开学第一周为 1', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, { semester: { start_date: '2026-09-01', total_weeks: 18, updated_at: '2026-09-01T00:00:00.000Z' } });
  assert.equal((await day(app, '2026-08-25')).json().semester_week, null);
  assert.equal((await day(app, '2026-09-01')).json().semester_week, 1);
  assert.equal((await day(app, '2026-09-06')).json().semester_week, 1, '同周周日仍第 1 周');
  assert.equal((await day(app, '2026-09-07')).json().semester_week, 2);
});

test('day: 跨午夜课程归到 Asia/Shanghai 起始日', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, {
    events: [scheduleEvent({
      id: 'night', title: '夜间自习', repeat: 'none', repeat_until: null,
      start_time: '2026-09-07T23:00:00',
      end_time: '2026-09-08T01:00:00',
    })],
  });
  assert.equal((await day(app, '2026-09-07')).json().events.length, 1, '起始日有');
  assert.equal((await day(app, '2026-09-08')).json().events.length, 1, '结束日也覆盖（跨日重叠）');
  assert.equal((await day(app, '2026-09-09')).json().events.length, 0);
});

test('day: events 按实例开始时间排序', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, {
    events: [
      scheduleEvent({ id: 'pm', repeat: 'none', repeat_until: null, start_time: '2026-09-07T14:00:00', end_time: '2026-09-07T15:00:00' }),
      scheduleEvent({ id: 'am', repeat: 'none', repeat_until: null, start_time: '2026-09-07T08:00:00', end_time: '2026-09-07T09:00:00' }),
    ],
  });
  assert.deepEqual((await day(app, '2026-09-07')).json().events.map((e) => e.id), ['am', 'pm']);
});

/* ---------- 合约第 20 条：业务时间 floating Asia/Shanghai（生产 bug 回归） ---------- */

test('时区: 裸格式推「上海 14:00」的课，day 里就是 14:00', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  // Iris 真机数据形态：app 推裸本地钟点，无 Z 无毫秒
  await seed(app, {
    events: [scheduleEvent({
      id: 'cpp', title: 'C++', repeat: 'none', repeat_until: null,
      start_time: '2026-09-08T14:00:00', end_time: '2026-09-08T15:40:00',
    })],
  });
  const e = (await day(app, '2026-09-08')).json().events[0];
  assert.equal(e.instance_start, '2026-09-08T14:00:00', '不能被平移成 22:00');
  assert.equal(e.instance_end, '2026-09-08T15:40:00');
  assert.equal(e.start_time, '2026-09-08T14:00:00', '母值也是裸上海格式');
});

test('时区: 带 Z 的 06:00Z 推入，day 里显示上海 14:00', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, {
    events: [scheduleEvent({
      id: 'zulu', repeat: 'none', repeat_until: null,
      start_time: '2026-09-08T06:00:00Z', end_time: '2026-09-08T07:40:00Z',
    })],
  });
  const e = (await day(app, '2026-09-08')).json().events[0];
  assert.equal(e.instance_start, '2026-09-08T14:00:00');
  assert.equal(e.start_time, '2026-09-08T14:00:00', '入库时已规范化成裸上海格式');
});

test('时区: 带 offset 与带毫秒的输入同样规范化', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, {
    events: [
      scheduleEvent({ id: 'off', repeat: 'none', repeat_until: null,
        start_time: '2026-09-08T14:00:00+08:00', end_time: '2026-09-08T15:00:00+08:00' }),
      scheduleEvent({ id: 'ms', repeat: 'none', repeat_until: null,
        start_time: '2026-09-08T16:00:00.250', end_time: '2026-09-08T17:00:00.750' }),
      scheduleEvent({ id: 'jst', repeat: 'none', repeat_until: null,
        start_time: '2026-09-08T19:00:00+09:00', end_time: '2026-09-08T20:00:00+09:00' }),
    ],
  });
  const events = (await day(app, '2026-09-08')).json().events;
  assert.deepEqual(
    events.map((e) => [e.id, e.instance_start]),
    [['off', '2026-09-08T14:00:00'], ['ms', '2026-09-08T16:00:00'], ['jst', '2026-09-08T18:00:00']],
  );
  // 库里存的也是规范化后的裸格式
  assert.equal(db.prepare("SELECT start_time FROM schedule_events WHERE id='jst'").get().start_time,
    '2026-09-08T18:00:00');
});

test('时区: repeat_until / last_reset 带时区输入被规范化成上海自然日', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, {
    events: [scheduleEvent({ id: 'ru', repeat_until: '2026-09-14T16:00:00Z' })],
    todos: [todoItem({ id: 'lr', last_reset: '2026-09-07T16:00:00Z' })],
  });
  // 16:00Z = 上海次日 00:00 → 归到 09-15 / 09-08
  assert.equal(db.prepare("SELECT repeat_until FROM schedule_events WHERE id='ru'").get().repeat_until, '2026-09-15');
  assert.equal(db.prepare("SELECT last_reset FROM todos WHERE id='lr'").get().last_reset, '2026-09-08');
});

test('时区: 同步字段仍是真 UTC ISO，没被业务规范化碰到', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, { events: [scheduleEvent()] });
  const row = db.prepare("SELECT * FROM schedule_events WHERE id='evt-1'").get();
  assert.equal(row.created_at, '2026-09-01T00:00:00.000Z', 'created_at 原样');
  assert.equal(row.updated_at, '2026-09-01T00:00:00.000Z', 'updated_at 原样');
  assert.equal(row.start_time, '2026-09-07T08:00:00', '业务时间才是裸格式');
});

test('时区: window 用裸格式参数查询，回显也是裸上海格式', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, {
    events: [scheduleEvent({ id: 'cpp', repeat: 'none', repeat_until: null,
      start_time: '2026-09-08T14:00:00', end_time: '2026-09-08T15:40:00' })],
  });
  const body = (await win(app, '2026-09-08T14:30:00', '2026-09-08T14:30:00')).json();
  assert.equal(body.events.length, 1, '裸格式时间点应命中正在上的课');
  assert.equal(body.start, '2026-09-08T14:30:00');
  assert.equal(body.events[0].instance_start, '2026-09-08T14:00:00');
  // 带 Z 的等价时刻应得到同样结果
  const zulu = (await win(app, '2026-09-08T06:30:00Z', '2026-09-08T06:30:00Z')).json();
  assert.equal(zulu.events.length, 1, '06:30Z = 上海 14:30，同样命中');
  assert.equal(zulu.start, '2026-09-08T14:30:00');
});

test('时区: 裸格式课程与 UTC 评分正确关联', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, {
    events: [scheduleEvent({ id: 'cpp', repeat: 'none', repeat_until: null,
      start_time: '2026-09-08T14:00:00', end_time: '2026-09-08T15:40:00' })],
  });
  // ratings.slot_* 是真 UTC：上海 14:00 = 06:00Z
  insertRating(db, {
    id: 'r1', linked_event_id: 'cpp',
    slot_start: '2026-09-08T06:00:00.000Z', slot_end: '2026-09-08T07:40:00.000Z',
    rating: 5, efficiency: 4,
  });
  const e = (await day(app, '2026-09-08')).json().events[0];
  assert.equal(e.ratings.length, 1, '跨语义比较应对上');
  assert.equal(e.ratings[0].rating, 5);
});

/* ---------- last_synced（数据新鲜度）语义 ---------- */

test('last_synced: 一次都没推过时为 null', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  assert.deepEqual((await day(app, '2026-09-07')).json().last_synced, { schedule: null, todos: null });
});

test('last_synced: 记录里 synced_at 全为 null 也照样有值（合约缺陷回归）', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  // app 推 pending 记录时 synced_at 恒为 null —— 服务端永远看不到非 null 值。
  // 老实现照 max(synced_at) 算，这里会是 null；新实现记的是服务端观测到的推送时刻。
  await seed(app, {
    events: [scheduleEvent({ synced_at: null })],
    todos: [todoItem({ synced_at: null })],
  });
  const ls = (await day(app, '2026-09-07')).json().last_synced;
  assert.ok(ls.schedule, 'synced_at 为 null 也该有 last_synced.schedule');
  assert.ok(ls.todos, 'synced_at 为 null 也该有 last_synced.todos');
});

test('last_synced: 推空 records 也刷新（app 活着就是新鲜）', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await app.inject({ method: 'POST', url: '/v1/schedule/sync', headers: auth(), payload: { records: [] } });
  const first = (await day(app, '2026-09-07')).json().last_synced;
  assert.ok(first.schedule, '空 records 的纯拉取调用也该刷新');
  assert.equal(first.todos, null, 'todos 还没推过，仍是 null');

  await new Promise((r) => setTimeout(r, 5));
  await app.inject({ method: 'POST', url: '/v1/schedule/sync', headers: auth(), payload: { records: [] } });
  const second = (await day(app, '2026-09-07')).json().last_synced;
  assert.ok(second.schedule >= first.schedule, '再推一次应前进');

  await app.inject({ method: 'POST', url: '/v1/todos/sync', headers: auth(), payload: { records: [] } });
  assert.ok((await day(app, '2026-09-07')).json().last_synced.todos, 'todos 空推后也该有值');
});

test('last_synced: schedule 与 todos 各记各的', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, { events: [scheduleEvent()] });
  const ls = (await day(app, '2026-09-07')).json().last_synced;
  assert.ok(ls.schedule);
  assert.equal(ls.todos, null, '只推了课程，待办那栏不该被带上');
});

test('last_synced: 整批被拒也算推过（app 确实来过）', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const res = await app.inject({
    method: 'POST', url: '/v1/schedule/sync', headers: auth(),
    payload: { records: [scheduleEvent({ category: '不存在' })] },
  });
  assert.equal(res.json().rejected, 1);
  assert.ok((await day(app, '2026-09-07')).json().last_synced.schedule);
});

test('last_synced: 400 的坏请求不刷新', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const res = await app.inject({
    method: 'POST', url: '/v1/schedule/sync', headers: auth(), payload: { records: 'nope' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal((await day(app, '2026-09-07')).json().last_synced.schedule, null,
    '请求格式就不对，不能算一次成功同步');
});

test('last_synced: window 响应同样带上', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, { events: [scheduleEvent()], todos: [todoItem()] });
  const ls = (await win(app, '2026-09-07', '2026-09-14')).json().last_synced;
  assert.ok(ls.schedule);
  assert.ok(ls.todos);
});

test('last_synced: 跨重启持久（写进库，不是内存）', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, { events: [scheduleEvent()] });
  const before = (await day(app, '2026-09-07')).json().last_synced.schedule;

  // 同一个 db 上重建一个 app 实例，模拟进程重启
  const app2 = buildApp({ db, syncToken: SYNC_TOKEN, readonlyToken: READONLY_TOKEN, logger: false });
  t.after(() => app2.close());
  const after = (await app2.inject({ url: '/v1/schedule/day?date=2026-09-07', headers: auth() })).json().last_synced.schedule;
  assert.equal(after, before, '重启后仍读得到');
});

test('last_synced: 不从 GET /v1/config/semester 漏出去', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, {
    events: [scheduleEvent()],
    todos: [todoItem()],
    semester: { start_date: '2026-09-01', total_weeks: 18, updated_at: '2026-09-01T00:00:00.000Z' },
  });
  const body = (await app.inject({ url: '/v1/config/semester', headers: auth() })).json();
  assert.deepEqual(Object.keys(body.semester).sort(), ['start_date', 'total_weeks', 'updated_at']);
  assert.ok(!JSON.stringify(body).includes('last_push'), 'config 端点不该带出 last_push_*');
  // config 表里也不该混进 meta 的 key
  const configKeys = db.prepare('SELECT key FROM config').all().map((r) => r.key);
  assert.deepEqual(configKeys, ['semester']);
});

/* ================= /v1/schedule/window ================= */

test('window: 展开区间内全部实例', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, { events: [scheduleEvent()] });
  const body = (await win(app, '2026-09-07', '2026-09-28')).json();
  assert.deepEqual(
    body.events.map((e) => e.instance_start.slice(0, 10)),
    ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'],
  );
  assert.equal(body.events.length, 4);
});

test('window: 时间点查询 start=end 命中正在上的课', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, { events: [scheduleEvent()] });
  const hit = await win(app, '2026-09-07T08:30:00.000+08:00', '2026-09-07T08:30:00.000+08:00');
  assert.equal(hit.json().events.length, 1);
  const miss = await win(app, '2026-09-07T12:00:00.000+08:00', '2026-09-07T12:00:00.000+08:00');
  assert.equal(miss.json().events.length, 0);
});

test('window: 超过 62 天 → 400', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const ok = await win(app, '2026-09-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'); // 61 天
  assert.equal(ok.statusCode, 200);
  const edge = await win(app, '2026-09-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z'); // 62 天整
  assert.equal(edge.statusCode, 200, '62 天整应放行');
  const over = await win(app, '2026-09-01T00:00:00.000Z', '2026-11-02T00:00:00.001Z');
  assert.equal(over.statusCode, 400);
  assert.match(over.json().error, /62 days/);
});

test('window: 缺参数 / 顺序颠倒 / 非法时间 → 400', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  assert.equal((await app.inject({ url: '/v1/schedule/window?end=2026-09-08', headers: auth() })).statusCode, 400);
  assert.equal((await app.inject({ url: '/v1/schedule/window?start=2026-09-08', headers: auth() })).statusCode, 400);
  assert.equal((await win(app, '2026-09-10', '2026-09-01')).statusCode, 400);
  assert.equal((await win(app, 'garbage', '2026-09-01')).statusCode, 400);
  assert.equal((await win(app, '2026-02-30', '2026-03-01')).statusCode, 400);
});

test('window: ratings 关联同 day', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, { events: [scheduleEvent()] });
  insertRating(db, {
    id: 'r1', linked_event_id: 'evt-1',
    slot_start: '2026-09-14T08:00:00.000+08:00', slot_end: '2026-09-14T09:40:00.000+08:00',
    rating: 3, efficiency: 3,
  });
  const body = (await win(app, '2026-09-07', '2026-09-21')).json();
  const rated = body.events.filter((e) => e.ratings.length > 0);
  assert.equal(rated.length, 1);
  assert.equal(rated[0].ratings[0].rating, 3);
});

test('window: YYYY-MM-DD 参数按 Asia/Shanghai 自然日边界解读', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, {
    events: [scheduleEvent({
      id: 'late', repeat: 'none', repeat_until: null,
      start_time: '2026-09-07T23:30:00',
      end_time: '2026-09-07T23:59:00',
    })],
  });
  assert.equal((await win(app, '2026-09-07', '2026-09-07')).json().events.length, 1);
});

/* ================= token 分级矩阵 ================= */

test('token 矩阵：READONLY_TOKEN 只开两个查询端点', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await seed(app, { events: [scheduleEvent()] });

  // 允许
  assert.equal((await day(app, '2026-09-07', READONLY_TOKEN)).statusCode, 200);
  assert.equal((await win(app, '2026-09-07', '2026-09-14', READONLY_TOKEN)).statusCode, 200);

  // 禁止：同步端点
  for (const url of ['/v1/schedule/sync', '/v1/todos/sync', '/v1/ratings/sync']) {
    const res = await app.inject({ method: 'POST', url, headers: auth(READONLY_TOKEN), payload: { records: [] } });
    assert.equal(res.statusCode, 403, `${url} 应 403`);
    assert.equal(res.json().error, 'forbidden_for_readonly_token');
  }
  // 禁止：拉取与配置端点
  for (const url of ['/v1/schedule', '/v1/todos', '/v1/ratings', '/v1/config/semester']) {
    assert.equal((await app.inject({ url, headers: auth(READONLY_TOKEN) })).statusCode, 403, `${url} 应 403`);
  }
  assert.equal((await app.inject({
    method: 'PUT', url: '/v1/config/semester', headers: auth(READONLY_TOKEN),
    payload: { start_date: '2026-09-01', total_weeks: 18, updated_at: 'x' },
  })).statusCode, 403);
  // 禁止：internal
  assert.equal((await app.inject({ url: '/internal/summary?days=7', headers: auth(READONLY_TOKEN) })).statusCode, 401);
});

test('token 矩阵：SYNC_TOKEN 通吃全部 /v1', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  for (const url of ['/v1/ratings', '/v1/schedule', '/v1/todos', '/v1/config/semester', '/v1/schedule/day']) {
    assert.equal((await app.inject({ url, headers: auth() })).statusCode, 200, url);
  }
  assert.equal((await win(app, '2026-09-07', '2026-09-14')).statusCode, 200);
});

test('token 矩阵：无 token / 错 token 一律 401', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  for (const url of ['/v1/schedule/day', '/v1/schedule', '/v1/ratings']) {
    assert.equal((await app.inject({ url })).statusCode, 401, `${url} 无 token`);
    assert.equal((await app.inject({ url, headers: auth('wrong-token-wrong-token-wrong-token') })).statusCode, 401);
    assert.equal((await app.inject({ url, headers: { authorization: 'Basic xyz' } })).statusCode, 401);
  }
});

test('token 矩阵：healthz 不需要 token', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const res = await app.inject({ url: '/v1/healthz' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test('token 矩阵：未配置 READONLY_TOKEN 时只读端点只认 SYNC_TOKEN（不 fatal）', async (t) => {
  const { app, db } = makeApp({ readonlyToken: undefined });
  t.after(() => { app.close(); db.close(); });
  assert.equal((await day(app, '2026-09-07', READONLY_TOKEN)).statusCode, 401);
  assert.equal((await day(app, '2026-09-07')).statusCode, 200, 'SYNC_TOKEN 仍可查');
});

test('token 矩阵：带 query string 的 URL 也正确路由鉴权', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  assert.equal((await app.inject({ url: '/v1/schedule/day?date=2026-09-07', headers: auth(READONLY_TOKEN) })).statusCode, 200);
  assert.equal((await app.inject({ url: '/v1/schedule?since=2026-01-01', headers: auth(READONLY_TOKEN) })).statusCode, 403);
});

/* ================= ratings 行为零变化 ================= */

test('ratings 端点行为不变：sync + LWW + stale', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const rating = (o = {}) => ({
    id: 'r1', slot_start: '2026-09-07T08:00:00.000Z', slot_end: '2026-09-07T09:00:00.000Z',
    rating: 4, efficiency: 4, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
    schema_version: 1, ...o,
  });
  const post = (payload) => app.inject({ method: 'POST', url: '/v1/ratings/sync', headers: auth(), payload });

  assert.equal((await post({ records: [rating()] })).json().applied, 1);
  assert.equal((await post({ records: [rating({ rating: 1, updated_at: '2026-08-01T00:00:00.000Z' })] })).json().applied, 0);
  const bad = await post({ records: [rating({ id: 'bad', rating: 9 })] });
  assert.equal(bad.json().rejected, 1);
  assert.match(bad.json().errors[0].error, /rating must be 1-5/);
  const stale = await post({ records: [rating({ updated_at: '2026-10-01T00:00:00.000Z', expected_updated_at: 'nope' })] });
  assert.equal(stale.json().errors[0].error, 'stale');
  assert.equal((await post({ records: 'x' })).statusCode, 400);
});
