/**
 * Row renderer for the browser debug drawer's **Network** sub-tab (sibling of
 * `console-row.ts`, whose `tagButton` / `formatTime` helpers it reuses).
 *
 * A row is one network capture: the method, the status code (tinted by range —
 * 4xx/5xx/failed use the `error` token, 3xx the `warning` token), the URL
 * (ellipsized, full on hover), the request duration, and a hover-revealed
 * **Tag** affordance that routes the capture id to `browser.tagEntry`.
 */
import type { BrowserNetworkCapture } from '../../shared/browser-capture-types'
import { formatTime, tagButton } from './console-row'
import { detailTabs, toCurl } from '../../shared/network-detail'
import type { DetailSection } from '../../shared/network-detail'
import { networkRowFields } from '../../shared/capture-row-fields'

/** Status code → tone class (the drawer's status-signal colours). */
function statusTone(status: number): string {
  if (status === 0 || status >= 400) return 'is-error'
  if (status >= 300) return 'is-warn'
  return ''
}

/** Render one network capture as a drawer row. `onTag` receives the capture id. */
export function renderNetworkRow(
  capture: BrowserNetworkCapture,
  onTag: (id: string) => void,
): HTMLElement {
  const { status, timingMs, ts } = capture.payload
  const fields = networkRowFields(capture.payload)

  const row = document.createElement('div')
  row.className = `fl-bdrawer-row ${statusTone(status)}`.trim()
  row.setAttribute('role', 'listitem')

  const methodEl = document.createElement('span')
  methodEl.className = 'fl-bdrawer-method'
  methodEl.textContent = fields.method

  const statusEl = document.createElement('span')
  statusEl.className = 'fl-bdrawer-status'
  statusEl.textContent = fields.status

  // NAME THEN HOST, not the whole URL. A reader identifies a request by its
  // last path segment — the part a long URL pushed off the end of the row.
  const nameEl = document.createElement('span')
  nameEl.className = 'fl-bdrawer-text'
  nameEl.textContent = fields.name
  nameEl.title = fields.url

  // The name takes only what it needs so the host sits BESIDE it — they name
  // one thing together, and a name stretched across the row strands the host
  // at the far edge where it reads as a separate column.
  nameEl.classList.remove('fl-bdrawer-text')
  nameEl.classList.add('fl-bdrawer-name')

  const hostEl = document.createElement('span')
  hostEl.className = 'fl-bdrawer-dim'
  hostEl.textContent = fields.host

  const grow = document.createElement('span')
  grow.className = 'fl-bdrawer-grow'

  // Type and size, the two columns a network panel is scanned for and neither
  // of which this row had. Blank rather than a placeholder when unknown — an
  // unmeasured size and a zero-byte response are different facts.
  const typeEl = document.createElement('span')
  typeEl.className = 'fl-bdrawer-type'
  typeEl.textContent = fields.type

  const sizeEl = document.createElement('span')
  sizeEl.className = 'fl-bdrawer-size'
  sizeEl.textContent = fields.size

  const time = document.createElement('span')
  time.className = 'fl-bdrawer-time'
  time.textContent = `${Math.round(timingMs)}ms`
  time.title = formatTime(ts)

  row.append(
    methodEl,
    statusEl,
    nameEl,
    hostEl,
    grow,
    typeEl,
    sizeEl,
    time,
    tagButton('Tag this network request', () => onTag(capture.id)),
  )

  // ── THE PART THAT WAS MISSING ───────────────────────────────────────────
  // The payload has carried headers and bodies since the capture layer was
  // built; the row rendered a method, a status and a URL, which is the same
  // information the address bar already shows (user, 2026-09-21: "there is no
  // information relevant there").
  //
  // Click to expand, like every network panel a person has used. Built LAZILY:
  // a hundred rows each holding a formatted response body is a hundred bodies
  // formatted for the one somebody opens.
  const wrap = document.createElement('div')
  wrap.className = 'fl-bdrawer-entry'
  const detail = document.createElement('div')
  detail.className = 'fl-bdrawer-detail'
  detail.hidden = true
  let built = false

  row.tabIndex = 0
  row.setAttribute('aria-expanded', 'false')
  const toggle = (): void => {
    if (!built) {
      detail.appendChild(buildDetail(capture))
      built = true
    }
    detail.hidden = !detail.hidden
    row.setAttribute('aria-expanded', String(!detail.hidden))
    row.classList.toggle('is-open', !detail.hidden)
  }
  row.addEventListener('click', (event) => {
    // The Tag button lives in this row and does its own thing.
    if ((event.target as HTMLElement).closest('button') !== null) return
    toggle()
  })
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggle()
  })

  wrap.append(row, detail)
  return wrap
}

