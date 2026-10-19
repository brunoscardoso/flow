/**
 * Inline per-hunk conflict resolver (conflict-UX Phase 4).
 *
 * `openConflictInMergeEditor(rootId, filePath, proposal?)` opens a conflicted
 * file as an editor-area tab and resolves it ONE HUNK AT A TIME. Standalone
 * Monaco 0.55 has no 3-way merge widget, so — instead of the former whole-file
 * three-pane view + "Use ours / Use theirs" toolbar — this renders the marker
 * working copy in a single read-only editor and floats a small control bar above
 * every conflict hunk (Monaco view-zone + overlay widget, the inline-diff
 * pattern). Each bar carries the two sides' {@link buildIdentityChip} chips and
 * three controls:
 *
 *   [ Keep <side A> ]  [ Keep <side B> ]  [ Keep both ▾ ]
 *
 * Side A is the ours stage, side B the theirs stage — labelled truthfully from
 * the file's {@link SideIdentity} (falling back to the marker label / merge-state
 * branch), NEVER the words ours / theirs / current / incoming. Clicking a control
 * resolves ONLY that hunk via `git:resolveConflictHunk` (through the shared
 * `resolveHunkAndRecord`, which also records the choice for undo), then the editor
 * re-reads + re-parses so sibling hunks and the remaining count stay live. The
 * ours/theirs regions carry the two-side accent as gutter + line decorations so
 * the editor and the chips share one scheme.
 *
 * "Keep both" defaults to side-A-first immediately; its ▾ menu offers side-B-first
 * (the reorder) — both apply `choice: 'both'`, only the concatenation order
 * differs, which is the last moment to reorder before the splice removes markers.
 *
 * Fail-safe: a read failure or oversize file surfaces a message/toast and never
 * crashes; a resolve failure surfaces a toast and leaves the file untouched.
 * Monaco is reached ONLY through `EditorApi.monaco()` (dynamic-import-only).
 */
import type * as Monaco from 'monaco-editor'

import type {
  FlowNotificationLevel,
  GitConflictedFile,
  GitMergeState,
} from '../../shared/ipc-contract'
import type { ConflictHunkChoice, ConflictHunkOrder } from '../../shared/conflict-hunks'
import type { SideIdentity } from '../../shared/side-identity'
import type { ConflictProposal } from './conflict-proposal'
import type { EditorApi } from './index'
import { parseConflicts, type ConflictBlock } from './conflict-parser'
import { buildIdentityChip, sideDisplayLabel, type IdentityChipOptions } from './identity-chip'
import { hunkControlSpecs, keepBothOrderOptions } from './conflict-hunk-controls'
import { resolveHunkAndRecord } from './conflict-hunk-actions'
import {
  CONFLICT_SIDE_DECORATION_CSS,
  sideDecorationRanges,
} from './conflict-decorations'

/** Tab-id scheme for a resolver view — one stable tab per (root, file). */
const VIEW_ID_PREFIX = 'conflict://'
/** fl-icon shown on the resolver tab. */
const VIEW_ICON = 'git-branch'
/**
 * The resolver's identity in a conversation's tab set. A resolver is opened
 * from one conversation's work — usually its own checkout — so it belongs to
 * that conversation's set like every other view: it leaves with the
 * conversation and comes back with it, instead of staying on screen in every
 * other thread.
 */
const VIEW_KIND = 'conflict-resolver'
/** Monaco model URI scheme — kept distinct from `file:` so it never collides
 *  with the real open-file models the editor host owns. */
const MODEL_SCHEME = 'conflict-resolve'

const FONT_FAMILY =
  "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
const FONT_SIZE = 13

/** Height reserved for one hunk's control bar (chips row + actions row). */
const CONTROL_BAR_HEIGHT = 58

const CONTROL_BAR_CLASS = 'fl-conflict-hunk-bar'
const CONTROL_CHIPS_CLASS = 'fl-conflict-hunk-chips'
const CONTROL_ACTIONS_CLASS = 'fl-conflict-hunk-actions'
const CONTROL_BUTTON_CLASS = 'fl-conflict-hunk-button'
const BOTH_WRAP_CLASS = 'fl-conflict-both'
const BOTH_MENU_CLASS = 'fl-conflict-both-menu'

