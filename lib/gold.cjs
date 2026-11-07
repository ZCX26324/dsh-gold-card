/**
 * lib/gold.cjs —— 四源聚合 + 缓存 + 交叉校验 + 时效校验 + 双重反算溢价（DSH 插件用）
 *
 * 设计要点（全部来自 2026-11-06 实测 + 提示词 v3 第五/六节）：
 *   1. 零第三方依赖，只用 node 内置模块
 *   2. 60 秒缓存；请求失败回退过期值并标注 stale / staleSince / error
 *   3. 同源并发去重：共享同一个进行中的 Promise
 *   4. 四源 Promise.allSettled 并发，单源失败不影响其它卡片
 *   5. 错误归一：请求超时 / 连接被拒 / 页面结构变更 / 接口返回失败 / TLS 协商失败
 *   6. 交叉校验：上金所 A vs B（1.0 元/克）、新浪 vs 建行 Acrs_Spot（3 美元/盎司）、
 *      工行 A00622 vs A00505 赎回价（3 元/克）、建行用国际金价反算隐含溢价带
 *   7. 时效校验：只用各源自带时间戳，绝不用本地抓取时刻冒充
 *   8. 溢价带按标的类型：账户型 [-5,10] / 实物金条 [15,25]
 *   9. 双重反算：昨收基准 vs 当前 Au99.99；按旧基准定价的陈旧快照 -> crossCheck=stale
 *  10. 变化检测：连续两次数值完全一致而同期 Au99.99 有变动 -> 标记陈旧
 */
'use strict'

const { fetchSgeFull } = require('./sge.cjs')
const {
  fetchIntlGold,
  fetchIntlGoldSina,
  fetchIcbc,
  fetchCcbPrice,
  classifyError,
} = require('./sources.cjs')

const CACHE_TTL_MS = 60 * 1000
const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/** 缓存：key -> { data, fetchedAt, ts, error } */
const cache = new Map()
/** 进行中的请求：key -> Promise（用于同源并发去重） */
const inflight = new Map()

/**
 * 带缓存的取数：
 *   - 60s 内直接命中
 *   - 同源并发共享同一个 Promise
 *   - 失败时优先回退上一次成功数据，并带 stale + staleSince + error
 */
async function cached(key, fn, ttl = CACHE_TTL_MS) {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.ts < ttl) {
    if (hit.error) {
      return {
        ...hit.data,
        stale: true,
        staleSince: hit.fetchedAt,
        error: hit.error,
        fetchedAt: hit.fetchedAt,
      }
    }
    return { ...hit.data, stale: false, error: null, fetchedAt: hit.fetchedAt }
  }
  // 同源并发去重
  if (inflight.has(key)) return inflight.get(key)

  const p = (async () => {
    try {
      const data = await fn()
      const rec = { data, fetchedAt: new Date().toISOString(), ts: Date.now(), error: null }
      cache.set(key, rec)
      return { ...data, stale: false, error: null, fetchedAt: rec.fetchedAt }
    } catch (err) {
      const message = classifyError(err).text
      // 失败回退：优先过期缓存，其次空白（金融看板宁可显示旧值也不要空卡片）
      if (hit && !hit.error) {
        return {
          ...hit.data,
          stale: true,
          staleSince: hit.fetchedAt,
          error: message,
          fetchedAt: hit.fetchedAt,
        }
      }
      const rec = { data: {}, fetchedAt: new Date().toISOString(), ts: Date.now(), error: message }
      cache.set(key, rec)
      return { ...rec.data, stale: true, error: message, fetchedAt: rec.fetchedAt }
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, p)
  return p
}

// ---------------------------------------------------------------------------
// 时间与时效
// ---------------------------------------------------------------------------

function padMs(frac) {
  if (!frac) return 0
  return Number(String(frac).padEnd(3, '0').slice(0, 3))
}

/**
 * 解析各源时间戳（一律按北京时间 UTC+8 解释，避免宿主时区不同导致误判）：
 *   - 上金所 delaystr : "2026年11月06日 15:45:00"
 *   - 新浪 quoteTime  : "2026-11-06 16:16:00"
 *   - 工行 sysdate    : "2026-11-06 16:16:24"
 *   - 建行 Tms        : "2026-11-06 16:16:23.489"
 *   - gold-api 兜底   : ISO8601 "2026-11-06T08:15:04Z"
 */
function parseSourceTime(value) {
  if (!value) return null
  const s = String(value).trim()
  if (!s) return null

  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(s)
  if (iso) {
    const dt = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +iso[6], padMs(iso[7])))
    return Number.isNaN(dt.getTime()) ? null : dt
  }

  // 兼容 "2026年11月06日 15:45:00" / "2026-11-06 16:16:23.489"（日期与时间之间可有/无空格）
  const m = /(\d{4})\s*[年\-\/]\s*(\d{1,2})\s*[月\-\/]\s*(\d{1,2})\s*日?(?:\s*[ T]?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?/.exec(s)
  if (!m) return null
  const y = +m[1]
  const mo = +m[2]
  const d = +m[3]
  const h = +(m[4] || 0)
  const mi = +(m[5] || 0)
  const se = +(m[6] || 0)
  const ms = padMs(m[7])
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se, ms) - BEIJING_OFFSET_MS)
  return Number.isNaN(dt.getTime()) ? null : dt
}

