/**
 * lib/sources.cjs —— 数据源与通用请求层（零第三方依赖）
 *
 * 覆盖：工商银行 / 建设银行 / 新浪国际金价 / gold-api 兜底，以及所有源共用的请求层。
 *
 * 请求层要点（提示词 v3 第六节）：
 *   1. 每个请求统一带桌面浏览器 UA
 *   2. 连接超时与读取超时分开设置（默认各 10s，上金所日行情页 12s）
 *   3. 重定向最多 3 次
 *   4. 按 content-encoding 解 gzip / deflate / br
 *   5. 智能解码：utf-8 出现替换字符时回退 GBK（新浪 hf_XAU 是 GBK）
 *   6. 工行/建行必须带 secureOptions = SSL_OP_LEGACY_SERVER_CONNECT，
 *      否则 OpenSSL 3.x 拒绝旧式重协商：EPROTO ... unsafe legacy renegotiation disabled
 *   7. 错误归一成五类：请求超时 / 连接被拒 / 页面结构变更 / 接口返回失败 / TLS 协商失败（附原始错误码）
 */

'use strict'

const https = require('node:https')
const http = require('node:http')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const { URL } = require('node:url')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/**
 * ⚠️ 关键：工行/建行服务器仍使用旧式 TLS 重协商（unsafe legacy renegotiation），
 * OpenSSL 3.x 默认拒绝，报错 EPROTO ... unsafe legacy renegotiation disabled。
 * 解法：给 TLS 连接加 SSL_OP_LEGACY_SERVER_CONNECT（Node 常量值 = 4）。
 * 不加这个标志，工行与建行两个源**必然同时失败**，且报错极具误导性。
 */
const LEGACY_TLS =
  crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT !== undefined
    ? crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
    : 4

const DEFAULT_CONNECT_TIMEOUT = 10000
const DEFAULT_READ_TIMEOUT = 10000
const MAX_REDIRECTS = 3

/** 错误分类（提示词 v3 六.5 要求的具体失败原因） */
const ERROR_KIND = {
  TIMEOUT: '请求超时',
  REFUSED: '连接被拒',
  STRUCT: '页面结构变更',
  API: '接口返回失败',
  TLS: 'TLS 协商失败',
}

/**
 * 构造一个带分类信息的 Error。
 * @param {string} kind  ERROR_KIND 之一
 * @param {string} message 人类可读细节
 * @param {string} [code]  原始错误码（如 EPROTO / HTTP_403）
 */
function sourceError(kind, message, code) {
  const err = new Error(message)
  err.kind = kind
  if (code) err.code = code
  return err
}

/**
 * 把任意异常归一成 `{ kind, code, raw, text }`。
 * text 是直接写进 card.error 的字符串，形如「请求超时：读取超时（10000ms）」。
 */
function classifyError(err) {
  const raw = err && err.message ? String(err.message) : String(err)
  const code = err && err.code ? String(err.code) : ''
  if (err && err.kind) {
    let text
    if (err.kind === ERROR_KIND.TLS) {
      text = `${ERROR_KIND.TLS}（${code || raw}）`
    } else if (raw.startsWith(err.kind)) {
      text = raw // 抛错处已带分类前缀，避免重复成「请求超时：请求超时：…」
    } else {
      text = `${err.kind}：${raw}`
    }
    return { kind: err.kind, code: code || null, raw, text }
  }
  const hay = `${code} ${raw}`
  if (/unsafe legacy renegotiation|SSL routines|EPROTO|ERR_SSL|CERT_|certificate|handshake/i.test(hay)) {
    return {
      kind: ERROR_KIND.TLS,
      code: code || null,
      raw,
      text: `${ERROR_KIND.TLS}（${code || raw}）`,
    }
  }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout|timed out|超时/i.test(hay)) {
    return { kind: ERROR_KIND.TIMEOUT, code: code || null, raw, text: `${ERROR_KIND.TIMEOUT}：${raw}` }
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH|ECONNABORTED/i.test(hay)) {
    return { kind: ERROR_KIND.REFUSED, code: code || null, raw, text: `${ERROR_KIND.REFUSED}（${code || raw}）` }
  }
  if (/^页面结构变更/.test(raw)) {
    return { kind: ERROR_KIND.STRUCT, code: code || null, raw, text: raw }
  }
  if (/^接口返回失败/.test(raw)) {
    return { kind: ERROR_KIND.API, code: code || null, raw, text: raw }
  }
  // 未识别：默认归为接口返回失败，保留原始信息
  return { kind: ERROR_KIND.API, code: code || null, raw, text: `${ERROR_KIND.API}：${raw}` }
}

