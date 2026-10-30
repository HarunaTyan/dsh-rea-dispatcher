// Pure helpers: no DSH imports, so tests and tooling can load them without the host.
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const FOLD_CASE = process.platform === 'win32'

/** Lexical normalization, platform-agnostic: slashes, `.`/`..`, drive and UNC roots. */
export function normalizePath(value) {
  const text = String(value ?? '').trim().replace(/\\/g, '/')
  if (text === '') return ''
  const unc = text.startsWith('//')
  const drive = /^([a-z]:)(?:\/|$)/i.exec(text)
  const rooted = unc || text.startsWith('/') || drive !== null
  const parts = []
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // `..` never climbs past a drive root or `/`.
      const last = parts[parts.length - 1]
      if (parts.length > 0 && !/^[a-z]:$/i.test(last)) parts.pop()
      continue
    }
    parts.push(segment)
  }
  const prefix = unc ? '//' : drive !== null ? '' : rooted ? '/' : ''
  const joined = prefix + parts.join('/')
  if (joined === '') return ''
  return FOLD_CASE ? joined.toLowerCase() : joined
}

/** Segment-aware: `/data/proj2` must not pass for `/data/proj`. */
export function isAllowedCwd(cwd, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return true
  const raw = String(cwd ?? '').trim()
  if (raw === '') return false
  // A relative session cwd cannot be proven to sit inside an absolute entry.
  if (!/^([a-z]:|[\\/])/i.test(raw)) return false
  const target = normalizePath(raw)
  if (target === '') return false
  return allowed.some((entry) => {
    const text = String(entry ?? '').trim()
    if (text === '') return false
    // '/' (or '\\') means the whole filesystem on every platform.
    if (text === '/' || text === '\\') return true
    const base = normalizePath(text)
    if (base === '') return false
    return target === base || target.startsWith(base.endsWith('/') ? base : base + '/')
  })
}

/** Catalogue grouped by domain, largest group first; stable order inside a group. */
export function groupByDomain(tools) {
  const groups = new Map()
  for (const tool of tools) {
    const key = domainOf(tool)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(tool)
  }
  const ORDER = ['native', 'web', 'apk', 'mobile', 'firmware', '通用']
  return [...groups.entries()].sort((a, b) => {
    const left = ORDER.indexOf(a[0])
    const right = ORDER.indexOf(b[0])
    return (left < 0 ? ORDER.length : left) - (right < 0 ? ORDER.length : right)
  })
}

/** Join the text blocks of one MCP result, then cap them. */
export function renderResult(result, maxBytes) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const text = blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n')
  const fallback =
    text === '' ? JSON.stringify(result?.structuredContent ?? result ?? null, undefined, 2) ?? '' : text
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 20000
  if (fallback.length <= limit) return { text: fallback, truncated: false, total: fallback.length }
  return {
    text: `${fallback.slice(0, limit)}\n…[truncated: 原始 ${fallback.length} 字符，仅返回前 ${limit}]`,
    truncated: true,
    total: fallback.length,
  }
}

