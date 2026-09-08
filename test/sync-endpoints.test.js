import assert from 'node:assert/strict';
import test from 'node:test';
import { makeApp, auth, scheduleEvent, todoItem } from './helpers.js';

async function post(app, url, payload, token) {
  return app.inject({ method: 'POST', url, headers: auth(token), payload });
}

/* ================= schedule/sync ================= */

test('schedule/sync 写入并回读', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const res = await post(app, '/v1/schedule/sync', { records: [scheduleEvent()] });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.applied, 1);
  assert.equal(body.rejected, 0);
  assert.equal(body.records.length, 1);
  assert.equal(body.records[0].title, '高等数学');
  assert.equal(body.records[0].is_completed, false, 'is_completed 还原为 boolean');
  assert.ok(body.server_time);
});

test('schedule/sync LWW：旧 updated_at 不覆盖新记录', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/sync', {
    records: [scheduleEvent({ title: '新版', updated_at: '2026-09-05T00:00:00.000Z' })],
  });
  const stale = await post(app, '/v1/schedule/sync', {
    records: [scheduleEvent({ title: '旧版', updated_at: '2026-09-01T00:00:00.000Z' })],
  });
  assert.equal(stale.json().applied, 0, '旧写入不计入 applied');
  assert.equal(stale.json().records[0].title, '新版');

  const newer = await post(app, '/v1/schedule/sync', {
    records: [scheduleEvent({ title: '更新版', updated_at: '2026-09-09T00:00:00.000Z' })],
  });
  assert.equal(newer.json().applied, 1);
  assert.equal(newer.json().records[0].title, '更新版');
});

test('schedule/sync tombstone 软删：deleted_at 保留并原样返回', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/sync', { records: [scheduleEvent()] });
  const del = await post(app, '/v1/schedule/sync', {
    records: [scheduleEvent({ updated_at: '2026-09-10T00:00:00.000Z', deleted_at: '2026-09-10T00:00:00.000Z' })],
  });
  assert.equal(del.json().applied, 1);
  assert.equal(del.json().records[0].deleted_at, '2026-09-10T00:00:00.000Z');
  // 拉取端点不 filter（对齐 ratings：全量返回让调用方决定）
  const pull = await app.inject({ url: '/v1/schedule', headers: auth() });
  assert.equal(pull.json().records.length, 1);
});

test('schedule/sync 校验拒绝：非法 category / repeat / reminder_minutes', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const res = await post(app, '/v1/schedule/sync', {
    records: [
      scheduleEvent({ id: 'bad-cat', category: '摸鱼' }),
      scheduleEvent({ id: 'bad-repeat', repeat: 'monthly' }),
      scheduleEvent({ id: 'bad-reminder', reminder_minutes: 7 }),
      scheduleEvent({ id: 'bad-until', repeat_until: '2026/12/31' }),
      scheduleEvent({ id: 'no-title', title: '' }),
      scheduleEvent({ id: 'ok' }),
    ],
  });
  const body = res.json();
  assert.equal(body.applied, 1);
  assert.equal(body.rejected, 5, '好记录仍然写入，坏的逐条进 rejected');
  const byId = Object.fromEntries(body.errors.map((e) => [e.id, e.error]));
  assert.match(byId['bad-cat'], /category/);
  assert.match(byId['bad-repeat'], /repeat/);
  assert.match(byId['bad-reminder'], /reminder_minutes/);
  assert.match(byId['bad-until'], /repeat_until/);
  assert.match(byId['no-title'], /title/);
  assert.equal(body.records.length, 1);
});

test('schedule/sync 接受 6 类 category 与 3 种 repeat', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const cats = ['学习', '工作', '生活', '运动', '娱乐', '其他'];
  const res = await post(app, '/v1/schedule/sync', {
    records: cats.map((c, i) => scheduleEvent({ id: `c${i}`, category: c, repeat: ['none', 'daily', 'weekly'][i % 3] })),
  });
  assert.equal(res.json().applied, 6);
  assert.equal(res.json().rejected, 0);
});

test('schedule/sync expected_updated_at stale → rejected 带 current_record', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/sync', { records: [scheduleEvent({ updated_at: '2026-09-05T00:00:00.000Z' })] });
  const res = await post(app, '/v1/schedule/sync', {
    records: [scheduleEvent({
      title: '抢改',
      updated_at: '2026-09-20T00:00:00.000Z',
      expected_updated_at: '1970-01-01T00:00:00.000Z',
    })],
  });
  const body = res.json();
  assert.equal(body.applied, 0);
  assert.equal(body.rejected, 1);
  assert.equal(body.errors[0].error, 'stale');
  assert.equal(body.errors[0].expected_updated_at, '1970-01-01T00:00:00.000Z');
  assert.equal(body.errors[0].current_record.updated_at, '2026-09-05T00:00:00.000Z');
  assert.equal(body.records[0].title, '高等数学', '原记录未被改');
});

