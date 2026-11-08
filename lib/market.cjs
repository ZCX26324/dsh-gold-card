/**
 * lib/market.cjs —— 金价走势（日 K）数据层，零第三方依赖
 *
 * 主源：东方财富历史行情接口（secid=118.AU9999，上金所 Au99.99）
 *   https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=118.AU9999&klt=101&fqt=0&lmt=45
 *   返回 data.klines = ["2026-11-06,868.57,868.57,873.96,865.0,...", ...]
 *   字段顺序：date,open,close,high,low,volume,amount
 *
 * 注意两个真实数据特征（已在面板/契约里处理）：
 *   1. 夜盘的 K 线日期是「所属交易日」，可能比自然日大（周五夜盘 -> 下周一），
 *      所以统计窗口必须锚定**最后一根 K 线**，不能用「今天」。
 *   2. 东方财富偶发 socket hang up，需要 Referer + 重试一次。
 *
 * 兜底：上金所日行情逐日抓取（lib/sge.cjs fetchDailyHistory），结果缓存 6 小时；
 *       主源失败两次才会走到这里，正常路径不会触发。
 */

'use strict'

const { getText, classifyError, sourceError, ERROR_KIND } = require('./sources.cjs')
const { fetchDailyHistory } = require('./sge.cjs')

const SYMBOL = 'Au99.99'
const UNIT = '元/克'
const SOURCE = '东方财富 118.AU9999'
const KLINE_URL =
  'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
  '?secid=118.AU9999' +
  '&fields1=f1,f2,f3,f4,f5' +
  '&fields2=f51,f52,f53,f54,f55,f56,f57' +
  '&klt=101&fqt=0&end=20500101&lmt=45'

const CHART_CACHE_MS = 30 * 60 * 1000 // 走势 30 分钟缓存
const FALLBACK_CACHE_MS = 6 * 60 * 60 * 1000 // 上金所兜底 6 小时缓存
const LAST_GOOD_MS = 24 * 60 * 60 * 1000 // 失败时可回退的旧数据上限
const MONTH_MIN_POINTS = 8 // 本月窗口少于 8 个交易日时退回近 22 个交易日

let chartCache = null // { at, data }
let lastGood = null // { at, data }
let fallbackCache = null // { at, rows }

function round2(n) {
  return Math.round(n * 100) / 100
}

function ymdUTC(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** 'YYYY-MM-DD' -> UTC 毫秒（纯日期运算，不受宿主时区影响） */
function dayMs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso))
  if (!m) return NaN
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** 某日期所在自然周的周一（ISO 周，周一为一周起点） */
function mondayOf(iso) {
  const t = dayMs(iso)
  if (!Number.isFinite(t)) return iso
  const wd = new Date(t).getUTCDay() // 0=周日
  const back = (wd + 6) % 7
  return ymdUTC(new Date(t - back * 86400000))
}

/**
 * 解析东方财富 K 线 JSON -> 升序 [{date, open, close, high, low}]
 * 非法行（字段缺失/非数字/日期格式不对）直接丢弃；一根都没有则视为结构变更。
 */
function parseKlines(json) {
  const data = json && json.data
  const lines = data && Array.isArray(data.klines) ? data.klines : null
  if (!lines) throw sourceError(ERROR_KIND.STRUCT, '页面结构变更：东方财富返回缺少 data.klines')
  const rows = []
  for (const line of lines) {
    const p = String(line).split(',')
    if (p.length < 5) continue
    const date = String(p[0]).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const open = Number(p[1])
    const close = Number(p[2])
    const high = Number(p[3])
    const low = Number(p[4])
    if (![open, close, high, low].every((n) => Number.isFinite(n))) continue
    if (close <= 0) continue
    rows.push({ date, open, close, high, low })
  }
  if (!rows.length) throw sourceError(ERROR_KIND.STRUCT, '页面结构变更：东方财富无有效 K 线')
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  // 极端情况下同一日期重复：保留最后一条
  const dedup = []
  for (const row of rows) {
    if (dedup.length && dedup[dedup.length - 1].date === row.date) dedup[dedup.length - 1] = row
    else dedup.push(row)
  }
  return dedup
}

/**
 * 按「本周 / 本月」切出图表序列。
 *
 * 窗口锚定最后一根 K 线（夜盘日期可能是下一交易日）：
 *   week  = 最后一根所在自然周的交易日；不足 2 根 -> 最近 5 个交易日
 *   month = 最后一根所在自然月的交易日；不足 5 根 -> 最近 22 个交易日
 *
 * @param {Array<{date:string,close:number}>} klines 升序
 * @param {Date} [now] 仅用于说明文字（判断最后一根是否为「未来日期」）
 */