/** The single EditorApi, registered once by the coordinator. */
let editorApiRef: EditorApi | null = null

/** Disposable Monaco glue for one open resolver view. The OUTER element is stable
 *  across reopens (EditorApi.openView caches by id), so only this INNER content is
 *  rebuilt/disposed. */
interface InnerSession {
  dispose(): void
}

/** Stable outer view elements by tab id (mirrors openView's cache lifetime). */
const outerElements = new Map<string, HTMLElement>()
/** The current inner session per tab id — disposed + rebuilt each open. */
const innerSessions = new Map<string, InnerSession>()

/** Register the EditorApi so `openConflictInMergeEditor` can open editor tabs. */
export function registerConflictMergeEditor(api: EditorApi): void {
  editorApiRef = api
  // A set coming back with a resolver in it: reopen it, unless the file has
  // been resolved since (then there is nothing to come back to).
  api.registerViewRestorer(VIEW_KIND, async (state) => {
    const { rootId, filePath } = state
    if (typeof rootId !== 'string' || rootId === '' || typeof filePath !== 'string' || filePath === '') {
      return null
    }
    await openConflictInMergeEditor(rootId, filePath, undefined, { restoring: true })
    const id = viewIdFor(rootId, filePath)
    return api.hasTab(id) ? id : null
  })
}

/** How a resolver tab is captured into its conversation's tab set. */
function persistFor(rootId: string, filePath: string): { kind: string; state: () => { rootId: string; filePath: string } } {
  return { kind: VIEW_KIND, state: () => ({ rootId, filePath }) }
}

/**
 * Open (or focus) the inline per-hunk resolver for one conflicted file. Reads the
 * marker copy + side identities, floats a control bar over each hunk, and wires
 * every control to a single-hunk resolve. Never throws.
 */
export async function openConflictInMergeEditor(
  rootId: string,
  filePath: string,
  proposal?: ConflictProposal,
  /** `restoring`: a tab-set restore — quiet on failure, and skipped once the
   *  file carries no conflict any more. */
  options: { restoring?: boolean } = {},
): Promise<void> {
  const api = editorApiRef
  if (!api) {
    console.error('flow: conflict resolver opened before registration', { rootId, filePath })
    notify('error', 'Resolver unavailable', 'The editor is not ready yet. Try again in a moment.')
    return
  }

  let result
  try {
    result = await window.flow.git.readConflicted({ rootId, filePath })
  } catch (error) {
    if (options.restoring === true) {
      console.warn('flow: a saved conflict resolver could not be reopened', { rootId, filePath, error })
      return
    }
    console.error('flow: failed to read conflicted file', { rootId, filePath, error })
    notify('error', 'Could not open resolver', `Failed to read ${baseName(filePath)}.`)
    return
  }
  if (options.restoring === true && !('oversize' in result) && parseConflicts(result.markered).length === 0) {
    return // resolved since the set was saved
  }

  const monaco = await api.monaco()
  const viewId = viewIdFor(rootId, filePath)
  const outer = ensureOuter(viewId)

  // Tear down the previous inner content and rebuild fresh so reopening reflects
  // the latest sides + remaining hunks.
  innerSessions.get(viewId)?.dispose()
  innerSessions.delete(viewId)
  outer.replaceChildren()

  if ('oversize' in result) {
    buildMessageInner(
      outer,
      `${baseName(filePath)} is too large to resolve here. Resolve it from the command line, then reload.`,
    )
    api.openView({
      id: viewId,
      label: baseName(filePath),
      icon: VIEW_ICON,
      element: outer,
      persist: persistFor(rootId, filePath),
    })
    return
  }

  // Merge state supplies a best-effort side-B branch fallback when identity is
  // absent; failure is non-fatal (the marker label still labels the side).
  const mergeState = await window.flow.git
    .mergeState({ rootId })
    .catch((error: unknown) => {
      console.warn('flow: failed to read merge state for resolver', { rootId, error })
      return null
    })

  const inner = buildResolverInner(monaco, outer, {
    api,
    viewId,
    rootId,
    filePath,
    conflicted: result,
    mergeState,
    proposal,
  })
  innerSessions.set(viewId, inner)
  api.openView({
    id: viewId,
    label: baseName(filePath),
    icon: VIEW_ICON,
    element: outer,
    persist: persistFor(rootId, filePath),
  })
}

