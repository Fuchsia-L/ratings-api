/**
 * v3 写端点：POST/PATCH/DELETE 课程与待办、单条读、token 权限矩阵、audit_log。
 *
 * 时区纪律同第一期：所有时刻都写显式偏移（+08:00 或 Z），断言不依赖 process.env.TZ。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  makeApp, auth, auditRows, scheduleEvent, todoItem,
  SYNC_TOKEN, READONLY_TOKEN, WRITE_TOKEN,
} from './helpers.js';
import { nextVersionTime } from '../schedule-write.js';

const WRITE = auth(WRITE_TOKEN);

test('版本戳在同毫秒和服务端时钟落后时仍严格递增', () => {
  const current = '2026-09-08T12:00:00.000Z';
  assert.equal(nextVersionTime(current, new Date(current)), '2026-09-08T12:00:00.001Z');
  assert.equal(nextVersionTime(current, new Date('2026-09-08T11:59:59.000Z')), '2026-09-08T12:00:00.001Z');
});

function post(app, url, payload, headers = WRITE) {
  return app.inject({ method: 'POST', url, headers, payload });
}
function patch(app, url, payload, headers = WRITE) {
  return app.inject({ method: 'PATCH', url, headers, payload });
}
function del(app, url, payload, headers = WRITE) {
  return app.inject({ method: 'DELETE', url, headers, payload });
}

/** 一节最小可用的课（服务端会补 created_at/updated_at/source）。 */
function newEvent(overrides = {}) {
  return {
    title: '线性代数',
    category: '学习',
    start_time: '2026-09-09T14:00:00.000+08:00',
    end_time: '2026-09-09T15:40:00.000+08:00',
    ...overrides,
  };
}

/* ================= POST 课程 ================= */

test('POST 课程：201 返回完整记录，服务端生成 id/时间戳/source', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const before = new Date().toISOString();
  const res = await post(app, '/v1/schedule/events', newEvent());
  assert.equal(res.statusCode, 201);

  const { record, server_time } = res.json();
  assert.ok(record.id, 'id 由服务端生成');
  assert.match(record.id, /^[0-9a-f-]{36}$/, 'UUID 形状');
  assert.equal(record.title, '线性代数');
  assert.equal(record.source, 'claude', 'source 缺省 claude');
  assert.equal(record.repeat, 'none', 'repeat 缺省 none');
  assert.equal(record.is_completed, false);
  assert.equal(record.deleted_at, null);
  assert.equal(record.synced_at, null);
  assert.equal(record.created_at, record.updated_at, '新建时两个时间戳相同');
  assert.ok(record.created_at >= before, '时间戳是服务端此刻');
  assert.ok(server_time);
});

test('POST 课程：caller 传的 id 生效，传的时间戳被服务端覆盖', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const res = await post(app, '/v1/schedule/events', newEvent({
    id: 'my-own-id',
    created_at: '1999-01-01T00:00:00.000Z',
    updated_at: '1999-01-01T00:00:00.000Z',
    synced_at: '1999-01-01T00:00:00.000Z',
    deleted_at: '1999-01-01T00:00:00.000Z',
  }));
  assert.equal(res.statusCode, 201);
  const { record } = res.json();
  assert.equal(record.id, 'my-own-id');
  assert.notEqual(record.created_at, '1999-01-01T00:00:00.000Z', 'created_at 归服务端');
  assert.notEqual(record.updated_at, '1999-01-01T00:00:00.000Z', 'updated_at 归服务端');
  assert.equal(record.synced_at, null, 'synced_at 不接受 caller 赋值');
  assert.equal(record.deleted_at, null, '不能靠 POST 直接建一条墓碑');
});

