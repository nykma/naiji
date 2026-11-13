# 奶记 · 婴儿喂养记录 — 独立 QA 验收报告

> 验收角色：独立 QA（只读产品代码，仅产出 `scripts/browser-e2e.mjs`、`docs/screenshots/`、本报告；未修改 `src/`、`public/`、`test/`、`package.json`、`docs/CONTRACT.md`，已用文件 mtime 核对）。
> 验收对象：`/home/nykma/Project/nodejs/baby-milk-tracker`（前后端已集成、开发自测通过）。
> 验收方式：真实 CLI 启动服务 + 真实 headless Chrome + CDP 驱动真实页面（真实鼠标点击 / 真实键盘输入 / 真实 `window.confirm` / 真实网络请求），不 mock 任何前端逻辑。

## 0. 结论速览

| 项目 | 结果 |
| --- | --- |
| 端到端脚本 | `scripts/browser-e2e.mjs`（零第三方依赖，Node 内置模块 + CDP） |
| 最终执行结果 | **341 / 341 断言 PASS，exit 0**；连续 3 次运行结果完全一致（含分组明细逐行相同） |
| 单次耗时 | 约 **21.9s**（真实计时 `real 21.937s`，含 Chrome/服务冷启动与清理） |
| 任务书 16 项验收 | 16 / 16 PASS |
| 契约 §8 五项验收 | 5 / 5 PASS |
| P0（阻断） | **0** |
| P1（明显体验问题） | **0** |
| P2（小瑕疵 / 可访问性） | **7 项**（均为非阻断，见第 4 节，建议排入后续迭代） |
| 上线结论 | **可以上线**（无阻断项；P2 建议修复后随下个版本发布） |

---

## 1. 环境与运行方式

### 1.1 实测环境

| 项 | 值 |
| --- | --- |
| OS / 内核 | Linux 7.2.13-xanmod1 x86_64（NixOS） |
| Node | `v24.21.0`（`/nix/store/j1j9b0w3mhpccdli73ycj5w7nf6fkzqz-nodejs-24.21.0/bin/node`，满足 engines ≥22.13） |
| 浏览器 | Google Chrome 157.0.8103.38（headless，`/etc/profiles/per-user/nykma/bin/google-chrome`） |
| 驱动方式 | CDP：`--remote-debugging-port=0` + `<user-data-dir>/DevToolsActivePort` 读端口；Node 内置 `WebSocket` 直连 page target |
| 显示模拟 | `Emulation.setDeviceMetricsOverride`，DPR=2：390×844 / 320×640 / 900×900；截图 780×1688 / 640×1280 / 1800×1800 |
| 时间 | 2026-11-13 13:0x CST；浏览器时区偏移 `tzOffset=-480` |
| 服务启动 | **真实 CLI**：`PORT=<随机空闲端口> HOST=127.0.0.1 DB_PATH=<mkdtemp>/qa.db node src/server.js` |
| 开发自测基线 | 我复跑 `node --test`：**143 tests / 143 pass**（另有 24 suites，非本项目验收结论，仅作基线） |

### 1.2 运行脚本

```bash
cd /home/nykma/Project/nodejs/baby-milk-tracker
/nix/store/j1j9b0w3mhpccdli73ycj5w7nf6fkzqz-nodejs-24.21.0/bin/node scripts/browser-e2e.mjs
echo $?   # 0 = 全部通过；1 = 有失败项（失败明细会打印在末尾“失败明细”）
# 调试时保留临时目录/DB/Chrome profile：
KEEP_ARTIFACTS=1 /path/to/node scripts/browser-e2e.mjs
```

脚本自带完整生命周期管理：每次运行随机空闲端口 + `mkdtemp` 临时 DB + 独立 Chrome profile；结束（含异常）时关闭 CDP、SIGTERM/SIGKILL 进程组、删除临时目录；**不会污染 `data/` 或产品代码**，也不依赖正在运行的服务。可重复执行（已连跑 3 次验证）。

### 1.3 可重复性证据（本次验收实际运行）

| 运行 | 断言结果 | 分组结果 | exit |
| --- | --- | --- | --- |
| 第 1 次（最终版） | 341 / 341 PASS | 21 组全 PASS | 0 |
| 第 2 次 | 341 / 341 PASS | 与第 1 次逐行 diff 完全一致 | 0 |
| 第 3 次 | 341 / 341 PASS | 与第 1 次逐行 diff 完全一致 | 0 |

额外证据：`docs/screenshots/empty-390.png` 在多次运行间 **sha256 完全相同**（`3295599d…b65fab`），说明截图内容可确定性复现（脚本用 `prefers-reduced-motion: reduce` 冻结动效、`Network.setCacheDisabled` 禁用缓存、随机端口/临时 DB 保证数据基线一致）。

### 1.4 脚本探测能力（为什么它不是“点一点而已”）

