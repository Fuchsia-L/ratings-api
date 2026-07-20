import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { buildSummary, parseSummaryDays } from '../summary.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ratings (
      id TEXT PRIMARY KEY, slot_start TEXT NOT NULL, slot_end TEXT NOT NULL,
      rating INTEGER NOT NULL, efficiency INTEGER NOT NULL,
      activity TEXT, reflection TEXT, deleted_at TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO ratings (id,slot_start,slot_end,rating,efficiency,activity,reflection,deleted_at)
    VALUES (@id,@slot_start,@slot_end,@rating,@efficiency,@activity,@reflection,@deleted_at)
  `);
  const rows = [
    { id: 'a', slot_start: '2026-07-20T01:00:00.000Z', slot_end: '2026-07-20T02:00:00.000Z', rating: 4, efficiency: 5, activity: '算法', reflection: '状态很好', deleted_at: null },
    { id: 'b', slot_start: '2026-07-19T07:00:00.000Z', slot_end: '2026-07-19T08:00:00.000Z', rating: 2, efficiency: 3, activity: '课程', reflection: null, deleted_at: null },
    { id: 'old', slot_start: '2026-06-01T01:00:00.000Z', slot_end: '2026-06-01T02:00:00.000Z', rating: 1, efficiency: 1, activity: '旧', reflection: '过期', deleted_at: null },
    { id: 'deleted', slot_start: '2026-07-20T03:00:00.000Z', slot_end: '2026-07-20T04:00:00.000Z', rating: 1, efficiency: 1, activity: '删除', reflection: '不应出现', deleted_at: '2026-07-20T05:00:00.000Z' },
  ];
  for (const row of rows) insert.run(row);
  return db;
}

test('summary only includes active rows inside its evidence window', () => {
  const db = fixture();
  const result = buildSummary(db, 7, new Date('2026-07-21T00:00:00.000Z'));
  assert.deepEqual(result.overall, { count: 2, avg_rating: 3, avg_efficiency: 4 });
  assert.equal(result.by_day.length, 2);
  assert.equal(result.by_weekday_period.length, 2);
  assert.deepEqual(result.recent_reflections.map((row) => row.reflection), ['状态很好']);
  db.close();
});

test('summary buckets timestamps in Asia/Shanghai', () => {
  const db = fixture();
  const result = buildSummary(db, 7, new Date('2026-07-21T00:00:00.000Z'));
  assert.equal(result.by_day.find((row) => row.date === '2026-07-20').count, 1);
  assert.equal(result.by_weekday_period.find((row) => row.period === 'morning').count, 1);
  assert.equal(result.by_weekday_period.find((row) => row.period === 'afternoon').count, 1);
  db.close();
});

test('only 7 and 28 day evidence windows are accepted', () => {
  assert.equal(parseSummaryDays(undefined), 7);
  assert.equal(parseSummaryDays('28'), 28);
  assert.equal(parseSummaryDays('21'), null);
});