function cookieHeader(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

function captureCookies(jar, setCookie) {
  if (!jar || !setCookie) return
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const c of list) {
    const kv = String(c).split(';')[0]
    const i = kv.indexOf('=')
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim())
  }
}

function numOpt(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * 单次请求（不处理重定向），返回 `{ status, headers, buffer }`。
 * connectTimeout 覆盖 TCP 连接 + TLS 握手；readTimeout 是连接建立后的空闲读超时。
 */
function requestOnce(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(urlStr)
    } catch (err) {
      return reject(sourceError(ERROR_KIND.API, `URL 无效：${urlStr}`))
    }
    const mod = u.protocol === 'https:' ? https : http
    const {
      headers = {},
      connectTimeout = DEFAULT_CONNECT_TIMEOUT,
      readTimeout = DEFAULT_READ_TIMEOUT,
      method = 'GET',
      body = null,
      jar = null,
      secureOptions = LEGACY_TLS,
    } = opts

    const reqHeaders = {
      'User-Agent': UA,
      'Accept-Encoding': 'gzip, deflate',
      ...headers,
    }
    if (body) reqHeaders['Content-Length'] = Buffer.byteLength(body)
    if (jar && jar.size) reqHeaders.Cookie = cookieHeader(jar)

    let settled = false
    let connectTimer = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
      fn(value)
    }

    let req
    try {
      req = mod.request(
        u,
        { method, headers: reqHeaders, rejectUnauthorized: true, secureOptions },
        (res) => {
          if (jar) captureCookies(jar, res.headers['set-cookie'])
          const status = res.statusCode || 0
          const enc = String(res.headers['content-encoding'] || '').toLowerCase()
          let stream = res
          try {
            if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip())
            else if (enc === 'deflate') stream = res.pipe(zlib.createInflate())
            else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress())
          } catch (err) {
            res.resume()
            return finish(reject, sourceError(ERROR_KIND.API, `响应解压失败：${err.message}`))
          }
          const chunks = []
          stream.on('data', (c) => chunks.push(c))
          stream.on('error', (err) =>
            finish(reject, sourceError(ERROR_KIND.API, `响应读取失败：${err.message}`, err.code)))
          stream.on('end', () => finish(resolve, { status, headers: res.headers, buffer: Buffer.concat(chunks) }))
        }
      )
    } catch (err) {
      return finish(reject, err)
    }

    connectTimer = setTimeout(() => {
      req.destroy(sourceError(ERROR_KIND.TIMEOUT, `连接超时（${connectTimeout}ms）`, 'ETIMEDOUT'))
    }, connectTimeout)

    req.on('socket', (socket) => {
      // 复用 keep-alive 连接时，socket 已经完成过握手：secureConnect/connect
      // 不会再次触发，直接清连接超时并开始计读取超时（否则 once 监听会累积，
      // 触发 MaxListenersExceededWarning，连接超时也会误判）。
      const reused =
        u.protocol === 'https:'
          ? socket.encrypted === true && socket.connecting === false
          : socket.connecting === false
      if (reused) {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
        if (!settled) req.setTimeout(readTimeout)
        return
      }
      const evt = u.protocol === 'https:' ? 'secureConnect' : 'connect'
      socket.once(evt, () => {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
        if (!settled) req.setTimeout(readTimeout)
      })
    })
    req.on('timeout', () => {
      req.destroy(sourceError(ERROR_KIND.TIMEOUT, `读取超时（${readTimeout}ms）`, 'ETIMEDOUT'))
    })
    req.on('error', (err) => finish(reject, err))

    if (body) req.write(body)
    req.end()
  })
}

/**
 * 通用请求，返回 Buffer。处理重定向（最多 3 次）、gzip/deflate、Cookie jar（可选）。
 * @param {string} urlStr
 * @param {{headers?:object, timeout?:number, connectTimeout?:number, readTimeout?:number,
 *          redirects?:number, method?:string, body?:string, jar?:Map<string,string>}} [opts]
 */
