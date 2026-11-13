# 奶记 · 婴儿喂养记录 — 接口与实现契约

> 这是前后端 / 测试并行开发的唯一事实来源。所有实现必须与本文一致；需要变更时先改本文再改代码。

## 1. 目标与范围

一个给新手爸妈用的手机端 Web App（局域网内手机浏览器访问），记录：

1. **一键喂奶**：奶粉 / 母乳（瓶喂）/ 亲喂，记录奶量（ml）。
2. **一键大小便**：小便 / 大便（可选混合）。
3. **距上次喂奶时间**：实时显示「距离上次喂奶 X 小时 X 分钟」。
4. 今日汇总 + 历史记录（可删除/撤销）+ CSV 导出。

技术栈（硬约束，**零第三方依赖，不需要 npm install / 构建步骤**）：

- 后端：Node.js `node:http` + `node:sqlite`（Node ≥ 22.13，开发环境 Node 24）。
- 数据库：SQLite 单文件，默认 `data/baby.db`（`DB_PATH` 环境变量可覆盖）。
- 前端：原生 HTML + CSS + ES Module JS，静态文件放 `public/`，由同一个 Node 服务托管。
- 测试：`node --test`。

## 2. 目录结构与职责

```
baby-milk-tracker/
├── package.json            # Lead：scripts / engines（无 dependencies）
├── flake.nix / .envrc      # Lead：nix devShell
├── docs/CONTRACT.md        # Lead：本文件
├── README.md               # Lead：运行说明
├── src/
│   ├── server.js           # Lead：HTTP 服务、路由、静态托管、校验
│   ├── db.js               # Lead：SQLite schema + Store
│   ├── state.js            # Lead：buildState(store, now, tzOffset) → /api/state 响应
│   └── util/time.js        # Lead：dayBounds / isValidTzOffset（纯函数，可单测）
├── public/                 # 前端 teammate 独占：index.html / app.css / app.js / manifest / icon
│   └── lib/format.js       # 共享格式化纯函数（浏览器 + node 测试共用；Lead 初版，前端可追加但保持现有导出兼容）
├── test/                   # 测试 teammate 独占：*.test.js
├── scripts/                # QA teammate 独占：浏览器端到端检查脚本
└── data/                   # 运行时生成，gitignore
```

**时间约定**

- 数据库与 API 中所有时间戳均为 **epoch 毫秒（number）**，不是 ISO 字符串。
- 展示时用浏览器本地时区（前端）；服务端「今天」的边界由 `tzOffset` 决定（见 `/api/state`）。
- `tzOffset` 语义与 JS `Date.prototype.getTimezoneOffset()` 一致：**本地时间 = UTC - tzOffset 分钟**。例如东八区 `tzOffset = -480`（中国用户手机上传 `-new Date().getTimezoneOffset()` = `480`？注意：直接传 `new Date().getTimezoneOffset()` 的返回值，即 `-480`）。
  前端发送 `tzOffset = new Date().getTimezoneOffset()`（东八区为 `-480`）。

## 3. 数据模型

单表 `events`，喂奶和大小便统一存（便于时间线展示）：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | |
| `kind` | TEXT NOT NULL | `'feed'` \| `'diaper'` |
| `feed_type` | TEXT NULL | 喂奶专用：`'formula'` \| `'breast_milk'` \| `'breast_direct'` |
| `amount_ml` | INTEGER NULL | 喂奶专用；`formula` / `breast_milk` 必填 1–2000，`breast_direct` 必须为 NULL |
| `diaper_kind` | TEXT NULL | 大小便专用：`'pee'` \| `'poop'` \| `'mixed'` |
| `note` | TEXT NULL | 备注，≤ 200 字符 |
| `happened_at` | INTEGER NOT NULL | epoch ms，发生时间 |
| `created_at` | INTEGER NOT NULL | epoch ms，记录时间 |

外键约束由 `CHECK` 保证：`kind='feed'` 时 `feed_type` 非空且 `diaper_kind` 为空；`kind='diaper'` 反之。
索引：`(happened_at DESC, id DESC)` 与 `(kind, happened_at DESC, id DESC)`。

**API 返回的 Event JSON**（camelCase）：

