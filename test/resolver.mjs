// Environment-derived defaults and pure helpers: no REA server needed, no network.
//   node test/resolver.mjs
import { join } from 'node:path'
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
check('reaMjs auto-detected on this machine', typeof found === 'string' && found.endsWith('rea.mjs'), String(found))
check('explicit reaMjs is honoured verbatim', resolveReaMjs('X:/custom/rea.mjs') === 'X:/custom/rea.mjs', 'a typo must fail at spawn, not fall back')
check('blank explicit falls back to detection', resolveReaMjs('   ').endsWith('rea.mjs'))

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
check('backslash and case normalised', isAllowedCwd('d:\\PROJ\\sub', ['D:/proj']))
check('missing cwd denied when restricted', !isAllowedCwd('', ['D:/proj']))
check('normalizePath strips trailing slashes', normalizePath('D:\\proj\\') === 'd:/proj')

// ---- result rendering ----------------------------------------------------
const long = renderResult({ content: [{ type: 'text', text: 'x'.repeat(100) }] }, 10)
check('truncation marks itself', long.truncated && long.total === 100 && long.text.includes('truncated'))
const structured = renderResult({ structuredContent: { a: 1 } }, 1000)
check('structured content falls back to JSON', structured.text.includes('"a": 1'), structured.text)
const empty = renderResult({ content: [{ type: 'text', text: '' }] }, 1000)
check('empty text falls back to the raw result', empty.text.includes('"content"'), 'never returns an empty tool result')

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
