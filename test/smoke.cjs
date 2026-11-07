#!/usr/bin/env node
/**
 * test/smoke.cjs —— 四源连通性 + 数据层契约冒烟测试
 * 用法：node test/smoke.cjs   （npm run test:sources）
 * 退出码 0 = 四源全通且所有断言通过；非 0 = 有源失败或断言失败
 *
 * 覆盖：
 *   1. 四源连通（上金所 / 新浪 / 工行 / 建行）
 *   2. 已知解析陷阱：如意金 buyprice 必须 ÷100；上金所涨跌幅必须由昨收算出
 *   3. v3 新增契约块：freshness / crossCheck / premium 三块必须有值且枚举合法
 *   4. 60s 缓存：第二次调用命中缓存且不重新抓取
 */
'use strict'

const { fetchCards } = require('../lib/gold.cjs')

const CROSS_LABELS = {
  verified: '✅ 已交叉校验',
  info: 'ℹ️ 两产品价差',
  differ: '⚠️ 两源有差异',
  single: '⚠️ 仅单源',
  stale: '⚠️ 疑似陈旧快照',
}
const PREMIUM_BAND_LABELS = { account: '账户型积存金', bar: '实物金条' }

let fail = 0
const ok = (msg) => console.log('  ✅ ' + msg)
const bad = (msg) => { fail += 1; console.error('  ❌ ' + msg) }
const check = (cond, msg) => (cond ? ok(msg) : bad(msg))

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

function findField(card, label) {
  if (!card || !Array.isArray(card.fields)) return null
  return card.fields.find((f) => f && f.label === label) || null
}