- 真实鼠标：`Input.dispatchMouseEvent` 在元素中心派发 press/release（能测出遮挡、禁用、真实 hit-test）。
- 真实键盘：`Input.insertText` 输入自定义奶量。
- 真实弹窗：`Page.javascriptDialogOpening` → 自动 `accept`，并断言 confirm 文案与类型。
- 真实网络：监听 `Network.requestWillBeSent` / `responseReceived` / `loadingFailed`，断言 POST/DELETE 状态码、抓 4xx/5xx。
- 真实错误采集：`Runtime.consoleAPICalled`(error) / `Runtime.exceptionThrown` / `Log.entryAdded`(error)。
- 故障注入：`Fetch` 域主动让 `/api/state`、`POST /api/feedings` 返回 `ERR_CONNECTION_REFUSED`，验证错误 UI / 重试 / 按钮禁用；注入期间的错误被**精确标注为预期错误**（不计失败，见第 8 节）。
- 网络挂起：`Fetch` 挂起第一个 POST 请求，验证「请求进行中按钮禁用 → 连点只产生一次记录」。

---

## 2. 验收清单逐项结果（任务书 16 项）

| # | 验收项 | 结果 | 证据（关键断言值 / 截图） |
| --- | --- | --- | --- |
| 1 | 首屏 200；`gap-duration` 非空且格式符合 `(刚刚\|N 分钟\|H 小时( M 分钟)?)`；秒级刷新 | **PASS** | G01：首屏 `GET / → 200`；空库 `"还没开始"` 非空；注入 `happenedAt=now-90*60000` 后 `"1 小时 30 分钟"`（正则匹配）；再注入 2m50s 前记录，`"2 分钟"` → 等待 ~10.5s 后自动变 `"3 分钟"`（`setInterval` 1s 生效）。截图 `screenshots/mobile-390.png` |
| 2 | 点 `volume-chip-120`：toast 含 120、Hero「刚刚」、今日汇总含 120ml/累计正确、时间线首条、POST 201 | **PASS** | G02：`POST /api/feedings → 201`；toast = `已记录 奶粉 120 ml` 且含「撤销」；Hero = `"刚刚"`；`today.totalMl` 180→**300**，汇总条含 `300 ml`；时间线首条 `奶粉 120 ml`；事件数 +1。截图 `screenshots/mobile-390-after-record.png`（含 toast） |
| 3 | `toast-undo` 撤销后终态与操作前一致、无残留 | **PASS** | G03：`DELETE /api/events/:id → 204`；服务端事件数恢复；`GET /api/events` 中**不存在**刚创建的 id（同 `happenedAt` 无残留）；DOM 条数恢复；Hero 回退到上一条 `奶粉 60 ml` |
| 4 | 母乳（瓶喂）60ml；亲喂 → 记录正确 | **PASS** | G04：`母乳（瓶喂）60ml` POST 201，toast/首条/`today.breastMl +60` 全对；`亲喂` POST 201，首条「亲喂」、`breastDirectCount +1`、Hero 变「亲喂」；类型选择写入 `localStorage`，**刷新后仍保持亲喂选中**（契约要求） |
| 5 | 自定义 999ml（合法 1–2000） | **PASS** | G05：输入 999 → POST 201；toast `已记录 奶粉 999 ml`；首条 `奶粉 999 ml`；`formulaMl +999`（180→1179）。附加：输入 2001 被前端拦截，错误 toast“1 到 2000”，**未发出 POST**（请求计数不变） |
| 6 | 小便 / 大便按钮 → 时间线出现 | **PASS** | G06：`POST /api/diapers → 201` ×2；toast `已记录 小便` / `已记录 大便`；首条与历史列表均出现「小便」「大便」；`peeCount +1`、`poopCount +1` |
| 7 | 时间线删除：confirm → 消失 | **PASS** | G07：`Page.javascriptDialogOpening` type=`confirm` 文案含「确定删除」；自动 accept 后 `DELETE → 204`；toast `已删除这条记录`；DOM 与 `GET /api/events` 均消失；**删除的是最新喂奶 → Hero 回退为「亲喂」**（服务端校准正确） |
| 8 | 持久化：`Page.reload` 后数据仍在 | **PASS** | G08：刷新后时间线条数 = min(30,总数)、首条仍是最新记录、Hero 上次喂奶/时长正确、导出入口可见。截图 `screenshots/mobile-390-full.png`（整页） |
| 9 | 加载更多：40+ 条历史 → 首屏 30 → 点 `load-more` → 条数增加到 40+ → 按钮消失 | **PASS** | G09：API 造 45 条（不同 `happenedAt`，跨天）→ 总 51 条；首屏 **30** 条 +「加载更多」；点击后 `GET /api/events → 200`，DOM 变 **51** 条、去重后 51（无重复）；按钮隐藏；日期分组 `["今天","昨天",…]` |
| 10 | `export-csv` 链接存在；`GET /api/export.csv` 200 + BOM + 中文项目名 + 记录数正确 | **PASS** | G10：链接 `href=/api/export.csv` 且有 `download`；CSV 带 BOM（`ef bb bf`）、表头 `时间,类别,项目,奶量(ml),备注`、**53 行 = 全部事件数 53**；含 `奶粉/母乳（瓶喂）/亲喂/小便/大便`；逗号+引号备注正确转义；时间升序且格式 `YYYY-MM-DD HH:mm`；`Content-Disposition: attachment; filename="baby-milk-2026-11-13.csv"` |
| 11 | 空库：`empty-state` 可见、今日汇总 0、无记录提示 | **PASS** | G14：清空 DB 后刷新：`empty-state` 可见、时间线 0 条、汇总 `喂奶 0 次 · 奶量 0 ml · 小便 0 · 大便 0`、`gap-last-feed="还没有喂奶记录"`、`gap-duration="还没开始"`、`gap-last-diaper="还没有大小便记录"`；API `lastFeeding/lastDiaper=null`、`recent=[]`。截图 `screenshots/empty-390.png` |
| 12 | 320/390/900 无横向滚动；奶量 chip、大小便按钮点击区 ≥44px | **PASS** | G12：三视口 `documentElement.scrollWidth <= innerWidth`（320/390/900 均相等）；chip：390=101×58、320=83×54、900=167×58；大小便：155×64 / 128×64 / 254×64；关键按钮两两**无重叠**；桌面内容区 `main` 宽 560px 且左右留白各 154px 居中。截图 `screenshots/mobile-320.png`、`screenshots/desktop-900.png` |
| 13 | 深色模式：背景/文字与浅色不同且对比度合理 | **PASS** | G13：`prefers-color-scheme: dark` 后 body 背景 `rgb(255,248,242)→rgb(23,17,16)`、文字 `rgb(58,42,34)→rgb(240,227,218)`、卡片背景变化；正文对比度 **浅色 13.01:1 / 深色 14.86:1**（WCAG AA 4.5:1 通过）；`matchMedia` 确认模拟生效。截图 `screenshots/dark-390.png` |
| 14 | console error / 未捕获异常 / Log error / 4xx-5xx 网络响应为空（预期项除外、精确记录） | **PASS** | G17：`console.error=0`、`exceptionThrown=0`、`Log.entryAdded(error)=0`、非 cancel 网络失败=0、浏览器 4xx/5xx=**0**；全程仅 1 个原生对话框（删除 confirm）。故障注入产生的 **6 条**预期错误逐条标注（见第 8 节），未混入失败项 |
| 15 | 静态资源全部 200、无 404（app.css/app.js/icon.svg/manifest 等） | **PASS** | G17：真实网络请求 `/`、`/app.css`(text/css)、`/app.js`(text/javascript)、`/lib/format.js`、`/icon.svg`(image/svg+xml)、`/manifest.webmanifest`(application/manifest+json) 全部 200；404 计数 0；**无任何外部 CDN/第三方请求** |
| 16 | 截图输出到 `docs/screenshots/` 指定 7 张 | **PASS** | G18：7 张必需截图全部生成且尺寸正确，脚本每次覆盖。见第 7 节清单 |

