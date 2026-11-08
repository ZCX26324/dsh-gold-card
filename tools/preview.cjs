#!/usr/bin/env node
/**
 * tools/preview.cjs —— 离线 UI 预览（零依赖）
 *
 * 用 vm 把 assets/panel.js 跑起来，借它导出的纯函数（cardHtml/cardsHtml/localTimeText…）
 * 生成和真实面板同构的 HTML，再套上 assets/panel.css，输出一个可直接用浏览器打开的
 * 静态预览页。这样改 UI 不必重启 DSH、也不必进 Electron 里看。
 *
 * 用法：
 *   node tools/preview.cjs                 # 用上次抓到的行情（无则实时抓一次）
 *   node tools/preview.cjs --live          # 强制实时抓四源
 *   node tools/preview.cjs --payload x.json
 * 输出：.preview/light.html、.preview/dark.html（再配合 Edge 无头截图）
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.preview')
const DATA_FILE = path.join(OUT_DIR, 'payload.json')
const EXTRAS_FILE = path.join(OUT_DIR, 'extras.json')

// 离线预览用的走势 / 要闻数据（形状与 /dsh-gold/api/extras 一致）
function mockExtras() {
  const monthCloses = [
    ['2026-09-30', 907.32],
    ['2026-10-09', 904.48],
    ['2026-10-12', 898.0],
    ['2026-10-13', 901.2],
    ['2026-10-14', 896.4],
    ['2026-10-15', 892.1],
    ['2026-10-16', 895.3],
    ['2026-10-19', 888.0],
    ['2026-10-20', 884.2],
    ['2026-10-21', 880.6],
    ['2026-10-22', 872.4],
    ['2026-10-23', 864.0],
    ['2026-10-26', 830.0],
    ['2026-10-27', 832.2],
    ['2026-10-28', 835.4],
    ['2026-10-29', 865.26],
    ['2026-10-30', 854.76],
    ['2026-11-02', 836.08],
    ['2026-11-03', 840.01],
    ['2026-11-04', 863.79],
    ['2026-11-05', 884.09],
    ['2026-11-06', 868.57],
  ]
  const range = (rows, label, note) => {
    const first = rows[0]
    const last = rows[rows.length - 1]
    const value = Math.round((last[1] - first[1]) * 100) / 100
    return {
      label: label,
      points: rows.map((r) => ({ date: r[0].slice(5), close: r[1] })),
      change: { value: value, pct: Math.round((value / first[1]) * 10000) / 100 },
      fromDate: first[0],
      toDate: last[0],
      note: note,
    }
  }
  const weekRows = monthCloses.slice(-5)
  return {
    build: 'preview',
    fetchedAt: new Date().toISOString(),
    chart: {
      ok: true,
      stale: false,
      fallback: true,
      error: null,
      symbol: 'Au99.99',
      unit: '元/克',
      source: '上海黄金交易所日行情',
      updatedAt: new Date().toISOString(),
      bars: monthCloses.length,
      ranges: {
        week: range(weekRows, '本周', null),
        month: range(monthCloses, '本月', '本月交易日不足，显示近 22 个交易日'),
      },
    },
    news: {
      ok: true,
      stale: false,
      error: null,
      updatedAt: new Date().toISOString(),
      items: [
        {
          id: 'pv-nbs-01',
          title: '2026年10月下旬流通领域重要生产资料市场价格变动情况',
          url: 'https://www.stats.gov.cn/sj/zxfb/202611/t20261103_1965738.html',
          source: 'nbs',
          sourceName: '国家统计局',
          tier: 3,
          category: 'macro',
          publishedAt: '2026-11-05T01:30:00.000Z',
        },
        {
          id: 'pv-pbc-01',
          title: '中国人民银行决定上调金融机构外汇存款准备金率',
          url: 'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/2026110510330636555/index.html',
          source: 'pbc',
          sourceName: '中国人民银行',
          tier: 3,
          category: 'policy',
          publishedAt: '2026-11-05T09:00:00.000Z',
        },
        {
          id: 'pv-sina-01',
          title: '国际金价小幅回落，市场关注美联储后续政策路径',
          url: 'https://finance.sina.com.cn/money/nmetal/hjzx/2026-11-07/doc-inline.shtml',
          source: 'sina',
          sourceName: '新浪财经',
          tier: 1,
          category: 'gold',
          publishedAt: '2026-11-07T01:20:00.000Z',
        },
      ],
    },
  }
}

function readPanelApi() {
  const code = fs.readFileSync(path.join(ROOT, 'assets', 'panel.js'), 'utf8')
  const win = {}
  const sandbox = {
    window: win,
    document: {
      readyState: 'loading',
      body: null,
      addEventListener() {},
      removeEventListener() {},
    },
    console: console,
    setTimeout() { return 0 },
    clearTimeout() {},
    setInterval() { return 0 },
    clearInterval() {},
    navigator: { userAgent: 'preview' },
    location: { href: 'preview://', protocol: 'preview:' },
    encodeURIComponent: encodeURIComponent,
    URL: URL,
    URLSearchParams: URLSearchParams,
    JSON, Math, Date, Number, String, Error, Promise, isFinite, parseFloat, parseInt,
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(code, sandbox, { filename: 'assets/panel.js' })
  const api = win.__dshGoldCardPanel
  if (!api) throw new Error('panel.js 未导出 __dshGoldCardPanel')
  return api
}

function escAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function refreshLabel(ms) {
  const sec = Math.round((Number(ms) || 900000) / 1000)
  if (sec >= 60 && sec % 60 === 0) return Math.round(sec / 60) + ' 分钟'
  return sec + ' 秒'
}

function panelHtml(api, payload, opts) {
  const note = payload && payload.note
    ? `<div class="dsh-gold-alert dsh-gold-alert-warn"><span class="dsh-gold-alert-text">${api.esc(payload.note)}</span></div>`
    : ''
  const cards = payload ? api.cardsHtml(payload) : '<div class="dsh-gold-empty">暂无行情数据</div>'
  const metaLeft = payload && payload.fetchedAt ? '更新于 ' + (api.localTimeText(payload.fetchedAt) || '—') : '加载中…'
  const total = (payload && payload.cards && Object.keys(payload.cards).length) || 4
  const metaRight = (payload ? api.okCount(payload) : 0) + '/' + total + ' 源正常'
  const base = payload && typeof payload.baseAu9999 === 'number' ? api.fmtNum(payload.baseAu9999) : '—'
  const extrasState = opts.extras ? { status: 'ok', data: opts.extras, error: null, at: 0 } : null
  const side = extrasState
    ? '<div class="dsh-gold-col-side" aria-label="走势与要闻">' +
      api.chartCardHtml(extrasState) +
      api.newsCardHtml(extrasState) +
      '</div>'
    : ''
  return `
  <div id="dsh-gold-card-root" class="dsh-gold-panel" data-open="1" data-extras="1" role="dialog" aria-label="黄金实时价格" aria-modal="false">
    <div class="dsh-gold-panel-head">
      <div class="dsh-gold-panel-title">
        <span class="dsh-gold-panel-glyph" aria-hidden="true">${opts.heroIcon}</span>
        <span class="dsh-gold-panel-title-text">黄金实时价格</span>
      </div>
      <div class="dsh-gold-panel-actions">
        <button type="button" class="dsh-gold-iconbtn dsh-gold-extras-btn" data-dsh-gold-action="extras" aria-pressed="true" title="显示/隐藏走势与要闻" aria-label="显示/隐藏走势与要闻">${opts.iconExtras}</button>
        <button type="button" class="dsh-gold-iconbtn" title="刷新" aria-label="刷新行情">${opts.iconRefresh}</button>
        <button type="button" class="dsh-gold-iconbtn" title="关闭" aria-label="关闭面板">${opts.iconClose}</button>
      </div>
    </div>
    <div class="dsh-gold-panel-meta">
      <span class="dsh-gold-panel-meta-left">${api.esc(metaLeft)}</span>
      <span class="dsh-gold-panel-meta-right">${api.esc(metaRight)}</span>
    </div>
    <div class="dsh-gold-alert-slot">${note}</div>
    <div class="dsh-gold-panel-body" role="region" aria-label="金价卡片">
      <div class="dsh-gold-layout${side ? ' dsh-gold-layout-wide' : ''}"><div class="dsh-gold-col-main">${cards}</div>${side}</div>
    </div>
    <div class="dsh-gold-panel-foot">
      <span class="dsh-gold-panel-foot-left">Au99.99 基准 ${api.esc(base)} 元/克</span>
      <span class="dsh-gold-panel-foot-right">每 ${refreshLabel(payload && payload.refreshMs)}自动刷新</span>
    </div>
  </div>`
}

const THEME_LIGHT = `
:root{
  --dsw-alias-label-primary:#1f2329; --dsw-alias-label-secondary:#4e5969; --dsw-alias-label-tertiary:#86909c;
  --dsw-alias-border-l1:rgba(0,0,0,.05); --dsw-alias-border-l2:rgba(0,0,0,.08); --dsw-alias-border-l3:rgba(0,0,0,.12);
  --dsw-alias-bg-layer-1:#ffffff; --dsw-alias-bg-overlay:#ffffff; --dsw-specific-menu:#ffffff;
  --dsw-alias-interactive-bg-hover:rgba(0,0,0,.05);
  --dsw-alias-state-error-primary:#ec1313; --dsw-alias-state-success-primary:#12a150;
  --dsw-alias-state-warn-primary:#f59e0b; --dsw-alias-state-warn-label:#b26a00;
  --dsw-alias-bg-skeleton:rgba(0,0,0,.04);
  --dsw-radius-sm:8px; --dsw-radius-md:12px; --dsw-radius-lg:16px;
  --dsw-shadow-lv2:0 2px 10px rgba(0,0,0,.08);
  --dsw-elevation-prominent:0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05);
  --mock-app-bg:#f7f8fa; --mock-sidebar-bg:#ffffff; --mock-hover:rgba(0,0,0,.05); --mock-active:rgba(77,107,254,.10);
  --mock-text:#1f2329; --mock-sub:#86909c; --mock-border:rgba(0,0,0,.07);
}`

const THEME_DARK = `
:root{
  --dsw-alias-label-primary:#e8eaed; --dsw-alias-label-secondary:#b6bcc6; --dsw-alias-label-tertiary:#8b929d;
  --dsw-alias-border-l1:rgba(255,255,255,.06); --dsw-alias-border-l2:rgba(255,255,255,.10); --dsw-alias-border-l3:rgba(255,255,255,.16);
  --dsw-alias-bg-layer-1:#22252b; --dsw-alias-bg-overlay:#282b31; --dsw-specific-menu:#282b31;
  --dsw-alias-interactive-bg-hover:rgba(255,255,255,.07);
  --dsw-alias-state-error-primary:#ff6b6b; --dsw-alias-state-success-primary:#3ddc84;
  --dsw-alias-state-warn-primary:#f5a524; --dsw-alias-state-warn-label:#f0b45a;
  --dsw-alias-bg-skeleton:rgba(255,255,255,.06);
  --dsw-radius-sm:8px; --dsw-radius-md:12px; --dsw-radius-lg:16px;
  --dsw-shadow-lv2:0 2px 10px rgba(0,0,0,.5);
  --dsw-elevation-prominent:0 3px 10px rgba(0,0,0,.55),0 0 24px rgba(0,0,0,.45);
  --mock-app-bg:#17191d; --mock-sidebar-bg:#1e2126; --mock-hover:rgba(255,255,255,.07); --mock-active:rgba(120,150,255,.18);
  --mock-text:#e8eaed; --mock-sub:#8b929d; --mock-border:rgba(255,255,255,.08);
}`

const MOCK_SIDEBAR = `
<aside class="mock-sidebar">
  <div class="mock-brand"><span class="mock-logo">◆</span><span class="mock-brand-text">deepseek <b>HARNESS</b></span></div>
  <div class="mock-newchat">＋ 新会话</div>
  <nav class="mock-nav">
    <button class="mock-row"><span class="mock-glyph">⧉</span><span class="mock-title">插件</span></button>
    <button class="mock-row"><span class="mock-glyph">◷</span><span class="mock-title">自动化任务</span></button>
    <button class="mock-row mock-row-gold"><span class="mock-glyph">▱</span><span class="mock-title">黄金实时价格</span></button>
    <button class="mock-row"><span class="mock-glyph">⋯</span><span class="mock-title">更多</span></button>
  </nav>
  <div class="mock-region">
    <div class="mock-region-head"><span>工作区</span></div>
    <div class="mock-region-item">dsh-gold-plugin</div>
    <div class="mock-region-item mock-active">制作黄金实时价格插件</div>
    <div class="mock-region-item">Downloads</div>
  </div>
</aside>
<div class="mock-main">
  <div class="mock-main-head"><span class="mock-tab mock-tab-active">对话</span><span class="mock-tab">轨迹</span><span class="mock-tab">统计</span></div>
  <div class="mock-content">
    <div class="mock-line w80"></div><div class="mock-line w92"></div><div class="mock-line w60"></div>
    <div class="mock-line w88"></div><div class="mock-line w45"></div>
  </div>
</div>`

const MOCK_CSS = `
html,body{margin:0;height:100%;}
body{background:var(--mock-app-bg);color:var(--mock-text);
  font-family:"Segoe UI","Microsoft YaHei",system-ui,-apple-system,sans-serif;}
.mock-sidebar{position:fixed;left:0;top:0;bottom:0;width:260px;box-sizing:border-box;
  background:var(--mock-sidebar-bg);border-right:1px solid var(--mock-border);padding:12px 12px 16px;}
.mock-brand{display:flex;align-items:center;gap:8px;padding:4px 8px 14px;font-size:15px;font-weight:600;}
.mock-brand-text b{font-weight:600;letter-spacing:.04em;font-size:11px;opacity:.65;}
.mock-logo{color:#d4a017;font-size:18px;}
.mock-newchat{display:flex;align-items:center;justify-content:center;gap:6px;height:36px;
  border:1px solid var(--mock-border);border-radius:10px;margin-bottom:14px;font-size:14px;color:var(--mock-text);}
.mock-nav{display:flex;flex-direction:column;gap:2px;}
.mock-row{display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 10px;
  border:0;border-radius:10px;background:transparent;color:var(--mock-text);font:inherit;font-size:14px;text-align:left;}
.mock-row:hover{background:var(--mock-hover);}
.mock-row-gold .mock-glyph{color:#e8a317;}
.mock-glyph{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;
  font-size:14px;color:var(--mock-sub);}
.mock-title{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
.mock-region{margin-top:16px;border-top:1px solid var(--mock-border);padding-top:12px;}
.mock-region-head{font-size:11px;color:var(--mock-sub);padding:0 10px 6px;}
.mock-region-item{height:32px;line-height:32px;padding:0 10px;border-radius:8px;font-size:13px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mock-text);}
.mock-region-item.mock-active{background:var(--mock-active);}
.mock-main{margin-left:260px;height:100%;display:flex;flex-direction:column;}
.mock-main-head{display:flex;gap:18px;padding:16px 24px;border-bottom:1px solid var(--mock-border);font-size:14px;}
.mock-tab{color:var(--mock-sub);}
.mock-tab-active{color:var(--mock-text);font-weight:500;}
.mock-content{padding:28px 32px;display:flex;flex-direction:column;gap:14px;}
.mock-line{height:12px;border-radius:6px;background:var(--mock-hover);}
.w80{width:80%;} .w92{width:92%;} .w60{width:60%;} .w88{width:88%;} .w45{width:45%;}
#dsh-gold-card-root{left:260px !important;width:780px !important;top:12px !important;bottom:12px !important;}
/* 截图用：关掉入场动画，避免无头浏览器在淡入过程中截到半透明画面 */
*,*::before,*::after{animation:none !important;transition:none !important;}
#dsh-gold-card-root{opacity:1 !important;transform:none !important;}
`

function themeVars(dark) {
  return dark ? THEME_DARK : THEME_LIGHT
}

function page(api, payload, dark, icons, extras) {
  const css = fs.readFileSync(path.join(ROOT, 'assets', 'panel.css'), 'utf8')
  return `<!doctype html><html lang="zh-CN"${dark ? ' data-dark="1"' : ''}><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-gold-card preview ${dark ? 'dark' : 'light'}</title>