test('POST 课程：校验错 400', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const noTitle = await post(app, '/v1/schedule/events', newEvent({ title: '' }));
  assert.equal(noTitle.statusCode, 400);
  assert.match(noTitle.json().error, /title/);

  const badCategory = await post(app, '/v1/schedule/events', newEvent({ category: '摸鱼' }));
  assert.equal(badCategory.statusCode, 400);
  assert.match(badCategory.json().error, /category/);

  const badTime = await post(app, '/v1/schedule/events', newEvent({ start_time: '下午两点' }));
  assert.equal(badTime.statusCode, 400);
  assert.match(badTime.json().error, /start_time/);

  const badRepeat = await post(app, '/v1/schedule/events', newEvent({ repeat: 'monthly' }));
  assert.equal(badRepeat.statusCode, 400);
  assert.match(badRepeat.json().error, /repeat/);

  const badReminder = await post(app, '/v1/schedule/events', newEvent({ reminder_minutes: 7 }));
  assert.equal(badReminder.statusCode, 400);

  assert.equal(db.prepare('SELECT COUNT(*) c FROM schedule_events').get().c, 0, '一条都没写进去');
});

test('POST 课程：id 已存在 409 id_exists（含墓碑）', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const first = await post(app, '/v1/schedule/events', newEvent({ id: 'dup' }));
  assert.equal(first.statusCode, 201);

  const again = await post(app, '/v1/schedule/events', newEvent({ id: 'dup', title: '另一节' }));
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'id_exists');
  assert.equal(again.json().current_record.title, '线性代数', '原记录原样奉还');
});

/* ================= 冲突检测 ================= */

test('POST 课程：撞上同一天已有的课 → 409 conflict，带完整冲突事件', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/events', newEvent({
    id: 'existing', title: '已有的课',
    start_time: '2026-09-09T14:00:00.000+08:00',
    end_time: '2026-09-09T15:40:00.000+08:00',
  }));

  // 14:30-15:00 落在 14:00-15:40 里面
  const res = await post(app, '/v1/schedule/events', newEvent({
    title: '撞车的课',
    start_time: '2026-09-09T14:30:00.000+08:00',
    end_time: '2026-09-09T15:00:00.000+08:00',
  }));
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.error, 'conflict');
  assert.equal(body.conflicts.length, 1);
  assert.equal(body.conflicts[0].id, 'existing');
  assert.equal(body.conflicts[0].title, '已有的课');
  assert.ok(body.conflicts[0].instance_start, '冲突事件带实例时间，好让 CLI 说清撞的是哪一节');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM schedule_events').get().c, 1, '冲突时不落库');
});

test('POST 课程：撞上 weekly 重复课的展开实例 → 409', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  // 9/7 是周一，weekly 到年底：9/14、9/21… 都有课
  await post(app, '/v1/schedule/events', newEvent({
    id: 'weekly-math', title: '高等数学',
    start_time: '2026-09-07T08:00:00.000+08:00',
    end_time: '2026-09-07T09:40:00.000+08:00',
    repeat: 'weekly', repeat_until: '2026-12-31',
  }));

  // 母事件那天不撞，但撞 9/14 这个展开实例
  const res = await post(app, '/v1/schedule/events', newEvent({
    title: '临时讲座',
    start_time: '2026-09-14T09:00:00.000+08:00',
    end_time: '2026-09-14T10:00:00.000+08:00',
    repeat: 'none',
  }));
  assert.equal(res.statusCode, 409);
  const conflicts = res.json().conflicts;
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].id, 'weekly-math');
  assert.equal(
    conflicts[0].instance_start, '2026-09-14T08:00:00',
    '报的是 9/14 那个实例的时间（裸上海钟点），不是母事件 9/7 的时间',
  );
  // 写入时 +08:00 的输入已被规范化成裸上海格式存储（合约第 20 条）
  assert.equal(conflicts[0].start_time, '2026-09-07T08:00:00', '母事件时间保持母值');
});

test('POST 课程：weekly 重复课在 repeat_until 之后不再算冲突', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/events', newEvent({
    id: 'short-weekly', title: '短期课',
    start_time: '2026-09-07T08:00:00.000+08:00',
    end_time: '2026-09-07T09:40:00.000+08:00',
    repeat: 'weekly', repeat_until: '2026-09-10',
  }));

  // 9/14 已经超出 repeat_until，该时段是空的
  const res = await post(app, '/v1/schedule/events', newEvent({
    title: '之后的课',
    start_time: '2026-09-14T08:00:00.000+08:00',
    end_time: '2026-09-14T09:40:00.000+08:00',
  }));
  assert.equal(res.statusCode, 201, 'repeat_until 之后不该拦');
});