## 2.2 契约 §8「测试与验收」五项

| 契约验收项 | 结果 | 对应证据 |
| --- | --- | --- |
| 1. 首屏显示「距离上次喂奶」且秒级刷新 | **PASS** | G01（2 分钟 → 3 分钟）；截图 `mobile-390.png` |
| 2. 点奶量按钮 → toast → Hero「刚刚」→ 今日汇总增加 → 时间线新增 | **PASS** | G02（POST 201 / 300 ml / 首条 奶粉 120 ml）；截图 `mobile-390-after-record.png` |
| 3. 点大小便按钮出现对应记录 | **PASS** | G06 |
| 4. 撤销可删除记录 | **PASS** | G03（服务端无残留）；另 G06b 连点防重复后撤销清理 |
| 5. 390×844 无横向滚动、按钮不重叠 | **PASS** | G12（scrollWidth=390；关键按钮无重叠） |

## 2.3 额外覆盖（超出任务书要求，均为 PASS）

| 额外检查 | 结果 | 说明 |
| --- | --- | --- |
| 连点防重复（契约 §5「请求中禁用，防连点重复记录」） | **PASS** | G06b：挂起首个 POST 模拟慢网 → 请求中 chip `disabled=true`；快速连点两次只产生 **1 次** POST、服务端只 +1 条；撤销后基线恢复 |
| 首屏加载失败 → 错误提示 → 记录按钮禁用 → 重试恢复（前端同学注意点 2） | **PASS** | G11：注入 `/api/state` 失败后错误条可见、**10 个记录按钮全部 disabled**、Hero/汇总/时间线给出失败提示；重试后错误条隐藏、按钮恢复、数据回填。截图 `screenshots/error-390.png` |
| 记录失败错误 toast 显示后端 message | **PASS** | G11：注入 POST 失败 → toast `网络连接失败，请检查服务是否正常运行`（`toast--error` 样式），服务端无残留数据，按钮恢复可用 |
| 类型选择 localStorage 记忆 | **PASS** | G04：刷新后仍保持「亲喂」选中态 |
| 撤销/删除后的 Hero 回退（本地无法推算时由服务端校准） | **PASS** | G03 / G07：删除最新喂奶后 Hero 回退到「亲喂」 |
| 同毫秒 `happenedAt` 的游标分页（额外手工探针） | **PASS** | 造 5 条同 `happenedAt`，`limit=2` 翻 3 页：`[[5,4],[3,2],[1]]`，无重复、无遗漏 |
| PWA/manifest/CSP/安全头 | **PASS** | G15：CSP 含 `default-src 'self'` + `script-src 'self'`；`X-Content-Type-Options: nosniff`；HTML `Cache-Control: no-cache`；页面无内联脚本请求异常 |
| 目录穿越防护 | **PASS** | G15：`/..%2fpackage.json`、`/..%2f..%2fsrc%2fserver.js`、`/%2e%2e/package.json` 均 404；静态路径非 GET → 405 |