/** `session.header.cwd` of the calling agent, when the host exposes it. */
export function sessionCwd(exec) {
  const value = exec?.agent?.session?.header?.cwd
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Session cwd, else the host process cwd (tools also run without a session). */
/** Required property names from a JSON schema. */
export function requiredParams(schema) {
  const required = Array.isArray(schema?.required) ? schema.required : []
  return required.filter((name) => typeof name === 'string')
}

/** One-line warnings distilled from a tool description, most costly trap first. */
export function toolWarnings(description) {
  const text = String(description ?? '').toLowerCase()
  const warnings = []
  if (text.includes('file offset') || text.includes('falls back')) {
    warnings.push('`0x…` 若不是函数入口会退化成 file offset；先 procedure_info 拿入口再调用')
  }
  if (text.includes('absolute path')) warnings.push('路径必须是绝对路径')
  if (text.includes('tshark') || text.includes('capinfos')) {
    warnings.push('需要外部工具 tshark/capinfos 在 PATH 上')
  }
  return warnings
}

/** Drop the oldest spill files so the directory cannot grow without bound. */
async function pruneSpill(dir, keep) {
  if (!Number.isFinite(keep) || keep <= 0) return
  const names = (await readdir(dir)).filter((name) => name.endsWith('.txt'))
  if (names.length <= keep) return
  const sized = (
    await Promise.all(
      names.map(async (name) => {
        try {
          const info = await stat(join(dir, name))
          return { name, modified: info.mtimeMs }
        } catch {
          // A concurrent prune may have removed it already.
          return undefined
        }
      }),
    )
  ).filter((entry) => entry !== undefined)
  sized.sort((a, b) => a.modified - b.modified)
  for (const entry of sized.slice(0, sized.length - keep)) {
    await unlink(join(dir, entry.name)).catch(() => {})
  }
}

/** Write the untruncated text and report where it landed. */
export async function spillText(dir, toolName, text, keep = 50) {
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23) + '-' + process.pid.toString(36) + Math.random().toString(36).slice(2, 6)
  const safe = String(toolName).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60)
  const file = join(dir, `${safe}-${stamp}.txt`)
  await writeFile(file, text, 'utf8')
  await pruneSpill(dir, keep)
  return { file, chars: text.length, lines: text.split('\n').length }
}

/** True when an MCP result says the REA session lost its target. */
export function isSessionLost(result) {
  if (result?.isError !== true) return false
  const text = JSON.stringify(result)
  return /No app is open|no active (?:app|target)/i.test(text)
}

const DOMAIN_TOKENS = {
  apk: ['android', 'apk', 'jadx', 'smali', 'dex', 'gradle', 'manifest'],
  mobile: ['frida', 'ios', 'dylib', 'macho', 'mach', 'objc', 'swift'],
  web: ['web', 'browser', 'capture', 'packet', 'pcap', 'tshark', 'tcp', 'udp', 'tls', 'dns', 'websocket', 'dom', 'scenario', 'ui'],
  firmware: ['firmware', 'rom', 'uboot', '6502', 'nes', 'dos', 'arm64', 'arm', 'signal', 'decoder', 'decoders'],
  native: ['native', 'pe', 'elf', 'mz', 'cab', 'dotnet', 'msi', 'coff', 'procedure', 'procedures', 'function', 'functions',
    'instruction', 'symbol', 'symbols', 'imports', 'import', 'exports', 'export', 'reference', 'references', 'string', 'strings',
    'decompile', 'address', 'comment', 'block', 'blocks', 'graph', 'data', 'type', 'types', 'xref', 'xrefs', 'entry', 'disasm',
    'binary', 'overview', 'app', 'document', 'documents', 'segment', 'segments', 'byte', 'bytes', 'bookmark', 'bookmarks',
    'name', 'names', 'project', 'workspace', 'memory', 'loader', 'listing', 'analysis', 'open', 'close', 'save'],
}

/** Domain of one catalogue entry, decided by whole name/title tokens (not substrings). */
function domainOf(tool) {
  const tokens = `${tool?.name ?? ''} ${tool?.title ?? ''}`.toLowerCase().split(/[^a-z0-9]+/)
  const has = (key) => tokens.some((token) => DOMAIN_TOKENS[key].includes(token))
  if (has('apk')) return 'apk'
  if (has('mobile')) return 'mobile'
  if (has('web') && !tokens.includes('native')) return 'web'
  if (has('firmware')) return 'firmware'
  if (has('native')) return 'native'
  return '通用'
}

/** One-line inventory: how many catalogue entries each domain covers. */
export function domainSummary(tools) {
  const counts = new Map()
  for (const tool of tools) {
    const key = domainOf(tool)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key} ${count}`)
    .join(' · ')
}