// ── View construction ────────────────────────────────────────────────────────

interface ResolverOptions {
  api: EditorApi
  viewId: string
  rootId: string
  filePath: string
  conflicted: GitConflictedFile
  mergeState: GitMergeState | null
  proposal?: ConflictProposal
}

/** File-level side identities, refreshed on every re-read. */
interface SideIdentities {
  ours?: SideIdentity
  theirs?: SideIdentity
}

/** Build the header + editor + per-hunk control bars into `outer`. */
function buildResolverInner(
  monaco: typeof Monaco,
  outer: HTMLElement,
  options: ResolverOptions,
): InnerSession {
  const { rootId, filePath, proposal } = options
  injectResolverStyles()
  const disposables: Array<{ dispose(): void }> = []
  const menuCleanups: Array<() => void> = []

  if (proposal && (proposal.why || proposal.how)) {
    outer.appendChild(buildRationaleHeader(proposal))
  }

  const strip = document.createElement('div')
  strip.className = 'fl-conflict-strip'
  outer.appendChild(strip)

  const host = document.createElement('div')
  host.style.cssText = 'flex:1;min-height:0;position:relative;'
  outer.appendChild(host)

  const model = freshModel(monaco, MODEL_SCHEME, filePath, options.conflicted.markered)
  const editor = monaco.editor.create(host, {
    model,
    readOnly: true,
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    fontLigatures: true,
    lineHeight: 1.5,
    minimap: { enabled: false },
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
    stickyScroll: { enabled: false },
    renderLineHighlight: 'none',
    scrollBeyondLastLine: false,
    padding: { top: 8, bottom: 8 },
    automaticLayout: true,
    fixedOverflowWidgets: true,
    tabSize: 2,
  })
  disposables.push(editor, model)

  let zoneIds: string[] = []
  let overlays: Monaco.editor.IOverlayWidget[] = []
  let decorations: Monaco.editor.IEditorDecorationsCollection | null = null
  let identities: SideIdentities = {
    ours: options.conflicted.oursIdentity,
    theirs: options.conflicted.theirsIdentity,
  }
  const mergeState = options.mergeState
  let busy = false

  /** Resolve one side's chip options (identity + a marker/branch fallback). */
  function sideOptions(block: ConflictBlock, side: 'a' | 'b'): {
    identity?: SideIdentity
    options: IdentityChipOptions
  } {
    if (side === 'a') {
      return { identity: identities.ours, options: { side: 'a', fallbackLabel: block.oursLabel } }
    }
    const fallbackLabel = block.theirsLabel ?? mergeState?.incomingBranch
    return { identity: identities.theirs, options: { side: 'b', fallbackLabel } }
  }

  function clearRendered(): void {
    decorations?.clear()
    decorations = null
    for (const cleanup of menuCleanups.splice(0)) cleanup()
    if (zoneIds.length > 0) {
      const ids = zoneIds
      zoneIds = []
      editor.changeViewZones((accessor) => {
        for (const id of ids) accessor.removeZone(id)
      })
    }
    for (const overlay of overlays) editor.removeOverlayWidget(overlay)
    overlays = []
  }

  function render(conflicted: GitConflictedFile): void {
    clearRendered()
    if (model.getValue() !== conflicted.markered) model.setValue(conflicted.markered)

    const blocks = parseConflicts(conflicted.markered)
    strip.textContent =
      blocks.length === 0
        ? 'All conflicts resolved.'
        : `${blocks.length} ${blocks.length === 1 ? 'conflict' : 'conflicts'} — resolve each below.`
    if (blocks.length === 0) return

    const decos: Monaco.editor.IModelDeltaDecoration[] = []
    editor.changeViewZones((accessor) => {
      for (const block of blocks) {
        pushSideDecorations(monaco, decos, block)

        const aOpt = sideOptions(block, 'a')
        const bOpt = sideOptions(block, 'b')
        const barNode = buildHunkControlBar({
          sideA: buildIdentityChip(aOpt.identity, aOpt.options),
          sideB: buildIdentityChip(bOpt.identity, bOpt.options),
          sideALabel: sideDisplayLabel(aOpt.identity, aOpt.options),
          sideBLabel: sideDisplayLabel(bOpt.identity, bOpt.options),
          onResolve: (choice, order) => void resolve(block, choice, order),
          registerMenuCleanup: (cleanup) => menuCleanups.push(cleanup),
        })

        const overlay: Monaco.editor.IOverlayWidget = {
          getId: () => `fl-conflict-bar-${filePath}-${block.hunkId}`,
          getDomNode: () => barNode,
          getPosition: () => null,
        }

        const spacer = document.createElement('div')
        zoneIds.push(
          accessor.addZone({
            afterLineNumber: Math.max(0, block.startLine - 1),
            heightInPx: CONTROL_BAR_HEIGHT,
            domNode: spacer,
            onDomNodeTop: (top) => {
              barNode.style.top = `${top}px`
            },
          }),
        )
        editor.addOverlayWidget(overlay)
        overlays.push(overlay)
      }
    })
    decorations = editor.createDecorationsCollection(decos)
  }

  /** Re-read the file after a resolve so remaining hunks stay live. Null on
   *  failure/oversize (the caller keeps the current view). */
  async function reread(): Promise<GitConflictedFile | null> {
    try {
      const fresh = await window.flow.git.readConflicted({ rootId, filePath })
      if ('oversize' in fresh) return null
      identities = { ours: fresh.oursIdentity, theirs: fresh.theirsIdentity }
      return fresh
    } catch (error) {
      console.warn('flow: failed to re-read conflicted file', { rootId, filePath, error })
      return null
    }
  }

  /** Resolve exactly one hunk, then re-read + re-render. Fail-safe on error. */
  async function resolve(
    block: ConflictBlock,
    choice: ConflictHunkChoice,
    order?: ConflictHunkOrder,
  ): Promise<void> {
    if (busy) return
    busy = true
    try {
      const outcome = await resolveHunkAndRecord({
        rootId,
        filePath,
        hunkId: block.hunkId,
        choice,
        order,
        oursIdentity: identities.ours,
        theirsIdentity: identities.theirs,
      })
      if (!outcome.matched) {
        notify('warn', 'Nothing to resolve', 'That conflict was already resolved. Refreshing.')
      } else if (outcome.remainingConflicts === 0) {
        notify('info', 'Conflict resolved', `Resolved the last conflict in ${baseName(filePath)}.`)
      }
      const fresh = await reread()
      if (fresh) render(fresh)
    } catch (error) {
      console.error('flow: failed to resolve conflict hunk', {
        rootId,
        filePath,
        hunkId: block.hunkId,
        choice,
        error,
      })
      notify('error', 'Resolve failed', `Could not resolve that conflict. Nothing was changed.`)
    } finally {
      busy = false
    }
  }

  render(options.conflicted)

  return {
    dispose: () => {
      clearRendered()
      for (const disposable of disposables) {
        try {
          disposable.dispose()
        } catch (error) {
          console.warn('flow: conflict resolver dispose failed', { viewId: options.viewId, error })
        }
      }
    },
  }
}

