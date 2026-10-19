/**
 * Row renderer for the browser debug drawer's **Console** sub-tab, plus the
 * two helpers the sibling `network-row.ts` shares (`tagButton`, `formatTime`).
 *
 * A row is one console capture: a level glyph (tinted with Flow's status-signal
 * tokens — `error`/`warning`), the capture time, the message text (collapsed to
 * one line, full text on hover), and a hover-revealed **Tag** affordance that
 * routes the capture id back to `browser.tagEntry` through the drawer. It owns
 * no capture logic — it renders a payload and reports a Tag intent by id, the
 * same shape the terminal/list rows use elsewhere.
 *
 * Styling is class-only (the drawer injects the stylesheet); nothing here sets
 * inline colour, so light/dark themes both resolve from the tokens.
 */
import '../components'
import { consoleSource } from '../../shared/capture-row-fields'
import type { FlButton } from '../components'
import type {
  BrowserConsoleCapture,
  BrowserConsolePayload,
} from '../../shared/browser-capture-types'

/** Level → glyph + tone class (the status-signal colours already in the tokens). */
const CONSOLE_LEVEL: Record<BrowserConsolePayload['level'], { icon: string; tone: string }> = {
  error: { icon: 'error', tone: 'is-error' },
  warn: { icon: 'warning', tone: 'is-warn' },
  info: { icon: 'info', tone: '' },
  log: { icon: 'dot', tone: '' },
  debug: { icon: 'dot', tone: 'is-muted' },
}

/** Epoch-ms → HH:MM:SS in local time (the row's leading timestamp). */
export function formatTime(ts: number): string {
  const date = new Date(ts)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/** First line only — a row is a single line; the full text lives in the title. */
function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? ''
}

/**
 * The per-row Tag affordance — a compact ghost button, hidden until the row is
 * hovered/focused (the drawer stylesheet owns the reveal). `label` is the
 * accessible name / tooltip; `onClick` fires the drawer's tagEntry call.
 */
export function tagButton(label: string, onClick: () => void): FlButton {
  const button = document.createElement('fl-button')
  button.setAttribute('variant', 'ghost')
  button.setAttribute('small', '')
  button.className = 'fl-bdrawer-row-tag'
  button.textContent = 'Add'
  button.setAttribute('aria-label', label)
  button.title = label
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return button
}

/** Render one console capture as a drawer row. `onTag` receives the capture id. */
export function renderConsoleRow(
  capture: BrowserConsoleCapture,
  onTag: (id: string) => void,
): HTMLElement {
  const { level, text, ts } = capture.payload
  const meta = CONSOLE_LEVEL[level]

  const row = document.createElement('div')
  row.className = `fl-bdrawer-row ${meta.tone}`.trim()
  row.setAttribute('role', 'listitem')

  const glyph = document.createElement('fl-icon')
  glyph.className = 'fl-bdrawer-glyph'
  glyph.setAttribute('name', meta.icon)
  glyph.setAttribute('size', '12')
  glyph.setAttribute('aria-label', level)

  const time = document.createElement('span')
  time.className = 'fl-bdrawer-time'
  time.textContent = formatTime(ts)

  const body = document.createElement('span')
  body.className = 'fl-bdrawer-text'
  body.textContent = firstLine(text)
  body.title = text

  // WHERE IT CAME FROM, which every capture has carried and no row has shown.
  // A reader scanning for "which file logged this" had to expand a row to find
  // out; Chrome puts it on the right of the line, and so does this.
  const sourceText = consoleSource(capture.componentPath)
  const source = document.createElement('span')
  source.className = 'fl-bdrawer-dim'
  source.textContent = sourceText
  if (sourceText !== '') source.title = capture.componentPath

  row.append(
    glyph,
    time,
    body,
    source,
    tagButton('Tag this console entry', () => onTag(capture.id)),
  )

  // ── THE REST OF IT ──────────────────────────────────────────────────────
  // A row printed the FIRST LINE and put everything else in a `title`, which
  // means a multi-line log or a stack trace — the entries somebody opens a
  // console for — were readable only as a tooltip you cannot scroll, select or
  // copy (user, 2026-09-21: "we should have that more formatted").
  //
  // Expandable only when there IS more: a one-line log gains nothing from a
  // disclosure control, and every row carrying one would be noise.
  const stack = capture.payload.stack
  const hasMore = text.includes('\n') || (stack !== undefined && stack.length > 0)
  if (!hasMore) return row

  const wrap = document.createElement('div')
  wrap.className = 'fl-bdrawer-entry'
  const detail = document.createElement('div')
  detail.className = 'fl-bdrawer-detail'
  detail.hidden = true
  let built = false

  row.classList.add('has-more')
  row.tabIndex = 0
  row.setAttribute('aria-expanded', 'false')
  const toggle = (): void => {
    if (!built) {
      const full = document.createElement('pre')
      full.className = 'fl-bdrawer-body-text'
      full.textContent = text
      detail.appendChild(full)
      if (stack !== undefined && stack.length > 0) {
        const title = document.createElement('h4')
        title.className = 'fl-bdrawer-section-title'
        title.textContent = 'Stack'
        const trace = document.createElement('pre')
        trace.className = 'fl-bdrawer-body-text is-stack'
        trace.textContent = stack
        detail.append(title, trace)
      }
      built = true
    }
    detail.hidden = !detail.hidden
    row.setAttribute('aria-expanded', String(!detail.hidden))
    row.classList.toggle('is-open', !detail.hidden)
  }
  row.addEventListener('click', (event) => {
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