---

## 3. 视觉与体验主观评价（亲自看截图后）

### 3.1 整体观感

**结论：完成度高于一般内部工具，可以直接给爸妈用。** 奶油暖底 + 珊瑚橙 Hero 的配色统一且不刺眼；卡片圆角与阴影克制；字号层级（34px Hero 数字 → 16px 正文 → 11~13px 辅助文案）清楚；emoji 图标风格一致（🍼/🥛/🤱/💧/💩）且与业务语义对应准确。信息架构对“单手、抱娃、快速记录”场景很友好：从顶栏到 Hero 再到喂奶/大小便操作区都在首屏或一屏内，快捷奶量 chip 大（390px 下 101×58px），错误点击成本低。

深色模式不是简单反色，而是重新调过一套暖灰棕配色（背景 `#171110`、卡片 `#221a17`、文字 `#f0e3da`），正文对比度 14.86:1，观感舒服；Hero 在深色下仍保持品牌橙，视觉重心明确。320px 极窄屏也没有破版：导出按钮收成 44px 图标圆钮、chip 收窄到 83×54px、汇总折两行（前端同学已说明，确认**不是 bug**）。

### 3.2 做得好的细节

1. Hero 大数字是绝对视觉焦点，一眼看到「距离上次喂奶」，符合核心诉求。
2. 记录成功 toast 底部浮层带「撤销」，5s 时限 + 进度条（`toast::after` 动画），符合移动端直觉。
3. 今日汇总放操作区下方、时间线上方，顺序合理；「已显示 N 条」「今天 6 条」这类计数降低了长列表焦虑。
4. 时间线按本地日期分组（今天/昨天/前天/日期 周几），删除按钮低调（灰 ×）且必须 `confirm`，误删防护到位。
5. 请求中按钮禁用 + `body.is-busy` 透明度反馈，连点防护真实有效（已断言）。
6. `prefers-reduced-motion`、`env(safe-area-inset-*)`、`color-scheme`、`theme-color` 双媒体 query、`viewport-fit=cover` 都齐了，工程细腻度不错。
7. 离线/加载失败态不是白屏：错误条 + Hero 文案 + 禁用按钮 + 重试，降级路径完整。

### 3.3 可挑剔 / 改进建议（按优先级）

> 以下均在下方 P2 问题清单中有复现与建议，这里只给“如果只改 3 件事”的排序。

1. **优先修（一行 CSS）**：加载失败时记录按钮 `disabled` 却看起来完全可用（无灰度/cursor 反馈）→ 用户会反复空点。加 `.record-btn:disabled { opacity:.55; cursor:not-allowed }`。
2. **优先修（一行属性）**：≤359px 时「导出 CSV」只剩图标，读屏软件读到的链接名称为空 → 加 `aria-label="导出 CSV"`。
3. **建议排期**：Hero/主按钮的白色文字在珊瑚渐变上对比度不足（Hero 最低 1.93:1、主按钮最低 2.11~2.31:1，低于 WCAG AA）。视觉上“能看清”，但强光下/低视力用户不友好；建议加深渐变端或给白字加轻微阴影。

其余：恰好 30 条时的「加载更多」空按钮（一次无意义点击）、toast 撤销按钮 42px 略小于 44/48px、toast 出现时短暂压住底部内容、深色模式分段选中态分隔偏弱——都属于打磨项，不影响上线。

---

## 4. 问题清单（P0 / P1 / P2）

### P0（阻断上线）— 无

未发现数据错误、崩溃、白屏、接口不可用、控制台报错、横向滚动、按钮不可点击等阻断级问题。所有 341 条断言 PASS，两次独立运行结果一致。

### P1（明显体验问题）— 无

### P2（小瑕疵 / 可访问性，建议排期）

#### QA-P2-01 加载失败时记录按钮 `disabled` 但无任何视觉反馈

