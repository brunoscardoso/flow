/**
 * The Source Control diff as a real editor tab (it used to be an overlay that
 * covered the editor area until Esc).
 *
 * ONE tab, VS Code's preview tab: opening another diff replaces what it shows
 * instead of stacking a tab per click, and its label is drawn in italics. The
 * title says which comparison it is — "a.ts (Working Tree)", "a.ts (Index)",
 * "a.ts (1a2b3c4)" — the model lives in diff-tab-model.ts.
 *
 * Above the panes: previous / next change, open the file, word wrap and the
 * inline / side-by-side toggle (the same persisted preferences the overlay
 * had). On a working-tree diff each hunk carries Stage hunk and Revert hunk;
 * on an index diff, Unstage hunk. The buttons are Monaco view zones above the
 * hunk's first line, and they only ever send the hunk's index plus the header
 * and digest they were drawn from — main re-reads the file and refuses a hunk
 * that moved (main/git/hunks.ts).
 *
 * The coordinator keeps owning WHEN a diff is current (git/index.ts): this
 * class only shows what it is handed and says when a person closed the tab.
 */
import type * as Monaco from 'monaco-editor'

import '../components'
import type { GitDiff, GitDiffHunk } from '../../shared/ipc-contract'
import { diffEditorThemeName } from '../editor/monaco-themes'
import { diffNote } from './diff-note'
import {
  DIFF_TAB_ID,
  HUNK_ACTION_LABELS,
  diffSubtitle,
  diffTabTitle,
  hunkActions,
  hunkAnchorLine,
  type DiffTarget,
} from './diff-tab-model'

type MonacoNamespace = typeof Monaco

/** The editor surface a diff tab needs — EditorApi, structurally. */
export interface DiffTabHost {
  monaco(): Promise<MonacoNamespace>
  openView(view: {
    id: string
    label: string
    icon: string
    element: HTMLElement
    preview?: boolean
  }): void
  closeFile(id: string): void
  hasTab(id: string): boolean
  onTabsChanged(listener: () => void): void
}

export interface DiffTabRequest {
  target: DiffTarget
  diff: GitDiff
  /** Path for language colouring; omitted for a whole-commit diff. */
  languagePath?: string
  /** The real file behind the diff — enables Open File. */
  openTarget?: { rootPath: string; relPath: string }
  /**
   * false: a LIVE REFRESH of the diff already open (#402). Its content is
   * replaced in place and the tab is never brought forward — a file the
   * person opened since must stay in front (#953). With no tab open it does
   * nothing.
   */
  reveal?: boolean
}

export type HunkAction = 'stage' | 'unstage' | 'revert'

export interface DiffTabCallbacks {
  /** A person closed the tab. */
  onClosed(): void
  /** A hunk button was pressed. Resolves when the action has settled. */
  onHunk(target: DiffTarget, hunk: GitDiffHunk, action: HunkAction): Promise<void>
}

const BINARY_NOTICE = 'Binary file — content not shown.'
const FONT_FAMILY =
  "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
const WRAP_PREF_KEY = 'flow.diffview.wordWrap'
const SIDE_PREF_KEY = 'flow.diffview.sideBySide'

function readPref(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writePref(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    /* the toggle still works for the session */
  }
}

export class DiffTab {
  #host: DiffTabHost
  #callbacks: DiffTabCallbacks
  #root: HTMLElement | null = null
  #titleEl: HTMLElement | null = null
  #subtitleEl: HTMLElement | null = null
  #noteEl: HTMLElement | null = null
  #openBtn: HTMLButtonElement | null = null
  #wrapBtn: HTMLButtonElement | null = null
  #sideBtn: HTMLButtonElement | null = null
  #body: HTMLElement | null = null
  #editor: Monaco.editor.IStandaloneDiffEditor | null = null
  #models: { original: Monaco.editor.ITextModel; modified: Monaco.editor.ITextModel } | null = null
  #zoneIds: string[] = []
  /** The zones' DOM, removed by hand too: a model swap rebuilds Monaco's view
   *  and the old zone ids no longer name anything it will remove. */
  #zoneNodes: HTMLElement[] = []
  #zoneEditor: Monaco.editor.ICodeEditor | null = null
  #counter = 0
  #request: DiffTabRequest | null = null
  #wordWrap = readPref(WRAP_PREF_KEY)
  #sideBySide = readPref(SIDE_PREF_KEY)
  #open = false
  /** A hunk action is running — every hunk button is off until it settles. */
  #busy = false

