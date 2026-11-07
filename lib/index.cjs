/**
 * lib/index.cjs —— dsh-gold-card Host 半边
 *
 * 两件事：
 *   1. 用 ctx.webServer.register({ kind:'exact', path, resource }) 挂 /dsh-gold/* 路由：
 *        GET /dsh-gold/panel.js        面板脚本（浏览器脚本，非 ESM）
 *        GET /dsh-gold/panel.css       面板样式
 *        GET /dsh-gold/api/quotes      四类金价 JSON（见 CONTRACT.md 第 3 节）
 *        GET /dsh-gold/api/status      插件自述（build/路由数/面板挂载报告）
 *        GET /dsh-gold/api/mounted     面板自报挂载（panel.js 打开时回报一次）
 *   2. 监听 'webserver/index-inject' 事件，贡献一行**自举脚本**，由它去插 <link> 与 <script src>。
 *
 * 为什么必须走 index-inject 而不是 tapIndex：
 *   Windows 桌面应用加载的是打包好的 dsh-app://app/，不经过 webServer.renderIndex()，
 *   tapIndex() 的 HTML 转换在桌面端永远不生效。桌面壳改为取 collectIndexInjections()
 *   产出的结构化注入表（内部 emit 'webserver/index-inject'），逐行插进页面。
 *   自举脚本在应用启动时是快照，所以改面板只需要刷新页面，不必重启应用；
 *   但路由要等 webServer 就绪（实测晚 120~500ms），所以自举脚本必须带重试。
 *
 * 为什么路由用 resource 而不是 handler：
 *   resource = (Request) => Response，HTTP 请求走 serveResource，同时能用
 *   webServer.readResource() 在进程内自检 —— 安装后不依赖浏览器/HTTP 客户端
 *   就能确认路由真的可服务（桌面应用对 HTTP 有访问令牌栅栏，外部 curl 进不来）。
 *
 * 刻意不 require 任何第三方包（只用 node 内置模块），避免 DSH 打包环境的模块解析风险。
 */

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const { fetchCards } = require('./gold.cjs')

const PACKAGE_ROOT = path.resolve(__dirname, '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PLUGIN_ID = 'dsh-gold-card'
const ROUTE_PREFIX = '/dsh-gold'
const LOG_FILE = path.join(DSH_HOME, '.dsh-gold-card.log')
const DEFAULT_REFRESH_MS = 15 * 60 * 1000
const LOG_MAX_BYTES = 256 * 1024

/** 当前加载的代码版本（内容哈希）：日志里能确认运行的到底是哪一版。 */
const BUILD = (function () {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0, 12)
  } catch (err) {
    return 'unknown'
  }
})()

/** 进程内共享状态，供 /api/status 与日志读取。 */
const state = {
  appliedAt: null,
  webServerAcquiredAt: null,
  routes: [],
  lastMounted: null,
  lastDiag: null,
  indexInjection: null,
  logs: 0,
}

// ---------------------------------------------------------------------------
// 日志：console + $DSH_HOME/.dsh-gold-card.log（超过 256KB 截断重写）
// ---------------------------------------------------------------------------

function log(msg) {
  const line = `[${new Date().toISOString()}] [${PLUGIN_ID}] ${msg}`
  try { console.log(line) } catch (err) { /* 无控制台不影响主流程 */ }
  try {
    let size = 0
    try { size = fs.statSync(LOG_FILE).size } catch (e) { size = 0 }
    if (size > LOG_MAX_BYTES) fs.writeFileSync(LOG_FILE, '')
    fs.appendFileSync(LOG_FILE, line + '\n')
    state.logs += 1
  } catch (err) { /* 日志失败不影响主流程 */ }
}

// ---------------------------------------------------------------------------
// HTTP 响应工具
// ---------------------------------------------------------------------------

/** 保证返回值是「无损 JSON」：undefined / 非纯对象会让 JSON.stringify 出错。 */
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value))
}

function jsonResponse(value, status) {
  const body = JSON.stringify(jsonSafe(value))
  return new Response(body, {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-dsh-gold-build': BUILD,
    },
  })
}

