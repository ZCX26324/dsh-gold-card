/**
 * lib/sge.cjs —— 上海黄金交易所 Au99.99 数据源（零依赖，含昨收 -> 涨跌幅）
 *
 * 实测可用的三个公开接口：
 *   A. https://www.sge.com.cn/graph/quotations      -> 当日分时序列 JSON（主源，自带 delaystr 时间戳）
 *      最新价 = data 中最后一个有效值，不是 data[0]
 *   B. https://www.sge.com.cn/sjzx/yshqbg          -> 延时行情 HTML（交叉校验源）
 *      行: ['Au99.99','868.6','887.0','866.14','887.0']  合约|最新价|最高价|最低价|今开盘
 *   C. https://www.sge.com.cn/sjzx/quotation_daily_new?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 *      -> 历史日行情 HTML，取「上一交易日收盘价」算真实涨跌幅（往前回溯最多 10 天）
 *
 * 交叉校验（提示词 v3 第 5.5 节）：接口 A(JSON) vs 接口 B(HTML)，容差 1.0 元/克。
 *
 * 域名容错（实测 2026-11-06）：上金所 www 域名经常被 WAF 拦截（HTTP 403
 * "您的访问请求可能对网站造成安全威胁"），而**去掉 www 的 apex 域名同样可用**。
 * 因此所有上金所请求都带 host 回退：主域失败自动切 apex，并记住可用域名。
 */

'use strict'

const {
  getText,
  sourceError,
  classifyError,
  ERROR_KIND,
} = require('./sources.cjs')

const SGE_HOSTS = ['https://www.sge.com.cn', 'https://sge.com.cn']
const SGE_JSON_PATH = '/graph/quotations'
const SGE_HTML_PATH = '/sjzx/yshqbg'
const SGE_DAILY_PATH = '/sjzx/quotation_daily_new'

/** 当前优先使用的上金所域名（被 WAF 拦截后自动切到另一个并记住） */
let sgeHostIndex = 0

/** 带上金所 host 回退的 GET：主域失败自动切备用域名。 */
async function sgeGetText(pathAndQuery, opts = {}) {
  let firstError = null
  for (let attempt = 0; attempt < SGE_HOSTS.length; attempt++) {
    const index = (sgeHostIndex + attempt) % SGE_HOSTS.length
    const host = SGE_HOSTS[index]
    try {
      const text = await getText(host + pathAndQuery, opts)
      if (attempt > 0) sgeHostIndex = index // 记住可用域名，后续优先使用
      return text
    } catch (err) {
      if (!firstError) firstError = err
    }
  }
  const info = classifyError(firstError)
  throw sourceError(
    info.kind,
    `上金所 ${pathAndQuery} 两个域名均不可用（${info.text}）`,
    info.code || undefined
  )
}

const BEIJING_OFFSET_MS = 8 * 3600 * 1000