test('POST 课程：相邻不重叠（前一节结束 = 后一节开始）不算冲突', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/events', newEvent({
    id: 'morning',
    start_time: '2026-09-09T08:00:00.000+08:00',
    end_time: '2026-09-09T09:40:00.000+08:00',
  }));
  const res = await post(app, '/v1/schedule/events', newEvent({
    title: '紧接着的课',
    start_time: '2026-09-09T09:40:00.000+08:00',
    end_time: '2026-09-09T11:20:00.000+08:00',
  }));
  assert.equal(res.statusCode, 201, '边界相接不算重叠');
});

test('POST 课程：软删的课不参与冲突检测', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const created = await post(app, '/v1/schedule/events', newEvent({ id: 'gone' }));
  const updatedAt = created.json().record.updated_at;
  await del(app, '/v1/schedule/events/gone', { expected_updated_at: updatedAt });

  const res = await post(app, '/v1/schedule/events', newEvent({ title: '占用同一时段' }));
  assert.equal(res.statusCode, 201, '墓碑不该挡住新课');
});

/* ================= PATCH 课程 ================= */

test('PATCH 课程：部分字段 merge，200 返回新记录', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const created = await post(app, '/v1/schedule/events', newEvent({ id: 'e1', location: '教三 401' }));
  const { created_at, updated_at } = created.json().record;

  const res = await patch(app, '/v1/schedule/events/e1', {
    expected_updated_at: updated_at,
    title: '线性代数（改）',
    notes: '带书',
  });
  assert.equal(res.statusCode, 200);
  const record = res.json().record;
  assert.equal(record.title, '线性代数（改）');
  assert.equal(record.notes, '带书');
  assert.equal(record.location, '教三 401', '没提到的字段保持原样');
  assert.equal(record.created_at, created_at, 'created_at 不因 PATCH 改变');
  assert.ok(record.updated_at >= updated_at, 'updated_at 前进');
  assert.equal(record.synced_at, null, 'PATCH 后重置 synced_at，等 app 拉走');
});

test('PATCH 课程：显式传 null 清空可空字段', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const created = await post(app, '/v1/schedule/events', newEvent({ id: 'e1', location: '教三 401' }));
  const res = await patch(app, '/v1/schedule/events/e1', {
    expected_updated_at: created.json().record.updated_at,
    location: null,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().record.location, null);
});

test('PATCH 课程：expected_updated_at 不符 → 409 stale + current_record', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/events', newEvent({ id: 'e1' }));
  const res = await patch(app, '/v1/schedule/events/e1', {
    expected_updated_at: '2020-01-01T00:00:00.000Z',
    title: '想改但基于旧版本',
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.error, 'stale');
  assert.equal(body.current_record.title, '线性代数', '把当前记录给 caller，让它重新决策');
});

test('PATCH 课程：缺 expected_updated_at → 400', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/events', newEvent({ id: 'e1' }));
  const res = await patch(app, '/v1/schedule/events/e1', { title: '硬改' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /expected_updated_at/);
});

test('PATCH 课程：改时间撞车 → 409 conflict；不碰时间则不跑检测', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/events', newEvent({
    id: 'other', title: '别人的课',
    start_time: '2026-09-09T08:00:00.000+08:00',
    end_time: '2026-09-09T09:40:00.000+08:00',
  }));
  const mine = await post(app, '/v1/schedule/events', newEvent({ id: 'mine' }));
  let updatedAt = mine.json().record.updated_at;

  // 只改标题：即使 detectConflicts 跑起来也没事，这里断言的是它压根不该跑
  const titleOnly = await patch(app, '/v1/schedule/events/mine', {
    expected_updated_at: updatedAt, title: '改个名',
  });
  assert.equal(titleOnly.statusCode, 200);
  updatedAt = titleOnly.json().record.updated_at;

  // 把时间挪到别人的课上
  const moved = await patch(app, '/v1/schedule/events/mine', {
    expected_updated_at: updatedAt,
    start_time: '2026-09-09T09:00:00.000+08:00',
    end_time: '2026-09-09T09:30:00.000+08:00',
  });
  assert.equal(moved.statusCode, 409);
  assert.equal(moved.json().conflicts[0].id, 'other');
});