function beijingClock(nowMs) {
  const d = new Date(nowMs + BEIJING_OFFSET_MS)
  return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() }
}

/**
 * 是否处于「本应持续报价」的交易时段（北京时间）。
 * 时效校验只在交易时段内才把 >6h 的旧时间戳判为「非实时报价」。
 */
const TRADING_SESSIONS = {
  // 上金所：周一至周五日盘 08:30-15:45、夜盘 20:00 起；周二至周六凌晨 02:30 前为前日夜盘延续
  sge(day, minutes) {
    const weekday = day >= 1 && day <= 5
    const daySession = weekday && minutes >= 8 * 60 + 30 && minutes <= 15 * 60 + 45
    const nightSession = weekday && minutes >= 20 * 60
    const earlyMorning = day >= 2 && day <= 6 && minutes <= 2 * 60 + 30
    return daySession || nightSession || earlyMorning
  },
  // 国际现货金：周一 06:00 至周六 05:00（北京时间）连续交易
  intl(day, minutes) {
    if (day === 0) return false
    if (day === 6) return minutes <= 5 * 60
    if (day === 1) return minutes >= 6 * 60
    return true
  },
  // 银行积存金：周一至周五 08:00-23:00（放宽窗口，避免把正常报价误判为陈旧）
  bank(day, minutes) {
    return day >= 1 && day <= 5 && minutes >= 8 * 60 && minutes <= 23 * 60
  },
}

function isTradingSession(session, nowMs) {
  const checker = TRADING_SESSIONS[session] || TRADING_SESSIONS.bank
  const clock = beijingClock(nowMs)
  return checker(clock.day, clock.minutes)
}

/**
 * freshness 计算（只用源自带时间戳，禁止用本地抓取时刻冒充）：
 *   - 缓存回退 / 数据源不可用 -> fresh=false
 *   - 源时间戳距当前 > 6 小时且处于交易时段 -> fresh=false、note="非实时报价"
 */
function computeFreshness({ ok, quoteTime, stale, staleSince, session }, nowMs) {
  if (ok === false) return { fresh: false, ageMinutes: null, note: '数据源不可用' }
  const dt = parseSourceTime(quoteTime)
  const ageMinutes = dt ? Math.max(0, Math.floor((nowMs - dt.getTime()) / 60000)) : null
  if (stale) {
    return {
      fresh: false,
      ageMinutes,
      note: `数据可能滞后（上次更新 ${staleSince || quoteTime || '未知'}）`,
    }
  }
  if (ageMinutes === null) {
    return { fresh: true, ageMinutes: null, note: '源未提供可解析时间戳，未做时效校验' }
  }
  if (ageMinutes > 360 && isTradingSession(session, nowMs)) {
    return { fresh: false, ageMinutes, note: '非实时报价' }
  }
  return { fresh: true, ageMinutes, note: null }
}

