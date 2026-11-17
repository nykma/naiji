# 奶记 · 婴儿喂养记录 — v2 独立 QA 验收报告

> 验收角色：独立 QA（只读产品代码，仅产出 `scripts/browser-e2e.mjs`、`docs/screenshots/`、本报告；未修改 `server/`、`web/`、`cli/`、`test/`、`cli/test/`、`package.json`、`docs/CONTRACT.md`，已用文件 mtime 核对）。
> 验收对象：`/home/nykma/Project/nodejs/baby-milk-tracker`（v2：前后端分离三包 + 多选喂奶类型 + CLI）。
> 验收方式：**真实进程 + 真实浏览器 + 真实 CLI**，不 mock 产品逻辑：
> 1. 用真实 CLI 启动 `node server/src/server.js`（随机空闲端口 + 临时目录 SQLite）；
> 2. 用 `node scripts/serve-web.mjs` 在另一个随机端口独立托管 `web/`，页面通过 `?api=http://后端` 跨源访问（验证 CORS / OPTIONS 预检）；
> 3. `spawn cli/bin/naiji`（`node cli/bin/naiji.mjs` 与 shell 启动器都测）对同一后端跑完整 CLI 场景；
> 4. headless Chrome + CDP 驱动真实页面：真实鼠标点击多选 toggle、真实输入、真实 `window.confirm`、真实网络请求。
> v1 报告归档于 `docs/qa-report-v1.md`（保留未动），本文件为 v2 重写版。

## 0. 结论速览

| 项目 | 结果 |
| --- | --- |
| 端到端脚本 | `scripts/browser-e2e.mjs`（零第三方依赖；web + 跨源 + CLI 三块一次跑完，exit 0/1） |
| 最终执行结果 | **644 / 644 断言 PASS，exit 0**；连续 2 次运行分组明细逐行一致 |
| 单次耗时 | 约 **27.5s**（真实计时 `real 27.517s`，含 server/独立 web/Chrome 冷启动、CLI 30+ 次子进程与清理） |
| **Web 前端 E2E** | **336 / 336 PASS**（G00–G11、G13–G15、G18–G20） |
| **前后端分离 / 跨源** | **25 / 25 PASS**（G12：独立端口托管 + `?api=` + CORS 预检 + 跨源写入 + localStorage 回退） |
| **CLI 端到端** | **131 / 131 PASS**（G17：status/feed/pee/poop/log/today/undo/rm/export/config/--json/错误退出码） |
| 契约一致性（HTTP API / CORS / SERVE_WEB / v1→v2 迁移） | **152 / 152 PASS**（G16） |
| `npm test` 基线（QA 复跑） | **234 tests / 234 pass**（30 suites，全绿） |
| P0（阻断） | **0** |
| P1（明显体验问题） | **0** |
| P2（小瑕疵 / 可访问性） | **4 项**（另 2 项观感建议；v1 的 4 项 P2 已确认修复） |
| 上线结论 | **可以上线**（无阻断项；P2 建议随下个迭代修复） |

---

## 1. 环境与运行方式

### 1.1 实测环境

| 项 | 值 |
| --- | --- |
| OS / 内核 | Linux 7.2.13-xanmod1 x86_64（NixOS） |
| Node | `v24.21.0`（任务指定路径 `/nix/store/j1j9b0w3mhpccdli73ycj5w7nf6fkzqz-nodejs-24.21.0/bin/node`，`process.execPath` 解析为 `nodejs-slim-24.21.0`，满足 engines ≥22.13） |
| 浏览器 | Google Chrome 157.0.8103.38（headless，`--remote-debugging-port=0` + `DevToolsActivePort`，Node 内置 WebSocket 直连 CDP） |
| 显示模拟 | `Emulation.setDeviceMetricsOverride`，DPR=2：390×844 / 320×640 / 900×900；`prefers-reduced-motion: reduce` 冻结动效保证截图稳定 |
| 时间 | 2026-11-13 22:2x–22:32 CST；浏览器/CLI `tzOffset=-480` |
| 服务 | API：真实 CLI `node server/src/server.js`（`PORT=<空闲端口> HOST=127.0.0.1 DB_PATH=<mkdtemp>/qa-v2.db`）；独立 web：`node scripts/serve-web.mjs --port <空闲端口> --api <API>` |
| 端口策略 | **全部动态空闲端口**（`net.createServer().listen(0)`），无 4321/4323/4325 等固定端口，避免残留进程冲突 |
| 开发自测基线 | 我复跑 `node --test`：**234 tests / 234 pass** |

### 1.2 运行脚本

```bash
cd /home/nykma/Project/nodejs/baby-milk-tracker
/nix/store/j1j9b0w3mhpccdli73ycj5w7nf6fkzqz-nodejs-24.21.0/bin/node scripts/browser-e2e.mjs
echo $?   # 0 = 全部通过；1 = 有失败（末尾打印“失败明细”与分组统计）
# 调试：保留临时 DB / Chrome profile / CLI 配置
KEEP_ARTIFACTS=1 /path/to/node scripts/browser-e2e.mjs
```

脚本每次运行自动完成：临时目录 + 随机端口 → 真实 server CLI → 独立 `serve-web.mjs` → headless Chrome → 23 组断言 → 截图 → CLI 子进程 → 清理（关 CDP、SIGTERM/SIGKILL 进程组、删临时目录）。**不污染 `data/`、不写用户 `~/.config`（CLI 用临时 `XDG_CONFIG_HOME`）**，可重复执行。

### 1.3 可重复性证据（本次验收实际运行）

| 运行 | 断言结果 | 分组结果 | exit | 耗时 |
| --- | --- | --- | --- | --- |
| 最终版第 1 次 | **644 / 644 PASS** | 23 组全 PASS | 0 | 27.517s |
| 最终版第 2 次 | **644 / 644 PASS** | 与第 1 次逐行 diff 完全一致 | 0 | 约 27s |

（正式批量运行前另有 5 次调试/回归运行，均为独立临时 DB/端口/Chrome profile。）

### 1.4 脚本覆盖矩阵

| 块 | 分组 | 断言数 |
| --- | --- | --- |
| Web 前端 E2E | G00 环境启动、G01 首屏/空库/秒级刷新、G02 多选记录、G03 撤销、G04 单标签/仅亲喂/组合/至少一个/记忆、G05 自定义奶量、G06 大小便/连点防重、G07 删除 confirm、G08 持久化、G09 加载更多、G10 CSV、G11 失败重试、G13 响应式、G14 深色、G14b 无障碍、G15 空库、G18 边界、G19 控制台/网络、G20 截图 | 336 |
| 跨源部署 | G12 独立托管 + `?api=` + CORS 预检 + 跨源写入 + localStorage 回退 | 25 |
| 契约一致性 | G16 API 字段/错误码/CORS/SERVE_WEB=0/v1→v2 迁移/静态防护 | 152 |
| CLI 端到端 | G17 命令/JSON/退出码/优先级/导出/config/启动器 | 131 |

---

## 2. 验收清单逐项结果（v2 任务书要求）

### 2.1 Web 前端（多选类型）