test('schedule/sync expected_updated_at 命中时绕过 LWW（可写回更旧的 updated_at）', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/sync', { records: [scheduleEvent({ updated_at: '2026-09-05T00:00:00.000Z' })] });
  const res = await post(app, '/v1/schedule/sync', {
    records: [scheduleEvent({
      title: '回滚',
      updated_at: '2026-09-02T00:00:00.000Z',
      expected_updated_at: '2026-09-05T00:00:00.000Z',
    })],
  });
  assert.equal(res.json().applied, 1);
  assert.equal(res.json().records[0].title, '回滚');
});

test('schedule/sync expected_updated_at 针对不存在记录时须为 null 语义', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const res = await post(app, '/v1/schedule/sync', {
    records: [scheduleEvent({ expected_updated_at: '2026-09-01T00:00:00.000Z' })],
  });
  assert.equal(res.json().rejected, 1);
  assert.equal(res.json().errors[0].current_record, null);
});

test('schedule/sync since 参数只回增量', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await post(app, '/v1/schedule/sync', {
    records: [
      scheduleEvent({ id: 'old', updated_at: '2026-09-01T00:00:00.000Z' }),
      scheduleEvent({ id: 'new', updated_at: '2026-09-10T00:00:00.000Z' }),
    ],
  });
  const res = await post(app, '/v1/schedule/sync', { records: [], since: '2026-09-05T00:00:00.000Z' });
  assert.deepEqual(res.json().records.map((r) => r.id), ['new']);
});

test('schedule/sync records 非数组 → 400', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const res = await post(app, '/v1/schedule/sync', { records: 'nope' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'records must be array');
});

/* ================= todos/sync ================= */

test('todos/sync 写入、LWW、tombstone', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const first = await post(app, '/v1/todos/sync', { records: [todoItem()] });
  assert.equal(first.json().applied, 1);
  assert.equal(first.json().records[0].is_completed, false);

  const older = await post(app, '/v1/todos/sync', {
    records: [todoItem({ title: '旧', updated_at: '2026-08-01T00:00:00.000Z' })],
  });
  assert.equal(older.json().applied, 0);
  assert.equal(older.json().records[0].title, '刷 100 道线段树');

  const del = await post(app, '/v1/todos/sync', {
    records: [todoItem({ updated_at: '2026-09-11T00:00:00.000Z', deleted_at: '2026-09-11T00:00:00.000Z' })],
  });
  assert.equal(del.json().records[0].deleted_at, '2026-09-11T00:00:00.000Z');
});

test('todos/sync 校验拒绝非法 type / priority / 缺 last_reset', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const res = await post(app, '/v1/todos/sync', {
    records: [
      todoItem({ id: 'bad-type', type: 'monthly' }),
      todoItem({ id: 'bad-pri', priority: 'urgent' }),
      todoItem({ id: 'no-reset', last_reset: undefined }),
      todoItem({ id: 'ok' }),
    ],
  });
  const body = res.json();
  assert.equal(body.applied, 1);
  assert.equal(body.rejected, 3);
  const byId = Object.fromEntries(body.errors.map((e) => [e.id, e.error]));
  assert.match(byId['bad-type'], /type/);
  assert.match(byId['bad-pri'], /priority/);
  assert.match(byId['no-reset'], /last_reset/);
});

test('todos/sync expected_updated_at stale', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await post(app, '/v1/todos/sync', { records: [todoItem()] });
  const res = await post(app, '/v1/todos/sync', {
    records: [todoItem({ updated_at: '2026-09-30T00:00:00.000Z', expected_updated_at: 'wrong' })],
  });
  assert.equal(res.json().rejected, 1);
  assert.equal(res.json().errors[0].error, 'stale');
  assert.equal(res.json().errors[0].current_record.id, 'todo-1');
});

test('todos/sync 接受三种 type 与三种 priority', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const res = await post(app, '/v1/todos/sync', {
    records: [
      todoItem({ id: 'd', type: 'daily', priority: 'high' }),
      todoItem({ id: 'w', type: 'weekly', priority: 'medium' }),
      todoItem({ id: 'l', type: 'longterm', priority: 'low' }),
    ],
  });
  assert.equal(res.json().applied, 3);
  assert.equal(res.json().rejected, 0);
});

