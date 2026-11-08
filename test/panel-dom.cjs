#!/usr/bin/env node
/**
 * test/panel-dom.cjs —— 前端面板离线渲染自测（零依赖，不需要浏览器）
 *
 * 本机 playwright MCP 不可用，所以用一个极小的 DOM stub 把 assets/panel.js
 * 真正跑起来，验证：
 *   1. 能找到左侧边栏锚点（[data-shell-overlay] → nav → SidebarRoot），把入口插到 nav 之后
 *   2. 折叠态（侧边栏列不可见）时退化为左下角轨道按钮，不抛错
 *   3. 打开面板：四张卡片 / 字段 / 溢价带 / 交叉校验徽标 / 数据源时间戳全部渲染出来
 *   4. 涨跌幅涨红跌绿、失效卡片只显示错误、加载中骨架
 *   5. 刷新失败时不清空旧数据，只显示告警
 *   6. 15 分钟自动刷新定时器被装上、页面隐藏时不触发刷新
 *
 * 用法：node test/panel-dom.cjs
 * 退出码 0 = 全部通过
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const PANEL_JS = path.join(__dirname, '..', 'assets', 'panel.js')
const code = fs.readFileSync(PANEL_JS, 'utf8')

let fail = 0
const ok = (m) => console.log('  ✅ ' + m)
const bad = (m) => { fail += 1; console.error('  ❌ ' + m) }
const check = (cond, m) => (cond ? ok(m) : bad(m))

// ---------------------------------------------------------------------------
// 极小 DOM stub
// ---------------------------------------------------------------------------

function El(tag) {
  this.tagName = String(tag || 'div').toUpperCase()
  this.children = []
  this.parentElement = null
  this.parentNode = null
  this.style = {}
  this._attrs = new Map()
  this._listeners = new Map()
  this._html = ''
  this._text = ''
  this.className = ''
  this.id = ''
  this.scrollTop = 0
  this.disabled = false
  this._rect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }
}

Object.defineProperty(El.prototype, 'innerHTML', {
  get() { return this._html },
  set(v) { this._html = String(v); this.children.length = 0 },
})

Object.defineProperty(El.prototype, 'textContent', {
  get() { return this._text + this.children.map((c) => c.textContent).join('') },
  set(v) { this._text = String(v); this.children.length = 0 },
})

Object.defineProperty(El.prototype, 'nextSibling', {
  get() {
    const p = this.parentElement
    if (!p) return null
    const i = p.children.indexOf(this)
    return i >= 0 ? p.children[i + 1] || null : null
  },
})

Object.defineProperty(El.prototype, 'previousSibling', {
  get() {
    const p = this.parentElement
    if (!p) return null
    const i = p.children.indexOf(this)
    return i > 0 ? p.children[i - 1] || null : null
  },
})

El.prototype.appendChild = function (child) {
  if (child.parentElement) child.parentElement.removeChild(child)
  child.parentElement = this
  child.parentNode = this
  this.children.push(child)
  return child
}
El.prototype.insertBefore = function (child, ref) {
  if (child.parentElement) child.parentElement.removeChild(child)
  child.parentElement = this
  child.parentNode = this
  if (!ref) return this.appendChild(child)
  const i = this.children.indexOf(ref)
  if (i < 0) return this.appendChild(child)
  this.children.splice(i, 0, child)
  return child
}
El.prototype.removeChild = function (child) {
  const i = this.children.indexOf(child)
  if (i >= 0) this.children.splice(i, 1)
  child.parentElement = null
  child.parentNode = null
  return child
}
El.prototype.remove = function () {
  if (this.parentElement) this.parentElement.removeChild(this)
}
El.prototype.setAttribute = function (n, v) { this._attrs.set(String(n), String(v)) }
El.prototype.getAttribute = function (n) { return this._attrs.has(String(n)) ? this._attrs.get(String(n)) : null }
El.prototype.hasAttribute = function (n) { return this._attrs.has(String(n)) }
El.prototype.removeAttribute = function (n) { this._attrs.delete(String(n)) }
El.prototype.addEventListener = function (type, fn) {
  const list = this._listeners.get(type) || []
  list.push(fn)
  this._listeners.set(type, list)
}
El.prototype.dispatch = function (type, event) {
  const list = this._listeners.get(type) || []
  for (const fn of list) fn(event)
}
El.prototype.click = function () {
  this.dispatch('click', {
    target: this,
    preventDefault() {},
    stopPropagation() {},
  })
}
El.prototype.focus = function () { doc.activeElement = this }
El.prototype.getBoundingClientRect = function () { return this._rect }
El.prototype.contains = function (node) {
  let cur = node
  while (cur) {
    if (cur === this) return true
    cur = cur.parentElement
  }
  return false
}
El.prototype.getComputedStyle = function () { return { flexGrow: '0' } }

El.prototype._match = function (selector) {
  const s = String(selector || '').trim()
  if (!s) return false
  if (s.startsWith('#')) return this.id === s.slice(1)
  if (s.startsWith('.')) return String(this.className).split(/\s+/).includes(s.slice(1))
  if (s.startsWith('[')) {
    const name = s.slice(1, -1).split('=')[0].trim()
    return this._attrs.has(name)
  }
  return this.tagName === s.toUpperCase()
}
El.prototype.querySelectorAll = function (selector) {
  const out = []
  const walk = (node) => {
    for (const child of node.children) {
      if (child._match(selector)) out.push(child)
      walk(child)
    }
  }
  walk(this)
  return out
}
El.prototype.querySelector = function (selector) {
  return this.querySelectorAll(selector)[0] || null
}

// ---------------------------------------------------------------------------
// 页面骨架
// ---------------------------------------------------------------------------

const doc = {
  readyState: 'complete',
  hidden: false,
  activeElement: null,
  _listeners: new Map(),
  createElement(tag) { return new El(tag) },
  createTextNode(t) { const e = new El('#text'); e.textContent = t; return e },
  getElementById(id) {
    const find = (node) => {
      for (const c of node.children) {
        if (c.id === id) return c
        const hit = find(c)
        if (hit) return hit
      }
      return null
    }
    return find(doc.body)
  },
  querySelector(sel) { return doc.body.querySelector(sel) },
  querySelectorAll(sel) { return doc.body.querySelectorAll(sel) },
  addEventListener(type, fn) {
    const list = doc._listeners.get(type) || []
    list.push(fn)
    doc._listeners.set(type, list)
  },
  dispatch(type, event) {
    for (const fn of doc._listeners.get(type) || []) fn(event)
  },
}
doc.body = new El('body')
doc.head = new El('head')
doc.documentElement = new El('html')
doc.documentElement.appendChild(doc.body)

// AppFrame：layout 一定渲染 [data-shell-overlay]
const frame = new El('div')
const overlay = new El('div')
overlay.setAttribute('data-shell-overlay', 'true')
overlay._rect = { left: 0, right: 1400, top: 0, bottom: 900, width: 1400, height: 900 }
const col = new El('div')
col._rect = { left: 0, right: 280, top: 0, bottom: 900, width: 280, height: 900 }
const sidebarRoot = new El('div')
sidebarRoot._rect = { left: 0, right: 280, top: 0, bottom: 900, width: 280, height: 900 }

// 真实结构（dsh-client-ui-sidebar/SidebarRoot）：nav > 面板行按钮… + 「更多」锚点 div
function nativeRow(label, extraClass) {
  const btn = new El('button')
  btn.className = 'sb_panelRow' + (extraClass ? ' ' + extraClass : '')
  const glyph = new El('span')
  glyph.className = 'sb_panelGlyph'
  glyph.innerHTML = '<svg></svg>'
  const title = new El('span')
  title.className = 'sb_panelTitle sb_wide'
  title.textContent = label
  btn.appendChild(glyph)
  btn.appendChild(title)
  return btn
}

const nav = new El('nav')
nav._rect = { left: 12, right: 268, top: 40, bottom: 260, width: 256, height: 220 }
const rowPlugins = nativeRow('插件')
const rowSchedules = nativeRow('自动化任务', 'sb_panelActive') // 故意带上 active 类，验证不会被复刻
const moreWrap = new El('div')
moreWrap.className = 'sb_moreAnchor'
const moreBtn = nativeRow('更多')
moreWrap.appendChild(moreBtn)
nav.appendChild(rowPlugins)
nav.appendChild(rowSchedules)
nav.appendChild(moreWrap)
sidebarRoot.appendChild(nav)
const regionArea = new El('div')
regionArea._rect = { left: 0, right: 280, top: 260, bottom: 800, width: 280, height: 540 }
sidebarRoot.appendChild(regionArea)
col.appendChild(sidebarRoot)
frame.appendChild(col)
frame.appendChild(overlay)
doc.body.appendChild(frame)

const intervals = new Map()
let intervalSeq = 0
const timeouts = []
const fetched = []
let fetchImpl = null

const win = {
  innerWidth: 1400,
  innerHeight: 900,
  location: { href: 'http://127.0.0.1:50653/', protocol: 'http:' },
  navigator: { userAgent: 'dsh-gold-card-dom-test' },
  _listeners: new Map(),
  addEventListener(type, fn) {
    const list = win._listeners.get(type) || []
    list.push(fn)
    win._listeners.set(type, list)
  },
  dispatch(type, event) {
    for (const fn of win._listeners.get(type) || []) fn(event)
  },
  getComputedStyle() { return { flexGrow: '0' } },
}

// localStorage 桩：与真实浏览器一样是「有则读写、无则异常」的同步接口
const lsData = new Map()
win.localStorage = {
  getItem(key) { return lsData.has(String(key)) ? lsData.get(String(key)) : null },
  setItem(key, value) { lsData.set(String(key), String(value)) },
  removeItem(key) { lsData.delete(String(key)) },
}

function setIntervalStub(fn, ms) {
  intervalSeq += 1
  intervals.set(intervalSeq, { fn, ms })
  return intervalSeq
}
function clearIntervalStub(id) { intervals.delete(id) }

// ---------------------------------------------------------------------------
// mock 行情（严格按 CONTRACT 第 3 节）
// ---------------------------------------------------------------------------

function ymdOf(d) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function mockPayload() {
  // 时间戳用「今天」，否则日期一过，前端会把时间渲染成「MM-DD HH:MM」导致断言失败
  const TODAY = ymdOf(new Date())
  return {
    fetchedAt: new Date().toISOString(),
    baseAu9999: 868.6,
    refreshMs: 900000,
    build: 'testbuild',
    cards: {
      sge: {
        id: 'sge', title: '上海黄金交易所 Au99.99', unit: '元/克', source: '上海黄金交易所官网',
        ok: true, error: null, stale: false, quoteTime: TODAY + ' 15:45:00', session: '夜盘',
        timeNote: '交易日口径：夜盘归属下一交易日，时间戳里的日期是所属交易日（非自然日）',
        freshness: { fresh: true, ageMinutes: 12, note: null },
        crossCheck: { level: 'verified', label: '✅ 已交叉校验', detail: '接口A 868.60 vs 接口B 868.60，差 0.00' },
        fields: [
          { label: '最新价', value: 868.6, hero: true },
          { label: '涨跌幅', value: -1.75, unit: '%', tone: 'down', kind: 'change' },
          { label: '昨收', value: 884.09 },
          { label: '最高', value: 887 },
          { label: '最低', value: 866 },
        ],
      },
      intl: {
        id: 'intl', title: '国际金价 伦敦金 XAU/USD', unit: '美元/盎司', source: '新浪财经',
        ok: true, error: null, stale: false, quoteTime: TODAY + ' 16:25:00',
        freshness: { fresh: true, ageMinutes: 1, note: null },
        crossCheck: { level: 'verified', label: '✅ 已交叉校验', detail: '新浪 4072.03 vs 建行 4072.22' },
        fields: [
          { label: '最新价', value: 4072.03, hero: true },
          { label: '24h涨跌', value: -0.41, unit: '%', tone: 'down', kind: 'change' },
          { label: '昨收', value: 4088.8 },
        ],
      },
      icbc: {
        id: 'icbc', title: '中国工商银行', unit: '元/克', source: '工行网银公开行情接口',
        ok: true, error: null, stale: false, quoteTime: TODAY + ' 16:44:00',
        freshness: { fresh: true, ageMinutes: 0, note: null },
        crossCheck: { level: 'single', label: '⚠️ 仅单源', detail: '两产品赎回价差 3.93' },
        groups: [
          {
            name: '如意金积存',
            fields: [{ label: '积存价', value: 890.15 }, { label: '赎回价', value: 869.68 }],
            premium: { premium: 21.55, band: { min: 15, max: 25, label: '实物金条' }, ok: true, note: null },
            crossCheck: { level: 'single', label: '⚠️ 仅单源', detail: '单产品口径' },
          },
          {
            name: '积存金',
            fields: [
              { label: '主动积存价', value: 873.61 },
              { label: '定期积存价', value: 879.5 },
              { label: '赎回价', value: 873.61 },
            ],
            premium: { premium: 5.04, band: { min: -5, max: 10, label: '账户型积存金' }, ok: true, note: null },
            crossCheck: { level: 'stale', label: '⚠️ 疑似陈旧快照', detail: '与如意金赎回价差 3.93' },
          },
        ],
      },
      ccb: {
        id: 'ccb', title: '中国建设银行', unit: '元/克', source: '建行积存金接口',
        ok: true, error: null, stale: false, quoteTime: TODAY + ' 16:43:56.945',
        freshness: { fresh: true, ageMinutes: 0, note: null },
        crossCheck: { level: 'verified', label: '✅ 已交叉校验', detail: '建行买入 876.88 vs 反算 868.64' },
        fields: [
          { label: '买入价', value: 876.88 },
          { label: '赎回价', value: 870.22 },
          { label: '中间价', value: 873.55 },
        ],
        premium: { premium: 8.28, band: { min: -5, max: 10, label: '账户型积存金' }, ok: true, note: null },
      },
    },
  }
}

/** 右侧扩展列：走势（本周/本月两个区间一次给全）+ 要闻 3 条 */
function mockExtras() {
  const week = {
    label: '本周',
    points: [
      { date: '11-02', close: 836.08 },
      { date: '11-03', close: 840.01 },
      { date: '11-04', close: 863.79 },
      { date: '11-05', close: 884.09 },
      { date: '11-06', close: 868.57 },
    ],
    change: { value: 32.49, pct: 3.89 },
    high: { date: '11-05', close: 884.09 },
    low: { date: '11-02', close: 836.08 },
    fromDate: '2026-11-02',
    toDate: '2026-11-06',
    note: null,
  }
  const month = {
    label: '本月',
    points: week.points.concat([{ date: '11-09', close: 874.0 }]),
    change: { value: 37.92, pct: 4.54 },
    high: { date: '11-05', close: 884.09 },
    low: { date: '11-02', close: 836.08 },
    fromDate: '2026-11-02',
    toDate: '2026-11-09',
    note: '最后一根为夜盘所属交易日',
  }
  return {
    build: 'testbuild',
    fetchedAt: new Date().toISOString(),
    chart: {
      ok: true, stale: false, fallback: true, error: null,
      symbol: 'Au99.99', unit: '元/克', source: '上海黄金交易所日行情',
      updatedAt: new Date().toISOString(), bars: 6,
      ranges: { week, month },
    },
    news: {
      ok: true, stale: false, error: null, cached: false,
      updatedAt: new Date().toISOString(), total: 8,
      items: [
        {
          id: 'n1', title: '2026年10月下旬流通领域重要生产资料市场价格变动情况',
          url: 'https://www.stats.gov.cn/sj/zxfb/202611/t20261103_1965738.html',
          source: 'nbs', sourceName: '国家统计局', tier: 3, category: 'data',
          publishedAt: new Date().toISOString(),
        },
        {
          id: 'n2', title: '中国人民银行决定上调金融机构外汇存款准备金率',
          url: 'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/2026110510330636555/index.html',
          source: 'pbc', sourceName: '中国人民银行', tier: 3, category: 'policy',
          publishedAt: new Date(Date.now() - 86400000).toISOString(),
        },
        {
          id: 'n3', title: '金价高位震荡，机构提示关注美联储政策路径',
          url: 'https://finance.sina.com.cn/money/nmetal/hjzx/2026-11-07/doc-test.shtml',
          source: 'sina', sourceName: '新浪财经', tier: 1, category: 'gold',
          publishedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        },
      ],
    },
  }
}