test('PATCH 课程：改时间不与自己旧版本冲突', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const created = await post(app, '/v1/schedule/events', newEvent({ id: 'solo' }));
  const res = await patch(app, '/v1/schedule/events/solo', {
    expected_updated_at: created.json().record.updated_at,
    start_time: '2026-09-09T14:10:00.000+08:00',
    end_time: '2026-09-09T15:50:00.000+08:00',
  });
  assert.equal(res.statusCode, 200, '自己跟自己不算冲突（detectConflicts 排除同 id）');
});

test('PATCH 课程：不存在或已软删 → 404', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const missing = await patch(app, '/v1/schedule/events/nope', {
    expected_updated_at: '2026-01-01T00:00:00.000Z', title: 'x',
  });
  assert.equal(missing.statusCode, 404);

  const created = await post(app, '/v1/schedule/events', newEvent({ id: 'e1' }));
  const updatedAt = created.json().record.updated_at;
  const deleted = await del(app, '/v1/schedule/events/e1', { expected_updated_at: updatedAt });
  const after = deleted.json().record.updated_at;

  const patchDeleted = await patch(app, '/v1/schedule/events/e1', {
    expected_updated_at: after, title: '改墓碑',
  });
  assert.equal(patchDeleted.statusCode, 404, '软删的记录当作不存在');
});

test('PATCH 课程：merge 后不合法 → 400', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const created = await post(app, '/v1/schedule/events', newEvent({ id: 'e1' }));
  const res = await patch(app, '/v1/schedule/events/e1', {
    expected_updated_at: created.json().record.updated_at,
    category: '不存在的分类',
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /category/);
});

/* ================= DELETE 课程 ================= */

test('DELETE 课程：软删返回 tombstone，day 查询里消失', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const created = await post(app, '/v1/schedule/events', newEvent({ id: 'e1' }));
  const updatedAt = created.json().record.updated_at;

  const dayBefore = await app.inject({ url: '/v1/schedule/day?date=2026-09-09', headers: auth() });
  assert.equal(dayBefore.json().events.length, 1);

  const res = await del(app, '/v1/schedule/events/e1', { expected_updated_at: updatedAt });
  assert.equal(res.statusCode, 200);
  const record = res.json().record;
  assert.ok(record.deleted_at, '墓碑带 deleted_at');
  assert.equal(record.deleted_at, record.updated_at, 'deleted_at 与 updated_at 同为此刻');
  assert.ok(record.updated_at > updatedAt);

  const dayAfter = await app.inject({ url: '/v1/schedule/day?date=2026-09-09', headers: auth() });
  assert.equal(dayAfter.json().events.length, 0, '软删后当天查不到');

  // 行还在库里，等 app 拉走墓碑
  assert.equal(db.prepare('SELECT COUNT(*) c FROM schedule_events').get().c, 1);
});

test('DELETE 课程：expected_updated_at 走 query 也认', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const created = await post(app, '/v1/schedule/events', newEvent({ id: 'e1' }));
  const updatedAt = encodeURIComponent(created.json().record.updated_at);
  const res = await app.inject({
    method: 'DELETE',
    url: `/v1/schedule/events/e1?expected_updated_at=${updatedAt}`,
    headers: WRITE,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().record.deleted_at);
});

