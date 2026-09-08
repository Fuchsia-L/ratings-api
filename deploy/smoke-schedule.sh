#!/usr/bin/env bash
# 课程/待办同步 + 查询端点的本地端到端烟测。
# 自己起一个临时 server（临时 SQLite + 测试 token），推数据、查 day/window、断言、清理。
#
#   bash deploy/smoke-schedule.sh
#
# 可选：PORT=3999 指定端口；NODE=/path/to/node 指定 node。
set -euo pipefail

cd "$(dirname "$0")/.."

NODE="${NODE:-node}"
PORT="${PORT:-3987}"
HOST="http://127.0.0.1:$PORT"
SYNC_TOKEN="smoke-sync-token-0123456789abcdefghij"
READONLY_TOKEN="smoke-readonly-token-0123456789abcdefg"
WRITE_TOKEN="smoke-write-token-0123456789abcdefghij"
TMPDIR_SMOKE="$(mktemp -d)"
SERVER_PID=""

say()  { printf '\n\033[36m>> %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m   ok\033[0m\n'; }
die()  { printf '\033[31m   FAIL: %s\033[0m\n' "$*"; exit 1; }

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMPDIR_SMOKE"
}
trap cleanup EXIT

# 用 python3 从 stdin 的 JSON 里取值（该机 python3 标准库可用）。
# 参数是一段以 d 为根的 python 表达式，例如 "d['date']" 或 "len(d['events'])"。
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1"; }

sync_hdr=(-H "Authorization: Bearer $SYNC_TOKEN" -H 'Content-Type: application/json')
ro_hdr=(-H "Authorization: Bearer $READONLY_TOKEN")
write_hdr=(-H "Authorization: Bearer $WRITE_TOKEN" -H 'Content-Type: application/json')

say "启动临时 server (port $PORT, db in $TMPDIR_SMOKE)"
SYNC_TOKEN="$SYNC_TOKEN" READONLY_TOKEN="$READONLY_TOKEN" WRITE_TOKEN="$WRITE_TOKEN" \
  PORT="$PORT" DB_PATH="$TMPDIR_SMOKE/smoke.db" LOG_LEVEL=warn \
  "$NODE" server.js &
SERVER_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS "$HOST/v1/healthz" >/dev/null 2>&1; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || die "server 进程已退出"
  sleep 0.25
done
curl -fsS "$HOST/v1/healthz" | grep -q '"ok":true' || die "healthz 没起来"
ok

# 固定用一个已知的周一做基准日，避免烟测结果随今天漂移。
MONDAY="2026-09-07"
NOW="2026-09-01T00:00:00.000Z"

say "推 3 门课（含 weekly 重复 + 跨午夜）"
curl -fsS -X POST "${sync_hdr[@]}" -d @- "$HOST/v1/schedule/sync" <<EOF | jget "d['applied']" | grep -qx 3 || die "课程同步 applied != 3"
{"records":[
 {"id":"smoke-math","title":"高等数学","category":"学习",
  "start_time":"${MONDAY}T08:00:00","end_time":"${MONDAY}T09:40:00",
  "repeat":"weekly","repeat_until":"2026-12-31","location":"教三 401","reminder_minutes":15,
  "source":"manual","is_completed":false,
  "created_at":"$NOW","updated_at":"$NOW","synced_at":null,"schema_version":1},
 {"id":"smoke-gym","title":"游泳","category":"运动",
  "start_time":"${MONDAY}T18:00:00","end_time":"${MONDAY}T19:00:00",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"$NOW","synced_at":null,"schema_version":1},
 {"id":"smoke-night","title":"夜间自习","category":"学习",
  "start_time":"${MONDAY}T23:00:00","end_time":"2026-09-08T01:00:00",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"$NOW","synced_at":null,"schema_version":1}
]}
EOF
ok

say "推 2 条待办"
curl -fsS -X POST "${sync_hdr[@]}" -d @- "$HOST/v1/todos/sync" <<EOF | jget "d['applied']" | grep -qx 2 || die "待办同步 applied != 2"
{"records":[
 {"id":"smoke-todo-1","title":"刷线段树","type":"daily","priority":"high",
  "is_completed":false,"last_reset":"$MONDAY",
  "created_at":"$NOW","updated_at":"$NOW","synced_at":null,"schema_version":1},
 {"id":"smoke-todo-2","title":"写周报","type":"weekly","priority":"medium",
  "is_completed":false,"last_reset":"$MONDAY",
  "created_at":"$NOW","updated_at":"$NOW","synced_at":null,"schema_version":1}
]}
EOF
ok

