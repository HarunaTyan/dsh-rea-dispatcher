// Environment-derived defaults and pure helpers: no REA server needed, no network.
//   node test/resolver.mjs
import { join } from 'node:path'
import { requiredParams, toolWarnings } from '../lib/index.js'
import { tmpdir } from 'node:os'
import {
  ReaMcp,
  resolveCachePath,
  resolveChildCwd,
  resolveGhidraDir,
  resolveJavaHome,
  resolveReaMjs,
} from '../lib/rea-client.js'
import { isAllowedCwd, normalizePath, renderResult } from '../lib/index.js'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

// ---- rea-agents discovery -------------------------------------------------
const found = resolveReaMjs('')
if (found === undefined) {
  console.log('SKIP rea-agents detection — not installed on this machine (npm i -g rea-agents to enable)')
} else {
  check('reaMjs auto-detected on this machine', found.endsWith('rea.mjs'), String(found))
}
check('explicit reaMjs is honoured verbatim', resolveReaMjs('X:/custom/rea.mjs') === 'X:/custom/rea.mjs', 'a typo must fail at spawn, not fall back')
if (found !== undefined) check('blank explicit falls back to detection', resolveReaMjs('   ').endsWith('rea.mjs'))

// ---- engine variables -----------------------------------------------------
const savedGhidra = process.env.GHIDRA_INSTALL_DIR
const savedJava = process.env.JAVA_HOME
process.env.GHIDRA_INSTALL_DIR = 'X:/ghidra-env'
process.env.JAVA_HOME = 'X:/jdk-env'
check('ghidraDir falls back to env', resolveGhidraDir('') === 'X:/ghidra-env')
check('ghidraDir config wins', resolveGhidraDir('X:/cfg') === 'X:/cfg')
check('javaHome falls back to env', resolveJavaHome('') === 'X:/jdk-env')
delete process.env.GHIDRA_INSTALL_DIR
delete process.env.JAVA_HOME
check('absent ghidraDir stays undefined', resolveGhidraDir('') === undefined)
check('absent javaHome stays undefined', resolveJavaHome('') === undefined)
if (savedGhidra !== undefined) process.env.GHIDRA_INSTALL_DIR = savedGhidra
if (savedJava !== undefined) process.env.JAVA_HOME = savedJava

// ---- cache path / child cwd ----------------------------------------------
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = 'X:/dshhome'
check('cachePath follows DSH_HOME', resolveCachePath() === join('X:/dshhome', 'rea-dispatcher-cache.json'), resolveCachePath())
delete process.env.DSH_HOME
check('cachePath falls back to ~/.dsh', resolveCachePath().endsWith(join('.dsh', 'rea-dispatcher-cache.json')), resolveCachePath())
if (savedHome !== undefined) process.env.DSH_HOME = savedHome
check('childCwd defaults to tmpdir', resolveChildCwd('') === tmpdir())
check('childCwd config wins', resolveChildCwd('X:/work') === 'X:/work')

// ---- child environment injection ----------------------------------------
const client = new ReaMcp({ reaMjs: 'X:/rea.mjs', ghidraDir: 'X:/ghidra', javaHome: 'X:/jdk', cwd: tmpdir() })
const env = client.environment()
check('child env sets GHIDRA_INSTALL_DIR', env.GHIDRA_INSTALL_DIR === 'X:/ghidra')
check('child env sets JAVA_HOME', env.JAVA_HOME === 'X:/jdk')
check('child env prepends the JDK bin to PATH', String(env.PATH ?? env.Path).startsWith(join('X:/jdk', 'bin')))
const bare = new ReaMcp({ reaMjs: 'X:/rea.mjs', ghidraDir: undefined, javaHome: undefined, cwd: tmpdir() })
const bareEnv = bare.environment()
check('absent engines inject nothing', bareEnv.GHIDRA_INSTALL_DIR === savedGhidra && bareEnv.JAVA_HOME === savedJava)

// ---- allow list ----------------------------------------------------------
check('empty allow list means unrestricted', isAllowedCwd('C:/anywhere', []))
check('exact match allowed', isAllowedCwd('D:/proj', ['D:/proj']))
check('child dir allowed', isAllowedCwd('D:/proj/sub', ['D:/proj']))
check('sibling prefix denied', !isAllowedCwd('D:/proj2', ['D:/proj']))
check('backslash and case normalised', isAllowedCwd('d:\\PROJ\\sub', ['D:/proj']) === (process.platform === 'win32'))
check('missing cwd denied when restricted', !isAllowedCwd('', ['D:/proj']))
check('normalizePath strips trailing slashes', normalizePath('D:\\proj\\') === (process.platform === 'win32' ? 'd:/proj' : 'D:/proj'))
check('dot-dot cannot escape the allow list', !isAllowedCwd('D:/proj/..', ['D:/proj']))
check('dot-dot inside the allow list still matches', isAllowedCwd('D:/proj/sub/../sub', ['D:/proj']))
check('dot segments are ignored', isAllowedCwd('D:/proj/./sub', ['D:/proj']))
check('root allow list covers absolute paths', isAllowedCwd('/home/u/re', ['/']))
check('empty allow entry never matches', !isAllowedCwd('D:/proj', ['']))

// ---- result rendering ----------------------------------------------------
const long = renderResult({ content: [{ type: 'text', text: 'x'.repeat(100) }] }, 10)
check('truncation marks itself', long.truncated && long.total === 100 && long.text.includes('truncated'))
const structured = renderResult({ structuredContent: { a: 1 } }, 1000)
check('structured content falls back to JSON', structured.text.includes('"a": 1'), structured.text)
const empty = renderResult({ content: [{ type: 'text', text: '' }] }, 1000)
check('empty text falls back to the raw result', empty.text.includes('"content"'), 'never returns an empty tool result')

// ---- rea_help summary: required params and known traps -------------------
const schema = { type: 'object', required: ['path', 'format'], properties: {} }
check('requiredParams reads the schema', requiredParams(schema).join(',') === 'path,format', JSON.stringify(requiredParams(schema)))
check('requiredParams tolerates junk', requiredParams(undefined).length === 0 && requiredParams({ required: 'x' }).length === 0)
const trap = toolWarnings('Falls back to a unique source-file mapping when a 0x-prefixed number resolves to no procedure')
check('file-offset trap detected', trap.length === 1 && trap[0].includes('file offset'), JSON.stringify(trap))
check('absolute path requirement detected', toolWarnings('path must be an absolute path').some((w) => w.includes('绝对路径')))
check('external tool requirement detected', toolWarnings('requires tshark on PATH').some((w) => w.includes('tshark')))
check('no warnings for a plain description', toolWarnings('Lists procedures.').length === 0)

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
