# 奶记 · 婴儿喂养记录 — v3 接口与实现契约

> 本文件是 server / web / cli 三方并行开发的唯一事实来源。需要变更时先改本文再改代码。
> v1 历史见 git；v1 的 QA 报告归档在 `docs/qa-report-v1.md`。

## 0. v2 变更摘要

1. **前后端分离**：拆成三个独立部分，只通过 HTTP API 通信：
   - `server/`：纯 HTTP API（可选托管 `web/` 静态文件，方便家庭单机部署）
   - `web/`：纯静态前端（HTML/CSS/ESM），API 地址可配置，可部署到任意静态主机
   - `cli/`：命令行工具，电脑上用它记录/查看；同样只走 API
2. **喂奶类型多选**：一次喂奶可同时勾选多个标签（奶粉 / 母乳·瓶喂 / 亲喂），**只记一个总奶量**，例如「奶粉 + 母乳 120 ml」「亲喂 + 奶粉 60 ml」。
3. 数据模型与 API 相应调整（`feedType` → `feedTypes` 数组），**旧库自动迁移，数据不丢**。
4. 新增 CORS 支持，允许 web 与 server 不同源部署。
6. **趋势统计**：新增 `GET /api/stats`（最近 7/30/90 天按天聚合），web 新增折线图卡片（SVG 手绘、零依赖）。
7. **洗澡事件**：`kind` 新增 `'bath'`（POST `/api/baths`）；洗澡也视为一次清洁，**重置「距上次换尿布」计时**（取 lastDiaper / lastBath 较晚者）。
5. **多端实时同步**：新增 SSE 端点 `GET /api/events/stream`，任何一端记录/删除后实时推送给所有打开的页面；顶栏提供手动「刷新」按钮，回到页面时也会静默校准。零依赖（浏览器原生 `EventSource`）。

## 1. 技术栈与硬约束

- **零第三方依赖**：只用 Node.js 内置模块（`node:http` / `node:sqlite` / `fetch` / `node:test`），无 `npm install`、无构建步骤、web 无打包。
- Node ≥ 22.13（开发环境 24；`node:sqlite` 内置）。
- SQLite 单文件，默认 `data/baby.db`（`DB_PATH` 覆盖）。
- 三处代码不得互相 import 运行时内部实现：web 只用 API；cli 只用 API。共享的纯展示函数各自保留（`web/lib/format.js` 与 `cli/src/format.mjs` 行为一致即可）。

## 2. 目录结构与所有权

```
baby-milk-tracker/
├── package.json              # Lead：根 scripts / bin（naiji）
├── flake.nix / .envrc        # Lead
├── server/
│   └── src/
│       ├── server.js         # Lead：HTTP、路由、校验、CORS、静态托管
│       ├── db.js             # Lead：schema v2 + v1→v2 迁移 + Store
│       ├── state.js          # Lead：buildState（纯函数）
│       └── util/time.js      # Lead：dayBounds（纯函数）
├── web/                      # web teammate 独占
│   ├── index.html / app.css / app.js（ES module）
│   ├── config.js             # 运行时配置：window.NAIJI_CONFIG = { apiBase: '' }
│   ├── lib/api.js / lib/format.js
│   ├── manifest.webmanifest / icon.svg
├── cli/                      # cli teammate 独占
│   ├── bin/naiji.mjs         # 可执行入口（#!/usr/bin/env node）
│   ├── src/*.mjs
│   └── test/*.test.js        # CLI 自己的测试
├── test/                     # tests teammate 独占：server + web/lib 纯函数测试
├── scripts/                  # QA teammate：browser-e2e.mjs / serve-web.mjs
└── docs/CONTRACT.md
```

## 3. 时间约定

- 数据库 / API 中所有时间戳均为 **epoch 毫秒（number）**。
- `tzOffset` 语义等同 `Date.prototype.getTimezoneOffset()`：本地 = UTC − tzOffset（分钟）。东八区为 `-480`。
- 展示用浏览器 / CLI 进程本地时区。

## 4. 数据模型（v3）