test('DELETE 课程：stale 409 / 缺 expected 400 / 不存在 404 / 重复删 404', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const created = await post(app, '/v1/schedule/events', newEvent({ id: 'e1' }));
  const updatedAt = created.json().record.updated_at;

  const noExpected = await del(app, '/v1/schedule/events/e1', {});
  assert.equal(noExpected.statusCode, 400);

  const stale = await del(app, '/v1/schedule/events/e1', {
    expected_updated_at: '2020-01-01T00:00:00.000Z',
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, 'stale');
  assert.equal(stale.json().current_record.id, 'e1');

  const missing = await del(app, '/v1/schedule/events/nope', {
    expected_updated_at: updatedAt,
  });
  assert.equal(missing.statusCode, 404);

  const first = await del(app, '/v1/schedule/events/e1', { expected_updated_at: updatedAt });
  assert.equal(first.statusCode, 200);
  const again = await del(app, '/v1/schedule/events/e1', {
    expected_updated_at: first.json().record.updated_at,
  });
  assert.equal(again.statusCode, 404, '删两次第二次 404');
});

/* ================= 待办写端点 ================= */

test('POST 待办：201，缺省 type/priority，服务端时间戳', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const res = await post(app, '/v1/todos', { title: '交实验报告', last_reset: '2026-09-09' });
  assert.equal(res.statusCode, 201);
  const record = res.json().record;
  assert.ok(record.id);
  assert.equal(record.title, '交实验报告');
  assert.equal(record.type, 'daily');
  assert.equal(record.priority, 'medium');
  assert.equal(record.is_completed, false);
  assert.equal(record.created_at, record.updated_at);
});

test('POST 待办：显式 type/priority 生效，非法值 400', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const ok = await post(app, '/v1/todos', {
    title: '周报', type: 'weekly', priority: 'high', last_reset: '2026-09-09',
  });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().record.type, 'weekly');
  assert.equal(ok.json().record.priority, 'high');

  const badType = await post(app, '/v1/todos', { title: 'x', type: 'yearly', last_reset: '2026-09-09' });
  assert.equal(badType.statusCode, 400);
  assert.match(badType.json().error, /type/);

  const badPriority = await post(app, '/v1/todos', { title: 'x', priority: 'urgent', last_reset: '2026-09-09' });
  assert.equal(badPriority.statusCode, 400);
});

test('待办 PATCH/DELETE：同模式，无冲突检测', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const created = await post(app, '/v1/todos', {
    id: 't1', title: '刷线段树', type: 'daily', priority: 'high', last_reset: '2026-09-09',
  });
  assert.equal(created.statusCode, 201);
  const updatedAt = created.json().record.updated_at;

  const patched = await patch(app, '/v1/todos/t1', {
    expected_updated_at: updatedAt, is_completed: true, priority: 'low',
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().record.is_completed, true);
  assert.equal(patched.json().record.priority, 'low');
  assert.equal(patched.json().record.title, '刷线段树');
  assert.ok(patched.json().record.updated_at > updatedAt, '版本戳必须严格递增，即使两次写入发生在同一毫秒');

  const stale = await patch(app, '/v1/todos/t1', {
    expected_updated_at: updatedAt, title: '基于旧版',
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, 'stale');

  const removed = await del(app, '/v1/todos/t1', {
    expected_updated_at: patched.json().record.updated_at,
  });
  assert.equal(removed.statusCode, 200);
  assert.ok(removed.json().record.deleted_at);

  const day = await app.inject({ url: '/v1/schedule/day', headers: auth() });
  assert.equal(day.json().todos.length, 0, '软删的待办不出现在 day 里');

  const missing = await patch(app, '/v1/todos/nope', {
    expected_updated_at: '2026-01-01T00:00:00.000Z', title: 'x',
  });
  assert.equal(missing.statusCode, 404);
});

/* ================= 单条读 ================= */

test('GET 单条：课程与待办，含软删记录并标明', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const created = await post(app, '/v1/schedule/events', newEvent({ id: 'e1' }));
  const updatedAt = created.json().record.updated_at;

  const read = await app.inject({ url: '/v1/schedule/events/e1', headers: WRITE });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().record.id, 'e1');
  assert.equal(read.json().record.updated_at, updatedAt, 'CLI 靠这个拿 expected_updated_at');
  assert.equal(read.json().deleted, false);
  assert.ok(read.json().server_time);

  await del(app, '/v1/schedule/events/e1', { expected_updated_at: updatedAt });
  const readDeleted = await app.inject({ url: '/v1/schedule/events/e1', headers: WRITE });
  assert.equal(readDeleted.statusCode, 200, '软删记录仍可单条读');
  assert.equal(readDeleted.json().deleted, true, '标明这条已删');
  assert.ok(readDeleted.json().record.deleted_at);

  const missing = await app.inject({ url: '/v1/schedule/events/nope', headers: WRITE });
  assert.equal(missing.statusCode, 404);

  await post(app, '/v1/todos', { id: 't1', title: '待办', last_reset: '2026-09-09' });
  const todoRead = await app.inject({ url: '/v1/todos/t1', headers: WRITE });
  assert.equal(todoRead.statusCode, 200);
  assert.equal(todoRead.json().record.id, 't1');
  assert.equal(todoRead.json().deleted, false);
});

