# dsh-gold-card 开发契约（v3 集成）

本文件是 Host 半边、聚合层、前端面板三方并行开发的**唯一接口约定**。
任何改动先改这里，再改代码；三方不得单方面变更字段名。

---

## 1. 插件形态

- CommonJS 包，`main: lib/index.cjs`，`package.json` 里 `dsh.bundle.patch: ./cordis.patch.yml`。
- `cordis.patch.yml`：`- insert: [{ id: dsh-gold-card, name: dsh-gold-card }]`
- 插件模块导出 `{ name: 'dsh-gold-card', apply(ctx, config) }`（Cordis 插件约定）。
- 零第三方依赖：只用 `node:https` / `node:zlib` / `node:crypto` / `node:url` / `node:fs` / `node:path`。

## 2. Host 半边（lib/index.cjs，Lead 独占）

### 2.1 路由注册（真实 API，骨架里写错了）

```js
const webServer = ctx.get('webServer')          // 可能晚于 apply() 就绪，要重试获取
webServer.register({ kind: 'exact', path: '/dsh-gold/panel.js', resource })
webServer.register({ kind: 'exact', path: '/dsh-gold/panel.css', resource })
webServer.register({ kind: 'exact', path: '/dsh-gold/api/quotes', resource })
webServer.register({ kind: 'exact', path: '/dsh-gold/api/status', resource })
webServer.register({ kind: 'exact', path: '/dsh-gold/api/mounted', resource })
webServer.register({ kind: 'exact', path: '/dsh-gold/api/diag', resource })   // 前端挂载诊断 → 写日志
```

- **不存在 `webServer.route(key, handler)`**，用 `register({kind:'exact',path,...})`。
- 路由可以用 `handler: (req,res)=>{}`（自己写响应），或 `resource: (request: Request, peer) => Response`。
  本项目统一用 **resource**：HTTP 走 `serveResource`，进程内还能用 `webServer.readResource()` 自检。
- 重复 `(kind,path)` 会抛错，注意只注册一次。

### 2.2 index 注入（桌面端可见的唯一通道）

```js
ctx.effect(() => ctx.on('webserver/index-inject', (table, peer) => {
  table.push({ kind: 'script', placement: 'body', text: bootstrap })
}))
```

- `collectIndexInjections()` 是 webServer 自己的方法（内部 emit），**不是插件要调用的 API**；
  插件监听 `webserver/index-inject` 事件往 table 里 push 行。
- 行类型：`global|script|script-src|script-preload|style|html`；`script` 行 placement 为 `head|body`。
- 只注入一段极小自举脚本，由它插 `<link href="/dsh-gold/panel.css">` 与 `<script src="/dsh-gold/panel.js">`；
  路由可能比注入晚就绪 → 自举脚本要重试（最多 80 次 × 150ms），onerror 要 console.error 留痕。
- 不要把 panel.js 内容内联进注入行（启动快照，改了要重启）；内联自举 + URL 加载才只需要刷新页面。

### 2.3 自检

apply() 里在路由注册完成后，用 `webServer.readResource(new Request('http://x/dsh-gold/api/quotes'))`
自检一次并写日志（`$DSH_HOME/.dsh-gold-card.log`），用于安装后无需 HTTP 客户端即可确认挂载成功。

## 3. 行情接口契约（GET /dsh-gold/api/quotes）