async function getBuffer(urlStr, opts = {}) {
  const connectTimeout = numOpt(opts.connectTimeout !== undefined ? opts.connectTimeout : opts.timeout, DEFAULT_CONNECT_TIMEOUT)
  const readTimeout = numOpt(opts.readTimeout !== undefined ? opts.readTimeout : opts.timeout, DEFAULT_READ_TIMEOUT)
  const maxRedirects = Number.isFinite(Number(opts.redirects)) ? Math.max(0, Number(opts.redirects)) : MAX_REDIRECTS
  let current = String(urlStr)
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await requestOnce(current, { ...opts, connectTimeout, readTimeout })
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      try {
        current = new URL(res.headers.location, current).toString()
      } catch (err) {
        throw sourceError(ERROR_KIND.API, `重定向 Location 无效：${res.headers.location}`)
      }
      continue
    }
    if (res.status < 200 || res.status >= 300) {
      const u = new URL(current)
      throw sourceError(ERROR_KIND.API, `HTTP ${res.status} ${u.host}${u.pathname}`, `HTTP_${res.status}`)
    }
    return res.buffer
  }
  throw sourceError(ERROR_KIND.API, `重定向次数超过 ${maxRedirects} 次`, 'TOO_MANY_REDIRECTS')
}

async function getText(urlStr, opts = {}) {
  const buf = await getBuffer(urlStr, opts)
  return decodeSmart(buf)
}

/** 智能解码：优先 utf-8，出现替换字符（U+FFFD）回退 GBK。 */
function decodeSmart(buf) {
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    const gbk = new TextDecoder('gbk').decode(buf)
    if (!gbk.includes('\uFFFD')) return gbk
  } catch (_) { /* 平台无 gbk 支持则忽略 */ }
  return utf8
}

// ---------------------------------------------------------------------------
// 1. 上金所 Au99.99（延时行情 HTML，作为 sge.cjs 的兜底与交叉校验源）
// ---------------------------------------------------------------------------

/**
 * 解析上金所延时行情页。
 * 实测返回行：['Au99.99', '868.6', '887.0', '866.14', '887.0']
 * 表头顺序：合约 | 最新价 | 最高价 | 最低价 | 今开盘
 */
function parseSge(html) {
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
  const find = (name) => rows.find((r) => r[0] === name)
  const au = find('Au99.99')
  if (!au) throw sourceError(ERROR_KIND.STRUCT, '页面结构变更：未找到 Au99.99 行')
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return {
    symbol: 'Au99.99',
    last: num(au[1]),
    high: num(au[2]),
    low: num(au[3]),
    open: num(au[4]),
    source: '上海黄金交易所官网(延时行情)',
    // 官网 HTML 不提供时间戳
    quoteTime: null,
  }
}

async function fetchSge() {
  const html = await getText('https://www.sge.com.cn/sjzx/yshqbg', { timeout: 12000 })
  return parseSge(html)
}

// ---------------------------------------------------------------------------
// 2. 国际金价 XAU/USD
// ---------------------------------------------------------------------------

/** 备源：gold-api.com（只给现价，不给昨收，仅作新浪失败兜底） */
async function fetchIntlGold() {
  const txt = await getText('https://api.gold-api.com/price/XAU', { timeout: 10000 })
  let j
  try {
    j = JSON.parse(txt)
  } catch (err) {
    throw sourceError(ERROR_KIND.STRUCT, '页面结构变更：gold-api 返回非 JSON')
  }
  if (typeof j.price !== 'number') throw sourceError(ERROR_KIND.API, '接口返回失败：gold-api 缺少 price 字段')
  return {
    symbol: 'XAU/USD',
    price: j.price,
    updatedAt: j.updatedAt || null,
    quoteTime: j.updatedAt || null,
    source: 'gold-api.com',
  }
}

/**
 * 新浪财经国际金价（国内直连可用，且自带昨收/最高/最低/时间戳）
 *   GET https://hq.sinajs.cn/list=hf_XAU
 *   必须带 Referer: https://finance.sina.com.cn，否则返回空
 *   编码 GBK
 *   字段：[0]现价 [1]昨收 [2]买价 [3]卖价 [4]最高 [5]最低 [6]时间 [7]昨收2
 *         [8]开盘 [12]日期 [13]品种名
 */
