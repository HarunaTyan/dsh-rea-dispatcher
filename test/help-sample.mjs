import { Config, apply } from '../lib/index.js'

const registry = new Map()
const ctx = {
  tools: { register: (definition) => registry.set(definition.name, definition) },
  effect: () => () => {},
}
apply(ctx, Config({ cwdAllow: [] }))
const help = registry.get('rea_help')
const out = await help.execute({ name: 'procedure_pseudo_code' }, { agent: { session: { header: { cwd: 'D:/re-projects' } } } })
console.log(String(out).split('\n').slice(0, 8).join('\n'))
console.log('... chars:', String(out).length)