/* ================= token 权限矩阵 ================= */

test('权限矩阵：WRITE_TOKEN 可写可查，不可调同步端点', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  // 写端点：可以
  const created = await post(app, '/v1/schedule/events', newEvent({ id: 'e1' }));
  assert.equal(created.statusCode, 201);
  const updatedAt = created.json().record.updated_at;

  // 查询端点：可以
  assert.equal((await app.inject({ url: '/v1/schedule/day', headers: WRITE })).statusCode, 200);
  assert.equal((await app.inject({
    url: '/v1/schedule/window?start=2026-09-09&end=2026-09-10', headers: WRITE,
  })).statusCode, 200);

  // 单条读：可以
  assert.equal((await app.inject({ url: '/v1/schedule/events/e1', headers: WRITE })).statusCode, 200);
  assert.equal((await app.inject({ url: '/v1/todos/nope', headers: WRITE })).statusCode, 404, '404 而非 403');

  // 待办写端点：可以
  assert.equal((await post(app, '/v1/todos', { title: 'x', last_reset: '2026-09-09' })).statusCode, 201);
  assert.equal((await del(app, '/v1/schedule/events/e1', { expected_updated_at: updatedAt })).statusCode, 200);

  // 同步端点：403（认识这把钥匙，但这扇门不归它开）
  for (const url of ['/v1/schedule/sync', '/v1/todos/sync']) {
    const res = await post(app, url, { records: [] });
    assert.equal(res.statusCode, 403, `${url} 对 WRITE_TOKEN 应 403`);
    assert.equal(res.json().error, 'forbidden_for_write_token');
  }

  // ratings 端点与 app pull 端点：403
  for (const url of ['/v1/ratings', '/v1/schedule', '/v1/todos', '/v1/config/semester']) {
    const res = await app.inject({ url, headers: WRITE });
    assert.equal(res.statusCode, 403, `GET ${url} 对 WRITE_TOKEN 应 403`);
  }
});

test('权限矩阵：READONLY_TOKEN 调写端点 403', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const RO = auth(READONLY_TOKEN);
  const create = await post(app, '/v1/schedule/events', newEvent(), RO);
  assert.equal(create.statusCode, 403);
  assert.equal(create.json().error, 'forbidden_for_readonly_token');

  assert.equal((await patch(app, '/v1/schedule/events/e1', { title: 'x' }, RO)).statusCode, 403);
  assert.equal((await del(app, '/v1/schedule/events/e1', {}, RO)).statusCode, 403);
  assert.equal((await post(app, '/v1/todos', { title: 'x' }, RO)).statusCode, 403);
  // 单条读也不归只读 token（它只有 day/window 两扇门）
  assert.equal((await app.inject({ url: '/v1/schedule/events/e1', headers: RO })).statusCode, 403);
  // 老行为不变：查询端点照常
  assert.equal((await app.inject({ url: '/v1/schedule/day', headers: RO })).statusCode, 200);
});

