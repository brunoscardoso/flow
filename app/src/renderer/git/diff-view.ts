/**
 * Diff view — read-only Monaco diff editor presented as an overlay over the
 * editor panel (surfaces.editor), with its own header bar and close button.
 *
 * Why an overlay and not an editor tab: the editor tab strip and Monaco host
 * are Phase 6/7 territory (renderer/editor/**, off-limits to the git phase),
 * so the diff surface lives entirely in this file and simply covers the
 * editor area while open. Esc or the ✕ button closes it and reveals the
 * editor exactly as it was.
 *
 * Monaco arrives only through the injected loader (EditorApi.monaco()), so
 * the dynamic-import-only rule holds — nothing here imports monaco-editor
 * statically (types only). Inline diff (renderSideBySide: false) suits the
 * narrow editor pane; models use a private `flow-git:` URI scheme so they can
 * never collide with the editor's Uri.file(absolutePath) models, while still
 * carrying the file extension for language colorization.
 */
import type * as Monaco from 'monaco-editor'

import '../components'
import type { GitDiff } from '../../shared/ipc-contract'
import { diffEditorThemeName } from '../editor/monaco-themes'
import { diffNote } from './diff-note'

type MonacoNamespace = typeof Monaco

/** Shown in both panes for a binary file instead of decoded bytes (#98). */
const BINARY_NOTICE = 'Binary file — content not shown.'

export interface DiffViewRequest {
  /** Header title — file path or commit subject. */
  title: string
  /** Header subtitle — e.g. "Working tree vs HEAD" or "1a2b3c4 vs parent". */
  subtitle: string
  diff: GitDiff
  /**
   * Path used for language inference (extension → colorization). Omit for
   * whole-commit concatenated diffs, which render as plaintext.
   */
  languagePath?: string
  /**
   * The real project file this diff shows, when there is one — enables the
   * header's "Open in editor" escape hatch (`flow:open-file`). Omitted for
   * whole-commit / synthetic diffs, which have no single file to open, and
   * the button hides with it.
   */
  openTarget?: { rootPath: string; relPath: string }
}

const FONT_FAMILY =
  "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
const FONT_SIZE = 13

const WRAP_PREF_KEY = 'flow.diffview.wordWrap'
const SIDE_PREF_KEY = 'flow.diffview.sideBySide'

/** A persisted diff reading pref ('1' = on); absent/error = off. */
function readDiffPref(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeDiffPref(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    /* private-mode etc. — the toggle still works for the session */
  }
}

export class DiffView {
  #host: HTMLElement
  #loadMonaco: () => Promise<MonacoNamespace>
  #overlay: HTMLElement | null = null
  #titleEl: HTMLElement | null = null
  #openBtn: HTMLButtonElement | null = null
  #wrapBtn: HTMLButtonElement | null = null
  #sideBtn: HTMLButtonElement | null = null
  /** The project file behind the current diff (null = nothing to open). */
  #openTarget: { rootPath: string; relPath: string } | null = null
  #subtitleEl: HTMLElement | null = null
  /** One-line banner for changes the panes can't show (#1185). */
  #noteEl: HTMLElement | null = null
  #diffContainer: HTMLElement | null = null
  #diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null
  #models: { original: Monaco.editor.ITextModel; modified: Monaco.editor.ITextModel } | null =
    null
  #modelCounter = 0
  /** 'none' = panes only; the host owns header/close (peek drawer). */
  #chrome: 'full' | 'none' = 'full'
  /** Reading prefs — persisted; applied at editor creation and on toggle. */
  #wordWrap = readDiffPref(WRAP_PREF_KEY)
  #sideBySide = readDiffPref(SIDE_PREF_KEY)
  #onKeydown: (event: KeyboardEvent) => void

