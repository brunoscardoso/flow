/**
 * PeekViewer — the Phase-4 consumer of the board's peek seam (#568).
 *
 * The board (blueprint-board.ts) owns the peek DRAWER shell — a slim header
 * (mono path title + close ✕) over an empty `.fb-peek-body` — and fires two
 * callback seams after showing/swapping/closing it:
 *
 *   onPeekOpen(relPath, body) — mount / swap the file view into `body`
 *   onPeekClose()             — tear the file view down
 *
 * This class fills that body with a SINGLE read-only Monaco editor, reused
 * across file swaps within one open session: each swap installs a fresh model
 * (the previous one disposed) so the language re-infers from the new path, and
 * the whole editor is disposed on close. It fails soft at every step — a styled
 * notice pane for no-root / read failure / binary / too-large (decidePeekRender),
 * and a plain <pre> only when Monaco itself fails to load. It also augments the
 * drawer header with an "Open in editor" button next to ✕ that PROMOTES the
 * peeked file into the full editor and closes the drawer.
 *
 * Review Mode (#609): a CHANGED file (git tracks a non-untracked change for it)
 * DEFAULTS to a working-tree diff (HEAD vs worktree) rendered through the reused
 * git DiffView — one lazily-created instance overlaid on the peek body, disposed
 * on teardown. A header "Diff"/"File" toggle (shown only for changed files) flips
 * between the diff and the full-file editor. The diff path is fail-soft: a
 * git.diff error/null or Monaco load failure falls back to the full-file viewer.
 *
 * All render selection + string work lives in the DOM-free peek-render module;
 * this file is the DOM + Monaco shell around those decisions.
 */
import type * as Monaco from 'monaco-editor'

import type { GitDiff, GitFileState } from '../../shared/ipc-contract'
import { monacoNamespace } from '../editor/monaco-host'
import { DiffView } from '../git/diff-view'
import { PEEK_CLOSED, peekReduce, type PeekState } from './peek-model'
import {
  decidePeekDiffRender,
  decidePeekRender,
  escapeHtml,
  peekModelUri,
  type PeekReadResult,
} from './peek-render'

/** The slice of BlueprintBoard the viewer drives — the Phase-3 peek seam. */
export interface PeekBoard {
  onPeekOpen: ((relPath: string, body: HTMLElement, gitState?: GitFileState) => void) | null
  onPeekClose: (() => void) | null
  closePeek(): void
}

/** A file has a HEAD side to diff against when git tracks a change for it that
 *  isn't a brand-new untracked file (untracked has no HEAD → full view only). */
function isChangedForDiff(gitState: GitFileState | undefined): boolean {
  return gitState !== undefined && gitState !== 'untracked'
}

export interface PeekViewerOptions {
  /** Resolve the active root path for readFile. A getter (not a snapshot) so it
   *  tracks the host's live active-project binding, which changes over the
   *  board's lifetime as the user switches projects. */
  rootId: () => string | null
  /** Promote the peeked file into the full editor (Open-in-editor button). */
  openInEditor: (relPath: string) => void
}

const OPEN_BUTTON_CLASS = 'fb-peek-open-editor'

export class PeekViewer {
  #rootId: () => string | null
  #openInEditor: (relPath: string) => void

  #board: PeekBoard | null = null
  #editorHost: HTMLDivElement | null = null
  #messageEl: HTMLDivElement | null = null
  #editor: Monaco.editor.IStandaloneCodeEditor | null = null
  #model: Monaco.editor.ITextModel | null = null
  /** The single reused working-tree diff surface (Review Mode, #609) — lazily
   *  created over the peek body, reused across swaps, disposed on teardown. Its
   *  own instance state keeps it independent of the git-panel's DiffView. */
  #diffView: DiffView | null = null
  #currentRelPath: string | null = null
  /** The current file's git state, so a toggle/re-render knows if a diff exists. */
  #currentGitState: GitFileState | undefined = undefined
  /** Pure peek state (see peek-model) — tracks the full/diff mode the body shows. */
  #peek: PeekState = PEEK_CLOSED
  /** Monotonic guard: each open bumps it so an in-flight async render whose file
   *  was swapped/closed out from under it detects the staleness and bails. */
  #openToken = 0