| # | 验收项 | 结果 | 证据（关键断言值 / 截图） |
| --- | --- | --- | --- |
| 1 | 首屏 200、`gap-duration` 非空且格式正确、秒级刷新 | **PASS** | G01：首屏 `GET / → 200`；空库 `还没开始`；注入 90 分钟前记录后 `1 小时 30 分钟`；注入 2m50s 前记录后 `2 分钟` → ~10.5s 内自动变 `3 分钟`。截图 `screenshots/mobile-390.png` |
| 2 | **多选奶粉 + 母乳** → 点 120ml → toast / Hero / 汇总 / 时间线全对 | **PASS** | G02：两个 toggle `aria-pressed=true`；`POST /api/feedings → 201`；toast `已记录 奶粉 + 母乳（瓶喂） 120 ml`；Hero `刚刚`；`today.totalMl 180→300`、`feedCount/formulaCount/breastMilkCount/mixedFeedCount` 各 +1；时间线首条 `奶粉 + 母乳（瓶喂） 120 ml`；服务端记录 `feedTypes=["formula","breast_milk"], amountMl=120`。截图 `screenshots/multi-select-390.png`（含 toast） |
| 3 | 撤销 | **PASS** | G03：`DELETE → 204`；服务端事件数恢复；被撤销 id 无残留；Hero 回退上一条；toast「已撤销」 |
| 4 | 单标签（奶粉 / 母乳瓶喂）、仅亲喂、亲喂 + 奶粉组合 | **PASS** | G04（44 断言）：单标签 toast/标题/统计正确；仅亲喂时奶量面板隐藏、`amountMl=null`、`totalMl` 不变、`breastDirectCount+1`；亲喂+奶粉时奶量面板 + 「奶量填写本次补充的瓶喂量」提示可见、记录 `["formula","breast_direct"]` 且总奶量 60、`mixedFeedCount+1`。截图 `screenshots/mobile-390-after-record.png` |
| 5 | 至少保留一个类型 + 类型记忆 | **PASS** | G04：再点唯一选中项 → toast「至少要保留一种喂奶类型」且保持选中；`localStorage['naiji.feedTypes']="[\"formula\",\"breast_direct\"]"`；刷新后选中态保持 |
| 6 | 自定义奶量 + 前端范围校验 | **PASS** | G05：999ml → 201、toast/标题/统计正确；2001 被前端拦截（无 POST）；toast 撤销按钮 44px 达标 |
| 7 | 大小便 / 连点防重复 | **PASS** | G06：pee/poop → 201、计数 +1、时间线出现；挂起首个 POST 时按钮 `disabled=true`，连点两次只产生 1 次 POST/1 条记录 |
| 8 | 删除（window.confirm） | **PASS** | G07：`Page.javascriptDialogOpening` type=confirm；accept 后 `DELETE → 204`；DOM/API 消失；删除最新喂奶后 Hero 回退正确；toast「已删除这条记录」 |
| 9 | 刷新持久化 | **PASS** | G08：刷新后条数 = min(30,总数)、首条/ Hero/类型选择正确。截图 `screenshots/mobile-390-full.png`（整页） |
| 10 | 加载更多 | **PASS** | G09：造 45 条（单/多标签/大小便）→ 总 60 条；首屏 30 条 + 按钮；点击后 `GET /api/events → 200`，DOM 变 60 条、无重复、按钮隐藏、日期分组/多标签标题正常 |
| 11 | CSV 导出 | **PASS** | G10：同源 href `/api/export.csv`；BOM；表头；记录数 = 全部事件；项目列含 `奶粉 + 母乳（瓶喂）`、`奶粉 + 亲喂`；逗号/引号转义；时间升序 |
| 12 | 320 / 390 / 900 无横向滚动、点击区 ≥44px、不重叠 | **PASS** | G13（60 断言）：三视口 `scrollWidth == innerWidth`；chip/大小便按钮两两无重叠；桌面 `main` 宽 560px 居中。截图 `screenshots/mobile-320.png`、`screenshots/desktop-900.png` |
| 13 | 深色模式 | **PASS** | G14：背景 `rgb(255,248,242)→rgb(23,17,16)`、文字/卡片均变化；正文对比度 13.01:1 / 14.86:1。截图 `screenshots/dark-390.png` |
| 14 | console error / 未捕获异常 / 4xx-5xx 为 0 | **PASS** | G19：`console.error=0`、`exceptionThrown=0`、`Log.entryAdded(error)=0`、非 cancel 网络失败 0、浏览器 4xx/5xx **0**；6 条主动注入的预期错误已精确标注（见第 9 节） |
| 15 | 空库状态 | **PASS** | G15：清空后 empty-state 可见、汇总全 0、Hero「还没开始/还没有喂奶记录」、`/api/state` null/空。截图 `screenshots/empty-390.png` |
| 16 | 截图输出（v1 同名 + 新增多选/跨源） | **PASS** | G20：9 张必需截图（`mobile-390`、`mobile-390-after-record`、`mobile-390-full`、`mobile-320`、`desktop-900`、`dark-390`、`empty-390`、`multi-select-390`、`cross-origin-390`）均生成且尺寸正确；附加 `error-390.png` |

### 2.2 前后端分离 / 跨源部署（G12，25/25 PASS）

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| `scripts/serve-web.mjs` 在独立空闲端口托管 `web/` | **PASS** | 实测 `http://127.0.0.1:<webPort>`，横幅「奶记 web」，与 API（另一端口）完全分离 |
| 页面 `?api=http://API` 跨源访问 | **PASS** | 页面 origin = web 静态服务；`GET /api/state` 跨源 200；无 `load-error`；Hero 显示「上次 …」 |
| 导出链接经 `apiUrl()` 指向后端 | **PASS** | `href="http://127.0.0.1:<apiPort>/api/export.csv"` |
| `?api=` 持久化 | **PASS** | `localStorage['naiji.apiBase'] === apiBase`；不带参数重新打开页面自动回退到该地址并正常加载数据 |
| CORS 预检 + 跨源写入 | **PASS** | 点 120ml：先 `OPTIONS /api/feedings → 204`（ACAO `*`、Allow-Methods 含 POST、Allow-Headers 含 content-type），再 `POST → 201`；toast 正确；API `totalMl +120`、记录 `feedTypes` 正确；跨源 `GET /api/state` 响应均带 `Access-Control-Allow-Origin: *` |
| 跨源页面视觉/功能 | **PASS** | 与同源页面完全一致（同一份 web/ 静态资源，仅 API 基址不同）。截图 `screenshots/cross-origin-390.png` |
| 切回同源 | **PASS** | 清除持久化后回到 API 页面：导出链接恢复相对地址、无 apiBase 残留 |

### 2.3 CLI 端到端（G17，131/131 PASS，同一临时后端）

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| `status` / 无参数 / `s` 别名 | **PASS** | `--json` 的 `today` 与 `GET /api/state` 逐字段一致；文本模式含「还没有喂奶记录/今日」；无参数默认 status |
| `feed` 多标签 `-t`（重复 / 逗号 / 中文别名） | **PASS** | `-t formula -t breast_milk` → `["formula","breast_milk"]`；`-t 奶粉,母乳` 同样解析；规范顺序；服务端 totalMl/计数一致 |
| `feed --direct`（仅亲喂） | **PASS** | `feedTypes=["breast_direct"]`、`amountMl=null`、`totalMl` 不变 |
| `feed` 组合（`-t formula -t breast_direct`） | **PASS** | `["formula","breast_direct"]`，总奶量 60，`mixedFeedCount+1` |
| `--ago 30` | **PASS** | happenedAt 与 30 分钟前差 40ms（在 ±5s 容差内） |
| `--at "HH:MM"` / 绝对时间 | **PASS** | 本次 22 点运行走 HH:MM 分支：happenedAt 精确等于本地「2 小时前」时间戳 |
| `--note` | **PASS** | 记录写入 note，`log` 文本输出含备注 |
| `pee` / `poop` / `d mixed` | **PASS** | `diaperKind` 分别 pee/poop/mixed；服务端 diaperCount=3、peeCount=2、poopCount=2、mixedCount=1 |
| `log -n 3` | **PASS** | 3 条且顺序/ id 与 `GET /api/events` 完全一致 |
| `today` | **PASS** | 日期、汇总（8 字段）与 `/api/state` 一致；events 只含当天 |
| `undo` | **PASS** | 删除最新一条（id 与 API 最新一致），服务端消失 |
| `rm <id>` / 不存在 id | **PASS** | 指定 id 删除成功；`rm 999999 --json` → exit 1，stderr JSON `{ok:false,error:"not_found",message:"记录不存在"}` |
| `export --out` / stdout / `--out -` | **PASS** | 文件写入（自动建目录），BOM + 表头 + 记录数与服务端一致，`--json` 报告 path/bytes 与实际文件一致；stdout 与 `-` 均带 BOM |
| `config set/show` | **PASS** | 写入 `$XDG_CONFIG_HOME/naiji/config.json`；`config show --json` → server/source=config/configExists=true；无 `--server` 时生效 |
| 地址优先级 | **PASS** | `NAIJI_SERVER` > 配置文件；`--server` > `NAIJI_SERVER`（均实测成功/失败反转验证） |
| `--json` 机器可读 | **PASS** | 成功命令 stdout 单 JSON；错误输出到 stderr 且为 JSON（`usage_error` / `network_error` / `not_found`） |
| 错误退出码 | **PASS** | 用法错误 → **2**（未知类型/非法奶量/缺奶量/仅亲喂带奶量/log 超范围/rm 非法 id/未知命令/非法 NAIJI_SERVER）；API/网络错误 → **1**（记录不存在/连接失败） |
| 启动器 `cli/bin/naiji` | **PASS** | shell 启动器（PATH 注入 Node）`status --json` exit 0，输出合法 JSON |

