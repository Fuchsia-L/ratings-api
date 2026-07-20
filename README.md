# ratings-api

CyberSchedule TimeSlotRating 同步服务，部署在 `api.epoch0.org`。

## 架构

- Fastify + better-sqlite3（WAL 模式）
- Bearer token 单用户认证（`SYNC_TOKEN` 环境变量）
- SQLite 落盘在 `./data/ratings.db`
- 绑 127.0.0.1，外部走 nginx 反代 + Let's Encrypt

## 端点

- `GET /v1/healthz` — 健康检查（无需认证）
- `GET /v1/ratings?since=<ISO>` — 拉取 `updated_at > since` 的记录，省略 `since` 拉全量
- `POST /v1/ratings/sync` — 双向同步
  - 请求体：`{ records: TimeSlotRating[], since?: string }`
  - 响应：`{ applied, rejected, errors?, records, server_time }`
  - 冲突策略：**last-write-wins**（比较 `updated_at` ISO 字符串字典序，ISO 8601 可直接比较）
- `GET /internal/summary?days=7|28` — 同机鹊桥专用只读汇总；使用独立 `INTERNAL_TOKEN`，nginx 公网入口对 `/internal/` 返回 404
  - 返回总体均值、按日、星期×时段、活动聚合，以及最多 5 条匿名化反思摘录
  - 自动排除软删除记录，窗口只允许 7/28 天，防止 AI 结论越过证据范围

## 数据 schema

与 app `TimeSlotRating` 完全对齐（15 字段）：`id` / `slot_start` / `slot_end` / `linked_event_id` / `rating` / `efficiency` / `mood` / `activity` / `reflection` / `created_at` / `updated_at` / `synced_at` / `schema_version` / `deleted_at`。

**软删除**：`deleted_at` 为 ISO 时间字符串表示已删除，null 表示活跃。Server 不做任何 filter（全量返回给调用方，让调用方决定如何展示/过滤）。本地 GC（比如"tombstone 超过 90 天真删"）后续单独加。

## 本地跑

```bash
npm install
cp .env.example .env
# 改 .env 里的 SYNC_TOKEN
npm start
```

## VPS 部署

见仓库根目录的 `scripts/vps_ratings_api.py`（paramiko 脚本，一键装）。

配置文件模板：
- `deploy/ratings-api.service` — systemd unit
- `deploy/nginx-api.conf` — nginx server block（certbot 会自动改写为 HTTPS）

环境变量文件在 VPS 侧独立路径：`/etc/ratings-api.env`（systemd `EnvironmentFile` 引用，不进 git）。

## 校验规则

- `rating` / `efficiency`：integer 1-5
- `mood`：string ≤ 20
- `activity`：string ≤ 50
- `reflection`：string ≤ 200
- `records` 非 array、`since` 非 string → 400

超长/类型错的记录整批其他行仍会写入，单条进 `rejected` 统计并返回 `errors: [{id, error}]`。

## 冲突检测（可选乐观并发）

`POST /v1/ratings/sync` 的每条 record 可附加 `expected_updated_at: <ISO string>` 字段。

- 带此字段时，server 会读取该 id 的当前记录：
  - 若 `current.updated_at === expected_updated_at` → 正常 upsert
  - 否则 → 本条被拒，`errors` 里返回 `{ id, error: 'stale', expected_updated_at, current_record }`，调用方可读 `current_record` 决定下一步
- 不带此字段 → 走默认 LWW（当前行为，app 端使用）

**约定**：
- app 端不带（一个终端自己不冲突，LWW 足够）
- MCP / Lux 端**必须**带：改之前先 `GET` 读最新，带上读到的 `updated_at` 作为 `expected_updated_at`。这样"被 app 抢先改过"的场景能明确反馈给 Lux，由 Lux 跟用户确认后再写

## 部署后烟测

```bash
TOKEN=<server token> HOST=https://api.epoch0.org bash deploy/smoke.sh
```

## 运维 TODO（v1 之后）

- SQLite 定期备份（systemd timer + rsync `/var/www/ratings-api/data/ratings.db` 到另一路径或 R2/S3）
- 打分频率/每日平均分的轻量 metrics 端点（给 Lux 读）
