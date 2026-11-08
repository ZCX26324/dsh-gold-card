/**
 * lib/news.cjs —— 黄金要闻聚合（零第三方依赖）
 *
 * 目标：右侧资讯卡只展示 3 条，官方来源优先，可点击，每天最多更新一次。
 *
 * 来源（2026-11-08 实测可用）：
 *   官方 tier 3：中国人民银行 / 国家统计局 / 上海黄金交易所公告 / 美联储 RSS
 *   媒体 tier 1：新浪财经贵金属频道
 *
 * 关键规则：
 *   1. 相关性过滤：只留黄金/美联储/通胀相关，丢掉走势分析、直播、课程、广告。
 *   2. 排序：tier 降序（官方 > 媒体）-> 话题分 -> 时效加分 -> 发布时间。
 *   3. 每天只抓一次：缓存 $DSH_HOME/dsh-gold-news.json（北京时间自然日）。
 *   4. 没有新增条目：继续返回上次的条目（不清空）；全部抓取失败：旧条目 + stale。
 *   5. 缓存写入用 tmp + rename，避免进程中断留下半个 JSON。
 */

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const { getText, classifyError } = require('./sources.cjs')

const NEWS_FILE = 'dsh-gold-news.json'
const MAX_AGE_DAYS = 7
const MAX_STORED = 60
const TOP_N = 3
const BEIJING_OFFSET_MS = 8 * 3600 * 1000
const DAY_MS = 24 * 3600 * 1000

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function stripTags(value) {
  return String(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (m, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

function cdata(value) {
  const m = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(String(value))
  return m ? m[1] : String(value)
}

function resolveUrl(base, href) {
  try {
    const u = new URL(String(href), base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    u.hash = ''
    return u.toString()
  } catch (err) {
    return ''
  }
}

function hashId(source, url) {
  return crypto
    .createHash('sha1')
    .update(String(source) + '|' + String(url))
    .digest('hex')
    .slice(0, 12)
}

/** 北京时间日期 'YYYY-MM-DD' */
function beijingDate(now) {
  const shifted = new Date((now instanceof Date ? now.getTime() : Date.now()) + BEIJING_OFFSET_MS)
  const p = (n) => String(n).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}`
}

/** 'YYYY-MM-DD' + 北京时间 09:00 -> ISO（只精确到日的来源用这个） */
function dayIso(y, m, d) {
  const t = Date.UTC(Number(y), Number(m) - 1, Number(d), 1, 0, 0)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

function makeItem(input) {
  const publishedAt = input.publishedAt || null
  return {
    id: hashId(input.source, input.url || input.title),
    title: input.title,
    url: input.url,
    source: input.source,
    sourceName: input.sourceName,
    tier: input.tier,
    category: input.category || 'gold',
    // 官方来源的「相关性」由各自解析器按语义判定（标题里不一定出现「黄金」），
    // 媒体来源仍用通用正则；排序时优先使用这个显式标记。
    relevant: typeof input.relevant === 'boolean' ? input.relevant : isRelevant(input.title),
    publishedAt,
  }
}

// ---------------------------------------------------------------------------
// 相关性 / 分类 / 噪音
// ---------------------------------------------------------------------------

const GOLD_RE = /黄金|金价|金饰|贵金属|白银|铂金|上金所|上海黄金交易所|Au99|沪金|金条|金矿/i
const POLICY_RE = /美联储|FOMC|利率|降息|加息|货币政策|央行|欧央行|日本央行|美元指数|美债收益率/i
const INFLATION_RE = /通胀|CPI|PPI|物价|消费价格|生产者价格|通货膨胀/i
const NOISE_RE =
  /走势分析|行情分析|操作建议|操作策略|交易策略|技术分析|直播|课程|广告|招聘|开户|免责声明|投资有风险|非农前瞻|喊单|带单/i

const RELEVANCE_RE = new RegExp(
  [GOLD_RE.source, POLICY_RE.source, INFLATION_RE.source].join('|'),
  'i'
)

/**
 * 官方来源的语义相关性：
 * 官方标题常常只写「召开会议」「市场价格变动」「变更企业名称」，不含「黄金」二字，
 * 用通用正则会把它们全部滤掉（实测官方条目 0 条进榜）。所以按来源分别判定。
 */
const PBC_RELEVANT_RE =
  /货币|利率|外汇|储备|黄金|金价|通胀|物价|流动性|存款准备金|再贷款|公开市场|支付系统/i
const NBS_RELEVANT_RE =
  /价格|CPI|PPI|消费|通胀|工业生产者|经济|指数|生产总值|投资|收入|就业|制造/i

function categoryOf(title) {
  if (POLICY_RE.test(title)) return 'policy'
  if (INFLATION_RE.test(title)) return 'inflation'
  return 'gold'
}

function isRelevant(title) {
  return !!title && title.length >= 6 && RELEVANCE_RE.test(title) && !NOISE_RE.test(title)
}

// ---------------------------------------------------------------------------
// 各来源解析器（纯函数，便于离线测试）
// ---------------------------------------------------------------------------

const PBC_BASE = 'https://www.pbc.gov.cn'
const PBC_URL = PBC_BASE + '/goutongjiaoliu/113456/113469/index.html'
const NBS_BASE = 'https://www.stats.gov.cn'
const NBS_URL = NBS_BASE + '/sj/zxfb/'
const SGE_BASE = 'https://www.sge.com.cn'
const SGE_URL = SGE_BASE + '/jjsnotice'
const SINA_BASE = 'https://finance.sina.com.cn'
const SINA_URL = SINA_BASE + '/nmetal/'
const FED_URL = 'https://www.federalreserve.gov/feeds/press_monetary.xml'

/** 央行「沟通交流」列表：href 内含 20261105 这样的日期 */
function parsePbcList(html) {
  const out = []
  const seen = new Set()
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(String(html || '')))) {
    const href = m[1]
    if (seen.has(href)) continue
    if (!/^\/goutongjiaoliu\/113456\/113469\//.test(href)) continue
    const dm = /\/(20\d{2})(\d{2})(\d{2})\d{0,12}\/index\.html/.exec(href)
    if (!dm) continue
    const title = stripTags(m[2])
    if (!title || title.length < 6) continue
    const url = resolveUrl(PBC_BASE, href)
    if (!url) continue
    seen.add(href)
    out.push(
      makeItem({
        source: 'pbc',
        sourceName: '中国人民银行',
        tier: 3,
        category: 'policy',
        title,
        url,
        relevant: PBC_RELEVANT_RE.test(title),
        publishedAt: dayIso(dm[1], dm[2], dm[3]),
      })
    )
  }
  return out
}

/** 统计局「数据发布」列表：href 形如 ./202611/t20261103_1965738.html */
function parseNbsList(html) {
  const out = []
  const seen = new Set()
  const re = /<a\b[^>]*href="(\.\/20\d{4}\/t20\d{6}_\d+\.html)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(String(html || '')))) {
    const href = m[1]
    if (seen.has(href)) continue
    const dm = /t(20\d{2})(\d{2})(\d{2})_/.exec(href)
    if (!dm) continue
    const title = stripTags(m[2])
    if (!title || title.length < 6) continue
    const url = resolveUrl(NBS_URL, href)
    if (!url) continue
    seen.add(href)
    out.push(
      makeItem({
        source: 'nbs',
        sourceName: '国家统计局',
        tier: 3,
        category: 'inflation',
        title,
        url,
        relevant: NBS_RELEVANT_RE.test(title),
        publishedAt: dayIso(dm[1], dm[2], dm[3]),
      })
    )
  }
  return out
}

/** 上金所公告：<a href="/jjsnotice/10007653"><span class="txt">标题</span><span class="fr">26-10-29</span></a> */
function parseSgeNotices(html) {
  const out = []
  const seen = new Set()
  const re = /<a\b[^>]*href="(\/jjsnotice\/\d+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(String(html || '')))) {
    const href = m[1]
    if (seen.has(href)) continue
    const inner = m[2]
    const tm = /<span[^>]*class="[^"]*\btxt\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(inner)
    const dm = /<span[^>]*class="[^"]*\bfr\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(inner)
    if (!tm || !dm) continue
    const title = stripTags(tm[1])
    if (!title || title.length < 6) continue
    const dateMatch = /^(\d{2})-(\d{2})-(\d{2})$/.exec(stripTags(dm[1]))
    if (!dateMatch) continue
    const url = resolveUrl(SGE_BASE, href)
    if (!url) continue
    seen.add(href)
    out.push(
      makeItem({
        source: 'sge',
        sourceName: '上海黄金交易所',
        tier: 3,
        category: 'gold',
        title,
        url,
        // 上金所公告本身就是黄金市场信息（会员资格、仓库、风险控制等），全部保留
        relevant: true,
        publishedAt: dayIso(2000 + Number(dateMatch[1]), dateMatch[2], dateMatch[3]),
      })
    )
  }
  return out
}

/** 美联储 RSS（press_monetary） */
function parseFedRss(xml) {
  const out = []
  const re = /<item>([\s\S]*?)<\/item>/gi
  const grab = (block, tag) => {
    const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i').exec(block)
    return m ? cdata(m[1]) : ''
  }
  let m
  while ((m = re.exec(String(xml || '')))) {
    const block = m[1]
    const title = stripTags(grab(block, 'title'))
    const link = stripTags(grab(block, 'link'))
    const pub = stripTags(grab(block, 'pubDate'))
    if (!title || !link) continue
    const url = resolveUrl('https://www.federalreserve.gov/', link)
    if (!url) continue
    const t = Date.parse(pub)
    out.push(
      makeItem({
        source: 'fed',
        sourceName: '美联储',
        tier: 3,
        category: 'policy',
        title,
        url,
        // press_monetary 整个 feed 都是货币政策内容（FOMC 声明、纪要、贴现率会议），
        // 英文标题不含中文关键词，全部视为相关。
        relevant: true,
        publishedAt: Number.isFinite(t) ? new Date(t).toISOString() : null,
      })
    )
  }
  return out
}

/** 新浪财经贵金属频道：href 内含 /2026-11-07/ */
function parseSinaNews(html) {
  const out = []
  const seen = new Set()
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(String(html || '')))) {
    const href = m[1]
    if (seen.has(href)) continue
    if (/video\.sina\.com\.cn/i.test(href)) continue
    const dm = /(20\d{2})-(\d{2})-(\d{2})/.exec(href)
    if (!dm) continue
    const title = stripTags(m[2])
    if (!title || title.length < 8) continue
    const url = resolveUrl(SINA_BASE, href)
    if (!url) continue
    if (!/^https?:\/\/[^/]*(sina\.com\.cn|sina\.cn)\//i.test(url)) continue
    seen.add(href)
    out.push(
      makeItem({
        source: 'sina',
        sourceName: '新浪财经',
        tier: 1,
        category: categoryOf(title),
        title,
        url,
        publishedAt: dayIso(dm[1], dm[2], dm[3]),
      })
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// 排序 / 合并
// ---------------------------------------------------------------------------

function topicScore(title) {
  if (/美联储|FOMC|Federal Reserve|利率|降息|加息|货币政策|央行|欧央行|日本央行/i.test(title)) return 40
  if (/通胀|CPI|PPI|物价|消费价格|生产者价格|价格/.test(title)) return 30
  if (GOLD_RE.test(title)) return 25
  if (/美元指数|美债收益率|储备|购金|外汇|准备金/.test(title)) return 20
  return 5
}

function ageBonus(publishedAt, now) {
  if (!publishedAt) return 0
  const t = Date.parse(publishedAt)
  if (!Number.isFinite(t)) return 0
  const age = (now instanceof Date ? now.getTime() : Date.now()) - t
  if (age <= DAY_MS) return 20
  if (age <= 3 * DAY_MS) return 10
  return 0
}

function normalizeTitle(title) {
  return String(title)
    .replace(/[\s\p{P}]/gu, '')
    .toLowerCase()
}

/**
 * 排序 + 过滤 + 去重。官方来源永远排在媒体前面（用户要求「官方消息放前位」）。
 * 若全部条目都超过 7 天，则保留最新的几条而不是返回空。
 */
function rankNews(items, now) {
  const ref = now instanceof Date ? now : new Date()
  const raw = Array.isArray(items) ? items : []
  const relevant = raw.filter((it) => {
    if (!it) return false
    if (typeof it.relevant === 'boolean') return it.relevant
    return isRelevant(it.title)
  })
  const fresh = relevant.filter((it) => {
    if (!it.publishedAt) return true
    const t = Date.parse(it.publishedAt)
    if (!Number.isFinite(t)) return true
    return ref.getTime() - t <= MAX_AGE_DAYS * DAY_MS
  })
  const pool = fresh.length ? fresh : relevant

  const byKey = new Map()
  for (const item of pool) {
    const key = normalizeTitle(item.title).slice(0, 40)
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, item)
      continue
    }
    // 同题：官方优先；同级保留发布时间更新的
    const better =
      item.tier > prev.tier ||
      (item.tier === prev.tier &&
        Date.parse(item.publishedAt || 0) > Date.parse(prev.publishedAt || 0))
    if (better) byKey.set(key, item)
  }

  return [...byKey.values()].sort((a, b) => {
    if (b.tier !== a.tier) return b.tier - a.tier
    const ts = topicScore(b.title) - topicScore(a.title)
    if (ts !== 0) return ts
    const ab = ageBonus(b.publishedAt, ref) - ageBonus(a.publishedAt, ref)
    if (ab !== 0) return ab
    return Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0)
  })
}

/**
 * 把「今天抓到的」合并进「上次缓存的」。
 * @returns {{items:Array, changed:boolean, added:number}}
 */
function mergeNews(previous, incoming) {
  const prev = Array.isArray(previous) ? previous.slice() : []
  const next = Array.isArray(incoming) ? incoming : []
  const prevIds = new Set(prev.map((it) => it && it.id).filter(Boolean))
  const added = next.filter((it) => it && !prevIds.has(it.id))
  if (!added.length) return { items: prev, changed: false, added: 0 }

  const byTitle = new Map()
  for (const item of prev.concat(next)) {
    if (!item || !item.id) continue
    const key = normalizeTitle(item.title).slice(0, 40)
    const current = byTitle.get(key)
    if (!current || item.tier >= current.tier) byTitle.set(key, item)
  }
  const merged = rankNews([...byTitle.values()], new Date())
  return { items: merged.slice(0, MAX_STORED), changed: true, added: added.length }
}

// ---------------------------------------------------------------------------
// 每天一次：抓取 + 缓存
// ---------------------------------------------------------------------------

const PROVIDERS = [
  {
    id: 'pbc',
    name: '中国人民银行',
    async fetch() {
      const html = await getText(PBC_URL, { timeout: 8000 })
      return parsePbcList(html)
    },
  },
  {
    id: 'nbs',
    name: '国家统计局',
    async fetch() {
      const html = await getText(NBS_URL, { timeout: 8000 })
      return parseNbsList(html)
    },
  },
  {
    id: 'sge',
    name: '上海黄金交易所',
    async fetch() {
      const html = await getText(SGE_URL, { timeout: 8000 })
      return parseSgeNotices(html)
    },
  },
  {
    id: 'fed',
    name: '美联储',
    async fetch() {
      const xml = await getText(FED_URL, { timeout: 8000 })
      return parseFedRss(xml)
    },
  },
  {
    id: 'sina',
    name: '新浪财经',
    async fetch() {
      const html = await getText(SINA_URL, { timeout: 8000 })
      return parseSinaNews(html)
    },
  },
]

function cachePath(dshHome) {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, NEWS_FILE)
}

function readCache(dshHome) {
  try {
    const raw = fs.readFileSync(cachePath(dshHome), 'utf8')
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return null
    return {
      date: typeof obj.date === 'string' ? obj.date : '',
      updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : null,
      attemptedAt: typeof obj.attemptedAt === 'string' ? obj.attemptedAt : null,
      items: Array.isArray(obj.items) ? obj.items.filter((it) => it && it.id && it.title && it.url) : [],
    }
  } catch (err) {
    return null
  }
}

function writeCache(dshHome, value) {
  try {
    const file = cachePath(dshHome)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    return false
  }
}

/**
 * 取资讯（3 条）。同一天只抓一次；抓不到 / 没有新增时保留上次的条目。
 * @param {{dshHome?:string, now?:Date, providers?:Array}} [options] 测试可注入
 */
async function fetchNews(options) {
  const opts = options || {}
  const now = opts.now instanceof Date ? opts.now : new Date()
  const today = beijingDate(now)
  const providers = Array.isArray(opts.providers) ? opts.providers : PROVIDERS
  const cache = readCache(opts.dshHome)

  function cachedResult(extra) {
    return Object.assign(
      {
        ok: true,
        stale: false,
        error: null,
        updatedAt: (cache && cache.updatedAt) || null,
        items: (cache ? cache.items : []).slice(0, TOP_N),
        total: cache ? cache.items.length : 0,
        cached: true,
      },
      extra || {}
    )
  }

  // 今天已经更新过：直接用缓存（这正是「每天自动更新一次」的含义）
  if (cache && cache.date === today && cache.items.length) {
    return cachedResult()
  }

  const settled = await Promise.allSettled(providers.map((p) => p.fetch()))
  const fetched = []
  const errors = []
  settled.forEach((res, index) => {
    const provider = providers[index] || { id: '#' + index }
    if (res.status === 'fulfilled') {
      if (Array.isArray(res.value)) fetched.push(...res.value)
    } else {
      errors.push(provider.id + '：' + classifyError(res.reason).text)
    }
  })

  const ranked = rankNews(fetched, now)
  let items = cache && cache.items.length ? cache.items.slice() : []
  let changed = false
  let stale = false
  let error = null

  if (ranked.length) {
    const merged = mergeNews(items, ranked)
    items = merged.items
    changed = merged.changed
  }

  if (!items.length) {
    if (errors.length) {
      writeCache(opts.dshHome, {
        date: today,
        updatedAt: null,
        attemptedAt: now.toISOString(),
        items: [],
      })
      return {
        ok: false,
        stale: false,
        error: errors[0],
        updatedAt: null,
        items: [],
        total: 0,
        cached: false,
      }
    }
    // 源都成功但一条相关的都没有：也算今天的更新结果，避免反复请求
    writeCache(opts.dshHome, {
      date: today,
      updatedAt: now.toISOString(),
      attemptedAt: now.toISOString(),
      items: [],
    })
    return {
      ok: true,
      stale: false,
      error: '今日暂无新增资讯',
      updatedAt: now.toISOString(),
      items: [],
      total: 0,
      cached: false,
    }
  }

  if (!changed && cache && cache.items.length) {
    stale = true
    error = errors.length ? '部分资讯源失败，展示上次内容' : '今日暂无新增资讯，展示上次内容'
  }

  const updatedAt = changed || !cache || !cache.updatedAt ? now.toISOString() : cache.updatedAt
  writeCache(opts.dshHome, {
    date: today,
    updatedAt,
    attemptedAt: now.toISOString(),
    items: items.slice(0, MAX_STORED),
  })

  return {
    ok: true,
    stale,
    error,
    updatedAt,
    items: items.slice(0, TOP_N),
    total: items.length,
    cached: false,
  }
}

module.exports = {
  NEWS_FILE,
  MAX_AGE_DAYS,
  TOP_N,
  PROVIDERS,
  parsePbcList,
  parseNbsList,
  parseSgeNotices,
  parseFedRss,
  parseSinaNews,
  rankNews,
  mergeNews,
  fetchNews,
  beijingDate,
  cachePath,
  readCache,
}