  constructor(host: DiffTabHost, callbacks: DiffTabCallbacks) {
    this.#host = host
    this.#callbacks = callbacks
    injectDiffTabStyles()
    host.onTabsChanged(() => {
      if (!this.#open || host.hasTab(DIFF_TAB_ID)) return
      // Closed from its tab — release the models and tell the owner.
      this.#open = false
      this.#release()
      this.#callbacks.onClosed()
    })
  }

  get isOpen(): boolean {
    return this.#open
  }

  get target(): DiffTarget | null {
    return this.#request?.target ?? null
  }

  async show(request: DiffTabRequest): Promise<void> {
    const monaco = await this.#host.monaco()
    const root = this.#ensureRoot()
    this.#request = request
    const { target, diff } = request
    if (this.#titleEl) {
      const shown = target.kind === 'commit-all' ? target.subject : target.filePath
      this.#titleEl.textContent = shown
      this.#titleEl.title = shown
    }
    if (this.#subtitleEl) this.#subtitleEl.textContent = diffSubtitle(target)
    if (this.#openBtn) this.#openBtn.hidden = request.openTarget === undefined
    const note = diffNote(diff)
    if (this.#noteEl) {
      this.#noteEl.textContent = note ?? ''
      this.#noteEl.hidden = note === null
    }

    // The tab first, so Monaco measures a visible host.
    if (request.reveal === false) {
      if (!this.#host.hasTab(DIFF_TAB_ID)) return
    } else {
      this.#host.openView({
        id: DIFF_TAB_ID,
        label: diffTabTitle(target),
        icon: 'git-compare',
        element: root,
        preview: true,
      })
    }
    this.#open = true
    this.#ensureEditor(monaco)

    const previous = this.#models
    this.#counter += 1
    const binary = diff.binary === true
    const suffix = binary ? '/binary.txt' : request.languagePath ? `/${request.languagePath}` : '/commit.txt'
    const uri = (authority: string): Monaco.Uri =>
      monaco.Uri.from({ scheme: 'flow-git', authority, path: `/tab${this.#counter}${suffix}` })
    const original = monaco.editor.createModel(binary ? BINARY_NOTICE : diff.beforeContent, undefined, uri('before'))
    const modified = monaco.editor.createModel(binary ? BINARY_NOTICE : diff.afterContent, undefined, uri('after'))
    this.#clearZones()
    this.#models = { original, modified }
    this.#editor?.setModel({ original, modified })
    previous?.original.dispose()
    previous?.modified.dispose()
    this.#renderHunkZones(request)
  }

  /** Close the tab (the owner decided the diff is stale). */
  hide(): void {
    const wasOpen = this.#open
    this.#open = false
    if (wasOpen && this.#host.hasTab(DIFF_TAB_ID)) this.#host.closeFile(DIFF_TAB_ID)
    this.#release()
  }

  #release(): void {
    this.#clearZones()
    this.#editor?.setModel(null)
    this.#models?.original.dispose()
    this.#models?.modified.dispose()
    this.#models = null
    this.#request = null
  }

  #ensureRoot(): HTMLElement {
    if (this.#root) return this.#root
    const root = document.createElement('div')
    root.className = 'gd-diff-tab'

    const header = document.createElement('div')
    header.className = 'gd-header'
    const title = document.createElement('span')
    title.className = 'gd-title'
    const subtitle = document.createElement('span')
    subtitle.className = 'gd-subtitle'
    header.append(title, subtitle)
    this.#titleEl = title
    this.#subtitleEl = subtitle

    const tool = (icon: string, label: string, onClick: () => void, extra = ''): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `gd-tool${extra ? ` ${extra}` : ''}`
      btn.title = label
      btn.setAttribute('aria-label', label)
      const glyph = document.createElement('fl-icon')
      glyph.setAttribute('name', icon)
      glyph.setAttribute('size', '14')
      btn.appendChild(glyph)
      btn.addEventListener('click', onClick)
      header.appendChild(btn)
      return btn
    }
    tool('arrow-up', 'Previous change', () => this.#editor?.goToDiff('previous'), 'gd-prev')
    tool('arrow-down', 'Next change', () => this.#editor?.goToDiff('next'), 'gd-next')
    this.#openBtn = tool(
      'go-to-file',
      'Open File',
      () => {
        const target = this.#request?.openTarget
        if (target === undefined) return
        document.dispatchEvent(new CustomEvent('flow:open-file', { detail: target }))
      },
      'gd-open',
    )
    this.#wrapBtn = tool('word-wrap', 'Toggle word wrap', () => {
      this.#wordWrap = !this.#wordWrap
      writePref(WRAP_PREF_KEY, this.#wordWrap)
      this.#applyPrefs()
    }, 'gd-wrap')
    this.#sideBtn = tool('split-horizontal', 'Toggle inline / side-by-side view', () => {
      this.#sideBySide = !this.#sideBySide
      writePref(SIDE_PREF_KEY, this.#sideBySide)
      this.#applyPrefs()
    }, 'gd-side')
    this.#wrapBtn.classList.toggle('gd-tool-active', this.#wordWrap)
    this.#sideBtn.classList.toggle('gd-tool-active', this.#sideBySide)

    const note = document.createElement('div')
    note.className = 'gd-note'
    note.hidden = true
    this.#noteEl = note

    const body = document.createElement('div')
    body.className = 'gd-body'
    this.#body = body

    root.append(header, note, body)
    this.#root = root
    return root
  }