- **最小复现**：断网（或脚本用 CDP `Fetch` 让 `/api/state` 返回 `ERR_CONNECTION_REFUSED`）→ 刷新页面 → 页面顶部出现「加载失败」错误条，此时观察奶量 chip。
- **期望**：禁用的按钮应有可感知的灰化/降透明度/`cursor:not-allowed`，让用户知道“现在点不了、先重试”。
- **实际**：按钮 `disabled=true`，但计算样式与正常态**完全一致**（实测 `opacity:1; background:rgb(255,244,235); color:rgb(94,67,53); cursor:pointer`）；用户点击无任何反馈。截图：`screenshots/error-390.png`。
- **建议修法**：`app.css` 补一条 `.record-btn:disabled { opacity: .55; cursor: not-allowed; }`（现有 `body.is-busy .record-btn` 的 0.62 样式可复用/统一）。低风险、无逻辑改动。
- **证据**：脚本 G11 观察项「加载失败时记录按钮视觉无禁用反馈（P2）」；截图 `screenshots/error-390.png`。

#### QA-P2-02 320px 窄屏下「导出 CSV」链接无无障碍名称

- **最小复现**：视口 ≤359px（如 320×640）→ 用 CDP `Accessibility.getPartialAXTree` 读取导出链接节点 → `role=link, name=""`。
- **原因**：`@media (max-width:359px)` 里 `.export-link span { display:none }` 隐藏了唯一文本，SVG 是 `aria-hidden="true"`，链接本身没有 `aria-label`/`title`；`display:none` 的文本不会进入无障碍树。
- **期望**：读屏软件能读出「导出 CSV」。
- **实际**：AX 名称为空（390px 下为 `"导出 CSV"`，已断言）。
- **建议修法**：`index.html` 的导出链接加 `aria-label="导出 CSV"`（一行）。
- **证据**：脚本 G13b 观察项；`screenshots/mobile-320.png`（图标钮形态）。

#### QA-P2-03 Hero 大字号白字 / 主按钮白字对比度低于 WCAG AA

- **实测数据**（脚本从 computed style 渐变色计算）：
  - Hero 时长白字：渐变三端对比度 **2.07 / 3.12 / 1.93 : 1**（34px/800；WCAG 大字号 AA 要求 3:1，浅端不达标）。
  - 主按钮「记录」白字：浅色 **2.31 / 3.80 : 1**、深色 **2.31 / 2.11 : 1**（15px/700；正文 AA 要求 4.5:1）。
- **期望**：主要信息与主按钮文字达到 WCAG AA（或至少视觉上强对比）。
- **实际**：截图观感可读（白字+粗体+大字号），但在强光/低视力场景下对比不足。
- **建议修法**：加深渐变暗端（如 `--hero-2` 调至 `#d94a33`、`--primary-strong` 调至 `#c8472e`），或给白字加 `text-shadow: 0 1px 2px rgba(90,30,10,.25)`；需设计/产品确认品牌色。属 a11y 改进，非契约硬要求。
- **证据**：脚本 G13b 两条观察项。

#### QA-P2-04 恰好 30 条记录时「加载更多」按钮可见，但已无更多数据

- **最小复现**：让库中恰好有 30 条记录 → 刷新 → 首屏 30 条，底部出现「加载更多」→ 点击 → 无新增，按钮随后消失。
- **期望**：契约 §5「无更多时隐藏」。
- **实际**：首屏只能靠 `recent.length >= 30` 猜测 `hasMore`，恰好 30 条时误显示。属一次无意义点击，不影响数据。
- **建议修法**：`/api/state` 增加 `hasMore` 字段（多取 1 条判断），前端直接使用；契约 §4 同步更新。或首屏 `/api/events?limit=31` 自行判断。
- **证据**：脚本 G16（造恰好 30 条，观察项 + 点击后条数不变、按钮隐藏的断言）。

#### QA-P2-05 toast「撤销」按钮高度 42px，略小于 44/48px 触控建议

- **实测**：`64×42px`（其它主按钮 48/52/58/64px，均达标）。
- **建议**：`height: 44px`（或 48px），宽度不变；撤销是 5 秒时限的重要操作，值得更大触控目标。
- **证据**：脚本 G02 观察项。

#### QA-P2-06 toast 出现的 5 秒内会遮挡底部内容（窄屏更明显）

- **最小复现**：390/320 视口记录一次喂奶 → 底部 toast 覆盖约 90px 高度；320 截图可见「记录大小便」按钮被 toast 压住一部分，此期间该区域不可点击（toast 本身 `pointer-events:auto`）。
- **期望**：记录成功后仍能立即操作下一项（如马上记大小便）。
- **建议**：记录成功后自动把视图滚到汇总/时间线并避开按钮区；或 toast 出现时为 body 增加底部占位；或将撤销窗口降到 3.5~4s。属体验优化（用户在 390 下本来也需要滚动才能点到大小便按钮，实际影响有限）。
- **证据**：`screenshots/mobile-390-after-record.png`。

#### QA-P2-07 深色模式分段控件选中态区分偏弱

