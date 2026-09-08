# ratings-api

CyberSchedule TimeSlotRating 同步服务，部署在 `api.epoch0.org`。

## 架构

- Fastify + better-sqlite3（WAL 模式）
- Bearer token 认证，三级：
  - `SYNC_TOKEN`（app 用）——全部 `/v1`；缺失或短于 32 字符则**启动失败**
  - `READONLY_TOKEN`（mooring Claude 用）——**仅** `GET /v1/schedule/day` 与
    `GET /v1/schedule/window`，调其他端点 403；**可选**，缺失只是关掉这条只读入口，不 fatal
  - `INTERNAL_TOKEN`（同机鹊桥）——仅 `/internal/*`，行为不变
- SQLite 落盘在 `./data/ratings.db`，表：`ratings`（现有）+ `schedule_events` + `todos` +
  `config`（app 的业务配置）+ `meta`（服务端运行时元数据，如数据新鲜度）
- 绑 127.0.0.1，外部走 nginx 反代 + Let's Encrypt

代码分层：`server.js`（只负责读 env、开库、listen）→ `app.js`（`buildApp()` 建 Fastify 实例，
可被测试直接 inject）→ `schedule-store.js`（三表 schema/校验/同步事务）、
`schedule-query.js`（day/window 组装）、`schedule-domain.js`（repeat/conflicts 移植）、
`summary.js`（内部汇总）。

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

### 课程 / 待办 / 学期配置（同步端点，语义与 `/v1/ratings/sync` 逐条对齐）

- `POST /v1/schedule/sync`、`POST /v1/todos/sync` — 请求/响应型同 ratings（LWW、tombstone、
  `expected_updated_at` 乐观并发、单条校验失败进 `rejected` 不影响同批其他行）
- `GET /v1/schedule?since=`、`GET /v1/todos?since=` — 纯拉取，不 filter 软删（同 ratings，交给调用方决定）
- `PUT /v1/config/semester` — body `{start_date, total_weeks, updated_at}`，`updated_at` 新者胜；
  响应 `{applied, semester, server_time}`
- `GET /v1/config/semester` — 未设置时 `semester` 为 `null`

### 查询端点（Claude / 未来其他 app 用）

- `GET /v1/schedule/day?date=YYYY-MM-DD` — `date` 缺省 = **Asia/Shanghai 的今天**
  ```json
  {
    "date": "2026-09-07", "weekday": 1, "semester_week": 2,
    "events": [ { "...母事件字段": "...", "instance_start": "...", "instance_end": "...",
                  "ratings": [ {"rating":4,"efficiency":5,"mood":null,"activity":null,
                                "reflection":null,"slot_start":"...","slot_end":"..."} ] } ],
    "todos": [ "...当天活跃待办（软删除外）" ],
    "last_synced": { "schedule": "<max synced_at>", "todos": "<max synced_at>" },
    "server_time": "..."
  }
  ```
- `GET /v1/schedule/window?start=&end=` — 窗口内展开实例；`start`/`end` 接受完整 ISO 时刻或
  `YYYY-MM-DD`（后者按 Asia/Shanghai 当日 00:00 / 23:59:59.999 解读）。时间点查询 = `start=end`。
  **窗口上限 62 天**，超出返回 400。

**展开语义**：重复实例继承母事件 `id`，实例时间放在 `instance_start` / `instance_end`，
母事件的 `start_time` / `end_time` **保持母值不变**（消费端不迷惑）。
非重复事件也带 `instance_*`（等于自身时间），结构统一。

**评分关联**：`ratings.linked_event_id = 母事件 id` 且 slot 与实例时间重叠，或 slot 落在
实例所在的那个 Asia/Shanghai 自然日；软删除的评分不算。

**`last_synced`（数据新鲜度）**：服务端**自己记录**的「最后一次收到该类同步请求的时刻」，
存在 `meta` 表的 `last_push_schedule` / `last_push_todos`。

