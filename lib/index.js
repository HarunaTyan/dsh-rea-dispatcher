// REA dispatcher: the 200+ rea-agents MCP tools, three calls at a time.
// Mounting REA's MCP server directly costs ~775 KB of tool schemas per request;
// this plugin exposes rea_tools (names) → rea_help (one schema) → rea_call.
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import {
  ReaMcp,
  loadCatalog,
  nearestNames,
  resolveCachePath,
  resolveChildCwd,
  resolveGhidraDir,
  resolveJavaHome,
  resolveReaMjs,
  resolveDshHome,
} from './rea-client.js'

export const name = 'dsh-rea-dispatcher'
export const inject = ['tools']

// Empty string = resolve from the environment; no machine path is shipped.
export const Config = Schema.object({
  reaMjs: Schema.string()
    .default('')
    .description('rea-agents 的 scripts/rea.mjs 绝对路径。空 = 自动探测（REA_MJS → 已装 rea-agents → npm 全局）。'),
  ghidraDir: Schema.string()
    .default('')
    .description('注入子进程的 GHIDRA_INSTALL_DIR。空 = 用同名环境变量；都没有则不注入。'),
  javaHome: Schema.string()
    .default('')
    .description('注入子进程的 JAVA_HOME，并把其 bin 前置进 PATH。空 = 用同名环境变量；都没有则不注入。'),
  childCwd: Schema.string()
    .default('')
    .description('REA 子进程的工作目录。空 = 系统临时目录。'),
  cachePath: Schema.string()
    .default('')
    .description('tools/list 缓存（带 reaVersion，升级 REA 后自动失效）。空 = <DSH_HOME>/rea-dispatcher-cache.json。'),
  cwdAllow: Schema.array(Schema.string())
    .default([])
    .description('允许调用 REA 的会话目录白名单；空数组 = 不限制（按路径段比较，不做前缀匹配）。'),
  callTimeoutMs: Schema.number()
    .default(300000)
    .description('单次 rea_call 的超时（毫秒）。'),
  listTimeoutMs: Schema.number()
    .default(120000)
    .description('握手与 tools/list 的超时（毫秒）。'),
  maxBytes: Schema.number()
    .default(20000)
    .description('rea_call 返回文本的默认上限（字符数），超出截断并标注 truncated。'),
  autoReopen: Schema.boolean()
    .default(true)
    .description('rea_call 遇到「会话已断开」（No app is open）时，自动重新 open_binary 并重试一次。'),
  spill: Schema.boolean()
    .default(true)
    .description('rea_call 结果超过 maxBytes 时把全文落盘，只返回路径与前 maxBytes 字符；用文件工具分段读，信息不丢。'),
  spillDir: Schema.string()
    .default('')
    .description('落盘目录。空 = <DSH_HOME>/rea-spill。'),
  spillKeep: Schema.number()
    .default(50)
    .description('落盘文件保留个数，超出按修改时间删最旧的。'),
  helpMaxChars: Schema.number()
    .default(12000)
    .description('rea_help 返回的字符上限；个别工具的 schema 有 4 万字符。'),
})

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
export function executionCwd(exec) {
  return sessionCwd(exec) ?? process.cwd()
}

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