/** Whole-line + gutter decorations tinting the ours region (side A) and the
 *  theirs region (side B) with the two-side accent, using the shared range recipe
 *  (conflict-decorations). Base regions stay neutral. */
function pushSideDecorations(
  monaco: typeof Monaco,
  decos: Monaco.editor.IModelDeltaDecoration[],
  block: ConflictBlock,
): void {
  for (const range of sideDecorationRanges(block)) {
    decos.push({
      range: new monaco.Range(range.startLine, 1, range.endLine, 1),
      options: {
        isWholeLine: true,
        className: range.lineClassName,
        linesDecorationsClassName: range.gutterClassName,
      },
    })
  }
}

// ── Control bar DOM ──────────────────────────────────────────────────────────

interface HunkControlBarParams {
  sideA: HTMLElement
  sideB: HTMLElement
  sideALabel: string
  sideBLabel: string
  onResolve: (choice: ConflictHunkChoice, order?: ConflictHunkOrder) => void
  registerMenuCleanup: (cleanup: () => void) => void
}

/** One hunk's floating control bar: the two side chips + the three controls. */
function buildHunkControlBar(params: HunkControlBarParams): HTMLElement {
  const bar = document.createElement('div')
  bar.className = CONTROL_BAR_CLASS

  const chips = document.createElement('div')
  chips.className = CONTROL_CHIPS_CLASS
  chips.append(params.sideA, params.sideB)

  const actions = document.createElement('div')
  actions.className = CONTROL_ACTIONS_CLASS
  for (const spec of hunkControlSpecs()) {
    if (spec.key === 'keep-both') {
      actions.appendChild(
        buildKeepBothControl(params.sideALabel, params.sideBLabel, params.onResolve, params.registerMenuCleanup),
      )
    } else {
      actions.appendChild(
        controlButton(spec.label, () => params.onResolve(spec.choice, spec.order)),
      )
    }
  }

  bar.append(chips, actions)
  return bar
}