### 2.4 v2 契约一致性（G16，152/152 PASS）

| 类别 | 结果 | 关键证据 |
| --- | --- | --- |
| Event JSON 字段（`feedTypes` 数组） | **PASS** | 字段集合精确为 `[amountMl,createdAt,diaperKind,feedTypes,happenedAt,id,kind,note]`；提交乱序 `["breast_milk","formula"]` → 返回规范顺序 `["formula","breast_milk"]`；时间均为 number |
| 奶量规则 | **PASS** | 含 formula/breast_milk 必须 1–2000；仅亲喂 `amountMl=null`；仅亲喂带奶量 → `400 unexpected_amount` |
| feedTypes 校验 | **PASS** | 缺失/空数组/重复/非法值/非数组 → `400 invalid_feed_types`（中文 message） |
| v1 兼容 | **PASS** | `{feedType:"breast_milk",amountMl:90}` → 201 `feedTypes=["breast_milk"]`；`feedType` 与 `feedTypes` 同时出现以 `feedTypes` 为准 |
| `state.today` 聚合（v2 字段） | **PASS** | 造 6 条喂奶 + 1 mixed 大小便，实测 `feedCount=6`、`totalMl=420`、`formulaCount=3`、`breastMilkCount=3`、`breastDirectCount=2`、`mixedFeedCount=2`、`diaperCount=1`、`pee/poop=1/1`、`mixedCount=1` |
| 错误码/中文 message | **PASS** | 415 / invalid_json / invalid_feed_types / invalid_amount / unexpected_amount / invalid_happened_at / invalid_note / invalid_diaper_kind / invalid_limit / invalid_tz_offset / invalid_cursor / 404 not_found 全部匹配 |
| CORS 默认 `*` | **PASS** | GET ACAO `*`；`OPTIONS → 204` + Allow-Methods 含 DELETE + Allow-Headers 含 Content-Type + `Max-Age: 86400` |
| CORS_ORIGINS 白名单 | **PASS** | 匹配来源回显具体 Origin 且带 `Vary: Origin`；未匹配来源**不带** ACAO（浏览器拦截）；预检对匹配来源 204 |
| `SERVE_WEB=0` 纯 API 模式 | **PASS** | `GET / → 404 {error:"web_disabled"}`（中文提示独立部署）；静态资源 404；API 正常且仍带 CORS |
| v1→v2 数据库迁移 | **PASS** | 真实 server 打开 v1 库：3 条记录全部保留（formula 120ml/亲喂 NULL/大便），`feed_types` 数组正确，id/时间/备注保留，`PRAGMA user_version=2`，旧列移除；**二次打开幂等**（记录数仍 3，不重复） |
| CSV（v2 多标签） | **PASS** | BOM、表头、项目列 `奶粉 + 母乳（瓶喂）` / `奶粉 + 亲喂`、奶量为总奶量、记录数/升序/转义/文件名均正确 |
| 静态托管与安全 | **PASS** | CSP 含 `connect-src *`（跨源必需）+ `script-src 'self'`；nosniff / no-cache；MIME 正确；目录穿越 404；静态 POST 405 |
| 服务端错误日志 | **PASS** | 主 server 与独立 web 服务日志均无「未捕获错误」/「静态服务出错」 |

---

## 3. 视觉与体验主观评价（亲自看截图后）

### 3.1 整体观感

**结论：v2 的多选改版是成功的，整体质感与 v1 一致偏“精致”，可以直接上线。**

- 三个类型从“分段单选”改为**多选 toggle + 勾选圆点**是本次最大的交互升级：选中项有珊瑚描边 + 浅珊瑚底 + ✓ 勾，未选中是空心圆；状态一眼可辨，比 v1 的单选分段更适合“奶粉+母乳”这种真实组合。
- 「类型可多选 · 点一下即记录」把规则直接写在卡片头部，降低理解成本；「奶量 · 奶粉 + 母乳（瓶喂）」让当前组合与奶量含义一目了然；亲喂+瓶喂时多出的「🍼 奶量填写本次补充的瓶喂量」提示非常必要，已实测会出现。
- Hero 上次详情里也同步展示多标签（`奶粉 + 母乳（瓶喂） 120 ml`），与时间线标题口径一致；深色模式、320 窄屏、桌面居中布局均保持 v1 水准，深色模式选中态还额外加了描边/内阴影，比 v1 更清楚。
- 跨源独立部署页面与同源页面**视觉零差异**（同一份静态资源，仅 API 基址不同），符合“纯静态前端可独立托管”的预期；错误态 banner 会把当前 API 地址打出来（`无法访问 http://127.0.0.1:…`），对前后端分离部署的排障很友好。

### 3.2 做得好的细节

1. 多选 toggle 的勾选圆点 + 描边 + 底色三重反馈，选中/未选中在浅色和深色下都清晰（v1 的“深色选中态区分弱”问题已修复）。
2. 点击唯一选中类型时不会变成 0 个，而是轻微抖动 + toast「至少要保留一种喂奶类型」，边界处理友好。
3. 时间线标题把「标签」与「奶量」拆成两个 span，`120 ml` 不会被拆成两行（时间线内），长标题折行位置合理。
4. 记录失败 toast 直接给出可排查的 API 地址；加载失败时按钮有可见禁用态（v1 的 P2 已修复）。
5. 今日汇总仍是「喂奶 N 次 · 奶量 M ml · 亲喂 K 次 · 小便 X · 大便 Y」五项，与 v1 习惯一致；服务端新增的 formulaCount/breastMilkCount/mixedFeedCount 没有强行塞进 UI，克制。
6. 320 窄屏：三个多选按钮仍能并排放下，导出按钮收成 44px 圆钮且补了 `aria-label`（v1 的 P2 已修复）。

### 3.3 可挑剔处（详见第 4 节）

1. **320px 下多标签 Hero 折行难看**：`上次 22:32 · 奶粉 + 母乳（瓶喂） 120` / `ml` —— 「120 ml」被拆成两行，`mobile-320.png` 可直接看到。时间线已经做了防拆，Hero 没做。
2. **主按钮 / Hero 白字对比度偏低**（Hero 渐变浅端 1.93:1、主按钮深色模式 2.11:1），强光或低视力场景吃力；属于 v1 遗留、v2 未改。
3. **toast 5 秒内遮挡下方操作区**（390 下与大便按钮重叠约 12px），记录后想立刻记大小便需要等 toast 消失或先滚动。
4. **恰好 30 条时「加载更多」是空按钮**（点击后无新增、按钮自行消失），v1 遗留。
5. 多标签时间线标题在 390 下折成「奶粉 + 母乳（瓶喂）」+「120 ml」两行，第二行只有奶量、左对齐，略显松散（可接受，属观感）。

---

## 4. 问题清单（P0 / P1 / P2）

### P0（阻断上线）— 无

未发现数据错误、崩溃、白屏、接口不可用、控制台报错、跨源失败、CLI 无法使用等阻断级问题。644 条断言两次独立运行全 PASS。

### P1（明显体验问题）— 无

### P2（小瑕疵 / 可访问性，建议排期）

#### QA-P2-01 Hero 大字号白字 / 主按钮白字对比度低于 WCAG AA（v1 遗留，v2 未改）

- **最小复现**：任意页面（浅色/深色）观察 Hero 大数字与「记录」按钮；用脚本实测渐变色对比度。
- **期望**：主要信息/主按钮文字达到 WCAG AA（大字号 3:1、正文 4.5:1）。
- **实际**（脚本 G14b 实测）：Hero 时长白字渐变三端 **2.07 / 3.12 / 1.93 : 1**（37.44px，大字号要求 3:1）；主按钮「记录」白字 **浅色 2.31 / 3.80 : 1、深色 2.31 / 2.11 : 1**（15px/700，正文要求 4.5:1）。
- **建议**：加深渐变暗端（如 `--hero-2` → `#d94a33`、`--primary-strong` → `#c8472e`），或给白字加 `text-shadow`；需设计确认品牌色。属可访问性改进，非契约硬要求。
- **证据**：脚本 G14b 三条观察项；`screenshots/mobile-390.png`、`screenshots/dark-390.png`。

#### QA-P2-02 320px 下多标签 Hero 上次详情把「120 ml」拆行（v2 新增）

