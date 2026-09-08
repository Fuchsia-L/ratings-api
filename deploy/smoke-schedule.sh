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

say "启动临时 server (port $PORT, db in $TMPDIR_SMOKE)"
SYNC_TOKEN="$SYNC_TOKEN" READONLY_TOKEN="$READONLY_TOKEN" \
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
  "start_time":"${MONDAY}T08:00:00.000+08:00","end_time":"${MONDAY}T09:40:00.000+08:00",
  "repeat":"weekly","repeat_until":"2026-12-31","location":"教三 401","reminder_minutes":15,
  "source":"manual","is_completed":false,
  "created_at":"$NOW","updated_at":"$NOW","synced_at":"$NOW","schema_version":1},
 {"id":"smoke-gym","title":"游泳","category":"运动",
  "start_time":"${MONDAY}T18:00:00.000+08:00","end_time":"${MONDAY}T19:00:00.000+08:00",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"$NOW","synced_at":"$NOW","schema_version":1},
 {"id":"smoke-night","title":"夜间自习","category":"学习",
  "start_time":"${MONDAY}T23:00:00.000+08:00","end_time":"2026-09-08T01:00:00.000+08:00",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"$NOW","synced_at":"$NOW","schema_version":1}
]}
EOF
ok

say "推 2 条待办"
curl -fsS -X POST "${sync_hdr[@]}" -d @- "$HOST/v1/todos/sync" <<EOF | jget "d['applied']" | grep -qx 2 || die "待办同步 applied != 2"
{"records":[
 {"id":"smoke-todo-1","title":"刷线段树","type":"daily","priority":"high",
  "is_completed":false,"last_reset":"$MONDAY",
  "created_at":"$NOW","updated_at":"$NOW","synced_at":"$NOW","schema_version":1},
 {"id":"smoke-todo-2","title":"写周报","type":"weekly","priority":"medium",
  "is_completed":false,"last_reset":"$MONDAY",
  "created_at":"$NOW","updated_at":"$NOW","synced_at":"$NOW","schema_version":1}
]}
EOF
ok

say "推学期配置"
curl -fsS -X PUT "${sync_hdr[@]}" \
  -d '{"start_date":"2026-09-01","total_weeks":18,"updated_at":"2026-09-01T00:00:00.000Z"}' \
  "$HOST/v1/config/semester" | grep -q '"applied":true' || die "学期配置没写进去"
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
[ "$(echo "$DAY_JSON" | jget "d['events'][0]['start_time']")" = "${MONDAY}T08:00:00.000+08:00" ] \
  || die "母事件 start_time 应保持母值"
echo "$DAY_JSON" | jget "d['events'][0]['instance_start']" | grep -q '^2026-09-07T00:00:00' \
  || die "instance_start 应为 UTC 2026-09-07T00:00（= +08 08:00）"
[ "$(echo "$DAY_JSON" | jget "d['last_synced']['schedule']")" = "$NOW" ] || die "last_synced.schedule 不对"
[ "$(echo "$DAY_JSON" | jget "d['last_synced']['todos']")" = "$NOW" ]    || die "last_synced.todos 不对"
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
  "$HOST/v1/schedule/window?start=2026-09-07T08:30:00.000%2B08:00&end=2026-09-07T08:30:00.000%2B08:00")
[ "$(echo "$HIT" | jget "len(d['events'])")" = "1" ] || die "08:30 应正在上高数"
MISS=$(curl -fsS "${ro_hdr[@]}" \
  "$HOST/v1/schedule/window?start=2026-09-07T12:00:00.000%2B08:00&end=2026-09-07T12:00:00.000%2B08:00")
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
curl -fsS -X POST "${sync_hdr[@]}" -d @- "$HOST/v1/schedule/sync" <<EOF | jget "d['applied']" | grep -qx 1 || die "改课未写入"
{"records":[
 {"id":"smoke-gym","title":"游泳(改到 20:00)","category":"运动",
  "start_time":"${MONDAY}T20:00:00.000+08:00","end_time":"${MONDAY}T21:00:00.000+08:00",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"2026-09-05T00:00:00.000Z","synced_at":"2026-09-05T00:00:00.000Z","schema_version":1}]}
EOF
AFTER=$(curl -fsS "${ro_hdr[@]}" "$HOST/v1/schedule/day?date=$MONDAY")
echo "$AFTER" | jget "[e['title'] for e in d['events']]" | grep -q '改到 20:00' || die "改动未反映到查询"
[ "$(echo "$AFTER" | jget "d['last_synced']['schedule']")" = "2026-09-05T00:00:00.000Z" ] \
  || die "last_synced 未跟着更新"
ok

say "tombstone：软删一门课后 day 里消失"
curl -fsS -X POST "${sync_hdr[@]}" -d @- "$HOST/v1/schedule/sync" <<EOF >/dev/null
{"records":[
 {"id":"smoke-gym","title":"游泳(改到 20:00)","category":"运动",
  "start_time":"${MONDAY}T20:00:00.000+08:00","end_time":"${MONDAY}T21:00:00.000+08:00",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"2026-09-06T00:00:00.000Z","synced_at":"2026-09-06T00:00:00.000Z",
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
  "start_time":"${MONDAY}T10:00:00.000+08:00","end_time":"${MONDAY}T11:00:00.000+08:00",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"$NOW","schema_version":1},
 {"id":"smoke-ok","title":"英语","category":"学习",
  "start_time":"${MONDAY}T10:00:00.000+08:00","end_time":"${MONDAY}T11:00:00.000+08:00",
  "repeat":"none","is_completed":false,
  "created_at":"$NOW","updated_at":"$NOW","schema_version":1}]}
EOF
)
[ "$(echo "$REJ" | jget "d['applied']")" = "1" ]  || die "同批好记录应写入"
[ "$(echo "$REJ" | jget "d['rejected']")" = "1" ] || die "坏记录应被拒"
ok

say "全部检查通过"