单表 `events`：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | |
| `kind` | TEXT NOT NULL | `'feed'` \| `'diaper'` \| `'bath'` |
| `feed_types` | TEXT NULL | feed 专用：JSON 数组文本，如 `["formula","breast_milk"]`，1–3 个、去重、按规范顺序存储 |
| `amount_ml` | INTEGER NULL | feed 专用：**总奶量**（1–2000）；仅亲喂时 NULL |
| `diaper_kind` | TEXT NULL | diaper 专用：`'pee'` \| `'poop'` \| `'mixed'` |
| `note` | TEXT NULL | ≤ 200 字符 |
| `happened_at` | INTEGER NOT NULL | |
| `created_at` | INTEGER NOT NULL | |

- 表级 CHECK：feed 行 `feed_types` 非空且 `diaper_kind` 为空；diaper 行 `feed_types`/`amount_ml` 为空且 `diaper_kind` 非空；bath 行三者全空。
- `PRAGMA user_version = 3`。打开旧库时自动迁移（事务内、幂等）：**v1**（单值 `feed_type` 列）→ 直接建 v3 表，`feed_type` → `feed_types` JSON 数组；**v2**（`kind` 仅 feed/diaper）→ 重建表放宽 `kind` CHECK（新增 bath），数据原样保留。迁移后 id/时间/备注/类型不变。
- 索引：`(happened_at DESC, id DESC)`、`(kind, happened_at DESC, id DESC)`。

**喂奶类型枚举**（规范顺序：formula → breast_milk → breast_direct）：

| 值 | 中文 |
| --- | --- |
| `formula` | 奶粉 |
| `breast_milk` | 母乳（瓶喂） |
| `breast_direct` | 亲喂 |

**Event JSON（v3）**：

```json
{
  "id": 12,
  "kind": "feed",
  "feedTypes": ["formula", "breast_milk"],
  "amountMl": 120,
  "diaperKind": null,
  "note": null,
  "happenedAt": 1763000000000,
  "createdAt": 1763000005000
}
```

diaper：`feedTypes: null, amountMl: null, diaperKind: "pee"`；
bath：`{ "kind": "bath", "feedTypes": null, "amountMl": null, "diaperKind": null, "note": null, ... }`（洗澡只有 note/时间）。

**错误响应**：`{ "error": "invalid_amount", "message": "奶量必须是 1 到 2000 之间的整数（毫升）" }`，`message` 为中文可直接展示。状态码：400/404/405/413/415/500。

## 5. HTTP API（v2）

服务默认 `0.0.0.0:3000`，同时托管 `web/`（可关，见配置）。`/api/*` 返回 JSON。

### 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `DB_PATH` | `<repo>/data/baby.db` | |
| `SERVE_WEB` | `1` | `0` 时纯 API，不托管静态文件 |
| `WEB_DIR` | `<repo>/web` | 静态目录 |
| `CORS_ORIGINS` | `*` | 允许的来源，逗号分隔；`*` 允许所有（无鉴权的家庭内网应用） |

### CORS

所有 `/api/*` 响应带 `Access-Control-Allow-Origin`（`*` 或匹配来源）；`OPTIONS` 预检返回 `204` + `Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS` + `Access-Control-Allow-Headers: Content-Type` + `Access-Control-Max-Age: 86400`。静态文件响应不需要 CORS。

### GET /api/health

`200 { "ok": true }`

### POST /api/feedings

```json
{ "feedTypes": ["formula", "breast_milk"], "amountMl": 120, "note": "夜里那次", "happenedAt": 1763000000000 }
```

- `feedTypes`：必填数组，1–3 个、去重、取值合法。
- `amountMl`：`feedTypes` 含 `formula` 或 `breast_milk` 时**必填**，整数 1–2000；仅 `breast_direct` 时必须省略或为 null（否则 `400 unexpected_amount`）。
- 兼容 v1 旧客户端：允许 `{ "feedType": "formula", "amountMl": 120 }`，服务端归一化为 `feedTypes: ["formula"]`。
- `happenedAt` 可选（默认 now；≥2000-01-01 且 ≤ now+5min）；`note` 可选（trim 后 ≤200）。
- 成功 `201 { "event": Event }`。
- 错误码：`invalid_feed_types` / `invalid_amount` / `unexpected_amount` / `invalid_happened_at` / `invalid_note` / `invalid_json` / `415 unsupported_media_type` / `413 payload_too_large`。

### POST /api/diapers