test('权限矩阵：SYNC_TOKEN 全部可调；未知/缺失 token 401', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const SYNC = auth(SYNC_TOKEN);
  const created = await post(app, '/v1/schedule/events', newEvent({ id: 'e1' }), SYNC);
  assert.equal(created.statusCode, 201, 'SYNC_TOKEN 是全权 token');
  assert.equal((await app.inject({ url: '/v1/schedule/events/e1', headers: SYNC })).statusCode, 200);
  assert.equal((await post(app, '/v1/schedule/sync', { records: [] }, SYNC)).statusCode, 200);

  // 未知 token → 401（不是 403：403 留给"认识但无权"）
  const unknown = auth('totally-unknown-token-0123456789abcdefgh');
  assert.equal((await post(app, '/v1/schedule/events', newEvent(), unknown)).statusCode, 401);
  // 无 token → 401
  const bare = await app.inject({ method: 'POST', url: '/v1/schedule/events', payload: newEvent() });
  assert.equal(bare.statusCode, 401);
});

test('WRITE_TOKEN 未配置：写端点只认 SYNC_TOKEN，写 token 值变未知 → 401', async (t) => {
  const { app, db } = makeApp({ writeToken: undefined });
  t.after(() => { app.close(); db.close(); });

  const res = await post(app, '/v1/schedule/events', newEvent(), WRITE);
  assert.equal(res.statusCode, 401, '没配 WRITE_TOKEN 时那串值就是个未知 token');

  // 服务照常起，SYNC_TOKEN 仍可写
  const viaSync = await post(app, '/v1/schedule/events', newEvent(), auth(SYNC_TOKEN));
  assert.equal(viaSync.statusCode, 201);
  assert.equal((await app.inject({ url: '/v1/healthz' })).statusCode, 200);
});

test('WRITE_TOKEN 过短（<32）视为未配置', async (t) => {
  const { app, db } = makeApp({ writeToken: 'too-short' });
  t.after(() => { app.close(); db.close(); });

  const res = await post(app, '/v1/schedule/events', newEvent(), auth('too-short'));
  assert.equal(res.statusCode, 401);
});

/* ================= audit_log ================= */

test('audit：成功的写操作落行（created/updated/deleted）', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const created = await post(app, '/v1/schedule/events', newEvent({ id: 'e1' }));
  const v1 = created.json().record.updated_at;
  const patched = await patch(app, '/v1/schedule/events/e1', {
    expected_updated_at: v1, title: '改名',
  });
  await del(app, '/v1/schedule/events/e1', {
    expected_updated_at: patched.json().record.updated_at,
  });

  const rows = auditRows(db);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.outcome), ['created', 'updated', 'deleted']);
  assert.deepEqual(rows.map((r) => r.method), ['POST', 'PATCH', 'DELETE']);
  assert.ok(rows.every((r) => r.endpoint === '/v1/schedule/events'));
  assert.ok(rows.every((r) => r.record_id === 'e1'));
  assert.ok(rows.every((r) => r.token_kind === 'write'));
  assert.ok(rows.every((r) => r.ts && !Number.isNaN(Date.parse(r.ts))));
  assert.match(rows[0].payload_summary, /线性代数/, 'payload 摘要留了内容');
});

test('audit：失败的写操作同样落行（conflict/stale/validation_error/not_found）', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/events', newEvent({ id: 'existing' }));
  // conflict
  await post(app, '/v1/schedule/events', newEvent({ title: '撞车' }));
  // validation_error
  await post(app, '/v1/schedule/events', newEvent({ category: '摸鱼' }));
  // stale
  await patch(app, '/v1/schedule/events/existing', {
    expected_updated_at: '2020-01-01T00:00:00.000Z', title: 'x',
  });
  // not_found
  await del(app, '/v1/schedule/events/nope', { expected_updated_at: '2020-01-01T00:00:00.000Z' });

  const outcomes = auditRows(db).map((r) => r.outcome);
  assert.deepEqual(outcomes, ['created', 'conflict', 'validation_error', 'stale', 'not_found']);
});