async function fetchIntlGoldSina() {
  const buf = await getBuffer('https://hq.sinajs.cn/list=hf_XAU', {
    timeout: 10000,
    headers: { Referer: 'https://finance.sina.com.cn/' },
  })
  const text = decodeSmart(buf)
  const m = /hq_str_hf_XAU="([^"]*)"/.exec(text)
  if (!m) throw sourceError(ERROR_KIND.STRUCT, '页面结构变更：新浪未匹配 hf_XAU')
  const f = m[1].split(',')
  if (f.length < 13) throw sourceError(ERROR_KIND.STRUCT, '页面结构变更：新浪字段数不足(' + f.length + ')')
  const n = (v) => {
    const x = Number(v)
    return Number.isFinite(x) ? x : null
  }
  const price = n(f[0])
  const prevClose = n(f[1])
  if (price === null) throw sourceError(ERROR_KIND.API, '接口返回失败：新浪现价非数字')
  const out = {
    symbol: 'XAU/USD',
    name: f[13] || '伦敦金（现货黄金）',
    price,
    prevClose,
    high: n(f[4]),
    low: n(f[5]),
    quoteTime: `${f[12] || ''} ${f[6] || ''}`.trim(),
    source: '新浪财经',
  }
  if (prevClose) {
    out.change = +(price - prevClose).toFixed(2)
    out.changePct = +(((price - prevClose) / prevClose) * 100).toFixed(2)
  }
  return out
}

// ---------------------------------------------------------------------------
// 3. 工商银行 积存金 / 如意金积存（网银公开行情接口，免登录，必须 POST）
// ---------------------------------------------------------------------------

const ICBC_SERVLET = 'https://mybank.icbc.com.cn/servlet/AsynGetDataServlet'
const ICBC_BACKUP = 'https://cmbcnp.icbc.com.cn/servlet/AsynGetDataServlet'

async function icbcCallAt(endpoint, tranCode) {
  const body = new URLSearchParams({ tranCode }).toString()
  const buf = await getBuffer(endpoint, {
    timeout: 10000,
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Referer:
        'https://mybank.icbc.com.cn/icbc/newperbank/perbank3/gold/goldaccrual_query_out.jsp',
    },
  })
  try {
    return JSON.parse(decodeSmart(buf))
  } catch (err) {
    throw sourceError(ERROR_KIND.STRUCT, `页面结构变更：工行 ${tranCode} 返回非 JSON`)
  }
}

async function icbcCall(tranCode) {
  try {
    return await icbcCallAt(ICBC_SERVLET, tranCode)
  } catch (primaryErr) {
    // 备用域名（实测同样可用）：主域失败时自动切换
    try {
      return await icbcCallAt(ICBC_BACKUP, tranCode)
    } catch (_) {
      throw primaryErr
    }
  }
}

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * A00622 -> 积存金行情（JC001）
 *   ActivePrice 实时主动积存价（买入）
 *   RegPrice    定期/协议积存价
 *   SellPrice   赎回价
 *   HighPrice / LowPrice
 *   sysdate     工行报价时间
 * A00505 -> 如意金积存
 *   buyprice / sellprice  单位：分（需 /100）
 *   注意：A00505 的 TranErrorCode 为 "0" 表示成功；A00622 成功时 TranErrorCode 为空串。
 */
async function fetchIcbc() {
  const [jcRes, ryRes] = await Promise.allSettled([icbcCall('A00622'), icbcCall('A00505')])
  const errors = []
  let accumulate = null
  let ruyi = null
  let quoteTime = null

  if (jcRes.status === 'fulfilled') {
    const jc = jcRes.value || {}
    const rf = (jc.rf || [])[0]
    if (!rf) {
      const te = String(jc.TranErrorCode === undefined ? '' : jc.TranErrorCode).trim()
      errors.push(sourceError(ERROR_KIND.API, `接口返回失败：工行 A00622 rf 为空${te ? `（TranErrorCode=${te}）` : ''}`))
    } else {
      accumulate = {
        name: rf.ProductName || '积存金',
        buy: toNum(rf.ActivePrice),
        reg: toNum(rf.RegPrice),
        sell: toNum(rf.SellPrice),
        high: toNum(rf.HighPrice),
        low: toNum(rf.LowPrice),
        quoteTime: jc.sysdate || null,
      }
      quoteTime = jc.sysdate || null
    }
  } else {
    errors.push(jcRes.reason)
  }

  if (ryRes.status === 'fulfilled') {
    const ry = ryRes.value || {}
    const pro = (ry.pronoinfo || [])[0]
    if (!pro) {
      const te = String(ry.TranErrorCode === undefined ? '' : ry.TranErrorCode).trim()
      errors.push(sourceError(ERROR_KIND.API, `接口返回失败：工行 A00505 pronoinfo 为空${te ? `（TranErrorCode=${te}）` : ''}`))
    } else {
      // ⚠️ 单位是「分」，必须 ÷100：89015 -> 890.15
      const yuan = (cent) => {
        const n = toNum(cent)
        return n === null ? null : Math.round((n / 100) * 100) / 100
      }
      ruyi = {
        name: '如意金积存',
        buy: yuan(pro.buyprice),
        sell: yuan(pro.sellprice),
        quoteTime,
      }
    }
  } else {
    errors.push(ryRes.reason)
  }

  if (!accumulate && !ruyi) {
    const first = errors.find(Boolean)
    if (first) throw first
    throw sourceError(ERROR_KIND.API, '接口返回失败：工行两个产品接口均无数据')
  }

  return {
    accumulate,
    ruyi,
    quoteTime,
    source: '工商银行网银公开行情接口',
    partialErrors: errors.map((e) => classifyError(e).text),
  }
}

