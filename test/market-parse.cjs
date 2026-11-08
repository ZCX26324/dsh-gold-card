#!/usr/bin/env node
/**
 * test/market-parse.cjs —— 走势图 / 资讯的离线单元测试（不联网）
 *
 * 覆盖：
 *   1. 东方财富 K 线解析：乱序、非法行、重复日期、结构缺失
 *   2. 本周 / 本月窗口：锚定最后一根 K（夜盘所属交易日）、不足时退化、涨跌幅
 *   3. 走势兜底：主源失败时用上金所日行情，语义为 fallback=true 且不标 stale
 *   4. 五个资讯源解析：央行 / 统计局 / 上金所 / 美联储 RSS / 新浪
 *   5. 排序：官方优先、top3、同题去重、超过 7 天的处理
 *   6. 合并：没有新增时保留旧条目
 *   7. 日更缓存：同一天只抓一次、跨天再抓、失败不清档
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const market = require('../lib/market.cjs')
const news = require('../lib/news.cjs')

let fail = 0
const ok = (msg) => console.log('  ✅ ' + msg)
const bad = (msg) => { fail += 1; console.error('  ❌ ' + msg) }
const check = (cond, msg) => (cond ? ok(msg) : bad(msg))

function tmpHome(name) {
  const dir = path.join(os.tmpdir(), 'dsh-gold-test-' + name + '-' + process.pid)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// 1) parseKlines
// ---------------------------------------------------------------------------
console.log('=== 1) 东方财富 K 线解析 ===')
{
  const json = {
    data: {
      klines: [
        '2026-11-06,868.57,868.57,873.96,865.00,0,0',
        '2026-11-04,863.79,863.79,865.00,860.00,0,0',
        'bad,1,2,3,4',
        '2026-11-05,884.09,884.09,890.00,880.00,0,0',
        '2026-11-05,884.09,884.09,890.00,880.00,0,0',
        '2026-11-03,840.01,840.01,850.00,838.00,0,0',
      ],
    },
  }
  const rows = market.parseKlines(json)
  check(rows.length === 4, '丢弃非法行并去重（实际 ' + rows.length + ' 行）')
  check(
    rows.map((r) => r.date).join(',') === '2026-11-03,2026-11-04,2026-11-05,2026-11-06',
    '按日期升序'
  )
  check(rows[1].close === 863.79, 'close 字段解析正确')

  let threw = ''
  try { market.parseKlines({ data: {} }) } catch (err) { threw = err.message }
  check(/结构变更/.test(threw), '缺少 data.klines 时报「页面结构变更」')

  let threw2 = ''
  try { market.parseKlines({ data: { klines: ['x', 'y'] } }) } catch (err) { threw2 = err.message }
  check(/无有效/.test(threw2), '全部非法时报「无有效 K 线」')
}

// ---------------------------------------------------------------------------
// 2) buildRanges
// ---------------------------------------------------------------------------
console.log('=== 2) 本周 / 本月窗口 ===')
{
  // 11-09 是周日？不，2026-11-09 是周一。这里覆盖两种锚点：
  //   a) 最后一根是「夜盘所属交易日 11-09」（未来日期）
  //   b) 最后一根是上周五 11-06（已收盘）
  const rows = []
  const closes = {
    '2026-10-26': 830,
    '2026-10-27': 832,
    '2026-10-28': 835,
    '2026-10-29': 865.26,
    '2026-10-30': 854.76,
    '2026-11-02': 836.08,
    '2026-11-03': 840.01,
    '2026-11-04': 863.79,
    '2026-11-05': 884.09,
    '2026-11-06': 868.57,
    '2026-11-09': 874.0,
  }
  for (const [date, close] of Object.entries(closes)) rows.push({ date, close })

  const now = new Date('2026-11-08T04:00:00Z') // 北京时间 12:00，周日
  const ranges = market.buildRanges(rows, now)

  // 最后一根 11-09 是周一：本周只有它自己一根 -> 不足 2 根，退化为最近 5 个交易日
  check(ranges.week.points.length === 5, '本周只有 1 根时退化为近 5 个交易日')
  check(/近 5 个交易日/.test(ranges.week.note || ''), '退化时带「近 5 个交易日」说明')
  // 本月只有 6 个交易日（11-02..11-09），少于 8 个 → 退回近 22 个交易日（这里共 11 根）
  check(ranges.month.points.length === 11, '本月不足 8 个交易日时退化为近 22 个交易日（实际 ' + ranges.month.points.length + ' 根）')
  check(/本月交易日不足/.test(ranges.month.note || ''), '退化时带「本月交易日不足」说明')
  check(/夜盘所属交易日/.test(ranges.month.note || ''), '最后一根是未来日期时说明「夜盘所属交易日」')

  const weekFallback = market.buildRanges(rows.slice(0, 10), now) // 最后一根 11-06（周五）
  check(weekFallback.week.points.length === 5, '本周交易日不足时退化为近 5 个交易日')
  check(
    weekFallback.week.change.value === Math.round((868.57 - 836.08) * 100) / 100,
    '本周涨跌额 = 最后一根 - 第一根'
  )
  check(
    weekFallback.week.change.pct === Math.round(((868.57 - 836.08) / 836.08) * 10000) / 100,
    '本周涨跌幅按第一根收盘计算'
  )

  const monthFallback = market.buildRanges(rows.slice(0, 3), now) // 只有 3 根 -> 本月不足 5 根
  check(monthFallback.month.points.length === 3, '本月不足 5 根时退化为最近 22 个交易日（这里只有 3 根）')
  check(/本月|近 22/.test(monthFallback.month.note || ''), '退化时带口径说明')

  const empty = market.buildRanges([], now)
  check(empty.week === null && empty.month === null, '空数据返回 null 区间')
}

// ---------------------------------------------------------------------------
// 3) 走势兜底语义
// ---------------------------------------------------------------------------
console.log('=== 3) 走势兜底 ===')
;(async () => {
  market.resetCache()
  const fallbackRows = [
    { date: '2026-11-04', close: 863.79 },
    { date: '2026-11-05', close: 884.09 },
    { date: '2026-11-06', close: 868.57 },
  ]
  const chart = await market.fetchChart({
    fetchKlines: async () => { throw new Error('socket hang up') },
    fetchFallback: async () => fallbackRows,
    now: new Date('2026-11-08T04:00:00Z'),
  })
  check(chart.ok === true, '主源失败时兜底成功')
  check(chart.fallback === true, '标记 fallback=true')
  check(chart.stale === false, '兜底数据不标 stale（不是过期缓存）')
  check(chart.error === null, '兜底成功时不带 error')
  check(/上海黄金交易所/.test(chart.source), 'source 标注上金所日行情')
  check(/主源不可用/.test(chart.note || ''), 'note 说明主源不可用')
  check(chart.ranges.week.points.length === 3, '兜底数据也能算出本周序列')

  market.resetCache()
  let threw = false
  try {
    await market.fetchChart({
      fetchKlines: async () => { throw new Error('boom') },
      fetchFallback: async () => { throw new Error('also boom') },
      now: new Date('2026-11-08T04:00:00Z'),
    })
  } catch (err) { threw = true }
  check(!threw, '两源都失败也不抛异常（返回 ok:false）')

  // -------------------------------------------------------------------------
  // 4) 资讯解析
  // -------------------------------------------------------------------------
  console.log('=== 4) 资讯源解析 ===')
  const pbcHtml = `
    <a href="/goutongjiaoliu/113456/113469/2026110510330636555/index.html">中国人民银行决定上调金融机构外汇存款准备金率</a>
    <a href="/goutongjiaoliu/113456/113469/2026110409000000000/index.html">中国人民银行行长潘功胜会见摩根士丹利集团董事长彭泰德</a>`
  const pbc = news.parsePbcList(pbcHtml)
  check(pbc.length === 2, '央行列表解析出 2 条')
  check(pbc[0].publishedAt.slice(0, 10) === '2026-11-05', '央行日期来自 href')
  check(pbc[0].relevant === true, '外汇存款准备金率判为相关')
  check(pbc[1].relevant === false, '纯会见类新闻判为不相关')
  check(pbc[0].tier === 3, '央行 tier=3（官方）')

  const nbsHtml = `
    <a href="./202611/t20261103_1965738.html">2026年10月下旬流通领域重要生产资料市场价格变动情况</a>
    <a href="./202610/t20261030_1965700.html">社会事业全面发展 民生福祉取得新进步</a>`
  const nbs = news.parseNbsList(nbsHtml)
  check(nbs.length === 2, '统计局列表解析出 2 条')
  check(nbs[0].publishedAt.slice(0, 10) === '2026-11-03', '统计局日期来自 t2026mmdd_')
  check(nbs[0].relevant === true, '价格变动判为相关')
  check(nbs[1].relevant === false, '社会事业新闻判为不相关')

  const sgeHtml = `<a href="/jjsnotice/10007653"><span class="txt">关于山东招金金银精炼有限公司变更企业名称的通知</span><span class="fr">26-10-29</span></a>`
  const sge = news.parseSgeNotices(sgeHtml)
  check(sge.length === 1 && sge[0].publishedAt.slice(0, 10) === '2026-10-29', '上金所公告日期 26-10-29 -> 2026-10-29')
  check(sge[0].relevant === true, '上金所公告全部视为相关')

  const fedXml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Federal Reserve issues FOMC statement]]></title>
      <link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm</link>
      <pubDate>Wed, 28 Oct 2026 18:00:00 GMT</pubDate></item>
  </channel></rss>`
  const fed = news.parseFedRss(fedXml)
  check(fed.length === 1 && /FOMC/.test(fed[0].title), '美联储 RSS 解析 CDATA 标题')
  check(fed[0].relevant === true, '美联储货币政策条目视为相关')
  check(fed[0].publishedAt.slice(0, 10) === '2026-10-28', '美联储 RFC822 日期解析')

  const sinaHtml = `
    <a href="/money/nmetal/hjzx/2026-11-07/doc-abc.shtml">央行连续24个月买黄金！</a>
    <a href="https://video.sina.com.cn/p/123.html">视频：金价走势</a>
    <a href="/money/nmetal/hjzx/2026-11-06/doc-def.shtml">高盛大砍黄金目标价！美联储政策立场趋鹰</a>`
  const sina = news.parseSinaNews(sinaHtml)
  check(sina.length === 2, '新浪过滤视频链接（实际 ' + sina.length + '）')
  check(sina[0].url.startsWith('https://finance.sina.com.cn/'), '新浪 URL 绝对化')
  check(sina[0].tier === 1, '新浪 tier=1（媒体）')
  check(sina[0].category === 'policy', '新浪条目按标题分类（含「央行」归 policy）')

  const ranked = news.rankNews(
    [
      ...sina,
      { id: 'x1', title: '中国人民银行决定上调金融机构外汇存款准备金率', url: 'https://a', source: 'pbc', sourceName: '中国人民银行', tier: 3, category: 'policy', relevant: true, publishedAt: '2026-11-03T01:00:00.000Z' },
      { id: 'x2', title: '2026年10月下旬流通领域重要生产资料市场价格变动情况', url: 'https://b', source: 'nbs', sourceName: '国家统计局', tier: 3, category: 'inflation', relevant: true, publishedAt: '2026-11-03T01:00:00.000Z' },
    ],
    new Date('2026-11-08T04:00:00Z')
  )
  check(ranked.length === 4, '排序后总数 = 4（实际 ' + ranked.length + '）')
  check(ranked[0].tier === 3 && ranked[1].tier === 3, '官方条目排在媒体前面')
  check(ranked[2].tier === 1 && ranked[3].tier === 1, '媒体条目在后')
  check(news.rankNews([], new Date()).length === 0, '空列表排序返回空')

  const dedup = news.rankNews(
    [
      { id: 'a', title: '金价突破 4000 美元！', url: 'https://a', source: 'sina', sourceName: '新浪财经', tier: 1, category: 'gold', relevant: true, publishedAt: '2026-11-07T00:00:00.000Z' },
      { id: 'b', title: '金价突破4000美元！', url: 'https://b', source: 'pbc', sourceName: '中国人民银行', tier: 3, category: 'gold', relevant: true, publishedAt: '2026-11-07T00:00:00.000Z' },
    ],
    new Date('2026-11-08T04:00:00Z')
  )
  check(dedup.length === 1 && dedup[0].tier === 3, '同题去重保留官方来源')

  const oldItems = [
    ...sina,
    { id: 'old', title: '旧闻：黄金 ETF 持仓变化', url: 'https://c', source: 'sina', sourceName: '新浪财经', tier: 1, category: 'gold', relevant: true, publishedAt: '2026-01-01T00:00:00.000Z' },
  ]
  const allOld = news.rankNews(oldItems, new Date('2026-11-08T04:00:00Z'))
  check(allOld.length === 2, '超过 7 天的条目默认丢弃（实际 ' + allOld.length + '）')

  const onlyOld = news.rankNews([oldItems[2]], new Date('2026-11-08T04:00:00Z'))
  check(onlyOld.length === 1, '全部条目都过期时保留最新，不返回空')

  // 合并：没有新增 -> 原样
  const prev = ranked.slice(0, 3)
  const mergedNo = news.mergeNews(prev, ranked.slice(0, 3))
  check(mergedNo.changed === false && mergedNo.items.length === prev.length, '没有新增条目时原样返回')
  const mergedNew = news.mergeNews(prev, [sina[1]])
  check(mergedNew.changed === true && mergedNew.added === 1, '有新条目时合并并标记 changed')

  // -------------------------------------------------------------------------
  // 5) 日更缓存
  // -------------------------------------------------------------------------
  console.log('=== 5) 日更缓存 ===')
  const home = tmpHome('news')
  let calls = 0
  const providers = [
    {
      id: 'mock',
      name: '模拟官方',
      async fetch() {
        calls += 1
        return [
          { id: 'n1', title: '美联储宣布维持利率不变，关注通胀数据', url: 'https://x/1', source: 'mock', sourceName: '模拟官方', tier: 3, category: 'policy', relevant: true, publishedAt: '2026-11-08T01:00:00.000Z' },
          { id: 'n2', title: '黄金价格本周上涨 3.89%', url: 'https://x/2', source: 'mock', sourceName: '模拟官方', tier: 3, category: 'gold', relevant: true, publishedAt: '2026-11-08T01:00:00.000Z' },
          { id: 'n3', title: '央行连续 24 个月增持黄金', url: 'https://x/3', source: 'mock', sourceName: '模拟官方', tier: 3, category: 'gold', relevant: true, publishedAt: '2026-11-08T01:00:00.000Z' },
          { id: 'n4', title: '白银跟随金价走高', url: 'https://x/4', source: 'mock', sourceName: '模拟官方', tier: 3, category: 'gold', relevant: true, publishedAt: '2026-11-08T01:00:00.000Z' },
        ]
      },
    },
  ]

  const first = await news.fetchNews({ dshHome: home, now: new Date('2026-11-08T04:00:00Z'), providers })
  check(first.ok === true && first.items.length === 3, '首次抓取只返回 3 条')
  check(first.cached === false && calls === 1, '首次抓取调用了 provider')
  check(fs.existsSync(news.cachePath(home)), '写入 $DSH_HOME 缓存文件')

  const second = await news.fetchNews({ dshHome: home, now: new Date('2026-11-08T06:00:00Z'), providers })
  check(second.cached === true && calls === 1, '同一天第二次直接用缓存，不再抓取')
  check(second.items.length === 3, '缓存里仍是 3 条')

  // 跨天 + 没有新增：保留旧条目并提示
  const noNewProviders = [{ id: 'mock', name: '模拟官方', async fetch() { return [] } }]
  const third = await news.fetchNews({ dshHome: home, now: new Date('2026-11-09T04:00:00Z'), providers: noNewProviders })
  check(third.items.length === 3, '跨天没有新增时保留上次 3 条')
  check(third.stale === true, '没有新增时标记 stale')
  check(/暂无新增/.test(third.error || ''), '提示「今日暂无新增资讯」')

  // 抓取失败：旧条目不动
  const failProviders = [{ id: 'mock', name: '模拟官方', async fetch() { throw new Error('network down') } }]
  const fourth = await news.fetchNews({ dshHome: home, now: new Date('2026-11-10T04:00:00Z'), providers: failProviders })
  check(fourth.items.length === 3, '抓取失败时仍返回上次 3 条')
  check(fourth.stale === true, '抓取失败标记 stale')

  // 从未成功过：ok=false
  const emptyHome = tmpHome('news-empty')
  const fifth = await news.fetchNews({ dshHome: emptyHome, now: new Date('2026-11-08T04:00:00Z'), providers: failProviders })
  check(fifth.ok === false && fifth.items.length === 0, '无缓存且全部失败时 ok=false')

  // -------------------------------------------------------------------------
  console.log(fail === 0 ? '\n全部通过 ✅' : '\n' + fail + ' 项失败 ❌')
  process.exit(fail === 0 ? 0 : 1)
})().catch((err) => {
  console.error('自检异常：', err && err.stack ? err.stack : err)
  process.exit(1)
})
