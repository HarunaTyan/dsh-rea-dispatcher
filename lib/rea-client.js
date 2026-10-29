// REA (rea-agents) MCP client: newline-delimited JSON on stdio (no Content-Length
// framing). One long-lived child, because cold start is 1-3 s and tools/list is ~3 MB.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

const TAIL_LIMIT = 8000

export const MISSING_REA_MESSAGE =
  '未找到 rea-agents 的 MCP 入口（scripts/rea.mjs）。先 `npm i -g rea-agents`，' +
  '或在 Config.reaMjs / 环境变量 REA_MJS 里给出 scripts/rea.mjs 的绝对路径。'

export function resolveDshHome() {
  const explicit = process.env.DSH_HOME
  return explicit !== undefined && explicit.trim() !== '' ? explicit.trim() : join(homedir(), '.dsh')
}

let cacheWarned = false

function warnCacheFailure(error) {
  if (cacheWarned) return
  cacheWarned = true
  console.warn(`[dsh-rea-dispatcher] 工具表缓存写入失败，之后每次调用都会重新拉取 tools/list：${error.message}`)
}

/** Inside DSH_HOME so the cache survives profile reinstalls. */
export function resolveCachePath() {
  return join(resolveDshHome(), 'rea-dispatcher-cache.json')
}

/**
 * Locate `scripts/rea.mjs`: explicit config → REA_MJS → resolvable rea-agents →
 * npm global prefixes. An explicit path is returned verbatim, so a typo surfaces
 * as ENOENT instead of silently launching a different install.
 * @returns {string | undefined}
 */