/* ================= app 真实 payload 形态对齐（逐字段审计产物） ================= */

test('payload 对齐: whut-import 生成的事件原样收下', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  // 逐字段照 klass2 whut-import.ts:150-161 + events.service.ts:59-65 的落库形态。
  // 注意 repeat_until / reminder_minutes 两个 key 压根不写 → wire 上缺席。
  const record = {
    id: 'whut-1',
    title: '卫星导航原理',
    category: '学习',                       // import 恒为「学习」
    start_time: '2026-09-08T08:00:00',      // buildDateTime：本地朴素，无毫秒无 Z
    end_time: '2026-09-08T09:40:00',
    repeat: 'none',
    location: '教三401',
    notes: '教师：张三\n周次：第1周、第2周\n节次：第1-2节',
    source: 'whut-import',
    is_completed: false,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    synced_at: null,                        // 显式 null（待推）
    deleted_at: null,                       // import 落库显式 null
    // 无 schema_version：schedule/todo 侧根本没这个字段
  };
  const res = await post(app, '/v1/schedule/sync', { records: [record] });
  assert.equal(res.json().rejected, 0, JSON.stringify(res.json().errors));
  assert.equal(res.json().applied, 1);
  const row = db.prepare("SELECT * FROM schedule_events WHERE id='whut-1'").get();
  assert.equal(row.start_time, '2026-09-08T08:00:00', '朴素时间原样（已是规范格式）');
  assert.equal(row.repeat_until, null, '缺席 → null');
  assert.equal(row.reminder_minutes, null, '缺席 → null');
  assert.equal(row.schema_version, 1, '服务端补默认值');
});

test('payload 对齐: location/notes 为 undefined 时 key 缺席也收下', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  // JSON.stringify 会丢掉值为 undefined 的键（app 侧 EventSheet 的 `.trim() || undefined`
  // 与 whut-import 的 item.location 都可能产出 undefined）
  const record = JSON.parse(JSON.stringify({
    id: 'no-loc', title: '自习', category: '学习',
    start_time: '2026-09-08T19:00:00', end_time: '2026-09-08T21:00:00',
    repeat: 'none', location: undefined, notes: undefined, reminder_minutes: undefined,
    repeat_until: undefined, source: 'manual', is_completed: false,
    created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
    synced_at: null, deleted_at: null,
  }));
  assert.ok(!('location' in record), 'undefined 的键确实消失了');
  const res = await post(app, '/v1/schedule/sync', { records: [record] });
  assert.equal(res.json().rejected, 0, JSON.stringify(res.json().errors));
  const row = db.prepare("SELECT * FROM schedule_events WHERE id='no-loc'").get();
  assert.equal(row.location, null);
  assert.equal(row.notes, null);
});

test('payload 对齐: deleted_at 三态（缺席／显式 null／墓碑）等价处理', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const mk = (id, patch) => {
    const r = { ...scheduleEvent({ id }), ...patch };
    if (patch.__omitDeleted) { delete r.deleted_at; delete r.__omitDeleted; }
    return r;
  };
  const res = await post(app, '/v1/schedule/sync', {
    records: [
      mk('absent', { __omitDeleted: true }),        // 懒升级老记录：键缺席
      mk('explicit-null', { deleted_at: null }),    // 新建路径：显式 null
      mk('tombstone', { deleted_at: '2026-09-02T00:00:00.000Z' }),
    ],
  });
  assert.equal(res.json().rejected, 0, JSON.stringify(res.json().errors));
  const get = (id) => db.prepare('SELECT deleted_at FROM schedule_events WHERE id=?').get(id).deleted_at;
  assert.equal(get('absent'), null, '缺席应与显式 null 等价（都算活跃）');
  assert.equal(get('explicit-null'), null);
  assert.equal(get('tombstone'), '2026-09-02T00:00:00.000Z');
  // 活跃判定用 IS NULL，两类记录不该分叉
  const active = db.prepare('SELECT id FROM schedule_events WHERE deleted_at IS NULL ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(active, ['absent', 'explicit-null']);
});

