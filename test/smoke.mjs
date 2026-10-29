// Smoke test for the REA dispatcher, run against the real REA MCP server.
//
//   node test/smoke.mjs
//
// It stubs the host context, so it never touches a live DSH process. Exit code
// is non-zero when any expectation fails; every REA round-trip is real.
import { apply, Config } from '../lib/index.js'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const registry = new Map()
const disposers = []
const ctx = {
  tools: {
    register(definition) {
      registry.set(definition.name, definition)
      return () => registry.delete(definition.name)
    },
  },
  effect(body) {
    const disposer = body()
    disposers.push(disposer)
    return disposer
  },
}

// cwdAllow is opt-in (empty = unrestricted); pin it here to prove the guard.
const config = Config({ cwdAllow: ['D:/re-projects'] })
apply(ctx, config)

const text = (name, value) =>
  registry
    .get(name)
    .output.render({}, value)
    .map((block) => block.text)
    .join('')

const run = async (name, args, cwd) => {
  const value = await registry.get(name).execute(args, {
    agent: { session: { header: { cwd } } },
  })
  return text(name, value)
}

try {
  check('three tools registered', [...registry.keys()].sort().join(',') === 'rea_call,rea_help,rea_tools')

  const denied = await run('rea_tools', {}, 'C:/Windows')
  check('unauthorized cwd refused', denied.startsWith('当前目录未授权'))

  const boundary = await run('rea_tools', { limit: 1 }, 'D:/re-projects2')
  check('path-segment boundary', boundary.startsWith('当前目录未授权'), 'D:/re-projects2 must not match D:/re-projects')

  const list = await run('rea_tools', { filter: 'native', limit: 3 }, 'D:/re-projects')
  check('catalogue lists 207 tools', list.includes('共 207 个工具'), list.split('\n')[0])
  check('catalogue stays compact', list.length < 800, `${list.length} chars`)

  const help = await run('rea_help', { name: 'inspect_native_load_image' }, 'D:/re-projects')
  check('help returns schema', help.includes('## 参数 schema'), `${help.length} chars`)
  check('help stays under cap', help.length <= config.helpMaxChars + 200, `${help.length} chars`)

  const typo = await run('rea_help', { name: 'inspect_native_load' }, 'D:/re-projects')
  check('help suggests nearest names', typo.includes('- inspect_native_load_image'))

  const call = await run('rea_call', { name: 'current_address', arguments: {} }, 'D:/re-projects')
  check('call passes provider errors through verbatim', call.includes('target_unavailable'))

  const cut = await run('rea_call', { name: 'current_address', maxBytes: 40 }, 'D:/re-projects')
  check('call truncates at maxBytes', cut.includes('原始') && cut.length < 300)

  const unknown = await run('rea_call', { name: 'no_such_tool' }, 'D:/re-projects')
  check('unknown tool is reported', unknown.includes('未找到工具'))
} finally {
  for (const disposer of disposers) disposer()
}

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