```json
{
  "id": 12,
  "kind": "feed",
  "feedType": "formula",
  "amountMl": 120,
  "diaperKind": null,
  "note": null,
  "happenedAt": 1763000000000,
  "createdAt": 1763000005000
}
```

大小便事件：`kind:"diaper"`、`feedType:null`、`amountMl:null`、`diaperKind:"pee"`。

**错误响应格式**（所有 4xx/5xx）：

```json
{ "error": "invalid_amount", "message": "奶量必须是 1 到 2000 之间的整数（毫升）" }
```

`message` 为中文，可直接展示给用户。状态码：`400` 参数错误、`404` 资源不存在、`413` 请求体过大、`415` Content-Type 不支持、`500` 服务器错误。

## 4. HTTP API

服务默认 `0.0.0.0:3000`（`PORT` / `HOST` 环境变量可覆盖），同时托管 `public/`。
`/api/*` 返回 JSON；其余路径返回静态文件。

### GET /api/health

`200 { "ok": true }`

### POST /api/feedings

请求体（`Content-Type: application/json`）：

```json
{ "feedType": "formula", "amountMl": 120, "happenedAt": 1763000000000, "note": "夜里那次" }
```

- `feedType`：必填，`formula` / `breast_milk` / `breast_direct`。
- `amountMl`：`formula`、`breast_milk` 必填，整数 1–2000；`breast_direct` 必须省略或为 `null`。
- `happenedAt`：可选，整数 epoch ms，默认当前时间；必须 ≥ `2000-01-01T00:00:00Z` 且 ≤ 服务器当前时间 + 5 分钟。
- `note`：可选字符串，trim 后 ≤ 200 字符，空串视为 null。

成功 `201`：`{ "event": Event }`
失败：`400 invalid_feed_type` / `400 invalid_amount` / `400 unexpected_amount` / `400 invalid_happened_at` / `400 invalid_note` / `400 invalid_json` / `415 unsupported_media_type` / `413 payload_too_large`

### POST /api/diapers

```json
{ "diaperKind": "poop", "happenedAt": 1763000000000, "note": null }
```

- `diaperKind`：必填，`pee` / `poop` / `mixed`。
- 其余同 feedings（`happenedAt`、`note`）。
  成功 `201`：`{ "event": Event }`；失败 `400 invalid_diaper_kind` 等。

### GET /api/state?tzOffset=-480

返回首页需要的全部数据（一次请求渲染首屏）：

```json
{
  "now": 1763001234000,
  "lastFeeding": Event | null,
  "lastDiaper": Event | null,
  "recent": [ Event, ... ],
  "today": {
    "date": "2026-11-13",
    "feedCount": 5,
    "breastDirectCount": 1,
    "formulaMl": 480,
    "breastMl": 120,
    "totalMl": 600,
    "diaperCount": 8,
    "peeCount": 5,
    "poopCount": 3,
    "mixedCount": 0
  }
}
```

- `tzOffset` 可选，整数 −840..840；省略时用**服务器本地时区**。
- `today` 统计当天 `[dayStart, dayEnd)` 内的事件。`peeCount` 含 `mixed`，`poopCount` 含 `mixed`，`mixedCount` 单独计。`feedCount` 含亲喂。`totalMl = formulaMl + breastMl`。
- `recent` 为最近 30 条事件，按 `happenedAt DESC, id DESC`。
- `lastFeeding` 为最近一条 `kind='feed'` 事件（可能为 `breast_direct`），`lastDiaper` 同理；没有则 `null`。
- 前端**不要在服务端时间上做倒计时**，用本地 `Date.now()` 与 `lastFeeding.happenedAt` 计算间隔（避免时钟偏差），每秒刷新一次。

### GET /api/events?limit=50&before=<epochMs>&beforeId=<id>

分页历史，按 `happenedAt DESC, id DESC`。

- `limit`：1–200，默认 50。
- `before` / `beforeId`：游标（上一页最后一条的 `happenedAt` 和 `id`），返回更旧的数据。只传 `before` 时按 `happenedAt < before`。
- 响应 `200 { "events": [Event...] }`。

### DELETE /api/events/:id

- `204` 无响应体；不存在 `404 { "error": "not_found", "message": "记录不存在" }`。

### GET /api/export.csv

