/**
 * THE NETWORK PANEL — the debug drawer's Network tab, modelled on Chrome's.
 *
 * Replaces the one-line rows of `network-row.ts`, which the user found "so
 * hard to debug" (2026-11-20): no columns, no filter, no types, no timing. The
 * approved mockup is https://claude.ai/artifact/6yt4TgjnxNZw6XdMT25ciN.
 *
 * What a reader gets: a toolbar (record, clear, a filter box that reads
 * `status:` / `method:` / `domain:` / `larger-than:` / `mime-type:`, invert,
 * errors only, hide other sites, group repeats, keep on reload, add shown to
 * chat), type chips, an overview strip, a sortable table with a waterfall, a
 * detail pane beside the list (Headers, Payload, Preview, Response, Timing,
 * Initiator), a summary bar, and a right-click menu.
 *
 * DRAWING ONLY. Every rule — what the filter matches, how repeats group, what
 * the summary adds up — is in `shared/network-panel-model.ts`.
 *
 * COST (allowed-patterns #17, #18). The list is read WITHOUT bodies; a body is
 * read for the one request opened. Reads are throttled, and the drawer only
 * asks for one while it is open and on screen.
 */
import type { BrowserNetworkCapture, BrowserPageTimings } from '../../shared/browser-capture-types'
import type { FlowBrowserApi } from '../../shared/ipc-contract'
import { redactAndBound } from '../../shared/browser-capture-boundary'
import { contentTypeOf, formatBody, toCurl, toFetch } from '../../shared/network-detail'
import {
  NETWORK_TYPE_FILTERS,
  barOf,
  buildRows,
  failureLabel,
  formatDuration,
  formatSize,
  hostOf,
  initiatorLabel,
  isError,
  isRecorded,
  isSameSite,
  nameOf,
  phaseList,
  resourceSize,
  statusLabel,
  summarize,
  timeRange,
  transferSize,
  typeCounts,
  typeLabel,
  type NetworkFilters,
  type NetworkRow,
  type NetworkSortKey,
  type NetworkTypeFilter,
} from '../../shared/network-panel-model'
import { addCapturesToContext } from './browser-capture-chip'
import { parseJson, renderJsonTree } from './json-tree'

export type NetworkPanelApi = Pick<FlowBrowserApi, 'bufferSlice' | 'tagEntry' | 'pageTimings' | 'replay'>

export interface NetworkPanelHost {
  /** Open an address in a new browser tab. */
  openUrl(url: string): void
  /** The address of the page on screen, for "Hide other sites". */
  pageUrl(): string | null
  /** Reload the page on screen. */
  reload(): void
}

/** The most requests the list reads — the buffer's own cap. */
const LIST_N = 500
/** At most one list read per this many ms while requests pour in. */
const READ_THROTTLE_MS = 250
const STORE_KEY = 'flow.browser.network-panel'

type DetailTabId = 'headers' | 'payload' | 'preview' | 'response' | 'timing' | 'initiator'
const DETAIL_TABS: readonly { id: DetailTabId; label: string }[] = [
  { id: 'headers', label: 'Headers' },
  { id: 'payload', label: 'Payload' },
  { id: 'preview', label: 'Preview' },
  { id: 'response', label: 'Response' },
  { id: 'timing', label: 'Timing' },
  { id: 'initiator', label: 'Initiator' },
]

interface Column {
  id: NetworkSortKey | 'waterfall'
  label: string
  width: string
  /** Dropped when the detail pane is open or the drawer is narrow. */
  extra?: boolean
  /** Dropped when the detail pane is open — as in Chrome, the list then
   *  shows what identifies a request, and the pane shows the rest. */
  wide?: boolean
}
// The short columns are sized in characters, so "OPTIONS" and "(failed)" fit
// however narrow the drawer is; Name takes whatever is left.
const COLUMNS: readonly Column[] = [
  { id: 'name', label: 'Name', width: 'auto' },
  { id: 'status', label: 'Status', width: '10ch' },
  { id: 'method', label: 'Method', width: '9ch', wide: true },
  { id: 'type', label: 'Type', width: '11ch', extra: true },
  { id: 'initiator', label: 'Initiator', width: '18ch', extra: true },
  { id: 'size', label: 'Size', width: '10ch', wide: true },
  { id: 'time', label: 'Time', width: '9ch', wide: true },
  { id: 'waterfall', label: 'Waterfall', width: '16%', extra: true },
]

interface Prefs {
  group: boolean
  hideOtherSites: boolean
  preserve: boolean
}

function readPrefs(): Prefs {
  const fallback: Prefs = { group: true, hideOtherSites: false, preserve: false }
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (raw === null) return fallback
    const parsed = JSON.parse(raw) as Partial<Prefs>
    return {
      group: typeof parsed.group === 'boolean' ? parsed.group : fallback.group,
      hideOtherSites: typeof parsed.hideOtherSites === 'boolean' ? parsed.hideOtherSites : fallback.hideOtherSites,
      preserve: typeof parsed.preserve === 'boolean' ? parsed.preserve : fallback.preserve,
    }
  } catch {
    return fallback
  }
}

function writePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(prefs))
  } catch {
    // A toggle that does not survive a restart is a small loss.
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export class NetworkPanel {
  readonly element: HTMLElement
  #api: NetworkPanelApi
  #host: NetworkPanelHost

  #captures: BrowserNetworkCapture[] = []
  #rows: NetworkRow[] = []
  #timings: BrowserPageTimings | null = null
  #filters: NetworkFilters = { query: '', type: 'all', invert: false, errorsOnly: false, hideOtherSites: false, pageHost: '' }
  #prefs: Prefs
  #sort: { key: NetworkSortKey; direction: 1 | -1 } | null = null
  #selectedId: string | null = null
  #detailTab: DetailTabId = 'headers'
  #detailCapture: BrowserNetworkCapture | null = null
  #recording = true
  #pauses: { from: number; to: number | null }[] = []
  #clearedAt: number | null = null

  #readSeq = 0
  #detailSeq = 0
  #lastRead = 0
  #timer: ReturnType<typeof setTimeout> | null = null
  #flashTimer: ReturnType<typeof setTimeout> | null = null

  #recordBtn: HTMLButtonElement
  #filterInput: HTMLInputElement
  #chips: HTMLElement
  #overview: HTMLCanvasElement
  #split: HTMLElement
  #list: HTMLElement
  #head: HTMLTableRowElement
  #body: HTMLTableSectionElement
  #empty: HTMLElement
  #detail: HTMLElement
  #detailHead: HTMLElement
  #detailTabs: HTMLElement
  #detailBody: HTMLElement
  #status: HTMLElement
  #flash: HTMLElement
  #missed: HTMLElement
  #missedText: HTMLElement
  #menu: HTMLElement
  #onDocPointer: (event: Event) => void

  constructor(api: NetworkPanelApi, host: NetworkPanelHost) {
    ensureStyles()
    this.#api = api
    this.#host = host
    this.#prefs = readPrefs()
    this.#filters.hideOtherSites = this.#prefs.hideOtherSites

    const root = el('div', 'fl-net')
    root.tabIndex = -1

    // ── Toolbar ─────────────────────────────────────────────────────────────
    const toolbar = el('div', 'fl-net-toolbar')
    this.#recordBtn = el('button', 'fl-net-btn fl-net-record')
    this.#recordBtn.type = 'button'
    this.#recordBtn.addEventListener('click', () => this.#toggleRecording())
    const clear = el('button', 'fl-net-btn', 'Clear')
    clear.type = 'button'
    clear.title = 'Clear the list'
    clear.addEventListener('click', () => this.#clear())

    const search = el('label', 'fl-net-search')
    this.#filterInput = el('input')
    this.#filterInput.type = 'search'
    this.#filterInput.placeholder = 'Filter, e.g. status:404 method:POST -domain:example.com'
    this.#filterInput.setAttribute('aria-label', 'Filter requests')
    this.#filterInput.spellcheck = false
    this.#filterInput.addEventListener('input', () => {
      this.#filters.query = this.#filterInput.value
      this.#render()
    })
    search.append(this.#filterInput)

    const invert = this.#check('Invert', 'Show what the filter does not match', false, (on) => {
      this.#filters.invert = on
      this.#render()
    })
    const errors = this.#check('Errors only', 'Only failed requests and 4xx/5xx answers', false, (on) => {
      this.#filters.errorsOnly = on
      this.#render()
    })
    const others = this.#check('Hide other sites', 'Hide requests to sites other than the page’s own, such as analytics', this.#prefs.hideOtherSites, (on) => {
      this.#filters.hideOtherSites = on
      this.#prefs.hideOtherSites = on
      writePrefs(this.#prefs)
      this.#render()
    })
    const group = this.#check('Group repeats', 'Show a request sent again and again as one row with a count', this.#prefs.group, (on) => {
      this.#prefs.group = on
      writePrefs(this.#prefs)
      this.#render()
    })
    const preserve = this.#check('Keep on reload', 'Keep the list when the page reloads or navigates', this.#prefs.preserve, (on) => {
      this.#prefs.preserve = on
      writePrefs(this.#prefs)
      this.refresh()
    })
    const addShown = el('button', 'fl-net-btn is-primary', 'Add shown to chat')
    addShown.type = 'button'
    addShown.dataset['action'] = 'network-add-shown'
    addShown.title = 'Add every request in the list to the chat'
    addShown.addEventListener('click', () => void this.#addToChat(this.#rows.flatMap((row) => row.ids)))
    toolbar.append(this.#recordBtn, clear, el('span', 'fl-net-sep'), search, invert, errors, others, group, preserve, el('span', 'fl-net-sep'), addShown)

    this.#chips = el('div', 'fl-net-chips')
    this.#chips.setAttribute('role', 'toolbar')
    this.#chips.setAttribute('aria-label', 'Request types')

    // Requests the start of a page load sent before capture was listening.
    this.#missed = el('div', 'fl-net-missed')
    this.#missed.hidden = true
    this.#missedText = el('span')
    const reload = el('button', 'fl-net-btn', 'Reload page')
    reload.type = 'button'
    reload.addEventListener('click', () => this.#host.reload())
    this.#missed.append(this.#missedText, reload)

    const overviewWrap = el('div', 'fl-net-overview')
    this.#overview = el('canvas')
    overviewWrap.append(this.#overview)

    // ── List and detail ─────────────────────────────────────────────────────
    this.#split = el('div', 'fl-net-split')
    this.#list = el('div', 'fl-net-list')
    this.#list.tabIndex = 0
    this.#list.addEventListener('keydown', (event) => this.#onListKey(event))
    const table = el('table', 'fl-net-table')
    const colgroup = el('colgroup')
    for (const column of COLUMNS) {
      const col = el('col', columnClass(column))
      col.style.width = column.width
      colgroup.append(col)
    }
    const thead = el('thead')
    this.#head = el('tr')
    thead.append(this.#head)
    this.#body = el('tbody')
    table.append(colgroup, thead, this.#body)
    this.#empty = el('div', 'fl-net-empty')
    this.#list.append(table, this.#empty)

    this.#detail = el('aside', 'fl-net-detail')
    this.#detail.hidden = true
    this.#detailHead = el('div', 'fl-net-detail-head')
    this.#detailTabs = el('div', 'fl-net-detail-tabs')
    this.#detailTabs.setAttribute('role', 'tablist')
    this.#detailBody = el('div', 'fl-net-detail-body')
    this.#detail.append(this.#detailHead, this.#detailTabs, this.#detailBody, this.#buildDetailFoot())
    this.#split.append(this.#list, this.#detail)

    const statusRow = el('div', 'fl-net-status')
    this.#status = el('div', 'fl-net-status-facts')
    this.#flash = el('div', 'fl-net-flash')
    this.#flash.setAttribute('role', 'status')
    statusRow.append(this.#status, this.#flash)

    this.#menu = el('div', 'fl-net-menu')
    this.#menu.hidden = true
    this.#menu.setAttribute('role', 'menu')

    root.append(toolbar, this.#chips, this.#missed, overviewWrap, this.#split, statusRow, this.#menu)
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      if (!this.#menu.hidden) this.#closeMenu()
      else if (this.#selectedId !== null) this.#select(null)
      else return
      event.stopPropagation()
    })
    this.#onDocPointer = (event: Event): void => {
      if (!this.#menu.hidden && !this.#menu.contains(event.target as Node)) this.#closeMenu()
    }
    document.addEventListener('pointerdown', this.#onDocPointer, true)
    this.element = root

    this.#syncRecordButton()
    this.#renderHead()
    this.#render()
  }

  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    if (this.#flashTimer !== null) clearTimeout(this.#flashTimer)
    document.removeEventListener('pointerdown', this.#onDocPointer, true)
  }

  /** Re-read the list. Throttled: a page firing requests every few ms causes
   *  one read per READ_THROTTLE_MS, never one per request. */
  refresh(): void {
    if (this.#timer !== null) return
    const wait = Math.max(0, READ_THROTTLE_MS - (Date.now() - this.#lastRead))
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#read()
    }, wait)
  }

  /** Forget the selection and what was on screen (the tab on screen changed). */
  reset(): void {
    this.#select(null)
    this.#captures = []
    this.#clearedAt = null
    this.#pauses = []
    this.#recording = true
    this.#syncRecordButton()
    this.#render()
  }

  async #read(): Promise<void> {
    const seq = ++this.#readSeq
    this.#lastRead = Date.now()
    let slice: BrowserNetworkCapture[]
    let timings: BrowserPageTimings | null = null
    try {
      const [captures, pageTimings] = await Promise.all([
        this.#api.bufferSlice({
          kind: 'network',
          selector: this.#prefs.preserve ? { mode: 'last-n', n: LIST_N } : { mode: 'since-nav' },
          bodies: false,
        }),
        this.#api.pageTimings?.({}).catch(() => null) ?? Promise.resolve(null),
      ])
      // In the order requests STARTED, as Chrome lists them. The buffer holds
      // them in the order they finished, which puts a slow document last.
      slice = captures
        .filter((capture): capture is BrowserNetworkCapture => capture.kind === 'network')
        .map((capture, index) => ({ capture, index }))
        .sort((a, b) => a.capture.payload.ts - b.capture.payload.ts || a.index - b.index)
        .map(({ capture }) => capture)
      timings = pageTimings
    } catch (error) {
      console.warn('flow: network panel read failed', error)
      return
    }
    if (seq !== this.#readSeq) return
    this.#captures = slice
    this.#timings = timings
    this.#render()
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /** What is recorded: everything since the last Clear, outside any pause. */
  #recorded(): BrowserNetworkCapture[] {
    return this.#captures.filter((capture) => isRecorded(capture.payload.ts, this.#clearedAt, this.#pauses))
  }

  #render(): void {
    const recorded = this.#recorded()
    const pageUrl = this.#host.pageUrl()
    this.#filters.pageHost = pageUrl === null ? '' : hostOf(pageUrl)
    this.#rows = buildRows(recorded, this.#filters, { group: this.#prefs.group, sort: this.#sort })
    this.#renderChips(recorded)
    this.#renderRows(recorded)
    this.#renderOverview(recorded)
    this.#renderStatus(recorded)
    const missed = this.#timings?.missedRequests ?? 0
    this.#missed.hidden = missed === 0 || this.#prefs.preserve
    this.#missedText.textContent =
      missed === 1
        ? 'One request from the start of this page load was not recorded. Reload the page to see every request.'
        : `${String(missed)} requests from the start of this page load were not recorded. Reload the page to see every request.`
  }

  #renderChips(recorded: readonly BrowserNetworkCapture[]): void {
    const counts = typeCounts(recorded)
    this.#chips.replaceChildren(
      ...NETWORK_TYPE_FILTERS.map(({ id, label }) => {
        const chip = el('button', `fl-net-chip${this.#filters.type === id ? ' is-on' : ''}`, label)
        chip.type = 'button'
        chip.dataset['type'] = id
        chip.setAttribute('aria-pressed', String(this.#filters.type === id))
        if (id !== 'all' && counts[id] > 0) chip.append(el('span', 'fl-net-chip-count', String(counts[id])))
        chip.addEventListener('click', () => {
          this.#filters.type = id as NetworkTypeFilter
          this.#render()
        })
        return chip
      }),
    )
  }

  #renderHead(): void {
    this.#head.replaceChildren(
      ...COLUMNS.map((column) => {
        const th = el('th', columnClass(column))
        th.scope = 'col'
        const key: NetworkSortKey = column.id === 'waterfall' ? 'start' : column.id
        const sorted = this.#sort?.key === key
        th.textContent = column.label
        if (sorted) th.append(el('span', 'fl-net-arrow', this.#sort?.direction === 1 ? '▲' : '▼'))
        th.setAttribute('aria-sort', sorted ? (this.#sort?.direction === 1 ? 'ascending' : 'descending') : 'none')
        th.tabIndex = 0
        th.title = `Sort by ${column.label.toLowerCase()}`
        const cycle = (): void => {
          // Ascending, descending, then back to the order requests were made in.
          if (this.#sort?.key !== key) this.#sort = { key, direction: 1 }
          else if (this.#sort.direction === 1) this.#sort = { key, direction: -1 }
          else this.#sort = null
          this.#renderHead()
          this.#render()
        }
        th.addEventListener('click', cycle)
        th.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            cycle()
          }
        })
        return th
      }),
    )
  }

  #renderRows(recorded: readonly BrowserNetworkCapture[]): void {
    const stick = this.#sort === null && this.#list.scrollHeight - this.#list.scrollTop - this.#list.clientHeight < 40
    const range = timeRange(recorded)
    const pageHost = this.#filters.pageHost
    const rows = this.#rows.map((row) => {
      const payload = row.capture.payload
      const tr = el('tr', 'fl-net-row')
      tr.dataset['id'] = row.capture.id
      if (isError(payload)) tr.classList.add('is-error')
      if (this.#selectedId !== null && row.ids.includes(this.#selectedId)) tr.classList.add('is-selected')

      const name = el('td', 'fl-net-name')
      name.title = payload.url
      name.append(el('span', 'fl-net-name-text', nameOf(payload.url)))
      const host = hostOf(payload.url)
      if (host !== '' && !isSameSite(pageHost, host)) name.append(el('span', 'fl-net-host', host))
      if (row.count > 1) {
        const repeat = el('span', 'fl-net-repeat', `×${String(row.count)}`)
        repeat.title = `Sent ${String(row.count)} times. Showing the latest.`
        name.append(repeat)
      }

      const status = el('td', 'fl-net-status-cell', statusLabel(payload))
      const failure = failureLabel(payload)
      if (failure !== '') {
        status.append(el('span', 'fl-net-dim fl-net-failure', ` ${failure}`))
        status.title = payload.failure ?? ''
      }
      const size = el('td', 'is-num is-wide')
      if (payload.servedFrom !== undefined) size.append(el('span', 'fl-net-dim', `(${payload.servedFrom})`))
      else size.textContent = payload.status === 0 ? '0 B' : formatSize(transferSize(payload))
      if (payload.resourceBytes !== undefined) size.title = `${formatSize(transferSize(payload))} transferred, ${formatSize(resourceSize(payload))} resource`

      const waterfall = el('td', 'is-extra')
      if (range !== null) waterfall.append(waterfallBar(row.capture, range))

      tr.append(
        name,
        status,
        el('td', 'is-wide', payload.method),
        el('td', 'fl-net-dim is-extra', typeLabel(payload)),
        el('td', 'fl-net-dim is-extra', initiatorLabel(payload)),
        size,
        el('td', 'is-num is-wide', formatDuration(payload.timingMs)),
        waterfall,
      )
      return tr
    })
    this.#body.replaceChildren(...rows)
    this.#empty.hidden = rows.length > 0
    this.#empty.textContent =
      this.#recorded().length === 0
        ? this.#recording
          ? 'No requests yet. Requests the page makes appear here.'
          : 'Recording is paused.'
        : 'No requests match the filter.'
    if (stick) this.#list.scrollTop = this.#list.scrollHeight
  }

  #renderOverview(recorded: readonly BrowserNetworkCapture[]): void {
    const canvas = this.#overview
    const box = canvas.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.round(box.width * ratio)
    canvas.height = Math.round(box.height * ratio)
    const g = canvas.getContext('2d')
    if (g === null) return
    g.scale(ratio, ratio)
    g.clearRect(0, 0, box.width, box.height)
    const range = timeRange(recorded)
    if (range === null) return
    const css = getComputedStyle(this.element)
    const color = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
    const lanes = 6
    const lane = (box.height - 4) / lanes
    recorded.forEach((capture, index) => {
      const bar = barOf(capture.payload, range)
      g.fillStyle = isError(capture.payload) ? color('--fl-color-error', '#e5484d') : color('--fl-net-wait', '#3e9b6b')
      g.fillRect(bar.left * box.width, 2 + (index % lanes) * lane, Math.max(2, bar.width * box.width), Math.max(1.5, lane - 1))
    })
    const summary = summarize(this.#rows, recorded, this.#timings)
    const mark = (ms: number | null, fill: string): void => {
      if (ms === null) return
      g.fillStyle = fill
      g.fillRect((ms / (range.end - range.start)) * box.width, 0, 1, box.height)
    }
    mark(summary.domContentLoaded, color('--fl-color-accent', '#3e63dd'))
    mark(summary.load, color('--fl-color-error', '#e5484d'))
  }

  #renderStatus(recorded: readonly BrowserNetworkCapture[]): void {
    const summary = summarize(this.#rows, recorded, this.#timings)
    const facts: HTMLElement[] = []
    const fact = (strong: string, rest: string, className = ''): void => {
      const span = el('span', className)
      span.append(el('b', '', strong), document.createTextNode(` ${rest}`))
      facts.push(span)
    }
    fact(`${String(summary.shown)} / ${String(summary.total)}`, 'requests')
    fact(formatSize(summary.transferred), 'transferred')
    fact(formatSize(summary.resources), 'resources')
    if (summary.failed > 0) facts.push(el('span', 'is-error', `${String(summary.failed)} failed`))
    if (summary.finish !== null) fact(formatDuration(summary.finish), 'to finish')
    if (summary.domContentLoaded !== null) facts.push(el('span', 'is-accent', `DOMContentLoaded ${formatDuration(summary.domContentLoaded)}`))
    if (summary.load !== null) facts.push(el('span', 'is-error', `Load ${formatDuration(summary.load)}`))
    this.#status.replaceChildren(...facts)
  }

  // ── Selection and detail ──────────────────────────────────────────────────

  #select(id: string | null): void {
    this.#selectedId = id
    this.#split.classList.toggle('has-detail', id !== null)
    this.#detail.hidden = id === null
    for (const tr of this.#body.querySelectorAll<HTMLElement>('.fl-net-row')) {
      const row = this.#rows.find((entry) => entry.capture.id === tr.dataset['id'])
      tr.classList.toggle('is-selected', id !== null && row !== undefined && row.ids.includes(id))
    }
    this.#detailCapture = null
    if (id === null) {
      this.#renderOverview(this.#recorded())
      return
    }
    void this.#loadDetail(id)
  }

  async #loadDetail(id: string): Promise<void> {
    const seq = ++this.#detailSeq
    this.#detailBody.replaceChildren(el('p', 'fl-net-note', 'Loading…'))
    let capture: BrowserNetworkCapture | null = null
    try {
      const found = await this.#api.bufferSlice({ kind: 'network', selector: { mode: 'single', id } })
      const first = found[0]
      capture = first?.kind === 'network' ? first : null
    } catch (error) {
      console.warn('flow: network detail read failed', error)
    }
    if (seq !== this.#detailSeq) return
    this.#detailCapture = capture
    this.#renderDetail()
  }

  #renderDetail(): void {
    const capture = this.#detailCapture
    this.#detailHead.replaceChildren()
    if (capture === null) {
      this.#detailTabs.replaceChildren()
      this.#detailBody.replaceChildren(el('p', 'fl-net-note', 'This request is no longer in the list.'))
      this.#detailHead.append(this.#closeButton())
      return
    }
    const payload = capture.payload
    const statusPill = el('span', `fl-net-pill${isError(payload) ? ' is-error' : payload.status >= 300 ? ' is-warn' : ' is-ok'}`, statusLabel(payload))
    const title = el('span', 'fl-net-detail-title', payload.url)
    title.title = payload.url
    this.#detailHead.append(statusPill, el('span', 'fl-net-pill', payload.method), title, this.#closeButton())

    const has: Record<DetailTabId, boolean> = {
      headers: true,
      payload: queryOf(payload.url).length > 0 || (payload.requestBody ?? '') !== '',
      preview: (payload.responseBody ?? '') !== '',
      response: (payload.responseBody ?? '') !== '',
      timing: payload.phases !== undefined,
      initiator: payload.initiator !== undefined,
    }
    this.#detailTabs.replaceChildren(
      ...DETAIL_TABS.map(({ id, label }) => {
        const tab = el('button', `fl-net-detail-tab${this.#detailTab === id ? ' is-on' : ''}${has[id] ? '' : ' is-empty'}`, label)
        tab.type = 'button'
        tab.setAttribute('role', 'tab')
        tab.setAttribute('aria-selected', String(this.#detailTab === id))
        tab.addEventListener('click', () => {
          this.#detailTab = id
          this.#renderDetail()
        })
        return tab
      }),
    )
    this.#detailBody.replaceChildren(...this.#detailContent(capture))
  }

  #detailContent(capture: BrowserNetworkCapture): HTMLElement[] {
    const payload = capture.payload
    // Headers are shown REDACTED — a drawer is on screen during a screen share —
    // and bodies as they came, which is what debugging needs.
    const redacted = redactAndBound(capture)
    const headers = redacted.kind === 'network' ? redacted.payload : payload
    switch (this.#detailTab) {
      case 'headers': {
        const general: [string, string][] = [
          ['Request URL', payload.url],
          ['Request method', payload.method],
          ['Status', payload.status === 0 ? `Failed${payload.failure !== undefined ? `: ${payload.failure}` : ''}` : String(payload.status)],
        ]
        if (payload.failure !== undefined && payload.status !== 0) general.push(['Error', payload.failure])
        if (payload.redirectedTo !== undefined) general.push(['Redirected to', payload.redirectedTo])
        if (payload.remoteAddress !== undefined) general.push(['Remote address', payload.remoteAddress])
        if (payload.protocol !== undefined) general.push(['Protocol', payload.protocol])
        if (payload.resourceType !== undefined) general.push(['Type', payload.resourceType])
        general.push(['Served from', payload.servedFrom ?? 'network'])
        general.push(['Started', new Date(payload.ts).toLocaleTimeString()])
        return [
          section('General', kv(general), true),
          section(`Response headers (${String(Object.keys(headers.responseHeaders).length)})`, headerList(headers.responseHeaders, 'No response headers.'), true),
          section(`Request headers (${String(Object.keys(headers.requestHeaders).length)})`, headerList(headers.requestHeaders, 'No request headers were captured.'), true),
        ]
      }
      case 'payload': {
        const out: HTMLElement[] = []
        const query = queryOf(payload.url)
        if (query.length > 0) out.push(section(`Query string (${String(query.length)})`, kv(query), true))
        const body = payload.requestBody ?? ''
        if (body !== '') out.push(section('Request body', bodyView(body, contentTypeOf(payload.requestHeaders), true), true, () => this.#copy(body, 'Request body copied')))
        if (out.length === 0) out.push(el('p', 'fl-net-note', 'This request sent no query string and no body.'))
        return out
      }
      case 'preview': {
        const body = payload.responseBody ?? ''
        if (body === '') return [el('p', 'fl-net-note', noBodyNote(capture))]
        const json = parseJson(body)
        if (json !== null) return [renderJsonTree(json.value)]
        return [el('pre', 'fl-net-raw', body)]
      }
      case 'response': {
        const body = payload.responseBody ?? ''
        if (body === '') return [el('p', 'fl-net-note', noBodyNote(capture))]
        return [el('pre', 'fl-net-raw', formatBody(body, payload.mimeType ?? contentTypeOf(payload.responseHeaders)))]
      }
      case 'timing':
        return [timingView(capture, this.#recorded())]
      case 'initiator':
        return [initiatorView(capture)]
    }
  }

  #closeButton(): HTMLElement {
    const close = el('button', 'fl-net-close', '×')
    close.type = 'button'
    close.title = 'Close details'
    close.setAttribute('aria-label', 'Close details')
    close.addEventListener('click', () => this.#select(null))
    return close
  }

  #buildDetailFoot(): HTMLElement {
    const foot = el('div', 'fl-net-detail-foot')
    const button = (label: string, run: (capture: BrowserNetworkCapture) => void, primary = false): HTMLButtonElement => {
      const b = el('button', `fl-net-btn${primary ? ' is-primary' : ''}`, label)
      b.type = 'button'
      b.addEventListener('click', () => {
        if (this.#detailCapture !== null) run(this.#detailCapture)
      })
      return b
    }
    foot.append(
      button('Add to chat', (capture) => void this.#addToChat([capture.id]), true),
      button('Copy as cURL', (capture) => this.#copy(toCurl(forCopy(capture)), 'cURL copied')),
      button('Copy as fetch', (capture) => this.#copy(toFetch(forCopy(capture)), 'fetch call copied')),
      button('Send again', (capture) => void this.#replay(capture.id)),
    )
    return foot
  }

  #onListKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return
    if (this.#rows.length === 0) return
    event.preventDefault()
    const index = this.#rows.findIndex((row) => this.#selectedId !== null && row.ids.includes(this.#selectedId))
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    const next = this.#rows[index === -1 ? (step < 0 ? this.#rows.length - 1 : 0) : Math.max(0, Math.min(this.#rows.length - 1, index + step))]
    if (next === undefined) return
    this.#select(next.capture.id)
    this.#body.querySelector(`[data-id="${CSS.escape(next.capture.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  #toggleRecording(): void {
    this.#recording = !this.#recording
    if (this.#recording) {
      const open = this.#pauses[this.#pauses.length - 1]
      if (open !== undefined && open.to === null) open.to = Date.now()
    } else {
      this.#pauses.push({ from: Date.now(), to: null })
    }
    this.#syncRecordButton()
    this.#render()
  }

  #syncRecordButton(): void {
    this.#recordBtn.replaceChildren(el('span', `fl-net-dot${this.#recording ? '' : ' is-off'}`), document.createTextNode(this.#recording ? 'Recording' : 'Paused'))
    this.#recordBtn.title = this.#recording ? 'Stop recording requests' : 'Start recording requests'
    this.#recordBtn.setAttribute('aria-pressed', String(this.#recording))
  }

  #clear(): void {
    this.#clearedAt = Date.now()
    this.#select(null)
    this.#render()
  }

  /** Add requests to the chat, bodies included (read now, redacted on the way). */
  async #addToChat(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    if (ids.length === 1 && ids[0] !== undefined) {
      await this.#api.tagEntry({ kind: 'network', id: ids[0] }).catch((error: unknown) => console.warn('flow: add request failed', error))
      this.#say('Added to chat')
      return
    }
    try {
      const all = await this.#api.bufferSlice({ kind: 'network', selector: { mode: 'last-n', n: LIST_N } })
      const wanted = new Set(ids)
      const picked = all.filter((capture) => wanted.has(capture.id))
      addCapturesToContext(picked, 'Network')
      this.#say(`Added ${String(picked.length)} requests to chat`)
    } catch (error) {
      console.warn('flow: add requests failed', error)
    }
  }

  async #replay(id: string): Promise<void> {
    if (this.#api.replay === undefined) return
    const result = await this.#api.replay({ id }).catch(() => ({ ok: false, detail: 'It could not be sent.' }))
    this.#say(result.ok ? 'Sent again. The new request is at the end of the list.' : (result.detail ?? 'It could not be sent.'))
    this.refresh()
  }

  #copy(text: string, done: string): void {
    void navigator.clipboard.writeText(text).then(
      () => this.#say(done),
      () => this.#say('Flow could not copy to the clipboard.'),
    )
  }

  #say(text: string): void {
    this.#flash.textContent = text
    this.#flash.classList.add('is-on')
    if (this.#flashTimer !== null) clearTimeout(this.#flashTimer)
    this.#flashTimer = setTimeout(() => this.#flash.classList.remove('is-on'), 2200)
  }

  #check(label: string, title: string, on: boolean, change: (on: boolean) => void): HTMLElement {
    const wrap = el('label', 'fl-net-check')
    wrap.title = title
    const box = el('input')
    box.type = 'checkbox'
    box.checked = on
    box.addEventListener('change', () => change(box.checked))
    wrap.append(box, document.createTextNode(label))
    return wrap
  }

  // ── Right-click menu ──────────────────────────────────────────────────────

  /** Open the menu for a row, at the pointer. Public for the list's handler. */
  #openMenu(x: number, y: number, row: NetworkRow): void {
    const payload = row.capture.payload
    const host = hostOf(payload.url)
    const name = nameOf(payload.url).split('?')[0] ?? ''
    const items: (null | { label: string; run: () => void })[] = [
      { label: 'Add to chat', run: () => void this.#addToChat([row.capture.id]) },
      ...(row.count > 1 ? [{ label: `Add all ${String(row.count)} ${name} requests to chat`, run: () => void this.#addToChat(row.ids) }] : []),
      null,
      { label: 'Copy URL', run: () => this.#copy(payload.url, 'URL copied') },
      { label: 'Copy as cURL', run: () => void this.#withFull(row.capture.id, (c) => this.#copy(toCurl(forCopy(c)), 'cURL copied')) },
      { label: 'Copy as fetch', run: () => void this.#withFull(row.capture.id, (c) => this.#copy(toFetch(forCopy(c)), 'fetch call copied')) },
      { label: 'Copy response', run: () => void this.#withFull(row.capture.id, (c) => this.#copy(c.payload.responseBody ?? '', 'Response copied')) },
      null,
      { label: 'Send again', run: () => void this.#replay(row.capture.id) },
      ...(/^https?:/i.test(payload.url) ? [{ label: 'Open in new tab', run: () => this.#host.openUrl(payload.url) }] : []),
      ...(host !== ''
        ? [
            null,
            {
              label: `Hide requests to ${host}`,
              run: () => {
                this.#filterInput.value = `${this.#filterInput.value.trim()} -domain:${host}`.trim()
                this.#filters.query = this.#filterInput.value
                this.#render()
              },
            },
          ]
        : []),
    ]
    this.#menu.replaceChildren(
      ...items.map((item) => {
        if (item === null) return el('hr')
        const b = el('button', '', item.label)
        b.type = 'button'
        b.setAttribute('role', 'menuitem')
        b.addEventListener('click', () => {
          this.#closeMenu()
          item.run()
        })
        return b
      }),
    )
    this.#menu.hidden = false
    const { offsetWidth: w, offsetHeight: h } = this.#menu
    this.#menu.style.left = `${String(Math.max(4, Math.min(x, window.innerWidth - w - 8)))}px`
    this.#menu.style.top = `${String(Math.max(4, Math.min(y, window.innerHeight - h - 8)))}px`
    this.#menu.querySelector<HTMLElement>('button')?.focus()
  }

  #closeMenu(): void {
    this.#menu.hidden = true
  }

  async #withFull(id: string, run: (capture: BrowserNetworkCapture) => void): Promise<void> {
    const found = await this.#api.bufferSlice({ kind: 'network', selector: { mode: 'single', id } }).catch(() => [])
    const first = found[0]
    if (first?.kind === 'network') run(first)
    else this.#say('That request is no longer in the list.')
  }

  /** Wire the row handlers once, by delegation (rows are rebuilt on every read). */
  wireRows(): void {
    this.#body.addEventListener('click', (event) => {
      const tr = (event.target as HTMLElement).closest<HTMLElement>('.fl-net-row')
      const id = tr?.dataset['id']
      if (id !== undefined) this.#select(id)
    })
    this.#body.addEventListener('contextmenu', (event) => {
      const tr = (event.target as HTMLElement).closest<HTMLElement>('.fl-net-row')
      const row = this.#rows.find((entry) => entry.capture.id === tr?.dataset['id'])
      if (row === undefined) return
      event.preventDefault()
      this.#select(row.capture.id)
      this.#openMenu(event.clientX, event.clientY, row)
    })
  }
}

function columnClass(column: Column): string {
  return [column.extra === true ? 'is-extra' : '', column.wide === true ? 'is-wide' : ''].filter(Boolean).join(' ')
}

/** Build a panel with its row handlers wired. */
export function createNetworkPanel(api: NetworkPanelApi, host: NetworkPanelHost): NetworkPanel {
  const panel = new NetworkPanel(api, host)
  panel.wireRows()
  return panel
}

// ── Detail pieces ───────────────────────────────────────────────────────────

/** The capture to copy from: headers redacted, bodies as captured. */
function forCopy(capture: BrowserNetworkCapture): BrowserNetworkCapture['payload'] {
  const redacted = redactAndBound(capture)
  const headers = redacted.kind === 'network' ? redacted.payload : capture.payload
  return { ...capture.payload, requestHeaders: headers.requestHeaders, responseHeaders: headers.responseHeaders }
}

function queryOf(url: string): [string, string][] {
  try {
    return [...new URL(url).searchParams.entries()]
  } catch {
    return []
  }
}

function noBodyNote(capture: BrowserNetworkCapture): string {
  if (capture.payload.status === 0) return 'No response arrived.'
  if (capture.withheld === true) return 'The body was too large to keep.'
  return 'This response has no body.'
}

function section(title: string, content: HTMLElement, open: boolean, copy?: () => void): HTMLElement {
  const details = el('details', 'fl-net-section')
  details.open = open
  const summary = el('summary', '', title)
  if (copy !== undefined) {
    const b = el('button', 'fl-net-btn fl-net-section-act', 'Copy')
    b.type = 'button'
    b.addEventListener('click', (event) => {
      event.preventDefault()
      copy()
    })
    summary.append(b)
  }
  details.append(summary, content)
  return details
}

function kv(rows: readonly [string, string][]): HTMLElement {
  const dl = el('dl', 'fl-net-kv')
  for (const [name, value] of rows) {
    const dd = el('dd', '', value)
    if (value === '[redacted]') {
      dd.textContent = 'hidden by Flow'
      dd.classList.add('is-hidden')
    }
    dl.append(el('dt', '', name), dd)
  }
  return dl
}

function headerList(headers: Record<string, string>, empty: string): HTMLElement {
  const rows = Object.entries(headers ?? {})
    .map(([name, value]): [string, string] => [name.toLowerCase(), String(value)])
    .sort((a, b) => a[0].localeCompare(b[0]))
  return rows.length === 0 ? el('p', 'fl-net-note', empty) : kv(rows)
}

function bodyView(body: string, contentType: string, asFields: boolean): HTMLElement {
  const json = parseJson(body)
  if (json !== null) return renderJsonTree(json.value)
  if (asFields && /x-www-form-urlencoded/i.test(contentType)) {
    try {
      return kv([...new URLSearchParams(body).entries()])
    } catch {
      // Not readable as fields after all — show it as it came.
    }
  }
  return el('pre', 'fl-net-raw', formatBody(body, contentType))
}

const PHASE_COLOR: Record<string, string> = {
  queued: 'var(--fl-net-queue)',
  dns: 'var(--fl-net-dns)',
  connect: 'var(--fl-net-connect)',
  tls: 'var(--fl-net-tls)',
  send: 'var(--fl-net-send)',
  wait: 'var(--fl-net-wait)',
  download: 'var(--fl-net-download)',
}

function waterfallBar(capture: BrowserNetworkCapture, range: { start: number; end: number }): HTMLElement {
  const payload = capture.payload
  const track = el('div', 'fl-net-wf')
  const bar = el('div', 'fl-net-wf-bar')
  const { left, width } = barOf(payload, range)
  bar.style.left = `${String(left * 100)}%`
  bar.style.width = `max(2px, ${String(width * 100)}%)`
  const phases = phaseList(payload)
  const total = phases.reduce((sum, phase) => sum + phase.ms, 0)
  if (isError(payload) && payload.status === 0) bar.classList.add('is-failed')
  else if (total > 0) {
    for (const phase of phases) {
      const seg = el('span')
      seg.style.width = `${String((phase.ms / total) * 100)}%`
      seg.style.background = PHASE_COLOR[phase.id] ?? 'var(--fl-net-wait)'
      bar.append(seg)
    }
  }
  bar.title = `Started ${formatDuration(payload.ts - range.start)} in, took ${formatDuration(payload.timingMs)}`
  track.append(bar)
  return track
}

function timingView(capture: BrowserNetworkCapture, recorded: readonly BrowserNetworkCapture[]): HTMLElement {
  const payload = capture.payload
  const wrap = el('div', 'fl-net-timing')
  const phases = phaseList(payload)
  const range = timeRange(recorded)
  if (range !== null) wrap.append(el('p', 'fl-net-note', `Started ${formatDuration(payload.ts - range.start)} after the first request in the list.`))
  if (phases.length === 0) {
    wrap.append(
      el(
        'p',
        'fl-net-note',
        payload.status === 0
          ? `The request failed before the browser timed it${payload.failure !== undefined ? `: ${failureLabel(payload)}` : ''}.`
          : 'The browser did not report a breakdown for this request.',
      ),
    )
    wrap.append(el('p', 'fl-net-timing-total', `Total ${formatDuration(payload.timingMs)}`))
    return wrap
  }
  const total = Math.max(payload.timingMs, phases.reduce((sum, phase) => sum + phase.ms, 0), 1)
  const grid = el('div', 'fl-net-timing-grid')
  let at = 0
  let lastGroup = ''
  const GROUP_LABEL: Record<string, string> = { queue: 'Queue', connection: 'Connection', response: 'Request and response' }
  for (const phase of phases) {
    if (phase.group !== lastGroup) {
      grid.append(el('span', 'fl-net-timing-group', GROUP_LABEL[phase.group] ?? phase.group))
      lastGroup = phase.group
    }
    const trackEl = el('span', 'fl-net-timing-track')
    const seg = el('span', 'fl-net-timing-seg')
    seg.style.left = `${String((at / total) * 100)}%`
    seg.style.width = `max(2px, ${String((phase.ms / total) * 100)}%)`
    seg.style.background = PHASE_COLOR[phase.id] ?? 'var(--fl-net-wait)'
    trackEl.append(seg)
    grid.append(el('span', 'fl-net-timing-label', phase.label), trackEl, el('span', 'fl-net-timing-ms', `${phase.ms.toFixed(1)} ms`))
    at += phase.ms
  }
  wrap.append(grid, el('p', 'fl-net-timing-total', `Total ${formatDuration(payload.timingMs)}`))
  const wait = payload.phases?.wait ?? 0
  if (wait > 0 && wait / total > 0.6) {
    wrap.append(el('p', 'fl-net-note', 'Most of this time the browser was waiting for the server to answer.'))
  }
  return wrap
}

function initiatorView(capture: BrowserNetworkCapture): HTMLElement {
  const initiator = capture.payload.initiator
  const wrap = el('div', 'fl-net-initiator')
  if (initiator === undefined) {
    wrap.append(el('p', 'fl-net-note', 'The browser did not say what sent this request.'))
    return wrap
  }
  const where = initiator.url !== undefined ? `${initiator.url}${initiator.line !== undefined ? `:${String(initiator.line)}` : ''}${initiator.column !== undefined ? `:${String(initiator.column)}` : ''}` : ''
  const KIND: Record<string, string> = {
    parser: 'The page itself, while it was being read',
    script: 'A script',
    preflight: 'The browser, checking it may send the request (a preflight)',
    redirect: 'A redirect',
    other: 'Something other than the page, such as typing the address',
  }
  wrap.append(section('Sent by', kv([['Who', KIND[initiator.type] ?? initiator.type], ...(where !== '' ? ([['Where', where]] as [string, string][]) : [])]), true))
  if (initiator.stack !== undefined && initiator.stack.length > 0) {
    const list = el('ol', 'fl-net-stack')
    for (const frame of initiator.stack) {
      if (frame.async === true) list.append(el('li', 'fl-net-stack-async', '(async)'))
      const li = el('li')
      li.append(el('span', 'fl-net-stack-fn', frame.functionName === '' ? '(anonymous)' : frame.functionName), el('span', 'fl-net-dim', ` ${frame.url}:${String(frame.line)}:${String(frame.column)}`))
      li.title = `${frame.url}:${String(frame.line)}:${String(frame.column)}`
      list.append(li)
    }
    wrap.append(section('Call stack', list, true))
  }
  return wrap
}

// ── Styles ──────────────────────────────────────────────────────────────────

const STYLE_ID = 'fl-net-styles'

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .fl-net {
      --fl-net-queue: #9a9a92;
      --fl-net-dns: #2f9e8f;
      --fl-net-connect: #d97a2b;
      --fl-net-tls: #a35bd6;
      --fl-net-send: #6b8afd;
      --fl-net-wait: #3e9b6b;
      --fl-net-download: #4f7cff;
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
      color: var(--fl-color-text);
      container-type: inline-size;
      outline: none;
    }
    .fl-net-toolbar, .fl-net-chips, .fl-net-missed, .fl-net-status,
    .fl-net-detail-head, .fl-net-detail-tabs, .fl-net-detail-foot { flex: none; }
    .fl-net-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 8px;
      padding: 4px var(--fl-space-sm);
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-net-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 22px;
      padding: 0 8px;
      border: var(--fl-border-width) solid transparent;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      font: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    .fl-net-btn:hover { background: var(--fl-color-surface-raised); color: var(--fl-color-text); }
    .fl-net-btn.is-primary {
      color: var(--fl-color-accent);
      border-color: color-mix(in srgb, var(--fl-color-accent) 35%, transparent);
    }
    .fl-net-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fl-color-error); }
    .fl-net-dot.is-off { background: var(--fl-color-text-secondary); }
    .fl-net-sep { width: 1px; height: 16px; background: var(--fl-color-border); }
    .fl-net-search {
      display: flex;
      flex: 1 1 220px;
      min-width: 140px;
      height: 22px;
      align-items: center;
      padding: 0 6px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface);
    }
    .fl-net-search:focus-within { border-color: var(--fl-color-accent); }
    .fl-net-search input {
      flex: 1;
      min-width: 0;
      border: 0;
      outline: none;
      background: transparent;
      color: var(--fl-color-text);
      font: inherit;
    }
    .fl-net-check {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--fl-color-text-secondary);
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
    }
    .fl-net-check input { margin: 0; accent-color: var(--fl-color-accent); }
    .fl-net-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
      padding: 3px var(--fl-space-sm);
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-net-chip {
      height: 20px;
      padding: 0 8px;
      border: 0;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      font: inherit;
      cursor: pointer;
    }
    .fl-net-chip:hover { background: var(--fl-color-surface-raised); }
    .fl-net-chip.is-on {
      background: color-mix(in srgb, var(--fl-color-accent) 16%, transparent);
      color: var(--fl-color-accent);
    }
    .fl-net-chip-count { margin-left: 4px; opacity: 0.7; font-variant-numeric: tabular-nums; }
    .fl-net-missed {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 3px var(--fl-space-sm);
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
      background: color-mix(in srgb, var(--fl-color-warning) 12%, transparent);
      color: var(--fl-color-text);
    }
    .fl-net-missed[hidden] { display: none; }
    .fl-net-missed span { flex: 1; min-width: 0; }
    .fl-net-overview {
      flex: none;
      height: 22px;
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-surface-sunken, var(--fl-color-surface));
    }
    .fl-net-overview canvas { display: block; width: 100%; height: 100%; }
    .fl-net-split {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
    }
    .fl-net-split.has-detail { grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); }
    .fl-net-list { overflow: auto; min-width: 0; outline: none; }
    .fl-net-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
    }
    .fl-net-table th {
      position: sticky;
      top: 0;
      z-index: 1;
      padding: 3px 6px;
      background: var(--fl-color-surface);
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
      border-right: var(--fl-border-width) solid var(--fl-color-border);
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      font-weight: 500;
      text-align: left;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
    }
    .fl-net-table th:last-child, .fl-net-table td:last-child { border-right: 0; }
    .fl-net-table th:focus-visible { outline: 1px solid var(--fl-color-accent); outline-offset: -1px; }
    .fl-net-arrow { margin-left: 4px; color: var(--fl-color-accent); }
    .fl-net-table td {
      padding: 2px 6px;
      border-right: var(--fl-border-width) solid var(--fl-color-border);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-variant-numeric: tabular-nums;
    }
    .fl-net-row { cursor: default; }
    .fl-net-row:nth-child(even) td { background: color-mix(in srgb, var(--fl-color-surface-raised) 40%, transparent); }
    .fl-net-row:hover td { background: var(--fl-color-surface-raised); }
    .fl-net-row.is-selected td { background: color-mix(in srgb, var(--fl-color-accent) 18%, transparent); }
    .fl-net-row.is-error .fl-net-name, .fl-net-row.is-error .fl-net-status-cell { color: var(--fl-color-error); }
    .fl-net-table td.is-num { text-align: right; }
    .fl-net-dim { color: var(--fl-color-text-secondary); }
    .fl-net-host { margin-left: 6px; color: var(--fl-color-text-secondary); }
    .fl-net-repeat {
      margin-left: 6px;
      padding: 0 5px;
      border-radius: 8px;
      background: var(--fl-color-surface-selected, var(--fl-color-surface-raised));
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
    }
    .fl-net-wf { position: relative; height: 10px; }
    .fl-net-wf-bar {
      position: absolute;
      top: 2px;
      height: 6px;
      display: flex;
      overflow: hidden;
      border-radius: 2px;
      background: var(--fl-net-wait);
    }
    .fl-net-wf-bar.is-failed { background: var(--fl-color-error); }
    .fl-net-wf-bar span { height: 100%; }
    .fl-net-split.has-detail .is-extra,
    .fl-net-split.has-detail .is-wide,
    .fl-net-split.has-detail .fl-net-failure { display: none; }
    @container (max-width: 640px) { .fl-net .is-extra { display: none; } }
    .fl-net-empty { padding: var(--fl-space-md); color: var(--fl-color-text-secondary); text-align: center; }
    .fl-net-detail {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      border-left: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-net-detail-head {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px var(--fl-space-sm);
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
      min-width: 0;
    }
    .fl-net-detail-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
    }
    .fl-net-pill {
      padding: 0 6px;
      border-radius: 8px;
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-caption-size);
    }
    .fl-net-pill.is-ok { color: var(--fl-color-success, #3e9b6b); }
    .fl-net-pill.is-warn { color: var(--fl-color-warning); }
    .fl-net-pill.is-error { color: var(--fl-color-error); }
    .fl-net-close {
      border: 0;
      background: transparent;
      color: var(--fl-color-text-secondary);
      font-size: 15px;
      line-height: 1;
      padding: 2px 6px;
      border-radius: var(--fl-radius-sm);
      cursor: pointer;
    }
    .fl-net-close:hover { background: var(--fl-color-surface-raised); color: var(--fl-color-text); }
    .fl-net-detail-tabs {
      display: flex;
      gap: 2px;
      padding: 3px var(--fl-space-sm);
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
      overflow-x: auto;
    }
    .fl-net-detail-tab {
      height: 22px;
      padding: 0 8px;
      border: 0;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      font: inherit;
      white-space: nowrap;
      cursor: pointer;
    }
    .fl-net-detail-tab.is-on { background: var(--fl-color-surface-raised); color: var(--fl-color-text); }
    .fl-net-detail-tab.is-empty { opacity: 0.5; }
    .fl-net-detail-body { flex: 1; min-height: 0; overflow: auto; padding: 6px var(--fl-space-sm) 12px; }
    .fl-net-detail-foot {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 4px var(--fl-space-sm);
      border-top: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-net-section { border-bottom: var(--fl-border-width) solid var(--fl-color-border); padding: 2px 0 6px; }
    .fl-net-section:last-child { border-bottom: 0; }
    .fl-net-section > summary {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 0;
      font-weight: 600;
      cursor: pointer;
    }
    .fl-net-section-act { margin-left: auto; font-weight: 400; }
    .fl-net-kv {
      display: grid;
      grid-template-columns: minmax(100px, 32%) minmax(0, 1fr);
      gap: 2px 10px;
      margin: 0;
      padding-left: 12px;
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
    }
    .fl-net-kv dt { color: var(--fl-color-text-secondary); overflow-wrap: anywhere; }
    .fl-net-kv dd { margin: 0; overflow-wrap: anywhere; }
    .fl-net-kv dd.is-hidden { color: var(--fl-color-text-secondary); font-style: italic; }
    .fl-net-note { margin: 4px 0; color: var(--fl-color-text-secondary); }
    .fl-net-raw {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
      line-height: 1.5;
    }
    .fl-net-tree { font-family: var(--fl-font-mono); font-size: var(--fl-text-mono-size); line-height: 1.6; }
    .fl-net-tree-node { padding-left: 0; }
    .fl-net-tree-kids { display: none; padding-left: 16px; }
    .fl-net-tree-node.is-open > .fl-net-tree-kids { display: block; }
    .fl-net-tree-toggle, .fl-net-tree-spacer {
      display: inline-block;
      width: 14px;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--fl-color-text-secondary);
      font: inherit;
      cursor: pointer;
    }
    .fl-net-tree-toggle::before { content: '▸'; }
    .fl-net-tree-node.is-open > .fl-net-tree-toggle::before { content: '▾'; }
    .fl-net-tree-key { color: var(--fl-color-accent); }
    .fl-net-tree-punct, .fl-net-tree-peek, .fl-net-tree-null { color: var(--fl-color-text-secondary); }
    .fl-net-tree-node.is-open > .fl-net-tree-peek { opacity: 0.6; }
    .fl-net-tree-string { color: var(--fl-color-success, #3e9b6b); }
    .fl-net-tree-number { color: var(--fl-color-warning); }
    .fl-net-tree-bool { color: var(--fl-net-tls); }
    .fl-net-tree-more { margin-top: 6px; color: var(--fl-color-text-secondary); }
    .fl-net-timing-grid {
      display: grid;
      grid-template-columns: minmax(110px, auto) minmax(0, 1fr) 72px;
      gap: 4px 10px;
      align-items: center;
    }
    .fl-net-timing-group {
      grid-column: 1 / -1;
      margin-top: 6px;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .fl-net-timing-label { color: var(--fl-color-text-secondary); }
    .fl-net-timing-track { position: relative; height: 10px; border-radius: 2px; background: var(--fl-color-surface-raised); }
    .fl-net-timing-seg { position: absolute; top: 0; bottom: 0; border-radius: 2px; }
    .fl-net-timing-ms { text-align: right; font-family: var(--fl-font-mono); font-variant-numeric: tabular-nums; }
    .fl-net-timing-total { margin: 8px 0 0; font-weight: 600; text-align: right; }
    .fl-net-stack { margin: 0; padding-left: 14px; list-style: none; font-family: var(--fl-font-mono); font-size: var(--fl-text-mono-size); }
    .fl-net-stack li { padding: 1px 0; overflow-wrap: anywhere; }
    .fl-net-stack-async { color: var(--fl-color-text-secondary); font-style: italic; }
    .fl-net-status {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 3px var(--fl-space-sm);
      border-top: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-surface-sunken, var(--fl-color-surface));
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      font-variant-numeric: tabular-nums;
    }
    .fl-net-status-facts { display: flex; flex-wrap: wrap; gap: 2px 14px; flex: 1; min-width: 0; }
    .fl-net-status b { color: var(--fl-color-text); font-weight: 500; }
    .fl-net-status .is-error { color: var(--fl-color-error); }
    .fl-net-status .is-accent { color: var(--fl-color-accent); }
    .fl-net-flash { opacity: 0; transition: opacity 150ms ease; color: var(--fl-color-text); white-space: nowrap; }
    .fl-net-flash.is-on { opacity: 1; }
    .fl-net-menu {
      position: fixed;
      z-index: 1000;
      min-width: 200px;
      padding: 4px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md, 6px);
      background: var(--fl-color-surface);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    }
    .fl-net-menu button {
      display: block;
      width: 100%;
      padding: 4px 10px;
      border: 0;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .fl-net-menu button:hover, .fl-net-menu button:focus-visible {
      background: color-mix(in srgb, var(--fl-color-accent) 16%, transparent);
      outline: none;
    }
    .fl-net-menu hr { margin: 4px 2px; border: 0; border-top: var(--fl-border-width) solid var(--fl-color-border); }
    @media (prefers-reduced-motion: reduce) { .fl-net-flash { transition: none; } }
  `
  document.head.appendChild(style)
}