/**
 * The expanded view: a tab strip, then the selected tab, then a cURL.
 *
 * TABS RATHER THAN A STACK. Everything at once meant a Content-Security-Policy
 * header — routinely a paragraph — pushed the response body off the bottom, and
 * reaching the section you wanted meant scrolling past five you did not (user,
 * 2026-09-21).
 */
function buildDetail(capture: BrowserNetworkCapture): HTMLElement {
  const frag = document.createElement('div')
  const tabs = detailTabs(capture.payload, capture.withheld === true)

  const strip = document.createElement('div')
  strip.className = 'fl-bdrawer-tabs'
  strip.setAttribute('role', 'tablist')

  const panel = document.createElement('div')
  panel.className = 'fl-bdrawer-panel'

  const buttons: HTMLButtonElement[] = []
  const show = (index: number): void => {
    buttons.forEach((button, at) => {
      const active = at === index
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-selected', String(active))
      button.tabIndex = active ? 0 : -1
    })
    panel.replaceChildren(renderSections(tabs[index]?.sections ?? []))
  }

  tabs.forEach((tab, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-bdrawer-subtab'
    button.setAttribute('role', 'tab')
    button.textContent = tab.label
    // An empty tab is DIMMED, not removed: a strip whose tabs come and go
    // makes a reader hunt for the one that moved.
    if (tab.empty) button.classList.add('is-empty')
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      show(index)
    })
    buttons.push(button)
    strip.appendChild(button)
  })

  // Arrow keys move between tabs, which is what a tablist is for.
  strip.addEventListener('keydown', (event) => {
    const at = buttons.findIndex((button) => button === document.activeElement)
    if (at < 0) return
    const next =
      event.key === 'ArrowRight' ? at + 1 : event.key === 'ArrowLeft' ? at - 1 : null
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    const target = (next + buttons.length) % buttons.length
    buttons[target]?.focus()
    show(target)
  })

  frag.append(strip, panel)
  // Headers first: it holds General, which is what a reader looks at first.
  show(0)
  appendCurl(frag, capture)
  return frag
}

/** One tab's sections, as elements. */
function renderSections(sections: readonly DetailSection[]): HTMLElement {
  const frag = document.createElement('div')
  for (const section of sections) {
    const block = document.createElement('section')
    block.className = 'fl-bdrawer-section'

    const title = document.createElement('h4')
    title.className = 'fl-bdrawer-section-title'
    title.textContent = section.title
    block.appendChild(title)

    if (section.rows !== undefined && section.rows.length > 0) {
      const table = document.createElement('dl')
      table.className = 'fl-bdrawer-kv'
      for (const { name, value } of section.rows) {
        const dt = document.createElement('dt')
        dt.textContent = name
        const dd = document.createElement('dd')
        dd.textContent = value
        table.append(dt, dd)
      }
      block.appendChild(table)
    }
    if (section.body !== undefined) {
      const pre = document.createElement('pre')
      pre.className = 'fl-bdrawer-body-text'
      pre.textContent = section.body
      block.appendChild(pre)
    }
    if (section.note !== undefined) {
      const note = document.createElement('p')
      note.className = 'fl-bdrawer-note'
      note.textContent = section.note
      block.appendChild(note)
    }
    frag.appendChild(block)
  }
  return frag
}

/** The take-away command, below whichever tab is open. */
function appendCurl(frag: HTMLElement, capture: BrowserNetworkCapture): void {
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'fl-bdrawer-copy'
  copy.textContent = 'Copy as cURL'
  copy.addEventListener('click', (event) => {
    event.stopPropagation()
    const command = toCurl(capture.payload)
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        // SAYS IT HAPPENED. A copy button that looks identical before and after
        // is a button people press twice.
        copy.textContent = 'Copied'
        setTimeout(() => {
          copy.textContent = 'Copy as cURL'
        }, 1600)
      })
      .catch(() => {
        copy.textContent = 'Could not copy'
      })
  })
  frag.appendChild(copy)
}