```json
{ "diaperKind": "poop", "happenedAt": 1763000000000, "note": null }
```

`diaperKind` ∈ `pee` / `poop` / `mixed`；成功 `201 { "event": Event }`；错误 `invalid_diaper_kind` 等。

### POST /api/baths

```json
{ "happenedAt": 1763000000000, "note": "洗香香" }
```

记录一次洗澡：两个字段都可选（`happenedAt` 规则同 feedings；`note` ≤200）。成功 `201 { "event": Event }`（`kind:"bath"`，其余业务字段为 null）。错误：`invalid_happened_at` / `invalid_note` / `invalid_json` / 415 / 413。

### GET /api/stats?days=7&tzOffset=-480

最近 N 天按天聚合（用于折线趋势图），`days` 整数 1–90，默认 7；`tzOffset` 规则同 state。响应：

```json
{
  "days": 7,
  "startDate": "2026-11-11",
  "endDate": "2026-11-17",
  "daily": [
    {
      "date": "2026-11-11",
      "feedCount": 5, "totalMl": 600,
      "formulaCount": 4, "breastMilkCount": 2, "breastDirectCount": 1, "mixedFeedCount": 1,
      "diaperCount": 8, "peeCount": 5, "poopCount": 3, "mixedCount": 0,
      "bathCount": 1
    }
  ]
}
```

- `daily` 按日期升序、连续 N 天（最后一天是今天），没有记录的日子补 0。
- 错误：`invalid_days`（非法/超范围）、`invalid_tz_offset`。

### GET /api/state?tzOffset=-480

```json
{
  "now": 1763001234000,
  "lastFeeding": Event | null,
  "lastDiaper": Event | null,
  "lastBath": Event | null,
  "recent": [Event ...30],
  "today": {
    "date": "2026-11-13",
    "feedCount": 5,
    "totalMl": 600,
    "formulaCount": 4,
    "breastMilkCount": 2,
    "breastDirectCount": 1,
    "mixedFeedCount": 1,
    "diaperCount": 8,
    "peeCount": 5,
    "poopCount": 3,
    "mixedCount": 0,
    "bathCount": 1
  }
}
```

- `feedCount`：喂奶事件数（含亲喂）。`totalMl`：奶量合计（不含亲喂）。`formulaCount`/`breastMilkCount`/`breastDirectCount`：**含该标签的事件数**。`mixedFeedCount`：`feedTypes.length > 1` 的事件数。
- （v1 的 `formulaMl`/`breastMl` 已移除：多选后无法拆分类型奶量。）
- `bathCount`：洗澡事件数。`lastBath`：最近一次洗澡（Event | null）。
- **「距上次换尿布」计时**：前端/CLI 取 `lastDiaper` 与 `lastBath` 中发生时间较晚者（洗澡也视为一次清洁/换尿布，重置计时），文案为「距上次换尿布/洗澡」。
- `recent` 最近 30 条，`happenedAt DESC, id DESC`。`tzOffset` 可选，省略用服务器本地时区。
- 前端/CLI 用本地时钟算「距离上次喂奶」，不要用服务端 `now` 倒计时。

### GET /api/events?limit=50&before=<epochMs>&beforeId=<id>

`200 { "events": [Event...] }`，`limit` 1–200 默认 50；只传 `before` 时严格 `happened_at < before`；`before`+`beforeId` 为复合游标（同毫秒可继续翻页）。

### DELETE /api/events/:id

`204`；不存在 `404 { "error": "not_found" }`。

### GET /api/export.csv

`200 text/csv; charset=utf-8`，UTF-8 BOM，`Content-Disposition: attachment; filename="baby-milk-YYYY-MM-DD.csv"`，按 `happenedAt ASC`。表头 `时间,类别,项目,奶量(ml),备注`：喂奶「项目」= 标签中文以 ` + ` 连接（如 `奶粉 + 母乳（瓶喂）`）；大小便为 `小便`/`大便`/`大小便`；洗澡为 `类别=洗澡, 项目=洗澡`；奶量为总奶量或空。

### GET /api/events/stream（SSE 多端实时同步）

长连接事件流，`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no`（跨源时带常规 CORS 头）。连接建立后立即收到：

```
retry: 3000
: connected
```