  #ensureEditor(monaco: MonacoNamespace): void {
    if (this.#editor || !this.#body) return
    this.#editor = monaco.editor.createDiffEditor(this.#body, {
      theme: diffEditorThemeName(document.documentElement.dataset['theme']),
      readOnly: true,
      renderSideBySide: this.#sideBySide,
      wordWrap: this.#wordWrap ? 'on' : 'off',
      automaticLayout: true,
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      fontLigatures: true,
      lineHeight: 1.5,
      minimap: { enabled: false },
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
      renderOverviewRuler: false,
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      padding: { top: 8, bottom: 8 },
      hideUnchangedRegions: { enabled: true },
      // See diff-view.ts: word highlighting's cancelled delayer surfaces as an
      // unhandled "Canceled" page error when models swap.
      occurrencesHighlight: 'off',
    })
    // A layout change (inline <-> side by side) re-creates the inner editors'
    // geometry; the zones belong to the modified editor and are re-laid.
    this.#editor.onDidUpdateDiff(() => {
      if (this.#request !== null && this.#zoneIds.length === 0) this.#renderHunkZones(this.#request)
    })
  }

  #applyPrefs(): void {
    this.#editor?.updateOptions({
      renderSideBySide: this.#sideBySide,
      wordWrap: this.#wordWrap ? 'on' : 'off',
    })
    this.#wrapBtn?.classList.toggle('gd-tool-active', this.#wordWrap)
    this.#sideBtn?.classList.toggle('gd-tool-active', this.#sideBySide)
    if (this.#request !== null) {
      this.#clearZones()
      this.#renderHunkZones(this.#request)
    }
  }

  #clearZones(): void {
    const editor = this.#zoneEditor
    if (editor !== null && this.#zoneIds.length > 0) {
      const ids = this.#zoneIds
      editor.changeViewZones((accessor) => {
        for (const id of ids) accessor.removeZone(id)
      })
    }
    for (const node of this.#zoneNodes) node.remove()
    this.#zoneNodes = []
    this.#zoneIds = []
    this.#zoneEditor = null
  }

  #renderHunkZones(request: DiffTabRequest): void {
    // ALWAYS from a clean slate: setModel can fire onDidUpdateDiff
    // synchronously, which renders once before show() renders again — two
    // sets of zones with only the second one's ids kept.
    this.#clearZones()
    const actions = hunkActions(request.target)
    const hunks = request.diff.hunks ?? []
    if (actions.length === 0 || hunks.length === 0 || !this.#editor) return
    const editor = this.#editor.getModifiedEditor()
    const ids: string[] = []
    editor.changeViewZones((accessor) => {
      for (const hunk of hunks) {
        const dom = document.createElement('div')
        dom.className = 'gd-hunk-acts'
        this.#zoneNodes.push(dom)
        for (const action of actions) {
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = `gd-hunk-btn gd-hunk-${action}`
          btn.dataset['hunk'] = String(hunk.index)
          const glyph = document.createElement('fl-icon')
          glyph.setAttribute('name', action === 'stage' ? 'plus' : action === 'unstage' ? 'minus' : 'discard')
          glyph.setAttribute('size', '12')
          const text = document.createElement('span')
          text.textContent = HUNK_ACTION_LABELS[action]
          btn.append(glyph, text)
          btn.disabled = this.#busy
          // Monaco swallows mousedown inside the editor; act on mousedown so a
          // press is never eaten by its selection handling.
          btn.addEventListener('mousedown', (event) => {
            event.preventDefault()
            event.stopPropagation()
            void this.#runHunk(request.target, hunk, action)
          })
          dom.appendChild(btn)
        }
        ids.push(
          accessor.addZone({
            afterLineNumber: hunkAnchorLine(hunk).afterLine,
            heightInPx: 26,
            domNode: dom,
            suppressMouseDown: false,
          }),
        )
      }
    })
    this.#zoneIds = ids
    this.#zoneEditor = editor
  }

  async #runHunk(target: DiffTarget, hunk: GitDiffHunk, action: HunkAction): Promise<void> {
    if (this.#busy) return
    this.#busy = true
    this.#root?.querySelectorAll<HTMLButtonElement>('.gd-hunk-btn').forEach((btn) => {
      btn.disabled = true
    })
    try {
      await this.#callbacks.onHunk(target, hunk, action)
    } finally {
      this.#busy = false
      this.#root?.querySelectorAll<HTMLButtonElement>('.gd-hunk-btn').forEach((btn) => {
        btn.disabled = false
      })
    }
  }
}