- **最小复现**：视口 320×640，最后一条记录为多标签（如 `奶粉 + 母乳（瓶喂） 120 ml`）→ Hero 的 `gap-last-feed` 折两行，第一行末尾是 `120`，第二行只剩 `ml`。
- **期望**：奶量与单位保持同一行（时间线已有同样处理），或整行折行时把奶量整体换到第二行。
- **实际**：脚本 G13 实测 `gap-last-feed` 高度 42px 折成多行；截图 `screenshots/mobile-320.png` 可见「… 120」/「ml」。
- **建议**：Hero 里用 `api` 与时间线一致的 `eventTitle` 拆分 span（label + nowrap 的 amount），或对 `hero-last` 内金额加 `white-space: nowrap`；一行 CSS/DOM 小改。
- **证据**：脚本 G13 观察项；`screenshots/mobile-320.png`。

#### QA-P2-03 记录成功 toast 的 5 秒内遮挡下方操作区（v1 遗留）

- **最小复现**：390/320 记录一次喂奶 → 底部 toast 覆盖「记录大小便」卡片上部；390 下与「大便」按钮垂直重叠约 12px，320 下更明显；toast 本身 `pointer-events:auto`，被覆盖区域不可点击。
- **期望**：记录成功后仍能立即操作下一项。
- **建议**：记录成功自动滚动到汇总/时间线并避开按钮区；或 toast 展示期间给 body 增加底部占位；或将撤销窗口从 5s 降到 3.5–4s。
- **证据**：脚本 G02 观察项；`screenshots/multi-select-390.png`。

#### QA-P2-04 恰好 30 条记录时「加载更多」按钮可见但无更多数据（v1 遗留）

- **最小复现**：库中恰好 30 条记录 → 刷新 → 首屏 30 条 + 「加载更多」→ 点击后无新增，按钮消失。
- **期望**：契约 §6.2「无更多时隐藏」。
- **原因**：前端 `state.hasMore = recent.length >= 30` 只能猜。
- **建议**：`/api/state` 增加 `hasMore`（多取 1 条判断）或首屏 `recent` 请求 31 条仅渲染 30。
- **证据**：脚本 G18（造恰好 30 条，观察项 + 点击后条数不变/按钮隐藏断言）。

### v1 → v2 已修复问题（回归验证 PASS）

| v1 报告问题 | v2 验证结果 | 证据 |
| --- | --- | --- |
| P2-01 加载失败时按钮 disabled 但无视觉反馈 | **已修复** | v2 `.record-btn:disabled { opacity:.58; cursor:not-allowed }`；实测失败态与正常态计算样式不同；`screenshots/error-390.png` |
| P2-02 320px 导出链接无无障碍名称 | **已修复** | `<a aria-label="导出 CSV">`；G14b 通过 AX 树实测 `name="导出 CSV"` |
| P2-03 toast 撤销按钮 42px 偏小 | **已修复** | G05 实测 `height ≥ 44px` |
| P2-07 深色模式分段选中态区分弱 | **已修复** | 深色选中态加描边/渐变/内阴影 + ✓ 勾；`screenshots/dark-390.png` 观感清晰 |
| P2-05 toast 遮挡 / P2-06 恰好 30 条按钮 / P2-04 对比度 | **仍存在**（见上） | — |

---

## 5. 契约一致性抽查（汇总）

- **时间约定**：API/DB 时间均为 epoch 毫秒 number；前端/CLI 展示用进程本地时区；`tzOffset` 语义与 `Date#getTimezoneOffset` 一致（实测 -480）。
- **Event JSON（v2）**：`feedTypes` 数组、规范顺序、1–3 个；`amountMl` 为总奶量（仅亲喂 null）；`diaperKind` 互斥；camelCase 字段精确匹配。
- **`state.today`**：`date/feedCount/totalMl/formulaCount/breastMilkCount/breastDirectCount/mixedFeedCount/diaperCount/peeCount/poopCount/mixedCount` 全部存在且语义正确（含 mixed 计数规则：pee/poop 各含 mixed，mixedCount 单独计；feedCount 含亲喂；totalMl 不含亲喂）。
- **错误响应**：`{error, message}`，中文 message 可直接展示；状态码 400/404/405/413/415/500 与契约一致（实测 400/404/405/415）。
- **CORS**：`*` 与白名单两种模式均正确；OPTIONS 204 + Allow-Methods/Headers/Max-Age；白名单模式带 `Vary: Origin`，未匹配来源不放行。
- **静态托管**：CSP（含 `connect-src *`）、nosniff、no-cache、MIME、目录穿越 404、非 GET 405；`SERVE_WEB=0` 返回 JSON `web_disabled`。
- **CSV**：BOM、表头、多标签项目名 ` + ` 连接、总奶量、升序、RFC4180 转义、文件名格式。
- **迁移**：v1 `feed_type` 单值 → `feed_types` JSON 数组；id/时间/备注/奶量保留；`user_version=2`；幂等。
- **备注/偏差**：
  1. CSV 时间用服务器本地时区、UI/CLI 用浏览器/进程本地时区（契约 §5 如此规定）；服务器与手机同处一个时区时一致，跨时区部署会差时差，建议 README 提示。
  2. `/api/state` 的 `hasMore` 未提供 → 前端只能按 30 条猜测（见 P2-04）。
  3. CLI 的 TTY 交互确认（`undo`/`rm` 的 y/N）本轮只验证非 TTY 自动执行；TTY 路径由 `cli/test/*.test.js` 覆盖，未做伪终端 E2E。
  4. `naiji export | head` 的 EPIPE 处理未单独压测（代码有处理，非契约要求）。

---

## 6. 结论

**可以上线。**

- **Web 前端 E2E 336/336 PASS**：多选类型、单标签、仅亲喂、亲喂+瓶喂组合、至少一个、类型记忆、撤销、删除、加载更多、持久化、响应式、深色、空库、错误恢复全部真实可用；控制台/网络零异常。
- **前后端分离/跨源 25/25 PASS**：`scripts/serve-web.mjs` 独立托管 + `?api=` 跨源访问真实可用，CORS 预检/写入/localStorage 回退均正确，跨源页面视觉与同源一致。
- **CLI 端到端 131/131 PASS**：所有命令、`--json`、`--ago/--at/--note`、配置优先级、导出、启动器、退出码 0/1/2 与 API 数据一致性均通过。
- **契约一致性 152/152 PASS**：v2 多标签模型、state 聚合、错误码、CORS、SERVE_WEB=0、v1→v2 迁移（含幂等）、CSV 全部符合 `docs/CONTRACT.md`。
- **两连跑结果一致**（644/644，分组逐行相同），脚本可重复执行、自动善后，是无残留的回归入口。
- **风险**：P0/P1 为 0；4 项 P2 均为打磨/可访问性/边界问题，不阻断上线。其中 QA-P2-02（320 Hero 拆行）是 v2 多选带来的新视觉瑕疵，建议顺手修；QA-P2-01 对比度建议随设计迭代处理。

**未覆盖范围（如实说明）**：iOS Safari / Android 真机与安全区、PWA 添加到主屏后的独立窗口、多设备/多标签页并发、跨时区部署、超大记录量（本轮最大 60 条，未压测 200+ 多页翻页）、CLI TTY 伪终端交互、长时运行稳定性。这些不在本轮任务范围，建议后续按需补充。

---

## 7. 附：实际亲眼看过的截图清单

> 全部位于 `docs/screenshots/`，由脚本每次运行覆盖生成；我逐张打开看过并据此给出第 3 节评价。

