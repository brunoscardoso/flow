/**
 * Inline diff review — renders pending agent-edit hunks inside the Monaco
 * editor as accept/reject blocks (Phase 8, built on ADR-001 interception).
 *
 * Per hunk on the active file:
 *   - added lines: whole-line green decoration + green gutter stripe
 *   - deleted lines: red block rendered in a view-zone-backed widget above
 *     the hunk (the zone is a spacer; the visible content lives in an
 *     overlay widget positioned via onDomNodeTop, so buttons stay clickable)
 *   - a compact toolbar (−n +m · accept ✓ / reject ✗) on every hunk
 *
 * The controller re-renders on editor:pendingChangesUpdated (fed by the
 * coordinator through setChanges) and on model switches. Because agent edits
 * land on disk immediately, the active model is re-synced from disk when its
 * file has pending changes — review state assumes disk truth (v1: agent and
 * user editing the same buffer concurrently is out of scope).
 *
 * Monaco access goes through editorApi.monaco()/editor() ONLY — nothing from
 * 'monaco-editor' is imported statically (dynamic-import-only constraint).
 */
import type * as Monaco from 'monaco-editor'

import '../components'
import type { PendingFileChange, PendingHunk } from '../../shared/ipc-contract'
import type { EditorApi } from './index'

export type HunkResolveHandler = (
  change: PendingFileChange,
  hunk: PendingHunk,
  action: 'accept' | 'reject',
) => void

const TOOLBAR_HEIGHT_PX = 24
const ADDED_LINE_CLASS = 'fl-diff-added-line'
const ADDED_GUTTER_CLASS = 'fl-diff-added-gutter'

export class InlineDiffController {
  #editorApi: EditorApi
  #onResolve: HunkResolveHandler
  #monaco: typeof Monaco | null = null
  #editor: Monaco.editor.IStandaloneCodeEditor | null = null
  /** Absolute path → pending entries. One file can carry entries from
   *  MULTIPLE threads (LOG-4) — each renders its own hunks so a resolve
   *  always targets the owning thread's hunk. */
  #changes = new Map<string, PendingFileChange[]>()
  #subscriptions: Monaco.IDisposable[] = []
  #decorations: Monaco.editor.IEditorDecorationsCollection | null = null
  #zoneIds: string[] = []
  #overlays: Monaco.editor.IOverlayWidget[] = []
  #disposed = false
  #syncedPaths = new Set<string>()

  constructor(editorApi: EditorApi, onResolve: HunkResolveHandler) {
    this.#editorApi = editorApi
    this.#onResolve = onResolve
    injectStyles()
  }