之后服务端在**任何客户端**新增/删除记录时向所有连接广播（`event: change`）：

```
event: change
data: {"type":"feed","event":{...完整 Event...}}
```

```
event: change
data: {"type":"diaper","event":{...}}
```

```
event: change
data: {"type":"bath","event":{...}}
```

```
event: change
data: {"type":"delete","id":12}
```

- 心跳：默认每 25 秒发送注释帧 `: ping`（`createApp({ sseHeartbeatMs })` 可调，测试用）。
- 浏览器 `EventSource` 会按 `retry` 自动重连；服务端关闭时会主动结束所有连接。
- web 端行为：收到 `change` → 幂等应用（同一 id 只应用一次，避免与本人 POST 响应竞态重复计数）；`delete` → 从本地移除；断线重连成功后静默全量校准一次。
- CLI 不强制订阅；CLI 每次命令本来就直接读服务端，天然一致。

### 静态文件

`SERVE_WEB=1` 时：`GET /` → `web/index.html`，其余按 `web/` 路径返回；`Cache-Control: no-cache`、`X-Content-Type-Options: nosniff`；HTML 带 CSP（`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; manifest-src 'self'; connect-src *`，其中 `connect-src *` 是为了跨源访问独立部署的 API）；防目录穿越。`SERVE_WEB=0` 时静态请求返回 404 JSON，提示 web 需独立托管。

> `feedTypes` 必须是数组（`["formula"]`）；只接受 v1 旧字段 `feedType`（单值字符串）并自动包装为数组，两者同时出现时以 `feedTypes` 为准。

## 6. web/ 前端规格（v2）

除类型多选外，v1 的视觉/交互/技术约束全部保留（手机优先、暖色、≥48px 点击区、深色模式、safe-area、无外部资源、CSP 禁内联脚本、原生 ESM、零构建）。

### 6.1 API 地址可配置（前后端分离关键）

- `web/config.js`（非 module，普通脚本，在 `app.js` 之前加载）：
  ```js
  window.NAIJI_CONFIG = { apiBase: '' }; // 留空 = 同源（由 server 托管时）
  ```
- `web/lib/api.js`：`apiUrl(path)` = `(apiBase || '').replace(/\/$/, '') + path`。
- 支持 URL 参数覆盖：`?api=http://192.168.1.10:3000`，持久化到 `localStorage['naiji.apiBase']`；优先级：URL 参数 > localStorage > `window.NAIJI_CONFIG.apiBase`。
- 所有请求（含导出 CSV 链接的 href）都经由 `apiUrl()`。

### 6.2 多选喂奶类型（核心变更）

- 三个类型按钮为**多选 toggle**（`aria-pressed` true/false，视觉上有勾选感）：`data-testid="type-formula"` / `type-breast-milk` / `type-breast-direct`，点击切换选中。
- **至少保持一个选中**：点击唯一已选中的类型时保持选中（可选提示）。
- 选择持久化到 `localStorage`（规范顺序保存），默认 `["formula"]`。
- 奶量面板显示条件：选中集合包含 `formula` 或 `breast_milk`。面板标题显示当前标签，如「奶量 · 奶粉 + 母乳（瓶喂）」。
- 点击奶量快捷按钮（30/60/90/120/150/180 ml）或自定义「记录」→ `POST /api/feedings`，`feedTypes` = 当前全部选中标签，`amountMl` = 该奶量 → **一次点击一条记录**，toast「已记录 奶粉 + 母乳 120 ml」+ 撤销。
- 仅选中 `breast_direct` 时：显示「🤱 亲喂一次」按钮（`record-breast-direct`），`POST { feedTypes: ["breast_direct"] }`。
- 同时选中亲喂 + 瓶喂标签时：仍显示奶量面板，并给一行小提示「奶量填写本次补充的瓶喂量」。
- 时间线/今日汇总：标题用 `eventTitle(event)`（如「奶粉 + 母乳（瓶喂） 120 ml」）；今日汇总格式「喂奶 N 次 · 奶量 M ml · 亲喂 K 次 · 小便 X · 大便 Y」。
- **浏览器标签标题（document.title）**：有上次喂奶时显示 `距上次 X 小时 X 分钟 · 奶记`（用 `formatDuration`，与 Hero 同源、随 Hero 每秒刷新；不足 1 分钟时显示 `刚刚喂过 · 奶记`）；没有记录/未加载时为 `奶记 · 婴儿喂养记录`。用于切到其他标签页时瞥一眼间隔。
- **多端实时同步 + 手动刷新**：
  - 顶栏「刷新」按钮（`data-testid="refresh"`，44×44、`aria-label="刷新最新数据"`）：点击 → `GET /api/state` 拉取最新数据，以服务端为准重置时间线（回到最近 30 条）与聚合；刷新中按钮禁用+转圈，完成后 toast「已刷新最新数据」，失败显示后端消息。写操作进行中不触发，避免与 POST 竞态。
  - `EventSource` 订阅 `apiUrl('/api/events/stream')`：收到新增 → 幂等插入时间线、更新 Hero/今日汇总，并 toast「已同步 xxx」（本人操作的回声跳过；若当前有可撤销 toast 则不打断）；收到删除 → 从本地移除；opened 后断线重连成功 → 静默全量校准。
  - 页面 `visibilitychange` 回到前台时静默校准一次（覆盖「切走期间别人记录」的场景）。
  - 不支持 `EventSource` 的浏览器降级为每 30 秒静默轮询。
  - 其他端记录后，Hero 倒计时/标签标题/今日汇总/时间线均无需刷新即更新；手动刷新用于兜底和手动确认。
