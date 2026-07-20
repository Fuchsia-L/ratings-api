#!/usr/bin/env bash
# Post-deploy smoke test. Run on VPS after systemctl start.
# Usage: TOKEN=xxxx ./smoke.sh
set -euo pipefail

HOST="${HOST:-https://api.epoch0.org}"
TOKEN="${TOKEN:?set TOKEN env var}"

say() { printf '\n\033[36m>> %s\033[0m\n' "$*"; }
ok()  { printf '\033[32m   ok\033[0m\n'; }
die() { printf '\033[31m   FAIL: %s\033[0m\n' "$*"; exit 1; }

say "healthz (no auth)"
curl -fsS "$HOST/v1/healthz" | grep -q '"ok":true' || die "healthz did not return ok"
ok

say "GET /v1/ratings without token -> expect 401"
code=$(curl -s -o /dev/null -w '%{http_code}' "$HOST/v1/ratings")
[ "$code" = "401" ] || die "expected 401, got $code"
ok

say "GET /v1/ratings with token -> expect 200"
curl -fsS -H "Authorization: Bearer $TOKEN" "$HOST/v1/ratings" | grep -q '"records"' || die "list missing records field"
ok

say "POST /v1/ratings/sync empty batch"
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"records":[]}' "$HOST/v1/ratings/sync" | grep -q '"applied":0' || die "empty sync applied != 0"
ok

say "POST one record roundtrip"
NOW=$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')
ID="smoke-$(date +%s)"
PAYLOAD=$(cat <<EOF
{"records":[{
  "id":"$ID","slot_start":"$NOW","slot_end":"$NOW",
  "rating":5,"efficiency":4,
  "activity":"smoke test","mood":"ok",
  "created_at":"$NOW","updated_at":"$NOW","schema_version":1
}]}
EOF
)
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$PAYLOAD" "$HOST/v1/ratings/sync" | grep -q '"applied":1' || die "sync did not apply"
curl -fsS -H "Authorization: Bearer $TOKEN" "$HOST/v1/ratings" | grep -q "$ID" || die "record missing after sync"
ok

say "stale-precondition rejection"
STALE_PAYLOAD=$(cat <<EOF
{"records":[{
  "id":"$ID","slot_start":"$NOW","slot_end":"$NOW",
  "rating":3,"efficiency":3,
  "created_at":"$NOW","updated_at":"2099-12-31T23:59:59.999Z","schema_version":1,
  "expected_updated_at":"1970-01-01T00:00:00.000Z"
}]}
EOF
)
STALE_RES=$(curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$STALE_PAYLOAD" "$HOST/v1/ratings/sync")
echo "$STALE_RES" | grep -q '"rejected":1' || die "stale conflict not rejected"
echo "$STALE_RES" | grep -q '"error":"stale"' || die "stale error label missing"
ok

say "all checks passed"