// ---------------------------------------------------------------------------
// 溢价与双重反算
// ---------------------------------------------------------------------------

/**
 * 溢价带（v3 修正：必须按标的类型区分）
 *   账户型积存金跟随现货 -> 约 -5 ~ +10
 *   实物金条（如意金）  -> 约 15 ~ 25
 */
const PREMIUM_BANDS = {
  account: { min: -5, max: 10, label: '账户型积存金' },
  bar: { min: 15, max: 25, label: '实物金条' },
}

const fmtNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—')

function premiumOf(price, base) {
  if (typeof price !== 'number' || typeof base !== 'number') return null
  return +(price - base).toFixed(2)
}

/** 单基准溢价校验（保留旧签名） */
function checkPremium(price, base, kind) {
  const band = PREMIUM_BANDS[kind]
  const p = premiumOf(price, base)
  if (p === null) return null
  const ok = p >= band.min && p <= band.max
  return { premium: p, band, ok, note: ok ? null : `${band.label}溢价越界（期望 ${band.min}~${band.max}）` }
}

/**
 * 双重反算（提示词 v3 五.2）：
 *   分别用「来源基准 = 上一交易日收盘/昨收」与「当前现价 Au99.99」反算溢价。
 *   - 两个基准都落带内 -> 正常
 *   - 当前基准越界、而昨收基准落带内 -> 按旧基准定价的陈旧快照（stale）
 *   - 当前基准落带内、昨收基准越界 -> 正常（现价已随现货移动，属预期）
 *   - 两个都越界 -> 溢价本身异常（不判 stale，避免把正常行情误判）
 *
 * 注：之所以不是「只要一处越界就判 stale」，是因为标的的溢价带是相对现价定义的；
 *     当日内金价波动超过计价带宽度时，按昨收反算必然越界，但那是正常的新报价。
 *     只有「旧基准能解释报价、现价不能解释报价」才说明报价还停在旧基准上。
 */
function checkPremiumDouble(price, baseNow, basePrev, kind) {
  if (typeof price !== 'number' || !Number.isFinite(price)) return null
  const band = PREMIUM_BANDS[kind]
  const now = typeof baseNow === 'number' ? checkPremium(price, baseNow, kind) : null
  const prev = typeof basePrev === 'number' ? checkPremium(price, basePrev, kind) : null
  const checks = {
    current: now ? { base: baseNow, baseLabel: '当前 Au99.99', premium: now.premium, inBand: now.ok } : null,
    previous: prev ? { base: basePrev, baseLabel: '上一交易日收盘', premium: prev.premium, inBand: prev.ok } : null,
  }

  if (!now && !prev) {
    return { premium: null, band, ok: false, note: '溢价基准（Au99.99 现价/昨收）不可用', stale: false, checks }
  }
  if (now && !prev) {
    return { premium: now.premium, band, ok: now.ok, note: now.note, stale: false, checks }
  }
  if (!now && prev) {
    return { premium: prev.premium, band, ok: prev.ok, note: prev.note, stale: false, checks }
  }

  // 两个基准都可用
  if (now.ok && prev.ok) {
    return { premium: now.premium, band, ok: true, note: null, stale: false, checks }
  }
  if (now.ok && !prev.ok) {
    // 现价口径正常：现价已随行情移动，属预期
    return { premium: now.premium, band, ok: true, note: null, stale: false, checks }
  }
  if (!now.ok && prev.ok) {
    // 只有旧基准能解释报价 -> 按旧基准定价的陈旧快照
    return {
      premium: now.premium,
      band,
      ok: false,
      stale: true,
      note:
        `按上一交易日收盘 ${fmtNum(basePrev)} 溢价 ${fmtNum(prev.premium)} 落带，` +
        `按当前 Au99.99 ${fmtNum(baseNow)} 溢价 ${fmtNum(now.premium)} 越界，` +
        '疑似按旧基准定价的陈旧快照',
      checks,
    }
  }
  return {
    premium: now.premium,
    band,
    ok: false,
    stale: false,
    note:
      `${band.label}溢价越界（期望 ${band.min}~${band.max}）：` +
      `当前基准 ${fmtNum(now.premium)}、昨收基准 ${fmtNum(prev.premium)}`,
    checks,
  }
}