function parseRows(html) {
  const rows = []
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let m
  while ((m = trRe.exec(html))) {
    const tds = []
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
    let t
    while ((t = tdRe.exec(m[1]))) {
      tds.push(
        t[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .trim()
      )
    }
    if (tds.length) rows.push(tds)
  }
  return rows
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 解析接口 B：延时行情 HTML */
function parseDelayHtml(html) {
  const rows = parseRows(html)
  const au = rows.find((r) => r[0] === 'Au99.99')
  if (!au) throw sourceError(ERROR_KIND.STRUCT, '页面结构变更：上金所延时行情未找到 Au99.99 行')
  const out = { last: num(au[1]), high: num(au[2]), low: num(au[3]), open: num(au[4]) }
  if (out.last === null) throw sourceError(ERROR_KIND.STRUCT, '页面结构变更：上金所延时行情最新价非数字')
  return out
}

/**
 * 解析接口 A：分时 JSON
 *
 * 实测陷阱（2026-11-07）：
 *   1. `json.min/max` 与 `data` 序列不一致（json 865/873，序列 865~873.96）。
 *      高低价一律由序列自己算，保证「最低 ≤ 最新 ≤ 最高」自洽。
 *   2. **未发生的时段是占位值**：`times` 覆盖 20:00~次日 15:30，数据源把还没走到的
 *      时点用同一个值填满（实测日盘 391 个点全是 863）。直接取最后一个有效值会拿到占位值。
 *   3. **不能只靠墙钟 `now` 判断**：2026-11-07 是周六，但 15:07 落在「日盘时间窗」内，
 *      若只用 now 定位，就会把周一的日盘占位值当成已发生时点（取到 863）。
 *      实测此时 delaystr 仍停在 `11月09日 02:29:54`，说明日盘并没有在跑。
 *
 * 处理顺序：
 *   a. 先截掉「连续 ≥20 个相同值」的占位尾段（真实行情不可能 20 分钟一分不动）；
 *   b. 再在截断后的范围内，用 `now` 定位「最后一个已走到的时点」，排除未来时点；
 *   c. 高低/开盘只用保留下来的点计算。
 *
 * 交易日时间轴（20:00 起算分钟数）：20:00→0、23:59→239、00:00→240、02:30→390、
 *   09:00→780、15:30→1170。`now` 落在 02:31~08:59 的空档时，最后一个已走时点就是 02:30。
 */
const PLACEHOLDER_RUN = 20

/** 截掉「连续重复值」的尾段（占位填充），返回保留长度 */
function cutPlaceholderTail(values) {
  const n = values.length
  if (!n) return 0
  let i = n - 1
  while (i > 0 && values[i] === values[i - 1]) i -= 1
  const runLen = n - i
  if (runLen < PLACEHOLDER_RUN) return n
  return i
}

function parseQuotations(json) {
  if (!json || json.heyue !== 'Au99.99') {
    throw sourceError(ERROR_KIND.STRUCT, '页面结构变更：上金所分时接口品种不符(' + (json && json.heyue) + ')')
  }
  const raw = Array.isArray(json.data) ? json.data : []
  const times = Array.isArray(json.times) ? json.times : []
  const values = raw.map(Number)
  const valid = values.filter((n) => Number.isFinite(n) && n > 0)
  if (!valid.length) throw sourceError(ERROR_KIND.API, '接口返回失败：上金所分时数据为空')

  const toMin = (t) => {
    const parts = String(t || '').split(':').map(Number)
    const h = parts[0]
    const m = parts[1]
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null
    return h >= 20 ? (h - 20) * 60 + m : (h + 4) * 60 + m
  }

  // a. 截掉占位尾段（至少保留 1 个点）
  const cut = cutPlaceholderTail(values)
  const keepLen = cut > 0 ? cut : values.length
  const placeholderCut = values.length - keepLen

  // b. 用源站墙钟在「保留范围内」定位最后一个已走过的时点
  const nowMin = json.now ? toMin(json.now) : null
  let lastIdx = keepLen - 1
  if (nowMin !== null) {
    let found = -1
    for (let i = 0; i < keepLen; i += 1) {
      const tm = toMin(times[i])
      if (tm !== null && tm <= nowMin) found = i
    }
    if (found >= 0) lastIdx = found
  }

  const usable = []
  for (let i = 0; i <= lastIdx; i += 1) {
    const value = values[i]
    if (Number.isFinite(value) && value > 0) usable.push({ i: i, value: value })
  }
  if (!usable.length) {
    const idx = values.findIndex((n) => Number.isFinite(n) && n > 0)
    usable.push({ i: idx, value: values[idx] })
  }
  const lastPoint = usable[usable.length - 1]
  const last = lastPoint.value

  const jsonMin = Number.isFinite(Number(json.min)) ? Number(json.min) : null
  const jsonMax = Number.isFinite(Number(json.max)) ? Number(json.max) : null

  return {
    last,
    high: +Math.max.apply(null, usable.map((p) => p.value)).toFixed(2),
    low: +Math.min.apply(null, usable.map((p) => p.value)).toFixed(2),
    open: +usable[0].value.toFixed(2),
    quoteTime: json.delaystr || null,
    lastTime: times[lastPoint.i] || null,
    now: json.now || null,
    points: valid.length,
    // elapsed = 已按墙钟收敛到时点；all = 拿不到 now，退回「截断后全序列」
    dataMode: nowMin !== null ? 'elapsed' : 'all',
    elapsedPoints: usable.length,
    // 被判定为占位填充而丢弃的点数（供排查）
    placeholderCut,
    // 记录源里自报的高低（仅供排查），卡片展示用序列算出来的值
    sourceRange: { min: jsonMin, max: jsonMax },
    sourceRangeSane: jsonMin === null || jsonMax === null ? null : last >= jsonMin && last <= jsonMax,
  }
}

/** 解析日行情 HTML，取指定日期某合约的收盘价与涨跌幅 */
function parseDailyHtml(html, date, symbol) {
  const rows = parseRows(html)
  for (const r of rows) {
    if (r.length >= 9 && r[1] === date && r[2] === symbol) {
      return {
        date: r[1],
        symbol: r[2],
        open: num(r[3]),
        high: num(r[4]),
        low: num(r[5]),
        close: num(r[6]),
        change: num(r[7]),
        changePct: r[8],
      }
    }
  }
  return null
}

function ymdUTC(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** 北京时间的「N 天前」日期字符串（避免宿主时区不同导致日期错位） */
function beijingDateStr(daysAgo) {
  const shifted = new Date(Date.now() + BEIJING_OFFSET_MS)
  const base = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  return ymdUTC(new Date(base - daysAgo * 86400000))
}

/** 北京时间的星期几（0=周日） */
function beijingWeekday(daysAgo) {
  const shifted = new Date(Date.now() + BEIJING_OFFSET_MS)
  const base = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  return new Date(base - daysAgo * 86400000).getUTCDay()
}

async function fetchQuotationsJson() {
  const txt = await sgeGetText(SGE_JSON_PATH, { timeout: 10000 })
  let json
  try {
    json = JSON.parse(txt)
  } catch (err) {
    throw sourceError(ERROR_KIND.STRUCT, '页面结构变更：上金所分时接口返回非 JSON')
  }
  return parseQuotations(json)
}

async function fetchDelayHtml() {
  const html = await sgeGetText(SGE_HTML_PATH, { timeout: 12000 })
  return parseDelayHtml(html)
}

/**
 * 取最近一个「有数据」的交易日（往前最多 10 天，跳过周末不发请求）。
 * 该接口近期可能维护，失败时由调用方降级为「涨跌幅 —」。
 *
 * startOffset 决定从「几天前」开始回溯：
 *   1 = 上一交易日（日盘 / 凌晨夜盘用）
 *   0 = 当天收盘（当天 20:00 之后的夜盘用，夜盘归属下一交易日，
 *       昨收就是当天日盘收盘价，不能跳过去取更早的一天）
 */
async function fetchPrevDaily(symbol = 'Au99.99', maxLookback = 10, startOffset = 1) {
  const errors = []
  const from = Number.isInteger(startOffset) && startOffset >= 0 ? startOffset : 1
  for (let i = from; i < from + maxLookback; i++) {
    const wd = beijingWeekday(i)
    if (wd === 0 || wd === 6) continue // 周末无行情，不浪费请求
    const ds = beijingDateStr(i)
    const url = `${SGE_DAILY_PATH}?start_date=${ds}&end_date=${ds}`
    let html
    try {
      html = await sgeGetText(url, { timeout: 12000 })
    } catch (err) {
      errors.push(classifyError(err).text)
      continue
    }
    const rec = parseDailyHtml(html, ds, symbol)
    if (rec && rec.close !== null && rec.close > 0) return rec
  }
  if (errors.length) throw sourceError(ERROR_KIND.API, `接口返回失败：近 10 日无上金所日行情（${errors[0]}）`)
  throw sourceError(ERROR_KIND.API, '接口返回失败：近 10 日无上金所日行情数据')
}

/**
 * 完整上金所数据：接口 A（主源）+ 接口 B（交叉校验）+ 接口 C（昨收 -> 涨跌幅）。
 * 四个源并发抓取时本函数整体只占一个并发位，内部 A/B 并行。
 */
async function fetchSgeFull() {
  const [aRes, bRes] = await Promise.allSettled([fetchQuotationsJson(), fetchDelayHtml()])
  const A = aRes.status === 'fulfilled' ? aRes.value : null
  const B = bRes.status === 'fulfilled' ? bRes.value : null

  if (!A && !B) {
    const aErr = classifyError(aRes.reason)
    const bErr = classifyError(bRes.reason)
    throw sourceError(
      aErr.kind,
      `接口A：${aErr.text}；接口B：${bErr.text}`,
      aErr.code || undefined
    )
  }

  const primary = A || B
  const cross = {
    tolerance: 1.0,
    aAvailable: !!A,
    bAvailable: !!B,
    aLast: A ? A.last : null,
    bLast: B ? B.last : null,
    diff: null,
    verified: null,
  }
  if (A && B && typeof A.last === 'number' && typeof B.last === 'number') {
    cross.diff = +Math.abs(A.last - B.last).toFixed(2)
    cross.verified = cross.diff <= cross.tolerance
    if (!cross.verified) {
      // 接口 A 是分时序列（含夜盘 20:00~次日 02:30，带 delaystr 交易时段标签）；
      // 接口 B 是「延时行情」表，通常只反映日盘。两接口时段口径不同，差值不是「陈旧」。
      // 以带时间戳的 A 为准，并把口径差异写清楚（否则周末/夜盘后会被误标成陈旧快照）。
      cross.sessionMismatch = true
      cross.aQuoteTime = A.quoteTime || null
      cross.aLastTime = A.lastTime || null
      cross.bLastTime = B.lastTime || null
    }
  }

  // 交易时段：上金所延时行情时间戳以「所属交易日」标注，夜盘（20:00~次日 02:30）
  // 的时间戳会落在下一个交易日。卡片上标出来，避免用户拿日盘报价对照时误以为价格错了。
  let session = null
  let sessionHour = null
  const clock = /(\d{1,2}):(\d{2})/.exec(String((primary && primary.quoteTime) || ''))
  if (clock) {
    sessionHour = Number(clock[1])
    session = sessionHour >= 20 || sessionHour <= 3 ? '夜盘' : '日盘'
  }

  // 昨收（用于涨跌幅）：失败不影响最新价。
  // 20:00 之后开始的夜盘属于「下一交易日」，昨收 = 当天日盘收盘（offset 0），
  // 若跳过当天会取到更早一天、把涨跌幅算错；凌晨 00:00~02:30 与日盘仍取上一交易日。
  const prevOffset = session === '夜盘' && sessionHour !== null && sessionHour >= 20 ? 0 : 1
  let prev = null
  let prevError = null
  try {
    prev = await fetchPrevDaily('Au99.99', 10, prevOffset)
  } catch (err) {
    prevError = classifyError(err).text
  }

  const out = {
    symbol: 'Au99.99',
    last: primary.last,
    high: primary.high !== undefined ? primary.high : null,
    low: primary.low !== undefined ? primary.low : null,
    open: primary.open !== undefined ? primary.open : null,
    quoteTime: A ? A.quoteTime : null, // 只有接口 A 自带 delaystr 时间戳
    session,
    lastTime: A ? A.lastTime || null : null,
    sourceRange: A ? A.sourceRange || null : null,
    sourceRangeSane: A ? A.sourceRangeSane : null,
    source: '上海黄金交易所官网',
    cross,
    points: A ? A.points : null,
  }
  if (prev && typeof prev.close === 'number') {
    out.prevClose = prev.close
    out.prevCloseDate = prev.date
    if (typeof out.last === 'number') {
      out.change = +(out.last - prev.close).toFixed(2)
      out.changePct = +(((out.last - prev.close) / prev.close) * 100).toFixed(2)
    }
  }
  if (prevError) out.prevCloseError = prevError
  return out
}

/**
 * 逐日抓取最近 N 个交易日收盘价（升序）。
 *
 * 为什么不用一次区间查询：`quotation_daily_new?start_date=A&end_date=B` 实测
 * 无论区间多大都只回最近约 2 个交易日（21 行里 Au99.99 只有 2 行），
 * 拿不到完整区间，只能按天请求。这里只在走势主源（东方财富）失败时作为兜底，
 * 结果由调用方缓存 6 小时，正常路径不会走到。
 *
 * @param {string} symbol
 * @param {number} days 需要的交易日数量（最多回溯 60 个自然日）
 */
async function fetchDailyHistory(symbol = 'Au99.99', days = 22) {
  const want = Math.max(2, Math.min(60, Number(days) || 22))
  const rows = []
  for (let i = 0; i <= 60 && rows.length < want; i++) {
    const wd = beijingWeekday(i)
    if (wd === 0 || wd === 6) continue // 周末无行情，不浪费请求
    const ds = beijingDateStr(i)
    let html
    try {
      html = await sgeGetText(`${SGE_DAILY_PATH}?start_date=${ds}&end_date=${ds}`, { timeout: 12000 })
    } catch (err) {
      continue
    }
    const rec = parseDailyHtml(html, ds, symbol)
    if (rec && typeof rec.close === 'number' && rec.close > 0) {
      rows.push({ date: rec.date, close: rec.close })
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  if (!rows.length) throw sourceError(ERROR_KIND.API, '接口返回失败：上金所日行情无可用数据')
  return rows
}

module.exports = {
  fetchSgeFull,
  fetchPrevDaily,
  fetchDailyHistory,
  fetchQuotationsJson,
  fetchDelayHtml,
  parseDelayHtml,
  parseQuotations,
  parseDailyHtml,
}

if (require.main === module) {
  fetchSgeFull()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => console.error('FAIL:', e.message))
}
