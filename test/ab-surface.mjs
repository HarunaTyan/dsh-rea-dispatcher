// A/B measurement of the two REA surfaces, using the host's own definition shapes.
//
//  A: what `dsh-plugin-rea` (2.0.13) registers — @deepseek-ai/dsh-mcp-client
//     maps every REA tool to {name: mcp__rea__<raw>, description, parameters: inputSchema}.
//     Source: dsh-mcp-client/lib/index.js createMcpToolDefinition (parameters = inputSchema verbatim).
//  B: our dispatcher — three defineTool definitions compiled by the host's own defineTool.
import { existsSync, readFileSync } from 'node:fs'
import { apply, Config } from '../lib/index.js'
import { resolveCachePath } from '../lib/rea-client.js'

const cachePath = resolveCachePath()
if (!existsSync(cachePath)) {
  console.error('先跑一次 rea_tools（或 node test/smoke.mjs）生成工具表缓存：' + cachePath)
  process.exit(1)
}
const catalog = JSON.parse(readFileSync(cachePath, 'utf8'))

// ---- A: eager MCP surface -------------------------------------------------
const mcpTable = catalog.tools.map((tool) => ({
  name: `mcp__rea__${tool.name}`,
  description: typeof tool.description === 'string' ? tool.description : '',
  parameters: tool.inputSchema ?? {},
}))
const mcpJson = JSON.stringify(mcpTable)
const mcpBytes = Buffer.byteLength(mcpJson)
const perTool = catalog.tools.map((tool, index) => JSON.stringify(mcpTable[index]).length)

// ---- B: our dispatcher ----------------------------------------------------
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

const kb = (n) => `${(n / 1024).toFixed(0)} KB`
const toks = (n) => `${Math.round(n / 4 / 1000)}k–${Math.round(n / 3.5 / 1000)}k tok`

console.log('REA version          ', catalog.reaVersion, `(${catalog.tools.length} tools)`)
console.log('A  market row  bytes ', mcpJson.length, kb(mcpJson.length), '≈', toks(mcpJson.length))
console.log('A  per-tool          ', `min ${Math.min(...perTool)} / avg ${Math.round(mcpJson.length / perTool.length)} / max ${Math.max(...perTool)} B`)
console.log('A  largest 3         ', [...catalog.tools]
  .map((tool, index) => ({ name: tool.name, bytes: perTool[index] }))
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 3)
  .map((entry) => `${entry.name}=${entry.bytes}B`)
  .join(', '))
const ourChars = oursJson.length
const ourBytes = Buffer.byteLength(oursJson)
console.log('B  our dispatcher    ', ourChars, 'chars /', ourBytes, 'bytes ≈', toks(ourBytes), `(${ours.length} tools)`)
console.log('ratio A/B            ', `${(mcpJson.length / oursJson.length).toFixed(0)}×`)

// Projection to the pinned 229-tool release (dsh-plugin-rea pins rea-agents 6.8.0).
const projected = Math.round((mcpJson.length / catalog.tools.length) * 229)
console.log('A  projected 229 tool', projected, kb(projected), '≈', toks(projected))

// What one schema fetch costs under each design (a session needs ~30 tools).
const helps = []
const helpDefinition = registry.get('rea_help')
for (const name of ['open_binary', 'inspect_native_load_image', 'list_functions_exported', 'decompile_native_function']) {
  const value = await helpDefinition.execute({ name }, { agent: { session: { header: { cwd: 'D:/re-projects' } } } })
  const rendered = helpDefinition.output.render({}, value).map((block) => block.text).join('')
  helps.push({ name, bytes: rendered.length })
}
console.log('B  rea_help ×4 (on demand)', helps.map((entry) => `${entry.name}=${entry.bytes}B`).join(', '))
