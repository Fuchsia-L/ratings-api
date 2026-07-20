const PERIOD_ORDER = ['morning', 'afternoon', 'evening', 'night'];

function round(value) {
  return value == null ? null : Math.round(Number(value) * 100) / 100;
}

export function parseSummaryDays(value) {
  const days = Number(value ?? 7);
  return days === 7 || days === 28 ? days : null;
}

/** 只读聚合评分。SQLite 将 ISO 时间归一到 UTC 后 +8h，按 Iris 的当地日/时段分桶。 */
export function buildSummary(db, days, now = new Date()) {
  if (days !== 7 && days !== 28) throw new Error('days must be 7 or 28');
  const end = now.toISOString();
  const start = new Date(now.getTime() - days * 86400000).toISOString();
  const params = { start, end };
  const activeWindow = `deleted_at IS NULL
    AND julianday(slot_start) >= julianday(@start)
    AND julianday(slot_start) < julianday(@end)`;

  const overallRow = db.prepare(`
    SELECT count(*) AS count, avg(rating) AS avg_rating, avg(efficiency) AS avg_efficiency
    FROM ratings WHERE ${activeWindow}
  `).get(params);

  const byDay = db.prepare(`
    SELECT date(datetime(slot_start, '+8 hours')) AS date,
           count(*) AS count, avg(rating) AS avg_rating, avg(efficiency) AS avg_efficiency
    FROM ratings WHERE ${activeWindow}
    GROUP BY date ORDER BY date
  `).all(params).map(normalizeAggregate);

  const byWeekdayPeriod = db.prepare(`
    SELECT CAST(strftime('%w', datetime(slot_start, '+8 hours')) AS INTEGER) AS weekday,
           CASE
             WHEN CAST(strftime('%H', datetime(slot_start, '+8 hours')) AS INTEGER) BETWEEN 5 AND 11 THEN 'morning'
             WHEN CAST(strftime('%H', datetime(slot_start, '+8 hours')) AS INTEGER) BETWEEN 12 AND 17 THEN 'afternoon'
             WHEN CAST(strftime('%H', datetime(slot_start, '+8 hours')) AS INTEGER) BETWEEN 18 AND 23 THEN 'evening'
             ELSE 'night'
           END AS period,
           count(*) AS count, avg(rating) AS avg_rating, avg(efficiency) AS avg_efficiency
    FROM ratings WHERE ${activeWindow}
    GROUP BY weekday, period
  `).all(params)
    .map(normalizeAggregate)
    .sort((a, b) => a.weekday - b.weekday || PERIOD_ORDER.indexOf(a.period) - PERIOD_ORDER.indexOf(b.period));

  const byActivity = db.prepare(`
    SELECT activity, count(*) AS count, avg(rating) AS avg_rating, avg(efficiency) AS avg_efficiency
    FROM ratings
    WHERE ${activeWindow} AND activity IS NOT NULL AND trim(activity) <> ''
    GROUP BY activity ORDER BY count DESC, activity LIMIT 12
  `).all(params).map(normalizeAggregate);

  const recentReflections = db.prepare(`
    SELECT datetime(slot_start, '+8 hours') AS local_time, activity, reflection
    FROM ratings
    WHERE ${activeWindow} AND reflection IS NOT NULL AND trim(reflection) <> ''
    ORDER BY julianday(slot_start) DESC LIMIT 5
  `).all(params);

  return {
    window: { days, start, end, timezone: 'Asia/Shanghai' },
    overall: normalizeAggregate(overallRow),
    by_day: byDay,
    by_weekday_period: byWeekdayPeriod,
    by_activity: byActivity,
    recent_reflections: recentReflections,
  };
}

function normalizeAggregate(row) {
  return { ...row, avg_rating: round(row.avg_rating), avg_efficiency: round(row.avg_efficiency) };
}
