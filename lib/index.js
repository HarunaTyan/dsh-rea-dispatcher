// REA dispatcher: the 200+ rea-agents MCP tools, three calls at a time.
// Mounting REA's MCP server directly costs ~775 KB of tool schemas per request;
// this plugin exposes rea_tools (names) → rea_help (one schema) → rea_call.
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
  domainTools: Schema.boolean()
    .default(true)
    .description(
      '额外注册 6 个只读域工具（rea_native / rea_web / rea_apk / rea_mobile / rea_firmware / rea_general），把域词放进入口名；' +
        '关掉则只保留 rea_tools / rea_help / rea_call 三条命令（常驻更小）。',
    ),
  domainLimit: Schema.number()
    .default(40)
    .description('域工具一次列出的条数上限；超出时提示加 filter。'),
})

import {
  DOMAIN_META,
  domainEntries,
  domainOf,
  domainSummary,
  domainToolName,
  groupByDomain,
  isAllowedCwd,
  isSessionLost,
  normalizePath,
  renderDomainCatalog,
  renderResult,
  requiredParams,
  sessionCwd,
  spillText,
  toolWarnings,
} from './pure.js'

export {
  DOMAIN_META,
  domainEntries,
  domainOf,
  domainSummary,
  domainToolName,
  groupByDomain,
  isAllowedCwd,
  isSessionLost,
  normalizePath,
  renderDomainCatalog,
  renderResult,
  requiredParams,
  sessionCwd,
  spillText,
  toolWarnings,
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
        '最后 rea_call 调用。不要凭猜测调用不存在的工具。覆盖 native（PE/ELF）、web、apk、firmware、mobile（Frida/ObjC/Swift/Mach-O）五个域；' +
        '按域看：native（open_binary / binary_overview / list_procedures）、web（浏览器与抓包）、apk（jadx 反编译）、' +
        'mobile（frida / ObjC / Swift）、firmware（固件与信号）。常用链路 open_binary → binary_overview → search_procedures → procedure_pseudo_code。' +
        '任务词对照：反编译/伪代码/交叉引用/字符串 → native；抓包/HTTP → web；解包/dex/adb → apk；Frida/ObjC/plist → mobile；固件/信号 → firmware。',
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
        const heading = `REA ${reaVersion} 共 ${tools.length} 个工具${
          filter === '' ? '' : `，匹配 "${filter}" 的 ${matched.length} 个`
        }${fromCache ? '（缓存）' : '（刚拉取）'}`
        const lines = [heading]
        let shownCount = 0
        if (filter === '') {
          // No filter: group by domain so the model sees the breadth of the catalogue.
            for (const [domain, entries] of groupByDomain(tools)) {
            const room = limit - shownCount
            if (room <= 0) break
            lines.push(`[${domain} ${entries.length}]`)
            for (const tool of entries.slice(0, room)) {
              lines.push(
                `  ${tool.name} — ${typeof tool.title === 'string' && tool.title !== '' ? tool.title : '（无标题）'}`,
              )
              shownCount += 1
            }
          }
        } else {
          for (const tool of matched.slice(0, limit)) {
            lines.push(
              `${tool.name} — ${typeof tool.title === 'string' && tool.title !== '' ? tool.title : '（无标题）'}`,
            )
            shownCount += 1
          }
        }
        if (matched.length > shownCount) {
          lines.push(`…还有 ${matched.length - shownCount} 个未列出（提高 limit 或加 filter）`)
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
        const wanted = typeof args?.name === 'string' ? args.name.trim() : ''
        if (wanted === '') {
          return '缺少工具名。先 rea_tools 查名字，再用 rea_help name=<工具名> 取参数。'
        }
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
        const wantedCall = typeof args?.name === 'string' ? args.name.trim() : ''
        if (wantedCall === '') {
          return '缺少工具名。先 rea_tools 查名字，再 rea_call name=<工具名> arguments={...}。'
        }
        if (!tools.some((candidate) => candidate.name === wantedCall)) {
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

  // Read-only domain entry points: the domain word sits in the tool name, so a model
  // that never heard of rea_tools can still recognise "apk" or "firmware" as its task.
  if (config.domainTools) {
    for (const [key, meta] of Object.entries(DOMAIN_META)) {
      ctx.tools.register(
        defineTool({
          name: domainToolName(key),
          description:
            `列出 REA ${meta.label} 域的工具名与标题（只读清单，不执行）。适合：${meta.tasks}。` +
            (meta.chain === '' ? '' : `常用链路 ${meta.chain}。`) +
            '本工具只列名字；执行用 rea_call name=<工具名> arguments={...}，参数先看 rea_help。',
          parameters: {
            filter: {
              type: 'string',
              description: '可选，按工具名或标题的子串过滤（不区分大小写）。',
            },
          },
          output: textOutput,
          async execute(args, exec) {
            const misuse = Object.keys(args ?? {}).filter((key) => key !== 'filter')
            if (misuse.length > 0) {
              return `${domainToolName(key)} 只列清单，不执行工具（不接受 ${misuse.join(' / ')}）。执行请用 rea_call name=<工具名> arguments={...}。`
            }
            const denied = unauthorized(exec)
            if (denied !== undefined) return denied
            const { tools, reaVersion, fromCache } = await catalog()
            return renderDomainCatalog(tools, key, {
              reaVersion,
              filter: typeof args?.filter === 'string' ? args.filter : '',
              limit: config.domainLimit,
              fromCache,
            })
          },
        }),
      )
    }
  }
}