// ---------------------------------------------------------------------------
// 交叉校验徽标
// ---------------------------------------------------------------------------

const CROSS_LABELS = {
  verified: '✅ 已交叉校验',
  info: 'ℹ️ 两产品价差',
  differ: '⚠️ 两源有差异',
  single: '⚠️ 仅单源',
  stale: '⚠️ 疑似陈旧快照',
}
// 差异 ≠ 陈旧：两源都在报数、只是时点/口径不同时用 differ；
// 只有「双重反算」「连续两次完全一致」这类能证明数据没更新的情形才升到 stale。
const CROSS_RANK = { verified: 0, info: 1, differ: 2, single: 3, stale: 4 }

function makeCross(level, detail) {
  const safe = CROSS_LABELS[level] ? level : 'single'
  return { level: safe, label: CROSS_LABELS[safe], detail: detail || null }
}

/** 卡片级汇总：以最差（stale > single > verified）的一个为准 */
function worstCross(list) {
  const arr = (list || []).filter((c) => c && CROSS_LABELS[c.level])
  if (!arr.length) return makeCross('single', '无可用校验源')
  return arr.reduce((worst, cur) => (CROSS_RANK[cur.level] > CROSS_RANK[worst.level] ? cur : worst))
}

/** 变化检测命中时，把交叉校验降级为 stale 并说明原因 */
function applyChange(cross, changed, label, value) {
  if (!changed) return cross
  const base = cross && cross.detail ? `；原校验：${cross.detail}` : ''
  return makeCross(
    'stale',
    `${label}连续两次抓取均为 ${fmtNum(value)} 完全一致，同期 Au99.99 有变动，疑似未刷新${base}`
  )
}

// ---------------------------------------------------------------------------
// 变化检测（进程内状态；连续两次数值完全一致而同期 Au99.99 有变动）
// ---------------------------------------------------------------------------

let previousAggregate = null

function takeAggregateSnapshot(sge, intl, icbc, ccb) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    sge: n(sge.last),
    intl: n(intl.price),
    icbc: icbc && icbc.accumulate ? n(icbc.accumulate.buy) : null,
    ruyi: icbc && icbc.ruyi ? n(icbc.ruyi.buy) : null,
    ccb: n(ccb.buy),
  }
}

function detectChanges(cur) {
  const flags = { intl: false, icbc: false, ruyi: false, ccb: false }
  const prev = previousAggregate
  if (prev && typeof cur.sge === 'number' && typeof prev.sge === 'number' && cur.sge !== prev.sge) {
    for (const key of Object.keys(flags)) {
      if (typeof cur[key] === 'number' && typeof prev[key] === 'number' && cur[key] === prev[key]) {
        flags[key] = true
      }
    }
  }
  previousAggregate = cur
  return flags
}

// ---------------------------------------------------------------------------
// 各卡片交叉校验构造
// ---------------------------------------------------------------------------

function buildSgeCross(sge) {
  if (typeof sge.last !== 'number') return makeCross('single', '上金所数据不可用，无法交叉校验')
  const c = sge.cross || {}
  if (c.aAvailable && c.bAvailable) {
    if (c.verified) {
      return makeCross(
        'verified',
        `接口A ${fmtNum(c.aLast)} vs 接口B ${fmtNum(c.bLast)}，差 ${fmtNum(c.diff)} 元/克（容差 1.0）`
      )
    }
    return makeCross(
      'differ',
      `接口A（分时，含夜盘，交易时段 ${c.aQuoteTime || '—'}）${fmtNum(c.aLast)} vs ` +
        `接口B（日盘延时行情）${fmtNum(c.bLast)}，差 ${fmtNum(c.diff)} 元/克；` +
        '两者时段口径不同，不能互相证伪，以带时间戳的接口A为准'
    )
  }
  if (c.aAvailable) return makeCross('single', '接口 B（HTML 延时行情）不可用，仅接口 A 单源')
  if (c.bAvailable) return makeCross('single', '接口 A（分时 JSON）不可用，已回退接口 B 单源')
  return makeCross('single', '上金所交叉校验源不可用')
}