function readAsset(name) {
  const file = path.join(PACKAGE_ROOT, 'assets', name)
  try {
    return { body: fs.readFileSync(file), error: null }
  } catch (err) {
    return { body: null, error: `资源缺失：assets/${name}（${err.message}）` }
  }
}

// ---------------------------------------------------------------------------
// index 注入：只注入一段自举脚本
// ---------------------------------------------------------------------------

/**
 * 自举脚本：插 <link rel=stylesheet> + <script src>，失败重试。
 *   - 不用 script-src 行：桌面壳会 await 它，取不到会让整个应用启动失败。
 *   - 不内联 panel.js：注入行是启动快照，内联内容改了要重启；按 URL 加载只要刷新页面。
 *   - 必须重试：注入表在 apply 阶段贡献，而路由要等 webServer 就绪才注册，
 *     首次请求很可能 404。80 次 × 150ms ≈ 12s 足够覆盖冷启动。
 *   - onerror 必须留痕（console.error + 计数），早先写成空函数会把失败完整吞掉。
 */
function bootstrapScript() {
  const jsPath = ROUTE_PREFIX + '/panel.js'
  const cssPath = ROUTE_PREFIX + '/panel.css'
  return (
    '(function(){' +
    'if(window.__dshGoldCardBoot||window.__dshGoldCardPanel)return;window.__dshGoldCardBoot=true;' +
    'var tries=0,done=false,MAX=80;' +
    'function drop(id){var e=document.getElementById(id);if(e&&e.parentNode)e.parentNode.removeChild(e)}' +
    'function warn(msg){try{console.warn("[dsh-gold-card] "+msg+" try="+tries)}catch(e){}}' +
    'function load(){' +
    'if(done||window.__dshGoldCardPanel)return;' +
    'if(tries>=MAX){try{console.error("[dsh-gold-card] panel.js 加载失败，已重试 "+tries+" 次")}catch(e){}return}' +
    'tries++;' +
    // 重试前先移除上一次失败的节点，避免失败时不断累积 <link>/<script>
    'drop("dsh-gold-card-css");' +
    'var l=document.createElement("link");l.id="dsh-gold-card-css";l.rel="stylesheet";l.href="' + cssPath + '?v="+tries;' +
    'l.onerror=function(){warn("panel.css 加载失败")};' +
    'document.head.appendChild(l);' +
    'drop("dsh-gold-card-js");' +
    'var s=document.createElement("script");s.id="dsh-gold-card-js";s.async=false;s.src="' + jsPath + '?v="+tries;' +
    's.onload=function(){done=true};' +
    's.onerror=function(){drop("dsh-gold-card-js");setTimeout(load,150)};' +
    'document.head.appendChild(s)}' +
    'load()})();'
  )
}

/**
 * 贡献注入行。同一张表只贡献一次（桌面壳可能对同一 Peer 反复收集）。
 */
function contributeIndexRows(table, log) {
  log('index-inject: 已贡献自举行 -> ' + ROUTE_PREFIX + '/panel.css + ' + ROUTE_PREFIX + '/panel.js')
  table.push({ kind: 'script', placement: 'body', text: bootstrapScript() })
}

// ---------------------------------------------------------------------------
// 路由 resources
// ---------------------------------------------------------------------------

