// A/B measurement of the two REA surfaces, using the host's own definition shapes.
//
//  A: what `dsh-plugin-rea` (2.0.13) registers — @deepseek-ai/dsh-mcp-client
//     maps every REA tool to {name: mcp__rea__<raw>, description, parameters: inputSchema}.
//  B: our dispatcher — defineTool definitions compiled by the host's own defineTool.
//
// Catalogue: the local cache when present, else the committed fixture, so a fresh
// clone can recompute the A-side numbers offline. The B-side numbers come from the
// host compiler and are only printed when @deepseek-ai/* is resolvable.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { resolveCachePath } from '../lib/rea-client.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, 'fixtures', 'catalog.json.gz')
const cachePath = resolveCachePath()

let catalog
let source
if (existsSync(cachePath)) {
  catalog = JSON.parse(readFileSync(cachePath, 'utf8'))
  source = `cache ${cachePath}`
} else if (existsSync(fixture)) {
  catalog = JSON.parse(gunzipSync(readFileSync(fixture)).toString('utf8'))
  source = 'fixture test/fixtures/catalog.json.gz'
} else {
  console.error('缺少工具目录：' + cachePath + ' 或 ' + fixture)
  process.exit(1)
}

const tools = catalog.tools

// ---- A: eager MCP surface -------------------------------------------------
const mcpTable = tools.map((tool) => ({
  name: `mcp__rea__${tool.name}`,
  description: typeof tool.description === 'string' ? tool.description : '',
  parameters: tool.inputSchema ?? {},
}))
const mcpJson = JSON.stringify(mcpTable)
const perTool = tools.map((tool, index) => JSON.stringify(mcpTable[index]).length)

const kb = (n) => `${(n / 1024).toFixed(0)} KB`
const toks = (n) => `${Math.round(n / 4 / 1000)}k–${Math.round(n / 3.5 / 1000)}k tok`

console.log('REA version          ', catalog.reaVersion, `(${tools.length} tools)`)
console.log('source               ', source)
console.log('A  market row  bytes ', mcpJson.length, kb(mcpJson.length), '≈', toks(mcpJson.length))
console.log('A  per-tool          ', `min ${Math.min(...perTool)} / avg ${Math.round(mcpJson.length / perTool.length)} / max ${Math.max(...perTool)} B`)
console.log('A  largest 3         ', [...tools]
  .map((tool, index) => ({ name: tool.name, bytes: perTool[index] }))
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 3)
  .map((entry) => `${entry.name}=${entry.bytes}B`)
  .join(', '))

// Projection to the pinned 229-tool release (dsh-plugin-rea pins rea-agents 6.8.0).
const projected = Math.round((mcpJson.length / tools.length) * 229)
console.log('A  projected 229 tool', projected, kb(projected), '≈', toks(projected))

// ---- B: our dispatcher (needs the host packages) --------------------------
let apply
let Config
try {
  ;({ apply, Config } = await import('../lib/index.js'))
} catch (error) {
  console.log('B  skipped           ', `没有宿主包（${error.code ?? error.message}），只打印 A 侧数字`)
  process.exit(0)
}

const registry = new Map()
const ctx = {
  tools: {
    register(definition) {
      registry.set(definition.name, definition)
      return () => registry.delete(definition.name)
    },
  },
  effect: (body) => body(),
}
apply(ctx, Config({}))
const ours = [...registry.values()].map((definition) => ({
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
}))
const oursJson = JSON.stringify(ours)
const ourChars = oursJson.length
const ourBytes = Buffer.byteLength(oursJson)
console.log('B  our dispatcher    ', ourChars, 'chars /', ourBytes, 'bytes ≈', toks(ourBytes), `(${ours.length} tools)`)
console.log('ratio A/B            ', `${(mcpJson.length / oursJson.length).toFixed(0)}×`)

// Same measurement with the domain entry points switched off (3 commands).
const offRegistry = new Map()
apply(
  {
    tools: { register: (d) => (offRegistry.set(d.name, d), () => offRegistry.delete(d.name)) },
    effect: (b) => b(),
  },
  Config({ domainTools: false }),
)
const offJson = JSON.stringify(
  [...offRegistry.values()].map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })),
)
console.log('B  domainTools:false  ', offJson.length, 'chars /', Buffer.byteLength(offJson), 'bytes', `(${offRegistry.size} tools)`)
console.log('ratio A/B (3 tools)   ', `${(mcpJson.length / offJson.length).toFixed(0)}×`)

// What one schema fetch costs under each design (a session needs ~30 tools).
const helps = []
const helpDefinition = registry.get('rea_help')
for (const name of ['open_binary', 'inspect_native_load_image', 'list_functions_exported', 'decompile_native_function']) {
  const value = await helpDefinition.execute({ name }, { agent: { session: { header: { cwd: 'D:/re-projects' } } } })
  const rendered = helpDefinition.output.render({}, value).map((block) => block.text).join('')
  helps.push({ name, bytes: rendered.length })
}
console.log('B  rea_help ×4 (on demand)', helps.map((entry) => `${entry.name}=${entry.bytes}B`).join(', '))
