/* ============================================================================
 * dsh-gold-card —— DSH 左侧边栏「黄金实时价格」入口 + 四卡片面板
 *
 * 运行环境：普通浏览器脚本（非 ESM、非 React），由 Host 注入的自举脚本以
 *           <script src="/dsh-gold/panel.js"> 加载。执行时 DSH 页面可能还没挂载完，
 *           所以自己处理 readyState + 后续 SPA 重渲染（重新挂载）。
 *
 * 数据：GET /dsh-gold/api/quotes（相对路径，dsh-app://app/ 与 http://127.0.0.1:xxx/ 都通）
 *
 * 挂载锚点（只依赖稳定属性/语义与运行时现取的类名，绝不硬编码 asar 里的哈希类名）：
 *   1. frame       = [data-shell-overlay] 的父元素（layout 的 AppFrame 无条件渲染该层）
 *   2. 面板导航     = SidebarRoot 里的面板 <nav>（优先取包含「自动化任务」行的那个）
 *   3. 入口插入点   = <nav> 内部、「自动化任务」行之后、「更多」之前
 *                     —— 与 插件/自动化任务/更多 并排的一行纯文字入口
 *   4. 入口样式     = 运行时从「自动化任务」那一行现取 CSS Module 类名复刻，
 *                     尺寸/内边距/hover/focus/折叠轨道形态与原生行完全一致
 *   5. 退化        = 找不到侧边栏 / 抽屉完全收起 → 左下角固定轨道按钮
 *
 * 注：插入的是 <nav> 的**额外**子节点，不参与 React 的 keyed children 协调；
 *     ensure() 在重渲染 / 折叠 / 窗口缩放后会补回原位（4s 健康检查 + MutationObserver）。
 *
 * 任何一步失败都只降级、不抛错、不白屏。
 * ========================================================================= */
