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
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const spillDir = join(tmpdir(), 'rea-spill-smoke-' + process.pid)
const config = Config({ cwdAllow: ['D:/re-projects'], spillDir })
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
  const expected = 'rea_apk,rea_call,rea_firmware,rea_general,rea_help,rea_mobile,rea_native,rea_tools,rea_web'
  check('nine tools registered (three commands + six domains)', [...registry.keys()].sort().join(',') === expected, [...registry.keys()].sort().join(','))

  const nativeList = await run('rea_native', { filter: 'procedure' }, 'D:/re-projects')
  check('domain tool lists its own domain', nativeList.includes('域 ') && nativeList.includes('procedure_pseudo_code'), nativeList.split('\n')[0])
  check('domain tool says it is read-only', nativeList.includes('只读清单'))

  const apkList = await run('rea_apk', {}, 'D:/re-projects')
  check('empty domain still answers', apkList.includes('域 ') && (apkList.includes('还有') || apkList.includes('rea_call')), apkList.split('\n')[0])

  const domainDenied = await run('rea_native', {}, 'C:/Windows')
  check('domain tool honours cwdAllow', domainDenied.startsWith('当前目录未授权'))

  const misuse = await run('rea_native', { name: 'open_binary' }, 'D:/re-projects')
  check('domain tool refuses execution args', misuse.includes('只列清单') && misuse.includes('rea_call'), misuse.split('\n')[0].slice(0, 60))

  const stray = await run('rea_apk', { path: 'C:/x.apk' }, 'D:/re-projects')
  check('domain tool refuses every unknown key', stray.includes('只列清单') && stray.includes('path'), stray.slice(0, 60))

  const miss = await run('rea_web', { filter: 'no_such_thing_xyz' }, 'D:/re-projects')
  check('domain miss points at rea_tools', miss.includes('本域没有匹配') && miss.includes('rea_tools filter="no_such_thing_xyz"'))

  const off = new Map()
  apply(
    { tools: { register: (d) => (off.set(d.name, d), () => off.delete(d.name)) }, effect: (b) => b() },
    Config({ domainTools: false }),
  )
  check('domainTools:false leaves the three commands', [...off.keys()].sort().join(',') === 'rea_call,rea_help,rea_tools', [...off.keys()].join(','))

  const denied = await run('rea_tools', {}, 'C:/Windows')
  check('unauthorized cwd refused', denied.startsWith('当前目录未授权'))

  const boundary = await run('rea_tools', { limit: 1 }, 'D:/re-projects2')
  check('path-segment boundary', boundary.startsWith('当前目录未授权'), 'D:/re-projects2 must not match D:/re-projects')

  const list = await run('rea_tools', { filter: 'native', limit: 3 }, 'D:/re-projects')
  check('catalogue reports the tool count', /共 \d+ 个工具/.test(list), list.split('\n')[0])
  check('catalogue stays compact', list.length < 800, `${list.length} chars`)

  const help = await run('rea_help', { name: 'inspect_native_load_image' }, 'D:/re-projects')
  check('help returns schema', help.includes('## 参数 schema'), `${help.length} chars`)
  check('help stays under cap', help.length <= config.helpMaxChars + 200, `${help.length} chars`)

  const typo = await run('rea_help', { name: 'inspect_native_load' }, 'D:/re-projects')
  check('help suggests nearest names', typo.includes('- inspect_native_load_image'))

  const call = await run('rea_call', { name: 'current_address', arguments: {} }, 'D:/re-projects')
  check('call passes provider errors through verbatim', call.includes('target_unavailable'))

  const cut = await run('rea_call', { name: 'current_address', maxBytes: 40 }, 'D:/re-projects')
  check('call truncates at maxBytes', cut.includes('原始') && cut.length < 500)
  check('truncated call spills the full text', cut.includes('全文已落盘') && cut.includes(spillDir), cut.slice(-160))

  const unknown = await run('rea_call', { name: 'no_such_tool' }, 'D:/re-projects')
  check('unknown tool is reported', unknown.includes('未找到工具'))
} finally {
  for (const disposer of disposers) disposer()
  await rm(spillDir, { recursive: true, force: true }).catch(() => {})
}

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