let stylesInjected = false

function injectDiffTabStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .gd-diff-tab { display: flex; flex-direction: column; background: var(--fl-color-surface); }
    .gd-diff-tab .gd-header {
      display: flex; align-items: center; gap: 2px; flex: none; height: 26px;
      padding: 0 8px 0 14px; border-bottom: var(--fl-border-width) solid var(--fl-color-separator);
      background: var(--fl-color-surface); color: var(--fl-color-text-secondary);
      font-size: 12px; user-select: none;
    }
    .gd-diff-tab .gd-title { color: var(--fl-color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .gd-diff-tab .gd-subtitle { flex: 1; min-width: 0; padding-left: 8px; color: var(--fl-color-text-tertiary, var(--fl-color-text-secondary)); opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gd-diff-tab .gd-tool {
      display: inline-grid; place-items: center; flex: none; width: 22px; height: 22px; padding: 0;
      border: none; border-radius: var(--fl-radius-sm); background: transparent;
      color: var(--fl-color-text-secondary); cursor: pointer;
    }
    .gd-diff-tab .gd-tool:hover { background: var(--fl-color-surface-raised); color: var(--fl-color-text); }
    .gd-diff-tab .gd-tool-active { color: var(--fl-color-text); background: var(--fl-color-surface-raised); }
    .gd-diff-tab .gd-open[hidden] { display: none; }
    .gd-diff-tab .gd-note {
      padding: 4px 14px; border-bottom: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-surface-raised); color: var(--fl-color-text-secondary); font-size: 12px;
    }
    .gd-diff-tab .gd-note[hidden] { display: none; }
    .gd-diff-tab .gd-body { flex: 1; min-height: 0; }
    .gd-hunk-acts { display: flex; gap: 6px; align-items: center; height: 26px; padding-left: 4px; font-family: var(--fl-font-ui); font-size: 11.5px; }
    .gd-hunk-btn {
      display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px;
      font: inherit; color: var(--fl-color-text); background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: 3px; cursor: pointer;
    }
    .gd-hunk-btn:hover { border-color: var(--fl-color-text-secondary); }
    .gd-hunk-btn:disabled { opacity: .5; cursor: default; }
  `
  document.head.appendChild(style)
}