| 截图 | 尺寸 / 大小 | 我看到了什么 |
| --- | --- | --- |
| `screenshots/mobile-390.png` | 780×1688 / 354.8KB | 首屏：Hero `1 小时 30 分钟`、`上次 21:02 · 奶粉 + 母乳（瓶喂） 120 ml`、多选 toggle（仅奶粉选中）、奶量 chip、大小便按钮 |
| `screenshots/multi-select-390.png` | 780×1688 / 360.6KB | **多选核心证据**：奶粉 + 母乳·瓶喂 同时勾选（✓+描边）、奶量标题「奶量 · 奶粉 + 母乳（瓶喂）」、toast「已记录 奶粉 + 母乳（瓶喂） 120 ml / 撤销」 |
| `screenshots/mobile-390-after-record.png` | 780×1688 / 328.8KB | 单次记录后 toast + Hero「刚刚」（亲喂+奶粉组合会话） |
| `screenshots/mobile-390-full.png` | 780×3204 / 475.9KB | 整页：Hero + 喂奶 + 大小便 + 今日汇总（喂奶 6 次/奶量 360ml/亲喂 2 次）+ 时间线 8 条（含多标签标题、备注「QA 首屏种子」） |
| `screenshots/mobile-320.png` | 640×1280 / 260.4KB | 320 极窄屏：无横向滚动；**可见 Hero 上次详情「120 ml」被拆成两行**（P2-02）；导出按钮收为 44px 图标钮 |
| `screenshots/desktop-900.png` | 1800×1800 / 475.2KB | 900 桌面：内容 560px 居中、左右留白；多选 toggle 与 chip 无拉伸变形 |
| `screenshots/dark-390.png` | 780×1688 / 333.0KB | 深色模式：暖黑底 + 深珊瑚 Hero；奶粉选中态有珊瑚描边+✓，v1 的“深色选中态弱”已改善；主按钮白字对比偏弱（P2-01） |
| `screenshots/empty-390.png` | 780×1688 / 340.2KB | 空库：Hero「还没开始 / 还没有喂奶记录 / 还没有大小便记录」，操作区完整可用 |
| `screenshots/cross-origin-390.png` | 780×1688 / 360.5KB | **跨源证据**：页面由独立静态服务（另一端口）托管、API 走跨源；视觉与同源无差异，toast「已记录 奶粉 + 母乳（瓶喂） 120 ml」 |
| `screenshots/error-390.png`（附加） | 780×1688 / 324.6KB | 加载失败态：banner 显示「无法访问 http://127.0.0.1:…」+ 重试；按钮呈**可见禁用态**（v1 P2 已修复） |

---

## 8. 附：最后一次运行日志摘要（644/644 PASS）

```
  ✓ G00 环境与启动（server CLI / 独立 web / Chrome） 12/12 PASS
  ✓ G01 首屏 200 / 空库 / 距离上次喂奶格式 / 秒级刷新 18/18 PASS  (~10.5s)
  ✓ G02 多选类型：奶粉 + 母乳（瓶喂）120ml 一键记录 21/21 PASS
  ✓ G03 toast 撤销：多标签记录不残留     7/ 7 PASS
  ✓ G04 单标签 / 仅亲喂 / 亲喂 + 瓶喂组合 / 至少一个 / 类型记忆 44/44 PASS
  ✓ G05 自定义奶量 999ml + 前端范围校验 10/10 PASS
  ✓ G06 大小便一键记录 + 请求中禁用防连点   11/11 PASS
  ✓ G07 时间线删除：window.confirm → DELETE → 服务端/UI/Hero 同步  9/ 9 PASS
  ✓ G08 刷新持久化（Page.reload）    7/ 7 PASS
  ✓ G09 加载更多：30 条首屏 → 游标翻页 → 全部展示 → 按钮隐藏 12/12 PASS
  ✓ G10 导出 CSV：多标签项目名 / BOM / 记录数 / 转义 21/21 PASS
  ✓ G11 首屏加载失败重试 + 记录失败错误提示  10/10 PASS
  ✓ G12 前后端分离：独立托管 web + ?api= 跨源访问 + CORS 预检 25/25 PASS
  ✓ G13 320 / 390 / 900 视口：无横向滚动 + 点击区 ≥ 44px + 按钮不重叠 60/60 PASS
  ✓ G14 深色模式：配色切换 + 对比度       6/ 6 PASS
  ✓ G14b 无障碍与对比度细节抽查           2/ 2 PASS
  ✓ G15 空库状态：empty-state / 今日汇总为 0 / 无记录提示 18/18 PASS
  ✓ G16 契约一致性抽查（API 字段 / 错误码 / CORS / SERVE_WEB=0 / v1→v2 迁移） 152/152 PASS
  ✓ G17 CLI 端到端：status / feed / pee / log / today / undo / rm / export / config / 错误码 131/131 PASS
  ✓ G18 边界：恰好 30 条记录时「加载更多」的表现  5/ 5 PASS
  ✓ G19 控制台错误 / 未捕获异常 / 4xx-5xx / 静态资源 / CORS 预检 27/27 PASS
  ✓ G20 截图产物完整性（docs/screenshots/） 36/36 PASS
  ─────────────────────────────────────────────
  断言总数 644：PASS 644 / FAIL 0
  总体结果：PASS（exit 0）
```

### 故障注入预期错误（脚本精确记录、不计失败，共 6 条）

1. `network-failure: GET /api/state?tzOffset=-480 → net::ERR_CONNECTION_REFUSED`（验证加载失败态）
2. `log-error: Failed to load resource: net::ERR_CONNECTION_REFUSED`（同上）
3. `console: [奶记] 加载失败: ApiError: 网络连接失败，无法访问 http://…`（应用预期错误日志）
4. `network-failure: POST /api/feedings → net::ERR_CONNECTION_REFUSED`（验证记录失败路径）
5. `log-error: Failed to load resource: net::ERR_CONNECTION_REFUSED`（同上）
6. `console: [奶记] 记录喂奶失败: ApiError: 网络连接失败，无法访问 http://…`（应用预期错误日志）

除上述 6 条主动注入的预期错误外，**全流程 console error / 未捕获异常 / Log error / 4xx-5xx 均为 0**。

### 观察项（不计入 PASS/FAIL，均已列入第 4 节）

```
⚠ 记录成功 toast 遮挡下方操作区（P2 体验） — 与「大便」按钮垂直重叠约 12px
⚠ 320px 今日汇总折行 — 高度 47px（两行，前端已说明不算 bug）
⚠ 320px 多标签 Hero 上次详情折行（P2 视觉） — 「120 ml」被拆成两行
⚠ 时间线删除按钮点击区域 — 44×44px（达标）
⚠ 主按钮白字对比度（浅色） — 2.31 / 3.80:1
⚠ Hero 大字号白字对比度（浅色） — 2.07 / 3.12 / 1.93:1
⚠ 主按钮白字对比度（深色） — 2.31 / 2.11:1
⚠ 恰好 30 条时「加载更多」按钮 — 可见但无更多数据（P2）
```

---

## 9. 修复跟进（QA 报告之后，Lead 处理）

QA v2 报告发出后，Lead 修掉了其中唯一新增的 P2，并做了完整回归：

| P2 | 处理 | 说明 |
| --- | --- | --- |
| #2 320px 多标签 Hero 上次详情把「120 ml」拆成两行 | ✅ 已修 | Hero 里奶量单独包 `span.hero-last-amount { white-space: nowrap }`；320px 下「120 ml」保持同一行（见重新生成的 `mobile-320.png`） |
| #1 Hero / 主按钮白字对比度 | ⏸ 保留 | 设计取舍：珊瑚渐变是视觉主轴，改到 WCAG AA 需整体换配色（v1 起已知限制） |
| #3 记录成功 toast 遮挡下方按钮约 12px | ⏸ 保留 | 标准底部 toast，5s 自动消失，不影响操作 |
| #4 恰好 30 条时「加载更多」空按钮 | ⏸ 保留 | 多点一次即自动隐藏；彻底修需 `/api/state` 增加 hasMore 字段 |

回归结果：`node --test` **234/234 PASS**；`node scripts/browser-e2e.mjs`（web + 跨源 + CLI）连跑 2 次均 **644/644 断言 PASS，exit 0**；`docs/screenshots/` 已随最新代码重新生成。

---

## 10. 多端实时同步（SSE）与刷新按钮 — 后续验证记录

**需求**：多人同时使用后，需要看到别人刚记录的数据；用户先要求「刷新按钮」，并提出可用长连接/WebSocket。

**方案（Lead 实现）**：SSE（Server-Sent Events，浏览器原生 `EventSource`，零依赖）为主 + 手动刷新按钮兜底：
- 服务端 `GET /api/events/stream`：SSE hub、`retry: 3000`、25s 心跳、记录增删即广播（`{type:"feed"|"diaper",event}` / `{type:"delete",id}`）、跨源 CORS、关闭应用时主动结束连接。
- 前端：顶栏刷新按钮（44×44，转圈/禁用/toast「已刷新最新数据」）；`EventSource` 订阅并**幂等应用**变更（避免本人 POST 响应与 SSE 回声乱序导致重复计数）；收到他人新增提示「已同步 …」（不打断撤销 toast）；断线重连后静默全量校准；`visibilitychange` 回前台静默校准；不支持 EventSource 时降级 30s 轮询。