```jsonc
{
  "fetchedAt": "2026-11-06T08:26:07.000Z",
  "baseAu9999": 868.6,               // 上金所 Au99.99 最新价，用于溢价基准；null = 不可用
  "cards": {
    "sge": {
      "id": "sge", "title": "上海黄金交易所 Au99.99", "unit": "元/克",
      "source": "上海黄金交易所官网", "ok": true, "error": null,
      "stale": false,                                   // 缓存回退标记
      "quoteTime": "2026年11月06日 15:45:00",            // 数据源自带时间戳，禁止用本地抓取时刻冒充
      "session": "夜盘",                                 // 上金所口径：夜盘 | 日盘（可选）
      "timeNote": "夜盘归属下一交易日，时间戳为所属交易日（非自然日）", // 仅夜盘时给，前端渲染口径说明
      "freshness": { "fresh": true, "ageMinutes": 41, "note": null },
      "fields": [ {"label":"最新价","value":868.6,"hero":true},
                  {"label":"涨跌幅","value":-1.75,"unit":"%","tone":"down","kind":"change"},
                  {"label":"昨收","value":884.09}, {"label":"最高","value":887}, {"label":"最低","value":866} ],
      "crossCheck": { "level": "verified", "label": "✅ 已交叉校验", "detail": "接口A 868.60 vs 接口B 868.60，差 0.00 元/克" }
    },
    "intl": {
      "id": "intl", "title": "国际金价 伦敦金 XAU/USD", "unit": "美元/盎司",
      "source": "新浪财经", "ok": true, "error": null, "stale": false,
      "quoteTime": "2026-11-06 16:25:00",
      "freshness": {...},
      "fields": [ {"label":"最新价","value":4060.32,"hero":true},
                  {"label":"24h涨跌","value":-0.7,"unit":"%","tone":"down","kind":"change"},
                  {"label":"昨收","value":4088.8}, {"label":"最高","value":4106.79}, {"label":"最低","value":4035.82} ],
      "crossCheck": { "level": "single", "label": "⚠️ 仅单源", ... }   // 校验源（建行 Acrs_Spot）不可用时是 single
    },
    "icbc": {
      "id": "icbc", "title": "中国工商银行", "unit": "元/克",
      "source": "工行网银公开行情接口", "ok": true, "error": null, "stale": false,
      "quoteTime": "2026-11-06 16:16:24", "freshness": {...},
      "groups": [
        { "name": "如意金积存",
          "fields": [ {"label":"积存价","value":890.15,"hero":true}, {"label":"赎回价","value":869.68} ],
          "premium": { "premium": 21.55, "band": {"min":15,"max":25,"label":"实物金条"}, "ok": true, "note": null },
          "crossCheck": { "level": "info", "label": "ℹ️ 两产品价差", "detail": "..." } },
        { "name": "积存金",
          "fields": [ {"label":"主动积存价","value":871.21,"hero":true}, {"label":"定期积存价","value":876.5},
                      {"label":"赎回价","value":871.21}, {"label":"最高/最低","value":"878.25 / 865.69"} ],
          "premium": { "premium": 2.61, "band": {"min":-5,"max":10,"label":"账户型积存金"}, "ok": true, "note": null },
          "crossCheck": {...} }
      ],
      "crossCheck": {...}                               // 卡片级汇总（最差一个为准）
    },
    "ccb": {
      "id": "ccb", "title": "中国建设银行", "unit": "元/克",
      "source": "建行积存金接口", "ok": true, "error": null, "stale": false,
      "quoteTime": "2026-11-06 16:16:23.489", "freshness": {...},
      "fields": [ {"label":"买入价","value":874.92,"hero":true}, {"label":"赎回价","value":868.92}, {"label":"中间价","value":870.02} ],
      "premium": { "premium": 6.32, "band": {"min":-5,"max":10,"label":"账户型积存金"}, "ok": true, "note": null },
      "crossCheck": {...}
    }
  }
}
```

### 实现补充字段（向前兼容，前端可选用）

```jsonc
{
  "baseDate": "2026-11-05",          // 昨收对应交易日
  "note": null,                      // 全部溢价源都按旧基准定价时的全局提示：
                                     // "报价基准时间 2026-11-05，可能未反映最新行情"
  "refreshMs": 900000,               // Host 下发的自动刷新间隔（15 分钟）
  "build": "c1a877054e55",           // Host 代码内容哈希，排查「跑的是哪一版」
  "cards": {
    "intl": { "changeDetected": true },              // 变化检测命中（连续两次一致而 Au99.99 变动）
    "icbc": { "groups": [{ "changeDetected": true }] },
    "ccb": { "premium": { "stale": false, "checks": { "current": {...}, "previous": {...} } } }
  }
}
```

前端已消费：`note`（面板顶部告警条）、`changeDetected`（不强制展示）。

### 字段规则