  /**
   * Lazily bind to the (dynamic-import-only) Monaco instance. Called once by
   * the coordinator; safe to race with setChanges.
   */
  async init(): Promise<void> {
    const [monaco, editor] = await Promise.all([
      this.#editorApi.monaco(),
      this.#editorApi.editor(),
    ])
    if (this.#disposed) return
    this.#monaco = monaco
    this.#editor = editor
    this.#subscriptions.push(
      editor.onDidChangeModel(() => {
        void this.#syncActiveModelFromDisk().then(() => this.#render())
      }),
      editor.onDidLayoutChange(() => this.#render()),
    )
    this.#render()
  }

  /** Replace the pending-change set (editor:pendingChangesUpdated payload). */
  setChanges(changes: PendingFileChange[]): void {
    this.#changes.clear()
    this.#syncedPaths.clear()
    for (const change of changes) {
      const key = joinPath(change.rootId, change.filePath)
      const existing = this.#changes.get(key)
      if (existing) {
        existing.push(change)
      } else {
        this.#changes.set(key, [change])
      }
    }
    void this.#syncActiveModelFromDisk().then(() => this.#render())
  }

  dispose(): void {
    this.#disposed = true
    this.#clearRendered()
    for (const subscription of this.#subscriptions) {
      subscription.dispose()
    }
    this.#subscriptions = []
    this.#changes.clear()
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  #render(): void {
    const monaco = this.#monaco
    const editor = this.#editor
    if (!monaco || !editor || this.#disposed) return

    this.#clearRendered()

    const model = editor.getModel()
    if (!model) return
    const changes = this.#changesForModel(model)
    if (changes.length === 0) return

    const decorations: Monaco.editor.IModelDeltaDecoration[] = []
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight)
    const layout = editor.getLayoutInfo()

    editor.changeViewZones((accessor) => {
      for (const change of changes) {
        for (const hunk of change.hunks) {
          const addedLineCount = hunk.range.end.line - hunk.range.start.line
          if (addedLineCount > 0) {
            const firstLine = clampLine(model, hunk.range.start.line + 1)
            const lastLine = clampLine(model, hunk.range.end.line)
            decorations.push({
              range: new monaco.Range(firstLine, 1, lastLine, 1),
              options: {
                isWholeLine: true,
                className: ADDED_LINE_CLASS,
                linesDecorationsClassName: ADDED_GUTTER_CLASS,
              },
            })
          }

          const deletedLines = hunk.beforeText.length > 0 ? hunk.beforeText.split('\n') : []
          const heightInPx = TOOLBAR_HEIGHT_PX + deletedLines.length * lineHeight

          // `change` is captured per entry, so the resolve handler always
          // carries the OWNING thread's change (LOG-4).
          const overlayNode = buildHunkWidget({
            hunk,
            deletedLines,
            lineHeight,
            contentLeft: layout.contentLeft,
            onAction: (action) => this.#onResolve(change, hunk, action),
          })

          const overlay: Monaco.editor.IOverlayWidget = {
            // threadId keeps widget ids unique when two threads carry
            // pending hunks on the same file.
            getId: () => `fl-inline-diff-${change.threadId}-${change.filePath}-${hunk.hunkId}`,
            getDomNode: () => overlayNode,
            getPosition: () => null,
          }

          const spacer = document.createElement('div')
          this.#zoneIds.push(
            accessor.addZone({
              afterLineNumber: clampLine(model, hunk.range.start.line, 0),
              heightInPx,
              domNode: spacer,
              onDomNodeTop: (top) => {
                overlayNode.style.top = `${top}px`
              },
            }),
          )
          editor.addOverlayWidget(overlay)
          this.#overlays.push(overlay)
        }
      }
    })

    this.#decorations = editor.createDecorationsCollection(decorations)
  }

  #clearRendered(): void {
    const editor = this.#editor
    if (!editor) return
    this.#decorations?.clear()
    this.#decorations = null
    if (this.#zoneIds.length > 0) {
      const zoneIds = this.#zoneIds
      this.#zoneIds = []
      editor.changeViewZones((accessor) => {
        for (const zoneId of zoneIds) {
          accessor.removeZone(zoneId)
        }
      })
    }
    for (const overlay of this.#overlays) {
      editor.removeOverlayWidget(overlay)
    }
    this.#overlays = []
  }

  /** Every pending entry for the model's file — possibly one per thread. */
  #changesForModel(model: Monaco.editor.ITextModel): PendingFileChange[] {
    const modelPath = model.uri.path
    for (const [absPath, changes] of this.#changes) {
      if (pathsEqual(modelPath, absPath)) return changes
    }
    return []
  }

  /**
   * Agent edits (and hunk rejections) land on disk while the file may be
   * open — refresh the buffer so the rendered hunks match reality. Uses a
   * single full-range edit (undo-stack friendly) and syncs each file once
   * per change-set.
   */
  async #syncActiveModelFromDisk(): Promise<void> {
    const editor = this.#editor
    const model = editor?.getModel()
    if (!editor || !model) return
    // Disk is shared across threads — one read covers every entry.
    const change = this.#changesForModel(model)[0]
    if (!change) return
    const absPath = joinPath(change.rootId, change.filePath)
    if (this.#syncedPaths.has(absPath)) return
    this.#syncedPaths.add(absPath)

    try {
      const file = await window.flow.project.readFile({
        rootPath: change.rootId,
        relPath: change.filePath,
      })
      if (this.#disposed || file.binary) return
      const current = editor.getModel()
      if (!current || !pathsEqual(current.uri.path, absPath)) return
      if (current.getValue() !== file.content) {
        current.pushEditOperations(
          [],
          [{ range: current.getFullModelRange(), text: file.content }],
          () => null,
        )
      }
    } catch (error) {
      console.error('flow: failed to sync model from disk for diff review', {
        absPath,
        error,
      })
    }
  }
}

// ── Widget DOM ─────────────────────────────────────────────────────────────

