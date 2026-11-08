#!/usr/bin/env node
/**
 * tools/market-index.cjs —— 生成并校验 DSH 插件市场索引（format 1）
 *
 * DSH 的「插件页 → 发现」读取用户配置的索引源（一份 index.json），
 * 本脚本把本插件的某一个 commit 写成一条索引记录，并用 DSH 官方校验器
 * @deepseek-ai/dsh-plugin-market-index 校验输出（该包是可选依赖，只在本脚本里按需加载）。
 *
 * 用法：
 *   node tools/market-index.cjs                       # 用 HEAD 生成 market/index.json
 *   node tools/market-index.cjs --commit <40位SHA>     # 指定要登记的提交
 *   node tools/market-index.cjs --out <path>          # 指定输出路径
 *
 * 环境变量：
 *   DSH_MARKET_INDEX_MODULE  校验器模块路径（默认在临时目录里找，见 README）
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')

function argOf(flag, fallback) {
  const i = process.argv.indexOf(flag)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('-') ? v : fallback
}

function sh(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function currentCommit() {
  const want = argOf('--commit', '')
  const sha = want || sh(['rev-parse', 'HEAD'])
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('commit 必须是 40 位小写十六进制：' + sha)
  return sha
}

function repoUrl() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const fromPkg = pkg.repository && pkg.repository.url
  if (fromPkg) return fromPkg.replace(/^git\+/, '').replace(/\.git$/, '')
  const remote = sh(['remote', 'get-url', 'origin'])
  return remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
}

function buildIndex() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const url = repoUrl()
  const commit = currentCommit()
  // publishTimestamp：登记的提交的提交时间（Unix 秒，整数）
  // --timestamp 用于应急推送场景：远端 API 提交在本地 git 里还不存在，无法用 git show 取时间
  const tsArg = argOf('--timestamp', '')
  const ts = tsArg ? Number(tsArg) : Number(sh(['show', '-s', '--format=%ct', commit]))
  if (!Number.isFinite(ts) || ts <= 0) throw new Error('publishTimestamp 无效：' + ts)
  return {
    format: 1,
    title: { en: 'DSH Gold Card', zh: 'DSH 实时金价面板' },
    description: {
      en: 'Sidebar gold price panel for DeepSeek Harness: Shanghai Gold Exchange Au99.99, XAU/USD, ICBC 和 CCB savings gold quotes with cross-verification.',
      zh: 'DSH 侧边栏「黄金实时价格」面板：上金所 Au99.99、国际金价 XAU/USD、工行积存金/如意金、建行积存金的实时报价、溢价与交叉校验。'
    },
    metadata: {
      categories: {
        tools: { title: { en: 'Tools', zh: '工具' } },
        finance: { title: { en: 'Finance', zh: '金融行情' } }
      },
      labels: {
        sidebar: { title: { en: 'Sidebar', zh: '侧边栏' } },
        price: { title: { en: 'Live price', zh: '实时价格' } }
      }
    },
    plugins: [
      {
        name: pkg.name,
        title: { en: 'Gold Card', zh: '黄金实时价格' },
        description: { en: pkg.description, zh: pkg.description },
        author: 'ZCX26324',
        homepage: url + '#readme',
        repository: { url },
        metadata: {
          category: 'finance',
          labels: ['sidebar', 'price']
        },
        versions: [
          {
            version: pkg.version,
            publishTimestamp: ts,
            source: { type: 'git', url, commit },
            engines: { dsh: '>=0.2.0' }
          }
        ]
      }
    ]
  }
}

function validatorPath() {
  const candidates = [
    process.env.DSH_MARKET_INDEX_MODULE,
    process.env.DSH_MARKET_INDEX_MODULE && path.join(process.env.DSH_MARKET_INDEX_MODULE, 'lib/index.js'),
    'C:\\deepseek harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-plugin-market-index\\lib\\index.js'
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return require(c)
    } catch {
      /* 继续找下一个 */
    }
  }
  return null
}

function main() {
  const doc = buildIndex()
  const out = path.resolve(ROOT, argOf('--out', 'market/index.json'))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n')

  const v = validatorPath()
  if (!v || typeof v.parseMarketIndex !== 'function') {
    console.log('已写出 ' + path.relative(ROOT, out) + '（未找到官方校验器，跳过校验）')
    console.log('提示：npm i --prefix %TEMP%\\dsmki @deepseek-ai/dsh-plugin-market-index@0.2.1-rc.5，再设置 DSH_MARKET_INDEX_MODULE')
    return
  }
  const parsed = v.parseMarketIndex(doc, 'https://raw.githubusercontent.com/ZCX26324/dsh-gold-card/main/market/index.json')
  const plugin = parsed.plugins[0]
  console.log('校验通过 ✅ ' + plugin.name + ' ' + plugin.versions[0].version +
    ' commit=' + plugin.versions[0].source.commit.slice(0, 8))
  try {
    console.log('安装参数：' + JSON.stringify(v.marketInstallTarget(parsed, plugin.name, plugin.versions[0].version)))
  } catch (err) {
    // 0.2.1-rc.5 的导出签名与本机 DSH 内置版本不同：签名不符时只跳过这一行，校验结果不受影响
    console.log('（跳过安装参数预览：' + (err && err.message ? err.message : err) + '）')
  }
}

if (require.main === module) {
  try {
    main()
  } catch (err) {
    console.error('生成失败：' + (err && err.message ? err.message : err))
    if (err && err.path) console.error('违规路径：' + err.path + ' —— ' + err.reason)
    process.exit(1)
  }
}

module.exports = { buildIndex }
