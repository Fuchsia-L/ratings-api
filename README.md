# ratings-api

CyberSchedule TimeSlotRating 同步服务，部署在 `api.epoch0.org`。

## 架构

- Fastify + better-sqlite3（WAL 模式）
- Bearer token 认证，四级：
  - `SYNC_TOKEN`（app 用）——全部 `/v1`；缺失或短于 32 字符则**启动失败**
  - `READONLY_TOKEN`（mooring Claude 查询用）——**仅** `GET /v1/schedule/day` 与
    `GET /v1/schedule/window`，调其他端点 403；**可选**，缺失只是关掉这条只读入口，不 fatal
  - `WRITE_TOKEN`（mooring Claude 增删改用）——写端点 + 查询端点 + 单条读；
    调同步端点（app 的批量推送）403；**可选**，缺失只是关掉写入口，不 fatal
  - `INTERNAL_TOKEN`（同机鹊桥）——仅 `/internal/*`，行为不变

  语义约定：**401 = token 缺失或不认识；403 = 认得这把钥匙但这扇门不归它开。**

- SQLite 落盘在 `./data/ratings.db`，表：`ratings`（现有）+ `schedule_events` + `todos` +
  `config`（app 的业务配置）+ `meta`（服务端运行时元数据，如数据新鲜度）+
  `audit_log`（写端点留痕，只写不读，要看直接查 SQLite）
- 绑 127.0.0.1，外部走 nginx 反代 + Let's Encrypt

代码分层：`server.js`（只负责读 env、开库、listen）→ `app.js`（`buildApp()` 建 Fastify 实例，
可被测试直接 inject）→ `schedule-store.js`（三表 schema/校验/同步事务）、
`schedule-query.js`（day/window 组装）、`schedule-domain.js`（repeat/conflicts 移植）、
`schedule-write.js`（v3 写端点的记录组装与 audit_log）、`summary.js`（内部汇总）。

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
  响应 `{applied, semester, server_time}`（`semester.start_date` 是归一后的值）
  - `start_date` 按业务日期收：裸 `YYYY-MM-DD`、zoned datetime（按上海日历日归一）、
    naive datetime（取日期部分）都接受，入库统一成裸 `YYYY-MM-DD`；解析不了才 400。
    app 设置页发的是 `new Date('2026-08-31').toISOString()` = `2026-08-31T00:00:00.000Z`，
    **必须收下**——早先严格只认裸日期，把它 400 掉，而 app 是 fire-and-forget 吞掉了拒绝，
    结果服务端永远没有学期配置，`semester_week` 恒 `null`。
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
    "last_synced": { "schedule": "<服务端记的最后一次推送时刻>", "todos": "<同左>" },
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

### 写端点（v3，`WRITE_TOKEN` 或 `SYNC_TOKEN`）

**服务端是时间戳权威**：`created_at` / `updated_at` 一律由服务端生成，caller 传了也被覆盖；
`synced_at` 与 `deleted_at` 同样不接受 caller 赋值。理由是 mooring 与手机两个钟不一定同步，
让远端 caller 自己写 `updated_at` 等于把 LWW 的胜负交给时钟漂移。
`id` caller 可给、缺省服务端生成 UUID；课程 `source` 缺省 `'claude'`。

- `POST /v1/schedule/events` — 先字段校验（错 400），再对**全部活跃事件**跑冲突检测
  （重复课先展开成实例再比）。冲突 → `409 {error:"conflict", conflicts:[完整冲突事件]}`；
  id 已存在 → `409 {error:"id_exists", current_record}`；成功 `201 {record, server_time}`。
- `PATCH /v1/schedule/events/:id` — body 必须带 `expected_updated_at`（缺则 400），
  与当前值不符 → `409 {error:"stale", current_record}`。部分字段 merge，
  显式传 `null` = 清空该字段。**改动了 `start_time`/`end_time`/`repeat`/`repeat_until`
  才重跑冲突检测**（排除自身 id），冲突 409。成功 `200 {record, server_time}`。
- `DELETE /v1/schedule/events/:id` — `expected_updated_at` 走 body 或 query 均可；
  软删（写 `deleted_at` + `updated_at`），成功 `200` 返回 tombstone。
- `POST /v1/todos`、`PATCH /v1/todos/:id`、`DELETE /v1/todos/:id` — 同模式，无冲突检测。
- `GET /v1/schedule/events/:id`、`GET /v1/todos/:id` — 单条读，**含软删记录**并以
  `deleted: true` 标明（caller 靠它拿 `expected_updated_at`）。不存在 → 404。