**验证**：
- `node --test` → **241/241 PASS**（新增 `test/sse.test.js` 7 项：响应头/CORS/初始帧、喂奶/大小便/删除广播、多客户端、心跳、关闭连接、同毫秒多次记录）。
- `scripts/browser-e2e.mjs` 连跑 2 次 → **644/644 PASS**（回归无破坏；`docs/screenshots/` 已更新为带刷新按钮的新 UI）。
- **真实浏览器 + 第二客户端**（curl/API 直接模拟另一台设备）21/21 PASS：写入后页面 Hero 倒计时/标签标题/今日汇总/时间线**无需刷新**即更新并提示「已同步」；第二端删除后记录实时消失、Hero 恢复；刷新按钮转圈→toast→恢复可用；320px 无横向滚动、刷新按钮点击区 44px；console 无错误。
- 过程中发现并修复真实竞态：POST 响应与 SSE 回声可能先到/后到导致同一条记录被应用两次（e2e 实测汇总 420 ml ≠ 300 ml、撤销后时间线多一条），已把应用逻辑改为幂等并回归通过。

---

## 11. v3 验收：洗澡事件与趋势折线图 — 独立验证记录

**验收人**：QA（独立于 server / web / cli 实现）　**日期**：2026-11-17　**基线**：`docs/CONTRACT.md` v3 §4 / §5 / §6.4 / §7 / §8
**边界**：本轮只写 `scripts/browser-e2e.mjs`、`docs/screenshots/`、本报告；未改 `server/`、`web/`、`cli/`、`test/`。

### 11.1 环境与命令

| 项 | 值 |
| --- | --- |
| 项目根 | `/home/nykma/Project/nodejs/baby-milk-tracker` |
| Node | v24.21.0（`/nix/store/j1j9b0w3mhpccdli73ycj5w7nf6fkzqz-nodejs-24.21.0/bin/node`；脚本内 `process.execPath` 为同版本 slim 包） |
| 浏览器 | Chrome/157.0.8103.50，`--headless=new`，通过 Node 内置 WebSocket 走 CDP 驱动真实点击/输入/网络/截图 |
| 时区 | Asia/Shanghai，浏览器 `tzOffset=-480`；另用固定偏移 `+840` 验证 `/api/stats` 的 tzOffset 语义 |
| 数据库 | 每次运行独立临时 SQLite（`/tmp/naiji-e2e-v3-*/qa-v3.db`），跑完自动删除；Chrome profile / 临时目录同样清理 |
| 服务 | 真实 `node server/src/server.js`（随机端口）+ `scripts/serve-web.mjs` 独立静态托管（另一随机端口，继续覆盖跨源部署与 CORS） |
| 命令 | `cd <项目根> && <node> scripts/browser-e2e.mjs`，连续跑 2 次 |
| 退出码 | 全 PASS → `exit 0`；有 FAIL → `exit 1`（两次均 exit 0） |
| 可重复性判据 | 脚本末尾输出「断言明细指纹 sha256=…」：仅对 `分组\|断言名\|结果` 取哈希（不含耗时/端口/时间等易变证据），两次指纹相同即明细一致；`E2E_MANIFEST=1` 可打印逐条清单用于 diff |
| 运行墙钟 | 单次约 90 秒（断言执行合计 36.3s，其余为进程/Chrome 启停、截图与清理；共 25 个分组、13 张截图） |

**脚本本轮改动（v2 644 断言 → v3 949 断言）**

1. **适配 v3 产品变更（非 bug）**：Hero 第三行空库文案 `还没有大小便记录` → `还没有换尿布/洗澡记录`；迁移断言 `PRAGMA user_version` 2 → 3（v3 schema）。原 644 条中的其余文案/流程断言全部保持，未放宽。
2. **新增 G06b 洗澡**（41 断言）：结构/一键记录/toast/时间线/今日汇总/Hero 计时重置/撤销/刷新持久化/SSE 第二客户端。
3. **新增 G16b v3 契约**（103 断言）：`POST /api/baths` 成功与全部错误码、`state.lastBath/today.bathCount`、`GET /api/stats` 形状/参数/tzOffset 语义、CSV 洗澡行、**v2→v3 迁移**（放宽 kind CHECK 后可写 bath）。
4. **新增 G18b 趋势卡**（101 断言）：7/30 天、6 指标、图表数据与 API 逐点/汇总一致、范围缓存、SSE 静默重拉、空状态、320/390/900 无横向滚动、深色模式、触控目标尺寸测量。
5. **扩充既有分组**：G01 空库 v3 文案/趋势卡默认态（18→25）；G15 空库洗澡计数/趋势空状态（18→23）；G17 CLI 洗澡与 status/today/log（131→167）；G20 新增截图产物校验（36→48）；G16 标题与 v1→v3 迁移断言更新。
6. 原有分组 **id 与顺序保持不变**，便于与 v2 报告逐组对比。

### 11.2 两次运行结果

| 运行 | 断言总数 | PASS | FAIL | 退出码 | 明细指纹 sha256 | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| #1 | 949 | 949 | 0 | 0 | `14304a75bd90f108d6683657ce9f8b56e5ec7b078a2f50450d909614a97f95e2` | PASS |
| #2 | 949 | 949 | 0 | 0 | `14304a75bd90f108d6683657ce9f8b56e5ec7b078a2f50450d909614a97f95e2`（与 #1 相同） | PASS |

**两次运行明细完全一致**（同指纹、同 949 条断言、同分组计数），且每次自动完成 Chrome / 服务 / 临时目录清理、无残留进程。分组结果（两次相同）：

```
G00 12/12   G01 25/25   G02 21/21   G03  7/7    G04 44/44   G05 10/10   G06 11/11
G06b 41/41  G07  9/9    G08  7/7    G09 12/12   G10 21/21   G11 10/10   G12 25/25
G13 60/60   G14  6/6    G14b 2/2   G15 23/23   G16 152/152 G16b 103/103
G17 167/167 G18  5/5    G18b 101/101 G19 27/27  G20 48/48
断言总数 949：PASS 949 / FAIL 0（exit 0）
```

v2 的 22 个既有分组全部仍为 PASS，**没有功能回归**；G16 中 2 条旧断言按 v3 契约更新后通过（见 11.1 第 1 条）。全流程 console error / 未捕获异常 / 非预期 4xx-5xx 均为 0（G19），仅 G11 故障注入窗口内 6 条预期错误被精确标记、不计失败。

### 11.3 新增验收逐项证据

#### A. 洗澡事件（G06b，41/41 PASS）

| 任务书要求 | 实测结果（证据摘自运行日志） |
| --- | --- |
| 「记录大小便」卡片第三个按钮 | `.diaper-grid` 按钮顺序 `record-pee / record-poop / record-bath`；文案「🛁 洗澡」；点击区 101×64px |
| 点击 → `POST /api/baths` 201 | 真实鼠标点击 → 网络 `POST /api/baths → 201`，服务端事件数 +1，最新记录 `kind="bath"`、`feedTypes/amountMl/diaperKind` 均 null |
| toast「已记录 洗澡」 | toast 文本含「已记录 洗澡」且带「撤销」按钮 |
| 时间线出现「🛁 洗澡」 | 时间线首条标题「洗澡」、图标 `🛁`（`.event-icon[data-tone="bath"]` 淡紫） |
| 今日汇总 +1 | 汇总文本 `洗澡 0 次 → 洗澡 1 次`；服务端 `today.bathCount=1`、`lastBath.kind="bath"` |
| Hero「距上次换尿布/洗澡」被重置 | 先用 API 造 45 分钟前小便 → Hero 显示「距上次换尿布/洗澡 45 分钟」；点洗澡 → **「刚刚」**；撤销后回退「45 分钟」→ 证明是洗澡重置而非巧合 |
| 撤销洗澡 | `toast-undo` → `DELETE /api/events/:id → 204`；toast「已撤销「洗澡」」；时间线/事件数恢复；服务端 `bathCount 1→0`、`lastBath=null`；Hero 回退 |
| 刷新后仍持久 | 记录后 `Page.reload`：时间线首条洗澡、Hero 第三行「刚刚」、汇总仍含洗澡、`/api/state lastBath` 仍为 bath |
| SSE 他人记录实时出现 | 第二客户端（Node 直接 `fetch POST /api/baths`）→ 页面**无需刷新**时间线 +1、首条「洗澡」、toast「已同步 洗澡」、汇总 +1、Hero 归零；服务端 `lastBath` 指向该记录；全程无 console/网络错误 |
| 截图 | `docs/screenshots/bath-390.png`（Hero「刚刚」+ 大小便三按钮 + toast「已记录 洗澡/撤销」） |