function buildIntlCross(intl, ccb) {
  if (typeof intl.price !== 'number') return makeCross('single', '国际金价主源不可用')
  const buy = ccb && typeof ccb.intlBuy === 'number' ? ccb.intlBuy : null
  const sell = ccb && typeof ccb.intlSell === 'number' ? ccb.intlSell : null
  if (buy === null || sell === null) {
    return makeCross('single', '建行 Acrs_Spot 校验源不可用，仅新浪单源')
  }
  const mid = +((buy + sell) / 2).toFixed(2)
  const diff = +Math.abs(intl.price - mid).toFixed(2)
  if (diff <= 3) {
    return makeCross(
      'verified',
      `新浪 ${fmtNum(intl.price)} vs 建行国际现货中值 ${fmtNum(mid)}（买 ${fmtNum(buy)} / 卖 ${fmtNum(sell)}），` +
        `差 ${fmtNum(diff)} 美元/盎司（容差 3）`
    )
  }
  return makeCross(
    'differ',
    `新浪 ${fmtNum(intl.price)} vs 建行国际现货中值 ${fmtNum(mid)}（买 ${fmtNum(buy)} / 卖 ${fmtNum(sell)}），` +
      `差 ${fmtNum(diff)} 美元/盎司，超出容差 3（通常是两源报价时点不同，不据此判定陈旧）`
  )
}

function buildIcbcPairCross(icbc) {
  const accSell = icbc && icbc.accumulate && typeof icbc.accumulate.sell === 'number' ? icbc.accumulate.sell : null
  const ruyiSell = icbc && icbc.ruyi && typeof icbc.ruyi.sell === 'number' ? icbc.ruyi.sell : null
  if (accSell === null && ruyiSell === null) return makeCross('single', '工行两个产品接口均无数据')
  if (accSell === null) return makeCross('single', 'A00622 积存金接口不可用，仅 A00505 如意金单源')
  if (ruyiSell === null) return makeCross('single', 'A00505 如意金接口不可用，仅 A00622 积存金单源')
  const diff = +Math.abs(accSell - ruyiSell).toFixed(2)
  if (diff <= 3) {
    return makeCross(
      'verified',
      `如意金赎回价 ${fmtNum(ruyiSell)} vs 积存金赎回价 ${fmtNum(accSell)}，差 ${fmtNum(diff)} 元/克（容差 3）`
    )
  }
  return makeCross(
    'info',
    `如意金赎回价 ${fmtNum(ruyiSell)} vs 积存金赎回价 ${fmtNum(accSell)}，差 ${fmtNum(diff)} 元/克，` +
      '两个产品本身定价不同，属正常价差（同时说明两个接口都在正常返回）'
  )
}

/**
 * 建行交叉校验：用国际金价反算隐含溢价带。
 * 以「上金所 Au99.99 / 国际金价」的比例作为隐含换算系数（隐含了 USD/CNY 与盎司->克），
 * 把建行自带的 Acrs_Spot（美元/盎司）折算成人民币/克参考价，再看建行买入价的隐含溢价
 * 是否落在账户型溢价带 [-5, 10] 内。
 */