/** The "Keep both ▾" split control: main applies side-A-first immediately; the
 *  caret opens a menu to pick the concatenation order (the reorder affordance). */
function buildKeepBothControl(
  sideALabel: string,
  sideBLabel: string,
  onResolve: (choice: ConflictHunkChoice, order?: ConflictHunkOrder) => void,
  registerMenuCleanup: (cleanup: () => void) => void,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = BOTH_WRAP_CLASS

  const main = controlButton('Accept Both', () => onResolve('both', 'ours-first'))
  const caret = controlButton('▾', () => toggleMenu())
  caret.classList.add('fl-conflict-both-caret')

  const menu = document.createElement('div')
  menu.className = BOTH_MENU_CLASS
  menu.hidden = true
  for (const option of keepBothOrderOptions(sideALabel, sideBLabel)) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'fl-conflict-both-item'
    item.textContent = option.label
    item.addEventListener('click', (event) => {
      event.stopPropagation()
      closeMenu()
      onResolve('both', option.order)
    })
    menu.appendChild(item)
  }

  const onDocClick = (event: MouseEvent): void => {
    if (!wrap.contains(event.target as Node)) closeMenu()
  }
  function openMenu(): void {
    menu.hidden = false
    document.addEventListener('click', onDocClick, true)
  }
  function closeMenu(): void {
    if (menu.hidden) return
    menu.hidden = true
    document.removeEventListener('click', onDocClick, true)
  }
  function toggleMenu(): void {
    if (menu.hidden) openMenu()
    else closeMenu()
  }
  // Ensure the listener is torn down when the bar is re-rendered/disposed.
  registerMenuCleanup(closeMenu)

  wrap.append(main, caret, menu)
  return wrap
}

/** A compact control-bar button; clicks never bubble to the editor. */
function controlButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = CONTROL_BUTTON_CLASS
  button.textContent = label
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return button
}

/** The AI proposal's why/how rationale, rendered above the editor. */
function buildRationaleHeader(proposal: ConflictProposal): HTMLElement {
  const header = document.createElement('div')
  header.style.cssText = [
    'flex:none',
    'display:flex',
    'flex-direction:column',
    'gap:var(--fl-space-xs)',
    'padding:var(--fl-space-sm) var(--fl-space-md)',
    'background:var(--fl-color-surface-raised)',
    'border-bottom:1px solid var(--fl-color-border)',
    'font-family:var(--fl-font-ui)',
    'font-size:var(--fl-text-caption-size)',
    'color:var(--fl-color-text-secondary)',
  ].join(';')
  if (proposal.why) header.appendChild(rationaleLine('Why', proposal.why))
  if (proposal.how) header.appendChild(rationaleLine('How', proposal.how))
  return header
}

function rationaleLine(label: string, text: string): HTMLElement {
  const line = document.createElement('div')
  const strong = document.createElement('strong')
  strong.textContent = `${label}: `
  strong.style.color = 'var(--fl-color-text)'
  line.appendChild(strong)
  line.appendChild(document.createTextNode(text))
  return line
}