- `fields[].value`：number 或 string（如「878.25 / 865.69」）或 null；null 前端显示 `—`。
- `fields[].tone`：`"up" | "down"`，仅涨跌幅字段带；涨红跌绿（A 股习惯）。
- `fields[].hero`：`true` = 主价格，前端渲染成大字号（26px）+ 单位；每张卡/每个分组第一个字段应为 hero。
- `fields[].kind`：`"change"` = 涨跌幅，前端渲染成涨跌胶囊（▲/▼ + 绝对值百分比，title 里保留带符号原值）。
  前端对旧 payload 有兜底：无 hero 标记取第一个字段；`unit:"%"` 或 label 含「涨跌」视为 change。
- `ok=false` 时带 `error`，前端只显示错误，不渲染字段。
- `freshness`：`{ fresh:boolean, ageMinutes:number|null, note:string|null }`；
  源时间戳距当前 > 6 小时且处于交易时段 → `fresh:false`、`note:"非实时报价"`。
- `crossCheck.level` 五级（前端徽标样式按级区分，语义见备注）：
  - `verified` → `"✅ 已交叉校验"`（两源一致）
  - `info` → `"ℹ️ 两产品价差"`（工行两产品本就不同价，正常）
  - `differ` → `"⚠️ 两源有差异"`（通常是报价时点不同，**不**等于陈旧）
  - `single` → `"⚠️ 仅单源"`（校验源不可用）
  - `stale` → `"⚠️ 疑似陈旧快照"`（仅双重反算 / 变化检测证实时）
  前端按 `level` 找 label（`label` 与 level 必须匹配，smoke 断言）。
- 溢价带：账户型 `[-5, 10]`、实物金条型 `[15, 25]`；`premium.band.label` 让卡片标明适用哪条带。

## 3.5 走势与要闻接口（GET /dsh-gold/api/extras）

面板右列数据。只在用户点开「走势与要闻」按钮、或手动刷新时拉取；永远 200，两半互不影响。

```jsonc
{
  "build": "441fe40cab2a",
  "fetchedAt": "2026-11-08T08:34:04.000Z",
  "chart": {
    "ok": true,
    "stale": false,
    "fallback": true,                       // 主源不可用、改用上金所日行情
    "error": null,
    "symbol": "Au99.99",
    "unit": "元/克",
    "source": "上海黄金交易所日行情",
    "updatedAt": "2026-11-08T08:34:04.000Z",
    "bars": 22,
    "ranges": {
      "week": {
        "label": "本周",
        "points": [ {"date":"11-02","close":836.08}, {"date":"11-06","close":868.57} ],
        "change": { "value": 32.49, "pct": 3.89 },
        "fromDate": "2026-11-02", "toDate": "2026-11-06", "note": null
      },
      "month": {
        "label": "本月",
        "points": [ {"date":"10-09","close":904.48}, {"date":"11-06","close":868.57} ],
        "change": { "value": -35.91, "pct": -3.97 },
        "fromDate": "2026-10-09", "toDate": "2026-11-06",
        "note": "本月交易日不足，显示近 22 个交易日"
      }
    }
  },
  "news": {
    "ok": true,
    "stale": false,
    "error": null,
    "updatedAt": "2026-11-08T08:34:04.000Z",
    "items": [
      {
        "id": "5f2c9a1b7d30",
        "title": "中国人民银行决定上调金融机构外汇存款准备金率",
        "url": "https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/2026110510330636555/index.html",
        "source": "pbc", "sourceName": "中国人民银行",
        "tier": 3, "category": "policy",
        "publishedAt": "2026-11-05T09:00:00.000Z"
      }
    ]
  }
}
```

规则：

- **chart**：主源东方财富 `118.AU9999` 日 K；请求失败时用上金所日行情逐日兜底（`fallback:true`，
  仍是真实收盘价，`stale:false`、`error:null`）；只有回退「本进程旧缓存」才 `stale:true`。
  两源都失败 → `ok:false`、`ranges:null`，前端显示「走势暂不可用」。
  `week` 锚定最后一根 K 所在自然周；`month` 锚定所在自然月，**少于 8 个交易日时退回近 22 个交易日**
  （否则月初的「本月」和「本周」完全一样）。最后一根是夜盘所属交易日时，`note` 会补一句说明。
