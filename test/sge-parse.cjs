#!/usr/bin/env node
/**
 * test/sge-parse.cjs —— 上金所分时 JSON 解析的确定性单元测试（离线、无网络）
 *
 * 针对 2026-11-07 实测踩到的两个坑：
 *   1. 未到时段是占位值：`data` 覆盖 20:00~次日15:30，但尚未发生的时点被同一个值填满
 *      （实测日盘 391 个点全是 863）。必须用 `now` 定位「最后一个已走到的时点」。
 *   2. `json.min/max` 与序列不一致（实测 865/873 vs 序列 865~873.96），高低价必须自己算。
 *
 * 用法：node test/sge-parse.cjs
 */
'use strict'

const { parseQuotations } = require('../lib/sge.cjs')

let fail = 0
const ok = (m) => console.log('  ✅ ' + m)
const bad = (m) => { fail += 1; console.error('  ❌ ' + m) }
const check = (cond, m) => (cond ? ok(m) : bad(m))
const eq = (a, b, m) => check(a === b, m + '（期望 ' + b + '，实际 ' + a + '）')

/** 构造一条完整交易日时间轴：20:00..02:30 + 09:00..15:30（共 782 点） */
function buildSeries({ nightValue, dayValue, nightLastValue, dayVary }) {
  const times = []
  const data = []
  const push = (h, m) => {
    const t = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
    times.push(t)
  }
  // 夜盘 20:00 -> 23:59
  for (let m = 20 * 60; m < 24 * 60; m += 1) push(Math.floor(m / 60), m % 60)
  // 00:00 -> 02:30
  for (let m = 0; m <= 2 * 60 + 30; m += 1) push(Math.floor(m / 60), m % 60)
  // 日盘 09:00 -> 15:30
  for (let m = 9 * 60; m <= 15 * 60 + 30; m += 1) push(Math.floor(m / 60), m % 60)

  const nightCount = 240 + 151 // 20:00..23:59 + 00:00..02:30
  for (let i = 0; i < times.length; i += 1) {
    if (i < nightCount) {
      // 夜盘做一条有起伏的序列：从 nightValue 缓慢爬升
      data.push((nightValue + (i % 10) * 0.5).toFixed(2))
    } else if (dayVary) {
      // 真实日盘：有小幅波动
      data.push((Number(dayValue) + (i % 9) * 0.1).toFixed(2))
    } else {
      // 未到时点：全部同一个占位值
      data.push(String(dayValue))
    }
  }
  // 让夜盘最后一点（02:30）有一个明确可断言的值
  data[nightCount - 1] = String(nightLastValue)
  if (dayVary) data[data.length - 1] = String(dayValue)
  return { times, data }
}

console.log('=== 上金所分时解析单元测试 ===')

// ---- 1) 夜盘已结束、日盘未开始：必须忽略日盘占位值 ----
console.log('1) now=08:28（夜盘后、日盘前，日盘是占位值）')
{
  const s = buildSeries({ nightValue: 868.57, dayValue: 863, nightLastValue: 873.6 })
  const r = parseQuotations({
    heyue: 'Au99.99', now: '08:28', delaystr: '2026年11月09日 02:29:54',
    times: s.times, data: s.data, min: 865, max: 873,
  })
  eq(r.last, 873.6, '最新价 = 夜盘最后一点，不是日盘占位值')
  eq(r.lastTime, '02:30', '最后时点 = 02:30')
  eq(r.dataMode, 'elapsed', '统计模式 = elapsed（只算已走时点）')
  eq(r.low, 868.57, '最低价只来自夜盘序列（不含占位值 863）')
  check(r.last >= r.low && r.last <= r.high, '最低 ≤ 最新 ≤ 最高 自洽（' + r.low + ' ≤ ' + r.last + ' ≤ ' + r.high + '）')
  check(r.high < 900, '最高价没有被占位值污染')
}

// ---- 2) 收盘后：应以 15:30 为准 ----
console.log('2) now=16:12（收盘后）')
{
  const s = buildSeries({ nightValue: 868.57, dayValue: 868.6, nightLastValue: 870, dayVary: true })
  const r = parseQuotations({
    heyue: 'Au99.99', now: '16:12', delaystr: '2026年11月06日 15:45:00',
    times: s.times, data: s.data, min: 860, max: 890,
  })
  eq(r.last, 868.6, '收盘后取 15:30 收盘价')
  eq(r.lastTime, '15:30', '最后时点 = 15:30')
}

// ---- 3) 日盘进行中：取当前时点 ----
console.log('3) now=10:00（日盘进行中）')
{
  const times = ['09:00', '09:01', '10:00', '10:01', '15:30']
  const data = ['860', '861', '862', '899', '899']
  const r = parseQuotations({
    heyue: 'Au99.99', now: '10:00', delaystr: '2026年11月10日 10:00:00',
    times: times, data: data, min: 850, max: 900,
  })
  eq(r.last, 862, '只统计到 10:00，不取 10:01 之后的未来数据')
  eq(r.high, 862, '最高价不包含未来时点')
}

// ---- 4) 缺失 now：退回全序列（并保证高低自洽） ----
console.log('4) 缺失 now（退化）')
{
  const s = buildSeries({ nightValue: 868.57, dayValue: 863, nightLastValue: 873.6 })
  const r = parseQuotations({ heyue: 'Au99.99', times: s.times, data: s.data })
  eq(r.dataMode, 'all', '无 now 时标记 all')
  check(r.last >= r.low && r.last <= r.high, '退化路径仍保证高低自洽')
}

// ---- 5) 品种不符必须报结构变更 ----
console.log('5) 品种不符')
{
  let threw = false
  try {
    parseQuotations({ heyue: 'Au100g', times: ['20:00'], data: ['1'] })
  } catch (err) {
    threw = /品种不符/.test(err.message)
  }
  check(threw, '品种不是 Au99.99 时抛「页面结构变更」')
}

// ---- 6) 周末：墙钟落在日盘时间窗内，但日盘并未开（占位值仍在） ----
// 2026-11-07（周六）真实的回归场景：now=15:07，delaystr 停在 11月09日 02:29:54，
// 日盘 391 个点全是 863。若只看 now 会把占位值当成已发生时点。
console.log('6) now=15:07（周六，日盘未开但墙钟在日盘窗内）')
{
  const s = buildSeries({ nightValue: 868.57, dayValue: 863, nightLastValue: 873.6 })
  const r = parseQuotations({
    heyue: 'Au99.99', now: '15:07', delaystr: '2026年11月09日 02:29:54',
    times: s.times, data: s.data, min: 865, max: 873,
  })
  eq(r.last, 873.6, '仍取夜盘最后成交价，不取日盘占位值')
  eq(r.lastTime, '02:30', '最后时点停在夜盘收盘 02:30')
  eq(r.placeholderCut, 391, '识别并丢弃 391 个日盘占位点')
  eq(r.low, 868.57, '最低价不受占位值影响')
}

console.log(fail === 0 ? '\n全部通过 ✅' : '\n' + fail + ' 项失败 ❌')
process.exit(fail === 0 ? 0 : 1)