test('payload 对齐: app 不发 schema_version，服务端补 1', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  // klass2 的 schedule/todo 类型里根本没有 schema_version（只有 rating 有）
  const ev = scheduleEvent({ id: 'nosv' }); delete ev.schema_version;
  const td = todoItem({ id: 'nosv-t' }); delete td.schema_version;
  assert.equal((await post(app, '/v1/schedule/sync', { records: [ev] })).json().rejected, 0);
  assert.equal((await post(app, '/v1/todos/sync', { records: [td] })).json().rejected, 0);
  assert.equal(db.prepare("SELECT schema_version FROM schedule_events WHERE id='nosv'").get().schema_version, 1);
  assert.equal(db.prepare("SELECT schema_version FROM todos WHERE id='nosv-t'").get().schema_version, 1);
});

test('payload 对齐: 手动 UI 的 toISOString 与 whut-import 的朴素串归一到同一时刻', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  // 同一节「上海 14:00」的课，两条路径写出两种形态，混存同一张表
  await post(app, '/v1/schedule/sync', {
    records: [
      scheduleEvent({ id: 'ui', repeat: 'none', repeat_until: null,
        start_time: '2026-09-08T06:00:00.000Z', end_time: '2026-09-08T07:40:00.000Z' }),
      scheduleEvent({ id: 'import', repeat: 'none', repeat_until: null,
        start_time: '2026-09-08T14:00:00', end_time: '2026-09-08T15:40:00' }),
    ],
  });
  const rows = db.prepare('SELECT id, start_time FROM schedule_events ORDER BY id').all();
  assert.equal(rows.find((r) => r.id === 'ui').start_time, '2026-09-08T14:00:00');
  assert.equal(rows.find((r) => r.id === 'import').start_time, '2026-09-08T14:00:00');
});

test('payload 对齐: todo 懒升级产出的裸日期 updated_at 不被拒', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  // todo.storage.ts:44 把未校验格式的 created_at 复制进 updated_at，
  // 老记录可能是裸 '2025-03-01'。同步字段不做格式校验（与 ratings 一致），照收。
  const res = await post(app, '/v1/todos/sync', {
    records: [todoItem({ id: 'legacy', created_at: '2025-03-01', updated_at: '2025-03-01' })],
  });
  assert.equal(res.json().rejected, 0, JSON.stringify(res.json().errors));
  assert.equal(db.prepare("SELECT updated_at FROM todos WHERE id='legacy'").get().updated_at, '2025-03-01');
});

/* ================= config/semester ================= */

test('PUT /v1/config/semester 写入并可读回', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const res = await app.inject({
    method: 'PUT', url: '/v1/config/semester', headers: auth(),
    payload: { start_date: '2026-09-01', total_weeks: 18, updated_at: '2026-09-01T00:00:00.000Z' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().applied, true);

  const get = await app.inject({ url: '/v1/config/semester', headers: auth() });
  assert.deepEqual(get.json().semester, {
    start_date: '2026-09-01', total_weeks: 18, updated_at: '2026-09-01T00:00:00.000Z',
  });
});

test('PUT /v1/config/semester updated_at 新者胜', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const put = (payload) => app.inject({ method: 'PUT', url: '/v1/config/semester', headers: auth(), payload });

  await put({ start_date: '2026-09-01', total_weeks: 18, updated_at: '2026-09-05T00:00:00.000Z' });

  const older = await put({ start_date: '2026-02-01', total_weeks: 20, updated_at: '2026-09-01T00:00:00.000Z' });
  assert.equal(older.json().applied, false, '旧的不覆盖');
  assert.equal(older.json().semester.start_date, '2026-09-01');

  const newer = await put({ start_date: '2026-09-08', total_weeks: 16, updated_at: '2026-09-09T00:00:00.000Z' });
  assert.equal(newer.json().applied, true);
  assert.equal(newer.json().semester.start_date, '2026-09-08');
  assert.equal(newer.json().semester.total_weeks, 16);
});

test('PUT /v1/config/semester 校验', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const put = (payload) => app.inject({ method: 'PUT', url: '/v1/config/semester', headers: auth(), payload });

  assert.equal((await put({ start_date: '2026/09/01', total_weeks: 18, updated_at: 'x' })).statusCode, 400);
  assert.equal((await put({ start_date: '2026-09-01', total_weeks: 0, updated_at: 'x' })).statusCode, 400);
  assert.equal((await put({ start_date: '2026-09-01', total_weeks: 18 })).statusCode, 400);
});