test('audit：token_kind 区分 sync 与 write；GET 单条不落行', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/events', newEvent({ id: 'w1' }), WRITE);
  await post(app, '/v1/schedule/events', newEvent({
    id: 's1', start_time: '2026-09-10T14:00:00.000+08:00', end_time: '2026-09-10T15:00:00.000+08:00',
  }), auth(SYNC_TOKEN));
  await app.inject({ url: '/v1/schedule/events/w1', headers: WRITE });
  await app.inject({ url: '/v1/schedule/day', headers: WRITE });

  const rows = auditRows(db);
  assert.equal(rows.length, 2, '只有写端点落行，读端点不落');
  assert.deepEqual(rows.map((r) => r.token_kind), ['write', 'sync']);
});

test('audit：payload 摘要截断到 500 字符', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/events', newEvent({ notes: 'x'.repeat(480) }));
  const row = auditRows(db)[0];
  assert.equal(row.payload_summary.length, 500);
  assert.ok(row.payload_summary.endsWith('…'), '超长带省略号');
});

test('audit：同步端点与老 ratings 端点不落 audit 行', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/sync', { records: [scheduleEvent()] }, auth(SYNC_TOKEN));
  await post(app, '/v1/todos/sync', { records: [todoItem()] }, auth(SYNC_TOKEN));
  assert.equal(auditRows(db).length, 0, 'app 的批量同步不进 audit（那是手机日常动作，不是 Claude 的写）');
});

/* ================= 时区纪律 ================= */

test('写端点：时区无关（冲突判定按绝对时刻，不看进程 TZ）', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  // 同一时刻的两种写法：+08:00 与等价的 Z
  await post(app, '/v1/schedule/events', newEvent({
    id: 'shanghai',
    start_time: '2026-09-09T14:00:00.000+08:00',
    end_time: '2026-09-09T15:40:00.000+08:00',
  }));
  const res = await post(app, '/v1/schedule/events', newEvent({
    title: '同一时刻的 UTC 写法',
    start_time: '2026-09-09T06:00:00.000Z',
    end_time: '2026-09-09T07:40:00.000Z',
  }));
  assert.equal(res.statusCode, 409, '14:00+08 == 06:00Z，必须判为冲突');
  assert.equal(res.json().conflicts[0].id, 'shanghai');
});

test('写端点：跨午夜课程的冲突按绝对时刻算', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  await post(app, '/v1/schedule/events', newEvent({
    id: 'night', title: '夜间自习',
    start_time: '2026-09-09T23:00:00.000+08:00',
    end_time: '2026-09-10T01:00:00.000+08:00',
  }));
  const res = await post(app, '/v1/schedule/events', newEvent({
    title: '次日凌晨的课',
    start_time: '2026-09-10T00:30:00.000+08:00',
    end_time: '2026-09-10T02:00:00.000+08:00',
  }));
  assert.equal(res.statusCode, 409, '跨午夜的尾巴仍占着时间');
  assert.equal(res.json().conflicts[0].id, 'night');
});

/* ================= 与 app 同步的衔接 ================= */

test('Claude 写的课能被 app 的 since 拉取拿到（含墓碑）', async (t) => {
  const { app, db } = makeApp();
  t.after(() => { app.close(); db.close(); });

  const created = await post(app, '/v1/schedule/events', newEvent({ id: 'e1' }));
  const record = created.json().record;

  const pull = await app.inject({ url: '/v1/schedule', headers: auth(SYNC_TOKEN) });
  const pulled = pull.json().records.find((r) => r.id === 'e1');
  assert.ok(pulled, 'app 拉得到 Claude 建的课');
  assert.equal(pulled.source, 'claude');
  assert.equal(pulled.synced_at, null, '手机还没确认过');

  await del(app, '/v1/schedule/events/e1', { expected_updated_at: record.updated_at });
  const afterDelete = await app.inject({ url: '/v1/schedule', headers: auth(SYNC_TOKEN) });
  const tomb = afterDelete.json().records.find((r) => r.id === 'e1');
  assert.ok(tomb.deleted_at, 'app 能拉到墓碑，本地跟着删');
});