say "推学期配置（app 真实形态：new Date(...).toISOString()）"
# app 设置页发的就是 toISOString 形态，不是裸日期——种子别再比生产干净。
curl -fsS -X PUT "${sync_hdr[@]}" \
  -d '{"start_date":"2026-09-01T00:00:00.000Z","total_weeks":18,"updated_at":"2026-09-01T00:00:00.000Z"}' \
  "$HOST/v1/config/semester" | grep -q '"applied":true' || die "学期配置没写进去（app 真实 payload 被拒？）"
# 服务端应归一成裸上海日历日
[ "$(curl -fsS "${sync_hdr[@]}" "$HOST/v1/config/semester" | jget "d['semester']['start_date']")" = "2026-09-01" ] \
  || die "start_date 应归一为裸 YYYY-MM-DD"
ok

say "学期配置：解析不了的 start_date 仍 400"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${sync_hdr[@]}" \
  -d '{"start_date":"2026/09/01","total_weeks":18,"updated_at":"x"}' "$HOST/v1/config/semester")
[ "$code" = "400" ] || die "非法 start_date 应 400，得到 $code"
ok

say "推一条关联评分（linked_event_id=smoke-math）"
curl -fsS -X POST "${sync_hdr[@]}" -d @- "$HOST/v1/ratings/sync" <<EOF | jget "d['applied']" | grep -qx 1 || die "评分同步失败"
{"records":[
 {"id":"smoke-rating-1","slot_start":"${MONDAY}T08:00:00.000+08:00","slot_end":"${MONDAY}T09:40:00.000+08:00",
  "linked_event_id":"smoke-math","rating":4,"efficiency":5,"mood":"清醒","activity":"高数","reflection":"听懂了",
  "created_at":"$NOW","updated_at":"$NOW","schema_version":1}]}
EOF
ok