// ---------------------------------------------------------------------------
// 4. 建设银行 积存金（creditcard1 接口，必须先建会话再带 Cookie 取价）
// ---------------------------------------------------------------------------

const CCB_BASE = 'https://creditcard1.ccb.com'
const CCB_SESSION_URL =
  `${CCB_BASE}/tran/WCCMainPlatV5?CCB_IBSVersion=V5&SERVLET_NAME=WCCMainPlatV5&TXCODE=100119`
const CCB_PRICE_URL =
  `${CCB_BASE}/tran/WCCMainPlatV5?CCB_IBSVersion=V5&SERVLET_NAME=WCCMainPlatV5&TXCODE=NGJS01`

async function fetchCcbPrice() {
  const headers = {
    Accept: 'application/json,text/plain,*/*',
    Referer: 'https://creditcard1.ccb.com/',
  }
  // 手动维护 Cookie jar：先建会话，再带 Cookie 取价（缺一不可）
  const jar = new Map()
  await getBuffer(CCB_SESSION_URL, { headers, jar, timeout: 10000, redirects: 3 })
  const buf = await getBuffer(CCB_PRICE_URL, { headers, jar, timeout: 10000, redirects: 3 })

  let j
  try {
    j = JSON.parse(decodeSmart(buf).trim() || '{}')
  } catch (err) {
    throw sourceError(ERROR_KIND.STRUCT, '页面结构变更：建行返回非 JSON')
  }
  if (String(j.SUCCESS).toLowerCase() !== 'true') {
    throw sourceError(ERROR_KIND.API, `接口返回失败：建行 ${j.retMsg || j.retCode || 'SUCCESS≠true'}`)
  }
  const out = {
    name: '建行积存金/账户金',
    buy: toNum(j.Cst_Buy_Prc),
    sell: toNum(j.Cst_Sell_Prc),
    mid: toNum(j.MdlRate),
    quoteTime: j.Tms || j.Mkt_Ofr_Tm || null,
    intlBuy: toNum(j.Acrs_Spot_Buy_Prc_1),
    intlSell: toNum(j.Acrs_Spot_Sell_Prc_1),
    source: '建设银行积存金接口',
  }
  if (out.buy === null) throw sourceError(ERROR_KIND.API, '接口返回失败：建行缺少 Cst_Buy_Prc')
  return out
}

// ---------------------------------------------------------------------------
// 聚合（供独立脚本调试用；插件聚合层见 lib/gold.cjs）
// ---------------------------------------------------------------------------

async function fetchAll() {
  const t0 = Date.now()
  const settle = async (name, fn) => {
    try {
      const data = await fn()
      return { name, ok: true, data, elapsedMs: Date.now() - t0 }
    } catch (err) {
      return {
        name,
        ok: false,
        error: classifyError(err).text,
        elapsedMs: Date.now() - t0,
      }
    }
  }
  const [sge, intl, icbc, ccb] = await Promise.all([
    settle('sge', fetchSge),
    settle('intl', fetchIntlGold),
    settle('icbc', fetchIcbc),
    settle('ccb', fetchCcbPrice),
  ])
  return { fetchedAt: new Date().toISOString(), sources: { sge, intl, icbc, ccb } }
}

module.exports = {
  // 常量 / 错误
  UA,
  LEGACY_TLS,
  ERROR_KIND,
  sourceError,
  classifyError,
  // 请求层
  getText,
  getBuffer,
  decodeSmart,
  // 数据源
  fetchAll,
  fetchSge,
  fetchIntlGold,
  fetchIntlGoldSina,
  fetchIcbc,
  fetchCcbPrice,
  // 解析器（供测试）
  parseSge,
}