- **实测**：选中项背景 `#3b2b24` vs 轨道 `#2b211d`，主要靠文字色（珊瑚 vs 灰）区分；`dark-390.png` 中「奶粉」选中块边界较淡。
- **建议**：选中态加 1px 高亮描边或细阴影，或拉开背景明度差。主观项，可随下次视觉迭代处理。
- **证据**：`screenshots/dark-390.png`。

> 已确认为**非 bug**：320px 今日汇总折成两行（实测高度 47px；前端同学已说明，390px 单行）——属于窄屏合理重排，不计问题。

---

## 5. 契约一致性抽查

### 5.1 API 字段与格式（PASS）

- `/api/state`：`now/lastFeeding/lastDiaper/recent/today` 齐全；`recent` 最多 30 条；`today.date` 为 `YYYY-MM-DD`（实测 `"2026-11-13"`）；`today` 各计数与 `totalMl = formulaMl + breastMl` 一致；空库时 `lastFeeding/lastDiaper=null`、`recent=[]`。
- Event JSON 字段**精确**为 `[id, kind, feedType, amountMl, diaperKind, note, happenedAt, createdAt]`（camelCase），时间均为 number（epoch ms）；`breast_direct` 的 `amountMl=null`；diaper 事件 `feedType/amountMl` 为 `null`。
- `mixed` 计数语义验证：`diaperCount+1`、`mixedCount+1`、`peeCount+1`、`poopCount+1` 同时成立（契约 §4 要求）。
- 分页：`limit` 1–200；`before/beforeId` 复合游标（额外探针：同毫秒 5 条记录翻页无重复、无遗漏）。

### 5.2 错误码与错误体（PASS，共 20 类实测）

| 场景 | 实测 |
| --- | --- |
| Content-Type 非 JSON | `415 unsupported_media_type` |
| 非法 JSON / 空体 / 非对象 | `400 invalid_json` |
| 非法 feedType | `400 invalid_feed_type` |
| 奶量 0 / 2001 / 非整数 | `400 invalid_amount` |
| 亲喂带奶量 | `400 unexpected_amount` |
| happenedAt 字符串 / 超前 10 分钟 | `400 invalid_happened_at` |
| note 超 200 字 / 非字符串 | `400 invalid_note` |
| 非法 diaperKind | `400 invalid_diaper_kind` |
| limit=0 / limit=201 | `400 invalid_limit` |
| tzOffset=9999 / abc | `400 invalid_tz_offset` |
| before=abc | `400 invalid_cursor` |
| 删除不存在记录 | `404 not_found`（message「记录不存在」） |

错误体均为 `{ error, message }`，`message` 为可直接展示的中文（已断言含中文字符）。成功路径：创建 `201 {event}`、删除 `204` 空体、列表/状态 `200`。

### 5.3 时间格式（PASS）

- API/DB 时间均为 epoch 毫秒 number；`happenedAt` 默认 now、可自定义（用于首屏/分页造数）。
- 前端展示用浏览器本地时区：`HH:mm`（断言 `^\d{2}:\d{2}$`）、时长格式 `刚刚 / N 分钟 / H 小时 M 分钟 / D 天 H 小时`（正则断言）。
- 前端 `tzOffset=new Date().getTimezoneOffset()`（实测 -480）传入 `/api/state`，与服务端统计口径一致。

### 5.4 CSV（PASS）

- `Content-Type: text/csv; charset=utf-8`；`Content-Disposition: attachment; filename="baby-milk-YYYY-MM-DD.csv"`；UTF-8 **BOM**（`ef bb bf`）。
- 表头逐字符 `时间,类别,项目,奶量(ml),备注`；数据行数 = 全部事件数（53/53）；按 `happenedAt` **升序**；时间列 `YYYY-MM-DD HH:mm`。
- 中文项目名 `奶粉 / 母乳（瓶喂）/ 亲喂 / 小便 / 大便` 全部出现；含逗号与双引号的备注按 RFC4180 正确转义（`"夜里,加""餐"""`）。

### 5.5 静态托管与安全头（PASS）

- HTML 带 CSP：`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; manifest-src 'self'`；`X-Content-Type-Options: nosniff`；`Cache-Control: no-cache`。
- MIME 正确：html/css/js/svg/webmanifest；无 404、无外部 CDN（页面全部请求同源）。
- 目录穿越 3 种编码均 404；静态路径非 GET/HEAD → 405。
- 页面无内联脚本（CSP `script-src 'self'` 下无 console 报错），符合契约 §5 实现约束。

### 5.6 备注与契约解释