/** Render a plain informational message (oversize / unsupported) into `outer`. */
function buildMessageInner(outer: HTMLElement, message: string): void {
  const box = document.createElement('div')
  box.textContent = message
  box.style.cssText = [
    'flex:1',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:var(--fl-space-xl)',
    'text-align:center',
    'font-family:var(--fl-font-ui)',
    'font-size:var(--fl-text-ui-size)',
    'color:var(--fl-color-text-secondary)',
  ].join(';')
  outer.appendChild(box)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Get (or lazily create) the stable outer element for a view id. */
function ensureOuter(viewId: string): HTMLElement {
  let outer = outerElements.get(viewId)
  if (!outer) {
    outer = document.createElement('div')
    outer.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;'
    outerElements.set(viewId, outer)
  }
  return outer
}

/** Dispose any existing model at the target URI, then create a fresh one so
 *  reopening the same file never trips Monaco's "model already exists" error. */
function freshModel(
  monaco: typeof Monaco,
  scheme: string,
  filePath: string,
  value: string,
): Monaco.editor.ITextModel {
  const uri = monaco.Uri.from({ scheme, path: `/${filePath}` })
  monaco.editor.getModel(uri)?.dispose()
  return monaco.editor.createModel(value, undefined, uri)
}

/** A stable tab id per (root, file) — unique across multi-project windows. */
function viewIdFor(rootId: string, filePath: string): string {
  return `${VIEW_ID_PREFIX}${rootId}::${filePath}`
}

function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf('/')
  return slash === -1 ? filePath : filePath.slice(slash + 1)
}

function notify(level: FlowNotificationLevel, title: string, body: string): void {
  document.dispatchEvent(
    new CustomEvent('flow:notify', {
      detail: {
        kind: 'state-change',
        rootId: '',
        title,
        body,
        timestamp: new Date().toISOString(),
        level,
      },
    }),
  )
}

let resolverStylesInjected = false

/** Inject the control-bar + decoration styles once. All colors resolve to theme
 *  tokens so the two-side accent matches the identity chips. */
function injectResolverStyles(): void {
  if (resolverStylesInjected) return
  resolverStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-conflict-strip {
      flex: none;
      padding: var(--fl-space-xs) var(--fl-space-md);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
      background: var(--fl-color-surface);
      border-bottom: 1px solid var(--fl-color-border);
    }
    .${CONTROL_BAR_CLASS} {
      position: absolute;
      left: 0;
      right: 14px;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--fl-space-md);
      height: ${CONTROL_BAR_HEIGHT}px;
      padding: 0 var(--fl-space-md);
      pointer-events: auto;
      background: var(--fl-color-surface-raised);
      border-top: 1px solid var(--fl-color-border);
      border-bottom: 1px solid var(--fl-color-border);
    }
    .${CONTROL_CHIPS_CLASS} {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      min-width: 0;
      overflow: hidden;
    }
    .${CONTROL_ACTIONS_CLASS} {
      display: flex;
      align-items: center;
      gap: var(--fl-space-xs);
      flex: none;
    }
    .${CONTROL_BUTTON_CLASS} {
      display: inline-flex;
      align-items: center;
      height: 24px;
      padding: 0 var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      font-weight: var(--fl-text-ui-weight-medium);
      line-height: 1;
      cursor: pointer;
      white-space: nowrap;
    }
    .${CONTROL_BUTTON_CLASS}:hover { border-color: var(--fl-color-text-secondary); }
    .${BOTH_WRAP_CLASS} { position: relative; display: inline-flex; }
    .${BOTH_WRAP_CLASS} .fl-conflict-both-caret {
      padding: 0 var(--fl-space-xs);
      margin-left: -1px;
    }
    .${BOTH_MENU_CLASS} {
      position: absolute;
      top: calc(100% + 2px);
      right: 0;
      z-index: 20;
      display: flex;
      flex-direction: column;
      min-width: 140px;
      padding: var(--fl-space-xs);
      background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
    }
    .fl-conflict-both-item {
      display: flex;
      align-items: center;
      height: 24px;
      padding: 0 var(--fl-space-sm);
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      text-align: left;
      cursor: pointer;
    }
    .fl-conflict-both-item:hover { background: var(--fl-color-surface); }
${CONFLICT_SIDE_DECORATION_CSS}
  `
  document.head.appendChild(style)
}