function buildHunkWidget(params: {
  hunk: PendingHunk
  deletedLines: string[]
  lineHeight: number
  contentLeft: number
  onAction: (action: 'accept' | 'reject') => void
}): HTMLElement {
  const node = document.createElement('div')
  node.className = 'fl-inline-diff-widget'
  node.style.left = `${params.contentLeft}px`
  node.style.height = `${TOOLBAR_HEIGHT_PX + params.deletedLines.length * params.lineHeight}px`

  const toolbar = document.createElement('div')
  toolbar.className = 'fl-inline-diff-toolbar'

  const summary = document.createElement('span')
  summary.className = 'fl-inline-diff-summary'
  const removed = params.deletedLines.length
  const added = params.hunk.range.end.line - params.hunk.range.start.line
  summary.textContent = `−${removed} +${added}`
  toolbar.appendChild(summary)

  toolbar.appendChild(
    widgetButton('check', 'Accept', 'fl-inline-diff-accept', () => params.onAction('accept')),
  )
  toolbar.appendChild(
    widgetButton('close', 'Reject', 'fl-inline-diff-reject', () => params.onAction('reject')),
  )
  node.appendChild(toolbar)

  if (params.deletedLines.length > 0) {
    const deleted = document.createElement('div')
    deleted.className = 'fl-inline-diff-deleted'
    deleted.style.lineHeight = `${params.lineHeight}px`
    for (const line of params.deletedLines) {
      const lineEl = document.createElement('div')
      lineEl.className = 'fl-inline-diff-deleted-line'
      lineEl.style.height = `${params.lineHeight}px`
      lineEl.textContent = line.length > 0 ? line : ' '
      deleted.appendChild(lineEl)
    }
    node.appendChild(deleted)
  }

  return node
}

function widgetButton(
  icon: string,
  label: string,
  className: string,
  onClick: () => void,
): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `fl-inline-diff-button ${className}`
  button.title = label
  const iconEl = document.createElement('fl-icon')
  iconEl.setAttribute('name', icon)
  iconEl.setAttribute('size', '11')
  const text = document.createElement('span')
  text.textContent = label
  button.appendChild(iconEl)
  button.appendChild(text)
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return button
}

// ── Helpers ────────────────────────────────────────────────────────────────

function joinPath(rootPath: string, relPath: string): string {
  const base = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath
  return `${base}/${relPath}`
}

function pathsEqual(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '/')
}

function clampLine(model: Monaco.editor.ITextModel, line: number, min = 1): number {
  return Math.min(Math.max(line, min), model.getLineCount())
}

// ── Styles (Stark) ─────────────────────────────────────────────────────────

let stylesInjected = false

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .${ADDED_LINE_CLASS} { background: rgba(152, 193, 121, 0.12); }
    .${ADDED_GUTTER_CLASS} {
      background: var(--fl-color-success);
      width: 3px !important;
      margin-left: 3px;
    }
    .fl-inline-diff-widget {
      position: absolute;
      right: 14px;
      z-index: 10;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      pointer-events: auto;
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
    }
    .fl-inline-diff-toolbar {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--fl-space-xs);
      height: ${TOOLBAR_HEIGHT_PX}px;
      padding: 0 var(--fl-space-xs);
    }
    .fl-inline-diff-summary {
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-mono);
      font-size: 11px;
      margin-right: var(--fl-space-xs);
      user-select: none;
    }
    .fl-inline-diff-button {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      height: 18px;
      padding: 0 var(--fl-space-xs);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: 11px;
      line-height: 1;
      cursor: pointer;
    }
    .fl-inline-diff-button:hover { border-color: var(--fl-color-text-secondary); }
    .fl-inline-diff-accept { color: var(--fl-color-success); }
    .fl-inline-diff-accept:hover { border-color: var(--fl-color-success); }
    .fl-inline-diff-reject { color: var(--fl-color-error); }
    .fl-inline-diff-reject:hover { border-color: var(--fl-color-error); }
    .fl-inline-diff-deleted {
      flex: 1;
      background: rgba(224, 108, 117, 0.12);
      border-left: 3px solid var(--fl-color-error);
      overflow: hidden;
    }
    .fl-inline-diff-deleted-line {
      padding-left: var(--fl-space-sm);
      color: var(--fl-color-text-secondary);
      white-space: pre;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `
  document.head.appendChild(style)
}