;(async () => {
  const t0 = Date.now()
  console.log('=== dsh-gold-card 四源冒烟测试 ===')
  console.log('时间：' + new Date().toLocaleString('zh-CN'))

  let payload
  try {
    payload = await fetchCards()
  } catch (err) {
    console.error('聚合层异常：', err && err.message ? err.message : err)
    process.exit(1)
  }
  const ms = Date.now() - t0

  let okCount = 0
  const order = ['sge', 'intl', 'icbc', 'ccb']

  for (const k of order) {
    const c = payload.cards && payload.cards[k]
    if (!c) { console.log(`[FAIL] ${k}: 缺失`); bad(k + ' 卡片缺失'); continue }
    if (c.ok) okCount++
    console.log(`[${c.ok ? ' OK ' : 'FAIL'}] ${k.padEnd(6)} ${c.title}  ${c.quoteTime || ''}`)
    if (!c.ok) console.log(`        原因：${c.error}`)
  }

  // ---- 1) 四源连通 ----
  check(okCount === 4, `四源全部成功（${okCount}/4）`)
  check(isNum(payload.baseAu9999), `baseAu9999 为数字（${payload.baseAu9999}）`)

  for (const k of order) {
    const c = payload.cards[k]
    if (!c || !c.ok) continue
    check(typeof c.quoteTime === 'string' && c.quoteTime.length > 0,
      `${k} 使用源自带时间戳（${c.quoteTime}）`)
  }

  // ---- 2) 上金所：涨跌幅必须由昨收算出 ----
  const sge = payload.cards.sge
  if (sge.ok) {
    const pct = findField(sge, '涨跌幅')
    const prev = findField(sge, '昨收')
    check(isNum(pct && pct.value), `上金所涨跌幅为数字（${pct && pct.value}%）`)
    check(pct && (pct.tone === 'up' || pct.tone === 'down'), '上金所涨跌幅带 tone（up/down）')
    check(isNum(prev && prev.value), `上金所昨收已取到（${prev && prev.value}）`)
    const last = findField(sge, '最新价')
    const high = findField(sge, '最高')
    const low = findField(sge, '最低')
    check(isNum(last && last.value), '上金所最新价为数字')
    // 回归（2026-11-07 实测 bug）：不能采信 json.min/max（当时 865/873），
    // 否则会出现「最新价 863 低于最低价 865」这种自相矛盾的卡片。
    check(isNum(high && high.value) && isNum(low && low.value), '上金所最高/最低为数字')
    if (isNum(last && last.value) && isNum(high && high.value) && isNum(low && low.value)) {
      check(
        low.value <= last.value && last.value <= high.value,
        `上金所最新价落在最高/最低之间（${low.value} ≤ ${last.value} ≤ ${high.value}）`
      )
    }
  }

  // ---- 3) 国际金价：24h 涨跌必须由新浪昨收算出 ----
  const intl = payload.cards.intl
  if (intl.ok) {
    const pct = findField(intl, '24h涨跌')
    check(isNum(pct && pct.value), `国际金价 24h 涨跌为数字（${pct && pct.value}%）`)
    check(isNum(findField(intl, '最新价').value), '国际金价最新价为数字')
  }

  // ---- 4) 工行：如意金 ÷100 陷阱 + 两个产品 ----
  const icbc = payload.cards.icbc
  if (icbc.ok && Array.isArray(icbc.groups)) {
    const ruyi = icbc.groups.find((g) => g.name === '如意金积存')
    const acc = icbc.groups.find((g) => g.name === '积存金')
    check(!!ruyi, '工行有「如意金积存」分组')
    check(!!acc, '工行有「积存金」分组')
    if (ruyi) {
      const buy = (ruyi.fields.find((f) => f.label === '积存价') || {}).value
      check(isNum(buy) && buy >= 100 && buy <= 5000,
        `如意金积存价 ${buy}（已确认 ÷100，量级 890.15）`)
    }
    if (acc) {
      const buy = (acc.fields.find((f) => f.label === '主动积存价') || {}).value
      check(isNum(buy) && buy >= 100 && buy <= 5000,
        `积存金主动积存价 ${buy}（量级 871.21）`)
    }
  }

  // ---- 5) 建行：买入/赎回/中间价 ----
  const ccb = payload.cards.ccb
  if (ccb.ok) {
    check(isNum(findField(ccb, '买入价').value), `建行买入价为数字（${findField(ccb, '买入价').value}）`)
    check(isNum(findField(ccb, '赎回价').value), '建行赎回价为数字')
  }

  // ---- 6) freshness 契约 ----
  console.log('\n时效性（freshness）：')
  for (const k of order) {
    const c = payload.cards[k]
    if (!c) continue
    const f = c.freshness
    check(!!f && typeof f === 'object', `${k} 有 freshness 块`)
    if (!f) continue
    check(typeof f.fresh === 'boolean', `${k} freshness.fresh 为布尔（${f.fresh}）`)
    check(f.ageMinutes === null || isNum(f.ageMinutes),
      `${k} freshness.ageMinutes 为数字或 null（${f.ageMinutes}）`)
    check(f.note === null || typeof f.note === 'string',
      `${k} freshness.note 为字符串或 null`)
    console.log(
      `       ${k.padEnd(6)} fresh=${f.fresh} age=${f.ageMinutes == null ? '—' : f.ageMinutes + 'min'}` +
      (f.note ? ` note="${f.note}"` : '')
    )
  }

  // ---- 7) crossCheck 契约 ----
  console.log('\n交叉校验（crossCheck）：')
  const crossCards = [
    ['sge', payload.cards.sge.crossCheck],
    ['intl', payload.cards.intl.crossCheck],
    ['icbc', payload.cards.icbc.crossCheck],
    ['ccb', payload.cards.ccb.crossCheck],
  ]
  for (const [k, cross] of crossCards) {
    check(!!cross && typeof cross === 'object', `${k} 有 crossCheck 块`)
    if (!cross) continue
    check(!!CROSS_LABELS[cross.level], `${k} crossCheck.level 合法（${cross.level}）`)
    check(cross.label === CROSS_LABELS[cross.level], `${k} crossCheck.label 与 level 匹配（${cross.label}）`)
    check(typeof cross.detail === 'string' && cross.detail.length > 0, `${k} crossCheck.detail 非空`)
    console.log(`       ${k.padEnd(6)} ${cross.label}  ${cross.detail}`)
  }
  if (Array.isArray(icbc.groups)) {
    for (const g of icbc.groups) {
      check(!!g.crossCheck && !!CROSS_LABELS[g.crossCheck.level], `工行「${g.name}」分组有 crossCheck`)
    }
  }

  // ---- 8) premium 契约（双重反算 + 分带） ----
  console.log('\n溢价（premium，双重反算）：')
  const premiumItems = []
  if (Array.isArray(icbc.groups)) {
    for (const g of icbc.groups) {
      if (g.premium) premiumItems.push([`工行·${g.name}`, g.premium, g.name === '如意金积存' ? 'bar' : 'account'])
    }
  }
  if (ccb.premium) premiumItems.push(['建行积存金', ccb.premium, 'account'])
  check(premiumItems.length === 3, `三处溢价均有值（实际 ${premiumItems.length}）`)

  for (const [name, p, kind] of premiumItems) {
    check(isNum(p.premium), `${name} premium 为数字（${p.premium} 元/克）`)
    check(!!p.band && p.band.label === PREMIUM_BAND_LABELS[kind],
      `${name} 适用溢价带正确（${p.band && p.band.label}）`)
    check(typeof p.ok === 'boolean', `${name} premium.ok 为布尔（${p.ok}）`)
    check(!!p.checks && !!p.checks.current, `${name} 双重反算含「当前现价」基准`)
    console.log(
      `       ${name.padEnd(12)} 溢价 ${p.premium >= 0 ? '+' : ''}${p.premium} 元/克 ` +
      `带[${p.band.min},${p.band.max}] ok=${p.ok}` +
      (p.note ? `  note="${p.note}"` : '')
    )
    if (p.checks && p.checks.previous) {
      console.log(
        `        基准口径：现价基准溢价 ${p.checks.current.premium}（${p.checks.current.inBand ? '带内' : '越界'}）` +
        ` / 昨收基准溢价 ${p.checks.previous.premium}（${p.checks.previous.inBand ? '带内' : '越界'}）`
      )
    }
  }

  // ---- 9) 60s 缓存：第二次调用不应重新抓取 ----
  console.log('\n缓存自检：')
  const t1 = Date.now()
  const payload2 = await fetchCards()
  const ms2 = Date.now() - t1
  check(payload2.baseAu9999 === payload.baseAu9999,
    `60s 缓存命中 baseAu9999 一致（${payload2.baseAu9999}）`)
  check(ms2 < 1000, `第二次调用走缓存，耗时 ${ms2}ms（<1000ms）`)

  // ---- 汇总 ----
  console.log(`\n结果：${okCount}/4 源成功，耗时 ${ms}ms`)
  if (okCount < 4) {
    console.log('提示：某源失败时请检查是否遗漏 secureOptions=SSL_OP_LEGACY_SERVER_CONNECT')
  }
  if (fail > 0) {
    console.error(`${fail} 项断言失败 ❌`)
    process.exit(2)
  }
  if (okCount < 4) process.exit(2)
  console.log('全部通过 ✅')
})().catch((err) => {
  console.error('冒烟测试异常：', err && err.stack ? err.stack : err)
  process.exit(1)
})