- **news**：官方 `tier=3`（央行/统计局/上金所/美联储），媒体 `tier=1`（新浪财经）；
  排序 = tier 降序 → 话题权重（美联储/利率 40、通胀/CPI 30、黄金 25、美元美债/储备 20）→ 时间；
  只取前 3 条，同一标题去重。外链只放行 http(s)。
- **日更**：按北京时间每天抓一次，缓存 `$DSH_HOME/dsh-gold-news.json`（原子写、最多 60 条）。
  当天没有新条目 → 返回上一次的 3 条，`stale:true`、`error:"今日暂无新增资讯"`；
  抓取失败 → 保留旧内容并带 `stale/error`；从来没有内容才 `ok:false` → 前端「资讯暂不可用」。
- **解耦**：extras 失败不能影响行情区；前端只给右列轻提示，行情卡片保持原样。

## 4. 前端面板（assets/panel.js / panel.css，Teammate B 独占）

- 挂载：**左侧面板导航 `<nav>` 内部、紧跟「自动化任务」行之后、「更多」之前**，
  与 插件/自动化任务/更多 并排的一行**纯文字**入口，文案固定为 **「黄金实时价格」**。
  入口的 CSS Module 类名在运行时从「自动化任务」那一行现取（复刻尺寸/hover/focus/折叠轨道形态），
  不要硬编码 `mP3x-q_`/`wtg9ga_` 这类哈希类名；插入的是 nav 的额外子节点，ensure() 负责补回原位。
  点击入口展开/收起贴边面板（面板标题同为「黄金实时价格」）。
- 只通过 `GET /dsh-gold/api/quotes` 取数，不要自己抓行情。
- 右列（走势 + 要闻）由头部第三个按钮控制显隐，默认隐藏；状态存 `localStorage['dsh-gold-card:extras']`，
  读不到按隐藏处理。打开/手动刷新时才请求 `/dsh-gold/api/extras`；切换显隐、切换本周/本月只重渲染，不重复请求。
- 打开即拉一次；手动「刷新」按钮；15 分钟自动刷新（`document.hidden` 时暂停，重新可见立即刷新）。
- 四卡片数据一次返回，前端一次渲染即可（并行拉取在 Host 层已用 Promise.allSettled）。
- 样式必须跟 DSH 现有 UI 一致：优先用 DSH 的 CSS 变量（见 client-ui-theme / layout 的 `--ds*` / `--dsw-*`）；
  没有可用变量时给自己的类加 `dsh-gold-` 前缀，避免污染全局。
- 面板要能在桌面应用（`dsh-app://app/`）与浏览器两条路径下都显示：不要依赖 `location.origin` 之外的假设，
  接口用相对路径 `fetch('/dsh-gold/api/quotes')`。

## 5. 测试

- `npm test` = `apply-smoke && market-parse && panel-dom && sge-parse && smoke`
  - `test/apply-smoke.cjs`：mock ctx 校验七条路由、index 注入行、进程内 `readResource` 可服务、
    注入表自检（`indexInjection.ours===1`）、dispose 后路由摘除。离线。
  - `test/market-parse.cjs`：走势 K 线解析（乱序/非法/去重/结构变更）、本周/本月窗口与退化、
    SGE 兜底语义、五个资讯源解析、排序/去重/7 天截断、日更缓存与回退。离线。
  - `test/panel-dom.cjs`：极小 DOM stub 真正执行 `assets/panel.js`，校验侧边栏入口锚点、四卡片渲染、
    hero/涨跌胶囊/徽标分级/交易日口径、15 分钟定时器、隐藏暂停、失败保留旧数据、折叠态退化，
    以及右列显隐（localStorage、宽度 384↔780）、SVG 走势、3 条资讯 target/rel、切区间不重复请求。离线。
  - `test/sge-parse.cjs`：上金所分时序列离线单测（未发生时点的占位值、夜盘/日盘时点收敛、
    周末日盘占位尾段截断）。离线。
  - `test/smoke.cjs`：真实四源连通 + 解析陷阱断言（如意金 ÷100、上金所涨跌幅算得出）
    + crossCheck / freshness / premium 三块结构断言。
- 安装后无需浏览器即可确认：读 `$DSH_HOME/.dsh-gold-card.log` 里的 `selfcheck` 行。