function buildCcbCross(ccb, intlPrice, sgeLast) {
  if (typeof ccb.buy !== 'number') return makeCross('single', '建行数据不可用')
  if (typeof sgeLast !== 'number') return makeCross('single', '上金所 Au99.99 基准不可用，无法反算建行隐含溢价')
  if (typeof intlPrice !== 'number' || intlPrice <= 0) {
    return makeCross('single', '国际金价不可用，无法反算建行隐含溢价带')
  }
  const factor = sgeLast / intlPrice
  const ccbIntlMid =
    typeof ccb.intlBuy === 'number' && typeof ccb.intlSell === 'number'
      ? +((ccb.intlBuy + ccb.intlSell) / 2).toFixed(2)
      : null
  const usdRef = ccbIntlMid !== null ? ccbIntlMid : intlPrice
  const refLabel =
    ccbIntlMid !== null
      ? `建行 Acrs_Spot 中值 ${fmtNum(ccbIntlMid)}`
      : `新浪国际金价 ${fmtNum(intlPrice)}`
  const expected = +(usdRef * factor).toFixed(2)
  const premium = +(ccb.buy - expected).toFixed(2)
  const band = PREMIUM_BANDS.account
  const inBand = premium >= band.min && premium <= band.max
  const detail =
    `建行买入 ${fmtNum(ccb.buy)} vs 国际金价反算 ${fmtNum(expected)}` +
    `（${refLabel} × 隐含换算 ${factor.toFixed(6)}），隐含溢价 ${premium >= 0 ? '+' : ''}${fmtNum(premium)} 元/克，` +
    `适用 ${band.label}带 [${band.min}, ${band.max}]` +
    (inBand ? '' : '，越界')
  return makeCross(inBand ? 'verified' : 'stale', detail)
}

// ---------------------------------------------------------------------------
// 卡片构造
// ---------------------------------------------------------------------------

function buildSgeCard(sge, nowMs) {
  const ok = typeof sge.last === 'number'
  const changePct = typeof sge.changePct === 'number' ? sge.changePct : null
  const fields = [
    { label: '最新价', value: ok ? sge.last : null, hero: true },
    { label: '涨跌幅', value: changePct, unit: '%', kind: 'change' },
    { label: '昨收', value: typeof sge.prevClose === 'number' ? sge.prevClose : null },
    { label: '最高', value: typeof sge.high === 'number' ? sge.high : null },
    { label: '最低', value: typeof sge.low === 'number' ? sge.low : null },
  ]
  if (changePct !== null) fields[1].tone = changePct >= 0 ? 'up' : 'down'
  return {
    id: 'sge',
    title: '上海黄金交易所 Au99.99',
    unit: '元/克',
    source: sge.source || '上海黄金交易所官网',
    ok,
    error: ok ? null : sge.error || '上金所数据不可用',
    stale: !!sge.stale,
    quoteTime: sge.quoteTime || null,
    session: sge.session || null,
    // 交易时段标签说明：上金所延时行情的时间戳按「所属交易日」标注，
    // 夜盘（20:00~次日 02:30）归属下一交易日，所以日期可能大于自然日。
    timeNote:
      sge.session === '夜盘'
        ? '夜盘归属下一交易日，时间戳为所属交易日（非自然日）'
        : null,
    freshness: computeFreshness(
      { ok, quoteTime: sge.quoteTime, stale: sge.stale, staleSince: sge.staleSince, session: 'sge' },
      nowMs
    ),
    fields,
    crossCheck: buildSgeCross(sge),
  }
}

function buildIntlCard(intl, ccb, changes, nowMs) {
  const ok = typeof intl.price === 'number'
  const changePct = typeof intl.changePct === 'number' ? intl.changePct : null
  const fields = [
    { label: '最新价', value: ok ? intl.price : null, hero: true },
    { label: '24h涨跌', value: changePct, unit: '%', kind: 'change' },
    { label: '昨收', value: typeof intl.prevClose === 'number' ? intl.prevClose : null },
    { label: '最高', value: typeof intl.high === 'number' ? intl.high : null },
    { label: '最低', value: typeof intl.low === 'number' ? intl.low : null },
  ]
  if (changePct !== null) fields[1].tone = changePct >= 0 ? 'up' : 'down'
  const quoteTime = intl.quoteTime || intl.updatedAt || null
  const card = {
    id: 'intl',
    title: '国际金价 伦敦金 XAU/USD',
    unit: '美元/盎司',
    source: intl.source || '新浪财经',
    ok,
    error: ok ? null : intl.error || '国际金价数据不可用',
    stale: !!intl.stale,
    quoteTime,
    freshness: computeFreshness(
      { ok, quoteTime, stale: intl.stale, staleSince: intl.staleSince, session: 'intl' },
      nowMs
    ),
    fields,
    crossCheck: applyChange(buildIntlCross(intl, ccb), changes.intl, '国际金价', intl.price),
  }
  if (changes.intl && ok) card.changeDetected = true
  return card
}