- `200 text/csv; charset=utf-8`（带 UTF-8 BOM，方便 Excel 打开），`Content-Disposition: attachment; filename="baby-milk-YYYY-MM-DD.csv"`。
- 按 `happenedAt ASC` 导出全部记录。
- 表头：`时间,类别,项目,奶量(ml),备注`
  - 时间：服务器本地时区 `YYYY-MM-DD HH:mm`
  - 类别：`喂奶` / `大小便`
  - 项目：喂奶为 `奶粉` / `母乳（瓶喂）` / `亲喂`；大小便为 `小便` / `大便` / `大小便`
  - 奶量：喂奶且有奶量时填数字，否则空
  - 备注：可为空

### 静态文件

- `GET /` → `public/index.html`；`GET /app.js` 等按 `public/` 下路径返回。
- MIME：html/css/js/json/svg/png/webmanifest/ico 等。
- 响应头：`Cache-Control: no-cache`、`X-Content-Type-Options: nosniff`；HTML 额外带 CSP：`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; manifest-src 'self'`。
- 防目录穿越：解析后的绝对路径必须位于 `public/` 内。

## 5. 前端规格（public/）

手机优先（iPhone Safari / Android Chrome），桌面可用；单页，无路由。

### 视觉与交互

- 中文界面，暖色调（奶油底 + 珊瑚/杏色主色），圆角卡片，大按钮（点击区 ≥ 48px），`env(safe-area-inset-*)` 适配，支持深色模式（`prefers-color-scheme`），字体用系统字体，不引用任何外部 CDN/字体/图片。
- 页面最大宽度 ~560px 居中；历史列表可滚动，主操作区不被遮挡。
- 所有记录操作**一键完成**：点击 → 立即 POST → 成功 toast「已记录 奶粉 120 ml」并带「撤销」按钮（5 秒内可撤销，调用 DELETE）。失败 toast 显示后端 `message`。请求中禁用对应按钮，防止连点重复记录。

### 版面（自上而下）

1. **顶部栏**：应用名「奶记」+ 小字「婴儿喂养记录」；右侧「导出 CSV」入口（`<a href="/api/export.csv" download>`）。
2. **Hero 卡片（核心）**：
   - 文案「距离上次喂奶」；下方超大数字 **`formatDuration(now - lastFeeding.happenedAt)`**，如「3 小时 25 分钟」，每秒刷新（`setInterval` 1s）。
   - 上次详情行：「上次 14:05 · 奶粉 120 ml」；无记录时显示「还没有喂奶记录」。
   - 次级信息：「距上次换尿布 1 小时 5 分钟」/「还没有大小便记录」。
3. **喂奶区**：
   - 类型分段选择：`奶粉` / `母乳·瓶喂` / `亲喂`（选中态明显；选择记忆到 localStorage）。
   - 奶粉/瓶喂时：奶量快捷按钮网格 `30 / 60 / 90 / 120 / 150 / 180 ml`，点击立即记录；再加「自定义」：数字输入框（`inputmode="numeric"`，默认 120）+「记录」按钮。
   - 亲喂时：一个大按钮「🤱 亲喂一次」，点击记 `breast_direct`（无奶量）。
4. **大小便区**：`💧 小便`、`💩 大便` 两个大按钮一键记录（可选「混合」入口不强制）。
5. **今日汇总条**：`喂奶 5 次 · 奶量 600 ml · 亲喂 1 次 · 小便 5 · 大便 3`（数据来自 `today`）。
6. **记录时间线**：按本地日期分组（今天 / 昨天 / 前天 / 日期 周几），最新在上；每条：时间（`HH:mm`）、图标、标题（如「奶粉 120 ml」）、备注、删除按钮（`×`，点击确认后 DELETE）。首屏显示最近 30 条；底部「加载更多」用 `/api/events` 游标翻页，无更多时隐藏。
7. **撤销 toast** 固定在底部，有安全区 padding。

### 必须有的 `data-testid`（QA 自动化依赖，勿改名）

