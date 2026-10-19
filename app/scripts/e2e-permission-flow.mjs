// Gated Write → card → auto-approve → wait for the turn to COMPLETE.
const PORT = '9223'
let msgId = 0
const pending = new Map()
let ws
function send(m, p = {}) { const id = ++msgId; return new Promise((r) => { pending.set(id, r); ws.send(JSON.stringify({ id, method: m, params: p })) }) }
async function evalJs(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 700)); return r.result.value }
async function getPage() { for (let i = 0; i < 60; i++) { try { const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page' && x.webSocketDebuggerUrl && !String(x.url).startsWith('devtools')); if (t) return t } catch {} await new Promise((r) => setTimeout(r, 500)) } throw new Error('no page') }
const page = await getPage()
ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const f = pending.get(m.id); pending.delete(m.id); f(m.result ?? m) } }
await send('Runtime.enable')
for (let i = 0; i < 30; i++) { if (await evalJs(`!!window.flow`)) break; await new Promise((r) => setTimeout(r, 400)) }

await evalJs(`(async () => {
  window.__d = { stream: [], perms: [], composerWorkingAtEnd: null }
  const api = window.flow
  api.threads.onStream((e) => { window.__d.stream.push(e.kind + (e.status ? ':' + e.status : '')) })
  api.threads.onPermissionRequest((req) => { window.__d.perms.push(req.toolName); api.threads.respondPermission({ requestId: req.requestId, verdict: 'allow-once' }) })
  const root = await api.workspace.addRoot({ path: '${process.cwd()}' })
  const t = await api.threads.create({ projectRoot: root.rootPath })
  await api.threads.sendMessage({ threadId: t.id, content: 'Create a file flow-diag-test.txt containing hello, using your Write tool.' })
  return true
})()`)
let d
for (let i = 0; i < 80; i++) { d = await evalJs(`window.__d`); if (d.stream.includes('done')) break; await new Promise((r) => setTimeout(r, 500)) }
console.log('STREAM:', JSON.stringify(d.stream))
console.log('PERMS:', JSON.stringify(d.perms))
const done = d.stream.includes('done')
const statusDone = d.stream.some((k) => k === 'status:done')
console.log('DONE:', done, '| status:done:', statusDone)
process.exit(done ? 0 : 1)