  constructor(options: PeekViewerOptions) {
    this.#rootId = options.rootId
    this.#openInEditor = options.openInEditor
  }

  /** Wire this viewer into the board's peek seam. */
  attach(board: PeekBoard): void {
    this.#board = board
    board.onPeekOpen = (relPath, body, gitState): void =>
      this.#onOpen(board, relPath, body, gitState)
    board.onPeekClose = (): void => this.#teardown()
  }

  /** Detach the seam and fully dispose the editor/models (host teardown). */
  dispose(): void {
    if (this.#board) {
      this.#board.onPeekOpen = null
      this.#board.onPeekClose = null
    }
    this.#teardown()
    this.#board = null
  }

  // ── Open / swap ────────────────────────────────────────────────────────────

  #onOpen(
    board: PeekBoard,
    relPath: string,
    body: HTMLElement,
    gitState?: GitFileState,
  ): void {
    this.#currentRelPath = relPath
    this.#currentGitState = gitState
    // Fresh review from scratch: `open` resets mode → full + verdict → null.
    // A changed file (with a HEAD side) then defaults to the diff surface.
    this.#peek = peekReduce(PEEK_CLOSED, { type: 'open', path: relPath })
    if (isChangedForDiff(gitState)) {
      this.#peek = peekReduce(this.#peek, { type: 'set-mode', mode: 'diff' })
    }
    this.#ensureHeaderButton(board, body)
    this.#ensureToggleButton(body)
    this.#ensureVerdictButtons(body)
    // Body is a flex child; give it a containing block so the editor host and the
    // diff overlay can fill it absolutely (both need a definite-size container).
    body.style.position = 'relative'
    const token = ++this.#openToken
    void this.#render(relPath, body, token)
  }

  /** Route to the diff or full-file surface per the current mode. The diff path
   *  is fail-soft — a git.diff error/null (or Monaco load failure) falls back to
   *  the plain full-file viewer rather than a blank pane. */
  async #render(relPath: string, body: HTMLElement, token: number): Promise<void> {
    if (this.#peek.mode === 'diff' && isChangedForDiff(this.#currentGitState)) {
      const handled = await this.#renderDiff(relPath, body, token)
      if (handled || token !== this.#openToken) return
      // Fall through to the full-file viewer (git.diff failed/unavailable).
    }
    await this.#renderFull(relPath, body, token)
  }

  async #renderFull(relPath: string, body: HTMLElement, token: number): Promise<void> {
    const root = this.#rootId()
    const result = await this.#read(root, relPath)
    if (token !== this.#openToken) return // superseded by a newer open/close
    const decision = decidePeekRender(result, root !== null)
    if (decision.kind === 'notice') {
      this.#showNotice(body, decision.message)
      return
    }
    let monaco: typeof Monaco
    try {
      monaco = await monacoNamespace()
    } catch {
      if (token !== this.#openToken) return
      this.#showPreFallback(body, decision.content)
      return
    }
    if (token !== this.#openToken) return
    this.#showEditor(monaco, body, relPath, decision.content)
  }

  /**
   * Render the working-tree diff (HEAD vs worktree) for a changed file via the
   * reused DiffView. Returns `true` when it took ownership of the body (a diff or
   * a decidePeekDiffRender notice was shown, or a newer open superseded it), and
   * `false` only when the caller should fall back to the full-file viewer
   * (git.diff error/null or Monaco load failure). Every await is #openToken-guarded.
   */
  async #renderDiff(relPath: string, body: HTMLElement, token: number): Promise<boolean> {
    const root = this.#rootId()
    if (root === null) return false // no root → let the full path show its notice
    let diff: GitDiff | undefined
    try {
      diff = await window.flow.git?.diff({ rootId: root, filePath: relPath })
    } catch {
      return false // fail-soft → full-file viewer
    }
    if (token !== this.#openToken) return true // superseded — stop, don't fall through
    if (diff === undefined) return false
    const decision = decidePeekDiffRender(diff, true)
    if (decision.kind === 'notice') {
      this.#showNotice(body, decision.message)
      return true
    }
    let view: DiffView
    try {
      view = this.#ensureDiffView(body)
    } catch {
      return false // Monaco/DiffView unavailable → full-file viewer
    }
    // Hide the plain surfaces so only the diff overlay shows.
    if (this.#editorHost) this.#editorHost.style.display = 'none'
    if (this.#messageEl) this.#messageEl.style.display = 'none'
    await view.show({
      title: relPath,
      subtitle: 'Working tree vs HEAD',
      diff,
      languagePath: relPath,
    })
    // A newer open/close/toggle landed during show() — retract the overlay.
    if (token !== this.#openToken) view.hide()
    return true
  }

  async #read(root: string | null, relPath: string): Promise<PeekReadResult> {
    if (root === null) return { ok: false }
    try {
      const file = await window.flow.project.readFile({ rootPath: root, relPath })
      return { ok: true, file }
    } catch {
      return { ok: false }
    }
  }

  // ── Surfaces ─────────────────────────────────────────────────────────────

  #showEditor(
    monaco: typeof Monaco,
    body: HTMLElement,
    relPath: string,
    content: string,
  ): void {
    const host = this.#ensureEditorHost(body)
    this.#diffView?.hide()
    if (this.#messageEl) this.#messageEl.style.display = 'none'
    host.style.display = 'block'

    if (!this.#editor) {
      this.#editor = monaco.editor.create(host, {
        model: null,
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        wordWrap: 'off',
        lineNumbers: 'on',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        fontLigatures: true,
      })
    }
    // A dedicated, DETERMINISTIC `peek:` URI per file (extension preserved) avoids
    // colliding with the editor's `file:` models and lets Monaco infer language.
    // Because the URI is deterministic, re-peeking the SAME file finds the model
    // still alive — createModel at a used URI throws "model URI already in use"
    // (#597). REUSE the existing model via setValue in that case; only createModel
    // when none exists. (Mirrors the conflict-merge-editor guard.)
    const uri = monaco.Uri.parse(peekModelUri(relPath))
    const existing = monaco.editor.getModel(uri)
    const next = existing ?? monaco.editor.createModel(content, undefined, uri)
    if (existing) existing.setValue(content)
    this.#editor.setModel(next)
    // Dispose the OUTGOING model only when swapping to a different file — never the
    // reused same-URI model we just set (that would blank the drawer).
    if (this.#model && this.#model !== next) this.#model.dispose()
    this.#model = next
  }

  #showNotice(body: HTMLElement, message: string): void {
    this.#diffView?.hide()
    if (this.#editorHost) this.#editorHost.style.display = 'none'
    const el = this.#ensureMessageEl(body)
    el.style.cssText = MESSAGE_BASE_CSS + 'align-items:center;justify-content:center;text-align:center;'
    el.textContent = message
  }

  #showPreFallback(body: HTMLElement, content: string): void {
    this.#diffView?.hide()
    if (this.#editorHost) this.#editorHost.style.display = 'none'
    const el = this.#ensureMessageEl(body)
    el.style.cssText = MESSAGE_BASE_CSS + 'align-items:stretch;overflow:auto;'
    const pre = document.createElement('pre')
    pre.style.cssText = [
      'margin:0',
      'padding:8px 12px',
      'white-space:pre',
      'font-family:var(--fb-mono, var(--fl-font-mono, ui-monospace, monospace))',
      'font-size:12px',
      'line-height:1.5',
      'color:var(--fb-ink)',
    ].join(';')
    pre.innerHTML = escapeHtml(content)
    el.replaceChildren(pre)
  }

  // ── DOM scaffolding ────────────────────────────────────────────────────────

  #ensureEditorHost(body: HTMLElement): HTMLDivElement {
    if (!this.#editorHost) {
      this.#editorHost = document.createElement('div')
      this.#editorHost.className = 'fb-peek-editor'
      this.#editorHost.style.cssText = 'position:absolute;inset:0;'
      body.appendChild(this.#editorHost)
    }
    return this.#editorHost
  }

  /** Lazily create the single reused DiffView over the peek body. It renders as
   *  an absolute overlay filling its host, so the body (already position:relative)
   *  sizes it correctly. Shares the PeekViewer's Monaco loader; its instance state
   *  is independent of the git-panel's DiffView. */
  #ensureDiffView(body: HTMLElement): DiffView {
    if (!this.#diffView) {
      // chrome: 'none' — the drawer owns the header (path + close + review
      // actions); the DiffView contributes panes only.
      this.#diffView = new DiffView(body, () => monacoNamespace(), { chrome: 'none' })
    }
    return this.#diffView
  }

  #ensureMessageEl(body: HTMLElement): HTMLDivElement {
    if (!this.#messageEl) {
      this.#messageEl = document.createElement('div')
      this.#messageEl.className = 'fb-peek-message'
      body.appendChild(this.#messageEl)
    }
    this.#messageEl.style.display = 'flex'
    this.#messageEl.replaceChildren()
    return this.#messageEl
  }

  /** Insert the "Open in editor" button into the drawer header (once). The seam
   *  only hands us the body, so we reach the sibling header through the drawer;
   *  the button promotes the current file and closes the drawer. */
  #ensureHeaderButton(board: PeekBoard, body: HTMLElement): void {
    const header = body.parentElement?.querySelector('.fb-peek-header')
    if (!header || header.querySelector(`.${OPEN_BUTTON_CLASS}`)) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = OPEN_BUTTON_CLASS
    btn.title = 'Open in editor'
    btn.setAttribute('aria-label', 'Open in editor')
    btn.textContent = '↗'
    btn.style.cssText = OPEN_BUTTON_CSS
    btn.addEventListener('mouseenter', () => {
      btn.style.color = 'var(--fb-ink)'
      btn.style.background = 'var(--fb-ghost-bg)'
    })
    btn.addEventListener('mouseleave', () => {
      btn.style.color = 'var(--fb-ink-dim)'
      btn.style.background = 'transparent'
    })
    btn.addEventListener('click', () => {
      const relPath = this.#currentRelPath
      if (relPath === null) return
      this.#openInEditor(relPath)
      board.closePeek()
    })
    // Sit just before the ✕ so promote reads left-of-close.
    const close = header.querySelector('.fb-peek-close')
    header.insertBefore(btn, close)
  }

  /** Add (or update / remove) the diff↔full-file toggle in the drawer header.
   *  Shown ONLY for changed files (untracked/clean have no diff surface); a swap
   *  to a non-diffable file drops any toggle a prior changed file left behind. */
  #ensureToggleButton(body: HTMLElement): void {
    const header = body.parentElement?.querySelector('.fb-peek-header')
    if (!header) return
    let btn = header.querySelector<HTMLButtonElement>(`.${TOGGLE_BUTTON_CLASS}`)
    if (!isChangedForDiff(this.#currentGitState)) {
      btn?.remove()
      return
    }
    if (!btn) {
      btn = document.createElement('button')
      btn.type = 'button'
      btn.className = TOGGLE_BUTTON_CLASS
      btn.style.cssText = TOGGLE_BUTTON_CSS
      const button = btn
      button.addEventListener('mouseenter', () => {
        button.style.color = 'var(--fb-ink)'
        button.style.background = 'var(--fb-ghost-bg)'
      })
      button.addEventListener('mouseleave', () => {
        button.style.color = 'var(--fb-ink-dim)'
        button.style.background = 'transparent'
      })
      button.addEventListener('click', () => this.#onToggleMode(body))
      // Sit left of the ↗ open-in-editor button (or the ✕ when it is absent).
      const anchor =
        header.querySelector(`.${OPEN_BUTTON_CLASS}`) ?? header.querySelector('.fb-peek-close')
      header.insertBefore(button, anchor)
    }
    this.#updateToggleLabel(btn)
  }

  /** The toggle reads as the surface a click switches TO (mirror of the mode). */
  #updateToggleLabel(btn: HTMLButtonElement): void {
    const toFull = this.#peek.mode === 'diff'
    btn.textContent = toFull ? 'File' : 'Diff'
    const label = toFull ? 'Show full file' : 'Show diff'
    btn.title = label
    btn.setAttribute('aria-label', label)
  }

  /** Flip full ↔ diff and re-render the body in the new mode under a fresh token. */
  #onToggleMode(body: HTMLElement): void {
    this.#peek = peekReduce(this.#peek, { type: 'toggle-mode' })
    const btn = body.parentElement?.querySelector<HTMLButtonElement>(`.${TOGGLE_BUTTON_CLASS}`)
    if (btn) this.#updateToggleLabel(btn)
    if (this.#currentRelPath === null) return
    const token = ++this.#openToken
    void this.#render(this.#currentRelPath, body, token)
  }

  // ── Review Mode verdict (#609) ───────────────────────────────────────────

  /** Add (or refresh / remove) the Approve+Refuse verdict buttons in the drawer
   *  header. Shown ONLY for changed files (a clean/untracked file has nothing to
   *  review). A swap to a non-changed file drops any buttons a prior file left
   *  behind. Placed left of the diff/file toggle. */
  #ensureVerdictButtons(body: HTMLElement): void {
    const header = body.parentElement?.querySelector('.fb-peek-header')
    if (!header) return
    let approve = header.querySelector<HTMLButtonElement>(`.${APPROVE_BUTTON_CLASS}`)
    let refuse = header.querySelector<HTMLButtonElement>(`.${REFUSE_BUTTON_CLASS}`)
    if (!isChangedForDiff(this.#currentGitState)) {
      approve?.remove()
      refuse?.remove()
      return
    }
    if (!approve || !refuse) {
      approve?.remove()
      refuse?.remove()
      approve = this.#makeVerdictButton(body, 'approved')
      refuse = this.#makeVerdictButton(body, 'refused')
      // Sit left of the diff/file toggle (or the ↗/✕ when the toggle is absent).
      const anchor =
        header.querySelector(`.${TOGGLE_BUTTON_CLASS}`) ??
        header.querySelector(`.${OPEN_BUTTON_CLASS}`) ??
        header.querySelector('.fb-peek-close')
      header.insertBefore(approve, anchor)
      header.insertBefore(refuse, anchor)
    }
    this.#updateVerdictButtons(body)
  }

  #makeVerdictButton(body: HTMLElement, verdict: 'approved' | 'refused'): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = verdict === 'approved' ? APPROVE_BUTTON_CLASS : REFUSE_BUTTON_CLASS
    btn.addEventListener('click', () => void this.#onVerdict(body, verdict))
    return btn
  }

  /** Reflect the peek's current verdict on the two buttons — the decided one
   *  settles into an "Approved ✓" / "Refused ✓" active state. Idempotent. */
  #updateVerdictButtons(body: HTMLElement): void {
    const header = body.parentElement?.querySelector('.fb-peek-header')
    if (!header) return
    const approve = header.querySelector<HTMLButtonElement>(`.${APPROVE_BUTTON_CLASS}`)
    const refuse = header.querySelector<HTMLButtonElement>(`.${REFUSE_BUTTON_CLASS}`)
    const verdict = this.#peek.verdict
    if (approve) {
      const done = verdict === 'approved'
      approve.textContent = done ? 'Approved ✓' : 'Approve'
      approve.title = done ? 'Approved' : 'Approve these changes'
      approve.setAttribute('aria-label', approve.title)
      approve.classList.toggle('fb-verdict-active', done)
    }
    if (refuse) {
      const done = verdict === 'refused'
      refuse.textContent = done ? 'Refused ✓' : 'Refuse'
      refuse.title = done ? 'Refused' : 'Refuse these changes'
      refuse.setAttribute('aria-label', refuse.title)
      refuse.classList.toggle('fb-verdict-active', done)
    }
  }

  /**
   * Record + relay a verdict on the current changed file. Fail-soft everywhere:
   * a missing `recordVerdict` accessor, a null root, or an `ok: false` append
   * never blocks the local reflect + board decoration + composer relay.
   *   - Approve → record 'kept', dispatch flow:blueprint-review 'approved'
   *   - Refuse  → record 'dismissed', prefill the composer with a refusal stub
   *               (never auto-sent), dispatch flow:blueprint-review 'refused'
   */
  async #onVerdict(body: HTMLElement, verdict: 'approved' | 'refused'): Promise<void> {
    const filePath = this.#currentRelPath
    if (filePath === null) return
    const rootId = this.#rootId()
    const classification = verdict === 'approved' ? 'kept' : 'dismissed'
    try {
      const record = window.flow.flow.recordVerdict
      if (rootId !== null && typeof record === 'function') {
        const result = await record({ rootId, filePath, classification })
        if (!result.ok) console.warn(`flow: recordVerdict not appended for ${filePath}`)
      }
    } catch (error) {
      console.warn('flow: recordVerdict failed', error)
    }
    // Refuse → prefill the composer with a refusal stub (never auto-sends).
    if (verdict === 'refused') {
      document.dispatchEvent(
        new CustomEvent('flow:prefill-composer', {
          detail: { text: `Refusing changes to ${filePath}: ` },
        }),
      )
    }
    // Approval IS staging (#898/#857): write git staging directly — the board
    // and the review list both re-derive from `staged` on git:changed.
    try {
      if (rootId !== null) {
        if (verdict === 'approved') await window.flow.git.stage({ rootId, filePaths: [filePath] })
        else await window.flow.git.unstage({ rootId, filePaths: [filePath] })
      }
    } catch (error) {
      console.warn('flow: peek verdict staging failed', { filePath, verdict, error })
    }
    // Reflect in peek state so the header shows the settled affordance.
    this.#peek = peekReduce(this.#peek, { type: 'set-verdict', verdict })
    this.#updateVerdictButtons(body)
  }

  // ── Teardown ─────────────────────────────────────────────────────────────

  #teardown(): void {
    this.#openToken++ // invalidate any in-flight render
    this.#currentRelPath = null
    this.#currentGitState = undefined
    this.#peek = PEEK_CLOSED
    this.#model?.dispose()
    this.#model = null
    this.#editor?.dispose()
    this.#editor = null
    this.#editorHost?.remove()
    this.#editorHost = null
    this.#messageEl?.remove()
    this.#messageEl = null
    this.#diffView?.dispose()
    this.#diffView = null
  }
}