function makeSandbox() {
  const sandbox = {
    window: win,
    document: doc,
    console: console,
    fetch: function (url, init) {
      fetched.push({ url: String(url), init: init || null })
      if (typeof fetchImpl !== 'function') return Promise.reject(new Error('no fetch impl'))
      return fetchImpl(String(url), init)
    },
    setTimeout: function (fn, ms) { timeouts.push({ fn, ms }); return timeouts.length },
    clearTimeout: function () {},
    setInterval: setIntervalStub,
    clearInterval: clearIntervalStub,
    MutationObserver: function () { this.observe = function () {}; this.disconnect = function () {} },
    AbortController: function () { this.signal = {}; this.abort = function () {} },
    navigator: win.navigator,
    location: win.location,
    encodeURIComponent: encodeURIComponent,
    URL: URL,
    JSON: JSON,
    Math: Math,
    Date: Date,
    Number: Number,
    String: String,
    Error: Error,
    Promise: Promise,
    isFinite: isFinite,
    parseFloat: parseFloat,
    parseInt: parseInt,
  }
  sandbox.globalThis = sandbox
  return sandbox
}

function flush() {
  return new Promise((resolve) => setTimeoutReal(resolve, 30))
}
const setTimeoutReal = setTimeout

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------

;(async () => {
  console.log('=== 前端面板离线渲染自测 ===')

  fetchImpl = function (url) {
    if (url.indexOf('/dsh-gold/api/extras') === 0) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(mockExtras())) })
    }
    if (url.indexOf('/dsh-gold/api/quotes') === 0) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(mockPayload())),
      })
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') })
  }

  const sandbox = makeSandbox()
  vm.runInNewContext(code, sandbox, { filename: 'assets/panel.js' })

  await flush()

  const api = win.__dshGoldCardPanel
  check(!!api, '面板脚本已挂到 window.__dshGoldCardPanel')
  if (!api) { console.log('\n' + fail + ' 项失败 ❌'); process.exit(1) }

  // ---- 1) 侧边栏入口 ----
  console.log('侧边栏入口：')
  const entryHost = doc.getElementById('dsh-gold-nav-host')
  check(!!entryHost, '入口节点已创建（#dsh-gold-nav-host）')
  check(!!entryHost && entryHost.parentElement === nav, '入口插进面板导航 <nav> 内部（与原生面板行同级）')
  check(!!entryHost && entryHost.previousSibling === rowSchedules, '入口紧跟在「自动化任务」行之后')
  check(!!entryHost && entryHost.nextSibling === moreWrap, '入口位于「更多」之前（不会跑到「更多」下面）')
  check(
    !!entryHost && String(entryHost.className).indexOf('sb_panelRow') >= 0,
    '复用原生面板行类名（尺寸/内边距/hover 与 插件、自动化任务 同款）'
  )
  check(
    !!entryHost && String(entryHost.className).indexOf('sb_panelActive') < 0,
    '没有把原生 active 高亮类名搬过来'
  )
  check(
    !!entryHost && String(entryHost.className).indexOf('sb_moreAnchor') < 0,
    '没有把「更多」菜单锚点类名搬过来'
  )
  check(!!entryHost && entryHost.tagName === 'BUTTON', '入口是可聚焦的 <button>')
  const entryGlyph = entryHost.children[0]
  const entryLabel = entryHost.children[1]
  check(String(entryGlyph.className).indexOf('sb_panelGlyph') >= 0, '图标 span 复用原生图标类名')
  check(String(entryGlyph.className).indexOf('dsh-gold-nav-glyph') >= 0, '图标 span 保留自己的类名（金色着色用）')
  check(entryGlyph.innerHTML.indexOf('<svg') >= 0, '图标是金锭 SVG')
  check(String(entryLabel.className).indexOf('sb_panelTitle') >= 0, '文字 span 复用原生标题类名')
  check(entryLabel.textContent === '黄金实时价格', '入口文字为「黄金实时价格」（实际「' + entryLabel.textContent + '」）')
  check(entryGlyph.textContent === '' && entryLabel.textContent.indexOf('|') < 0, '入口不含价格摘要，是纯文字行')
  check(api.state.mode === 'wide', '侧边栏可见时 mode=wide（实际 ' + api.state.mode + '）')
  check(entryHost.getAttribute('data-native') === '1', '入口复刻了原生行样式（data-native=1）')

  // 结构变化兜底：nav 里的原生行消失时入口仍能挂上，并退回自带样式
  nav.removeChild(moreWrap)
  nav.removeChild(rowSchedules)
  nav.removeChild(rowPlugins)
  api.ensure()
  check(entryHost.getAttribute('data-native') === '0', '找不到原生行时退回自带样式（data-native=0）')
  check(entryHost.parentElement === nav, '兜底时入口仍留在面板导航 <nav> 内')
  nav.appendChild(rowPlugins)
  nav.appendChild(rowSchedules)
  nav.appendChild(moreWrap)
  api.ensure()
  check(entryHost.getAttribute('data-native') === '1', '原生行恢复后重新复刻原生样式')
  check(
    entryHost.previousSibling === rowSchedules && entryHost.nextSibling === moreWrap,
    '结构恢复后入口回到「自动化任务」下方、「更多」上方'
  )

  // 外壳钩子缺失/版本差异：不依赖 [data-shell-overlay]，靠「面板行文字」也能找到 nav
  frame.removeChild(overlay)
  api.ensure()
  check(entryHost.getAttribute('data-native') === '1', '缺少 [data-shell-overlay] 钩子时仍能定位到面板行并复刻样式')
  check(entryHost.previousSibling === rowSchedules, '缺少外壳钩子时入口位置仍正确')
  frame.appendChild(overlay)
  api.ensure()

  // 容器连 <nav> 语义都没有（结构大改）时：靠「自动化任务」按钮文案定位，且能穿过 Tooltip 包裹层
  sidebarRoot.removeChild(nav)
  const altList = new El('div')
  const altWrapPlugins = new El('span')
  altWrapPlugins.appendChild(nativeRow('插件'))
  const altWrapSchedules = new El('span')
  altWrapSchedules.appendChild(nativeRow('自动化任务'))
  altList.appendChild(altWrapPlugins)
  altList.appendChild(altWrapSchedules)
  sidebarRoot.appendChild(altList)
  api.ensure()
  check(!!entryHost && entryHost.parentElement === altList, '容器不是 <nav> 时也能插到正确列表里')
  check(!!entryHost && entryHost.previousSibling === altWrapSchedules, '按钮外包着 Tooltip 时插入的是包裹层之后（不会插进行内部）')
  check(entryHost.getAttribute('data-native') === '1', '结构大改时仍然复刻原生行样式')
  sidebarRoot.removeChild(altList)
  sidebarRoot.appendChild(nav)
  api.ensure()
  check(entryHost.previousSibling === rowSchedules, '结构恢复后入口回到原位')

  // ---- 2) 打开面板 ----
  console.log('打开面板：')
  api.open()
  await flush()
  const panel = doc.getElementById('dsh-gold-card-root')
  check(!!panel, '面板节点已创建（#dsh-gold-card-root）')
  check(!!panel && panel.getAttribute('data-open') === '1', '面板处于展开态')
  const headText = panel
    ? panel.children.filter((c) => /dsh-gold-panel-head/.test(String(c.className))).map((c) => c.textContent).join(' ')
    : ''
  check(headText.indexOf('黄金实时价格') >= 0, '面板标题为「黄金实时价格」（实际「' + headText.trim() + '」）')
  check(entryHost.getAttribute('title').indexOf('黄金实时价格') >= 0, '入口 hover 提示带「黄金实时价格」')
  check(entryHost.getAttribute('aria-expanded') === 'true', '展开后入口 aria-expanded=true')
  const bodyHtml = panel ? panel.children.find((c) => String(c.className).indexOf('dsh-gold-panel-body') >= 0).innerHTML : ''
  check(bodyHtml.length > 1000, '卡片 HTML 已渲染（' + bodyHtml.length + ' 字符）')
  for (const title of ['上海黄金交易所 Au99.99', '国际金价 伦敦金 XAU/USD', '中国工商银行', '中国建设银行']) {
    check(bodyHtml.indexOf(title) >= 0, '渲染出卡片「' + title + '」')
  }
  check(bodyHtml.indexOf('868.60') >= 0, '上金所最新价 868.60 已格式化')
  check(bodyHtml.indexOf('dsh-gold-hero-value') >= 0, '主价格用 hero 大字号结构渲染')
  check(bodyHtml.indexOf('dsh-gold-change') >= 0, '涨跌幅渲染成胶囊')
  check(bodyHtml.indexOf('▼ 1.75%') >= 0, '跌用 ▼ 箭头 + 绝对值百分比（不带负号）')
  check(bodyHtml.indexOf('-1.75%') >= 0, '胶囊 title 里保留带符号的原始涨跌幅')
  check(bodyHtml.indexOf('dsh-gold-fields') >= 0, '其余字段进统计网格')
  check(bodyHtml.indexOf('dsh-gold-down') >= 0, '跌用绿色 class（dsh-gold-down）')
  check(bodyHtml.indexOf('溢价 +21.55 元/克') >= 0, '工行如意金溢价 +21.55')
  check(bodyHtml.indexOf('实物金条 15~25') >= 0, '标明实物金条适用带 15~25')
  check(bodyHtml.indexOf('账户型积存金') >= 0, '标明账户型适用带')
  check(bodyHtml.indexOf('✅ 已交叉校验') >= 0, '渲染「已交叉校验」徽标')
  check(bodyHtml.indexOf('⚠️ 仅单源') >= 0, '渲染「仅单源」徽标')
  check(bodyHtml.indexOf('⚠️ 疑似陈旧快照') >= 0, '渲染「疑似陈旧快照」徽标')
  check(bodyHtml.indexOf('源时间 15:45:00 · 夜盘') >= 0, '渲染数据源自带时间戳并标注夜盘（上金所）')
  check(bodyHtml.indexOf('交易日口径') >= 0, '渲染「夜盘时间戳是所属交易日」口径说明')
  check(bodyHtml.indexOf('源时间 16:25:00') >= 0, '渲染国际金价时间戳')
  check(bodyHtml.indexOf('如意金积存') >= 0 && bodyHtml.indexOf('积存金') >= 0, '工行两个产品分组都渲染')
  check(bodyHtml.indexOf('876.88') >= 0, '建行买入价渲染')

  // 面板元信息
  const panelHtmlAll = panel ? panel.innerHTML : ''
  const metaText = panel ? panel.children.filter((c) => /panel-meta/.test(String(c.className))).map((c) => c.textContent).join(' ') : ''
  check(/更新于/.test(metaText), '面板显示「更新于 <时刻>」')
  check(/4\/4 源正常/.test(metaText), '面板显示 4/4 源正常（实际「' + metaText.trim() + '」）')
  const footText = panel ? panel.children.filter((c) => /panel-foot/.test(String(c.className))).map((c) => c.textContent).join(' ') : ''
  check(footText.indexOf('每 15 分钟自动刷新') >= 0, '面板底部标注「每 15 分钟自动刷新」')
  check(panelHtmlAll.length >= 0 && footText.indexOf('Au99.99 基准 868.60') >= 0, '面板底部显示 Au99.99 基准')

  // ---- 3) 自动刷新定时器 ----
  console.log('定时器与可见性：')
  const timerEntry = [...intervals.values()].find((x) => x.ms === 900000)
  check(!!timerEntry, '15 分钟自动刷新定时器已装上')
  let quoteCalls = fetched.filter((f) => f.url.indexOf('/api/quotes') >= 0).length
  check(quoteCalls >= 1, '打开时已拉取一次行情（实际 ' + quoteCalls + ' 次）')

  // 页面隐藏时，自动刷新不应请求
  doc.hidden = true
  const before = quoteCalls
  if (timerEntry) timerEntry.fn()
  await flush()
  quoteCalls = fetched.filter((f) => f.url.indexOf('/api/quotes') >= 0).length
  check(quoteCalls === before, 'document.hidden 时自动刷新暂停')

  // 重新可见：立即刷新一次（把上次拉取时刻拨回 10s 前，模拟真的隔了一会儿）
  doc.hidden = false
  api.state.lastLoadAt = Date.now() - 10000
  doc.dispatch('visibilitychange', {})
  await flush()
  quoteCalls = fetched.filter((f) => f.url.indexOf('/api/quotes') >= 0).length
  check(quoteCalls > before, '重新可见后立即刷新（' + before + ' → ' + quoteCalls + '）')

  // ---- 4) 刷新失败：保留旧数据 + 告警 ----
  console.log('失败降级：')
  fetchImpl = () => Promise.reject(new Error('模拟网络中断'))
  api.refresh()
  await flush()
  const bodyAfterError = panel.children.find((c) => String(c.className).indexOf('dsh-gold-panel-body') >= 0).innerHTML
  check(bodyAfterError.indexOf('868.60') >= 0, '失败后不清空旧数据（仍显示 868.60）')
  const alerts = panel.children.find((c) => String(c.className).indexOf('alert-slot') >= 0)
  check(!!alerts && alerts.innerHTML.indexOf('刷新失败，显示上次数据') >= 0, '显示「刷新失败，显示上次数据」告警')
  check(!!alerts && alerts.innerHTML.indexOf('data-dsh-gold-action="retry"') >= 0, '提供重试按钮')

  // 恢复 fetch，验证手动刷新成功
  fetchImpl = function (url) {
    if (url.indexOf('/dsh-gold/api/quotes') === 0) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(mockPayload())) })
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') })
  }
  api.refresh()
  await flush()
  const alertsAfter = panel.children.find((c) => String(c.className).indexOf('alert-slot') >= 0)
  check(alertsAfter.innerHTML === '', '刷新成功后告警清除')

  // 全局「全部源都陈旧」提示（payload.note）要显示出来
  const noted = mockPayload()
  noted.note = '报价基准时间 2026-11-05，可能未反映最新行情'
  fetchImpl = function () {
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(noted)) })
  }
  api.refresh()
  await flush()
  check(
    alertsAfter.innerHTML.indexOf('报价基准时间 2026-11-05') >= 0,
    '显示 payload.note「报价基准时间 X，可能未反映最新行情」'
  )

  // ---- 5) 失效卡片只显示错误 ----
  console.log('失效卡片：')
  const broken = mockPayload()
  broken.cards.sge = {
    id: 'sge', title: '上海黄金交易所 Au99.99', unit: '元/克', source: '上海黄金交易所官网',
    ok: false, error: '请求超时（10 秒）', stale: false, quoteTime: null,
    freshness: { fresh: false, ageMinutes: null, note: '非实时报价' },
    crossCheck: { level: 'single', label: '⚠️ 仅单源', detail: '上金所数据不可用' },
    fields: [{ label: '最新价', value: 868.6 }],
  }
  fetchImpl = function () {
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(broken)) })
  }
  api.refresh()
  await flush()
  const brokenHtml = panel.children.find((c) => String(c.className).indexOf('dsh-gold-panel-body') >= 0).innerHTML
  check(brokenHtml.indexOf('请求超时（10 秒）') >= 0, '失效卡片显示具体错误原因')
  check(brokenHtml.indexOf('暂不可用') >= 0, '失效卡片显示「暂不可用」徽标')
  check(brokenHtml.indexOf('4072.03') >= 0, '其他卡片不受影响（国际金价 4072.03 仍在）')

  // ---- 6) 折叠态 / 抽屉收起 ----
  console.log('折叠态与退化：')
  // 折叠成 56px 轨道：入口留在 nav 里，只隐藏文字（图标行）。
  // 注意：可见性用的是 nav/root 自己的矩形（root.parentElement 在真实 DOM 里是零宽包装层）
  col._rect = { left: 0, right: 56, top: 0, bottom: 900, width: 56, height: 900 }
  nav._rect = { left: 0, right: 44, top: 40, bottom: 260, width: 44, height: 220 }
  api.ensure()
  check(api.state.mode === 'compact', '侧边栏折叠时报 mode=compact（实际 ' + api.state.mode + '）')
  check(entryHost.getAttribute('data-compact') === '1', '入口打上 data-compact（CSS 只留图标）')
  check(entryHost.style.display !== 'none', '折叠轨道里入口仍然可见')
  check(entryHost.parentElement === nav, '折叠后入口仍在 nav 原位（不会掉到别处）')

  // 抽屉完全收起：侧边栏不可见 → 退化为左下角轨道按钮
  col._rect = { left: -280, right: 0, top: 0, bottom: 900, width: 280, height: 900 }
  nav._rect = { left: -280, right: 0, top: 40, bottom: 260, width: 0, height: 220 }
  api.ensure()
  check(api.state.mode === 'hidden', '侧边栏不可见时 mode=hidden（实际 ' + api.state.mode + '）')
  check(entryHost.style.display === 'none', '抽屉收起时 nav 入口隐藏')
  const rail = doc.getElementById('dsh-gold-rail-host')
  check(!!rail, '生成左下角轨道按钮')
  check(!!rail && !rail.hasAttribute('hidden'), '轨道按钮可见')
  check(!!rail && rail.children[0] && String(rail.children[0].className).indexOf('dsh-gold-rail-btn') >= 0, '轨道按钮是真实 DOM 按钮')

  // 恢复宽侧边栏
  col._rect = { left: 0, right: 280, top: 0, bottom: 900, width: 280, height: 900 }
  nav._rect = { left: 12, right: 268, top: 40, bottom: 260, width: 256, height: 220 }
  api.ensure()
  check(api.state.mode === 'wide', '侧边栏恢复后 mode 回到 wide')
  check(rail.hasAttribute('hidden'), '轨道按钮重新隐藏')
  check(entryHost.previousSibling === rowSchedules, '恢复后入口仍在「自动化任务」行之后')

  // 回归：SidebarRoot 的父元素是零宽包装层（实测 DSH 就是这样）时，
  // 入口不能被误判成不可见 —— 几何必须按 nav / root 自身算。
  col._rect = { left: 0, right: 0, top: 0, bottom: 900, width: 0, height: 900 }
  sidebarRoot._rect = { left: 0, right: 280, top: 0, bottom: 900, width: 280, height: 900 }
  nav._rect = { left: 8, right: 272, top: 40, bottom: 260, width: 264, height: 220 }
  api.ensure()
  check(api.state.mode === 'wide' && entryHost.style.display !== 'none', '父层为零宽包装层时仍按 nav 判可见（宽态）')

  // ---- 7) 关闭面板 ----
  api.close()
  check(panel.getAttribute('data-open') === '0', '面板可关闭')

  // ---- 8) 新版 UI 片段（纯函数，覆盖 hero / 徽标分级 / 交易日口径）----
  console.log('UI 片段：')

  // 8.1 徽标分级：differ（两源差异）与 info（两产品价差）不能再用「疑似陈旧」样式
  const differBadge = api.badgeHtml({ level: 'differ', label: '⚠️ 两源有差异', detail: '两源报价时点不同' })
  check(differBadge.indexOf('dsh-gold-badge-differ') >= 0, 'differ 徽标用「差异」琥珀样式')
  check(differBadge.indexOf('data-level="differ"') >= 0, '徽标带 data-level 便于断言/样式')
  const infoBadge = api.badgeHtml({ level: 'info', label: 'ℹ️ 两产品价差' })
  check(infoBadge.indexOf('dsh-gold-badge-info') >= 0, 'info 徽标用中性灰样式')

  // 8.2 hero 大价格 + 涨跌胶囊 + 统计网格
  const heroCard = api.cardHtml({
    id: 'sge', title: '测试卡', unit: '元/克', source: '测试源', ok: true,
    crossCheck: { level: 'verified', label: '✅ 已交叉校验', detail: '' },
    fields: [
      { label: '最新价', value: 873.6, hero: true },
      { label: '涨跌幅', value: 0.58, unit: '%', kind: 'change', tone: 'up' },
      { label: '昨收', value: 868.57 },
      { label: '最高', value: 873.96 },
    ],
  })
  check(heroCard.indexOf('dsh-gold-hero-value">873.60') >= 0, 'hero 大数字格式化为两位小数')
  check(heroCard.indexOf('dsh-gold-hero-unit">元/克') >= 0, '单位进 hero 行')
  check(heroCard.indexOf('dsh-gold-change dsh-gold-up') >= 0, '涨用红色 class')
  check(heroCard.indexOf('▲ 0.58%') >= 0, '涨用 ▲ 箭头 + 绝对值百分比')
  check(heroCard.indexOf('data-level="verified"') >= 0, '卡片带 data-level 供左侧色带使用')

  // 8.3 只剩一个统计字段 → 单行布局
  const singleField = api.cardHtml({
    id: 'ccb', title: '单字段', unit: '元/克', ok: true,
    fields: [{ label: '买入价', value: 876.88, hero: true }, { label: '昨收', value: 870.22 }],
  })
  check(singleField.indexOf('dsh-gold-fields-single') >= 0, '只剩一个字段时用单行布局')

  // 8.4 分组徽标去重：与卡片级同级的徽标不再重复
  const grouped = api.cardHtml({
    id: 'icbc', title: '工行', unit: '元/克', ok: true,
    crossCheck: { level: 'info', label: 'ℹ️ 两产品价差', detail: '' },
    groups: [
      { name: 'A', fields: [{ label: '积存价', value: 890.15, hero: true }], crossCheck: { level: 'info', label: 'ℹ️ 两产品价差' } },
      { name: 'B', fields: [{ label: '赎回价', value: 869.68, hero: true }], crossCheck: { level: 'stale', label: '⚠️ 疑似陈旧快照' } },
    ],
  })
  check((grouped.match(/ℹ️ 两产品价差/g) || []).length === 1, '分组与卡片级相同的徽标不重复渲染')
  check(grouped.indexOf('⚠️ 疑似陈旧快照') >= 0, '分组确实更差时仍单独标注')

  // 8.5 交易所「所属交易日」：未来日期不能被读成日期算错
  const aheadDate = new Date(Date.now() + 2 * 24 * 3600 * 1000)
  const aheadStr = ymdOf(aheadDate) + ' 02:29:54'
  check(api.quoteTimeText(aheadStr).indexOf('交易日 ') === 0, '未来日期显示为「交易日 MM-DD HH:MM」（实际「' + api.quoteTimeText(aheadStr) + '」）')
  const aheadFoot = api.cardHtml({
    id: 'sge', title: 'x', ok: true, quoteTime: aheadStr, session: '夜盘',
    fields: [{ label: '最新价', value: 873.6, hero: true }],
  })
  check(aheadFoot.indexOf('所属交易日 ') >= 0, '脚注把未来日期写成「所属交易日」而不是「源时间」')

  // ---- 9) 右侧扩展列：走势图 + 黄金要闻 ----
  console.log('右侧扩展列：')
  // 恢复成按 URL 分流的 fetch（前面几节故意改成了「固定返回某段 payload」）
  fetchImpl = function (url) {
    if (url.indexOf('/dsh-gold/api/extras') === 0) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(mockExtras())) })
    }
    if (url.indexOf('/dsh-gold/api/quotes') === 0) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(mockPayload())) })
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') })
  }
  api.open()
  await flush()
  const bodyNode = panel.children.find((c) => String(c.className).indexOf('dsh-gold-panel-body') >= 0)
  const extrasBtn = panel.querySelector('.dsh-gold-extras-btn')
  check(!!extrasBtn, '头部有「走势 / 要闻」开关按钮')
  check(!!extrasBtn && extrasBtn.getAttribute('aria-pressed') === 'false', '默认隐藏：aria-pressed=false')
  check(bodyNode.innerHTML.indexOf('dsh-gold-col-side') < 0, '默认不渲染右侧列（DOM 与旧版一致）')
  check(
    fetched.filter((f) => f.url.indexOf('/dsh-gold/api/extras') >= 0).length === 0,
    '默认隐藏时不请求 extras 接口'
  )

  api.toggleExtras()
  await flush()
  check(api.state.extrasVisible === true, '点击后进入展开态')
  const extrasHtml = bodyNode.innerHTML
  check(extrasHtml.indexOf('dsh-gold-col-side') >= 0, '渲染右侧列容器')
  check(extrasHtml.indexOf('Au99.99 走势') >= 0, '走势卡标题为「Au99.99 走势」')
  check(extrasHtml.indexOf('dsh-gold-chart-line') >= 0, '手写 SVG 折线已渲染')
  check(extrasHtml.indexOf('dsh-gold-chart-area') >= 0, '折线下有面积渐变')
  check(
    (extrasHtml.match(/class="dsh-gold-chart-dot/g) || []).length === 5,
    '每个交易日都画了加粗圆点（实际 ' + (extrasHtml.match(/class="dsh-gold-chart-dot/g) || []).length + ' 个）'
  )
  check(extrasHtml.indexOf('dsh-gold-chart-dot-high') >= 0, '最高点用红色描边圆点强调')
  check(extrasHtml.indexOf('dsh-gold-chart-dot-low') >= 0, '最低点用绿色描边圆点强调')
  check(
    extrasHtml.indexOf('最高') >= 0 && extrasHtml.indexOf('884.09') >= 0 && extrasHtml.indexOf('11-05') >= 0,
    '图下方显示本周最高价与日期'
  )
  check(
    extrasHtml.indexOf('最低') >= 0 && extrasHtml.indexOf('836.08') >= 0 && extrasHtml.indexOf('11-02') >= 0,
    '图下方显示本周最低价与日期'
  )
  check(extrasHtml.indexOf('▲ 3.89%') >= 0, '本周涨跌胶囊（+3.89%）')
  check(extrasHtml.indexOf('data-dsh-gold-action="range"') >= 0, '图表右下角有切换按钮')
  check(
    (extrasHtml.match(/class="dsh-gold-news-item"/g) || []).length === 3,
    '资讯恰好展示 3 条（实际 ' + (extrasHtml.match(/class="dsh-gold-news-item"/g) || []).length + ' 条）'
  )
  check(
    extrasHtml.indexOf('target="_blank"') >= 0 && extrasHtml.indexOf('rel="noopener noreferrer"') >= 0,
    '资讯链接可点击且带 target/rel'
  )
  check(extrasHtml.indexOf('dsh-gold-news-pill-official') >= 0, '官方来源用官方 pill 标注')
  check(extrasHtml.indexOf('国家统计局') >= 0 && extrasHtml.indexOf('中国人民银行') >= 0, '官方媒体排在列表里')
  check(parseInt(panel.style.width, 10) > 384, '展开后面板变宽（两列并排，实际 ' + panel.style.width + '）')
  check(extrasBtn.getAttribute('aria-pressed') === 'true', '展开后按钮 aria-pressed=true')
  check(win.localStorage.getItem('dsh-gold-card:extras') === '1', '显隐状态写入 localStorage')

  const extrasCalls = fetched.filter((f) => f.url.indexOf('/dsh-gold/api/extras') >= 0).length
  check(extrasCalls === 1, '首次展开只请求一次 extras（实际 ' + extrasCalls + ' 次）')
  api.toggleRange()
  check(api.state.range === 'month', '切换区间后 state.range=month')
  const monthHtml = bodyNode.innerHTML
  check(monthHtml.indexOf('本月') >= 0, '按钮文案变成「本月」')
  check(monthHtml.indexOf('夜盘所属交易日') >= 0, '本月数据带夜盘口径说明')
  check(
    (monthHtml.match(/class="dsh-gold-chart-dot/g) || []).length === 6,
    '切换本月后圆点数等于本月点数（实际 ' + (monthHtml.match(/class="dsh-gold-chart-dot/g) || []).length + ' 个）'
  )
  check(
    fetched.filter((f) => f.url.indexOf('/dsh-gold/api/extras') >= 0).length === extrasCalls,
    '切换本周/本月不重新请求（Host 已一次算好两个区间）'
  )

  // extras 失败：不影响行情卡片，仍展示上次资讯并给轻提示
  fetchImpl = function (url) {
    if (url.indexOf('/dsh-gold/api/extras') === 0) return Promise.reject(new Error('模拟资讯接口超时'))
    if (url.indexOf('/dsh-gold/api/quotes') === 0) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(mockPayload())) })
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') })
  }
  api.refresh()
  await flush()
  const failHtml = bodyNode.innerHTML
  check(failHtml.indexOf('868.60') >= 0, 'extras 失败不影响行情卡片')
  check(failHtml.indexOf('资讯更新失败，展示上次内容') >= 0, '资讯失败时保留上次 3 条并轻提示')
  check(failHtml.indexOf('dsh-gold-news-item') >= 0, '失败后旧资讯仍可点击')

  api.toggleExtras()
  check(api.state.extrasVisible === false, '再次点击收起右侧列')
  check(bodyNode.innerHTML.indexOf('dsh-gold-col-side') < 0, '收起后 DOM 恢复单列')
  check(parseInt(panel.style.width, 10) <= 384, '收起后面板宽度回到单列（实际 ' + panel.style.width + '）')
  check(win.localStorage.getItem('dsh-gold-card:extras') === '0', '收起状态也写入 localStorage')

  // ---- 10) 顶部原生标题栏避让（Windows titleBarOverlay 会吃掉右上角鼠标事件） ----
  console.log('顶部标题栏避让：')
  check(api.titlebarInset() === 0, '普通浏览器环境不需要下移')
  check(parseInt(panel.style.top, 10) === 8, '面板默认 top=8px')
  sandbox.navigator.windowControlsOverlay = {
    visible: true,
    getTitlebarAreaRect: () => ({ x: 0, y: 0, width: 900, height: 40 }),
  }
  check(api.titlebarInset() === 40, '读取 windowControlsOverlay 的标题栏高度（40px）')
  api.open()
  check(parseInt(panel.style.top, 10) === 48, '面板整体下移到标题栏下方（top=48px）')
  delete sandbox.navigator.windowControlsOverlay
  api.open()
  check(parseInt(panel.style.top, 10) === 8, '没有标题栏覆盖时恢复 top=8px')

  // ---- 11) 积存金持仓（右侧列底部：本地记录 + 按渠道规则算全部赎回盈亏） ----
  console.log('积存金持仓：')
  fetchImpl = function (url) {
    if (url.indexOf('/dsh-gold/api/extras') === 0) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(mockExtras())) })
    }
    if (url.indexOf('/dsh-gold/api/quotes') === 0) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(mockPayload())) })
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') })
  }
  if (!api.state.extrasVisible) api.toggleExtras()
  api.open()
  await flush()
  check(bodyNode.innerHTML.indexOf('积存金持仓') >= 0, '右侧列底部有「积存金持仓」模块')
  check(bodyNode.innerHTML.indexOf('还没有积存记录') >= 0, '没有记录时给出空状态提示')
  check(bodyNode.innerHTML.indexOf('data-dsh-gold-action="position-add"') >= 0, '有「记录一笔」按钮')

  check(
    (api.channelRedeem(mockPayload(), 'icbc') || {}).price === 873.61,
    '工行渠道取「积存金」分组赎回价（873.61，而不是如意金 869.68）'
  )
  check((api.channelRedeem(mockPayload(), 'ccb') || {}).price === 870.22, '建行渠道取卡片「赎回价」870.22')
  check((api.channelBuyPrice(mockPayload(), 'icbc') || {}).price === 873.61, '工行买入价预填取「主动积存价」873.61')
  check((api.channelBuyPrice(mockPayload(), 'ccb') || {}).price === 876.88, '建行买入价预填取「买入价」876.88')

  // 工行：赎回金额另收 0.5% 手续费
  api.setPosDraft({ channel: 'icbc', grams: '10', price: '870' })
  const r1 = api.submitPosition()
  check(!!r1 && api.state.positions.length === 1, '录入一笔工行积存（10 克 @870）')
  const sum1 = api.positionSummary()
  check(Math.abs(sum1.channels.icbc.stats.avgCost - 870) < 1e-9, '平均成本 = 870.00')
  check(Math.abs(sum1.channels.icbc.stats.netUnit - 869.242) < 0.01, '工行净赎回价已扣 0.5% 手续费（869.24）')
  check(Math.abs(sum1.total.pnl - -7.58) < 0.02, '工行这笔全部赎回约亏 -7.58 元（实际 ' + sum1.total.pnl.toFixed(2) + '）')
  check(bodyNode.innerHTML.indexOf('工商银行') >= 0 && bodyNode.innerHTML.indexOf('10.00 克') >= 0, '汇总行显示渠道与克数')
  check(bodyNode.innerHTML.indexOf('平均成本') >= 0 && bodyNode.innerHTML.indexOf('当前赎回价') >= 0, '汇总包含平均成本与当前赎回价')
  check(bodyNode.innerHTML.indexOf('dsh-gold-down') >= 0, '亏损用绿色（与行情涨跌配色一致）')

  // 建行：按赎回价成交，不另收手续费
  api.setPosDraft({ channel: 'ccb', grams: '5', price: '868' })
  api.submitPosition()
  const sum2 = api.positionSummary()
  check(Math.abs(sum2.channels.ccb.stats.pnl - 11.1) < 0.02, '建行这笔全部赎回约赚 +11.10 元')
  check(Math.abs(sum2.total.grams - 15) < 1e-9, '合计克数 = 15.00')
  check(Math.abs(sum2.total.pnl - 3.52) < 0.05, '合计盈亏跨渠道汇总（实际 ' + sum2.total.pnl.toFixed(2) + '）')
  check(bodyNode.innerHTML.indexOf('合计') >= 0 && bodyNode.innerHTML.indexOf('15.00 克') >= 0, '有合计行')
  check((bodyNode.innerHTML.match(/class="dsh-gold-pos-item"/g) || []).length === 2, '两笔记录都列出来了')

  const stored = JSON.parse(win.localStorage.getItem('dsh-gold-card:positions') || '[]')
  check(stored.length === 2 && stored[0].channel === 'icbc' && stored[1].channel === 'ccb', '记录写入 localStorage')
  check(api.readPositions().length === 2, '能从 localStorage 读回记录')

  // 改渠道时价格输入框自动回填当前渠道价（模拟 change 事件）
  api.setPosDraft({ channel: 'ccb', grams: '', price: '' })
  api.toggleRange()
  check(bodyNode.innerHTML.indexOf('value="876.88"') >= 0, '价格输入框默认回填当前渠道买入价（建行 876.88，不是赎回价）')

  // 删除一笔
  api.removePosition(r1.id)
  api.toggleRange()
  check(api.state.positions.length === 1, '删除后只剩 1 笔')
  check(bodyNode.innerHTML.indexOf('dsh-gold-pos-ch-name">工商银行') < 0, '删掉工行记录后该渠道汇总消失')
  check(api.readPositions().length === 1, '删除也同步到 localStorage')

  // 非法输入
  api.setPosDraft({ channel: 'icbc', grams: '0', price: '870' })
  const bad = api.submitPosition()
  check(bad === null && api.state.posError === '克数需要大于 0', '克数为 0 时拒绝录入并提示')
  check(api.state.positions.length === 1, '非法输入不产生记录')

  // 收起右侧列后持仓模块一起隐藏（属于右侧列的一部分）
  api.toggleExtras()
  check(bodyNode.innerHTML.indexOf('积存金持仓') < 0, '收起右侧列后不显示持仓模块')

  // ---- 汇总 ----
  console.log(fail === 0 ? '\n全部通过 ✅' : '\n' + fail + ' 项失败 ❌')
  process.exit(fail === 0 ? 0 : 1)
})().catch((err) => {
  console.error('自测异常：', err && err.stack ? err.stack : err)
  process.exit(1)
})

