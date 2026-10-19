// The ⌘P command palette overlay — a floating, keyboard-first blend of files,
// threads, and commands. Reuses the shipped modal chrome (.fl-settings-overlay
// backdrop + injectSettingsStyles) and the virtualized <fl-list>; all matching,
// ranking, and source logic lives in the pure/DOM-free sibling modules — this
// file is only the view: mount, open/close, input → providers → rank → render,
// and activate.
//
// Registers as a `.fl-settings-overlay` so the shell's single keydown guard
// (shell.ts) and the terminal focus-guard treat it as modal; while open, this
// view owns the keyboard (arrows/Enter/Escape handled on the input).

import { FlList, type ListItemDetail } from '../components/fl-list'
import { injectSettingsStyles } from '../settings/settings-view'
import { markModalOverlay } from '../modal-overlay'
import { FlIcon } from '../components/fl-icon'
import { fileIconColor } from '../editor/file-icon-color'
import type { EditorApi } from '../editor'
import type { PaletteCandidate, PaletteMode } from './palette-types'
import { focusToCapture, focusToRestore, type CloseReason } from './palette-focus'
import { parseQuery } from './palette-query'
import { rankCandidates, emptyStateResults } from './palette-rank'
import { readPrimaryRoot } from '../primary-root'
import {
  commandCandidates,
  fileCandidates,
  threadCandidates,
  loadCommandList,
  type PaletteSourceDeps,
} from './palette-sources'
import type { PaletteCommand, PaletteEmit } from './palette-commands'

const OPEN_EVENT = 'flow:open-palette'
/** Coalesce keystrokes before fanning out to the (async) file/thread providers. */
const INPUT_DEBOUNCE_MS = 120
/** Recents/actions shown for the empty content term. */
const RECENT_THREADS = 6
/** Per-kind row icon: files reuse the app's generic `file` glyph (tinted by
 *  extension via fileIconColor — TS/PY/MD blue, JS/JSON yellow, …), threads get
 *  the chat bubble, commands the terminal glyph. */
const KIND_ICON: Record<PaletteCandidate['kind'], string> = {
  file: 'file',
  thread: 'message',
  command: 'terminal',
}

let stylesInjected = false

function injectPaletteStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-palette-panel {
      width: min(620px, 92vw);
      display: flex;
      flex-direction: column;
      background: var(--fl-color-surface);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-lg, 10px);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
      overflow: hidden;
    }
    .fl-palette-input {
      border: none;
      outline: none;
      background: transparent;
      color: var(--fl-color-text);
      font-size: var(--fl-text-ui-size);
      padding: var(--fl-space-md) var(--fl-space-lg);
      /* Region seam — the query row against the results. The palette's own
         outline below stays the object-edge token. */
      border-bottom: var(--fl-border-width) solid var(--fl-color-separator);
    }
    .fl-palette-input::placeholder { color: var(--fl-color-text-secondary); }
    .fl-palette-list { height: 360px; min-height: 0; }
    .fl-palette-empty {
      padding: var(--fl-space-lg);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-ui-size);
    }
    .fl-palette-hint {
      padding: var(--fl-space-xs) var(--fl-space-lg);
      /* Region seam — the footer strip against the results. */
      border-top: var(--fl-border-width) solid var(--fl-color-separator);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
  `
  document.head.appendChild(style)
}

/** Live emitter — the app CustomEvent bridge the source `run` closures fire. */
const emitEvent: PaletteEmit = (type, detail) =>
  document.dispatchEvent(new CustomEvent(type, detail === undefined ? {} : { detail }))

class CommandPalette {
  readonly #editor: EditorApi
  readonly #overlay: HTMLDivElement
  readonly #input: HTMLInputElement
  readonly #list: FlList<PaletteCandidate>
  /** The file list this palette session is filtering, held for its lifetime. */
  #heldFiles: { rootPath: string; result: { relPaths: string[]; truncated: boolean } } | null = null
  readonly #deps: PaletteSourceDeps

  #open = false
  /** Monotonic query generation — every keystroke bumps it so a slow async
   *  provider from a superseded keystroke drops its results. */
  #generation = 0
  #debounce: ReturnType<typeof setTimeout> | null = null
  #root: string | null = null
  /** Cached command list (static registry + folded slash commands) per open. */
  #commands: PaletteCommand[] = []
  #items: PaletteCandidate[] = []
  /** Whoever owned the keyboard when the palette opened (#1100) — a cancel
   *  (Escape / backdrop) hands it straight back, so the keyboard-first
   *  open→cancel→keep-typing loop never needs the mouse. */
  #previousFocus: HTMLElement | null = null

  constructor(editor: EditorApi) {
    this.#editor = editor
    injectSettingsStyles()
    injectPaletteStyles()

    this.#overlay = document.createElement('div')
    this.#overlay.className = 'fl-settings-overlay'
    // Modal chrome: declare it to the shared guard so global panel shortcuts,
    // the terminal's autofocus and the focus trap all treat it as owning the
    // keyboard (#1002).
    markModalOverlay(this.#overlay)
    this.#overlay.hidden = true
    this.#overlay.addEventListener('mousedown', (event) => {
      if (event.target === this.#overlay) this.close('cancel')
    })

    const panel = document.createElement('div')
    panel.className = 'fl-palette-panel'

    this.#input = document.createElement('input')
    this.#input.className = 'fl-palette-input'
    this.#input.type = 'text'
    this.#input.setAttribute('aria-label', 'Command palette')
    this.#input.placeholder = 'Search files & threads — type > for commands'
    // Combobox wiring to the list the input drives (#1755). Expanded is
    // statically true: the input only exists inside the open overlay.
    this.#input.setAttribute('role', 'combobox')
    this.#input.setAttribute('aria-expanded', 'true')
    this.#input.setAttribute('aria-autocomplete', 'list')
    this.#input.setAttribute('aria-controls', 'fl-palette-listbox')
    this.#input.addEventListener('input', () => this.#onInput())
    this.#input.addEventListener('keydown', (event) => void this.#onInputKeydown(event))

    this.#list = document.createElement('fl-list') as FlList<PaletteCandidate>
    this.#list.className = 'fl-palette-list'
    this.#list.id = 'fl-palette-listbox'
    this.#list.renderItem = (item) => this.#renderRow(item)
    this.#list.addEventListener('fl-list-activate', (event) => {
      const detail = (event as CustomEvent<ListItemDetail<PaletteCandidate>>).detail
      this.#activate(detail.item)
    })

    const hint = document.createElement('div')
    hint.className = 'fl-palette-hint'
    hint.textContent = "↑↓ to navigate · Enter to open · > for commands · Esc to close"

    panel.append(this.#input, this.#list, hint)
    this.#overlay.appendChild(panel)
    document.body.appendChild(this.#overlay)

    this.#deps = {
      // ONCE PER SESSION, NOT PER KEYSTROKE. The file source runs on every
      // character typed, and it was asking for the whole list each time —
      // measured on a 4,182-file project: 5,675 paths, 297 KB across IPC, per
      // character. Main already caches the WALK (allowed-pattern #20), so the
      // walk was free and the transfer was the cost: forbidden-pattern #13, a
      // payload re-sent for a view that filters it locally anyway.
      //
      // Held here rather than in the source module because this is where the
      // lifecycle lives: a palette opens, and that is exactly the window in
      // which a person expects the list not to shift under them.
      listAllFiles: async (request) => {
        const held = this.#heldFiles
        if (held !== null && held.rootPath === request.rootPath) return held.result
        const result = await window.flow.project.listAllFiles(request)
        this.#heldFiles = { rootPath: request.rootPath, result }
        return result
      },
      searchThreads: (request) => window.flow.threads.search(request),
      listCommands: (request) => window.flow.project.listCommands(request),
      emit: emitEvent,
    }
  }

  async open(mode: PaletteMode): Promise<void> {
    // A new session sees the tree as it is now — the held list belongs to ONE
    // palette, never across two.
    this.#heldFiles = null
    // Capture BEFORE anything here can move focus (#1100).
    const active = document.activeElement
    this.#previousFocus = focusToCapture({
      active: active instanceof HTMLElement ? active : null,
      body: document.body,
      insidePalette: active instanceof Node && this.#overlay.contains(active),
    })
    this.#open = true
    this.#overlay.hidden = false
    const gen = ++this.#generation

    // Focus the input SYNCHRONOUSLY, before any IPC (#1100, second facet).
    // Escape is handled ONLY on this input (the shell's global keydown guard
    // bails while a `.fl-settings-overlay` is open, and opening the palette
    // moves no focus, so the overlay focus trap's `focusin` backstop never
    // fires either) — waiting for `activeProject()` + `loadCommandList()` left
    // a window in which the keyboard still belonged to the terminal and an
    // immediate "changed my mind" Escape was swallowed by xterm.
    this.#input.value = mode === 'command' ? '>' : ''
    this.#input.focus()
    // Cursor to end (after the `>` in command mode).
    const end = this.#input.value.length
    this.#input.setSelectionRange(end, end)

    // Resolve the working tree + command list fresh on each open (fail-soft).
    // The tree, not the project: ⌘P opens FILES, and a thread that owns a git
    // worktree has different files on a different branch — offering the
    // project's would hand the reader a path their thread cannot see.
    this.#root = await readPrimaryRoot(window.flow.project)
    this.#commands = await loadCommandList(this.#root ?? '', this.#deps)
    if (!this.#open) return

    // The command list only exists now, and the input is live throughout the
    // fetch above — so run against whatever it currently holds, superseding any
    // debounced query that already ranked against an empty command list.
    if (this.#debounce) {
      clearTimeout(this.#debounce)
      this.#debounce = null
    }
    await this.#runQuery(gen === this.#generation ? gen : ++this.#generation)
  }

  /** `reason` decides focus (#1100): a CANCEL hands the keyboard back to
   *  whoever had it; an ACTIVATE leaves it alone so the action's own focus()
   *  wins. The overlay is hidden first either way, so the document-level
   *  overlay focus trap no longer counts this palette as topmost and cannot
   *  pull the restored focus back inside it. */
  close(reason: CloseReason = 'activate'): void {
    this.#open = false
    this.#overlay.hidden = true
    if (this.#debounce) {
      clearTimeout(this.#debounce)
      this.#debounce = null
    }
    this.#input.value = ''
    this.#setItems([])
    const restore = focusToRestore(this.#previousFocus, reason)
    this.#previousFocus = null
    restore?.focus()
  }

  #onInput(): void {
    const gen = ++this.#generation
    if (this.#debounce) clearTimeout(this.#debounce)
    this.#debounce = setTimeout(() => void this.#runQuery(gen), INPUT_DEBOUNCE_MS)
  }

  async #onInputKeydown(event: KeyboardEvent): Promise<void> {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        this.#move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        this.#move(-1)
        break
      case 'Enter': {
        event.preventDefault()
        // Flush any pending debounced query first, so Enter always acts on
        // results matching the CURRENT input — never a stale empty-state row
        // (e.g. the first command action) left selected from before the user
        // typed. Without this, a fast type-then-Enter (or paste+Enter) fires
        // the wrong action.
        await this.#flushPendingQuery()
        const index = this.#list.selectedIndex
        if (index >= 0 && index < this.#items.length) this.#activate(this.#items[index])
        break
      }
      case 'Escape':
        event.preventDefault()
        this.close('cancel')
        break
      default:
        break
    }
  }

  #move(delta: number): void {
    const count = this.#items.length
    if (count === 0) return
    const current = this.#list.selectedIndex
    const next = current < 0 ? (delta > 0 ? 0 : count - 1) : (current + delta + count) % count
    this.#list.selectedIndex = next
  }

  /** Run any pending debounced query NOW (used before Enter activates), so the
   *  selection reflects the current input rather than a stale earlier state. */
  async #flushPendingQuery(): Promise<void> {
    if (this.#debounce === null) return
    clearTimeout(this.#debounce)
    this.#debounce = null
    await this.#runQuery(this.#generation)
  }

  #activate(candidate: PaletteCandidate): void {
    // Close first so focus returns to the app before the action runs (e.g.
    // open-file focuses the editor) — and WITHOUT restoring the pre-open owner,
    // which would immediately steal focus back off the action's surface (#1100).
    this.close('activate')
    candidate.run()
  }

  /** Fan out to the sources for the current input, rank, and render. */
  async #runQuery(gen: number): Promise<void> {
    if (gen !== this.#generation || !this.#open) return
    const { mode, term, isEmpty } = parseQuery(this.#input.value)
    const isStale = (): boolean => gen !== this.#generation || !this.#open

    if (mode === 'command') {
      this.#setItems(rankCandidates(commandCandidates(term, this.#commands)))
      return
    }

    if (isEmpty) {
      await this.#renderEmptyState(gen)
      return
    }

    const root = this.#root
    const [files, threads] = await Promise.all([
      root ? fileCandidates(root, term, this.#deps, isStale) : Promise.resolve([]),
      root ? threadCandidates(root, term, this.#deps, isStale) : Promise.resolve([]),
    ])
    if (isStale()) return
    const commands = commandCandidates(term, this.#commands)
    this.#setItems(rankCandidates([...files, ...threads, ...commands]))
  }

  /** Recents (open tabs + recent threads) + suggested actions for an empty term. */
  async #renderEmptyState(gen: number): Promise<void> {
    const recents: PaletteCandidate[] = []
    const snapshot = this.#editor.snapshotTabs()
    for (const ref of snapshot.openFiles) {
      recents.push({
        kind: 'file',
        id: ref.relPath,
        label: baseName(ref.relPath),
        sublabel: dirName(ref.relPath) || undefined,
        run: () => emitEvent('flow:open-file', { rootPath: ref.rootPath, relPath: ref.relPath }),
      })
    }
    if (this.#root) {
      try {
        const threads = await window.flow.threads.list({
          projectRoot: this.#root,
          limit: RECENT_THREADS,
        })
        if (gen !== this.#generation || !this.#open) return
        for (const thread of threads.slice(0, RECENT_THREADS)) {
          recents.push({
            kind: 'thread',
            id: thread.id,
            label: thread.title,
            recencyAt: thread.updatedAt,
            run: () => emitEvent('flow:open-thread', { threadId: thread.id }),
          })
        }
      } catch {
        // Fail-soft — recents without threads is still useful.
      }
    }
    const actions: PaletteCandidate[] = this.#commands.map((command) => ({
      kind: 'command',
      id: command.id,
      label: command.label,
      sublabel: command.hint,
      icon: command.icon,
      run: command.run,
    }))
    if (gen !== this.#generation || !this.#open) return
    this.#setItems(emptyStateResults(recents, actions))
  }

  #setItems(items: PaletteCandidate[]): void {
    this.#items = items
    this.#list.items = items
    this.#list.selectedIndex = items.length > 0 ? 0 : -1
  }

  // Rows are rendered INSIDE the <fl-list> shadow DOM, which a document.head
  // stylesheet can't reach — so row styling is INLINE (CSS custom properties
  // still inherit through the shadow boundary). Mirrors the file tree's rows.
  #renderRow(candidate: PaletteCandidate): HTMLElement {
    const row = document.createElement('div')
    // Class is a locator marker only (no CSS reaches the fl-list shadow DOM);
    // the layout below is inline.
    row.className = 'fl-palette-row'
    row.style.cssText = 'display:flex;align-items:center;gap:var(--fl-space-sm);width:100%;'

    const kind = document.createElement('fl-icon')
    kind.setAttribute('name', candidate.icon ?? KIND_ICON[candidate.kind])
    kind.setAttribute('size', '14')
    kind.style.flex = 'none'
    // Files get a per-extension tint (TS/PY/MD blue, JS/JSON yellow, …); threads
    // and commands stay muted so the type reads at a glance without shouting.
    kind.style.color =
      candidate.kind === 'file' ? fileIconColor(candidate.label) : 'var(--fl-color-text-secondary)'

    const label = document.createElement('span')
    label.textContent = candidate.label
    label.style.cssText =
      'flex:none;color:var(--fl-color-text);font-size:var(--fl-text-ui-size);white-space:nowrap;'

    row.append(kind, label)
    if (candidate.sublabel) {
      const sub = document.createElement('span')
      sub.textContent = candidate.sublabel
      sub.style.cssText =
        'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'color:var(--fl-color-text-secondary);font-size:var(--fl-text-caption-size);'
      row.appendChild(sub)
    }
    return row
  }
}

function baseName(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash === -1 ? relPath : relPath.slice(slash + 1)
}

function dirName(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash === -1 ? '' : relPath.slice(0, slash)
}

/**
 * Mount the command palette. Opens on `flow:open-palette` (detail `{ mode }` —
 * 'command' pre-fills the `>` prefix). Idempotent per app boot; call once from
 * main.ts after the editor is initialized (it reads snapshotTabs for recents).
 */
export function initCommandPalette(editor: EditorApi): void {
  // Touch FlList/FlIcon so their customElements.define side-effects can't be
  // tree-shaken (the palette creates <fl-list>/<fl-icon> via createElement).
  void FlList
  void FlIcon
  const palette = new CommandPalette(editor)
  document.addEventListener(OPEN_EVENT, (event) => {
    const detail = (event as CustomEvent<{ mode?: PaletteMode }>).detail
    void palette.open(detail?.mode ?? 'content')
  })
}
