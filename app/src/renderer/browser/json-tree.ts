/**
 * A JSON value as a tree a reader opens one level at a time — the Network
 * panel's Preview and Payload tabs. The top two levels start open; deeper ones
 * start closed and show a one-line peek (`{id, name, …}`, `Array(25)`).
 *
 * BOUNDED: a response can hold tens of thousands of values, and a DOM node per
 * value would stall the drawer. Past `MAX_NODES` the tree stops and says how
 * much it left out; the Response tab still has the whole text.
 */

const MAX_NODES = 3000
const OPEN_DEPTH = 2

export function renderJsonTree(value: unknown): HTMLElement {
  const root = document.createElement('div')
  root.className = 'fl-net-tree'
  const budget = { left: MAX_NODES, cut: 0 }
  root.appendChild(node(value, null, 0, budget))
  if (budget.cut > 0) {
    const more = document.createElement('div')
    more.className = 'fl-net-tree-more'
    more.textContent = `${String(budget.cut)} more values are not shown here. The Response tab has the whole body.`
    root.appendChild(more)
  }
  return root
}

/** Parse text as JSON, or null when it is not JSON. */
export function parseJson(text: string | undefined): { value: unknown } | null {
  if (text === undefined) return null
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null
  try {
    return { value: JSON.parse(trimmed) as unknown }
  } catch {
    return null
  }
}

function keyEl(key: string | null): HTMLElement[] {
  if (key === null) return []
  const k = document.createElement('span')
  k.className = 'fl-net-tree-key'
  k.textContent = key
  const colon = document.createElement('span')
  colon.className = 'fl-net-tree-punct'
  colon.textContent = ': '
  return [k, colon]
}

function leaf(value: unknown): HTMLElement {
  const span = document.createElement('span')
  if (value === null) {
    span.className = 'fl-net-tree-null'
    span.textContent = 'null'
  } else if (typeof value === 'string') {
    span.className = 'fl-net-tree-string'
    span.textContent = JSON.stringify(value)
  } else if (typeof value === 'number') {
    span.className = 'fl-net-tree-number'
    span.textContent = String(value)
  } else {
    span.className = 'fl-net-tree-bool'
    span.textContent = String(value)
  }
  return span
}

function peek(value: object): string {
  if (Array.isArray(value)) return `Array(${String(value.length)})`
  const keys = Object.keys(value)
  return `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`
}

function node(value: unknown, key: string | null, depth: number, budget: { left: number; cut: number }): HTMLElement {
  budget.left -= 1
  const row = document.createElement('div')
  row.className = 'fl-net-tree-node'
  if (value === null || typeof value !== 'object') {
    row.append(document.createElement('span'), ...keyEl(key), leaf(value))
    row.firstElementChild?.classList.add('fl-net-tree-spacer')
    return row
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'fl-net-tree-toggle'
  const label = document.createElement('span')
  label.className = 'fl-net-tree-peek'
  label.textContent = peek(value)
  const kids = document.createElement('div')
  kids.className = 'fl-net-tree-kids'
  const open = depth < OPEN_DEPTH && entries.length > 0
  const sync = (isOpen: boolean): void => {
    row.classList.toggle('is-open', isOpen)
    toggle.setAttribute('aria-expanded', String(isOpen))
    toggle.setAttribute('aria-label', isOpen ? 'Collapse' : 'Expand')
  }
  // Children are built on first open: a closed branch costs one row.
  let built = false
  const build = (): void => {
    if (built) return
    built = true
    for (const [childKey, childValue] of entries) {
      if (budget.left <= 0) {
        budget.cut += 1
        continue
      }
      kids.appendChild(node(childValue, Array.isArray(value) ? childKey : childKey, depth + 1, budget))
    }
  }
  if (open) build()
  sync(open)
  toggle.addEventListener('click', () => {
    const next = !row.classList.contains('is-open')
    if (next) build()
    sync(next)
  })
  row.append(toggle, ...keyEl(key), label, kids)
  return row
}