<style>${themeVars(dark)}${MOCK_CSS}${css}</style>
</head><body>
${MOCK_SIDEBAR}
${panelHtml(api, payload, Object.assign({ extras: extras }, icons))}
</body></html>`
}

async function loadPayload(argv) {
  const live = argv.includes('--live')
  const idx = argv.indexOf('--payload')
  if (idx >= 0 && argv[idx + 1]) {
    return JSON.parse(fs.readFileSync(path.resolve(argv[idx + 1]), 'utf8'))
  }
  if (!live) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    } catch (err) { /* 没有缓存就走实时 */ }
  }
  console.log('抓取实时行情…')
  const { fetchCards } = require('../lib/gold.cjs')
  const payload = await fetchCards({ ttl: 1 })
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2))
  return payload
}

async function loadExtras(argv) {
  const live = argv.includes('--live')
  if (!live) {
    try {
      return JSON.parse(fs.readFileSync(EXTRAS_FILE, 'utf8'))
    } catch (err) { /* 没有缓存就用内置 mock */ }
    return mockExtras()
  }
  try {
    console.log('抓取走势与要闻…')
    const { fetchChart } = require('../lib/market.cjs')
    const { fetchNews } = require('../lib/news.cjs')
    const os = require('node:os')
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const [chart, news] = await Promise.all([
      fetchChart(),
      fetchNews({ dshHome: dshHome }),
    ])
    const extras = { build: 'preview', fetchedAt: new Date().toISOString(), chart: chart, news: news }
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(EXTRAS_FILE, JSON.stringify(extras, null, 2))
    return extras
  } catch (err) {
    console.warn('实时抓取失败，改用内置 mock：' + (err && err.message ? err.message : err))
    return mockExtras()
  }
}

;(async () => {
  const argv = process.argv.slice(2)
  const api = readPanelApi()
  const payload = await loadPayload(argv)
  const extras = await loadExtras(argv)
  const icons = {
    // 与 panel.js 里的 GOLD_ICON / ICON_REFRESH / ICON_CLOSE 同形
    heroIcon:
      '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.1 9.2 4.35 5.6h7.3L12.9 9.2" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/><rect x="2.5" y="9.2" width="11" height="3.3" rx="1.05" stroke="currentColor" stroke-width="1.15"/><path d="M6.6 6.6h2.8" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>',
    iconRefresh:
      '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.1 8.4a5.1 5.1 0 1 1-1.7-3.9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/><path d="M13.3 3.1v2.6h-2.6" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    iconClose:
      '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
    iconExtras:
      '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.6 11.7 6 8.1l2.4 2.1 4.9-5.3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.6 4.9h2.7v2.7" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  for (const dark of [false, true]) {
    const file = path.join(OUT_DIR, dark ? 'dark.html' : 'light.html')
    fs.writeFileSync(file, page(api, payload, dark, icons, extras))
    console.log((dark ? 'dark ' : 'light') + ' -> ' + path.relative(ROOT, file))
  }
  fs.writeFileSync(path.join(OUT_DIR, 'cards.html'), api.cardsHtml(payload))
  console.log('payload -> ' + path.relative(ROOT, DATA_FILE))
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