function buildIcbcCard(icbc, base, basePrev, changes, nowMs) {
  const acc = icbc.accumulate || null
  const ruyi = icbc.ruyi || null
  const ok = !!(acc || ruyi)
  const pairCross = buildIcbcPairCross(icbc)

  const ruyiPremium =
    ruyi && typeof ruyi.buy === 'number'
      ? checkPremiumDouble(ruyi.buy, base, basePrev, 'bar')
      : null
  const accPremium =
    acc && typeof acc.buy === 'number'
      ? checkPremiumDouble(acc.buy, base, basePrev, 'account')
      : null

  let ruyiCross = pairCross
  if (ruyiPremium && ruyiPremium.stale) ruyiCross = makeCross('stale', `双重反算：${ruyiPremium.note}`)
  ruyiCross = applyChange(ruyiCross, changes.ruyi, '如意金积存价', ruyi ? ruyi.buy : null)

  let accCross = pairCross
  if (accPremium && accPremium.stale) accCross = makeCross('stale', `双重反算：${accPremium.note}`)
  accCross = applyChange(accCross, changes.icbc, '积存金主动积存价', acc ? acc.buy : null)

  const cardCross = worstCross([pairCross, ruyiCross, accCross])
  const quoteTime =
    icbc.quoteTime || (ruyi && ruyi.quoteTime) || (acc && acc.quoteTime) || null

  const groups = [
    {
      name: '如意金积存',
      fields: [
        { label: '积存价', value: ruyi && typeof ruyi.buy === 'number' ? ruyi.buy : null, hero: true },
        { label: '赎回价', value: ruyi && typeof ruyi.sell === 'number' ? ruyi.sell : null },
      ],
      premium: ruyiPremium,
      crossCheck: ruyiCross,
    },
    {
      name: '积存金',
      fields: [
        { label: '主动积存价', value: acc && typeof acc.buy === 'number' ? acc.buy : null, hero: true },
        { label: '定期积存价', value: acc && typeof acc.reg === 'number' ? acc.reg : null },
        { label: '赎回价', value: acc && typeof acc.sell === 'number' ? acc.sell : null },
        {
          label: '最高/最低',
          value:
            acc && typeof acc.high === 'number' && typeof acc.low === 'number'
              ? `${acc.high} / ${acc.low}`
              : null,
        },
      ],
      premium: accPremium,
      crossCheck: accCross,
    },
  ]
  if (changes.ruyi) groups[0].changeDetected = true
  if (changes.icbc) groups[1].changeDetected = true

  const card = {
    id: 'icbc',
    title: '中国工商银行',
    unit: '元/克',
    source: icbc.source || '工行网银公开行情接口',
    ok,
    error: ok ? null : icbc.error || '工行数据不可用',
    stale: !!icbc.stale,
    quoteTime,
    freshness: computeFreshness(
      { ok, quoteTime, stale: icbc.stale, staleSince: icbc.staleSince, session: 'bank' },
      nowMs
    ),
    groups,
    crossCheck: cardCross,
  }
  if (changes.ruyi || changes.icbc) card.changeDetected = true
  return card
}