1. **CSV 时区**：契约规定 CSV 时间用“服务器本地时区”，而 UI 用浏览器本地时区。服务器与手机在同一时区（典型家庭局域网部署）时一致；若服务器在 UTC、手机在东八区，CSV 与页面时间会差 8 小时。**这是契约既定行为，不算缺陷**，但建议 README 提示部署时区，或后续统一为导出请求携带 `tzOffset`。
2. **空库/错误态文案**：`gap-duration` 空库显示「还没开始」、加载失败显示「—」；契约未规定具体文案，实现合理，不视为偏差。
3. **`invalid_tz_offset` / `invalid_limit` / `invalid_cursor`** 等错误码未在契约 §4 逐条列出，但符合「400 参数错误 + 中文 message」总约定。
4. **`hasMore` 缺失**：见 P2-04，属契约 §5「无更多时隐藏」的边界实现瑕疵（仅恰好 30 条时触发）。

---

## 6. 结论

**可以上线。**

- 功能验收：任务书 16 项 + 契约 §8 五项 **全部 PASS**；341 条断言在 3 次独立运行中全部通过且结果一致，脚本可重复、可回归（每次约 22s）。
- 质量结论：核心链路（首屏、一键记录、撤销、大小便、删除确认、持久化、分页、CSV、空库、响应式、深色模式、错误恢复）均真实可用；控制台零报错、网络零 4xx/5xx、零外部依赖，工程实现与契约高度一致。
- 风险结论：**P0/P1 为 0**，不影响上线；7 项 P2 均为打磨/可访问性/边界项，其中 QA-P2-01、QA-P2-02 建议在发版前用一行 CSS / 一行 `aria-label` 顺手修掉，其余排入下个迭代。

**未覆盖范围（如实说明）**：iOS Safari 实机与刘海安全区表现、PWA 添加到主屏后的独立窗口行为、多设备/多标签页并发写入、跨时区部署、长时间（>1 天）运行与超大数据量（本脚本最大 53 条，未压测 200+ 分页多轮）、无障碍全量审查（仅抽查 2 个元素）。这些不在本轮任务范围，建议后续按需补充。

---

## 7. 附：实际亲眼看过的截图清单

> 全部位于 `docs/screenshots/`，由脚本每次运行覆盖生成；我逐张打开看过并据此给出第 3 节评价。

| 截图 | 尺寸 / 大小 | 我看到了什么 |
| --- | --- | --- |
| `screenshots/mobile-390.png` | 780×1688 / 335.1KB | 首屏：Hero `1 小时 30 分钟`、上次 `11:33 · 奶粉 120 ml`、奶粉/母乳/亲喂分段、6 个奶量 chip、自定义输入、大小便按钮，层级清晰 |
| `screenshots/mobile-390-after-record.png` | 780×1688 / 327.6KB | Hero 变「刚刚」+ 底部深色 toast `已记录 奶粉 120 ml / 撤销`；toast 覆盖底部约 90px（见 P2-06） |
| `screenshots/mobile-390-full.png` | 780×2902 / 430.4KB | 整页：Hero + 喂奶 + 大小便 + 今日汇总（喂奶 4 次/奶量 240ml/亲喂 1 次/小便 1/大便 1）+ 按「今天」分组的时间线 6 条 + 页脚备份提示 |
| `screenshots/mobile-320.png` | 640×1280 / 235.1KB | 320 极窄屏：导出按钮收为 44px 图标圆钮、chip 83×54、无横向滚动；汇总折两行（非 bug） |
| `screenshots/desktop-900.png` | 1800×1800 / 459.7KB | 900 桌面：内容区 560px 居中、左右各 154px 留白；Hero/卡片无拉伸变形 |
| `screenshots/dark-390.png` | 780×1688 / 313.8KB | 深色模式：暖黑底 + 深珊瑚 Hero，文字对比清晰；分段控件选中态区分稍弱（见 P2-07） |
| `screenshots/empty-390.png` | 780×1688 / 323.7KB | 空库：Hero「还没开始 / 还没有喂奶记录 / 还没有大小便记录」，操作区完整可用；该图 sha256 在多次运行间完全一致 |
| `screenshots/error-390.png`（附加） | 780×1688 / 316.1KB | 加载失败态：错误条「加载失败：网络连接失败…」+ 重试按钮；Hero 提示「加载失败，请点上方重试」；按钮看起来仍可用（见 P2-01） |

---

## 8. 附：最后一次运行日志摘要