export function resolveReaMjs(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  if (process.env.REA_MJS !== undefined && process.env.REA_MJS.trim() !== '') {
    return process.env.REA_MJS.trim()
  }
  const candidates = []
  try {
    const require = createRequire(import.meta.url)
    candidates.push(join(dirname(require.resolve('rea-agents/package.json')), 'scripts', 'rea.mjs'))
  } catch {
    // not a resolvable dependency; fall through to prefixes
  }
  const prefixes = []
  if (process.env.APPDATA !== undefined && process.env.APPDATA !== '') {
    prefixes.push(join(process.env.APPDATA, 'npm'))
  }
  if (process.env.npm_config_prefix !== undefined && process.env.npm_config_prefix !== '') {
    prefixes.push(process.env.npm_config_prefix)
  }
  prefixes.push(join(homedir(), '.npm-global'), '/usr/local/lib', '/usr/lib')
  for (const prefix of prefixes) {
    candidates.push(join(prefix, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'))
  }
  return candidates.find((candidate) => {
    try {
      return existsSync(candidate)
    } catch {
      return false
    }
  })
}

/** Config value, else the same-named environment variable. */
function fromEnv(explicit, name) {
  const value = typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : process.env[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export const resolveGhidraDir = (explicit) => fromEnv(explicit, 'GHIDRA_INSTALL_DIR')
export const resolveJavaHome = (explicit) => fromEnv(explicit, 'JAVA_HOME')

export function resolveChildCwd(explicit) {
  return typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : tmpdir()
}

/** `version` of the rea-agents install that owns `reaMjs`. */
export async function readReaVersion(reaMjs) {
  try {
    const pkg = JSON.parse(await readFile(join(dirname(reaMjs), '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function pushTail(previous, chunk) {
  const next = previous + chunk
  return next.length > TAIL_LIMIT ? next.slice(-TAIL_LIMIT) : next
}

/** One REA MCP child with JSON-RPC request/response correlation. */
export class ReaMcp {
  /**
   * @param {object} options
   * @param {string} [options.reaMjs]
   * @param {string} [options.nodePath] - defaults to process.execPath
   * @param {string} [options.ghidraDir]
   * @param {string} [options.javaHome] - also prepended to PATH
   * @param {string} options.cwd
   * @param {number} [options.callTimeoutMs]
   * @param {number} [options.listTimeoutMs]
   * @param {(line: string) => void} [options.onStray]
   */
  constructor(options) {
    this.options = options
    this.child = undefined
    this.pending = new Map()
    this.nextId = 1
    this.ready = undefined
    this.stderrTail = ''
    this.stdoutTail = ''
    this.strayCount = 0
    this.closed = false

  }

  /** Engine variables are injected per child, never persisted. */
  environment() {
    const { javaHome, ghidraDir } = this.options
    const env = { ...process.env }
    if (ghidraDir !== undefined) env.GHIDRA_INSTALL_DIR = ghidraDir
    if (javaHome !== undefined) {
      env.JAVA_HOME = javaHome
      // Windows naming is `Path`; keep exactly one PATH key whatever its case,
      // because a PATH/Path pair leaves the child's value implementation-defined.
      const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
      for (const name of Object.keys(env)) {
        if (name !== key && name.toUpperCase() === 'PATH') delete env[name]
      }
      const bin = join(javaHome, 'bin')
      const current = env[key] ?? ''
      env[key] = current === '' ? bin : `${bin}${delimiter}${current}`
    }
    return env
  }

  async start() {
    const { reaMjs, nodePath, cwd, onStray } = this.options
    if (typeof reaMjs !== 'string' || reaMjs === '') throw new Error(MISSING_REA_MESSAGE)
    // Direct node.exe: a .cmd shim mangles quotes and non-ASCII paths on Windows.
    const child = spawn(nodePath ?? process.execPath, [reaMjs, 'mcp'], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.environment(),
    })
    this.child = child

    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.trim() !== '') this.dispatch(line, onStray)
        newline = buffer.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderrTail = pushTail(this.stderrTail, chunk)
    })
    const flushBuffer = () => {
      if (buffer.trim() === '') return
      const line = buffer.replace(/\r$/, '')
      buffer = ''
      this.dispatch(line, onStray)
    }
    child.on('error', (error) => this.failAll(`REA MCP 无法启动：${error.message}`))
    child.on('exit', (code, signal) => {
      flushBuffer()
      if (this.closed) return
      this.failAll(`REA MCP 已退出（code=${code}, signal=${signal}）`)
    })

    await this.send(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'dsh-rea-dispatcher', version: '1.0.0' },
      },
      this.options.listTimeoutMs ?? 120000,
    )
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  /** Route one stdout line to its waiter; anything unparseable is stray. */
  dispatch(line, onStray) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.stdoutTail = pushTail(this.stdoutTail, line + '\n')
      this.strayCount += 1
      onStray?.(line)
      return
    }
    if (message === null || typeof message !== 'object') return
    if (message.id === undefined) return // server notification
    if (message.method !== undefined) {
      // Server-initiated request. We advertise no capabilities, so a fake empty
      // result could make the server continue on wrong assumptions; "method not
      // found" is the honest, non-blocking answer.
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'unsupported client method: ' + message.method },
      })
      return
    }
    const waiter = this.pending.get(message.id)
    if (waiter === undefined) return
    this.pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error !== undefined) {
      const detail =
        typeof message.error === 'object' && message.error !== null
          ? `${message.error.code ?? ''} ${message.error.message ?? JSON.stringify(message.error)}`
          : String(message.error)
      waiter.reject(new Error(`REA MCP ${waiter.method} 失败：${detail.trim()}`))
      return
    }
    waiter.resolve(message.result)
  }

  write(payload) {
    const child = this.child
    if (child === undefined || child.stdin.destroyed) throw new Error('REA MCP 子进程不可用')
    child.stdin.write(JSON.stringify(payload) + '\n')
  }

  /** One request, never hanging past `timeoutMs`. */
  async send(method, params, timeoutMs) {
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method }
    if (params !== undefined) payload.params = params
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out REA job keeps the single-threaded server busy, so every
        // later call would queue behind it; drop the child and restart on demand.
        const error = new Error(`REA MCP ${method} 超时（${Math.round(timeoutMs / 1000)} s）`)
        this.failAll(`REA MCP ${method} 超时`, error)
        reject(error)
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending.set(id, { resolve, reject, timer, method })
    })
    try {
      this.write(payload)
    } catch (error) {
      const waiter = this.pending.get(id)
      if (waiter !== undefined) {
        clearTimeout(waiter.timer)
        this.pending.delete(id)
      }
      throw error
    }
    return promise
  }

  /** Lazy start, and restart after a crash; idempotent per generation. */
  async ensureStarted() {
    if (this.closed) throw new Error('REA MCP 客户端已关闭')
    if (this.ready === undefined) {
      const generation = (async () => {
        if (this.child === undefined) await this.start()
      })()
      this.ready = generation
      generation.catch(() => {
        if (this.ready === generation) this.ready = undefined
      })
    }
    await this.ready
  }

  async call(method, params, timeoutMs) {
    await this.ensureStarted()
    return this.send(method, params, timeoutMs)
  }

  async listTools() {
    const result = await this.call('tools/list', undefined, this.options.listTimeoutMs ?? 120000)
    const tools = result?.tools
    if (!Array.isArray(tools)) throw new Error('REA MCP tools/list 返回了非数组 tools')
    return tools
  }

  async callTool(name, args, timeoutMs) {
    return this.call('tools/call', { name, arguments: args ?? {} }, timeoutMs ?? this.options.callTimeoutMs ?? 300000)
  }

  /** Reject in-flight requests and forget the child, so the next call restarts it. */
  failAll(reason, cause) {
    const detail = this.stderrTail.trim() === '' ? '' : `\nSTDERR 尾部：\n${this.stderrTail.trim()}`
    const error = cause ?? new Error(reason + detail)
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
    this.child = undefined
    this.ready = undefined
  }

  close() {
    const child = this.child
    this.closed = true
    this.child = undefined
    this.ready = undefined
    if (child !== undefined && child.exitCode === null) child.kill()
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('REA MCP 客户端已关闭'))
    }
    this.pending.clear()
  }
}

