const { fetchCards } = require('../lib/gold.cjs')
;(async () => {
  const p = await fetchCards({ ttl: 1 })
  const out = { fetchedAt: p.fetchedAt, base: p.baseAu9999, baseDate: p.baseDate, note: p.note }
  out.cards = Object.fromEntries(Object.entries(p.cards).map(([k, c]) => [k, {
    ok: c.ok, stale: c.stale, quoteTime: c.quoteTime, session: c.session || null,
    cross: c.crossCheck && { level: c.crossCheck.level, detail: c.crossCheck.detail },
    freshness: c.freshness,
    premium: c.premium ? { v: c.premium.premium, ok: c.premium.ok, stale: c.premium.stale, note: c.premium.note } : null,
    timeNote: c.timeNote || null,
    fields: (c.fields || []).map(f => f.label + '=' + f.value),
    groups: (c.groups || []).map(g => ({ name: g.name, cross: g.crossCheck.level, premium: g.premium && { v: g.premium.premium, ok: g.premium.ok, stale: g.premium.stale } })),
  }]))
  console.log(JSON.stringify(out, null, 2))
})().catch(e => { console.error('FAIL', e); process.exit(1) })