(function () {
  'use strict'

  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (window.__dshGoldCardPanel) return

  // ---------------------------------------------------------------------------
  // 常量
  // ---------------------------------------------------------------------------

  var VERSION = '3.6.0'
  var API = '/dsh-gold/api/quotes'
  var MOUNTED_API = '/dsh-gold/api/mounted'
  var DIAG_API = '/dsh-gold/api/diag'
  var PANEL_ID = 'dsh-gold-card-root'
  var ENTRY_HOST_ID = 'dsh-gold-nav-host'
  var RAIL_HOST_ID = 'dsh-gold-rail-host'
  var CARD_ORDER = ['sge', 'intl', 'icbc', 'ccb']
  var DEFAULT_REFRESH_MS = 15 * 60 * 1000 // 15 分钟（Host 未下发时的兜底）
  var MIN_REFRESH_MS = 15000
  var MAX_REFRESH_MS = 60 * 60 * 1000
  var FETCH_TIMEOUT_MS = 20000
  var HEALTH_MS = 4000
  var SIDEBAR_MIN_WIDE = 120 // < 该宽度视为折叠轨道
  var SIDEBAR_MIN_VISIBLE = 8 // < 该宽度视为侧边栏不可见

  // 入口文案：与侧边栏原生面板行（插件 / 自动化任务 / 更多）一样的纯文字风格
  var ENTRY_LABEL = '黄金实时价格'
  /** 入口要插在「哪一行之后」：优先「自动化任务」，兼容其它语言的面板名。 */
  var ANCHOR_LABEL_RE = /自动化任务|自动任务|自动化|schedul|automat|tasks?/i
  /** 原生 CSS Module 的类名是「哈希前缀 + 语义 key」，按 key 匹配可跨版本使用。 */
  var MORE_CLASS_RE = /moreAnchor/
  var ACTIVE_CLASS_RE = /panelActive/

  var BADGE_LABELS = {
    verified: '✅ 已交叉校验',
    info: 'ℹ️ 两产品价差',
    differ: '⚠️ 两源有差异',
    single: '⚠️ 仅单源',
    stale: '⚠️ 疑似陈旧快照',
  }

  // 金锭图标（16/18px，currentColor 描边，颜色由 CSS 给金色）
  var GOLD_ICON =
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M3.1 9.2 4.35 5.6h7.3L12.9 9.2" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/>' +
    '<rect x="2.5" y="9.2" width="11" height="3.3" rx="1.05" stroke="currentColor" stroke-width="1.15"/>' +
    '<path d="M6.6 6.6h2.8" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/>' +
    '</svg>'

  var ICON_REFRESH =
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M13.1 8.4a5.1 5.1 0 1 1-1.7-3.9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>' +
    '<path d="M13.3 3.1v2.6h-2.6" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>'

  var ICON_CLOSE =
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>' +
    '</svg>'

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------

  var refs = { entry: null, panel: null, rail: null }

  var state = {
    booted: false,
    open: false,
    loading: false,
    error: null,
    payload: null,
    build: '',
    // 侧边栏
    sidebar: null,
    mode: 'hidden', // wide | compact | hidden
    colWidth: 0,
    // 刷新
    refreshMs: DEFAULT_REFRESH_MS,
    timer: null,
    timerMs: 0,
    health: null,
    lastLoadAt: 0,
    diagHidden: false,
  }

  // ---------------------------------------------------------------------------
  // 基础工具
  // ---------------------------------------------------------------------------

  function mk(tag, cls, text) {
    var el = document.createElement(tag)
    if (cls) el.className = cls
    if (text !== undefined && text !== null) el.textContent = String(text)
    return el
  }

  function setText(el, text) {
    if (!el) return
    var value = text === null || text === undefined ? '' : String(text)
    if (el.textContent !== value) el.textContent = value
  }

  function setAttr(el, name, value) {
    if (!el) return
    try {
      if (value === null || value === undefined) {
        if (el.hasAttribute && el.hasAttribute(name)) el.removeAttribute(name)
      } else if (el.getAttribute && el.getAttribute(name) !== String(value)) {
        el.setAttribute(name, String(value))
      }
    } catch (err) { /* 属性写入失败不影响主流程 */ }
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      if (ch === '&') return '&amp;'
      if (ch === '<') return '&lt;'
      if (ch === '>') return '&gt;'
      if (ch === '"') return '&quot;'
      return '&#39;'
    })
  }

  function isNum(value) {
    return typeof value === 'number' && isFinite(value)
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n
  }

  function rectOf(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null
    try {
      return el.getBoundingClientRect()
    } catch (err) {
      return null
    }
  }

  function computedOf(el) {
    if (!el || !window || typeof window.getComputedStyle !== 'function') return null
    try {
      return window.getComputedStyle(el)
    } catch (err) {
      return null
    }
  }

  function findActionNode(target, boundary) {
    var node = target
    var guard = 0
    while (node && node !== boundary && guard < 40) {
      guard += 1
      if (node.getAttribute) {
        var action = node.getAttribute('data-dsh-gold-action')
        if (action) return node
      }
      node = node.parentNode
    }
    return null
  }

  // ---------------------------------------------------------------------------
  // 格式化（纯函数，离线自测覆盖）
  // ---------------------------------------------------------------------------

  /** 数字：null → em dash；非数字原样返回（调用方负责转义）。 */
  function fmtNum(value, digits) {
    if (value === null || value === undefined || value === '') return '—'
    if (!isNum(value)) return String(value)
    var d = digits === undefined || digits === null ? 2 : digits
    return (value < 0 ? '-' : '') + Math.abs(value).toFixed(d)
  }

  /** 涨跌幅：带符号 + 百分号。 */
  function fmtPct(value, digits) {
    if (value === null || value === undefined || value === '') return '—'
    if (!isNum(value)) return String(value)
    var d = digits === undefined || digits === null ? 2 : digits
    var body = Math.abs(value).toFixed(d)
    if (value > 0) return '+' + body + '%'
    if (value < 0) return '-' + body + '%'
    return body + '%'
  }

  function fmtClock(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) return ''
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
  }

  /** 宽松解析数据源自带的时间戳（"2026年11月06日 15:45:00" / ISO / 带毫秒）。 */
  function parseLooseDate(raw) {
    if (raw === null || raw === undefined || raw === '') return null
    var s = String(raw).trim()
    var t = Date.parse(s)
    if (!isNaN(t)) return new Date(t)
    var normalized = s
      .replace(/年|月/g, '-')
      .replace(/日/g, ' ')
      .replace(/\//g, '-')
      .replace(/\s+/g, ' ')
      .trim()
    t = Date.parse(normalized)
    if (!isNaN(t)) return new Date(t)
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(normalized)
    if (m) {
      return new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4] || 0),
        Number(m[5] || 0),
        Number(m[6] || 0)
      )
    }
    return null
  }

  function extractClock(raw) {
    var m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(raw || ''))
    if (!m) return ''
    return pad2(Number(m[1])) + ':' + m[2] + (m[3] ? ':' + m[3] : '')
  }

  function isSameDay(a, b) {
    return (
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
    )
  }

  /** 数据源自带报价时间：今天只显示 HH:MM(:SS)，跨天补 MM-DD。
   *  落在未来的日期是交易所「所属交易日」标注（上金所夜盘归属下一交易日），
   *  显式写成「交易日 MM-DD HH:MM」，避免被误读成日期算错。 */
  function quoteTimeText(raw) {
    if (raw === null || raw === undefined || raw === '') return ''
    var s = String(raw).trim()
    var clock = extractClock(s)
    var date = parseLooseDate(s)
    if (!date) return clock || s
    var now = new Date()
    if (isSameDay(date, now)) return clock || fmtClock(date)
    var day = pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    var ahead = date.getTime() - now.getTime() > 20 * 60 * 60 * 1000
    return (ahead ? '交易日 ' : '') + day + (clock ? ' ' + clock : '')
  }

  /** 本地时间（只用于 Host 的 fetchedAt = 接口生成时刻，不冒充数据源报价时间）。 */
  function localTimeText(raw) {
    var date = parseLooseDate(raw)
    if (!date) return ''
    var clock = fmtClock(date)
    if (isSameDay(date, new Date())) return clock
    return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + clock.slice(0, 5)
  }

  function toneOf(field) {
    if (field && (field.tone === 'up' || field.tone === 'down')) return field.tone
    if (field && isNum(field.value)) return field.value > 0 ? 'up' : field.value < 0 ? 'down' : ''
    return ''
  }

  function toneCls(tone) {
    if (tone === 'up') return ' dsh-gold-up'
    if (tone === 'down') return ' dsh-gold-down'
    return ''
  }

  // ---------------------------------------------------------------------------
  // HTML 片段（纯函数，离线自测覆盖）
  // ---------------------------------------------------------------------------

  var BADGE_KIND = {
    verified: 'dsh-gold-badge-ok',
    info: 'dsh-gold-badge-info',
    differ: 'dsh-gold-badge-differ',
    single: 'dsh-gold-badge-single',
    stale: 'dsh-gold-badge-warn',
  }

  function badgeHtml(crossCheck) {
    if (!crossCheck || typeof crossCheck !== 'object') return ''
    var level = crossCheck.level || ''
    var label = crossCheck.label || BADGE_LABELS[level] || ''
    if (!label) return ''
    var kind = BADGE_KIND[level] || 'dsh-gold-badge-warn'
    var title = crossCheck.detail ? ' title="' + esc(crossCheck.detail) + '"' : ''
    return (
      '<span class="dsh-gold-badge ' + kind + '" data-level="' + esc(level) + '"' + title + '>' +
      esc(label) +
      '</span>'
    )
  }

  /**
   * 把字段拆成「主价格（hero）/ 涨跌（胶囊）/ 其余统计」三段。
   * Host 会给主价格字段打 hero:true、涨跌字段打 kind:'change'；
   * 万一是旧 payload / 测试数据，则按「第一个数值字段 = 主价格，带 % 的 = 涨跌」兜底。
   */
  function splitFields(fields) {
    var list = fields || []
    var hero = null
    var change = null
    var rest = []
    for (var i = 0; i < list.length; i += 1) {
      var f = list[i]
      if (!f) continue
      if (!hero && (f.hero === true || i === 0)) {
        hero = f
        continue
      }
      if (
        !change &&
        (f.kind === 'change' || f.unit === '%' || /涨跌/.test(String(f.label || '')))
      ) {
        change = f
        continue
      }
      rest.push(f)
    }
    // 第一个字段是涨跌（极少见）时，别把它当主价格
    if (hero && hero.unit === '%') {
      change = hero
      hero = null
    }
    return { hero: hero, change: change, rest: rest }
  }

  function heroValueText(hero) {
    if (!hero) return '—'
    if (isNum(hero.value)) return fmtNum(hero.value)
    if (hero.value === null || hero.value === undefined || hero.value === '') return '—'
    return esc(String(hero.value))
  }

  /** 主价格区：小标签 + 大数字 + 单位 +（可选）涨跌胶囊。 */
  function heroHtml(hero, change, unitFallback) {
    if (!hero) return ''
    var unit = hero.unit || unitFallback || ''
    var html =
      '<div class="dsh-gold-hero">' +
      '<div class="dsh-gold-hero-main">' +
      '<span class="dsh-gold-hero-label">' + esc(hero.label || '最新价') + '</span>' +
      '<span class="dsh-gold-hero-line">' +
      '<span class="dsh-gold-hero-value">' + heroValueText(hero) + '</span>' +
      (unit ? '<span class="dsh-gold-hero-unit">' + esc(unit) + '</span>' : '') +
      '</span>' +
      '</div>'
    if (change) {
      var tone = toneOf(change)
      var arrow = tone === 'up' ? '▲' : tone === 'down' ? '▼' : '•'
      var pct = isNum(change.value) ? Math.abs(change.value).toFixed(2) + '%' : '—'
      html +=
        '<span class="dsh-gold-change' + toneCls(tone) + '"' +
        ' title="' + esc(String(change.label || '涨跌幅')) + ' ' + esc(fmtPct(change.value)) + '">' +
        arrow + ' ' + esc(pct) +
        '</span>'
    }
    return html + '</div>'
  }

  function fieldValueText(field) {
    if (!field) return '—'
    var value = field.value
    if (field.unit === '%') return esc(fmtPct(value))
    if (value === null || value === undefined || value === '') return '—'
    var text = isNum(value) ? fmtNum(value) : esc(String(value))
    if (field.unit) text += ' ' + esc(field.unit)
    return text
  }

  function fieldHtml(field) {
    if (!field) return ''
    var tone = toneOf(field)
    return (
      '<div class="dsh-gold-field">' +
      '<span class="dsh-gold-field-label">' + esc(field.label || '') + '</span>' +
      '<span class="dsh-gold-field-value' + toneCls(tone) + '">' + fieldValueText(field) + '</span>' +
      '</div>'
    )
  }

  function fieldsHtml(fields, unitFallback) {
    if (!fields || !fields.length) return ''
    var parts = splitFields(fields)
    var html = heroHtml(parts.hero, parts.change, unitFallback)
    if (parts.rest.length) {
      html +=
        '<div class="dsh-gold-fields' + (parts.rest.length === 1 ? ' dsh-gold-fields-single' : '') + '">'
      for (var i = 0; i < parts.rest.length; i += 1) html += fieldHtml(parts.rest[i])
      html += '</div>'
    }
    return html
  }

  function premiumHtml(premium) {
    if (!premium || !isNum(premium.premium)) return ''
    var band = premium.band || {}
    var ok = premium.ok !== false
    var sign = premium.premium > 0 ? '+' : ''
    var html =
      '<div class="dsh-gold-premium" data-ok="' + (ok ? 'true' : 'false') + '">' +
      '<span class="dsh-gold-premium-value">溢价 ' + esc(sign + fmtNum(premium.premium)) + ' 元/克</span>'
    if (band.label || band.min !== undefined || band.max !== undefined) {
      html +=
        '<span class="dsh-gold-premium-band">' +
        esc(band.label || '适用带') + ' ' + esc(fmtNum(band.min, 0)) + '~' + esc(fmtNum(band.max, 0)) +
        '</span>'
    }
    if (!ok && premium.note) html += '<span class="dsh-gold-premium-note">' + esc(premium.note) + '</span>'
    return html + '</div>'
  }

  function freshnessHtml(freshness) {
    if (!freshness || typeof freshness !== 'object') return ''
    if (freshness.fresh !== false) return ''
    var note = freshness.note || '非实时报价'
    var age = isNum(freshness.ageMinutes) ? ' · 源时间 ' + Math.round(freshness.ageMinutes) + ' 分钟前' : ''
    return '<div class="dsh-gold-note dsh-gold-note-warn">' + esc(note + age) + '</div>'
  }

  function staleHtml(card) {
    if (!card || !card.stale) return ''
    var since = card.staleSince ? quoteTimeText(card.staleSince) : ''
    return (
      '<div class="dsh-gold-note dsh-gold-note-warn">数据滞后（缓存回退）' +
      (since ? ' · 上次成功 ' + esc(since) : '') +
      '</div>'
    )
  }

  /** 口径说明（例如上金所夜盘的时间戳是「所属交易日」，不是自然日） */
  function timeNoteHtml(card) {
    if (!card || !card.timeNote) return ''
    return '<div class="dsh-gold-note">' + esc(String(card.timeNote)) + '</div>'
  }

  function cardFootHtml(card) {
    if (!card) return ''
    var source = card.source ? String(card.source) : ''
    var rawTime = card.quoteTime ? String(card.quoteTime) : ''
    var shortTime = quoteTimeText(rawTime)
    var timeLabel = shortTime.indexOf('交易日 ') === 0 ? '所属交易日 ' + shortTime.slice(4) : '源时间 ' + shortTime
    if (!source && !shortTime) return ''
    return (
      '<div class="dsh-gold-card-foot">' +
      '<span class="dsh-gold-source"' + (source ? ' title="' + esc(source) + '"' : '') + '>' +
      esc(source || '源未提供') +
      '</span>' +
      (shortTime
        ? '<span class="dsh-gold-time" title="' + esc(rawTime) + '">' + esc(timeLabel) +
          (card.session ? ' · ' + esc(card.session) : '') + '</span>'
        : '<span class="dsh-gold-time" title="数据源未提供报价时间戳">源时间 —</span>') +
      '</div>'
    )
  }

  function groupHtml(group, unitFallback, cardCross) {
    if (!group) return ''
    var html = '<div class="dsh-gold-group">'
    html += '<div class="dsh-gold-group-head">'
    html += '<span class="dsh-gold-group-name">' + esc(group.name || '') + '</span>'
    // 分组的校验结果与卡片级完全相同就不再重复（工行两个分组会共用同一个结果）
    if (!cardCross || !group.crossCheck || group.crossCheck.level !== cardCross.level) {
      html += badgeHtml(group.crossCheck)
    }
    html += '</div>'
    html += fieldsHtml(group.fields, unitFallback)
    html += premiumHtml(group.premium)
    html += freshnessHtml(group.freshness)
    return html + '</div>'
  }

  function cardHtml(card) {
    if (!card || typeof card !== 'object') return ''
    var ok = card.ok !== false
    var level = ok && card.crossCheck && card.crossCheck.level ? card.crossCheck.level : ''
    var html =
      '<section class="dsh-gold-card" data-ok="' + (ok ? 'true' : 'false') + '"' +
      (level ? ' data-level="' + esc(level) + '"' : '') + '>'

    html += '<div class="dsh-gold-card-head">'
    html +=
      '<span class="dsh-gold-card-title"' +
      (card.title ? ' title="' + esc(card.title) + '"' : '') +
      '>' + esc(card.title || '金价') +
      '</span>'
    if (!ok) {
      html += '<span class="dsh-gold-badge dsh-gold-badge-error">暂不可用</span>'
    } else {
      if (card.stale) html += '<span class="dsh-gold-badge dsh-gold-badge-warn">数据滞后</span>'
      // 卡片级显示最差的那个校验结果；分组里只在比卡片更差时才重复标一次
      html += badgeHtml(card.crossCheck)
    }
    html += '</div>'

    if (!ok) {
      // 失败只显示错误，不渲染字段（CONTRACT 第 3 节）
      html += '<div class="dsh-gold-error-text">' + esc(card.error || '数据暂不可用') + '</div>'
      html += cardFootHtml(card)
      return html + '</section>'
    }

    html += fieldsHtml(card.fields, card.unit)
    if (card.groups && card.groups.length) {
      for (var i = 0; i < card.groups.length; i += 1)
        html += groupHtml(card.groups[i], card.unit, card.crossCheck)
    }
    html += premiumHtml(card.premium)
    html += freshnessHtml(card.freshness)
    html += staleHtml(card)
    html += timeNoteHtml(card)
    html += cardFootHtml(card)
    return html + '</section>'
  }

  function cardsHtml(payload) {
    if (!payload || !payload.cards) return ''
    var cards = payload.cards
    var html = ''
    for (var i = 0; i < CARD_ORDER.length; i += 1) {
      var card = cards[CARD_ORDER[i]]
      if (card) html += cardHtml(card)
    }
    return html
  }

  function okCount(payload) {
    if (!payload || !payload.cards) return 0
    var n = 0
    for (var i = 0; i < CARD_ORDER.length; i += 1) {
      var card = payload.cards[CARD_ORDER[i]]
      if (card && card.ok !== false) n += 1
    }
    return n
  }

  function skeletonHtml() {
    return (
      '<div class="dsh-gold-skeleton" aria-hidden="true">' +
      '<div class="dsh-gold-skeleton-row"></div>' +
      '<div class="dsh-gold-skeleton-row"></div>' +
      '<div class="dsh-gold-skeleton-row"></div>' +
      '<div class="dsh-gold-skeleton-row"></div>' +
      '</div>'
    )
  }

  function bodyHtmlFor() {
    if (!state.payload) {
      if (state.loading) return skeletonHtml()
      if (state.error) return '<div class="dsh-gold-empty">行情服务暂时不可用</div>'
      return '<div class="dsh-gold-empty">加载中…</div>'
    }
    var html = cardsHtml(state.payload)
    return html || '<div class="dsh-gold-empty">暂无行情数据</div>'
  }

  /** 侧边栏摘要：Au99.99 最新价 + 涨跌幅。 */
  function summaryOf(payload) {
    var out = { price: null, pct: null, tone: '', unit: '元/克' }
    if (!payload) return out
    var card = payload.cards ? payload.cards.sge : null
    if (card && card.unit) out.unit = card.unit
    if (card && card.ok !== false && card.fields && card.fields.length) {
      for (var i = 0; i < card.fields.length; i += 1) {
        var f = card.fields[i]
        if (!f) continue
        if (out.price === null && isNum(f.value) && f.unit !== '%') out.price = f.value
        if (f.unit === '%' || /涨跌/.test(String(f.label || ''))) {
          out.pct = isNum(f.value) ? f.value : null
          out.tone = toneOf(f)
        }
      }
    }
    if (out.price === null && isNum(payload.baseAu9999)) out.price = payload.baseAu9999
    return out
  }

  // ---------------------------------------------------------------------------
  // 侧边栏探测
  // ---------------------------------------------------------------------------

  /** 取元素上的可见文案（去掉空白，便于跨语言匹配面板行） */
  function textOf(el) {
    return el && typeof el.textContent === 'string' ? el.textContent.replace(/\s+/g, '') : ''
  }

  /**
   * nav 里的普通面板行：[{ wrap, btn, label }]。
   * DSH 侧栏结构（ui-sidebar/SidebarRoot）：
   *   <nav class="…panelList">
   *     <button class="…panelRow">…插件…</button>
   *     <button class="…panelRow">…自动化任务…</button>
   *     <div class="…moreAnchor"><button class="…panelRow">…更多…</button></div>
   *   </nav>
   * 「更多」那一行要排除，入口插在它前面。
   */
  function panelRowsOf(nav) {
    var rows = []
    var kids = []
    try {
      kids = nav.children || []
    } catch (err) {
      kids = []
    }
    for (var i = 0; i < kids.length; i += 1) {
      var wrap = kids[i]
      if (!wrap) continue
      // 绝不能把「我们自己」当成原生行：否则会自引用复制类名、插到自己后面
      if (wrap.id === ENTRY_HOST_ID) continue
      if (refs.entry && (wrap === refs.entry.host || wrap === refs.entry.btn)) continue
      var btn = wrap.tagName === 'BUTTON' ? wrap : (wrap.querySelector ? wrap.querySelector('button') : null)
      if (!btn) continue
      if (btn.id === ENTRY_HOST_ID) continue
      var cls = String(wrap.className || '') + ' ' + String(btn.className || '')
      if (MORE_CLASS_RE.test(cls)) continue
      var label = textOf(btn)
      if (label === ENTRY_LABEL) continue
      rows.push({ wrap: wrap, btn: btn, label: label })
    }
    return rows
  }

  function describeEl(el) {
    if (!el) return null
    var cls = String(el.className || '').slice(0, 48).replace(/\s+/g, '.')
    return el.tagName + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '')
  }

  /** 找 AppFrame：优先 shell 的结构化钩子；全都取不到就退回 document.body（继续在整篇文档里找 nav）。 */
  function findFrame() {
    var hooks = ['[data-shell-overlay]', '[data-shell-bottom]', '[data-shell-leading]']
    for (var i = 0; i < hooks.length; i += 1) {
      try {
        var el = document.querySelector(hooks[i])
        if (el && el.parentElement) return el.parentElement
      } catch (err) { /* 继续下一个 */ }
    }
    return document.body || null
  }

  /**
   * 给一个 nav 打分：面板导航里一定有「插件 / 自动化任务」这类面板行，
   * 用行文案识别比几何判断稳得多（折叠、抽屉、窗口缩放都不影响）。
   */
  function navScore(nav, frame) {
    var rows = panelRowsOf(nav)
    var score = 0
    var anchor = false
    var plugins = false
    for (var i = 0; i < rows.length; i += 1) {
      var label = rows[i].label
      if (ANCHOR_LABEL_RE.test(label)) {
        score += 6
        anchor = true
      }
      if (/插件|plugins?/i.test(label)) {
        score += 3
        plugins = true
      }
    }
    if (anchor && plugins) score += 3
    if (rows.length >= 2) score += 1
    var rect = rectOf(nav)
    if (rect && rect.left <= 120 && rect.width >= 40 && rect.height >= 20) score += 2
    if (frame && frame !== document.body && frame.contains && frame.contains(nav)) score += 1
    return { score: score, rows: rows, rect: rect }
  }

  /**
   * 找侧边栏：以「面板导航 <nav>」为准（行文案打分），
   * 拿到 nav 后 root = nav 父元素、col = root 父元素。
   * 找不到 nav 时才退回 [data-window-drag] / body 兜底。
   */
  function detectSidebar() {
    var out = { frame: null, root: null, col: null, nav: null, rows: [] }
    var frame = findFrame()
    out.frame = frame

    var navs = []
    try {
      navs = document.querySelectorAll('nav') || []
    } catch (err) {
      navs = []
    }
    var best = null
    for (var i = 0; i < navs.length; i += 1) {
      var info = navScore(navs[i], frame)
      if (!info.score) continue
      if (!best || info.score > best.score) {
        best = { nav: navs[i], score: info.score, rows: info.rows }
      }
    }
    if (best) {
      out.nav = best.nav
      out.root = best.nav.parentElement || null
      out.col = (out.root && out.root.parentElement) || out.root
      out.rows = best.rows
      return out
    }

    // 兜底 1：整篇文档找文案为「自动化任务」的那一行按钮（不依赖 <nav> 语义与几何）。
    // 这条路径覆盖「nav 没被识别 / 几何为 0（折叠动画中）/ DSH 改了容器标签」等情况：
    // 直接把按钮的父元素当容器，插在它后面，位置依旧正确。
    try {
      var buttons = document.querySelectorAll('button') || []
      for (var k = 0; k < buttons.length; k += 1) {
        var label = textOf(buttons[k])
        if (!label || label.length > 12) continue
        if (!ANCHOR_LABEL_RE.test(label)) continue
        var rowBtn = buttons[k]
        // 按钮外面可能还包着 Tooltip 之类的 wrapper：向上找到「有多行子节点」的容器，
        // 并把「容器的直接子元素」作为插入参照，避免插进 wrapper 内部。
        var container = rowBtn.parentElement
        var guard = 0
        while (container && container.children && container.children.length < 2 && guard < 4) {
          container = container.parentElement
          guard += 1
        }
        if (!container) continue
        var wrapEl = rowBtn
        var hop = 0
        while (wrapEl.parentElement && wrapEl.parentElement !== container && hop < 4) {
          wrapEl = wrapEl.parentElement
          hop += 1
        }
        out.nav = container
        out.root = container.parentElement || container
        out.col = (out.root && out.root.parentElement) || out.root
        out.rows = [{ wrap: wrapEl, btn: rowBtn, label: label }]
        return out
      }
    } catch (err) { /* 继续下一个兜底 */ }

    // 兜底 2：靠窗口拖拽行找 SidebarRoot（不一定能拿到 nav）
    var drags = []
    try {
      drags = document.querySelectorAll('[data-window-drag]') || []
    } catch (err) {
      drags = []
    }
    for (var j = 0; j < drags.length; j += 1) {
      var dragRoot = drags[j].parentElement
      if (!dragRoot) continue
      var rect = rectOf(dragRoot)
      if (!rect || rect.width < 100) continue
      if (rect.left > 400) continue
      out.root = dragRoot
      out.col = dragRoot.parentElement || dragRoot
      return out
    }
    return out
  }

  /** 侧边栏列「当前在视口内可见的宽度」：抽屉收起时列被 translate(-100%)，宽度虽在但不可见。 */
  function visibleWidth(el) {
    var r = rectOf(el)
    if (!r) return 0
    var vw = window.innerWidth || 1024
    var left = Math.max(0, r.left)
    var right = Math.min(vw, r.right)
    return Math.max(0, right - left)
  }

  /**
   * 侧边栏几何参照：**优先用 <nav> 或 SidebarRoot 自身**，而不是 root.parentElement。
   *
   * 实测（2026-11-07 诊断日志）：SidebarRoot 的父元素可能是一个零宽包装层
   * （`<div>` 无类名、getBoundingClientRect().right ≈ 0），拿它算宽度会得到 0，
   * 于是入口被误判成「侧边栏不可见」而 display:none，只剩左下角兜底按钮。
   * 真正反映可见性的是 nav / root 自己的矩形。
   */
  function sidebarGeom(sb) {
    var candidates = [sb && sb.nav, sb && sb.root, sb && sb.col]
    for (var i = 0; i < candidates.length; i += 1) {
      var rect = rectOf(candidates[i])
      if (rect && (rect.width > 0 || rect.height > 0)) {
        return { el: candidates[i], rect: rect, width: visibleWidth(candidates[i]) }
      }
    }
    return null
  }

  /** 侧边栏右缘的 x 坐标（面板贴边用）：取 nav / root / col 里最靠右的可见边。 */
  function sidebarRightEdge(sb) {
    var candidates = [sb && sb.nav, sb && sb.root, sb && sb.col]
    var right = 0
    for (var i = 0; i < candidates.length; i += 1) {
      var rect = rectOf(candidates[i])
      if (!rect || rect.width <= 0) continue
      if (rect.right > right) right = rect.right
    }
    return right
  }

  /** 入口应插在「自动化任务」行之后；找不到就退化为 nav 里最后一个普通面板行之后。 */
  function anchorRowOf(sb) {
    var rows = (sb && sb.rows) || []
    for (var i = 0; i < rows.length; i += 1) {
      if (ANCHOR_LABEL_RE.test(rows[i].label)) return rows[i]
    }
    return rows.length ? rows[rows.length - 1] : null
  }

  /**
   * 把入口插进面板导航 <nav> 内部：紧跟「自动化任务」行、「更多」之前。
   * 之所以插进 nav 而不是 nav 之后：用户要求入口出现在「自动化任务」下方，
   * 而「更多」是 nav 的最后一个子元素。DSH 侧栏是 React 渲染的，插入的是**额外**子节点，
   * 不参与它的 keyed children 协调；ensure() 会在结构变化/重渲染后自动补回。
   */
  function placeEntry(sb, host) {
    try {
      var nav = sb && sb.nav
      if (nav) {
        var anchor = anchorRowOf(sb)
        if (anchor) {
          var ref = anchor.wrap.nextSibling
          if (ref !== host) nav.insertBefore(host, ref)
          return true
        }
        if (host.parentElement !== nav || nav.lastChild !== host) nav.appendChild(host)
        return true
      }
      // 没有 nav：插到「可伸缩区域」之前（SidebarRoot 里 flex:1 的那块），拿不到就追加到末尾。
      var root = sb && sb.root
      if (!root) return false
      var kids = root.children || []
      for (var i = 0; i < kids.length; i += 1) {
        var cs = computedOf(kids[i])
        if (cs && parseFloat(cs.flexGrow || '0') > 0) {
          if (kids[i] !== host) root.insertBefore(host, kids[i])
          return true
        }
      }
      if (root.lastChild !== host) root.appendChild(host)
      return true
    } catch (err) {
      console.error('[dsh-gold-card] 入口插入侧边栏失败', err)
      return false
    }
  }

  function detachEntry() {
    var host = refs.entry && refs.entry.host
    if (!host || !host.parentElement) return
    try {
      host.parentElement.removeChild(host)
    } catch (err) {
      host.parentElement.removeChild(host)
    }
  }

  function setMode(mode, width) {
    var nextWidth = width || 0
    var changed = state.mode !== mode || Math.abs(state.colWidth - nextWidth) >= 4
    state.mode = mode
    state.colWidth = nextWidth

    var entry = refs.entry
    if (entry) {
      if (mode === 'compact') setAttr(entry.host, 'data-compact', '1')
      else if (entry.host.getAttribute && entry.host.getAttribute('data-compact')) {
        entry.host.removeAttribute('data-compact')
      }
      var display = mode === 'hidden' ? 'none' : ''
      if (entry.host.style && (entry.host.style.display || '') !== display) entry.host.style.display = display
    }
    if (refs.rail && refs.rail.host) {
      if (mode === 'hidden') {
        if (refs.rail.host.hasAttribute && refs.rail.host.hasAttribute('hidden')) {
          refs.rail.host.removeAttribute('hidden')
        }
      } else if (!(refs.rail.host.hasAttribute && refs.rail.host.hasAttribute('hidden'))) {
        refs.rail.host.setAttribute('hidden', '')
      }
    }
    if (changed) updateEntry()
    if (state.open) positionPanel()
  }

  /**
   * 幂等的「确保挂上」：页面结构变化（SPA 重渲染 / 侧边栏折叠 / 窗口缩放）后调用。
   * 只做结构动作，无变化时不写 DOM，避免 MutationObserver 自激。
   */
  function ensure() {
    try {
      var sb = detectSidebar()
      state.sidebar = sb
      var host = refs.entry && refs.entry.host
      if (!sb.root) {
        if (host) detachEntry()
        setMode('hidden', 0)
        reportDiag('no-sidebar')
        return
      }
      if (!host) host = buildEntryHost()

      // 复刻「自动化任务」那一行的原生类名：尺寸、hover、focus、折叠态全部同款
      var anchor = anchorRowOf(sb)
      if (anchor) applyNativeClasses(refs.entry, anchor)
      else if (refs.entry) setAttr(refs.entry.host, 'data-native', '0')
      placeEntry(sb, host)

      // 可见性：只有「证明不可见」（侧边栏在视口左侧之外）才藏起来。
      // 几何参照用 nav / root 自身，绝不用零宽包装层（实测 colWidth 会是 0）。
      var geom = sidebarGeom(sb)
      if (!geom) {
        // 布局未就绪：先按宽态显示，绝不让入口凭空消失
        setMode('wide', 0)
      } else if (geom.rect.right <= 2) {
        setMode('hidden', 0)
      } else if (geom.width < SIDEBAR_MIN_WIDE) {
        setMode('compact', geom.width)
      } else {
        setMode('wide', geom.width)
      }

      if (state.mode === 'hidden' && !state.diagHidden) {
        state.diagHidden = true
        reportDiag('hidden-mode')
      }
    } catch (err) {
      console.error('[dsh-gold-card] 挂载侧边栏入口失败，退化为左侧轨道按钮', err)
      try {
        setMode('hidden', 0)
      } catch (inner) { /* 连退化都失败：保持不抛错 */ }
      reportDiag('ensure-error:' + (err && err.message ? err.message : String(err)))
    }
  }

  // ---------------------------------------------------------------------------
  // 侧边栏入口
  // ---------------------------------------------------------------------------

  function addTokens(list, seen, value) {
    var tokens = String(value || '').split(/\s+/).filter(Boolean)
    for (var i = 0; i < tokens.length; i += 1) {
      var name = tokens[i]
      // 不搬 active 态与「更多」菜单的类名，否则入口会高亮/错位
      if (ACTIVE_CLASS_RE.test(name) || MORE_CLASS_RE.test(name)) continue
      if (seen[name]) continue
      seen[name] = true
      list.push(name)
    }
    return list
  }

  /**
   * 复刻原生面板行的类名（CSS Module 的哈希前缀 + 语义 key，按元素现取，跨版本安全），
   * 让入口在宽侧边栏 / 折叠轨道两种形态下都与「插件 / 自动化任务」完全一致。
   */
  function applyNativeClasses(entry, anchor) {
    if (!entry || !entry.host || !anchor || !anchor.btn) return
    var seen = {}
    var list = []
    addTokens(list, seen, anchor.btn.className)
    addTokens(list, seen, 'dsh-gold-nav-row')
    var next = list.join(' ')
    if (entry.host.className !== next) entry.host.className = next
    setAttr(entry.host, 'data-native', '1')

    var spans = []
    try {
      spans = anchor.btn.querySelectorAll ? anchor.btn.querySelectorAll('span') : []
    } catch (err) {
      spans = []
    }
    if (spans[0] && spans[0].className) {
      var glyphSeen = {}
      var glyphList = []
      addTokens(glyphList, glyphSeen, spans[0].className)
      addTokens(glyphList, glyphSeen, 'dsh-gold-nav-glyph')
      entry.glyph.className = glyphList.join(' ')
    }
    if (spans[1] && spans[1].className) {
      var titleSeen = {}
      var titleList = []
      addTokens(titleList, titleSeen, spans[1].className)
      addTokens(titleList, titleSeen, 'dsh-gold-nav-title')
      entry.label.className = titleList.join(' ')
    }
  }

  function buildEntryHost() {
    // 入口就是一个原生风格的面板行按钮：图标 + 纯文字「黄金实时价格」
    var btn = document.createElement('button')
    btn.id = ENTRY_HOST_ID
    btn.type = 'button'
    btn.className = 'dsh-gold-nav-row'
    setAttr(btn, 'aria-label', ENTRY_LABEL)
    setAttr(btn, 'aria-expanded', 'false')
    setAttr(btn, 'aria-controls', PANEL_ID)

    var glyph = mk('span', 'dsh-gold-nav-glyph')
    setAttr(glyph, 'aria-hidden', 'true')
    glyph.innerHTML = GOLD_ICON

    var title = mk('span', 'dsh-gold-nav-title', ENTRY_LABEL)

    btn.appendChild(glyph)
    btn.appendChild(title)

    btn.addEventListener('click', function (event) {
      if (findActionNode(event.target, btn)) return
      if (event.preventDefault) event.preventDefault()
      togglePanel()
    })

    refs.entry = { host: btn, btn: btn, glyph: glyph, label: title }
    return btn
  }

  function updateEntry() {
    var entry = refs.entry
    if (!entry) return
    var summary = summaryOf(state.payload)
    var titleText = entryTitleText(summary)
    setAttr(entry.btn, 'aria-expanded', state.open ? 'true' : 'false')
    // 行内保持纯文字；行情摘要放在 hover 的 title 里，不挤压原生行布局
    setAttr(entry.host, 'title', titleText)

    if (refs.rail) {
      setAttr(refs.rail.host, 'data-open', state.open ? '1' : '0')
      setAttr(refs.rail.btn, 'title', titleText)
    }
  }

  function entryTitleText(summary) {
    var parts = [ENTRY_LABEL]
    if (summary.price !== null) parts.push(fmtNum(summary.price) + ' ' + (summary.unit || '元/克'))
    else if (state.loading && !state.payload) parts.push('加载中…')
    else if (state.error) parts.push('获取失败')
    if (summary.pct !== null) parts.push(fmtPct(summary.pct))
    parts.push(state.open ? '点击收起' : '点击展开')
    return parts.join(' · ')
  }

  // ---------------------------------------------------------------------------
  // 退化：左下角固定轨道按钮
  // ---------------------------------------------------------------------------

  function buildRail() {
    var host = document.createElement('div')
    host.id = RAIL_HOST_ID
    host.className = 'dsh-gold-rail-host'
    setAttr(host, 'hidden', '')
    setAttr(host, 'data-open', '0')

    var btn = mk('button', 'dsh-gold-rail-btn')
    btn.type = 'button'
    setAttr(btn, 'aria-label', ENTRY_LABEL)
    setAttr(btn, 'aria-controls', PANEL_ID)
    btn.innerHTML = GOLD_ICON + '<span class="dsh-gold-rail-dot" aria-hidden="true"></span>'
    host.appendChild(btn)

    host.addEventListener('click', function (event) {
      if (event.preventDefault) event.preventDefault()
      togglePanel()
    })

    refs.rail = { host: host, btn: btn }
    if (document.body) document.body.appendChild(host)
  }

  // ---------------------------------------------------------------------------
  // 面板
  // ---------------------------------------------------------------------------

  function buildPanelMount() {
    var root = document.createElement('div')
    root.id = PANEL_ID
    root.className = 'dsh-gold-panel'
    setAttr(root, 'role', 'dialog')
    setAttr(root, 'aria-label', ENTRY_LABEL)
    setAttr(root, 'aria-modal', 'false')
    setAttr(root, 'data-open', '0')

    var head = mk('div', 'dsh-gold-panel-head')
    var titleWrap = mk('div', 'dsh-gold-panel-title')
    var glyph = mk('span', 'dsh-gold-panel-glyph')
    setAttr(glyph, 'aria-hidden', 'true')
    glyph.innerHTML = GOLD_ICON
    titleWrap.appendChild(glyph)
    titleWrap.appendChild(mk('span', 'dsh-gold-panel-title-text', ENTRY_LABEL))

    var actions = mk('div', 'dsh-gold-panel-actions')
    var refresh = mk('button', 'dsh-gold-iconbtn')
    refresh.type = 'button'
    setAttr(refresh, 'data-dsh-gold-action', 'refresh')
    setAttr(refresh, 'title', '刷新')
    setAttr(refresh, 'aria-label', '刷新行情')
    setAttr(refresh, 'data-busy', '0')
    refresh.innerHTML = ICON_REFRESH
    var close = mk('button', 'dsh-gold-iconbtn')
    close.type = 'button'
    setAttr(close, 'data-dsh-gold-action', 'close')
    setAttr(close, 'title', '关闭')
    setAttr(close, 'aria-label', '关闭面板')
    close.innerHTML = ICON_CLOSE
    actions.appendChild(refresh)
    actions.appendChild(close)

    head.appendChild(titleWrap)
    head.appendChild(actions)

    var meta = mk('div', 'dsh-gold-panel-meta')
    var metaLeft = mk('span', 'dsh-gold-panel-meta-left')
    var metaRight = mk('span', 'dsh-gold-panel-meta-right')
    meta.appendChild(metaLeft)
    meta.appendChild(metaRight)

    var alerts = mk('div', 'dsh-gold-alert-slot')

    var body = mk('div', 'dsh-gold-panel-body')
    setAttr(body, 'role', 'region')
    setAttr(body, 'aria-label', '金价卡片')

    var foot = mk('div', 'dsh-gold-panel-foot')
    var footLeft = mk('span', 'dsh-gold-panel-foot-left')
    var footRight = mk('span', 'dsh-gold-panel-foot-right')
    foot.appendChild(footLeft)
    foot.appendChild(footRight)

    root.appendChild(head)
    root.appendChild(meta)
    root.appendChild(alerts)
    root.appendChild(body)
    root.appendChild(foot)

    root.addEventListener('click', function (event) {
      var node = findActionNode(event.target, root)
      if (!node) return
      var action = node.getAttribute('data-dsh-gold-action')
      if (action === 'close') closePanel()
      else if (action === 'refresh' || action === 'retry') load({ manual: true })
    })

    refs.panel = {
      root: root,
      metaLeft: metaLeft,
      metaRight: metaRight,
      alerts: alerts,
      body: body,
      footLeft: footLeft,
      footRight: footRight,
      refresh: refresh,
    }
    if (document.body) document.body.appendChild(root)
    return root
  }

  function alertHtmlFor() {
    var html = ''
    // 全局基准提示：全部溢价源都按旧基准定价时，Host 会在 payload.note 里给出「报价基准时间 X」
    if (state.payload && state.payload.note) {
      html +=
        '<div class="dsh-gold-alert dsh-gold-alert-warn">' +
        '<span class="dsh-gold-alert-text">' + esc(String(state.payload.note)) + '</span>' +
        '</div>'
    }
    if (!state.error) return html
    var hasData = !!(state.payload && state.payload.cards)
    var cls = hasData ? 'dsh-gold-alert-warn' : 'dsh-gold-alert-error'
    var label = hasData ? '刷新失败，显示上次数据' : '行情服务不可用'
    return (
      html +
      '<div class="dsh-gold-alert ' + cls + '">' +
      '<span class="dsh-gold-alert-text">' + esc(label + '：' + state.error) + '</span>' +
      '<button type="button" class="dsh-gold-linkbtn" data-dsh-gold-action="retry">重试</button>' +
      '</div>'
    )
  }

  function updatePanel() {
    var panel = refs.panel
    if (!panel) return

    var leftText = ''
    var rightText = ''
    if (state.payload && state.payload.fetchedAt) {
      leftText = '更新于 ' + (localTimeText(state.payload.fetchedAt) || '—')
    } else if (state.loading) {
      leftText = '加载中…'
    } else if (state.error) {
      leftText = '未能获取数据'
    }
    if (state.payload && state.payload.cards) {
      var total = 0
      var ids = Object.keys(state.payload.cards)
      for (var i = 0; i < ids.length; i += 1) if (state.payload.cards[ids[i]]) total += 1
      rightText = okCount(state.payload) + '/' + total + ' 源正常'
    }
    setText(panel.metaLeft, leftText)
    setText(panel.metaRight, rightText)

    var html = bodyHtmlFor()
    if (panel.body.__dshGoldHtml !== html) {
      var scrollTop = panel.body.scrollTop || 0
      panel.body.innerHTML = html
      panel.body.__dshGoldHtml = html
      if (scrollTop && typeof panel.body.scrollTop === 'number') panel.body.scrollTop = scrollTop
    }

    var alertHtml = alertHtmlFor()
    if (panel.alerts.__dshGoldHtml !== alertHtml) {
      panel.alerts.innerHTML = alertHtml
      panel.alerts.__dshGoldHtml = alertHtml
    }

    setAttr(panel.refresh, 'data-busy', state.loading ? '1' : '0')
    try {
      panel.refresh.disabled = !!state.loading
    } catch (err) { /* 忽略 */ }

    var base = state.payload && isNum(state.payload.baseAu9999) ? fmtNum(state.payload.baseAu9999) : '—'
    setText(panel.footLeft, 'Au99.99 基准 ' + base + ' 元/克')
    setText(panel.footRight, '每 ' + refreshLabel(state.refreshMs) + '自动刷新')
  }

  /** 刷新间隔文案：整分钟用「分钟」，否则用「秒」 */
  function refreshLabel(ms) {
    var sec = Math.round(ms / 1000)
    if (sec >= 60 && sec % 60 === 0) return Math.round(sec / 60) + ' 分钟'
    return sec + ' 秒'
  }

  function updateDom() {
    updateEntry()
    updatePanel()
  }

  // 贴左侧边栏右缘展开：宽视口是「贴边竖条」，窄视口退化成居中浮层。
  function positionPanel() {
    var panel = refs.panel
    if (!panel) return
    var root = panel.root
    var style = root.style || {}
    var vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 1024
    var vh = window.innerHeight || 800

    if (vw < 820 || vh < 480) {
      setAttr(root, 'data-sheet', '1')
      style.left = '8px'
      style.right = '8px'
      style.top = '8px'
      style.bottom = '8px'
      style.width = 'auto'
      return
    }
    setAttr(root, 'data-sheet', null)

    var left = 0
    var edge = sidebarRightEdge(state.sidebar || {})
    if (edge > 2) {
      left = Math.round(edge)
    } else if (state.mode === 'hidden' && refs.rail) {
      var railRect = rectOf(refs.rail.btn)
      if (railRect) left = Math.round(railRect.right + 8)
    }

    var width = Math.round(Math.min(384, Math.max(300, vw - left - 24)))
    if (vw - left - 24 < 300) width = Math.max(260, vw - left - 16)
    left = Math.max(0, Math.min(left, vw - width))

    style.left = left + 'px'
    style.right = 'auto'
    style.top = '8px'
    style.bottom = '8px'
    style.width = width + 'px'
  }

  function togglePanel() {
    if (state.open) closePanel()
    else openPanel()
  }

  function openPanel() {
    state.open = true
    if (!refs.panel) {
      try {
        buildPanelMount()
      } catch (err) {
        console.error('[dsh-gold-card] 面板创建失败', err)
        state.open = false
        return
      }
    }
    if (refs.panel) setAttr(refs.panel.root, 'data-open', '1')
    positionPanel()
    updateDom()
    load({ reason: 'open' })
  }

  function closePanel() {
    state.open = false
    if (refs.panel) setAttr(refs.panel.root, 'data-open', '0')
    updateDom()
  }

  // ---------------------------------------------------------------------------
  // 取数
  // ---------------------------------------------------------------------------

  function requestQuotes() {
    return new Promise(function (resolve, reject) {
      var settled = false
      var timer = null
      var controller = null
      if (typeof AbortController === 'function') {
        try {
          controller = new AbortController()
        } catch (err) {
          controller = null
        }
      }
      var init = { cache: 'no-store', credentials: 'same-origin' }
      if (controller) init.signal = controller.signal

      function finish(fn, value) {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        fn(value)
      }

      try {
        timer = setTimeout(function () {
          if (controller) {
            try {
              controller.abort()
            } catch (err) { /* 忽略 */ }
          }
          finish(reject, new Error('请求超时（' + Math.round(FETCH_TIMEOUT_MS / 1000) + ' 秒）'))
        }, FETCH_TIMEOUT_MS)
      } catch (err) {
        timer = null
      }

      fetch(API, init)
        .then(function (res) {
          return res.text().then(function (text) {
            var data = null
            try {
              data = JSON.parse(text)
            } catch (err) {
              data = null
            }
            if (!res.ok) {
              var msg = data && data.error ? String(data.error) : '行情接口返回 HTTP ' + res.status
              var httpError = new Error(msg)
              httpError.httpStatus = res.status
              throw httpError
            }
            if (!data) throw new Error('行情接口返回的不是 JSON')
            return data
          })
        })
        .then(
          function (data) {
            finish(resolve, data)
          },
          function (err) {
            finish(reject, err)
          }
        )
    })
  }

  function applyQuotes(data) {
    if (!data || typeof data !== 'object') {
      state.error = '行情接口返回空数据'
      return
    }
    if (!data.cards || typeof data.cards !== 'object') {
      state.error = data.error ? String(data.error) : '行情接口返回缺少 cards'
      return
    }
    state.payload = data
    state.error = data.error ? String(data.error) : null
    state.build = data.build ? String(data.build) : state.build
    var ms = Number(data.refreshMs)
    if (isFinite(ms) && ms >= MIN_REFRESH_MS) state.refreshMs = Math.min(ms, MAX_REFRESH_MS)
    else state.refreshMs = DEFAULT_REFRESH_MS
  }

  function load(options) {
    var opts = options || {}
    if (state.loading) return
    if (typeof fetch !== 'function') {
      state.error = '当前页面环境不支持 fetch'
      updateDom()
      return
    }
    state.loading = true
    state.lastLoadAt = Date.now()
    updatePanel()

    requestQuotes().then(
      function (data) {
        applyQuotes(data)
      },
      function (err) {
        // 失败不清空已有数据，只记错误
        state.error = String(err && err.message ? err.message : err)
      }
    ).then(function () {
      state.loading = false
      updateDom()
      restartTimer(false)
      if (opts.manual) {
        try {
          console.log('[dsh-gold-card] 手动刷新完成' + (state.error ? '（失败：' + state.error + '）' : ''))
        } catch (err) { /* 忽略 */ }
      }
    })
  }

  function restartTimer(force) {
    if (!force && state.timer && state.timerMs === state.refreshMs) return
    if (state.timer) {
      clearInterval(state.timer)
      state.timer = null
    }
    state.timerMs = state.refreshMs
    try {
      state.timer = setInterval(function () {
        if (document.hidden) return // 页面隐藏时暂停轮询
        load({ reason: 'auto' })
      }, state.timerMs)
    } catch (err) {
      state.timer = null
    }
  }

  // ---------------------------------------------------------------------------
  // 生命周期 / 事件
  // ---------------------------------------------------------------------------

  function onResize() {
    try {
      ensure()
      if (state.open) positionPanel()
    } catch (err) {
      console.error('[dsh-gold-card] resize 处理失败', err)
    }
  }

  function onVisibility() {
    if (document.hidden) return
    // 重新可见：立即刷新一次并重置轮询节拍
    if (Date.now() - state.lastLoadAt > 3000) load({ reason: 'visible' })
    restartTimer(true)
  }

  function onKeydown(event) {
    if (!state.open) return
    var key = event && (event.key || event.keyCode)
    if (key !== 'Escape' && key !== 'Esc' && key !== 27) return
    var panel = refs.panel
    var active = document.activeElement
    var focusInside = !!(panel && active && panel.root.contains && panel.root.contains(active))
    closePanel()
    if (focusInside) {
      var target = state.mode === 'hidden' && refs.rail ? refs.rail.btn : refs.entry && refs.entry.btn
      if (target && typeof target.focus === 'function') {
        try {
          target.focus()
        } catch (err) { /* 忽略 */ }
      }
    }
  }

  function watchDom() {
    if (typeof MutationObserver !== 'function' || !document.body) return
    var scheduled = false
    try {
      var observer = new MutationObserver(function () {
        if (scheduled) return
        scheduled = true
        setTimeout(function () {
          scheduled = false
          ensure()
        }, 500)
      })
      observer.observe(document.body, { childList: true, subtree: true })
    } catch (err) {
      // 观察失败也没关系：还有 4s 健康检查兜底
    }
  }

  /**
   * 挂载诊断：把「真实 DOM 里到底看到了什么」报给 Host 写日志。
   *
   * 为什么需要它：面板在 dsh-app:// 里跑，外部无法检查页面 DOM；一旦探测失败，
   * 只能靠这条通道把现场（找没找到 frame / nav、nav 里有哪些行、入口落在哪个父节点）
   * 送到 $DSH_HOME/.dsh-gold-card.log，才能定位真实结构差异而不是靠猜。
   * 每个页面生命周期最多上报 16 次，避免刷屏。
   */
  var diagCount = 0

  function reportDiag(reason) {
    if (typeof fetch !== 'function') return
    if (diagCount >= 16) return
    diagCount += 1
    try {
      var sb = state.sidebar || {}
      var navs = []
      try {
        var list = document.querySelectorAll('nav') || []
        for (var i = 0; i < list.length && i < 6; i += 1) {
          var r = rectOf(list[i])
          var rows = panelRowsOf(list[i])
          var labels = []
          for (var j = 0; j < rows.length && j < 8; j += 1) labels.push(String(rows[j].label).slice(0, 10))
          navs.push({
            i: i,
            el: describeEl(list[i]),
            left: r ? Math.round(r.left) : null,
            w: r ? Math.round(r.width) : null,
            h: r ? Math.round(r.height) : null,
            rows: labels,
          })
        }
      } catch (err) { /* 诊断本身不能抛 */ }
      var entry = refs.entry && refs.entry.host
      var prev = entry && entry.previousSibling ? textOf(entry.previousSibling).slice(0, 10) : null
      var next = entry && entry.nextSibling ? textOf(entry.nextSibling).slice(0, 10) : null
      var payload = {
        v: VERSION,
        reason: String(reason || '').slice(0, 60),
        mode: state.mode,
        colWidth: Math.round(state.colWidth || 0),
        frame: describeEl(sb.frame),
        root: describeEl(sb.root),
        col: describeEl(sb.col),
        chosenNav: sb.nav ? describeEl(sb.nav) : null,
        navCount: navs.length,
        navs: navs,
        entryParent: entry ? describeEl(entry.parentElement) : null,
        entryPrev: prev,
        entryNext: next,
        native: entry ? entry.getAttribute('data-native') : null,
        display: entry ? String(entry.style && entry.style.display ? entry.style.display : '') : null,
        bodyChildren: (function () {
          var out = []
          try {
            var kids = document.body ? document.body.children : []
            for (var k = 0; k < kids.length && k < 6; k += 1) out.push(describeEl(kids[k]))
          } catch (err) { /* 忽略 */ }
          return out
        })(),
      }
      var json = JSON.stringify(payload).slice(0, 6000)
      fetch(DIAG_API + '?d=' + encodeURIComponent(json), { cache: 'no-store' }).catch(function () {})
    } catch (err) {
      // 诊断失败不影响面板
    }
  }

  function reportMounted() {
    try {
      if (typeof fetch !== 'function') return
      var loc = window.location || {}
      var nav = window.navigator || (typeof navigator !== 'undefined' ? navigator : null)
      var href = String(loc.href || '')
      var proto = String(loc.protocol || '')
      var ua = nav && nav.userAgent ? String(nav.userAgent) : ''
      var url =
        MOUNTED_API +
        '?href=' + encodeURIComponent(href.slice(0, 300)) +
        '&proto=' + encodeURIComponent(proto.slice(0, 40)) +
        '&ua=' + encodeURIComponent(ua.slice(0, 180))
      fetch(url, { cache: 'no-store' }).catch(function () {})
    } catch (err) {
      // 自报失败不影响面板
    }
  }

  function boot() {
    if (state.booted) return
    if (!document.body) {
      setTimeout(boot, 120)
      return
    }
    state.booted = true

    try {
      if (!refs.panel) buildPanelMount()
    } catch (err) {
      console.error('[dsh-gold-card] 面板创建失败（面板不可用，其余不受影响）', err)
    }
    try {
      if (!refs.rail) buildRail()
    } catch (err) {
      console.error('[dsh-gold-card] 轨道按钮创建失败', err)
    }

    ensure()
    updateDom()
    load({ reason: 'boot' })
    restartTimer(true)

    try {
      state.health = setInterval(ensure, HEALTH_MS)
    } catch (err) {
      // 无定时器能力（极端环境）：只靠 MutationObserver
    }
    watchDom()

    try {
      window.addEventListener('resize', onResize)
    } catch (err) { /* 忽略 */ }
    try {
      document.addEventListener('visibilitychange', onVisibility)
    } catch (err) { /* 忽略 */ }
    try {
      document.addEventListener('keydown', onKeydown, true)
    } catch (err) { /* 忽略 */ }

    reportMounted()
    // 诊断快照：启动瞬间一次 + 3 秒后（布局稳定）一次，写 Host 日志供排查
    reportDiag('boot')
    setTimeout(function () {
      reportDiag('boot+3s')
    }, 3000)
  }

  function start() {
    if (document.readyState === 'loading') {
      try {
        document.addEventListener('DOMContentLoaded', boot, { once: true })
      } catch (err) {
        document.addEventListener('DOMContentLoaded', boot)
      }
      // 兜底：个别环境 readyState 卡在 loading
      setTimeout(function () {
        if (!state.booted) boot()
      }, 4000)
    } else {
      boot()
    }
  }

  // ---------------------------------------------------------------------------
  // 调试 / 离线自测入口（Host 侧不需要，纯前端自测用）
  // ---------------------------------------------------------------------------

  var publicApi = {
    version: VERSION,
    state: state,
    api: API,
    // 纯函数
    esc: esc,
    fmtNum: fmtNum,
    fmtPct: fmtPct,
    quoteTimeText: quoteTimeText,
    localTimeText: localTimeText,
    parseLooseDate: parseLooseDate,
    toneOf: toneOf,
    toneCls: toneCls,
    // HTML 片段
    badgeHtml: badgeHtml,
    premiumHtml: premiumHtml,
    freshnessHtml: freshnessHtml,
    cardHtml: cardHtml,
    cardsHtml: cardsHtml,
    bodyHtmlFor: bodyHtmlFor,
    summaryOf: summaryOf,
    okCount: okCount,
    // 布局/交互（自测可直接调）
    detectSidebar: detectSidebar,
    ensure: ensure,
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
    refresh: function () { load({ manual: true }) },
  }

  window.__dshGoldCardPanel = publicApi
  window.__dshGoldPanel = publicApi

  start()
})()