```
  ✓ G00 环境与启动（真实 CLI 入口）      6/ 6 PASS
  ✓ G01 首屏 200 / 距离上次喂奶格式 / 秒级刷新 11/11 PASS  (~10.5s，含等待 2 分钟→3 分钟)
  ✓ G02 点 120ml 快捷按钮：toast / Hero / 今日汇总 / 时间线 / POST 201 10/10 PASS
  ✓ G03 toast 撤销：记录不残留        7/ 7 PASS
  ✓ G04 母乳（瓶喂）60ml / 亲喂（含类型记忆） 17/17 PASS
  ✓ G05 自定义奶量 999ml + 前端范围校验  7/ 7 PASS
  ✓ G06 小便 / 大便一键记录           9/ 9 PASS
  ✓ G06b 连点防重复：请求进行中按钮禁用，只记录一次  7/ 7 PASS
  ✓ G07 时间线删除：window.confirm → DELETE → 服务端/UI 同步  9/ 9 PASS
  ✓ G08 刷新持久化（Page.reload）    7/ 7 PASS
  ✓ G09 加载更多：30 条首屏 → 游标翻页 → 全部展示 → 按钮隐藏 11/11 PASS
  ✓ G10 导出 CSV：链接 / BOM / 中文项目名 / 记录数 / 转义 19/19 PASS
  ✓ G11 首屏加载失败：错误提示 / 记录按钮禁用 → 重试恢复 11/11 PASS
  ✓ G12 320 / 390 / 900 视口：无横向滚动 + 点击区 ≥ 44px + 按钮不重叠 47/47 PASS
  ✓ G13 深色模式：配色切换 + 对比度       6/ 6 PASS
  ✓ G13b 无障碍与对比度细节抽查           2/ 2 PASS
  ✓ G14 空库状态：empty-state / 今日汇总为 0 / 无记录提示 17/17 PASS
  ✓ G15 契约一致性抽查（API 字段 / 错误码 / 静态头 / CSV） 91/91 PASS
  ✓ G16 边界：恰好 30 条记录时「加载更多」的表现  4/ 4 PASS
  ✓ G17 控制台错误 / 未捕获异常 / 4xx-5xx 网络响应 / 静态资源 200 15/15 PASS
  ✓ G18 截图产物完整性（docs/screenshots/） 28/28 PASS
  ─────────────────────────────────────────────
  断言总数 341：PASS 341 / FAIL 0
  总体结果：PASS（exit 0）
```

### 故障注入预期错误（脚本精确记录、不计失败，共 6 条）

1. `network-failure: GET /api/state?tzOffset=-480 → net::ERR_CONNECTION_REFUSED`（验证加载失败态）
2. `log-error: Failed to load resource: net::ERR_CONNECTION_REFUSED`（同上，浏览器日志）
3. `console: [奶记] 加载失败: ApiError: 网络连接失败，请检查服务是否正常运行`（应用错误日志，因页面处于预期失败态）
4. `network-failure: POST /api/feedings → net::ERR_CONNECTION_REFUSED`（验证记录失败路径）
5. `log-error: Failed to load resource: net::ERR_CONNECTION_REFUSED`（同上，浏览器日志）
6. `console: [奶记] 记录喂奶失败: ApiError: 网络连接失败，请检查服务是否正常运行`（应用错误日志，因页面处于预期失败态）

除上述 6 条主动注入的预期错误外，**全流程 console error / 未捕获异常 / Log error / 4xx-5xx 均为 0**。

### 观察项（不计入 PASS/FAIL，均已列入第 4 节 P2）

```
⚠ toast「撤销」按钮高度略小于 44px — 64×42px
⚠ 加载失败时记录按钮视觉无禁用反馈（P2）
⚠ 320px 今日汇总折行 — 高 47px，两行（前端已说明不算 bug）
⚠ 时间线删除按钮点击区域 — 44×44px
⚠ 主按钮白字对比度（浅色） — 2.31 / 3.80:1
⚠ 320px 下导出链接无无障碍名称（P2）
⚠ Hero 大字号白字对比度 — 2.07 / 3.12 / 1.93:1
⚠ 主按钮白字对比度（深色） — 2.31 / 2.11:1
⚠ 恰好 30 条时「加载更多」按钮 — 可见但无更多数据（P2）
```

---

## 9. 修复跟进（QA 报告之后，Lead 处理）

QA 报告发出后，Lead 按 P2 清单做了 4 个低成本修复，并用本报告同一套脚本回归验证：

| P2 | 处理 | 说明 |
| --- | --- | --- |
| #1 加载失败时按钮无禁用视觉 | ✅ 已修 | `.record-btn:disabled { opacity:.58; cursor:not-allowed }`；G11 新增的「可感知的禁用视觉反馈」断言 PASS |
| #2 ≤359px 导出链接 AX 名称为空 | ✅ 已修 | `<a>` 增加 `aria-label="导出 CSV"`；G13b 两条断言 PASS |
| #5 toast 撤销按钮 42px | ✅ 已修 | 高度改为 44px，观察项消失 |
| #7 深色模式分段选中态偏弱 | ✅ 已修 | 深色下选中 pill 加深 + 珊瑚内描边；见 `dark-390.png` |
| #3 Hero / 主按钮白字对比度 | ⏸ 保留 | 设计取舍：珊瑚渐变是产品视觉主轴，改到 WCAG AA 需整体换配色，记入已知限制 |
| #4 恰好 30 条时「加载更多」 | ⏸ 保留 | 多点一次即自动隐藏；彻底修需 `/api/state` 增加 hasMore 字段 |
| #6 toast 遮挡底部内容 | ⏸ 保留 | 标准底部固定 toast，5s 自动消失 |

回归结果：`node scripts/browser-e2e.mjs` 连跑 2 次均 **343/343 PASS，exit 0**；`node --test` **143/143 PASS**；`docs/screenshots/` 已随最新代码重新生成。