/**
 * Tool catalogue, preferring the on-disk cache. The cache is keyed by the
 * installed rea-agents version, so upgrading REA never serves a stale schema.
 * @returns {Promise<{tools: unknown[], reaVersion: string, fetchedAt: number, fromCache: boolean}>}
 */
export async function loadCatalog(client, options) {
  const { cachePath, reaMjs, force } = options
  const reaVersion = await readReaVersion(reaMjs)

  const cacheable = reaVersion !== 'unknown'
  if (!force && cacheable) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8'))
      if (
        cached !== null &&
        typeof cached === 'object' &&
        cached.reaVersion === reaVersion &&
        Array.isArray(cached.tools) &&
        cached.tools.length > 0
      ) {
        return {
          tools: cached.tools,
          reaVersion,
          fetchedAt: typeof cached.fetchedAt === 'number' ? cached.fetchedAt : 0,
          fromCache: true,
        }
      }
    } catch {
      // missing or unreadable cache: fetch live
    }
  }

  const tools = await client.listTools()
  const fetchedAt = Date.now()
  if (cacheable) try {
    await mkdir(dirname(cachePath), { recursive: true })
    const staging = `${cachePath}.tmp-${process.pid}`
    await writeFile(staging, JSON.stringify({ reaVersion, fetchedAt, tools }), 'utf8')
    await rename(staging, cachePath)
  } catch (error) {
    // A write failure must not fail the tool call, but silence would turn every
    // later call into a fresh 3 MB tools/list round trip.
    warnCacheFailure(error)
  }
  return { tools, reaVersion, fetchedAt, fromCache: false }
}

/** Levenshtein distance, for "did you mean" only. */
export function distance(a, b) {
  const left = [...a]
  const right = [...b]
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[right.length]
}

export function nearestNames(names, name, count = 5) {
  const needle = name.toLowerCase()
  return names
    .map((candidate) => {
      const lower = candidate.toLowerCase()
      const contains = lower.includes(needle) || needle.includes(lower) ? 0 : 1
      return { candidate, score: contains * 1000 + distance(lower, needle) }
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, count)
    .map((entry) => entry.candidate)
}