#### B. 趋势卡（G18b，101/101 PASS）

数据构造：经 API 造 **10 个本地日历天 × 6 个指标**（33 条事件：第 d 天事件时间为 `now - d×24h` 同一本地时刻，当天事件取 `now-0.9s`；今天含 3 条喂奶/2 条大小便/1 条洗澡）。页面 tzOffset=-480 与 API 请求一致；`GET /api/stats?days=7` 的最后一天与 `/api/state.today` **全字段逐项相等**。

- **位置/结构**：`stats-card` 位于「今日汇总」之后、「记录时间线」之前；`stats-chart` 为内联 SVG（恰好 1 个 `<svg>`、0 个 `<canvas>`），`role="img"`，`aria-label` 随范围/指标更新（「最近 7 天奶量趋势」→「最近 30 天奶量趋势」）。
- **默认态**：7 天 `aria-pressed=true`、30 天 false；默认指标「奶量 ml」。
- **7 天视图**：7 个数据点（circle）、折线 path 7 段（M+6×L）、3 条网格线、X 轴 7 个 MM-DD 日期标签、**每个点都有数值标签**，各点数值逐点等于 `GET /api/stats.totalMl`（`["220","150","140","190","120","110","160"]`）；`stats-summary` 精确等于「7 天合计 1090 ml · 日均 155.7 ml · 最高 220 ml（11-11）」。
- **6 指标逐一切换**：奶量 / 喂奶次数 / 亲喂 / 小便 / 大便 / 洗澡 —— 每项均验证 7 点数值、**首点=API 第 1 天、末点=API 第 7 天（今天）**、汇总行合计/日均/最高与 API 对应字段一致（如洗澡「7 天合计 3 次 · 日均 0.4 次 · 最高 1 次（11-11）」）。
- **30 天视图**：30 个数据点；X 轴 6 个标签、**每 5 天一个且最后一个是今天**（`["10-23","10-28","11-02","11-07","11-12","11-17"]`）；**只标最高点**（1 个数值标签 = API 30 天最大值 250）；汇总「30 天合计 1690 ml · 日均 56.3 ml · 最高 250 ml（11-08）」与 API 一致。
- **范围缓存**：7↔30 重复切换命中缓存，`/api/stats` 请求计数不变（契约「切换范围时拉取并缓存」）。
- **SSE 静默重拉（契约 §6.4）**：趋势卡可见时第二客户端记录洗澡 → 自动重拉 `GET /api/stats?days=7`，洗澡指标末点 +1、汇总同步为「7 天合计 4 次 · 日均 0.6 次 · 最高 2 次（11-17）」；删除后再次静默重拉并恢复原值。
- **空状态**：清库并手动刷新后显示「最近 7 天还没有数据」，仍画 7 个 0 基点点、7 个「0」数值标签、汇总「7 天合计 0 ml · 日均 0 ml · 最高 0 ml（11-17）」；切 30 天显示「最近 30 天还没有数据」。
- **响应式**：320 / 390 / 900 三档均 `documentElement.scrollWidth ≤ innerWidth` 且 `body.scrollWidth ≤ innerWidth`（无横向滚动）；SVG 宽度随容器自适应 266 / 320 / 518px；6 个指标 chips 不溢出视口。
- **深色模式**：背景 `rgb(255,248,242) → rgb(23,17,16)`、折线 `rgb(224,85,58) → rgb(255,151,125)`、坐标轴标签同步切换；`stats-dark-390.png` 目视对比清楚。
- **截图**：`stats-390.png`（7 天视图，含今日汇总衔接与时间线）、`stats-dark-390.png`（深色）。

#### C. v3 API 与迁移契约（G16b，103/103 PASS）

- **`POST /api/baths`**：空对象 → 201，Event 恰好 8 个字段（`amountMl/createdAt/diaperKind/feedTypes/happenedAt/id/kind/note`），`kind="bath"`、三个业务字段 null、note 默认 null、时间戳为 number；带 `note`/`happenedAt` 时 note trim、时间原样；`state.lastBath` 取较晚者、`today.bathCount` 同日 2 条计 2、非今天补记不改变 today。
- **错误码/中文 message**：note 201 字符、note 非字符串、happenedAt 字符串/未来 10 分钟/早于 2000-01-01、非法 JSON、非 `application/json`（415）、>64KB（413）——状态码与 error code 全部符合契约，message 为中文且非法请求**未落库**。
- **`GET /api/stats`**：默认 `days=7`；`daily` 项 12 个字段（含 v3 `bathCount`）；日期升序连续、`endDate=今天`；最后一天与 `/api/state.today` 完全一致；`days=1/30/90` 合法；`days=0/91/abc/1.5/-1` → `invalid_days`；`tzOffset=9999/abc` → `invalid_tz_offset`；`tzOffset=-480/+840` 的 `endDate` 均等于该固定偏移下的日历「今天」。
- **CSV**：3 条洗澡行「时间,洗澡,洗澡,,备注」，表头仍为 `时间,类别,项目,奶量(ml),备注`，备注正确。
- **v1→v3**（G16）：旧库 3 条记录全部保留、`feed_type`→`feedTypes`、奶量/备注/id 不变，`PRAGMA user_version=3`，表结构为 `feed_types`。
- **v2→v3**（G16b）：构造 `kind CHECK IN ('feed','diaper')`、`user_version=2` 的旧库 → 打开后 2 条记录及多标签 `feedTypes`/奶量/大小便原样保留，`user_version=3`，**kind CHECK 放宽后可成功 POST 洗澡 201 并落库**（契约 §8 要求的 v2→v3 迁移）。

#### D. CLI（G17，167/167；v3 新增 36 条）

- `naiji bath --json` / `naiji b`：exit 0，返回 `kind="bath"`、三业务字段 null；服务端 `today.bathCount +1`、`lastBath` 指向该记录。
- `naiji bath --ago 30 --json`：`happenedAt` 与期望 30 分钟前相差 29ms、落在执行窗口内。
- `naiji b --note 洗香香 --json`：备注写入。
- `naiji bath`（文本、非 TTY）：输出「✅ 已记录 洗澡 · HH:MM」，无 ANSI 颜色码。
- `naiji status`：「💧 距上次换尿布/洗澡  刚刚」「上次 HH:MM · 洗澡」，今日汇总含「洗澡 4 次」且与 `/api/state.today.bathCount` 一致。
- `naiji today` / `naiji log`：文本与 `--json` 均出现洗澡记录（log -n 30 --json 中 4 条）。
- `naiji undo`：删除最近一条洗澡，`deleted.kind="bath"`，服务端确认消失；`bath 多余参数` / `--ago abc` → exit 2 + `usage_error` JSON。

### 11.4 视觉主观评价（逐张亲眼看图后）

本轮亲手看过的截图（2026-11-17 最终运行生成，均在 `docs/screenshots/`）：`stats-390.png`、`stats-dark-390.png`、`bath-390.png`、`mobile-390.png`、`mobile-390-full.png`、`mobile-320.png`、`desktop-900.png`、`dark-390.png`、`empty-390.png`、`multi-select-390.png`、`cross-origin-390.png`、`error-390.png`、`hero-390.png`（后两张为加载失败态与 README 主图，v3 UI 已同步）。

**趋势卡（stats-390.png / stats-dark-390.png）**
- 好评：折线 + 面积渐变 + 红色数据点干净；最大点加粗数值突出；7 个日期标签在 390 宽下间距舒适、不重叠；深色模式折线与网格对比清楚、暖色主视觉延续得好。
- 可挑剔（P2）：
  1. 390 宽下汇总行「最高 220 ml（11-11）」的日期括号被挤到**第二行单独一行**（`（11-11）`），视觉像断句；建议把「最高 M（MM-DD）」整段 nowrap 或缩小字号。
  2. 范围段控按钮高 38px、指标 chips 高 40px，明显比上方大小便按钮（64px）矮，触控目标偏小（与 11.5 P2-1 同源）。
  3. Y 轴中间刻度为 125（yMax/2），不是整百刻度；可读性没问题，但若追求「更整」可标 250/125/0 之外的 4 线方案。
  4. 截图取景裁到了上一张卡片的下边缘（截图方式所致，非产品缺陷）。

**洗澡（bath-390.png）**
- 好评：大小便卡片第三个按钮淡紫底 + 🛁，与蓝/黄两键一眼区分；Hero 第三行「距上次换尿布/洗澡 刚刚」语义自然；时间线洗澡淡紫图标与标题一致；toast「已记录 洗澡 / 撤销」清楚。
- 可挑剔：toast 仍为底部悬浮，会短暂遮住「今日汇总」卡片顶部（约 12px，5 秒），属 v2 继承的 P2（见 §4），洗澡路径同样受影响。