function buildRanges(klines, now) {
  const rows = Array.isArray(klines) ? klines : []
  if (!rows.length) {
    return { week: null, month: null }
  }
  const last = rows[rows.length - 1]
  const refMs = now instanceof Date ? now.getTime() : Date.now()
  const anchorNote = dayMs(last.date) > refMs + 12 * 3600 * 1000 ? '最后一根为夜盘所属交易日' : null

  function build(mode) {
    let points
    let note = null
    if (mode === 'week') {
      const monday = mondayOf(last.date)
      points = rows.filter((r) => r.date >= monday && r.date <= last.date)
      if (points.length < 2) {
        points = rows.slice(-5)
        note = '本周交易日不足，显示近 5 个交易日'
      }
    } else {
      const ym = last.date.slice(0, 7)
      points = rows.filter((r) => r.date.slice(0, 7) === ym)
      // 月初只有几根 K 线时，「本月」和「本周」会长得一模一样；
      // 少于 8 个交易日就退回近 22 个交易日，至少是一段有意义的趋势。
      if (points.length < MONTH_MIN_POINTS) {
        points = rows.slice(-22)
        note = '本月交易日不足，显示近 22 个交易日'
      }
    }
    if (!points.length) points = rows.slice(-1)
    const first = points[0]
    const end = points[points.length - 1]
    const diff = round2(end.close - first.close)
    const pct = first.close ? round2((diff / first.close) * 100) : 0
    return {
      label: mode === 'week' ? '本周' : '本月',
      points: points.map((r) => ({ date: r.date.slice(5), close: round2(r.close) })),
      change: { value: diff, pct },
      fromDate: first.date,
      toDate: end.date,
      note: [note, anchorNote].filter(Boolean).join('；') || null,
    }
  }

  return { week: build('week'), month: build('month') }
}

/** 东方财富请求：带 Referer，失败重试一次。 */
async function fetchKlineJson() {
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await getText(KLINE_URL, {
        timeout: 12000,
        headers: {
          Referer: 'https://quote.eastmoney.com/',
          Accept: '*/*',
        },
      })
      return JSON.parse(text)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr || sourceError(ERROR_KIND.API, '接口返回失败：东方财富 K 线请求失败')
}

/** 上金所兜底：逐日抓最近 22 个交易日（带 6 小时缓存）。 */
async function fetchFallbackKlines() {
  if (fallbackCache && Date.now() - fallbackCache.at < FALLBACK_CACHE_MS) return fallbackCache.rows
  const rows = await fetchDailyHistory(SYMBOL, 22)
  fallbackCache = { at: Date.now(), rows }
  return rows
}

function makeChartData(klines, now, extra) {
  const base = {
    ok: true,
    stale: false,
    error: null,
    symbol: SYMBOL,
    unit: UNIT,
    source: extra && extra.source ? extra.source : SOURCE,
    updatedAt: new Date().toISOString(),
    ranges: buildRanges(klines, now),
    bars: klines.length,
    fallback: false,
    note: null,
  }
  return Object.assign(base, extra || {})
}

/**
 * 取走势数据（含缓存/回退/兜底）。
 * @param {{fetchKlines?:Function, fetchFallback?:Function, now?:Date}} [options] 测试注入
 */
async function fetchChart(options) {
  const opts = options || {}
  const now = opts.now instanceof Date ? opts.now : new Date()

  if (chartCache && Date.now() - chartCache.at < CHART_CACHE_MS) {
    return chartCache.data
  }

  let data
  try {
    const json = opts.fetchKlines ? await opts.fetchKlines() : await fetchKlineJson()
    data = makeChartData(parseKlines(json), now)
  } catch (err) {
    const detail = classifyError(err).text
    // 1) 最近 24h 内成功过：用旧数据，标记 stale
    if (lastGood && Date.now() - lastGood.at < LAST_GOOD_MS) {
      data = Object.assign({}, lastGood.data, { stale: true, error: detail })
    } else {
      // 2) 没有旧数据：上金所日行情兜底
      try {
        const rows = opts.fetchFallback ? await opts.fetchFallback() : await fetchFallbackKlines()
        data = makeChartData(rows, now, {
          source: '上海黄金交易所日行情',
          fallback: true,
          // 兜底数据来自交易所官方日行情，是「已收盘交易日」的真实收盘价，
          // 不是过期缓存，所以不标 stale；只在说明里注明口径。
          stale: false,
          error: null,
          note: '主源不可用，已用上金所日行情（仅已收盘交易日）',
        })
      } catch (err2) {
        data = {
          ok: false,
          stale: false,
          error: detail + '；上金所兜底：' + classifyError(err2).text,
          symbol: SYMBOL,
          unit: UNIT,
          source: SOURCE,
          updatedAt: null,
          ranges: null,
          bars: 0,
        }
      }
    }
  }

  if (data.ok) {
    const at = Date.now()
    chartCache = { at, data }
    lastGood = { at, data }
  }
  return data
}

function resetCache() {
  chartCache = null
  lastGood = null
  fallbackCache = null
}

module.exports = {
  SYMBOL,
  UNIT,
  SOURCE,
  KLINE_URL,
  CHART_CACHE_MS,
  parseKlines,
  buildRanges,
  fetchChart,
  fetchKlineJson,
  resetCache,
}
