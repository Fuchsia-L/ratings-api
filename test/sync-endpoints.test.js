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