  /**
   * @param host The editor panel element the overlay covers (surfaces.editor).
   * @param loadMonaco Lazy Monaco loader — pass EditorApi.monaco.
   * @param options.chrome 'none' renders panes only — for hosts that own
   *   their own header/close (the blueprint peek drawer), declared here
   *   instead of the host reaching into this component's classes from
   *   outside (which silently gained/lost whatever the header grows).
   */
  constructor(
    host: HTMLElement,
    loadMonaco: () => Promise<MonacoNamespace>,
    options?: { chrome?: 'full' | 'none' },
  ) {
    this.#host = host
    this.#loadMonaco = loadMonaco
    this.#chrome = options?.chrome ?? 'full'
    // The overlay anchors to the panel itself (header included) so it reads
    // as a temporary surface over the whole editor area.
    if (!this.#host.style.position) {
      this.#host.style.position = 'relative'
    }
    this.#onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && this.isOpen) {
        event.preventDefault()
        this.hide()
      }
    }
    injectDiffViewStyles()
  }

  get isOpen(): boolean {
    return this.#overlay !== null && this.#overlay.style.display !== 'none'
  }

  /** Open (or refresh) the overlay with a before/after pair. */
  async show(request: DiffViewRequest): Promise<void> {
    const monaco = await this.#loadMonaco()
    this.#ensureOverlay()
    this.#ensureDiffEditor(monaco)

    if (this.#titleEl) {
      this.#titleEl.textContent = request.title
      this.#titleEl.title = request.title
    }
    if (this.#subtitleEl) this.#subtitleEl.textContent = request.subtitle
    this.#openTarget = request.openTarget ?? null
    if (this.#openBtn) this.#openBtn.hidden = this.#openTarget === null
    // #1185: say what the two panes cannot. A chmod-only change (or a brand-new
    // empty file) renders byte-identical sides, which reads exactly like a diff
    // that failed to load — the panel says the file changed and the diff says it
    // didn't. The note appears above the panes and is cleared for ordinary diffs.
    this.#renderNote(diffNote(request.diff))

    // Fresh models per view; the previous pair is disposed to free memory.
    const previous = this.#models
    this.#modelCounter += 1
    // Binary files carry no text — show a notice instead of decoded mojibake
    // (#98). A plain '.txt' suffix avoids any syntax tokenization of the notice.
    const binary = request.diff.binary === true
    const suffix = binary ? '/binary.txt' : request.languagePath ? `/${request.languagePath}` : '/commit.txt'
    const beforeText = binary ? BINARY_NOTICE : request.diff.beforeContent
    const afterText = binary ? BINARY_NOTICE : request.diff.afterContent
    const original = monaco.editor.createModel(
      beforeText,
      undefined,
      monaco.Uri.from({
        scheme: 'flow-git',
        authority: 'before',
        path: `/${this.#modelCounter}${suffix}`,
      }),
    )
    const modified = monaco.editor.createModel(
      afterText,
      undefined,
      monaco.Uri.from({
        scheme: 'flow-git',
        authority: 'after',
        path: `/${this.#modelCounter}${suffix}`,
      }),
    )
    this.#models = { original, modified }
    this.#diffEditor?.setModel({ original, modified })
    previous?.original.dispose()
    previous?.modified.dispose()

    if (this.#overlay) this.#overlay.style.display = 'flex'
    this.#diffEditor?.focus()
  }

  /** Close the overlay and release the current models. */
  hide(): void {
    if (this.#overlay) this.#overlay.style.display = 'none'
    this.#diffEditor?.setModel(null)
    this.#models?.original.dispose()
    this.#models?.modified.dispose()
    this.#models = null
  }

  dispose(): void {
    this.hide()
    window.removeEventListener('keydown', this.#onKeydown)
    this.#diffEditor?.dispose()
    this.#diffEditor = null
    this.#overlay?.remove()
    this.#overlay = null
    this.#titleEl = null
    this.#subtitleEl = null
    this.#noteEl = null
    this.#diffContainer = null
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /** Show or clear the note banner (#1185). */
  #renderNote(text: string | null): void {
    if (!this.#noteEl) return
    this.#noteEl.textContent = text ?? ''
    this.#noteEl.hidden = text === null
  }

  #ensureOverlay(): void {
    if (this.#overlay) return

    const overlay = document.createElement('div')
    overlay.className = 'gd-overlay'
    if (this.#chrome === 'none') overlay.classList.add('gd-chromeless')
    overlay.style.display = 'none'

    const header = document.createElement('div')
    header.className = 'gd-header'

    const icon = document.createElement('fl-icon')
    icon.setAttribute('name', 'git-branch')
    icon.setAttribute('size', '13')
    header.appendChild(icon)

    const title = document.createElement('span')
    title.className = 'gd-title'
    header.appendChild(title)
    this.#titleEl = title

    const subtitle = document.createElement('span')
    subtitle.className = 'gd-subtitle'
    header.appendChild(subtitle)
    this.#subtitleEl = subtitle

    // Reading controls (#g9): the panes were fixed inline/no-wrap with no way
    // to walk changes. Prev/next drive Monaco's own goToDiff; Wrap and Split
    // are persisted prefs applied live via updateOptions.
    const tool = (
      label: string,
      title: string,
      onClick: (btn: HTMLButtonElement) => void,
    ): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'gd-tool'
      btn.textContent = label
      btn.title = title
      btn.setAttribute('aria-label', title)
      btn.addEventListener('click', () => onClick(btn))
      header.appendChild(btn)
      return btn
    }
    tool('‹', 'Previous change', () => this.#diffEditor?.goToDiff('previous'))
    tool('›', 'Next change', () => this.#diffEditor?.goToDiff('next'))
    const wrapBtn = tool('Wrap', 'Toggle word wrap', () => {
      this.#wordWrap = !this.#wordWrap
      writeDiffPref(WRAP_PREF_KEY, this.#wordWrap)
      this.#applyReadingPrefs()
    })
    wrapBtn.classList.toggle('gd-tool-active', this.#wordWrap)
    this.#wrapBtn = wrapBtn
    const sideBtn = tool('Split', 'Toggle side-by-side view', () => {
      this.#sideBySide = !this.#sideBySide
      writeDiffPref(SIDE_PREF_KEY, this.#sideBySide)
      this.#applyReadingPrefs()
    })
    sideBtn.classList.toggle('gd-tool-active', this.#sideBySide)
    this.#sideBtn = sideBtn

    // The overlay must not dead-end: a reader deciding "this needs editing"
    // was one ✕ plus a tree hunt away from the file they were looking at.
    const open = document.createElement('button')
    open.className = 'gd-close gd-open'
    open.type = 'button'
    open.title = 'Open in editor'
    open.setAttribute('aria-label', 'Open file in editor')
    open.textContent = '↗'
    open.hidden = true
    open.addEventListener('click', () => {
      const target = this.#openTarget
      if (target === null) return
      document.dispatchEvent(
        new CustomEvent('flow:open-file', {
          detail: { rootPath: target.rootPath, relPath: target.relPath },
        }),
      )
      this.hide()
    })
    header.appendChild(open)
    this.#openBtn = open

    const close = document.createElement('button')
    close.className = 'gd-close'
    close.type = 'button'
    close.title = 'Close diff (Esc)'
    close.setAttribute('aria-label', 'Close diff')
    const closeIcon = document.createElement('fl-icon')
    closeIcon.setAttribute('name', 'close')
    closeIcon.setAttribute('size', '12')
    close.appendChild(closeIcon)
    close.addEventListener('click', () => this.hide())
    header.appendChild(close)

    const diffContainer = document.createElement('div')
    diffContainer.className = 'gd-body'
    this.#diffContainer = diffContainer

    // #1185: a one-line banner between the header and the panes, for changes the
    // panes can't show (a file-mode change; an empty new file).
    const note = document.createElement('div')
    note.className = 'gd-note'
    note.hidden = true
    this.#noteEl = note

    overlay.appendChild(header)
    overlay.appendChild(note)
    overlay.appendChild(diffContainer)
    this.#host.appendChild(overlay)
    this.#overlay = overlay

    window.addEventListener('keydown', this.#onKeydown)
  }

  #ensureDiffEditor(monaco: MonacoNamespace): void {
    if (this.#diffEditor || !this.#diffContainer) return
    this.#diffEditor = monaco.editor.createDiffEditor(this.#diffContainer, {
      // Monaco's theme is a global singleton — a dangling name flipped every editor
      // to the light `vs` fallback (#453). Use the app's current editor theme; the
      // data-theme observer in monaco-host re-themes all editors together after.
      theme: diffEditorThemeName(document.documentElement.dataset['theme']),
      readOnly: true,
      // Inline by default — side-by-side is cramped at pane width, but it is
      // the reader's call now (the header's Split toggle, persisted).
      renderSideBySide: this.#sideBySide,
      wordWrap: this.#wordWrap ? 'on' : 'off',
      automaticLayout: true,
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      fontLigatures: true,
      lineHeight: 1.5,
      minimap: { enabled: false },
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        useShadows: false,
      },
      renderOverviewRuler: false,
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      padding: { top: 8, bottom: 8 },
      // Long unchanged stretches collapse — essential for whole-commit views.
      hideUnchangedRegions: { enabled: true },
      // No occurrence (word) highlighting in a read-only overlay: Monaco's
      // WordHighlighter cancels its pending delayer when the overlay hides or
      // models swap, and that cancellation surfaces as an UNHANDLED
      // "Canceled: Canceled" page error (Delayer.cancel → WordHighlighter.
      // dispose). The highlight adds nothing to a diff you can't edit.
      occurrencesHighlight: 'off',
    })
  }

  /** Push the current reading prefs into the live editor + button states. */
  #applyReadingPrefs(): void {
    this.#diffEditor?.updateOptions({
      renderSideBySide: this.#sideBySide,
      wordWrap: this.#wordWrap ? 'on' : 'off',
    })
    this.#wrapBtn?.classList.toggle('gd-tool-active', this.#wordWrap)
    this.#sideBtn?.classList.toggle('gd-tool-active', this.#sideBySide)
  }
}

// ── Styles (light DOM, injected once) ─────────────────────────────────────

let stylesInjected = false

function injectDiffViewStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .gd-overlay {
      position: absolute;
      inset: 0;
      z-index: 20;
      display: flex;
      flex-direction: column;
      background: var(--fl-color-surface);
      border: var(--fl-border-width) solid var(--fl-color-border);
    }
    .gd-header {
      display: flex;
      align-items: center;
      gap: var(--fl-space-xs);
      flex: none;
      height: var(--fl-tab-height);
      padding: 0 var(--fl-space-sm);
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-bg);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      user-select: none;
    }
    .gd-title {
      color: var(--fl-color-text);
      font-size: var(--fl-text-ui-size);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .gd-note {
      padding: var(--fl-space-xs) var(--fl-space-md);
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    .gd-note[hidden] { display: none; }
    .gd-subtitle {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .gd-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      cursor: pointer;
    }
    .gd-close:hover {
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
    }
    /* Explicit, because the class's display outranks the UA [hidden] rule. */
    .gd-open[hidden] { display: none; }
    /* chrome: 'none' — the host owns header/close; panes only. */
    .gd-overlay.gd-chromeless .gd-header { display: none; }
    .gd-tool {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      height: 20px;
      min-width: 20px;
      padding: 0 5px;
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      cursor: pointer;
    }
    .gd-tool:hover {
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
    }
    .gd-tool-active { color: var(--fl-color-accent, #3794ff); }
    .gd-body { flex: 1; min-height: 0; }
  `
  document.head.appendChild(style)
}