function assetResource(name, mime) {
  return async function () {
    const asset = readAsset(name)
    if (asset.error) {
      return new Response(asset.error, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    return new Response(asset.body, {
      status: 200,
      headers: {
        'content-type': mime + '; charset=utf-8',
        // 面板是开发中的资产：不缓存，改完刷新页面即生效
        'cache-control': 'no-store',
        'x-dsh-gold-build': BUILD,
      },
    })
  }
}

function quotesResource(refreshMs) {
  return async function () {
    try {
      const payload = await fetchCards()
      // 顺带把自动刷新间隔告诉面板，避免 Host 与前端各写死一个值
      payload.refreshMs = refreshMs
      payload.build = BUILD
      return jsonResponse(payload)
    } catch (err) {
      const detail = err && err.message ? err.message : String(err)
      log('quotes 失败：' + detail)
      return jsonResponse({ error: detail, build: BUILD, fetchedAt: new Date().toISOString() }, 500)
    }
  }
}

function statusResource() {
  return async function () {
    return jsonResponse({
      plugin: PLUGIN_ID,
      build: BUILD,
      pid: process.pid,
      dshHome: DSH_HOME,
      appliedAt: state.appliedAt,
      webServerAcquiredAt: state.webServerAcquiredAt,
      injectRow: 'webserver/index-inject（script, body；自举后按 URL 加载 panel.js/css）',
      routes: state.routes.slice(),
      lastMounted: state.lastMounted,
      lastDiag: state.lastDiag,
      indexInjection: state.indexInjection,
      logFile: LOG_FILE,
    })
  }
}

/**
 * 前端挂载诊断：panel.js 把「真实 DOM 里看到了什么」发过来，Host 原文写日志。
 * 桌面应用跑在 dsh-app:// 里，外部无法检查页面 DOM；面板探测失败时这条通道
 * 是唯一能拿到现场的手段（$DSH_HOME/.dsh-gold-card.log 里的 diag 行）。
 */
function diagResource() {
  return async function (request) {
    let raw = ''
    try {
      raw = String(new URL(request.url).searchParams.get('d') || '')
    } catch (err) {
      raw = ''
    }
    const text = raw.slice(0, 8000)
    state.lastDiag = { at: new Date().toISOString(), data: text }
    log('diag ' + text)
    return jsonResponse({ ok: true, received: text.length })
  }
}

/**
 * 面板自报挂载：panel.js 打开后 GET 一次，Host 侧就能确认
 * 「面板真的在页面里跑起来了」（桌面 dsh-app:// 与浏览器两条路径都要确认），
 * 而不是靠「路由返回 200」推断。
 */
function mountedResource() {
  return async function (request) {
    let q
    try { q = new URL(request.url).searchParams } catch (err) { q = new URLSearchParams('') }
    const href = String(q.get('href') || '').slice(0, 300)
    const proto = String(q.get('proto') || '').slice(0, 40)
    const ua = String(q.get('ua') || '').slice(0, 200)
    state.lastMounted = { at: new Date().toISOString(), href, proto, ua }
    log('panel mounted proto=' + (proto || '?') + ' href=' + (href || '?'))
    return jsonResponse(state.lastMounted)
  }
}

/**
 * 注入表自检：用桌面壳**完全相同**的调用方式（collectIndexInjections(browserPeer)）
 * 收集一次注入表，确认自举行真的在里面。
 *
 * 这一条很关键：桌面壳只在应用启动时取一次注入表（dsh-desktop-host 在 ready 时发送
 * injections），所以新装插件必须重启应用才能让面板入口出现；但「下次启动一定能拿到」
 * 这件事可以在当前进程里直接验证，不用等到重启。
 */
function verifyIndexInjection(ctx, webServer) {
  try {
    if (typeof webServer.collectIndexInjections !== 'function') {
      log('index-inject verify: webServer 无 collectIndexInjections，跳过')
      return { checked: false, reason: 'no collectIndexInjections' }
    }
    let peer
    try {
      const connection = ctx.get('connection')
      peer = connection && connection.browserPeer
    } catch (err) { /* 无 connection 服务时用 undefined */ }
    const table = webServer.collectIndexInjections(peer)
    const ours = table.filter(function (row) {
      return row && row.kind === 'script' && typeof row.text === 'string' &&
        row.text.indexOf(ROUTE_PREFIX + '/panel.js') !== -1
    })
    log(
      'index-inject verify: rows=' + table.length + ' ours=' + ours.length +
      ' placement=' + (ours[0] && ours[0].placement) + ' len=' + (ours[0] && String(ours[0].text).length)
    )
    return { checked: true, rows: table.length, ours: ours.length, placement: ours[0] && ours[0].placement }
  } catch (err) {
    log('index-inject verify 失败：' + (err && err.message ? err.message : String(err)))
    return { checked: false, reason: err && err.message ? err.message : String(err) }
  }
}

/** 进程内自检：不经过 HTTP，直接问 webServer「这个路径会返回什么」。 */
async function runSelfCheck(webServer) {
  const targets = [
    ROUTE_PREFIX + '/panel.js',
    ROUTE_PREFIX + '/panel.css',
    ROUTE_PREFIX + '/api/status',
  ]
  const results = {}
  let failed = 0
  for (const target of targets) {
    try {
      const res = await webServer.readResource(new Request('http://dsh-gold.local' + target))
      let bytes = 0
      if (res.status === 200) {
        try { bytes = (await res.arrayBuffer()).byteLength } catch (err) { bytes = 0 }
      } else {
        failed += 1
      }
      results[target] = { status: res.status, bytes }
    } catch (err) {
      failed += 1
      results[target] = { error: err && err.message ? err.message : String(err) }
    }
  }
  log('selfcheck assets ' + JSON.stringify(results) + (failed ? '（有失败）' : '（全部可服务）'))
  return failed === 0
}

/**
 * 行情自检：延后 3 秒执行，避免拖慢 DSH 启动；结果写日志，
 * 安装后不打开浏览器也能确认「四源 + 路由」端到端通。
 */
function scheduleQuotesSelfCheck(webServer) {
  const timer = setTimeout(function () {
    Promise.resolve()
      .then(function () {
        return webServer.readResource(new Request('http://dsh-gold.local' + ROUTE_PREFIX + '/api/quotes'))
      })
      .then(async function (res) {
        const text = await res.text()
        let summary = text.slice(0, 200)
        try {
          const parsed = JSON.parse(text)
          const cards = parsed.cards || {}
          const sgeFields = (cards.sge && cards.sge.fields) || []
          const fieldOf = (label) => {
            const hit = sgeFields.find((f) => f && f.label === label)
            return hit ? hit.value : null
          }
          summary = JSON.stringify({
            base: parsed.baseAu9999,
            sge: cards.sge && {
              ok: cards.sge.ok,
              last: fieldOf('最新价'),
              high: fieldOf('最高'),
              low: fieldOf('最低'),
              pct: fieldOf('涨跌幅'),
              quoteTime: cards.sge.quoteTime,
              session: cards.sge.session || null,
              cross: cards.sge.crossCheck && cards.sge.crossCheck.level,
            },
            intl: cards.intl && { ok: cards.intl.ok, last: (cards.intl.fields || [])[0] && cards.intl.fields[0].value },
            icbc: cards.icbc && { ok: cards.icbc.ok },
            ccb: cards.ccb && { ok: cards.ccb.ok },
          })
        } catch (err) { /* 非 JSON 就打印前 200 字 */ }
        log('selfcheck quotes status=' + res.status + ' base=' + summary)
      })
      .catch(function (err) {
        log('selfcheck quotes 失败：' + (err && err.message ? err.message : String(err)))
      })
  }, 3000)
  if (timer && typeof timer.unref === 'function') timer.unref()
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

function apply(ctx, pluginConfig) {
  const config = pluginConfig && typeof pluginConfig === 'object' ? pluginConfig : {}
  const refreshMs = Number(config.refreshMs) > 0 ? Number(config.refreshMs) : DEFAULT_REFRESH_MS

  state.appliedAt = new Date().toISOString()
  state.routes = []
  log(
    'apply: start build=' + BUILD + ' pid=' + process.pid +
    ' DSH_HOME=' + DSH_HOME + ' refreshMs=' + refreshMs
  )

  // ---- 1) index 注入（桌面端可见的唯一通道）----
  // Cordis 事件总线是扁平的，任意 ctx 上监听都能收到 webServer 的 emit。
  // 同一张表只贡献一次，防止重复注入。
  try {
    const contributed = new WeakSet()
    ctx.effect(function () {
      return ctx.on('webserver/index-inject', function (table) {
        if (!table || typeof table.push !== 'function') return
        if (contributed.has(table)) return
        contributed.add(table)
        try {
          contributeIndexRows(table, log)
        } catch (err) {
          log('index-inject 贡献失败：' + (err && err.message ? err.message : String(err)))
        }
      })
    })
    log('index-inject listener registered')
  } catch (err) {
    log('index-inject 监听注册失败：' + (err && err.message ? err.message : String(err)))
  }

  // ---- 2) 等 webServer 就绪后挂路由 ----
  const startedAt = Date.now()
  let started = false
  let disposed = false
  let retryDelayMs = 80

  try {
    ctx.effect(function () {
      return function () { disposed = true }
    })
  } catch (err) { /* 无 effect 能力时靠 disposed 兜底 */ }

  function registerRoute(webServer, routePath, resource) {
    try {
      const dispose = webServer.register({ kind: 'exact', path: routePath, resource: resource })
      state.routes.push(routePath)
      log('route registered: ' + routePath)
      return dispose
    } catch (err) {
      const detail = err && err.message ? err.message : String(err)
      log('route 注册失败 ' + routePath + '：' + detail)
      return null
    }
  }

  function onWebServer(webServer) {
    state.webServerAcquiredAt = new Date().toISOString()
    log('webServer acquired after ' + (Date.now() - startedAt) + 'ms')

    const disposers = []
    const routes = [
      [ROUTE_PREFIX + '/panel.js', assetResource('panel.js', 'application/javascript')],
      [ROUTE_PREFIX + '/panel.css', assetResource('panel.css', 'text/css')],
      [ROUTE_PREFIX + '/api/quotes', quotesResource(refreshMs)],
      [ROUTE_PREFIX + '/api/status', statusResource()],
      [ROUTE_PREFIX + '/api/mounted', mountedResource()],
      [ROUTE_PREFIX + '/api/diag', diagResource()],
    ]
    for (const [routePath, resource] of routes) {
      const dispose = registerRoute(webServer, routePath, resource)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
    log('routes ready: ' + state.routes.length + '/' + routes.length + ' 前缀 ' + ROUTE_PREFIX)

    try {
      ctx.effect(function () {
        return function () {
          for (const dispose of disposers) {
            try { dispose() } catch (err) { /* 忽略单条路由的回退失败 */ }
          }
          state.routes = []
        }
      })
    } catch (err) { /* 无 effect 能力时路由随进程结束 */ }

    // ---- 3) 自检（进程内，不依赖浏览器与 HTTP 令牌）----
    state.indexInjection = verifyIndexInjection(ctx, webServer)
    // 其他插件的注入监听可能比我们晚注册，2 秒后再验一次，取更完整的表
    try {
      const timer = setTimeout(function () {
        state.indexInjection = verifyIndexInjection(ctx, webServer)
      }, 2000)
      if (timer && typeof timer.unref === 'function') timer.unref()
    } catch (err) { /* 调度失败不影响主流程 */ }

    runSelfCheck(webServer).catch(function (err) {
      log('selfcheck 异常：' + (err && err.message ? err.message : String(err)))
    })
    scheduleQuotesSelfCheck(webServer)
  }

  function scheduleRetry() {
    const delay = retryDelayMs
    retryDelayMs = Math.min(500, Math.round(retryDelayMs * 1.6))
    try {
      const handle = setTimeout(tryStart, delay)
      if (handle && typeof handle.unref === 'function') handle.unref()
    } catch (err) {
      log('重试调度失败：' + (err && err.message ? err.message : String(err)))
    }
  }

  function tryStart() {
    if (started || disposed) return
    let webServer = null
    try {
      webServer = ctx.get('webServer')
    } catch (err) { /* 服务尚未发布 */ }

    if (webServer && typeof webServer.register === 'function') {
      started = true
      try {
        onWebServer(webServer)
      } catch (err) {
        log('挂载失败：' + (err && err.stack ? err.stack : String(err)))
      }
      return
    }
    if (Date.now() - startedAt < 30000) {
      scheduleRetry()
      return
    }
    log('webServer 30s 内始终不可用，面板未挂载（其余能力不受影响）')
  }

  tryStart()
}

const plugin = {
  name: PLUGIN_ID,
  // 不声明 inject：没有 Web 层的 profile 里也只是面板不可用，不应让整插件失效。
  // 只用全局 setTimeout 重试（不用 ctx.timeout，避免依赖 timer 混入）。
  apply: apply,
}

module.exports = plugin
module.exports.default = plugin
module.exports.apply = apply
module.exports.contributeIndexRows = contributeIndexRows
module.exports.PLUGIN_ID = PLUGIN_ID
module.exports.BUILD = BUILD
