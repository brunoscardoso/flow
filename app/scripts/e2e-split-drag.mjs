// Final verification: every handle, both directions, fresh coords per drag.
const PORT = '9223'
let msgId = 0
const pending = new Map()
let ws
function send(m, p = {}) { const id = ++msgId; return new Promise((r) => { pending.set(id, r); ws.send(JSON.stringify({ id, method: m, params: p })) }) }
async function evalJs(e) { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value }
async function mouse(type, x, y, extra = {}) { await send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', pointerType: 'mouse', ...extra }) }

const res = await fetch(`http://127.0.0.1:${PORT}/json`)
const page = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const f = pending.get(m.id); pending.delete(m.id); f(m.result ?? m) } }
await send('Runtime.enable')

await evalJs(`(() => {
  localStorage.removeItem('flow.shell.layout.v1')
  for (const p of document.querySelectorAll('fl-panel[collapsed]')) p.removeAttribute('collapsed')
  for (const split of document.querySelectorAll('fl-split')) {
    Array.from(split.children).forEach((c, i) => split.setPaneCollapsed(i, c.hasAttribute('collapsed')))
  }
  return true
})()`)
await new Promise((r) => setTimeout(r, 300))

const specs = await evalJs(`(() => {
  const out = []
  for (const split of document.querySelectorAll('fl-split')) {
    const n = split.shadowRoot.querySelectorAll('.handle').length
    for (let i = 0; i < n; i++) out.push({ splitId: split.id, index: i, vertical: split.getAttribute('direction') === 'vertical' })
  }
  return out
})()`)

let failures = 0
for (const spec of specs) {
  for (const dir of [+1, -1]) {
    const info = await evalJs(`(() => {
      const split = document.getElementById('${spec.splitId}')
      const h = split.shadowRoot.querySelectorAll('.handle')[${spec.index}]
      const r = h.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height, sizes: split.getSizes(), disabled: h.classList.contains('disabled') }
    })()`)
    if (info.disabled) { console.log(`${spec.splitId}[${spec.index}] dir=${dir}: DISABLED — skip`); continue }
    const cx = info.x + info.w / 2, cy = info.y + info.h / 2
    const dx = spec.vertical ? 0 : 40 * dir, dy = spec.vertical ? 40 * dir : 0
    await mouse('mousePressed', cx, cy, { buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 4; i++) { await mouse('mouseMoved', cx + (dx * i) / 4, cy + (dy * i) / 4, { buttons: 1 }); await new Promise((r) => setTimeout(r, 15)) }
    await mouse('mouseReleased', cx + dx, cy + dy, { buttons: 0, clickCount: 1 })
    await new Promise((r) => setTimeout(r, 120))
    const now = await evalJs(`document.getElementById('${spec.splitId}').getSizes()`)
    const delta = now[spec.index] - info.sizes[spec.index]
    const expectSign = dir
    const ok = Math.abs(delta) > 0.02 && Math.sign(delta) === expectSign
    if (!ok) failures++
    console.log(`${spec.splitId}[${spec.index}] dir=${dir > 0 ? '+' : '-'}: ${ok ? 'OK' : 'FAIL'} (${info.sizes[spec.index].toFixed(3)} -> ${now[spec.index].toFixed(3)})`)
  }
}
// persistence check
const stored = await evalJs(`localStorage.getItem('flow.shell.layout.v1')`)
console.log('persisted:', stored ? 'yes' : 'NO')
console.log(failures === 0 ? 'ALL_DRAGS_WORK' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
