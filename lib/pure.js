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
  apk: ['android', 'apk', 'adb', 'jadx', 'smali', 'dex', 'gradle', 'manifest', 'apktool', 'jeb', 'harmony'],
  mobile: ['frida', 'ios', 'dylib', 'macho', 'mach', 'objc', 'swift', 'plist', 'apple', 'keyed', 'asset',
    'catalog', 'builder', 'flutter', 'dart'],
  web: ['web', 'browser', 'pcap', 'packet', 'javascript', 'electron', 'webmcp', 'dom', 'tls', 'dns', 'websocket'],
  firmware: ['firmware', 'rom', 'uboot', '6502', 'nes', 'dos', 'signal', 'decoder', 'decoders'],
  native: ['native', 'pe', 'elf', 'mz', 'cab', 'dotnet', 'msi', 'coff', 'procedure', 'procedures', 'function',
    'functions', 'instruction', 'instructions', 'symbol', 'symbols', 'imports', 'exports', 'reference', 'references',
    'string', 'strings', 'decompile', 'address', 'addresses', 'comment', 'block', 'blocks', 'graph', 'xref', 'xrefs',
    'entry', 'disasm', 'binary', 'overview', 'segment', 'segments', 'byte', 'bytes', 'bookmark', 'bookmarks',
    'memory', 'loader', 'listing', 'analysis', 'document', 'documents', 'managed', 'rizin', 'cutter', 'gdb',
    'objdump', 'name', 'names'],
}

/** Domain of one catalogue entry, decided by whole name/title tokens (not substrings).
 *  Order matters: the specific platforms (apk / mobile / web) win over the generic native set. */
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

export { domainOf }

/** Per-domain wording for the read-only domain tools: what the domain is for, in task words. */
export const DOMAIN_META = {
  native: {
    slug: 'native',
    label: 'native（PE / ELF 可执行文件）',
    tasks: '反编译、反汇编、函数与交叉引用、导入导出、字符串、段与内存、调试器（gdb/rizin）',
    chain: 'open_binary → binary_overview → search_procedures → procedure_pseudo_code',
  },
  web: {
    slug: 'web',
    label: 'web（浏览器、JavaScript、抓包）',
    tasks: '抓包与 HTTP/TLS/DNS 解析、浏览器与 Electron 页面、JavaScript 源码与运行时',
    chain: '',
  },
  apk: {
    slug: 'apk',
    label: 'apk（Android 包、dex 与 adb）',
    tasks: '解包与 dex/smali、jadx 与 JEB 反编译、manifest 与资源、adb 设备调试',
    chain: '',
  },
  mobile: {
    slug: 'mobile',
    label: 'mobile（Frida、ObjC/Swift、Mach-O）',
    tasks: '运行时附加、ObjC/Swift 类与方法、dyld 与 dylib、Mach-O、plist 与 Apple 资源',
    chain: '',
  },
  firmware: {
    slug: 'firmware',
    label: 'firmware（固件与信号）',
    tasks: '固件解包、分区分析、信号解码器',
    chain: '',
  },
  通用: {
    slug: 'general',
    label: '通用（文件、文档、会话）',
    tasks: '打开与关闭文件、文档与工程管理、会话状态、证据包',
    chain: '',
  },
}

/** Catalogue entries of one domain. */
export function domainEntries(tools, key) {
  return tools.filter((tool) => domainOf(tool) === key)
}

/** Registered tool name for a domain key (`通用` → `rea_general`). */
export function domainToolName(key) {
  const meta = DOMAIN_META[key]
  return `rea_${meta === undefined ? 'general' : meta.slug}`
}

/** Body of one read-only domain tool. Pure so it can be tested without the host. */
export function renderDomainCatalog(tools, key, options = {}) {
  const meta = DOMAIN_META[key] ?? DOMAIN_META['通用']
  const version = typeof options.reaVersion === 'string' ? options.reaVersion : ''
  const filter = typeof options.filter === 'string' ? options.filter.trim().toLowerCase() : ''
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 40
  const inDomain = domainEntries(tools, key)
  const matched = inDomain.filter((tool) => {
    if (filter === '') return true
    const title = typeof tool.title === 'string' ? tool.title : ''
    return String(tool.name).toLowerCase().includes(filter) || title.toLowerCase().includes(filter)
  })
  const head = [`REA ${version} · ${meta.label} 域 ${inDomain.length} 个工具` +
    `${filter === '' ? '' : `，匹配 "${filter}" 的 ${matched.length} 个`}${options.fromCache === true ? '（缓存）' : ''}` +
    '（只读清单，不执行任何工具）']
  const lines = head
  for (const tool of matched.slice(0, limit)) {
    const title = typeof tool.title === 'string' && tool.title !== '' ? tool.title : '（无标题）'
    lines.push(`  ${tool.name} — ${title}`)
  }
  if (matched.length > limit) {
    lines.push(`…还有 ${matched.length - limit} 个未列出（加 filter=<关键词> 缩小范围）`)
  }
  if (filter !== '' && matched.length === 0) {
    lines.push(`本域没有匹配 "${filter}" 的工具；用 rea_tools filter="${filter}" 查全域。`)
  }
  lines.push('执行用 rea_call name=<工具名> arguments={...}；参数用 rea_help name=<工具名> 取。')
  if (meta.chain !== '') lines.push(`常用链路：${meta.chain}`)
  return lines.join('\n')
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