- 其余（Hero 实时「距离上次喂奶 X 小时 X 分钟」、撤销 toast、时间线按天分组、加载更多、删除确认、加载失败重试、深色模式、PWA、`data-testid` 集合）与 v1 相同，不得回退。

### 6.3 web/lib/format.js（浏览器 + tests 共用，测试依赖）

| 函数 | 行为 |
| --- | --- |
| `formatDuration(ms)` | 同 v1（刚刚 / N 分钟 / H 小时 M 分钟 / D 天 H 小时） |
| `formatClock(ts)` / `formatDayKey(ts)` / `formatDayLabel(ts, now?)` / `formatAmount(ml)` | 同 v1 |
| `feedTypeLabel(type)` | `奶粉` / `母乳（瓶喂）` / `亲喂` |
| `feedTypesLabel(types)` | 按规范顺序用 ` + ` 连接的中文标签，如 `奶粉 + 母乳（瓶喂）`；空数组 → `''` |
| `diaperKindLabel(k)` | `小便` / `大便` / `大小便` |
| `eventTitle(ev)` | 喂奶：有奶量 → `标签文案 + " " + 奶量`（如 `奶粉 + 母乳（瓶喂） 120 ml`）；无奶量 → 标签文案（`亲喂`）；大小便 → 中文；洗澡 → `洗澡` |
| `eventIcon(ev)` | 喂奶：含 formula → `🍼`；否则含 breast_milk → `🥛`；否则 `🤱`；大小便：💧/💩/🚼；洗澡 → `🛁` |

### 6.4 洗澡事件与趋势统计（v3 新增）

**洗澡**
- 「记录大小便」卡片增加第三个一键按钮「🛁 洗澡」（`data-testid="record-bath"`），点击 `POST /api/baths` → toast「已记录 洗澡」+ 撤销，时间线出现「🛁 洗澡」，今日汇总加「洗澡 N 次」。
- Hero 第三行改为**「距上次换尿布/洗澡」**：取 `lastDiaper` 与 `lastBath` 中较晚者计算 `formatDuration`（洗澡重置计时）；两者都无 → 「还没有换尿布/洗澡记录」；对应 `data-testid="gap-last-diaper"` 保持不变。
- 实时同步：SSE `bath` 事件与其他事件同样即时应用。