| testid | 元素 |
| --- | --- |
| `gap-duration` | Hero 中「X 小时 X 分钟」文本容器 |
| `gap-last-feed` | 上次喂奶详情行 |
| `gap-last-diaper` | 距上次换尿布文本 |
| `type-formula` / `type-breast-milk` / `type-breast-direct` | 类型分段按钮 |
| `volume-chip-30` … `volume-chip-180` | 奶量快捷按钮 |
| `custom-amount-input` | 自定义奶量输入框 |
| `custom-amount-submit` | 自定义奶量记录按钮 |
| `record-breast-direct` | 亲喂按钮 |
| `record-pee` / `record-poop` | 大小便按钮 |
| `today-summary` | 今日汇总条 |
| `history-list` | 时间线容器 |
| `load-more` | 加载更多按钮 |
| `toast` / `toast-undo` | 撤销 toast 与撤销按钮 |
| `export-csv` | 导出链接 |
| `empty-state` | 无任何记录时的空状态（可选） |

### 实现约束

- 原生 JS ES Module（`<script type="module" src="/app.js">`），不要内联脚本（CSP）。
- 状态简单：内存中的 `state = { now, lastFeeding, lastDiaper, today, recent, cursor }`；记录成功后就地更新，或重新 `GET /api/state`（推荐：先 POST 拿返回的 event 更新 UI 与今日汇总；如实现复杂就重新拉 state，但要保证「距上次喂奶」立即刷新）。
- `public/lib/format.js` 已由 Lead 提供（见下节），**必须复用**，可追加新导出函数但不要改既有函数签名/行为。
- 添加 `manifest.webmanifest` + SVG 图标（`public/icon.svg`），`<meta name="theme-color">`、`apple-mobile-web-app-capable`，方便「添加到主屏幕」。不需要 Service Worker。

## 6. 共享前端工具库 public/lib/format.js

浏览器与 node 测试共用（纯函数、无 DOM/无时区依赖假设；展示用浏览器本地时区）。

| 函数 | 行为 |
| --- | --- |
| `formatDuration(ms)` | `< 60_000` → `刚刚`；`< 1h` → ``N 分钟``；`< 24h` → `H 小时 M 分钟`（M=0 时仅 `H 小时`）；`≥24h` → `D 天 H 小时`（H=0 时仅 `D 天`）。负数/NaN 视为 0 |
| `formatClock(ts)` | 本地 `HH:mm`，补零 |
| `formatAmount(ml)` | `120 ml`；null/undefined → `''` |
| `formatDayKey(ts)` | 本地日期 `YYYY-MM-DD` |
| `formatDayLabel(ts, now?)` | `今天` / `昨天` / `前天` / `11月12日 周三`；跨年时 `2025年11月12日` |
| `feedTypeLabel(t)` | `奶粉` / `母乳（瓶喂）` / `亲喂` |
| `diaperKindLabel(k)` | `小便` / `大便` / `大小便` |
| `eventTitle(ev)` | 喂奶：亲喂→`亲喂`，否则 `奶粉 120 ml`；大小便→`小便` |
| `eventIcon(ev)` | 喂奶：`🍼`（formula）/ `🥛`（breast_milk）/ `🤱`（breast_direct）；大小便：`💧` / `💩` / `🚼` |

## 7. 服务端纯函数（src/util/time.js，可单测）

| 函数 | 行为 |
| --- | --- |
| `dayBounds(nowMs, tzOffsetMinutes?)` | 返回 `{ start, end, dateKey }`：`start` 为该时区当天 0 点的 epoch ms，`end = start + 86400000`，`dateKey` 为 `YYYY-MM-DD`。`tzOffsetMinutes` 省略/null 时用服务器本地时区 |
| `isValidTzOffset(v)` | 整数且 −840 ≤ v ≤ 840 |

## 8. 测试与验收

- `npm test`（等价 `node --test`，自动发现 `test/*.test.js`；注意 Node 24 里 `node --test test/` 这种「目录位置参数」不可用，会报 MODULE_NOT_FOUND）全绿，使用临时目录数据库，不得污染 `data/`。
- 服务端测试：`createApp({ dbPath, publicDir })` 返回 `{ server, store, close }`，测试里 `server.listen(0)` 后访问。
- 前端测试：`format.js` 纯函数边界用例。
- 验收（QA）：真实启动服务 → 用浏览器（headless Chrome）打开首页，确认：
  1. 首屏显示「距离上次喂奶」且秒级刷新；
  2. 点奶量按钮后出现 toast、Hero 归零为「刚刚」、今日汇总增加、时间线新增一条；
  3. 点大小便按钮出现对应记录；
  4. 撤销可删除记录；
  5. 手机窄屏（390×844）无横向滚动、按钮不重叠。