export function apply(ctx, config) {
  const reaMjs = resolveReaMjs(config.reaMjs)
  const cachePath = config.cachePath !== '' ? config.cachePath : resolveCachePath()
  const client = new ReaMcp({
    reaMjs,
    ghidraDir: resolveGhidraDir(config.ghidraDir),
    javaHome: resolveJavaHome(config.javaHome),
    cwd: resolveChildCwd(config.childCwd),
    callTimeoutMs: config.callTimeoutMs,
    listTimeoutMs: config.listTimeoutMs,
  })

  // The child is long-lived; unload must kill it.
  ctx.effect(() => () => client.close(), 'rea-mcp-client')

  let catalogPromise
  function catalog(force = false) {
    if (catalogPromise === undefined || force) {
      catalogPromise = loadCatalog(client, { cachePath, reaMjs, force }).catch((error) => {
        catalogPromise = undefined
        throw error
      })
    }
    return catalogPromise
  }

  const unauthorized = (exec) => {
    if (!Array.isArray(config.cwdAllow) || config.cwdAllow.length === 0) return undefined
    const cwd = sessionCwd(exec)
    // A restricted allow-list must not guess: no session cwd means no proof.
    if (cwd === undefined) {
      return [
        '取不到会话目录（session.header.cwd），而 Config.cwdAllow 非空 ⇒ 拒绝。',
        '要么在正常会话里调用，要么把 Config.cwdAllow 设为空数组（不限制）。',
      ].join('\n')
    }
    if (isAllowedCwd(cwd, config.cwdAllow)) return undefined
    return [
      `当前目录未授权：${cwd}`,
      `rea_* 工具仅在 ${config.cwdAllow.join('、')} 下可用。`,
      '要么在允许的目录里开会话，要么由用户调整 Config.cwdAllow（空数组 = 不限制）。',
    ].join('\n')
  }

  // Last successful open_binary per agent, so a dropped session can be reopened.
  const lastOpen = new Map()

  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  }

  ctx.tools.register(
    defineTool({
      name: 'rea_tools',
      description:
        '列出 REA（Ghidra 反汇编后端）可用的工具名与标题。三段式的第一步：先 rea_tools 找名字，再 rea_help 取单个工具的 schema，' +
        '最后 rea_call 调用。不要凭猜测调用不存在的工具。覆盖 native（PE/ELF/Mach-O）、web、apk、firmware、mobile 五个域；' +
        '常用链路 open_binary → binary_overview → search_procedures → procedure_pseudo_code，按域过滤用 filter=native 这类词。',
      parameters: {
        filter: {
          type: 'string',
          description: '可选，按工具名或标题的子串过滤（不区分大小写）。',
        },
        limit: {
          type: 'integer',
          description: '可选，最多返回多少条（默认 80，上限为工具总数）。',
        },
      },
      output: textOutput,
      async execute(args, exec) {
        const denied = unauthorized(exec)
        if (denied !== undefined) return denied
        const { tools, reaVersion, fromCache } = await catalog()
        const filter = typeof args.filter === 'string' ? args.filter.trim().toLowerCase() : ''
        const matched = tools.filter((tool) => {
          if (filter === '') return true
          const title = typeof tool.title === 'string' ? tool.title : ''
          return String(tool.name).toLowerCase().includes(filter) || title.toLowerCase().includes(filter)
        })
        const rawLimit = Number.isFinite(args.limit) ? Math.floor(args.limit) : 80
        const limit = Math.max(1, Math.min(rawLimit, tools.length))
        const shown = matched.slice(0, limit)
        const lines = [
          `REA ${reaVersion} 共 ${tools.length} 个工具${
            filter === '' ? '' : `，匹配 "${filter}" 的 ${matched.length} 个`
          }${fromCache ? '（缓存）' : '（刚拉取）'}`,
          ...shown.map(
            (tool) =>
              `${tool.name} — ${typeof tool.title === 'string' && tool.title !== '' ? tool.title : '（无标题）'}`,
          ),
        ]
        if (matched.length > shown.length) {
          lines.push(`…还有 ${matched.length - shown.length} 个未列出（提高 limit 或加 filter）`)
        }
        lines.push(`覆盖：${domainSummary(tools)}（按名称/标题归类，仅作索引，不是精确统计）`)
        lines.push('下一步：rea_help name=<工具名> 取参数 schema，然后 rea_call；按域找工具用 filter=native / web / apk / firmware / mobile。')
        // First fresh fetch with no filter: say what this is, so a user who just
        // installed from the market does not have to read the README first.
        if (!fromCache && filter === '' && args.limit === undefined) {
          lines.unshift(
            '用法：rea_tools filter=<关键词> 找名字 → rea_help name=<工具名> 看必填与陷阱 → rea_call name=<工具名> arguments={...} 执行。',
            '不要猜工具名；参数以 rea_help 的 schema 为准。默认不限制会话目录，需要限制时由用户配 Config.cwdAllow。',
            '',
          )
        }
        return lines.join('\n')
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rea_help',
      description:
        '取 REA 单个工具的完整说明与参数 schema（含必填项）。三段式的第二步：rea_tools 之后、rea_call 之前调用。',
      parameters: {
        name: {
          type: 'string',
          required: true,
          description: '工具名，例如 inspect_native_load_image。',
        },
      },
      output: textOutput,
      async execute(args, exec) {
        const denied = unauthorized(exec)
        if (denied !== undefined) return denied
        const { tools } = await catalog()
        const wanted = args.name.trim()
        const tool = tools.find((candidate) => candidate.name === wanted)
        if (tool === undefined) {
          const suggestions = nearestNames(
            tools.map((candidate) => candidate.name),
            wanted,
            5,
          )
          return [
            `未找到工具 "${wanted}"。`,
            `最相近的 ${suggestions.length} 个：`,
            ...suggestions.map((suggestion) => `- ${suggestion}`),
            '用 rea_tools filter=<关键词> 可以看全部候选。',
          ].join('\n')
        }
        const description = typeof tool.description === 'string' ? tool.description : '（无）'
        const schemaJson = JSON.stringify(tool.inputSchema ?? {}, undefined, 2)
        const required = requiredParams(tool.inputSchema)
        const head = [`# ${tool.name}`, '']
        if (typeof tool.title === 'string' && tool.title !== '') head.push(`标题：${tool.title}`)
        head.push(`必填：${required.length === 0 ? '无' : required.join(', ')}`)
        for (const warning of toolWarnings(description)) head.push(`⚠️ ${warning}`)
        const render = (desc) => [...head, '', '## 说明', desc, '', '## 参数 schema', schemaJson].join('\n')
        // outputSchema is skipped on purpose: some are 40 KB and rea_call shows the real payload.
        const limit = Number.isFinite(config.helpMaxChars) ? config.helpMaxChars : 12000
        const full = render(description)
        if (full.length <= limit) return full
        // The description is the elastic part: trim it before the schema loses structure.
        const room = limit - render('').length - 40
        if (room > 0) {
          const trimmed = render(`${description.slice(0, room)}…[说明已截断，schema 完整]`)
          if (trimmed.length <= limit) return trimmed
        }
        return `${render('（说明过长已省略）').slice(0, limit)}\n…[truncated: 该工具的 schema 本身 ${schemaJson.length} 字符，超出 helpMaxChars=${limit}，必填项可能被切掉；调大它可看全文]`
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rea_call',
      description:
        '调用一个 REA 工具（arguments 原样透传给 REA）。三段式的第三步：先用 rea_tools/rea_help 确认名字与参数。' +
        '不确定该用哪个工具时，先 rea_tools（filter=native 之类的域词能缩小范围）。返回文本超过 maxBytes 会截断并标注 truncated。',
      parameters: {
        name: {
          type: 'string',
          required: true,
          description: '工具名，必须来自 rea_tools/rea_help 的列表。',
        },
        arguments: {
          type: 'object',
          additionalProperties: true,
          description: '可选，透传给该工具的参数对象（按 rea_help 给出的 schema 填）。',
        },
        maxBytes: {
          type: 'integer',
          description: `可选，返回文本上限（字符数），默认 ${config.maxBytes}。`,
        },
      },
      output: textOutput,
      async execute(args, exec) {
        const denied = unauthorized(exec)
        if (denied !== undefined) return denied
        const { tools } = await catalog()
        if (!tools.some((candidate) => candidate.name === args.name)) {
          return `未找到工具 "${args.name}"：先 rea_tools 查名字，再用 rea_help 取 schema。`
        }
        const rawArgs = args.arguments
        const toolArguments =
          rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}
        let result = await client.callTool(args.name, toolArguments, config.callTimeoutMs)
        const maxBytes = Number.isFinite(args.maxBytes) ? args.maxBytes : config.maxBytes
        const sessionKey = exec?.agent?.id ?? 'default'
        if (args.name === 'open_binary' && isSessionLost(result) !== true && result?.isError !== true) {
          lastOpen.set(sessionKey, toolArguments)
        }
        let reopened = false
        if (isSessionLost(result) && config.autoReopen && args.name !== 'open_binary') {
          const previous = lastOpen.get(sessionKey)
          if (previous !== undefined) {
            try {
              await client.callTool('open_binary', previous, config.callTimeoutMs)
              reopened = true
            } catch {
              // keep the original failure; the caller still sees the REA error
            }
          }
        }
        if (reopened) {
          try {
            result = await client.callTool(args.name, toolArguments, config.callTimeoutMs)
          } catch {
            // fall through with the original error result
          }
        }
        const { text, truncated } = renderResult(result, maxBytes)
        const reopenNote = reopened ? '\n\n[REA 会话已断开（No app is open），已自动重新 open_binary 并重试一次]' : ''
        let note = ''
        if (truncated && config.spill) {
          const dir = config.spillDir !== '' ? config.spillDir : join(resolveDshHome(), 'rea-spill')
          try {
            const full = renderResult(result, Number.MAX_SAFE_INTEGER).text
            const spilled = await spillText(dir, args.name, full, config.spillKeep)
            note =
              `\n\n[全文已落盘：${spilled.file}（${spilled.chars} 字符 / ${spilled.lines} 行）。` +
              '用 ops_read_files 或 ops_grep 分段读，不必再调一次 rea_call]'
          } catch (error) {
            note = `\n\n[全文落盘失败：${error.message}]`
          }
        }
        if (result?.isError === true) {
          const hint = /no loaded source mapping|file offset/i.test(text)
            ? '\n提示：该 0x 不是函数入口，先用 procedure_info 拿到入口地址再反编译。'
            : ''
          return `REA 返回错误（原样透传，未改写）：\n${text}${hint}${note}${reopenNote}`
        }
        return text + note + reopenNote
      },
    }),
  )
}