**趋势统计卡片（折线图，零依赖手绘 SVG）**
- 位置：「今日汇总」之后、「记录时间线」之前。
- 结构：标题「趋势」+ 范围切换（`7 天` / `30 天`，`data-testid="stats-range-7"` / `stats-range-30`，默认 7 天）+ 指标切换 chips + SVG 折线图 + 一行汇总。
- 指标（`data-testid="stats-metric-<key>"`）：`totalMl`(奶量 ml)、`feedCount`(喂奶次数)、`breastDirectCount`(亲喂)、`peeCount`(小便)、`poopCount`(大便)、`bathCount`(洗澡)。默认 `totalMl`。
- 数据：`GET /api/stats?days=<7|30>&tzOffset=<client offset>`，切换范围时拉取并缓存；收到 SSE 变更后若趋势卡可见则静默重拉当前范围。
- 折线：X 轴为天（7 天视图显示每个日期 MM-DD；30 天视图每 5 天一个标签），Y 轴 0..max（全 0 时按 1 处理），3 条网格线 + 数值；折线 + 面积渐变 + 数据点；7 天视图在点上方显示数值，30 天视图只标最高点。全部为内联 SVG（无外部库、无 canvas 依赖；折线可用 `path`/`polyline` + `circle` 数据点实现，验收不限定具体 SVG 标签）。
- 汇总行：`N 天合计 X · 日均 Y · 最高 M（MM-DD）`，单位随指标（奶量 ml，其余为次）。
- 空状态：最近 N 天全 0 时显示「最近 N 天还没有数据」提示，但仍画 0 基线。
- 动效/无障碍：`role="img"` + `aria-label` 概括（如「最近 7 天奶量趋势」）；`prefers-reduced-motion` 下不做路径动画；`data-testid="stats-chart"` 容器、`stats-summary` 汇总行。

**data-testid 新增**：`record-bath`、`stats-card`、`stats-range-7`、`stats-range-30`、`stats-metric-<key>`、`stats-chart`、`stats-summary`。

## 7. cli/ 命令行工具（v3）

零依赖 Node CLI，命令名 `naiji`（`node cli/bin/naiji.mjs`；`npm link` 或 `nix develop` 后可直接 `naiji`）。

### 7.1 服务器地址解析（优先级从高到低）

1. `--server <url>` 命令行参数
2. 环境变量 `NAIJI_SERVER`
3. 配置文件 `$XDG_CONFIG_HOME/naiji/config.json`（默认 `~/.config/naiji/config.json`）的 `{ "server": "http://..." }`
4. 默认 `http://127.0.0.1:3000`

`naiji config set server <url>` 写配置；`naiji config show` 显示当前生效地址与来源。

### 7.2 命令

| 命令 | 说明 |
| --- | --- |
| `naiji`（无参数）/ `naiji status` / `naiji s` | 状态卡：距离上次喂奶、上次详情、距上次换尿布/洗澡（取 lastDiaper/lastBath 较晚者）、今日汇总（含洗澡次数） |
| `naiji feed <ml>` / `naiji f <ml>` | 记录喂奶；`-t, --type <list>` 类型，逗号分隔或重复，取值 `formula`/`breast_milk`/`breast_direct`（中文别名 奶粉/母乳/亲喂 也接受）；默认 `formula`。`--direct` 等价于追加 `breast_direct` 标签 |
| `naiji feed --direct` / `naiji f --direct` | 仅亲喂（不带奶量） |
| `naiji pee` / `naiji p` | 记录小便（`--note`） |
| `naiji poop` / `naiji o` | 记录大便（`--note`） |
| `naiji diaper <pee\|poop\|mixed>` / `naiji d ...` | 完整形式 |
| `naiji bath` / `naiji b` | 记录洗澡（`--note`、`--ago`、`--at`、`--json` 同其它记录命令） |
| `naiji log [-n 10]` / `naiji l` | 最近记录（按天分组，紧凑一行一条） |
| `naiji today` | 今日记录 + 今日汇总 |
| `naiji undo` / `naiji u` | 删除最近一条记录（打印被删内容） |
| `naiji rm <id>` | 删除指定 id |
| `naiji export [--out <path>]` | 导出 CSV；无 `--out` 时输出到 stdout |
| `naiji config [show\|set <key> <value>]` / `naiji c` | 配置 |
| `naiji help [command]` / `-h` | 帮助 |

### 7.3 全局选项与行为