注意它**不是** `max(synced_at)`：`synced_at` 是 app 收到服务端确认后打的本地标记，
推上来的 pending 记录里恒为 `null`，服务端永远看不到非 null 值——按 `max(synced_at)` 算
会永远返回 `null`，CLI 就算刚拿到数据也会显示「还没收到过手机同步」。改成服务端记录后，
`null` 现在真表示「一次都没推过」。

刷新规则：`POST /v1/schedule/sync`、`POST /v1/todos/sync` 每次成功处理后刷新，
**`records` 为空的纯拉取调用也算**（app 发起同步就说明它活着）；整批记录被校验拒绝也算
（app 确实来过）；请求格式错误返回 400 的不算。两类数据各记各的。

`meta` 表与 `config` 分开存：`config` 是 app 推上来、会被 `GET /v1/config/*` 读出去的业务
配置，`meta` 是服务端观测到的事实，分表比加过滤更保险，不会哪天顺手漏出去。

## 时区（本项目最大的坑）

app 的 `repeat.ts` 跑在手机本地时区，node 服务端进程默认 UTC。移植版
（`schedule-domain.js`）**显式钉死 Asia/Shanghai**：统一按 UTC+8 偏移计算「本地日期」，
不读 `process.env.TZ`，不依赖进程时区。测试在 UTC / America-New_York / Asia-Shanghai 三种
进程时区下均须全绿（`repeat.test.ts` 的用例已逐条复刻到 `test/schedule-domain.test.js`，
另加跨午夜课程、`repeat_until` 边界日、周界三个专项）。

`deploy/ratings-api.service` 里的 `Environment=TZ=UTC` 只是把这条不变量显式化，改它不会
改变查询结果。

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

`schedule_events`（对齐 app `ScheduleEvent`）：
- `category` ∈ 学习/工作/生活/运动/娱乐/其他
- `repeat` ∈ `none`/`daily`/`weekly`；`repeat_until` 须为 `YYYY-MM-DD`
- `reminder_minutes` ∈ 5/15/30 或 null
- `source` ∈ `manual`/`whut-import`/`claude`（`claude` 为 v3 预留，服务端先放行免得届时拒收）
- `title` ≤ 200、`location` ≤ 100、`notes` ≤ 500；`start_time`/`end_time` 须可解析为时间

`todos`（对齐 app `TodoItem`）：
- `type` ∈ `daily`/`weekly`/`longterm`
- `priority` ∈ `high`/`medium`/`low`
- `last_reset` 必填

`is_completed` 在库里存 0/1，出参还原成 boolean，与 app 类型一致。

## 冲突检测（可选乐观并发）

`POST /v1/ratings/sync` 的每条 record 可附加 `expected_updated_at: <ISO string>` 字段。

- 带此字段时，server 会读取该 id 的当前记录：
  - 若 `current.updated_at === expected_updated_at` → 正常 upsert
  - 否则 → 本条被拒，`errors` 里返回 `{ id, error: 'stale', expected_updated_at, current_record }`，调用方可读 `current_record` 决定下一步
- 不带此字段 → 走默认 LWW（当前行为，app 端使用）

**约定**：
- app 端不带（一个终端自己不冲突，LWW 足够）
- MCP / Lux 端**必须**带：改之前先 `GET` 读最新，带上读到的 `updated_at` 作为 `expected_updated_at`。这样"被 app 抢先改过"的场景能明确反馈给 Lux，由 Lux 跟用户确认后再写

## 测试与烟测

```bash
npm test                          # node:test，串行（1C/1G VPS 上别开并行）
bash deploy/smoke-schedule.sh     # 课程/待办端到端：自己起临时 server，跑完自动清理
TOKEN=<server token> HOST=https://api.epoch0.org bash deploy/smoke.sh   # 线上 ratings 烟测
```

## 运维 TODO（v1 之后）

- SQLite 定期备份（systemd timer + rsync `/var/www/ratings-api/data/ratings.db` 到另一路径或 R2/S3）
- 打分频率/每日平均分的轻量 metrics 端点（给 Lux 读）
