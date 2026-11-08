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

  var VERSION = '3.8.2'
  var API = '/dsh-gold/api/quotes'
  var EXTRAS_API = '/dsh-gold/api/extras'
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
  var EXTRAS_TIMEOUT_MS = 25000
  var HEALTH_MS = 4000
  var SIDEBAR_MIN_WIDE = 120 // < 该宽度视为折叠轨道
  var SIDEBAR_MIN_VISIBLE = 8 // < 该宽度视为侧边栏不可见
  /** 右侧扩展列（走势图 + 资讯）的显隐持久化 key，读者可自行清除 */
  var EXTRAS_KEY = 'dsh-gold-card:extras'

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

  // 走势 + 要闻开关（柱状/折线小图标）
  var ICON_EXTRAS =
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M2.6 11.7 6 8.1l2.4 2.1 4.9-5.3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M10.6 4.9h2.7v2.7" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>' +
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
    // 右侧扩展列（走势图 + 资讯）
    extrasVisible: false,
    extrasLoading: false,
    extras: { status: 'idle', data: null, error: null, at: 0 },
    range: 'week', // week | month
    extrasToken: 0,
    // 积存金持仓（本地记录）
    positions: [],
    posDraft: { channel: 'icbc', grams: '', price: '' },
    posError: null,
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
    var main
    if (!state.payload) {
      if (state.loading) main = skeletonHtml()
      else if (state.error) main = '<div class="dsh-gold-empty">行情服务暂时不可用</div>'
      else main = '<div class="dsh-gold-empty">加载中…</div>'
    } else {
      main = cardsHtml(state.payload) || '<div class="dsh-gold-empty">暂无行情数据</div>'
    }
    var side = state.extrasVisible ? sideHtml() : ''
    return (
      '<div class="dsh-gold-layout' + (side ? ' dsh-gold-layout-wide' : '') + '">' +
      '<div class="dsh-gold-col-main">' + main + '</div>' +
      side +
      '</div>'
    )
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
  // 右侧扩展列：走势图 + 黄金要闻
  //
  // 两个模块共用头部一个开关（默认隐藏）；显隐存 localStorage。
  // 走势与资讯都来自 Host 的 /dsh-gold/api/extras，前端只负责渲染，
  // 切换本周/本月不重新请求（Host 一次把两个区间都算好）。
  // ---------------------------------------------------------------------------

  function safeUrl(url) {
    try {
      var u = new URL(String(url))
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString()
    } catch (err) { /* 非法 URL 直接丢弃 */ }
    return ''
  }

  function readExtrasPref() {
    try {
      if (!window.localStorage) return false
      return window.localStorage.getItem(EXTRAS_KEY) === '1'
    } catch (err) {
      return false // 隐私模式 / 禁用存储：默认隐藏，仅本次会话有效
    }
  }

  function writeExtrasPref(on) {
    try {
      if (window.localStorage) window.localStorage.setItem(EXTRAS_KEY, on ? '1' : '0')
    } catch (err) { /* 写不进去也不影响当前会话 */ }
  }

  /** 资讯时间：今天/昨天/MM-DD */
  function newsDateText(publishedAt, now) {
    var d = parseLooseDate(publishedAt)
    if (!d) return ''
    var ref = now instanceof Date ? now : new Date()
    var day = 24 * 3600 * 1000
    var startOfRef = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime()
    var startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    var diff = Math.round((startOfRef - startOfDay) / day)
    if (diff === 0) return '今天'
    if (diff === 1) return '昨天'
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  }

  function changePillHtml(change) {
    if (!change || !isNum(change.pct)) return ''
    var tone = change.pct > 0 ? 'up' : change.pct < 0 ? 'down' : ''
    var arrow = change.pct > 0 ? '▲ ' : change.pct < 0 ? '▼ ' : ''
    return (
      '<span class="dsh-gold-change ' + (tone ? 'dsh-gold-' + tone : 'dsh-gold-flat') + '" title="' +
      esc(fmtPct(change.pct)) + '">' + arrow + Math.abs(change.pct).toFixed(2) + '%</span>'
    )
  }

  /** 320×132 的手写 SVG 折线图（不引第三方图表库，避免 CDN/依赖） */
  function chartSvg(rangeData) {
    var pts = rangeData && rangeData.points ? rangeData.points : []
    if (!pts.length) return ''
    var W = 320
    var H = 132
    var padL = 8
    var padR = 8
    var padT = 12
    var padB = 22
    var plotW = W - padL - padR
    var plotH = H - padT - padB
    var values = []
    var i
    for (i = 0; i < pts.length; i += 1) if (isNum(pts[i].close)) values.push(pts[i].close)
    if (!values.length) return ''
    var min = Math.min.apply(null, values)
    var max = Math.max.apply(null, values)
    if (min === max) {
      min -= 0.5
      max += 0.5
    }
    var span = max - min
    function px(index) {
      if (pts.length === 1) return padL + plotW / 2
      return padL + (plotW * index) / (pts.length - 1)
    }
    function py(value) {
      return padT + plotH * ((max - value) / span)
    }
    var line = ''
    for (i = 0; i < pts.length; i += 1) {
      line += (i ? ' L' : 'M') + px(i).toFixed(1) + ' ' + py(pts[i].close).toFixed(1)
    }
    var area =
      line +
      ' L' + px(pts.length - 1).toFixed(1) + ' ' + (padT + plotH).toFixed(1) +
      ' L' + px(0).toFixed(1) + ' ' + (padT + plotH).toFixed(1) + ' Z'

    var grid = ''
    for (i = 0; i <= 2; i += 1) {
      var gy = (padT + (plotH * i) / 2).toFixed(1)
      grid +=
        '<line class="dsh-gold-chart-grid" x1="' + padL + '" y1="' + gy +
        '" x2="' + (W - padR) + '" y2="' + gy + '"/>'
    }

    var last = pts[pts.length - 1]
    var lastX = px(pts.length - 1)
    var lastY = py(last.close)
    var labelAnchor = lastX > W - 62 ? 'end' : 'start'
    var labelX = labelAnchor === 'end' ? lastX - 5 : lastX + 5
    var labelY = Math.max(13, Math.min(H - 8, lastY - 7))

    // 每天的收盘价都点一个加粗圆点；区间最高/最低用红/绿描边强调
    var highIdx = -1
    var lowIdx = -1
    for (i = 0; i < pts.length; i += 1) {
      if (rangeData.high && pts[i].date === rangeData.high.date) highIdx = i
      if (rangeData.low && pts[i].date === rangeData.low.date) lowIdx = i
    }
    var dots = ''
    for (i = 0; i < pts.length; i += 1) {
      var dotClass = 'dsh-gold-chart-dot'
      var dotR = 2.4
      if (i === pts.length - 1) {
        dotClass += ' dsh-gold-chart-dot-last'
        dotR = 3.0
      }
      if (i === highIdx) {
        dotClass += ' dsh-gold-chart-dot-high'
        dotR = 3.4
      }
      if (i === lowIdx) {
        dotClass += ' dsh-gold-chart-dot-low'
        dotR = 3.4
      }
      dots +=
        '<circle class="' + dotClass + '" cx="' + px(i).toFixed(1) + '" cy="' + py(pts[i].close).toFixed(1) +
        '" r="' + dotR + '"><title>' + esc(pts[i].date + ' ' + fmtNum(pts[i].close)) + '</title></circle>'
    }

    var svg =
      '<svg class="dsh-gold-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Au99.99 ' +
      esc(rangeData.label || '') + '走势">' +
      '<defs><linearGradient id="dsh-gold-chart-grad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" class="dsh-gold-chart-stop-a"/>' +
      '<stop offset="1" class="dsh-gold-chart-stop-b"/>' +
      '</linearGradient></defs>' +
      grid +
      '<path class="dsh-gold-chart-area" d="' + area + '"/>' +
      '<path class="dsh-gold-chart-line" d="' + line + '"/>' +
      dots +
      '<text class="dsh-gold-chart-price" x="' + labelX.toFixed(1) + '" y="' + labelY.toFixed(1) +
      '" text-anchor="' + labelAnchor + '">' + esc(fmtNum(last.close)) + '</text>' +
      '<text class="dsh-gold-chart-axis" x="' + padL + '" y="' + (H - 4) + '">' +
      esc(String(pts[0].date || '')) + '</text>' +
      '<text class="dsh-gold-chart-axis" x="' + (W - padR) + '" y="' + (H - 4) + '" text-anchor="end">' +
      esc(String(last.date || '')) + '</text>' +
      '</svg>'
    return svg
  }

  function rangeButtonHtml() {
    var next = state.range === 'week' ? '本月' : '本周'
    return (
      '<button type="button" class="dsh-gold-range-btn" data-dsh-gold-action="range" ' +
      'aria-label="切换到' + next + '走势" title="切换到' + next + '走势">' +
      esc(state.range === 'week' ? '本周' : '本月') +
      '<span class="dsh-gold-range-ico" aria-hidden="true">⇄</span></button>'
    )
  }

  function chartCardHtml(extras) {
    var chart = extras && extras.data ? extras.data.chart : null
    var rangeData = chart && chart.ranges ? chart.ranges[state.range] : null
    var html = '<div class="dsh-gold-side-card dsh-gold-chart-card">'
    html += '<div class="dsh-gold-side-head">'
    html += '<span class="dsh-gold-side-title">Au99.99 走势</span>'
    if (rangeData && rangeData.change) html += changePillHtml(rangeData.change)
    html += '</div>'

    var unavailable = extras && extras.status === 'error' && !chart
    if (unavailable || (chart && chart.ok === false)) {
      html += '<div class="dsh-gold-side-empty">走势暂不可用</div>'
    } else if (!chart) {
      html += '<div class="dsh-gold-chart-skeleton" aria-hidden="true"></div>'
    } else if (!rangeData || !rangeData.points || !rangeData.points.length) {
      html += '<div class="dsh-gold-side-empty">暂无走势数据</div>'
    } else {
      html += '<div class="dsh-gold-chart-wrap">' + chartSvg(rangeData) + '</div>'
      if (rangeData.high || rangeData.low) {
        html += '<div class="dsh-gold-chart-extremes">'
        if (rangeData.high) {
          html +=
            '<span class="dsh-gold-extreme dsh-gold-extreme-high">' +
            '<span class="dsh-gold-extreme-label">最高</span>' +
            '<span class="dsh-gold-extreme-value">' + esc(fmtNum(rangeData.high.close)) + '</span>' +
            '<span class="dsh-gold-extreme-date">' + esc(String(rangeData.high.date || '')) + '</span>' +
            '</span>'
        }
        if (rangeData.low) {
          html +=
            '<span class="dsh-gold-extreme dsh-gold-extreme-low">' +
            '<span class="dsh-gold-extreme-label">最低</span>' +
            '<span class="dsh-gold-extreme-value">' + esc(fmtNum(rangeData.low.close)) + '</span>' +
            '<span class="dsh-gold-extreme-date">' + esc(String(rangeData.low.date || '')) + '</span>' +
            '</span>'
        }
        html += '</div>'
      }
      if (rangeData.note) {
        html += '<div class="dsh-gold-side-note">' + esc(rangeData.note) + '</div>'
      }
    }

    var src = '东方财富'
    if (chart && chart.fallback) src = '上金所日行情'
    if (chart && chart.stale) src += ' · 缓存'
    html += '<div class="dsh-gold-chart-foot">'
    html += '<span class="dsh-gold-side-src">' + esc(src) + '</span>'
    html += rangeButtonHtml()
    html += '</div>'
    return html + '</div>'
  }

  function newsItemHtml(item, index) {
    var url = safeUrl(item && item.url)
    if (!url) return ''
    var tier = item.tier >= 3 ? 'official' : 'media'
    var time = newsDateText(item.publishedAt, new Date())
    return (
      '<a class="dsh-gold-news-item" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' +
      '<span class="dsh-gold-news-idx">' + (index + 1) + '</span>' +
      '<span class="dsh-gold-news-main">' +
      '<span class="dsh-gold-news-title">' + esc(item.title) + '</span>' +
      '<span class="dsh-gold-news-meta">' +
      '<span class="dsh-gold-news-pill dsh-gold-news-pill-' + tier + '">' + esc(item.sourceName || '') + '</span>' +
      (time ? '<span class="dsh-gold-news-time">' + esc(time) + '</span>' : '') +
      '</span></span></a>'
    )
  }

  function newsCardHtml(extras) {
    var news = extras && extras.data ? extras.data.news : null
    var items = news && news.items ? news.items : []
    var html = '<div class="dsh-gold-side-card dsh-gold-news-card">'
    html += '<div class="dsh-gold-side-head">'
    html += '<span class="dsh-gold-side-title">黄金要闻</span>'
    if (items.length) html += '<span class="dsh-gold-side-meta">每天更新</span>'
    html += '</div>'

    if (!items.length) {
      html += '<div class="dsh-gold-side-empty">' +
        (extras && extras.status === 'error' ? '资讯暂不可用' : '资讯加载中…') + '</div>'
    } else {
      html += '<div class="dsh-gold-news-list">'
      for (var i = 0; i < items.length && i < 3; i += 1) html += newsItemHtml(items[i], i)
      html += '</div>'
      if (news && (news.stale || news.error || (extras && extras.status === 'error'))) {
        html += '<div class="dsh-gold-side-note">资讯更新失败，展示上次内容</div>'
      }
    }

    html += '<div class="dsh-gold-news-foot">官方来源优先 · 每天更新一次</div>'
    return html + '</div>'
  }

  function sideHtml() {
    return (
      '<div class="dsh-gold-col-side" aria-label="走势、要闻与持仓">' +
      chartCardHtml(state.extras) +
      newsCardHtml(state.extras) +
      positionCardHtml() +
      '</div>'
    )
  }

  // ---------------------------------------------------------------------------
  // 积存金持仓（右侧列底部）：记录每笔积存，按渠道规则估算全部赎回盈亏
  // ---------------------------------------------------------------------------

  var POSITIONS_KEY = 'dsh-gold-card:positions'
  /**
   * 渠道交易规则：
   * - 工商银行积存金：赎回按赎回价成交，另收赎回金额 0.5% 手续费；
   *   主动积存手续费在活动期内为 0（买入成本按用户录入的每克价格算）。
   * - 建设银行积存金：买卖点差体现在买入价/赎回价里，赎回不再另收手续费。
   */
  var POSITION_CHANNELS = {
    icbc: { name: '工商银行', fee: 0.005, feeText: '赎回费 0.5%' },
    ccb: { name: '建设银行', fee: 0, feeText: '点差已含' },
  }
  var POSITION_MAX_RECORDS = 200

  function positionChannelIds() {
    return ['icbc', 'ccb']
  }

  /** 本地记录：只接受合法渠道、正数克重/价格，坏数据直接跳过（不因脏数据把面板弄挂） */
  function readPositions() {
    var out = []
    try {
      var raw = window.localStorage ? window.localStorage.getItem(POSITIONS_KEY) : null
      if (!raw) return out
      var list = JSON.parse(raw)
      if (!Array.isArray(list)) return out
      for (var i = 0; i < list.length && i < POSITION_MAX_RECORDS; i += 1) {
        var it = list[i]
        if (!it || !POSITION_CHANNELS[it.channel]) continue
        var grams = Number(it.grams)
        var price = Number(it.price)
        if (!(grams > 0) || !(price > 0)) continue
        out.push({
          id: String(it.id || 'p' + i),
          channel: it.channel,
          grams: grams,
          price: price,
          at: Number(it.at) || 0,
        })
      }
    } catch (err) {
      return []
    }
    return out
  }

  function writePositions() {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(POSITIONS_KEY, JSON.stringify(state.positions || []))
      }
    } catch (err) {
      // 本地存储不可用：只在当前页面会话内有效
    }
  }

  function pickFieldByLabel(fields, re) {
    if (!fields || !fields.length) return null
    for (var i = 0; i < fields.length; i += 1) {
      var f = fields[i]
      if (f && re.test(String(f.label || ''))) return f
    }
    return null
  }

  /** 取渠道当前赎回价：工行取「积存金」分组（不是如意金），建行取卡片「赎回价」 */
  function channelRedeem(payload, channel) {
    var def = POSITION_CHANNELS[channel]
    var out = { ok: false, price: null, fee: def ? def.fee : 0, name: def ? def.name : channel }
    if (!payload || !payload.cards || !def) return out
    var card = payload.cards[channel]
    if (!card || card.ok === false) return out
    var field = null
    if (channel === 'icbc') {
      var groups = card.groups || []
      var g = null
      for (var i = 0; i < groups.length; i += 1) {
        var title = String((groups[i] && (groups[i].name || groups[i].title)) || '')
        if (/积存金/.test(title) && !/如意/.test(title)) {
          g = groups[i]
          break
        }
      }
      if (!g) {
        for (var j = 0; j < groups.length; j += 1) {
          if (groups[j]) {
            g = groups[j]
            break
          }
        }
      }
      field = pickFieldByLabel(g && g.fields, /赎回价/)
    } else {
      field = pickFieldByLabel(card.fields, /赎回价/)
    }
    if (field && isNum(field.value)) {
      out.ok = true
      out.price = Number(field.value)
    }
    return out
  }

  /** 取渠道当前「买入价」用于录入时预填：工行取积存金主动积存价，建行取买入价 */
  function channelBuyPrice(payload, channel) {
    if (!payload || !payload.cards) return { ok: false, price: null }
    var card = payload.cards[channel]
    if (!card || card.ok === false) return { ok: false, price: null }
    var field = null
    if (channel === 'icbc') {
      var groups = card.groups || []
      var g = null
      for (var i = 0; i < groups.length; i += 1) {
        var title = String((groups[i] && (groups[i].name || groups[i].title)) || '')
        if (/积存金/.test(title) && !/如意/.test(title)) {
          g = groups[i]
          break
        }
      }
      field = pickFieldByLabel(g && g.fields, /主动积存价|积存价/)
    } else {
      field = pickFieldByLabel(card.fields, /买入价/)
    }
    if (field && isNum(field.value)) return { ok: true, price: Number(field.value) }
    return { ok: false, price: null }
  }

  function channelStats(records, priceInfo) {
    var grams = 0
    var cost = 0
    for (var i = 0; i < records.length; i += 1) {
      grams += records[i].grams
      cost += records[i].grams * records[i].price
    }
    var avgCost = grams > 0 ? cost / grams : null
    var redeem = priceInfo && priceInfo.ok && isNum(priceInfo.price) ? Number(priceInfo.price) : null
    var fee = priceInfo && isNum(priceInfo.fee) ? Number(priceInfo.fee) : 0
    var netUnit = redeem !== null ? redeem * (1 - fee) : null
    var netValue = netUnit !== null ? grams * netUnit : null
    var pnl = netValue !== null ? netValue - cost : null
    var pnlPct = pnl !== null && cost > 0 ? (pnl / cost) * 100 : null
    return {
      grams: grams,
      cost: cost,
      avgCost: avgCost,
      redeem: redeem,
      fee: fee,
      netUnit: netUnit,
      netValue: netValue,
      pnl: pnl,
      pnlPct: pnlPct,
    }
  }

  /** 汇总：分渠道 + 合计。任一有持仓的渠道拿不到赎回价时，不硬凑总盈亏。 */
  function positionsSummary() {
    var records = state.positions || []
    var channels = {}
    var ids = positionChannelIds()
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i]
      var list = []
      for (var j = 0; j < records.length; j += 1) if (records[j].channel === id) list.push(records[j])
      var priceInfo = channelRedeem(state.payload, id)
      channels[id] = { priceInfo: priceInfo, stats: channelStats(list, priceInfo), count: list.length }
    }
    var totalGrams = 0
    var totalCost = 0
    var totalNet = 0
    var missing = false
    for (var k = 0; k < ids.length; k += 1) {
      var ch = channels[ids[k]]
      totalGrams += ch.stats.grams
      totalCost += ch.stats.cost
      if (ch.stats.grams <= 0) continue
      if (ch.stats.netValue === null) missing = true
      else totalNet += ch.stats.netValue
    }
    var total = {
      grams: totalGrams,
      cost: totalCost,
      avgCost: totalGrams > 0 ? totalCost / totalGrams : null,
      netValue: missing ? null : totalNet,
      pnl: missing ? null : totalNet - totalCost,
      pnlPct: missing || totalCost <= 0 ? null : ((totalNet - totalCost) / totalCost) * 100,
    }
    return { channels: channels, total: total, missing: missing }
  }

  function pnlText(value, pct) {
    var cls = value > 0 ? ' dsh-gold-up' : value < 0 ? ' dsh-gold-down' : ''
    var num = (value > 0 ? '+' : '') + fmtNum(value)
    var pctText = pct === null ? '' : '（' + fmtPct(pct) + '）'
    return '<span class="dsh-gold-pos-pnl' + cls + '">' + num + pctText + '</span>'
  }

  function positionChannelHtml(id) {
    var def = POSITION_CHANNELS[id]
    var ch = positionsSummary().channels[id]
    var stats = ch.stats
    if (!ch.count) return ''
    var priceText = stats.redeem === null ? '赎回价暂不可用' : fmtNum(stats.redeem) + ' 元/克'
    var feeLine =
      stats.redeem === null
        ? '等待行情刷新'
        : '净赎回价 ' + fmtNum(stats.netUnit) + ' 元/克 · ' + def.feeText
    var pnl =
      stats.pnl === null
        ? '<span class="dsh-gold-pos-muted">盈亏待行情</span>'
        : pnlText(stats.pnl, stats.pnlPct)
    return (
      '<div class="dsh-gold-pos-ch">' +
      '<div class="dsh-gold-pos-ch-head">' +
      '<span class="dsh-gold-pos-ch-name">' + esc(def.name) + '</span>' +
      '<span class="dsh-gold-pos-ch-grams">' + fmtNum(stats.grams) + ' 克</span>' +
      '</div>' +
      '<div class="dsh-gold-pos-grid">' +
      '<div class="dsh-gold-pos-cell"><span class="dsh-gold-pos-label">平均成本</span>' +
      '<span class="dsh-gold-pos-value">' + fmtNum(stats.avgCost) + '</span></div>' +
      '<div class="dsh-gold-pos-cell"><span class="dsh-gold-pos-label">当前赎回价</span>' +
      '<span class="dsh-gold-pos-value">' + priceText + '</span></div>' +
      '<div class="dsh-gold-pos-cell"><span class="dsh-gold-pos-label">预计盈亏</span>' +
      '<span class="dsh-gold-pos-value">' + pnl + '</span></div>' +
      '</div>' +
      '<div class="dsh-gold-pos-fee">' + feeLine + '</div>' +
      '</div>'
    )
  }

  function positionRecordsHtml() {
    var list = (state.positions || []).slice().sort(function (a, b) {
      return b.at - a.at
    })
    if (!list.length) return ''
    var html = '<ul class="dsh-gold-pos-list">'
    for (var i = 0; i < list.length && i < 12; i += 1) {
      var it = list[i]
      var def = POSITION_CHANNELS[it.channel]
      var date = ''
      try {
        var d = new Date(it.at || Date.now())
        date = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      } catch (err) { date = '' }
      html +=
        '<li class="dsh-gold-pos-item">' +
        '<span class="dsh-gold-pos-item-date">' + esc(date) + '</span>' +
        '<span class="dsh-gold-pos-item-main">' + esc(def ? def.name : it.channel) + ' · ' + fmtNum(it.grams) + ' 克 @ ' + fmtNum(it.price) + '</span>' +
        '<button type="button" class="dsh-gold-pos-del" data-dsh-gold-action="position-remove" data-id="' + esc(it.id) + '" title="删除这笔记录" aria-label="删除这笔记录">×</button>' +
        '</li>'
    }
    html += '</ul>'
    if (list.length > 12) html += '<div class="dsh-gold-pos-more">仅显示最近 12 笔，共 ' + list.length + ' 笔</div>'
    return html
  }

  function positionCardHtml() {
    var draft = state.posDraft || { channel: 'icbc', grams: '', price: '' }
    var buyInfo = channelBuyPrice(state.payload, draft.channel)
    var prefill = draft.price !== '' ? draft.price : buyInfo.ok ? fmtNum(buyInfo.price) : ''
    var options = ''
    var ids = positionChannelIds()
    for (var i = 0; i < ids.length; i += 1) {
      options +=
        '<option value="' + ids[i] + '"' + (ids[i] === draft.channel ? ' selected' : '') + '>' +
        esc(POSITION_CHANNELS[ids[i]].name) +
        '</option>'
    }
    var summary = positionsSummary()
    var channelsHtml = positionChannelHtml('icbc') + positionChannelHtml('ccb')
    var total = summary.total
    var totalHtml = ''
    if (total.grams > 0) {
      totalHtml =
        '<div class="dsh-gold-pos-total">' +
        '<span class="dsh-gold-pos-total-label">合计</span>' +
        '<span class="dsh-gold-pos-total-grams">' + fmtNum(total.grams) + ' 克 · 成本 ' + fmtNum(total.avgCost) + ' 元/克</span>' +
        '<span class="dsh-gold-pos-total-pnl">' +
        (total.pnl === null ? '<span class="dsh-gold-pos-muted">盈亏待行情</span>' : pnlText(total.pnl, total.pnlPct)) +
        '</span>' +
        '</div>'
    }
    return (
      '<section class="dsh-gold-side-card dsh-gold-pos" aria-label="积存金持仓">' +
      '<div class="dsh-gold-side-head">' +
      '<span class="dsh-gold-side-title">积存金持仓</span>' +
      '<span class="dsh-gold-side-meta">本地记录</span>' +
      '</div>' +
      (channelsHtml || '<div class="dsh-gold-pos-empty">还没有积存记录，填入克数和成交价后点「记录一笔」</div>') +
      totalHtml +
      positionRecordsHtml() +
      '<div class="dsh-gold-pos-err">' + esc(state.posError || '') + '</div>' +
      '<div class="dsh-gold-pos-form">' +
      '<label class="dsh-gold-pos-field"><span>渠道</span>' +
      '<select id="dsh-gold-pos-channel" data-pos="channel">' + options + '</select></label>' +
      '<label class="dsh-gold-pos-field"><span>克数</span>' +
      '<input id="dsh-gold-pos-grams" data-pos="grams" type="number" inputmode="decimal" step="0.01" min="0.01" placeholder="0.00" value="' + esc(draft.grams) + '"></label>' +
      '<label class="dsh-gold-pos-field"><span>每克价格</span>' +
      '<input id="dsh-gold-pos-price" data-pos="price" type="number" inputmode="decimal" step="0.01" min="0.01" placeholder="' + esc(buyInfo.ok ? fmtNum(buyInfo.price) : '0.00') + '" value="' + esc(prefill) + '"></label>' +
      '<button type="button" class="dsh-gold-pos-add" data-dsh-gold-action="position-add">记录一笔</button>' +
      '</div>' +
      '<div class="dsh-gold-pos-foot">工行赎回费 0.5% · 建行按赎回价成交（点差已含）· 记录只存在本机</div>' +
      '</section>'
    )
  }

  function addPosition(input) {
    var data = input || {}
    var channel = POSITION_CHANNELS[data.channel] ? data.channel : 'icbc'
    var grams = Number(data.grams)
    var price = Number(data.price)
    if (!(grams > 0)) {
      state.posError = '克数需要大于 0'
      return null
    }
    if (!(price > 0)) {
      state.posError = '每克价格需要大于 0'
      return null
    }
    state.posError = null
    var rec = {
      id: 'p' + Date.now() + Math.random().toString(36).slice(2, 6),
      channel: channel,
      grams: Math.round(grams * 100) / 100,
      price: Math.round(price * 100) / 100,
      at: Date.now(),
    }
    state.positions = (state.positions || []).concat([rec])
    writePositions()
    state.posDraft = { channel: channel, grams: '', price: '' }
    return rec
  }

  function submitPosition() {
    var draft = state.posDraft || {}
    var rec = addPosition({ channel: draft.channel, grams: draft.grams, price: draft.price })
    updatePanel()
    return rec
  }

  function removePosition(id) {
    var list = state.positions || []
    var next = []
    for (var i = 0; i < list.length; i += 1) if (list[i].id !== id) next.push(list[i])
    if (next.length === list.length) return false
    state.positions = next
    writePositions()
    return true
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
    setAttr(root, 'data-extras', state.extrasVisible ? '1' : '0')

    var head = mk('div', 'dsh-gold-panel-head')
    var titleWrap = mk('div', 'dsh-gold-panel-title')
    var glyph = mk('span', 'dsh-gold-panel-glyph')
    setAttr(glyph, 'aria-hidden', 'true')
    glyph.innerHTML = GOLD_ICON
    titleWrap.appendChild(glyph)
    titleWrap.appendChild(mk('span', 'dsh-gold-panel-title-text', ENTRY_LABEL))

    var actions = mk('div', 'dsh-gold-panel-actions')
    var extras = mk('button', 'dsh-gold-iconbtn dsh-gold-extras-btn')
    extras.type = 'button'
    setAttr(extras, 'data-dsh-gold-action', 'extras')
    setAttr(extras, 'aria-pressed', state.extrasVisible ? 'true' : 'false')
    setAttr(extras, 'title', state.extrasVisible ? '隐藏走势与要闻' : '显示走势与要闻')
    setAttr(extras, 'aria-label', '显示或隐藏走势与要闻')
    extras.innerHTML = ICON_EXTRAS
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
    actions.appendChild(extras)
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
      else if (action === 'extras') toggleExtras()
      else if (action === 'range') toggleRange()
      else if (action === 'position-add') submitPosition()
      else if (action === 'position-remove') {
        if (removePosition(node.getAttribute('data-id') || '')) updatePanel()
      }
    })

    // 持仓表单：输入只记到 state，不重绘（保住光标）；刷新重绘时再从 state 回填
    root.addEventListener('input', function (event) {
      var target = event.target
      if (!target || typeof target.getAttribute !== 'function') return
      var key = target.getAttribute('data-pos')
      if (!key) return
      if (!state.posDraft) state.posDraft = { channel: 'icbc', grams: '', price: '' }
      state.posDraft[key] = target.value === undefined || target.value === null ? '' : String(target.value)
    })

    root.addEventListener('change', function (event) {
      var target = event.target
      if (!target || typeof target.getAttribute !== 'function') return
      if (target.getAttribute('data-pos') !== 'channel') return
      var channel = String(target.value || '')
      if (!POSITION_CHANNELS[channel]) return
      var info = channelBuyPrice(state.payload, channel)
      state.posDraft.channel = channel
      state.posDraft.price = info.ok ? fmtNum(info.price) : ''
      updatePanel()
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
      extrasBtn: extras,
      closeBtn: close,
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

    setAttr(panel.root, 'data-extras', state.extrasVisible ? '1' : '0')
    if (panel.extrasBtn) {
      setAttr(panel.extrasBtn, 'aria-pressed', state.extrasVisible ? 'true' : 'false')
    }

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

  /**
   * Windows 桌面版窗口用的是 titleBarOverlay：原生的最小化/最大化/关闭按钮浮在页面
   * 顶部约 40px 的条带里。面板贴右上角摆放时，这段原生区域会吃掉鼠标事件——
   * 图标上半截点不动、往下挪一点才能点到。这里量出标题栏高度，把面板整体下移。
   */
  function titlebarInset() {
    var inset = 0
    try {
      var wco = typeof navigator !== 'undefined' ? navigator.windowControlsOverlay : null
      if (wco && wco.visible !== false && typeof wco.getTitlebarAreaRect === 'function') {
        var r = wco.getTitlebarAreaRect()
        if (r && r.height > 0 && r.height < 120) inset = Math.round(r.height)
      }
    } catch (err) { /* 忽略 */ }
    if (!inset) {
      try {
        var ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '')
        var proto = String((window.location && window.location.protocol) || '')
        if (/Windows/i.test(ua) && /^dsh-app:/i.test(proto)) inset = 40
      } catch (err) { /* 忽略 */ }
    }
    return inset
  }

  // 贴左侧边栏右缘展开：宽视口是「贴边竖条」，窄视口退化成居中浮层。
  function positionPanel() {
    var panel = refs.panel
    if (!panel) return
    var root = panel.root
    var style = root.style || {}
    var vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 1024
    var vh = window.innerHeight || 800
    // 顶部留出原生标题栏（Windows 窗口按钮）的高度，避免按钮被原生层挡住
    var top = 8 + titlebarInset()

    if (vw < 820 || vh < 480) {
      setAttr(root, 'data-sheet', '1')
      style.left = '8px'
      style.right = '8px'
      style.top = top + 'px'
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

    // 打开右侧扩展列时面板变宽（两列并排），否则保持原来的单列宽度
    var useExtras = !!state.extrasVisible
    var maxW = useExtras ? 780 : 384
    var minW = useExtras ? 320 : 300
    var width = Math.round(Math.min(maxW, Math.max(minW, vw - left - 24)))
    if (vw - left - 24 < minW) width = Math.max(260, vw - left - 16)
    left = Math.max(0, Math.min(left, vw - width))

    style.left = left + 'px'
    style.right = 'auto'
    style.top = top + 'px'
    style.bottom = '8px'
    style.width = width + 'px'
  }

  /**
   * 命中测试：三个头部按钮的几何中心/上边缘是否真能点到自己。
   * 用于排查「看着在按钮上却点不到」这类原生层遮挡问题（结果进诊断日志）。
   */
  function hitTargetsReport() {
    var panel = refs.panel
    var out = []
    if (!panel) return out
    var list = [
      { name: 'extras', el: panel.extrasBtn },
      { name: 'refresh', el: panel.refresh },
      { name: 'close', el: panel.closeBtn },
    ]
    for (var i = 0; i < list.length; i += 1) {
      var btn = list[i].el
      if (!btn) continue
      var r = rectOf(btn)
      if (!r) {
        out.push({ name: list[i].name, rect: null })
        continue
      }
      var cx = Math.round(r.left + r.width / 2)
      var cy = Math.round(r.top + r.height / 2)
      var at = null
      var atTop = null
      try {
        at = document.elementFromPoint(cx, cy)
      } catch (err) { at = null }
      try {
        atTop = document.elementFromPoint(cx, Math.round(r.top + 2))
      } catch (err) { atTop = null }
      var owns = function (el) {
        if (!el) return false
        if (el === btn) return true
        try {
          return !!(btn.contains && btn.contains(el))
        } catch (err) {
          return false
        }
      }
      out.push({
        name: list[i].name,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        centerOk: owns(at),
        centerAt: at ? describeEl(at) : null,
        topOk: owns(atTop),
        topAt: atTop ? describeEl(atTop) : null,
      })
    }
    return out
  }

  var hitReported = false
  function reportHitTargets() {
    if (hitReported) return
    hitReported = true
    reportDiag('hit-test')
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
    if (state.extrasVisible) requestExtras()
    // 面板刚挂载时量一次命中区域（诊断用，每个页面生命周期只报一次）
    try {
      setTimeout(reportHitTargets, 800)
    } catch (err) { /* 忽略 */ }
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

  /**
   * 取「走势 + 要闻」。与行情完全解耦：
   * - 失败只写 state.extras.error，不动行情卡片；
   * - 只在显隐打开、手动刷新时抓，切换本周/本月不重新请求。
   */
  function requestExtras() {
    if (!state.extrasVisible) return Promise.resolve()
    if (typeof fetch !== 'function') return Promise.resolve()
    if (state.extrasLoading) return Promise.resolve()

    state.extrasLoading = true
    var token = ++state.extrasToken
    state.extras = {
      status: state.extras.data ? 'refreshing' : 'loading',
      data: state.extras.data,
      error: null,
      at: state.extras.at,
    }
    updatePanel()

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
    var timer = null
    try {
      timer = setTimeout(function () {
        if (controller) {
          try {
            controller.abort()
          } catch (err) { /* 忽略 */ }
        }
      }, EXTRAS_TIMEOUT_MS)
    } catch (err) {
      timer = null
    }

    function settle() {
      if (timer) clearTimeout(timer)
      timer = null
      state.extrasLoading = false
    }

    return fetch(EXTRAS_API, init)
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null
          try {
            data = JSON.parse(text)
          } catch (err) {
            data = null
          }
          if (!res.ok) {
            throw new Error(data && data.error ? String(data.error) : '扩展接口返回 HTTP ' + res.status)
          }
          if (!data) throw new Error('扩展接口返回的不是 JSON')
          return data
        })
      })
      .then(
        function (data) {
          settle()
          if (token !== state.extrasToken) return
          state.extras = { status: 'ok', data: data, error: null, at: Date.now() }
          updatePanel()
        },
        function (err) {
          settle()
          if (token !== state.extrasToken) return
          state.extras = {
            status: 'error',
            data: state.extras.data, // 失败保留上次内容
            error: String(err && err.message ? err.message : err),
            at: Date.now(),
          }
          updatePanel()
        }
      )
  }

  function setExtrasVisible(on) {
    state.extrasVisible = !!on
    writeExtrasPref(state.extrasVisible)
    var panel = refs.panel
    if (panel) {
      setAttr(panel.root, 'data-extras', state.extrasVisible ? '1' : '0')
      if (panel.extrasBtn) {
        setAttr(panel.extrasBtn, 'aria-pressed', state.extrasVisible ? 'true' : 'false')
        setAttr(panel.extrasBtn, 'title', state.extrasVisible ? '隐藏走势与要闻' : '显示走势与要闻')
      }
    }
    updateDom()
    positionPanel()
    if (state.extrasVisible) requestExtras()
  }

  function toggleExtras() {
    setExtrasVisible(!state.extrasVisible)
  }

  /** 本周 ⇄ 本月：数据已在 Host 一次算好，这里只改本地状态重渲染。 */
  function toggleRange() {
    state.range = state.range === 'week' ? 'month' : 'week'
    updatePanel()
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
      // 手动刷新连右侧一起刷；自动轮询只刷行情（资讯每天更新、走势 Host 缓存 30 分钟）
      if (opts.manual && state.extrasVisible) requestExtras()
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
        titlebarInset: titlebarInset(),
        hits: hitTargetsReport(),
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
    // 用户上次是否展开了「走势 / 要闻」列（存 localStorage）
    state.extrasVisible = readExtrasPref()
    // 积存金持仓记录（本地）
    state.positions = readPositions()

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
    // 右侧扩展列
    chartSvg: chartSvg,
    chartCardHtml: chartCardHtml,
    newsCardHtml: newsCardHtml,
    newsItemHtml: newsItemHtml,
    sideHtml: sideHtml,
    rangeButtonHtml: rangeButtonHtml,
    changePillHtml: changePillHtml,
    newsDateText: newsDateText,
    safeUrl: safeUrl,
    // 布局/交互（自测可直接调）
    detectSidebar: detectSidebar,
    ensure: ensure,
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
    refresh: function () { load({ manual: true }) },
    toggleExtras: toggleExtras,
    setExtrasVisible: setExtrasVisible,
    toggleRange: toggleRange,
    titlebarInset: titlebarInset,
    hitTargetsReport: hitTargetsReport,
    // 积存金持仓
    positionCardHtml: positionCardHtml,
    positionSummary: positionsSummary,
    channelRedeem: channelRedeem,
    channelBuyPrice: channelBuyPrice,
    addPosition: addPosition,
    submitPosition: submitPosition,
    removePosition: removePosition,
    readPositions: readPositions,
    setPosDraft: function (patch) {
      state.posDraft = Object.assign({ channel: 'icbc', grams: '', price: '' }, state.posDraft || {}, patch || {})
      return state.posDraft
    },
  }

  window.__dshGoldCardPanel = publicApi
  window.__dshGoldPanel = publicApi

  start()
})()