对已软删或不存在的 id 做 PATCH/DELETE 一律 404——改一条已经删掉的课没有意义。

### `audit_log`

所有写端点**无论成败**落一行：`ts`、`token_kind`（sync/write）、`endpoint`、`method`、
`record_id`、`payload_summary`（JSON 截断到 500 字符）、`outcome`（`created` / `updated` /
`deleted` / `conflict` / `stale` / `validation_error` / `not_found` / `id_exists`）。

不开读取端点，要看直接查 SQLite：

```bash
sqlite3 /var/www/ratings-api/data/ratings.db \
  'SELECT ts, token_kind, method, endpoint, record_id, outcome FROM audit_log ORDER BY id DESC LIMIT 20;'
```

401/403 被鉴权钩子挡在路由之前，**不落 audit 行**——审计记的是「被授权的调用做了什么」。
app 的批量同步端点同样不落行（那是手机的日常动作，不是谁的定向写入）。

## 业务时间字段的格式（合约第 20 条）

时间字段分两套语义，**别混**：

| 类别 | 字段 | 语义 | 格式 |
|---|---|---|---|
| 业务时间 | `start_time`、`end_time`、`repeat_until`、`last_reset`、`config.semester.start_date` | floating **Asia/Shanghai**（墙上钟点） | 裸本地 `YYYY-MM-DDTHH:mm:ss`（日期字段 `YYYY-MM-DD`） |
| 同步时间 | `created_at`、`updated_at`、`synced_at`、`deleted_at`、`last_synced` | 绝对时刻 | 真 UTC 毫秒 ISO `...Z` |

业务时间的规范存储格式与 app 现状一致（whut-import 导入的真课表就是 `2026-09-08T08:00:00`，
无 Z 无毫秒），app 零改动。

**输入容忍**：带 `Z`、带 `±HH:mm` 偏移、带毫秒的输入一律先按其声明时区换算成上海钟点，
再规范化成裸格式入库。所以 `2026-09-08T06:00:00Z` 与 `2026-09-08T14:00:00` 存进去是同一行。

**输出**：查询响应的 `instance_start` / `instance_end` 也是裸上海格式——消费端是人和 Claude，
本地钟点最直读。

**为什么必须这么定**：`new Date('2026-09-08T08:00:00')` 会按**进程时区**解析裸串。
服务端 `TZ=UTC` 时它变成 `08:00Z`，整条链平移 +8——Iris 14:00 的 C++ 课在 `klass day` 里
显示成 22:00（9/8 生产实测 bug）。所以裸格式一律走 `parseShanghai()`，
**禁止对业务时间用 `new Date(裸串)` 或 `Date.parse(裸串)`**。

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

四个 token 各自独立生成，别复用：

```bash
for k in SYNC_TOKEN READONLY_TOKEN WRITE_TOKEN INTERNAL_TOKEN; do
  printf '%s=%s\n' "$k" "$(openssl rand -hex 32)"
done
```

`READONLY_TOKEN` 与 `WRITE_TOKEN` 要抄进 mooring 的 `~/.config/klass/env`
（分别是 `KLASS_READONLY_TOKEN` 与 `KLASS_WRITE_TOKEN`）。加完 `WRITE_TOKEN` 需重启服务
才生效；不填也能起，只是写端点关着。

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

课程/待办的 `sync` 端点语义相同。v3 的 `PATCH`/`DELETE` 写端点则把它从「可选」升级为
**强制**：不带 `expected_updated_at` 直接 400，不符则 409 并奉还 `current_record`。

## 测试与烟测

```bash
npm test                          # node:test，串行（1C/1G VPS 上别开并行）；113 个用例
bash deploy/smoke-schedule.sh     # 课程/待办端到端 31 阶段（含 v3 写端点与 audit）：
                                  # 自己起临时 server、自带三个 token，跑完自动清理
TOKEN=<server token> HOST=https://api.epoch0.org bash deploy/smoke.sh   # 线上 ratings 烟测
```

## 运维 TODO（v1 之后）

- SQLite 定期备份（systemd timer + rsync `/var/www/ratings-api/data/ratings.db` 到另一路径或 R2/S3）
- 打分频率/每日平均分的轻量 metrics 端点（给 Lux 读）