function buildCcbCard(ccb, intl, base, basePrev, changes, nowMs) {
  const ok = typeof ccb.buy === 'number'
  const premium = ok ? checkPremiumDouble(ccb.buy, base, basePrev, 'account') : null
  let cross = buildCcbCross(ccb, intl.price, base)
  if (premium && premium.stale) {
    cross = makeCross('stale', `双重反算：${premium.note}；${cross.detail || ''}`)
  }
  cross = applyChange(cross, changes.ccb, '建行买入价', ccb.buy)

  const card = {
    id: 'ccb',
    title: '中国建设银行',
    unit: '元/克',
    source: ccb.source || '建行积存金接口',
    ok,
    error: ok ? null : ccb.error || '建行数据不可用',
    stale: !!ccb.stale,
    quoteTime: ccb.quoteTime || null,
    freshness: computeFreshness(
      { ok, quoteTime: ccb.quoteTime, stale: ccb.stale, staleSince: ccb.staleSince, session: 'bank' },
      nowMs
    ),
    fields: [
      { label: '买入价', value: ok ? ccb.buy : null, hero: true },
      { label: '赎回价', value: typeof ccb.sell === 'number' ? ccb.sell : null },
      { label: '中间价', value: typeof ccb.mid === 'number' ? ccb.mid : null },
    ],
    premium,
    crossCheck: cross,
  }
  if (changes.ccb) card.changeDetected = true
  return card
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 拉取全部四源并做校验。
 * @param {{ttl?:number}} [opts]
 * @returns {Promise<{fetchedAt:string, baseAu9999:number|null, baseDate:string|null,
 *                    cards:object, note:string|null}>}
 */
async function fetchCards(opts = {}) {
  const ttl = Number(opts.ttl) > 0 ? Number(opts.ttl) : CACHE_TTL_MS
  const nowMs = Date.now()

  // 四源并发（Promise.allSettled：单源失败不影响其它卡片）
  const settled = await Promise.allSettled([
    cached('sge', () => fetchSgeFull(), ttl),
    cached('intl', () => fetchIntlGoldSina().catch(() => fetchIntlGold()), ttl),
    cached('icbc', () => fetchIcbc(), ttl),
    cached('ccb', () => fetchCcbPrice(), ttl),
  ])

  const pick = (index) => {
    const r = settled[index]
    if (r.status === 'fulfilled' && r.value && typeof r.value === 'object') return r.value
    const message = classifyError(r.status === 'rejected' ? r.reason : new Error('数据源未返回')).text
    return { stale: true, error: message }
  }
  const sge = pick(0)
  const intl = pick(1)
  const icbc = pick(2)
  const ccb = pick(3)

  const base = typeof sge.last === 'number' ? sge.last : null
  const basePrev = typeof sge.prevClose === 'number' ? sge.prevClose : null
  const baseDate = sge.prevCloseDate || null

  const changes = detectChanges(takeAggregateSnapshot(sge, intl, icbc, ccb))

  const cards = {
    sge: buildSgeCard(sge, nowMs),
    intl: buildIntlCard(intl, ccb, changes, nowMs),
    icbc: buildIcbcCard(icbc, base, basePrev, changes, nowMs),
    ccb: buildCcbCard(ccb, intl, base, basePrev, changes, nowMs),
  }

  // 「全部源都陈旧」时给出全局标注
  const premiumChecks = []
  for (const g of cards.icbc.groups || []) {
    if (g && g.premium) premiumChecks.push(g.premium)
  }
  if (cards.ccb.premium) premiumChecks.push(cards.ccb.premium)
  const allStale = premiumChecks.length > 0 && premiumChecks.every((p) => p.stale === true)
  const note = allStale
    ? `报价基准时间 ${baseDate || '上一交易日收盘'}，可能未反映最新行情`
    : null

  return {
    fetchedAt: new Date().toISOString(),
    baseAu9999: base,
    baseDate,
    cards,
    note,
  }
}

module.exports = {
  fetchCards,
  cached,
  checkPremium,
  checkPremiumDouble,
  PREMIUM_BANDS,
  cache,
  classifyError,
  parseSourceTime,
  computeFreshness,
  isTradingSession,
}
