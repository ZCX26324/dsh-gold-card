#!/usr/bin/env node
/**
 * tools/asar-probe.cjs —— 零依赖读取 app.asar（Electron asar 格式）
 *
 * 用途：DSH 桌面应用的内置包都在 app.asar 里（不是真实目录），
 * 排查 webServer / client-ui API 时需要按路径取文件或按内容搜索。
 *
 * 用法：
 *   node tools/asar-probe.cjs list <regex>                列出匹配的条目（含大小）
 *   node tools/asar-probe.cjs grep <fileRegex> <keyword> [maxFiles]
 *   node tools/asar-probe.cjs cat <path> [maxChars]       输出文件内容
 *
 * asar 文件结构：[u32=4][u32=headerBufLen][headerBuf: u32 payloadLen + u32 jsonLen + json][file data...]
 * 文件数据区起点 = 8 + headerBufLen，条目里的 offset 相对该起点。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ASAR = process.env.DSH_ASAR || 'D:\\deepseek harness\\resources\\app.asar'

function readAsar(file) {
  const fd = fs.openSync(file, 'r')
  const size = fs.fstatSync(fd).size
  const sizeBuf = Buffer.alloc(8)
  fs.readSync(fd, sizeBuf, 0, 8, 0)
  const headerBufLen = sizeBuf.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerBufLen)
  fs.readSync(fd, headerBuf, 0, headerBufLen, 8)
  const jsonLen = headerBuf.readUInt32LE(4)
  const json = JSON.parse(headerBuf.slice(8, 8 + jsonLen).toString('utf8'))
  const baseOffset = 8 + headerBufLen
  return { fd, size, header: json, baseOffset }
}

function walk(node, prefix, out) {
  if (!node || typeof node !== 'object') return
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walk(child, prefix ? prefix + '/' + name : name, out)
    }
    return
  }
  out.push({ path: prefix, size: node.size || 0, offset: node.offset, unpacked: !!node.unpacked })
}

function entries(archive) {
  const out = []
  walk(archive.header, '', out)
  return out
}

function readEntry(archive, entry) {
  const full = path.join(path.dirname(ASAR), 'app.asar.unpacked', entry.path)
  if (entry.unpacked) return fs.readFileSync(full)
  const buf = Buffer.alloc(entry.size)
  fs.readSync(archive.fd, buf, 0, entry.size, archive.baseOffset + Number(entry.offset))
  return buf
}

const [, , cmd, ...rest] = process.argv

if (cmd === 'list') {
  const re = new RegExp(rest[0] || '.', 'i')
  const archive = readAsar(ASAR)
  const hits = entries(archive).filter((e) => re.test(e.path))
  hits.sort((a, b) => a.path.localeCompare(b.path))
  for (const h of hits) console.log(String(h.size).padStart(9) + '  ' + h.path)
  console.log('---- total ' + hits.length + ' / asar size ' + archive.size)
} else if (cmd === 'grep') {
  const fileRe = new RegExp(rest[0] || '.', 'i')
  const keyword = rest[1]
  const maxFiles = Number(rest[2] || 200)
  if (!keyword) { console.error('need keyword'); process.exit(2) }
  const archive = readAsar(ASAR)
  const files = entries(archive)
    .filter((e) => fileRe.test(e.path) && e.size > 0 && e.size < 8 * 1024 * 1024)
    .slice(0, maxFiles)
  for (const f of files) {
    let buf
    try { buf = readEntry(archive, f) } catch (err) { continue }
    const text = buf.toString('utf8')
    if (!text.includes(keyword)) continue
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (line.includes(keyword)) {
        console.log(f.path + ':' + (i + 1) + ': ' + line.trim().slice(0, 300))
      }
    })
  }
} else if (cmd === 'cat') {
  const archive = readAsar(ASAR)
  const target = rest[0]
  const maxChars = Number(rest[1] || 40000)
  const entry = entries(archive).find((e) => e.path === target)
  if (!entry) { console.error('not found: ' + target); process.exit(1) }
  const buf = readEntry(archive, entry)
  process.stdout.write(buf.toString('utf8').slice(0, maxChars))
} else {
  console.error('usage: asar-probe.cjs list <regex> | grep <fileRegex> <keyword> [maxFiles] | cat <path> [maxChars]')
  process.exit(2)
}
