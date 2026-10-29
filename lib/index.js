// REA dispatcher: the 200+ rea-agents MCP tools, three calls at a time.
// Mounting REA's MCP server directly costs ~775 KB of tool schemas per request;
// this plugin exposes rea_tools (names) → rea_help (one schema) → rea_call.
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
  helpMaxChars: Schema.number()
    .default(12000)
    .description('rea_help 返回的字符上限；个别工具的 schema 有 4 万字符。'),
})

export function normalizePath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** Segment-aware on purpose: `/data/proj2` must not pass for `/data/proj`. */
export function isAllowedCwd(cwd, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return true
  const target = normalizePath(cwd)
  if (target === '') return false
  return allowed.some((entry) => {
    const base = normalizePath(entry)
    return base !== '' && (target === base || target.startsWith(base + '/'))
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

/** Session cwd for the allow-list check. */
export function executionCwd(exec) {
  const fromAgent = exec?.agent?.session?.header?.cwd
  return typeof fromAgent === 'string' && fromAgent !== '' ? fromAgent : process.cwd()
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
    const cwd = executionCwd(exec)
    if (isAllowedCwd(cwd, config.cwdAllow)) return undefined
    return [
      `当前目录未授权：${cwd}`,
      `rea_* 工具仅在 ${config.cwdAllow.join('、')} 下可用。`,
      '要么在允许的目录里开会话，要么由用户调整 Config.cwdAllow（空数组 = 不限制）。',
    ].join('\n')
  }

  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  }

  ctx.tools.register(
    defineTool({
      name: 'rea_tools',
      description:
        '列出 REA（Ghidra 反汇编后端）可用的工具名与标题。三段式的第一步：先 rea_tools 找名字，再 rea_help 取单个工具的 schema，最后 rea_call 调用。不要凭猜测调用不存在的工具。',
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
        lines.push('下一步：rea_help name=<工具名> 取参数 schema，然后 rea_call。')
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
        const parts = [`# ${tool.name}`, '']
        if (typeof tool.title === 'string' && tool.title !== '') parts.push(`标题：${tool.title}`)
        parts.push('', '## 说明', typeof tool.description === 'string' ? tool.description : '（无）')
        parts.push('', '## 参数 schema', JSON.stringify(tool.inputSchema ?? {}, undefined, 2))
        // outputSchema is skipped on purpose: some are 40 KB and rea_call shows the real payload.
        const text = parts.join('\n')
        const limit = Number.isFinite(config.helpMaxChars) ? config.helpMaxChars : 12000
        if (text.length <= limit) return text
        return `${text.slice(0, limit)}\n…[truncated: 该工具说明原始 ${text.length} 字符，仅返回前 ${limit}；调大 Config.helpMaxChars 可看全文]`
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'rea_call',
      description:
        '调用一个 REA 工具（arguments 原样透传给 REA）。三段式的第三步：先用 rea_tools/rea_help 确认名字与参数。返回文本超过 maxBytes 会截断并标注 truncated。',
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
        const result = await client.callTool(args.name, toolArguments, config.callTimeoutMs)
        const maxBytes = Number.isFinite(args.maxBytes) ? args.maxBytes : config.maxBytes
        const { text, truncated, total } = renderResult(result, maxBytes)
        if (result?.isError === true) return `REA 返回错误（原样透传，未改写）：\n${text}`
        return truncated ? `${text}\n\n[truncated: 全文 ${total} 字符；需要更多请调大 maxBytes]` : text
      },
    }),
  )
}