test('PUT /v1/config/semester 接受 app 真实的 toISOString 格式（生产回归）', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  // app 设置页发的就是 new Date('2026-08-31').toISOString()
  // （klass2 useSettingsForm.ts）——老代码零改动，服务端负责收下并归一。
  const res = await app.inject({
    method: 'PUT', url: '/v1/config/semester', headers: auth(),
    payload: { start_date: '2026-08-31T00:00:00.000Z', total_weeks: 18, updated_at: '2026-08-31T00:00:00.000Z' },
  });
  assert.equal(res.statusCode, 200, 'app 的真实 payload 不该被 400 拒掉');
  assert.equal(res.json().applied, true);
  assert.equal(res.json().semester.start_date, '2026-08-31', '响应回归一后的值');
  // 库里落的也是裸日历日
  assert.equal(
    JSON.parse(db.prepare("SELECT value_json FROM config WHERE key='semester'").get().value_json).start_date,
    '2026-08-31',
  );
});

test('PUT /v1/config/semester 裸 YYYY-MM-DD 原样收下', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const res = await app.inject({
    method: 'PUT', url: '/v1/config/semester', headers: auth(),
    payload: { start_date: '2026-08-31', total_weeks: 18, updated_at: 'x' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().semester.start_date, '2026-08-31');
});

test('PUT /v1/config/semester zoned 跨日界按上海日历日归一', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  // 2026-08-31T20:00:00Z = 上海 2026-09-01 04:00 → 归到 9/1
  const res = await app.inject({
    method: 'PUT', url: '/v1/config/semester', headers: auth(),
    payload: { start_date: '2026-08-31T20:00:00Z', total_weeks: 18, updated_at: 'x' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().semester.start_date, '2026-09-01', 'zoned 按上海日历日，不是 UTC 日');
});

test('PUT /v1/config/semester naive datetime 取日期部分', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const res = await app.inject({
    method: 'PUT', url: '/v1/config/semester', headers: auth(),
    payload: { start_date: '2026-08-31T09:00:00', total_weeks: 18, updated_at: 'x' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().semester.start_date, '2026-08-31');
});

test('PUT /v1/config/semester 解析不了的 start_date 仍 400', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const put = (start_date) => app.inject({
    method: 'PUT', url: '/v1/config/semester', headers: auth(),
    payload: { start_date, total_weeks: 18, updated_at: 'x' },
  });
  for (const bad of ['2026/09/01', '不是日期', '', '九月一号', '2026-13-45T00:00:00.000Z']) {
    const res = await put(bad);
    assert.equal(res.statusCode, 400, `${JSON.stringify(bad)} 应被拒`);
    assert.match(res.json().error, /start_date/);
  }
  assert.equal((await put(20260901)).statusCode, 400, '非字符串也拒');
});

test('semester 归一后 day 的 semester_week 算得对（端到端）', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  // app 形态推入：学期从 2026-08-31（周一）起
  await app.inject({
    method: 'PUT', url: '/v1/config/semester', headers: auth(),
    payload: { start_date: '2026-08-31T00:00:00.000Z', total_weeks: 18, updated_at: 'x' },
  });
  const week = async (d) => (await app.inject({ url: `/v1/schedule/day?date=${d}`, headers: auth() })).json().semester_week;
  assert.equal(await week('2026-08-31'), 1, '开学当周');
  assert.equal(await week('2026-09-06'), 1, '同周周日');
  assert.equal(await week('2026-09-07'), 2, '下周一');
  assert.equal(await week('2026-08-30'), null, '开学前');
});

test('GET /v1/config/semester 未设置时返回 null', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  const res = await app.inject({ url: '/v1/config/semester', headers: auth() });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().semester, null);
});

/* ================= 纯拉取端点 ================= */

test('GET /v1/schedule 与 /v1/todos 支持 since', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });
  await post(app, '/v1/schedule/sync', {
    records: [
      scheduleEvent({ id: 'a', updated_at: '2026-09-01T00:00:00.000Z' }),
      scheduleEvent({ id: 'b', updated_at: '2026-09-10T00:00:00.000Z' }),
    ],
  });
  await post(app, '/v1/todos/sync', {
    records: [
      todoItem({ id: 'x', updated_at: '2026-09-01T00:00:00.000Z' }),
      todoItem({ id: 'y', updated_at: '2026-09-10T00:00:00.000Z' }),
    ],
  });
  const s = await app.inject({ url: '/v1/schedule?since=2026-09-05T00:00:00.000Z', headers: auth() });
  assert.deepEqual(s.json().records.map((r) => r.id), ['b']);
  const td = await app.inject({ url: '/v1/todos?since=2026-09-05T00:00:00.000Z', headers: auth() });
  assert.deepEqual(td.json().records.map((r) => r.id), ['y']);
});