const MESSAGE_BASE_CSS = [
  'position:absolute',
  'inset:0',
  'display:flex',
  'flex-direction:column',
  'min-height:0',
  'padding:0',
  'color:var(--fb-ink-dim)',
  'font-size:12px',
  '',
].join(';')

const OPEN_BUTTON_CSS = [
  'flex:none',
  'display:inline-flex',
  'align-items:center',
  'justify-content:center',
  'width:20px',
  'height:20px',
  'padding:0',
  'border:none',
  'border-radius:3px',
  'background:transparent',
  'color:var(--fb-ink-dim)',
  'font-size:12px',
  'line-height:1',
  'cursor:pointer',
].join(';')

/** Review-Mode verdict buttons (#609) — styled green/red via BOARD_STYLES. */
const APPROVE_BUTTON_CLASS = 'fb-peek-approve'
const REFUSE_BUTTON_CLASS = 'fb-peek-refuse'

const TOGGLE_BUTTON_CLASS = 'fb-peek-toggle-mode'

const TOGGLE_BUTTON_CSS = [
  'flex:none',
  'display:inline-flex',
  'align-items:center',
  'justify-content:center',
  'height:20px',
  'padding:0 6px',
  'border:none',
  'border-radius:3px',
  'background:transparent',
  'color:var(--fb-ink-dim)',
  'font-size:11px',
  'line-height:1',
  'cursor:pointer',
].join(';')
