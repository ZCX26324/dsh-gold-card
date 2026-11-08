#!/usr/bin/env node
/**
 * test/apply-smoke.cjs —— 用 mock ctx 验证 apply() 挂载是否正确（离线，不联网）
 *
 * 按 DSH 真实 API 建模：
 *   ctx.get('webServer') -> { register({kind,path,resource}), readResource(Request) }
 *   ctx.effect(fn)       -> 立即执行 fn()，登记其返回的 disposer
 *   ctx.on(event, fn)    -> 登记监听，返回 unsubscriber
 *   'webserver/index-inject' 事件 -> 传入 table，插件往 table.push 注入行
 *
 * 断言：
 *   1. 七条路由全部注册（panel.js / panel.css / api/quotes / api/extras /
 *      api/status / api/mounted / api/diag）
 *   2. index-inject 行是 script/body，引用 panel.js 与 panel.css，并带重试逻辑
 *   3. 静态资源在进程内可服务（readResource 返回 200 且字节数正常）
 *   4. API 路由返回 JSON（quotes 只验证形状，不联网）
 *   5. dispose 后路由被摘掉
 */
'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

// 日志写到临时目录，别在仓库里留测试产物
process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-gold-card-test-home')

const plugin = require('../lib/index.cjs')

let fail = 0
const ok = (msg) => console.log('  ✅ ' + msg)
const bad = (msg) => { fail += 1; console.error('  ❌ ' + msg) }
const check = (cond, msg) => (cond ? ok(msg) : bad(msg))

// ---- mock ctx / webServer ----
const registered = new Map()
const listeners = new Map()
const disposers = []

const webServer = {
  register(route) {
    if (registered.has(route.path)) throw new Error('duplicate route ' + route.path)
    registered.set(route.path, route)
    return () => registered.delete(route.path)
  },
  async readResource(request) {
    const pathname = new URL(request.url).pathname
    const route = registered.get(pathname)
    if (!route) return new Response(null, { status: 404 })
    if (!route.resource) return new Response(null, { status: 404 })
    return route.resource(request, undefined)
  },
  // 桌面壳用完全相同的调用取注入表，插件会据此自检
  collectIndexInjections(peer) {
    const table = []
    const listener = listeners.get('webserver/index-inject')
    if (typeof listener === 'function') listener(table, peer)
    return table
  },
}

const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  on(event, listener) {
    listeners.set(event, listener)
    return () => listeners.delete(event)
  },
  get(name) {
    return name === 'webServer' ? webServer : undefined
  },
}

console.log('=== apply() 冒烟（真实 API 形状）===')

plugin.apply(ctx, { refreshMs: 45000 })

// ---- 1) 路由 ----
console.log('注册路由：')
for (const p of registered.keys()) console.log('  ' + p)
const need = [
  '/dsh-gold/panel.js',
  '/dsh-gold/panel.css',
  '/dsh-gold/api/quotes',
  '/dsh-gold/api/extras',
  '/dsh-gold/api/status',
  '/dsh-gold/api/mounted',
  '/dsh-gold/api/diag',
]
for (const p of need) check(registered.has(p), '路由存在 ' + p)

// ---- 2) index 注入行 ----
console.log('index 注入行：')
const table = []
const listener = listeners.get('webserver/index-inject')
check(typeof listener === 'function', '已监听 webserver/index-inject')
if (typeof listener === 'function') {
  listener(table, {})
  check(table.length === 1, '贡献了 1 行注入（实际 ' + table.length + '）')
  const row = table[0] || {}
  console.log('  [0] kind=' + row.kind + ' placement=' + row.placement + ' len=' + (row.text || '').length)
  check(row.kind === 'script', '注入行 kind=script')
  check(row.placement === 'body', '注入行 placement=body')
  check(String(row.text).includes('/dsh-gold/panel.js'), '注入行引用 panel.js')
  check(String(row.text).includes('/dsh-gold/panel.css'), '注入行引用 panel.css')
  check(String(row.text).includes('tries'), '注入行带重试逻辑')
  check(!String(row.text).includes('script-src'), '未使用 script-src（不会阻塞应用启动）')

  // 同一张表再 emit 一次不应重复贡献
  listener(table, {})
  check(table.length === 1, '同一张表不会重复注入')
}

// ---- 3) 静态资源进程内可服务 ----
;(async () => {
  console.log('静态资源自检（readResource）：')
  for (const [p, mustContain] of [
    ['/dsh-gold/panel.js', 'dsh-gold'],
    ['/dsh-gold/panel.css', 'dsh-gold'],
  ]) {
    const res = await webServer.readResource(new Request('http://x' + p))
    const body = await res.text()
    check(res.status === 200, p + ' 返回 200（实际 ' + res.status + '）')
    check(body.length > 500, p + ' 字节数正常（' + body.length + '）')
    check(body.includes(mustContain), p + ' 内容含 "' + mustContain + '"')
  }

  // ---- 4) API 路由 ----
  console.log('API 自检：')
  const statusRes = await webServer.readResource(new Request('http://x/dsh-gold/api/status'))
  const statusBody = await statusRes.text()
  check(statusRes.status === 200, '/api/status 返回 200')
  let statusJson = null
  try { statusJson = JSON.parse(statusBody) } catch (err) { /* 下面报错 */ }
  check(!!statusJson && statusJson.plugin === 'dsh-gold-card', '/api/status 返回插件自述')
  check(!!statusJson && Array.isArray(statusJson.routes) && statusJson.routes.length === 7, '/api/status 报告 7 条路由')
  check(
    !!statusJson && statusJson.indexInjection && statusJson.indexInjection.ours === 1,
    '/api/status 证明自举行已在注入表里（indexInjection.ours=1）'
  )

  const mountedRes = await webServer.readResource(
    new Request('http://x/dsh-gold/api/mounted?href=http://127.0.0.1:50653/&proto=http:')
  )
  const mountedJson = JSON.parse(await mountedRes.text())
  check(mountedJson.href === 'http://127.0.0.1:50653/', '/api/mounted 记录面板挂载报告')

  // ---- 5) dispose ----
  console.log('dispose 自检：')
  for (const dispose of disposers.slice()) {
    try { dispose() } catch (err) { /* ignore */ }
  }
  check(registered.size === 0, 'dispose 后路由全部摘除（剩余 ' + registered.size + '）')

  // ---- 汇总 ----
  const assets = ['assets/panel.js', 'assets/panel.css']
  assets.forEach((a) => {
    const p = path.join(__dirname, '..', a)
    check(fs.existsSync(p), '资源存在 ' + a + '（' + (fs.existsSync(p) ? fs.statSync(p).size : 0) + ' bytes）')
  })

  console.log(fail === 0 ? '\n全部通过 ✅' : '\n' + fail + ' 项失败 ❌')
  process.exit(fail === 0 ? 0 : 1)
})().catch((err) => {
  console.error('自检异常：', err && err.stack ? err.stack : err)
  process.exit(1)
})