say "GET /v1/schedule/day?date=$MONDAY（READONLY_TOKEN）"
DAY_JSON=$(curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=$MONDAY")
[ "$(echo "$DAY_JSON" | jget "d['date']")" = "$MONDAY" ]           || die "date 字段不对"
[ "$(echo "$DAY_JSON" | jget "d['weekday']")" = "1" ]              || die "weekday 应为 1（周一）"
[ "$(echo "$DAY_JSON" | jget "d['semester_week']")" = "2" ]        || die "semester_week 应为 2"
[ "$(echo "$DAY_JSON" | jget "len(d['events'])")" = "3" ] || die "当天应有 3 节课"
[ "$(echo "$DAY_JSON" | jget "len(d['todos'])")" = "2" ]  || die "当天应有 2 条待办"
[ "$(echo "$DAY_JSON" | jget "d['events'][0]['id']")" = "smoke-math" ] || die "首节课应是 smoke-math"
[ "$(echo "$DAY_JSON" | jget "d['events'][0]['ratings'][0]['rating']")" = "4" ] || die "评分未关联上"
[ "$(echo "$DAY_JSON" | jget "d['events'][0]['start_time']")" = "${MONDAY}T08:00:00" ] \
  || die "母事件 start_time 应保持母值（裸上海格式）"
# 合约第 20 条：业务时间是 floating Asia/Shanghai，实例时间直读就是本地钟点。
[ "$(echo "$DAY_JSON" | jget "d['events'][0]['instance_start']")" = "${MONDAY}T08:00:00" ] \
  || die "instance_start 应为裸上海 08:00，不能被平移"
# last_synced 是服务端记的「最后一次收到同步请求」，不是记录里的 synced_at
# （app 推 pending 记录时 synced_at 恒为 null，服务端永远看不到非 null 值）。
echo "$DAY_JSON" | jget "d['last_synced']['schedule'] or ''" | grep -q '^2' \
  || die "last_synced.schedule 应有服务端记录的推送时刻"
echo "$DAY_JSON" | jget "d['last_synced']['todos'] or ''" | grep -q '^2' \
  || die "last_synced.todos 应有服务端记录的推送时刻"
ok

say "时区回归：裸格式「上海 14:00」与带 Z「06:00Z」都显示 14:00（合约第 20 条）"
curl -fsS -X POST "${sync_hdr[@]}" -d @- "$HOST/v1/schedule/sync" >/dev/null <<EOF
{"records":[
 {"id":"smoke-tz-naive","title":"C++(裸格式)","category":"学习",
  "start_time":"2026-09-10T14:00:00","end_time":"2026-09-10T15:40:00",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"$NOW","synced_at":null,"schema_version":1},
 {"id":"smoke-tz-zulu","title":"C++(带 Z)","category":"学习",
  "start_time":"2026-09-10T06:00:00Z","end_time":"2026-09-10T07:40:00Z",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"$NOW","synced_at":null,"schema_version":1},
 {"id":"smoke-tz-offset","title":"C++(带 offset 带毫秒)","category":"学习",
  "start_time":"2026-09-10T14:00:00.250+08:00","end_time":"2026-09-10T15:40:00.750+08:00",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"$NOW","synced_at":null,"schema_version":1}
]}
EOF
TZ_JSON=$(curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=2026-09-10")
for id in smoke-tz-naive smoke-tz-zulu smoke-tz-offset; do
  got=$(echo "$TZ_JSON" | jget "[e['instance_start'] for e in d['events'] if e['id']=='$id'][0]")
  [ "$got" = "2026-09-10T14:00:00" ] || die "$id 应显示 14:00，得到 $got（时区平移 bug 回归）"
done
# 库里存的一律是规范化后的裸格式
[ "$(curl -fsS -H "Authorization: Bearer $SYNC_TOKEN" "$HOST/v1/schedule" \
     | jget "[r['start_time'] for r in d['records'] if r['id']=='smoke-tz-zulu'][0]")" = "2026-09-10T14:00:00" ] \
  || die "带 Z 的输入应被规范化成裸上海格式存储"
ok

say "last_synced 不受记录里 synced_at=null 影响（合约缺陷回归）"
[ "$(curl -fsS -H "Authorization: Bearer $SYNC_TOKEN" "$HOST/v1/schedule" \
     | jget "str(d['records'][0]['synced_at'])")" = "None" ] \
  || die "烟测应模拟 app 的真实推送形态：synced_at 为 null"
ok

say "重复课下一周（$MONDAY +7）仍在，非重复课不在"
NEXT_JSON=$(curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=2026-09-14")
[ "$(echo "$NEXT_JSON" | jget "len(d['events'])")" = "1" ] || die "下周一应只剩 weekly 那节"
[ "$(echo "$NEXT_JSON" | jget "d['events'][0]['id']")" = "smoke-math" ] || die "下周一应是 smoke-math"
[ "$(echo "$NEXT_JSON" | jget "d['semester_week']")" = "3" ] || die "下周应是第 3 周"
ok

say "跨午夜课程在 Asia/Shanghai 次日（9/8）也覆盖到"
D8=$(curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=2026-09-08")
echo "$D8" | jget "[e['id'] for e in d['events']]" | grep -q 'smoke-night' || die "跨午夜课程未覆盖次日"
ok

say "GET /v1/schedule/window 展开 4 周的 weekly 实例"
WIN=$(curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/window?start=$MONDAY&end=2026-09-28")
[ "$(echo "$WIN" | jget "len([e for e in d['events'] if e['id']=='smoke-math'])")" = "4" ] \
  || die "9/7-9/28 应展开 4 个 smoke-math 实例"
ok

say "时间点查询：上课中命中、课间落空"
HIT=$(curl -fsS "${ro_hdr[@]}" \
  "$HOST/v1/schedule/window?start=2026-09-07T08:30:00&end=2026-09-07T08:30:00")
[ "$(echo "$HIT" | jget "len(d['events'])")" = "1" ] || die "08:30 应正在上高数"
MISS=$(curl -fsS "${ro_hdr[@]}" \
  "$HOST/v1/schedule/window?start=2026-09-07T12:00:00&end=2026-09-07T12:00:00")
[ "$(echo "$MISS" | jget "len(d['events'])")" = "0" ] || die "12:00 应没课"
ok

say "窗口上限 62 天：61 天 200，超出 400"
code=$(curl -s -o /dev/null -w '%{http_code}' "${ro_hdr[@]}" \
  "$HOST/v1/schedule/window?start=2026-09-01T00:00:00.000Z&end=2026-11-01T00:00:00.000Z")
[ "$code" = "200" ] || die "61 天窗口应 200，得到 $code"
code=$(curl -s -o /dev/null -w '%{http_code}' "${ro_hdr[@]}" \
  "$HOST/v1/schedule/window?start=2026-09-01T00:00:00.000Z&end=2026-12-01T00:00:00.000Z")
[ "$code" = "400" ] || die "91 天窗口应 400，得到 $code"
ok

say "token 分级：READONLY 调同步端点 403、无 token 401"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${ro_hdr[@]}" -H 'Content-Type: application/json' \
  -d '{"records":[]}' "$HOST/v1/schedule/sync")
[ "$code" = "403" ] || die "READONLY 调同步端点应 403，得到 $code"
code=$(curl -s -o /dev/null -w '%{http_code}' "${ro_hdr[@]}" "$HOST/v1/schedule")
[ "$code" = "403" ] || die "READONLY 调拉取端点应 403，得到 $code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$HOST/v1/schedule/day")
[ "$code" = "401" ] || die "无 token 应 401，得到 $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SYNC_TOKEN" "$HOST/v1/schedule/day")
[ "$code" = "200" ] || die "SYNC_TOKEN 查 day 应 200，得到 $code"
ok

say "LWW：改一门课再推，查询见变化"
PREV_SYNCED=$(curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=$MONDAY" | jget "d['last_synced']['schedule']")
sleep 1
curl -fsS -X POST "${sync_hdr[@]}" -d @- "$HOST/v1/schedule/sync" <<EOF | jget "d['applied']" | grep -qx 1 || die "改课未写入"
{"records":[
 {"id":"smoke-gym","title":"游泳(改到 20:00)","category":"运动",
  "start_time":"${MONDAY}T20:00:00","end_time":"${MONDAY}T21:00:00",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"2026-09-05T00:00:00.000Z","synced_at":null,"schema_version":1}]}
EOF
AFTER=$(curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=$MONDAY")
echo "$AFTER" | jget "[e['title'] for e in d['events']]" | grep -q '改到 20:00' || die "改动未反映到查询"
NEW_SYNCED=$(echo "$AFTER" | jget "d['last_synced']['schedule']")
[ "$NEW_SYNCED" \> "$PREV_SYNCED" ] \
  || die "last_synced 应随新一次推送前进（$PREV_SYNCED -> $NEW_SYNCED）"
ok

say "推空 records 也刷新 last_synced（app 活着就是新鲜）"
BEFORE_EMPTY=$(curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=$MONDAY" | jget "d['last_synced']['todos']")
sleep 1
curl -fsS -X POST "${sync_hdr[@]}" -d '{"records":[]}' "$HOST/v1/todos/sync" >/dev/null
AFTER_EMPTY=$(curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=$MONDAY" | jget "d['last_synced']['todos']")
[ "$AFTER_EMPTY" \> "$BEFORE_EMPTY" ] || die "空 records 的纯拉取调用也该刷新 last_synced.todos（$BEFORE_EMPTY -> $AFTER_EMPTY）"
ok

say "tombstone：软删一门课后 day 里消失"
curl -fsS -X POST "${sync_hdr[@]}" -d @- "$HOST/v1/schedule/sync" <<EOF >/dev/null
{"records":[
 {"id":"smoke-gym","title":"游泳(改到 20:00)","category":"运动",
  "start_time":"${MONDAY}T20:00:00","end_time":"${MONDAY}T21:00:00",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"2026-09-06T00:00:00.000Z","synced_at":null,
  "deleted_at":"2026-09-06T00:00:00.000Z","schema_version":1}]}
EOF
DEL=$(curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=$MONDAY")
[ "$(echo "$DEL" | jget "len(d['events'])")" = "2" ] || die "软删后当天应剩 2 节"
if echo "$DEL" | jget "[e['id'] for e in d['events']]" | grep -q 'smoke-gym'; then
  die "软删的课不该出现"
fi
ok

say "校验拒绝：非法 category 单条 rejected，同批好记录照写"
REJ=$(curl -fsS -X POST "${sync_hdr[@]}" -d @- "$HOST/v1/schedule/sync" <<EOF
{"records":[
 {"id":"smoke-bad","title":"摸鱼","category":"不存在的分类",
  "start_time":"${MONDAY}T10:00:00","end_time":"${MONDAY}T11:00:00",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"$NOW","schema_version":1},
 {"id":"smoke-ok","title":"英语","category":"学习",
  "start_time":"${MONDAY}T10:00:00","end_time":"${MONDAY}T11:00:00",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"$NOW","schema_version":1}]}
EOF
)
[ "$(echo "$REJ" | jget "d['applied']")" = "1" ]  || die "同批好记录应写入"
[ "$(echo "$REJ" | jget "d['rejected']")" = "1" ] || die "坏记录应被拒"
ok

# ================= v3 写端点 =================
# 到这里 MONDAY 当天还剩：smoke-math(08:00-09:40 weekly)、smoke-night(23:00-次日01:00)、
# smoke-ok(10:00-11:00)。下面拿 12:00-13:00 这个空档做增改删。

# audit 基线：此刻只有 app 的同步调用跑过，写端点一次没调，应为 0 行。
audit_count() {
  "$NODE" -e "
const Database = require('better-sqlite3');
const db = new Database('$TMPDIR_SMOKE/smoke.db', { readonly: true });
console.log(db.prepare('SELECT COUNT(*) c FROM audit_log').get().c);
"
}
say "audit 基线：同步端点不落 audit 行"
AUDIT_BEFORE=$(audit_count)
[ "$AUDIT_BEFORE" = "0" ] || die "写端点还没调过，audit_log 应为空（实际 $AUDIT_BEFORE）"
ok

say "写端点：WRITE_TOKEN 新增一门课（201，服务端补 id/时间戳/source）"
ADD=$(curl -fsS -X POST "${write_hdr[@]}" -d @- "$HOST/v1/schedule/events" <<EOF
{"title":"Claude 加的课","category":"学习",
 "start_time":"${MONDAY}T12:00:00","end_time":"${MONDAY}T13:00:00",
 "location":"图书馆"}
EOF
)
NEW_ID=$(echo "$ADD" | jget "d['record']['id']")
[ -n "$NEW_ID" ] || die "新增未返回 id"
[ "$(echo "$ADD" | jget "d['record']['source']")" = "claude" ] || die "source 应缺省为 claude"
[ "$(echo "$ADD" | jget "d['record']['created_at'] == d['record']['updated_at']")" = "True" ] \
  || die "新建时两个时间戳应相同"
ok

say "写端点：新增的课出现在 day 查询里"
curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=$MONDAY" \
  | jget "[e['title'] for e in d['events']]" | grep -q 'Claude 加的课' || die "新增的课没进 day"
ok

say "写端点：撞车的新增 → 409 conflict，报出撞的是哪一节"
CONFLICT=$(curl -sS -o /tmp/smoke-conflict.$$ -w '%{http_code}' -X POST "${write_hdr[@]}" -d @- \
  "$HOST/v1/schedule/events" <<EOF
{"title":"想插队的课","category":"学习",
 "start_time":"${MONDAY}T12:30:00","end_time":"${MONDAY}T13:30:00"}
EOF
)
[ "$CONFLICT" = "409" ] || die "撞车应返回 409，实际 $CONFLICT"
[ "$(jget "d['error']" < /tmp/smoke-conflict.$$)" = "conflict" ] || die "error 应为 conflict"
jget "[c['title'] for c in d['conflicts']]" < /tmp/smoke-conflict.$$ | grep -q 'Claude 加的课' \
  || die "conflicts 里应带撞上的那节课"
jget "d['conflicts'][0]['instance_start']" < /tmp/smoke-conflict.$$ >/dev/null \
  || die "冲突事件应带 instance_start"
rm -f /tmp/smoke-conflict.$$
ok

say "写端点：撞 weekly 重复课的展开实例 → 409（下周一 08:30）"
NEXT_MONDAY="2026-09-14"
W_CONFLICT=$(curl -sS -o /tmp/smoke-wconf.$$ -w '%{http_code}' -X POST "${write_hdr[@]}" -d @- \
  "$HOST/v1/schedule/events" <<EOF
{"title":"撞高数展开实例","category":"学习",
 "start_time":"${NEXT_MONDAY}T08:30:00","end_time":"${NEXT_MONDAY}T09:00:00"}
EOF
)
[ "$W_CONFLICT" = "409" ] || die "撞重复课实例应 409，实际 $W_CONFLICT"
jget "[c['id'] for c in d['conflicts']]" < /tmp/smoke-wconf.$$ | grep -q 'smoke-math' \
  || die "应报出 smoke-math 这门 weekly 课"
rm -f /tmp/smoke-wconf.$$
ok

say "写端点：单条读拿 expected_updated_at"
READ=$(curl -fsS "${write_hdr[@]}" "$HOST/v1/schedule/events/$NEW_ID")
EXPECTED=$(echo "$READ" | jget "d['record']['updated_at']")
[ -n "$EXPECTED" ] || die "单条读没拿到 updated_at"
[ "$(echo "$READ" | jget "d['deleted']")" = "False" ] || die "未删记录 deleted 应为 False"
ok

say "写端点：PATCH 改地点与标题（200），day 里见变化"
PATCHED=$(curl -fsS -X PATCH "${write_hdr[@]}" -d @- "$HOST/v1/schedule/events/$NEW_ID" <<EOF
{"expected_updated_at":"$EXPECTED","title":"Claude 改过的课","location":"教五 203"}
EOF
)
[ "$(echo "$PATCHED" | jget "d['record']['title']")" = "Claude 改过的课" ] || die "标题没改上"
[ "$(echo "$PATCHED" | jget "d['record']['location']")" = "教五 203" ] || die "地点没改上"
AFTER_PATCH=$(echo "$PATCHED" | jget "d['record']['updated_at']")
[ "$AFTER_PATCH" \> "$EXPECTED" ] || die "updated_at 应前进"
curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=$MONDAY" \
  | jget "[e['title'] for e in d['events']]" | grep -q 'Claude 改过的课' || die "改动没反映到 day"
ok

say "写端点：stale 的 PATCH → 409 stale 并奉还当前记录"
STALE=$(curl -sS -o /tmp/smoke-stale.$$ -w '%{http_code}' -X PATCH "${write_hdr[@]}" -d @- \
  "$HOST/v1/schedule/events/$NEW_ID" <<EOF
{"expected_updated_at":"$EXPECTED","title":"基于旧版本硬改"}
EOF
)
[ "$STALE" = "409" ] || die "stale 应返回 409，实际 $STALE"
[ "$(jget "d['error']" < /tmp/smoke-stale.$$)" = "stale" ] || die "error 应为 stale"
[ "$(jget "d['current_record']['title']" < /tmp/smoke-stale.$$)" = "Claude 改过的课" ] \
  || die "应奉还当前记录"
rm -f /tmp/smoke-stale.$$
ok

say "写端点：DELETE 软删后 day 里消失，墓碑仍可拉取"
DELETED=$(curl -fsS -X DELETE "${write_hdr[@]}" -d @- "$HOST/v1/schedule/events/$NEW_ID" <<EOF
{"expected_updated_at":"$AFTER_PATCH"}
EOF
)
jget "d['record']['deleted_at']" <<<"$DELETED" >/dev/null || die "删除应返回带 deleted_at 的墓碑"
if curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=$MONDAY" \
   | jget "[e['id'] for e in d['events']]" | grep -q "$NEW_ID"; then
  die "软删的课不该出现在 day 里"
fi
curl -fsS "${sync_hdr[@]}" "$HOST/v1/schedule" \
  | jget "[r['id'] for r in d['records'] if r['deleted_at']]" | grep -q "$NEW_ID" \
  || die "app 应能拉到墓碑"
ok

say "写端点：待办增改删"
TODO=$(curl -fsS -X POST "${write_hdr[@]}" -d '{"title":"Claude 加的待办","type":"weekly","priority":"high","last_reset":"2026-09-07"}' "$HOST/v1/todos")
TODO_ID=$(echo "$TODO" | jget "d['record']['id']")
[ -n "$TODO_ID" ] || die "待办新增没返回 id"
curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=$MONDAY" \
  | jget "[t['title'] for t in d['todos']]" | grep -q 'Claude 加的待办' || die "新待办没进 day"
TODO_V1=$(echo "$TODO" | jget "d['record']['updated_at']")
TODO_V2=$(curl -fsS -X PATCH "${write_hdr[@]}" -d "{\"expected_updated_at\":\"$TODO_V1\",\"is_completed\":true}" \
  "$HOST/v1/todos/$TODO_ID" | jget "d['record']['updated_at']")
curl -fsS -X DELETE "${write_hdr[@]}" -d "{\"expected_updated_at\":\"$TODO_V2\"}" "$HOST/v1/todos/$TODO_ID" >/dev/null
if curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=$MONDAY" \
   | jget "[t['id'] for t in d['todos']]" | grep -q "$TODO_ID"; then
  die "软删的待办不该出现"
fi
ok

say "写端点：404（不存在的 id）与 400（缺 expected_updated_at）"
NF=$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH "${write_hdr[@]}" \
  -d '{"expected_updated_at":"2020-01-01T00:00:00.000Z","title":"x"}' \
  "$HOST/v1/schedule/events/does-not-exist")
[ "$NF" = "404" ] || die "不存在的 id 应 404，实际 $NF"
NE=$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH "${write_hdr[@]}" \
  -d '{"title":"x"}' "$HOST/v1/schedule/events/smoke-math")
[ "$NE" = "400" ] || die "缺 expected_updated_at 应 400，实际 $NE"
ok

say "写端点：校验错 400（非法 category）"
VE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${write_hdr[@]}" -d @- "$HOST/v1/schedule/events" <<EOF
{"title":"摸鱼","category":"不存在的分类",
 "start_time":"${MONDAY}T15:00:00","end_time":"${MONDAY}T16:00:00"}
EOF
)
[ "$VE" = "400" ] || die "非法 category 应 400，实际 $VE"
ok

say "token 权限矩阵：READONLY 写 403、WRITE 调同步端点 403、无 token 401"
RO_WRITE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${ro_hdr[@]}" -H 'Content-Type: application/json' \
  -d '{"title":"x","category":"学习","start_time":"'"${MONDAY}"'T16:00:00.000+08:00","end_time":"'"${MONDAY}"'T17:00:00.000+08:00"}' \
  "$HOST/v1/schedule/events")
[ "$RO_WRITE" = "403" ] || die "READONLY_TOKEN 调写端点应 403，实际 $RO_WRITE"
W_SYNC=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${write_hdr[@]}" -d '{"records":[]}' "$HOST/v1/schedule/sync")
[ "$W_SYNC" = "403" ] || die "WRITE_TOKEN 调 schedule/sync 应 403，实际 $W_SYNC"
W_TSYNC=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${write_hdr[@]}" -d '{"records":[]}' "$HOST/v1/todos/sync")
[ "$W_TSYNC" = "403" ] || die "WRITE_TOKEN 调 todos/sync 应 403，实际 $W_TSYNC"
NO_TOKEN=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{}' "$HOST/v1/schedule/events")
[ "$NO_TOKEN" = "401" ] || die "无 token 应 401，实际 $NO_TOKEN"
ok

say "audit_log：写操作全部留痕（成功与失败都算）"
AUDIT_COUNT=$(audit_count)
[ "$AUDIT_COUNT" -gt "$AUDIT_BEFORE" ] || die "audit 行数没增长（$AUDIT_BEFORE -> $AUDIT_COUNT）"
# 上面共 12 次写调用：新增 1、撞车 2、PATCH 1、stale 1、DELETE 1、
# 待办增改删 3、404/400 各 1、校验错 1。403/401 被鉴权钩子挡在路由之前，不落行。
[ "$AUDIT_COUNT" -ge 12 ] || die "audit_log 行数偏少（$AUDIT_COUNT），写操作应全部留痕"
AUDIT_OUTCOMES=$("$NODE" -e "
const Database = require('better-sqlite3');
const db = new Database('$TMPDIR_SMOKE/smoke.db', { readonly: true });
console.log(db.prepare('SELECT DISTINCT outcome FROM audit_log ORDER BY outcome').all().map(r=>r.outcome).join(','));
")
for want in conflict created deleted not_found stale updated validation_error; do
  echo "$AUDIT_OUTCOMES" | grep -q "$want" || die "audit_log 缺 outcome=$want（实际有 $AUDIT_OUTCOMES）"
done
printf '   audit 行数 %s，outcome 覆盖 %s\n' "$AUDIT_COUNT" "$AUDIT_OUTCOMES"
ok

say "全部检查通过"