**整页 / 极窄屏 / 深色 / 空库 / 错误 / 跨源**
- `mobile-390-full.png`：趋势卡插在今日汇总与时间线之间，视觉节奏合理；洗澡事件的淡紫 tone 与喂奶/小便/大便区分明显。
- `mobile-320.png`：无横向滚动，洗澡按钮与另两键等宽。可挑剔（v2 继承）：Hero 上次详情把「母乳（瓶喂）」在括号内拆行（「母乳（瓶 / 喂）」），金额「120 ml」已 nowrap 保持完整；建议类型文案整体 nowrap 或缩短。
- `dark-390.png` / `stats-dark-390.png`：暖黑底 + 深珊瑚 Hero/折线，按钮深色态有描边，文本可读；整体一致性好。
- `empty-390.png`：Hero 三行「还没开始 / 还没有喂奶记录 / 还没有换尿布/洗澡记录」，汇总「洗澡 0 次」，趋势卡「最近 7 天还没有数据」，语义完整。
- `error-390.png`：加载失败条 + Hero「换尿布/洗澡记录暂时无法加载」+ 按钮可见禁用态。
- `cross-origin-390.png`：独立静态服务 + 跨源 API 下视觉与同源一致，v3 按钮/趋势卡正常。

### 11.5 问题清单（P0 / P1 / P2）

**P0：无。P1：无。**

**P2（不阻断上线，建议后续打磨）**

1. **趋势卡点击目标偏小**：范围按钮 56×38 / 59×38，指标 chips 102×40（高 <44px）。契约 §6 仍保留 v1「≥48px 点击区」表述，项目 e2e 既有标准为 ≥44px。
   - 复现：390 视口滚动到趋势卡，量取 `.stats-range-btn` / `.stats-metric` 的 `getBoundingClientRect()`。
   - 期望：≥44px（建议 44–48）；实际：38 / 40px。不影响点击功能。证据：G18b 观察项。
2. **390 宽下趋势汇总行「（MM-DD）」折行**：`stats-summary` 的「最高 220 ml（11-11）」把日期括号甩到第二行。
   - 复现：390 视口 + 7 天视图 + 奶量指标；期望「最高 M（MM-DD）」不拆行；实际括号单独一行。证据：`stats-390.png`。
3. **任务书措辞与实现不一致（非产品缺陷）**：任务书称「`stats-chart` 内 SVG `polyline` 折线」，实际 web 用 `<path>`（M/L 段）+ `<circle>` 数据点实现，`polyline` 元素为 0；CONTRACT §6.4 只要求「折线 + 面积渐变 + 数据点」，实现符合契约。建议验收口径改为「按数据点数量/折线段数断言」。
4. **CLI status 比契约示例多一行**：CONTRACT §7.3 status 示例中「距上次换尿布/洗澡」仅一行；实际多输出「上次 HH:MM · 洗澡/小便」。契约已注明「参考」，属增强信息，如要严格对齐可调整示例。
5. **v2 遗留 P2 回归仍存在**（v3 未劣化，也未见修复）：toast 遮挡下方操作区约 12px；320px 多标签 Hero 类型文案括号内折行；主按钮/Hero 白字对比度 1.93–3.80:1；恰好 30 条时「加载更多」空按钮。见 §4。

**观察（不计分）**：趋势卡可见时 SSE 静默重拉存在约 1s 节流（实测 1–1.5s 内完成），符合契约「静默重拉」；同日多条记录时汇总/图表数值仍精确（无重复计数）。

### 11.6 结论

**v3 可以上线。**

- **洗澡事件**：Web 一键记录 → toast/时间线/今日汇总/Hero 计时重置（洗澡会重置「距上次换尿布/洗澡」）、撤销、刷新持久化、SSE 多端实时同步全部实测可用；CSV、CLI（`bath/b`、`--note/--ago/--json`、status/today/log/undo）均与契约一致。
- **趋势卡**：7/30 天、6 指标、图表点数/逐点数值/汇总行与 `GET /api/stats` 完全一致；范围缓存、SSE 静默重拉、空状态、320/390/900 无横向滚动、深色模式全部通过；30 天 X 轴每 5 天标签、只标最高点符合契约。
- **数据层/API**：`kind='bath'`、`state.lastBath/today.bathCount`、`/api/stats` 形状与参数校验、v1→v3 与 v2→v3 迁移（`user_version=3`、放宽 kind CHECK、数据不丢）实测通过。
- **回归**：v2 既有 22 个分组全部 PASS，无功能回归；两次运行 **949/949 PASS、exit 0、明细指纹一致**，脚本可重复执行并自动善后。
- **风险**：P0/P1 为 0；5 项 P2 均为打磨/可访问性/文档口径问题，不阻断上线。建议优先处理 P2-1（趋势卡触控目标 44–48px）与 P2-2（汇总行折行）。

**未覆盖（如实说明）**：iOS Safari / Android 真机与安全区、PWA 添加到主屏后的独立窗口、跨时区部署实跑（仅用固定 tzOffset 验证口径）、超大数据量性能（本轮趋势 33 条、时间线最多约 90 条）、CLI TTY 伪终端交互、长时间运行稳定性。

### 11.7 附：v3 本轮截图产物（最终运行生成）

| 截图 | 尺寸 / 大小 | 内容 |
| --- | --- | --- |
| `bath-390.png` | 780×1688 / 351KB | 点「洗澡」后：Hero 第三行「距上次换尿布/洗澡 刚刚」、大小便三按钮、toast「已记录 洗澡/撤销」 |
| `stats-390.png` | 780×1688 / 164KB | 趋势卡 7 天奶量折线：7 点数值标签、7 个日期、汇总行，上接今日汇总下接时间线 |
| `stats-dark-390.png` | 780×1688 / 154KB | 深色模式趋势卡（折线/面积/标签随主题切换） |
| `mobile-390.png` / `mobile-320.png` / `desktop-900.png` | 780×1688 / 640×1280 / 1800×1800 | v3 UI 首屏、极窄屏与桌面（无横向滚动、按钮不重叠） |
| `mobile-390-full.png` | 780×4358 / 572KB | v3 整页长截图（Hero→记录→汇总→趋势卡→时间线） |
| `dark-390.png` / `empty-390.png` / `multi-select-390.png` / `cross-origin-390.png` / `error-390.png` | 780×1688 | 深色、空库 v3 文案、多选记录、跨源部署、加载失败态 |

> 除 `hero-390.png` 外，上表截图均由 `scripts/browser-e2e.mjs` 每次运行重新生成；本轮已全部覆盖为 v3 UI。`hero-390.png`（README 主图）不是本脚本产物，由团队另行更新，内容已为 v3。

---

## 12. 修复跟进（QA §11 之后，Lead 处理）

QA §11 报告发出后，Lead 按 P2 清单做了两项低成本修复，并回归验证：

| P2 | 处理 | 说明 |
| --- | --- | --- |
| #1 趋势卡可点击控件偏小（range 38px / metric 40px） | ✅ 已修 | `.stats-range-btn` / `.stats-metric` 高度统一为 44px（与项目点击区标准一致）；`docs/screenshots/` 已随 e2e 重新生成 |
| #3 契约写 `polyline`、实现为 `<path>`+`<circle>` | ✅ 已澄清 | CONTRACT §6.4 明确「折线可用 path/polyline + circle 数据点实现，验收不限定具体 SVG 标签」 |
| #2 390px 下汇总日期括号折行 | ⏸ 保留 | 已加 `nowrap` 整体换行（不拆括号），两行展示不影响阅读；如需单行需再缩字号 |
| #4 CLI status 比契约示例多一行「上次 HH:MM · 洗澡/小便」 | ✅ 已同步文档 | CONTRACT §7 status 示例补充该行（属于信息增强，非缺陷） |
| #5 v2 遗留 P2（toast 遮挡 12px、320 Hero 括号折行、对比度、恰好 30 条空按钮） | ⏸ 保留 | 与 v2 时期一致，均为非阻断项 |

回归结果：`node --test` **313/313 PASS**（含新增 DST 回归用例）；`node scripts/browser-e2e.mjs` → **950/950 断言 PASS，exit 0**；截图已更新为 v3 UI + 44px 控件。
