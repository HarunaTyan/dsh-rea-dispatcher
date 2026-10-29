import { ReaMcp } from '../lib/rea-client.js'

const client = new ReaMcp({
  reaMjs: 'C:/nope/rea-does-not-exist.mjs',
  cwd: process.cwd(),
  callTimeoutMs: 5000,
  listTimeoutMs: 5000,
})

for (let attempt = 1; attempt <= 2; attempt += 1) {
  const started = Date.now()
  try {
    await client.call('tools/list', undefined, 5000)
    console.log(attempt, 'UNEXPECTED SUCCESS')
  } catch (error) {
    const first = String(error.message).split('\n')[0]
    console.log(attempt, 'failed after', Date.now() - started, 'ms:', first.slice(0, 80))
  }
}
client.close()