- `--server <url>`、`--json`（机器可读输出，脚本友好）、`--no-color`、`--ago <分钟>`（回溯记录时间）、`--at <HH:MM|YYYY-MM-DD HH:MM>`（指定当天/绝对时间）、`--note <text>`、`-h/--help`、`-V/--version`。
- `--ago`/`--at` 与 `--json` 对 `feed`/`pee`/`poop`/`diaper`/`bath` 有效；时间不合法 → 用法错误。
- 退出码：`0` 成功；`1` API/网络错误（stderr 输出后端 `message`）；`2` 用法错误（打印帮助提示）。
- 输出中文、带颜色（`NO_COLOR`/`--no-color`/非 TTY 时降级为纯文本）；`status` 参考：

```
🍼 距离上次喂奶  3 小时 25 分钟
   上次 09:35 · 母乳（瓶喂） 90 ml
💧 距上次换尿布/洗澡  1 小时 5 分钟
   上次 12:30 · 洗澡
今日 喂奶 4 次 · 奶量 360 ml · 亲喂 1 次 · 小便 2 · 大便 1 · 洗澡 1
```

- 网络错误提示包含服务器地址与排查建议（服务是否启动 / `--server` / `NAIJI_SERVER`）。
- 交互式确认：`undo`/`rm` 在 TTY 下可用 `y/N` 确认（`--yes` 跳过；非 TTY 默认执行，避免脚本卡住）。`--json` 时输出结构化结果。

### 7.4 CLI 测试（cli/test/*.test.js，`node --test` 自动发现）

必须覆盖：参数解析（类型解析/中文别名/多类型/未知参数）、`--ago`/`--at` 时间解析、配置优先级、`formatDuration` 等纯函数、以及用本地 stub HTTP server（node:http）验证请求体与错误处理（不依赖真实 server）。

## 8. 测试与验收

- `npm test`（`node --test` 自动发现 `test/**`、`cli/test/**`）全绿，用临时数据库，不污染 `data/`。
- `test/`（tests teammate）覆盖：v1→v2 迁移、多标签校验、state 聚合（feedCount/totalMl/各标签 count/mixedFeedCount）、CORS/OPTIONS、`SERVE_WEB=0`、CSV 多标签项目名、分页、静态度量等。
- `test/sse.test.js` 覆盖：SSE 响应头/CORS/初始帧、新增喂奶/大小便/**洗澡**广播、删除广播、多客户端同时收到、心跳帧、关闭应用结束连接。
- `test/stats.test.js` 覆盖：`buildDailyStats` 7/30 天连续升序、无记录补 0、跨时区边界、bath/feed/diaper 计数、非法 days；`test/migration.test.js` 增加 **v2→v3**（结构不变、放宽 kind CHECK）与 v1→v3 用例，断言 `user_version=3` 且数据不丢。
- API 测试新增：`POST /api/baths`（成功/note/happenedAt/非法 JSON/415/413）、`GET /api/stats`（默认 7、1/30/90、0/91/abc/1.5、tzOffset 非法、响应形状）、state 的 `lastBath`/`bathCount`、CSV 洗澡行。
- `scripts/browser-e2e.mjs`（QA）覆盖 v2 前端：多选类型 → 一键记录 → toast/Hero/汇总/时间线；撤消；删除；深色/窄屏/无横向滚动；console/网络无异常；截图更新到 `docs/screenshots/`。
- 多端同步验收（真实浏览器 + 第二客户端直接调 API）：页面无需刷新即更新 Hero/标签标题/今日汇总/时间线；其他端删除后记录实时消失；刷新按钮转圈/toast/恢复可用；320px 无横向滚动、刷新按钮点击区 ≥44px、console 无错误。
- v3 验收：洗澡按钮一键记录 → 时间线/汇总/CSV 正确、Hero「距上次换尿布/洗澡」被重置；趋势卡 7/30 天切换、6 个指标切换、折线点数与 API 数据一致、空状态提示、无横向滚动、console 无错误；CLI `naiji bath` 与 status/今日汇总一致。
- QA 还要做 **CLI 端到端**：真实启动 server + 临时 DB，spawn CLI 执行 `status/feed/pee/log/undo/export`，断言输出与服务端数据一致。
- QA 还要验证**前后端分离**：用 `scripts/serve-web.mjs` 在另一个端口托管 `web/`，把 `config.js` 的 `apiBase`（或 `?api=`）指向 API 端口，确认页面跨源正常记录（依赖 server CORS）。
- 验收结论写入 `docs/qa-report.md`（v2，P0/P1/P2 + 截图 + CLI 证据）。
