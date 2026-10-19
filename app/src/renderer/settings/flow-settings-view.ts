/**
 * Flow settings overlay — a project-scoped surface for editing the active
 * project's flow/.flowconfig. Opened by the ⚙ status-bar button
 * (`flow:open-flow-settings`); mirrors SettingsView's modal pattern and reuses
 * its styles.
 *
 * Live editing: every control change is written immediately via flow:setConfig
 * (no Save button); the main-side watcher rebroadcasts flow:stateChanged, which
 * also reconciles external `/flow` edits into the open panel. Dependency
 * guardrails (pr ⇒ push + commit) are enforced in the UI before any write.
 *
 * Notifications (webhook/telegram) are intentionally NOT here in v1.
 */
import { accentOverrideFor, setAccentOverride } from '../project-accent'
import { accentPickerModel } from '../threads/accent-picker'
import {
  closeOtherSettingsOverlays,
  registerSettingsOverlay,
} from './settings-overlay-stack'
import '../components'
import type {
  FlowState,
  ResolvedWorktreeSettingsResult,
  RegisteredProject,
  WorktreeSettingSource,
} from '../../shared/ipc-contract'
import { resolveAssignRevert } from './account-assign'
import { injectFieldRowStyles, injectSettingsStyles } from './settings-view'
import { markModalOverlay } from '../modal-overlay'
import { StoragePage } from './storage-page'
import { STORAGE_PAGE_TITLE } from './storage-page-model'
import { OverlayFocusReturn } from './overlay-focus-return'
import {
  FLOW_SETTINGS_SECTIONS,
  GIT_PR_SECTION_TITLE,
  RUNTIME_SECTION_TITLE,
  WORKTREE_SECTION_TITLE,
  applyDependencies,
  canReprovision,
  disabledKeys,
  fieldConfigString,
  isRefusal,
  learnBudgetText,
  ownedEditAction,
  ownedEditingSource,
  providerWriteValue,
  provisioningStatusText,
  readValues,
  takeOverAction,
  toConfigUpdates,
  validateWorktreeField,
  worktreeFieldStates,
  worktreesOffNote,
  type FieldDef,
  type FieldValidation,
  type FieldValue,
  type FlowSettingsValues,
  type InheritableState,
} from './flow-settings-model'
import {
  renderFieldRow,
  renderWarnings,
  type FieldDocument,
  type FieldNode,
  type FieldRow,
  type FieldRowState,
} from './settings-fields'
import {
  requirementsMet,
  runtimeName,
  runtimeRequirements,
  type RuntimeAuthAnswer,
} from './runtime-ready'

const OPEN_EVENT = 'flow:open-flow-settings'
const ONBOARDED_KEY = 'flow.onboarded'

/**
 * The app-wide settings, where the defaults an inherited row is reading live.
 *
 * A chip that says a value came from somewhere else is only half an answer
 * while the somewhere else takes a hunt through another menu to find. This is
 * the same event the titlebar and the palette dispatch, so the overlay family's
 * own rule applies and this panel closes as that one opens (#1395).
 */
const GLOBAL_SETTINGS_EVENT = 'flow:open-settings'

function openGlobalSettings(): void {
  document.dispatchEvent(new CustomEvent(GLOBAL_SETTINGS_EVENT))
}

/**
 * The seam between the real DOM and the field builders.
 *
 * `settings-fields` is typed against minimal structural interfaces so it (and
 * its tests) run under the app's node-env jest, which omits the DOM lib. These
 * two casts are the entire cost of that, and they live HERE — at the one place
 * a real document is handed in and a real element is taken back — rather than
 * being sprinkled through the builders.
 */
function fieldDocument(): FieldDocument {
  return document as unknown as FieldDocument
}

function asElement(node: FieldNode): HTMLElement {
  return node as unknown as HTMLElement
}

/** The runtimes a project can be PINNED to — everything the provider select
 *  offers except `inherit`, which clears the override rather than storing one. */
const CONCRETE_PROVIDERS = new Set(['claude', 'codex', 'copilot'])

/** True for a provider value that names a real runtime (not `inherit`). Only
 *  these gate on readiness before they are written (Phase 2). */
function isConcreteProvider(value: boolean | number | string): boolean {
  return typeof value === 'string' && CONCRETE_PROVIDERS.has(value)
}

/** What the inline Runtime-select readiness line is showing. */
type ProviderGateState =
  | { kind: 'clear' }
  | { kind: 'checking'; provider: string }
  | { kind: 'refused'; provider: string; answer: RuntimeAuthAnswer }

/** The field definition behind a config key, or undefined for an unknown one. */
function fieldByKey(key: string): FieldDef | undefined {
  for (const section of FLOW_SETTINGS_SECTIONS) {
    const found = section.fields.find((field) => field.key === key)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Wire the singleton Flow settings overlay. Opened per-project via the sidebar
 * project ⋯ menu (`flow:open-flow-settings` with `{ rootPath }`), and shown
 * automatically the FIRST time an unconfigured project is selected (onboarding).
 */
export function initFlowSettings(): void {
  const api = window.flow
  if (!api?.flow || !api?.project) {
    console.warn('flow: flow bridge missing — flow settings disabled')
    return
  }
  const view = new FlowSettingsView()

  // `section` (optional) opens the panel scrolled to one section by its id.
  document.addEventListener(OPEN_EVENT, (event) => {
    const detail = (event as CustomEvent<{ rootPath?: string; section?: string }>).detail
    void view.open(detail?.rootPath, typeof detail?.section === 'string' ? detail.section : undefined)
  })

  // Onboarding: the first time a project becomes active, show its flow config
  // once — but only when it has none yet (already-configured projects skip it).
  api.project.onActiveChanged((context) => {
    void maybeOnboard(context?.rootPath ?? null, view)
  })
  void api.project
    .active()
    .then((context) => maybeOnboard(context ? context.rootPath : null, view))
    .catch(() => undefined)
}

function readOnboarded(): Set<string> {
  try {
    const raw = localStorage.getItem(ONBOARDED_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * Mark a root as onboarded so `maybeOnboard` never auto-opens the flow-settings
 * panel for it — used by the first-run wizard (#48), whose settings step already
 * covers this, to avoid opening the panel twice.
 */
export function markRootOnboarded(rootPath: string): void {
  const seen = readOnboarded()
  if (seen.has(rootPath)) return
  seen.add(rootPath)
  try {
    localStorage.setItem(ONBOARDED_KEY, JSON.stringify([...seen]))
  } catch {
    /* convenience only — ignore storage failures */
  }
}

async function maybeOnboard(rootPath: string | null, view: FlowSettingsView): Promise<void> {
  if (!rootPath) return
  const seen = readOnboarded()
  if (seen.has(rootPath)) return
  seen.add(rootPath)
  try {
    localStorage.setItem(ONBOARDED_KEY, JSON.stringify([...seen]))
  } catch {
    /* onboarding is a convenience — ignore storage failures */
  }
  // Only surface it for a project that has not been configured yet.
  const state = await window.flow.flow.state({ rootId: rootPath }).catch(() => null)
  const configured = state !== null && Object.keys(state.flowconfig).length > 0
  if (configured) return
  void view.open(rootPath)
}

class FlowSettingsView {
  #overlay: HTMLDivElement
  #title: HTMLSpanElement
  #body: HTMLDivElement
  /** Inline "couldn't save" line (#1158) — present only after a failed write. */
  #writeError: HTMLElement | null = null
  #open = false
  #rootPath: string | null = null
  #values: FlowSettingsValues = {}
  /** Live row per config key — the patch target that lets a write update the
   *  panel WITHOUT replacing the DOM the user is interacting with (#1032). */
  #rows = new Map<string, FieldRow>()
  /**
   * Where each worktree value came from, keyed by config key.
   *
   * Empty until `flow:worktreeSettings` answers. A field with no entry renders
   * without a chip and without the inherit switch, which is the honest state
   * when the panel could not find out — better than a badge that guesses.
   */
  #sources: Record<string, WorktreeSettingSource> = {}
  /** The resolver's last answer per field, kept so a re-read of the project file
   *  does not momentarily show a built-in in place of an inherited value. */
  #worktreeStates: Record<string, InheritableState> = {}
  /**
   * Fields taken over on screen but not yet written — the blank case.
   *
   * Taking over a value normally writes the value already shown. There is
   * nothing to write when the value in effect is BLANK (no base branch, no
   * naming pattern): the resolver reads a blank as absent at every layer, so
   * the write would land, resolve to inherited, and snap the row straight back
   * — a press that did nothing, twice a second. A key in here is a row that is
   * editable as this project's own and is waiting for the first real value;
   * nothing is on disk until one arrives, and pressing the switch back simply
   * forgets it (no write, and no removal — forbidden-pattern #15 is untouched).
   */
  #owning = new Set<string>()
  /** Sentences from the resolver about values it could not use — shown verbatim. */
  #warnings: string[] = []
  /** What the last typed value was, per field, while the panel is open. */
  #validation = new Map<string, FieldValidation | null>()
  /** The node the warnings are painted into, inside the Conversation files section. */
  #warningsHost: HTMLElement | null = null
  /** The provisioning card — the only root-data-dependent node, swapped alone. */
  #provisioningSection: HTMLElement | null = null
  /** The caption under the Runtime select saying whether the provider is pinned
   *  to this project or inherited from the app default — populated async from
   *  settings:getProjectProvider, skipped when an older preload lacks it. */
  #providerCaption: HTMLElement | null = null
  /** The inline readiness refusal under the Runtime select — hidden until a
   *  concrete provider is picked that its runtime is not signed into/installed
   *  for (Phase 2). Empty on an older preload, which cannot verify and so does
   *  not gate. */
  #providerRequirements: HTMLElement | null = null
  #unsubscribe: (() => void) | null = null
  /** The active root's RegisteredProject (provisioning fields) — ide-auto-provisioning. */
  #root: RegisteredProject | undefined
  #unsubscribeRoots: (() => void) | null = null
  #reprovisioning = false
  /**
   * Which page the panel's body is showing.
   *
   * A PANEL WITH TWO PAGES, NOT A PANEL PLUS A DIALOG. The list of files a
   * project is holding used to open as a modal over whatever was underneath;
   * nothing about it is urgent, so it is a place you walk to and walk back
   * from. Everything that re-renders the body (a config write, an external
   * `/flow` edit, a roots change) reads this first, so a setting written on
   * disk while the list is open does not yank the reader back to the fields.
   */
  #page: 'settings' | 'storage' = 'settings'
  /**
   * The storage page, kept alive across the panel's re-renders.
   *
   * Rebuilding it would re-read the inventory — a directory walk and a git call
   * per row — every time an unrelated setting was written (allowed-pattern
   * #17). The instance is made once per visit and its element re-attached.
   */
  #storage: StoragePage | null = null

  constructor() {
    injectSettingsStyles()
    injectFlowSettingsStyles()

    this.#overlay = document.createElement('div')
    this.#overlay.className = 'fl-settings-overlay'
    registerSettingsOverlay('flow-settings', () => this.close()) // #1395
    // Modal chrome: declare it to the shared guard so global panel shortcuts,
    // the terminal's autofocus and the focus trap all treat it as owning the
    // keyboard (#1002).
    markModalOverlay(this.#overlay)
    this.#overlay.hidden = true
    this.#overlay.addEventListener('mousedown', (event) => {
      if (event.target === this.#overlay) this.close()
    })

    const panel = document.createElement('div')
    panel.className = 'fl-settings-panel'
    const header = document.createElement('div')
    header.className = 'fl-settings-header'
    this.#title = document.createElement('span')
    this.#title.textContent = 'Flow settings'
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'fl-settings-close'
    closeBtn.setAttribute('aria-label', 'Close flow settings')
    closeBtn.textContent = '✕'
    closeBtn.addEventListener('click', () => this.close())
    header.append(this.#title, closeBtn)

    this.#body = document.createElement('div')
    this.#body.className = 'fl-settings-body'

    panel.append(header, this.#body)
    this.#overlay.appendChild(panel)
    document.body.appendChild(this.#overlay)

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.#open) this.close()
    })
  }

  /** Open for a specific project (⋯ menu / onboarding), else the active one. */
  /** Who owned the keyboard before this overlay opened (#1199). */
  readonly #focusReturn = new OverlayFocusReturn()

  async open(rootPath?: string, sectionId?: string): Promise<void> {
    // #1395: ONE SETTINGS DIALOG AT A TIME. The three overlays share a class
    // and a z-index and are appended to <body> in a fixed order, so equal
    // z-indexes paint in DOM order and the one opened LAST was drawn
    // UNDERNEATH. ⌘, over an open sibling therefore moved focus into a dialog
    // the user could not see, and Escape closed the visible one to reveal a
    // second they never asked for.
    closeOtherSettingsOverlays('flow-settings')
    // #1199: remember the keyboard's owner before the trap takes it.
    this.#focusReturn.capture(this.#overlay)
    const target =
      rootPath ?? (await window.flow.project.active().catch(() => null))?.rootPath ?? null
    this.#open = true
    this.#overlay.hidden = false
    // A VISIT STARTS ON THE FIELDS. Reopening the panel means "show me the
    // settings"; landing on the list somebody was reading last week is the
    // panel remembering something nobody asked it to.
    this.#page = 'settings'
    this.#storage = null
    if (!target) {
      // No project — show a hint instead of a blank/broken panel.
      this.#showNoProject()
      return
    }
    this.#rootPath = target
    this.#title.textContent = `Flow settings · ${projectName(target)}`
    // Messages about values typed in a previous visit belong to that visit —
    // and so does a row somebody started taking over and walked away from.
    this.#validation.clear()
    this.#owning.clear()

    // Reconcile external /flow edits (and our own writes' echo) into the panel.
    this.#unsubscribe = window.flow.flow.onStateChanged((state: FlowState) => {
      if (this.#open && state.rootId === this.#rootPath) {
        this.#applyConfig(state.flowconfig)
        // #1032: PATCH, never rebuild. Our own writes echo back through here —
        // rebuilding destroyed the body between a field's blur-driven change and
        // the mouseup of the click that caused it, so the next control's click
        // (and any text still being typed) vanished with no feedback.
        this.#patchControls()
        // A write to the file can change WHO OWNS a value as well as the value
        // — taking a default over adds a key, handing it back removes one — and
        // neither shows in the file's contents alone. Re-resolve.
        void this.#reloadWorktreeSettings()
      }
    })
    // Track this root's provisioning stamp (ide-auto-provisioning) — refreshed
    // whenever ANY root changes (add/remove/reorder/(re-)provision), so a
    // manual "Re-provision now" or a background sweep both reflect live.
    this.#unsubscribeRoots = window.flow.project.onListChanged((roots) => {
      if (!this.#open) return
      // #1453: the project this panel edits can be REMOVED while it is open.
      // Nothing used to check, so the dialog kept its title, kept every control
      // enabled, and kept writing flow/.flowconfig into a folder the project list
      // no longer owns — while the shell behind it had already fallen back to
      // "No project". It also reported the removed (and genuinely provisioned)
      // project as "Not provisioned", because #root resolved to undefined.
      // Degrade to the panel's own project-less state: same words it shows when
      // opened with no project, and #rootPath null, which is what every write
      // path already guards on.
      if (this.#rootPath !== null && !roots.some((root) => root.rootPath === this.#rootPath)) {
        this.#showNoProject()
        return
      }
      this.#applyRoots(roots)
      // Only the provisioning card depends on root data — swap THAT node and
      // leave every field (and the user's focus/click) untouched (#1032).
      this.#refreshProvisioningSection()
    })

    // The two reads the panel needs: the project's own file, and the same
    // settings RESOLVED through the person's defaults and the built-ins. Both
    // before the first render, so no field is ever drawn with a value it is
    // about to lose.
    let config: Record<string, string> = {}
    try {
      const state = await window.flow.flow.state({ rootId: target })
      config = state.flowconfig
    } catch (error) {
      console.warn('flow: failed to load flow settings', error)
    }
    await this.#loadWorktreeSettings(target)
    this.#applyConfig(config)
    try {
      this.#applyRoots(await window.flow.project.list())
    } catch (error) {
      console.warn('flow: failed to load project roots', error)
      this.#root = undefined
    }
    this.#renderSections()
    if (sectionId !== undefined && this.#scrollToSection(sectionId)) return
    // #1455: an overlay that owns the keyboard has to actually HOLD it. This one
    // auto-opens the first time a project becomes active, with nothing inside it
    // focused — the panel isn't focusable and its first input is disabled — so
    // the focus trap had no `lastFocusedInOverlay` to return to and keystrokes
    // went to <body>. Same class as #1486 and #1199: a modal that takes the
    // screen without taking the caret.
    this.#focusFirstControl()
  }

  /**
   * Bring one section into view and put the keyboard in it (#1455's rule
   * still holds: the overlay must hold the caret). False when no section has
   * that id, so the caller falls back to the first control.
   */
  #scrollToSection(sectionId: string): boolean {
    const section = [...this.#body.querySelectorAll<HTMLElement>('[data-section-id]')].find(
      (candidate) => candidate.dataset['sectionId'] === sectionId,
    )
    if (section === undefined) return false
    section.scrollIntoView({ block: 'start' })
    const focusable = section.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), button:not([disabled]), a[href]',
    )
    if (focusable !== null) focusable.focus({ preventScroll: true })
    else {
      this.#overlay.tabIndex = -1
      this.#overlay.focus({ preventScroll: true })
    }
    return true
  }

  /** Put the keyboard on the first control the user can actually use (#1455). */
  #focusFirstControl(): void {
    // Prefer somewhere typing actually goes — the same choice the New-task
    // modal makes with its title input. A toggle or a number field would take
    // the caret and silently swallow ordinary keystrokes.
    const typable = this.#body.querySelector<HTMLElement>(
      'textarea:not([disabled]), input[type="text"]:not([disabled]), input[type="url"]:not([disabled]), input[type="search"]:not([disabled]), input:not([type]):not([disabled])',
    )
    const focusable =
      typable ??
      this.#body.querySelector<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
    if (focusable !== null) {
      focusable.focus()
      return
    }
    // Nothing usable to focus (the project-less state): hold the keyboard on the
    // overlay itself rather than leaving it on whatever is behind the backdrop.
    this.#overlay.tabIndex = -1
    this.#overlay.focus()
  }

  close(): void {
    // THREE STEPS, IN THIS ORDER, and each one is a bug that has happened.
    //
    // 1. COMMIT WHAT IS BEING TYPED. A text field here writes on `change`,
    //    which for an input means blur — and it used to be blurred as a SIDE
    //    EFFECT of the focus-return moving the keyboard elsewhere. Hiding an
    //    element that holds focus does not reliably fire `change`, so a typed
    //    branch name was silently dropped the moment that order changed. It is
    //    blurred deliberately now, while the dialog is still on screen.
    // 2. HIDE.
    // 3. HAND THE KEYBOARD BACK — after the hide, because the focus TRAP is
    //    live while the dialog is visible: a `restore()` that ran first focused
    //    the composer and had focus pulled straight back into a dialog that was
    //    still there (#1199, with its own fix in the wrong order).
    const typing = document.activeElement
    if (typing instanceof HTMLElement && this.#overlay.contains(typing)) typing.blur()
    this.#open = false
    this.#overlay.hidden = true
    this.#focusReturn.restore()
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#unsubscribeRoots?.()
    this.#unsubscribeRoots = null
    // The second page goes with the visit: nothing on it is worth keeping in
    // memory for a panel nobody can see (allowed-pattern #17).
    this.#page = 'settings'
    this.#storage = null
  }

  /**
   * The project-less panel: no root bound, no controls, one hint. Shared by
   * `open()` with no project and by a removal landing under an open dialog
   * (#1453) — one code path, so the two states can never drift into saying
   * different things about the same situation.
   */
  #showNoProject(): void {
    this.#rootPath = null
    this.#root = undefined
    this.#owning.clear()
    // A panel with no project has nothing to list, and a page still pointing at
    // a root that was just removed would read a project that is gone (#1453).
    this.#page = 'settings'
    this.#storage = null
    this.#title.textContent = 'Flow settings'
    this.#body.textContent = ''
    // The rows go with the body they were in — a patch against nodes nobody can
    // see is work done for no reader (allowed-pattern #17).
    this.#rows.clear()
    this.#warningsHost = null
    const hint = document.createElement('div')
    hint.className = 'fl-settings-empty'
    hint.textContent = 'Open a project to edit its flow settings.'
    this.#body.appendChild(hint)
  }

  /** Resolve `#root` from a fresh roots list (caller re-renders). */
  #applyRoots(roots: RegisteredProject[]): void {
    this.#root = roots.find((root) => root.rootPath === this.#rootPath)
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  #renderSections(): void {
    this.#body.textContent = ''
    this.#rows.clear()
    this.#warningsHost = null
    // THE SECOND PAGE OWNS THE WHOLE BODY when it is open. It is not a section
    // among the fields: it is a list that wants the width, and a reader on it
    // is answering a different question from the one the fields answer.
    if (this.#page === 'storage') {
      const storage = this.#storage
      if (storage !== null) {
        this.#body.appendChild(storage.element)
        return
      }
      // Nothing to show it for — fall through to the fields rather than paint
      // an empty page, which is the state a project-less panel is already in.
      this.#page = 'settings'
    }
    // "Claude account" first (#763): this overlay IS the project's settings
    // surface, so the per-project account binding must be changeable HERE — it
    // used to live only in the app Settings' "This project" section, where
    // users looking at "project settings" never found it.
    // The project's colour first: it is how the reader finds this project
    // everywhere else (user, 2026-10-06).
    this.#body.appendChild(this.#renderColourSection())
    this.#body.appendChild(this.#renderAccountSection())
    const disabled = disabledKeys(this.#values)
    for (const section of FLOW_SETTINGS_SECTIONS) {
      // Git & PR moved to the unified Settings page's Conversation files tab
      // (worktree_settings_ui) — one door for these keys, not two.
      if (section.title === GIT_PR_SECTION_TITLE) continue
      const el = document.createElement('div')
      el.className = 'fl-settings-section'
      const heading = document.createElement('div')
      heading.className = 'fl-settings-heading'
      heading.textContent = section.title
      el.appendChild(heading)
      if (section.title === WORKTREE_SECTION_TITLE) {
        // The resolver's warnings sit ABOVE the fields they are about: they say
        // why a value on screen is not the value in use, which is unreadable
        // after the fact and useless below the control it explains.
        this.#warningsHost = document.createElement('div')
        this.#warningsHost.className = 'fl-fs-warnings-host'
        el.appendChild(this.#warningsHost)
        this.#paintWarnings()
      }
      for (const field of section.fields) {
        el.appendChild(asElement(this.#buildRow(field, disabled)))
      }
      if (section.title === RUNTIME_SECTION_TITLE) {
        // A caption under the select that tells apart a runtime PINNED to this
        // project from one it merely INHERITS — so a project following the app
        // default never reads as pinned to it (the same distinction #1311 drew
        // for the account section). Loads async; skipped on an older preload.
        this.#providerCaption = document.createElement('div')
        this.#providerCaption.className = 'fl-settings-hint'
        el.appendChild(this.#providerCaption)
        // The readiness refusal lives right below the caption — where the reader
        // is looking when the select springs back. Hidden until a concrete
        // runtime that is not ready is picked (#gateProviderChange fills it).
        this.#providerRequirements = document.createElement('div')
        this.#providerRequirements.className = 'fl-fs-provider-gate'
        this.#providerRequirements.hidden = true
        el.appendChild(this.#providerRequirements)
        void this.#refreshProviderCaption()
      }
      // A section can carry a block that is not a config key at all — today
      // only the Learning budget, which is a constant rather than a setting.
      // (A "Loops" block lived here too; loops are configured in the Loops
      // modal on the board now, beside the status they govern.)
      if (section.extra === 'learn-budget') {
        el.appendChild(this.#renderBudgetInfo())
      }
      if (section.extra === 'thread-worktrees') {
        el.appendChild(this.#renderWorktreesRow())
      }
      this.#body.appendChild(el)
    }
    this.#provisioningSection = this.#renderProvisioningSection()
    this.#body.appendChild(this.#provisioningSection)
  }

  /**
   * "Colour" — the project's colour everywhere it is named: the file tree's
   * bar, tabs, the Workspace switcher and the Workspace map. Auto is its place
   * in its Workspace. A pick goes through the one write path
   * (project:setRootAccent) and is applied here at once, so every open surface
   * repaints without waiting for the roots broadcast.
   */
  #renderColourSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fl-settings-section'
    section.dataset['flowSettings'] = 'colour'
    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = 'Colour'
    section.appendChild(heading)
    const rootPath = this.#rootPath
    if (rootPath === null) return section
    const hint = document.createElement('div')
    hint.className = 'fl-settings-hint'
    hint.textContent = 'Marks this project in the file tree, tabs, the Workspace menu and the Workspace map. Auto follows its place in its Workspace.'
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:6px 0 4px;'
    const paint = (): void => {
      row.textContent = ''
      const model = accentPickerModel(rootPath, accentOverrideFor(rootPath))
      const swatchStyle = (fill: string, selected: boolean): string =>
        [
          'width:20px',
          'height:20px',
          'border-radius:50%',
          'padding:0',
          `background:${fill}`,
          'cursor:pointer',
          `border:2px solid ${selected ? 'var(--fl-color-text)' : 'transparent'}`,
          'box-shadow:0 0 0 1px var(--fl-color-border)',
        ].join(';')
      model.swatches.forEach((swatch, index) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.dataset['colour'] = swatch.color
        button.style.cssText = swatchStyle(swatch.paint, swatch.selected)
        button.setAttribute('aria-label', `Colour ${String(index + 1)}`)
        button.setAttribute('aria-pressed', String(swatch.selected))
        button.addEventListener('click', () => void pick(swatch.color))
        row.appendChild(button)
      })
      const auto = document.createElement('button')
      auto.type = 'button'
      auto.className = 'fl-btn'
      auto.dataset['colour'] = 'auto'
      auto.textContent = 'Auto'
      auto.setAttribute('aria-pressed', String(model.autoSelected))
      auto.style.cssText = `margin-left:4px;font-weight:${model.autoSelected ? '600' : '400'};`
      auto.addEventListener('click', () => void pick(null))
      row.appendChild(auto)
    }
    const pick = async (color: string | null): Promise<void> => {
      const before = accentOverrideFor(rootPath)
      setAccentOverride(rootPath, color)
      paint()
      try {
        await window.flow.project.setRootAccent({ rootPath, color })
      } catch (error) {
        console.error('flow: failed to set the project colour', error)
        setAccentOverride(rootPath, before)
        paint()
        hint.textContent = "Couldn't save the colour. Try again."
      }
    }
    paint()
    section.appendChild(row)
    section.appendChild(hint)
    return section
  }

  /**
   * "Claude account" — the per-project account binding (#763). Mirrors the app
   * Settings' "This project" section (same accounts API, same optimistic select
   * + revert-on-failure), so the binding is changeable from the surface users
   * actually think of as "project settings". Data loads async into the section
   * shell; a fetch failure degrades to a hint (never a broken control).
   */
  #renderAccountSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fl-settings-section'
    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = 'Claude account'
    section.appendChild(heading)
    const hint = document.createElement('div')
    hint.className = 'fl-settings-hint'
    hint.textContent = 'Loading accounts…'
    section.appendChild(hint)

    const rootPath = this.#rootPath
    if (!rootPath) {
      hint.textContent = 'Open a project to bind an account.'
      return section
    }
    void (async () => {
      try {
        const [accounts, resolution] = await Promise.all([
          window.flow.accounts.list(),
          window.flow.accounts.activeForProject({ rootPath }),
        ])
        // #1311: #1108 named TWO surfaces and its fix commit touched one. This
        // is the other — the per-project surface #763 added precisely because
        // "users looking at a project want to know what it runs as" — and it
        // still flattened "pinned to this account" and "merely following the
        // default" into the same sentence. A project that follows the default
        // must not read as pinned to it: change the default and it moves,
        // which is the opposite of what "Runs under: X" implies.
        hint.textContent =
          resolution.status === 'ready'
            ? resolution.source === 'override'
              ? `Pinned to: ${resolution.label}`
              : `Runs under: ${resolution.label} (inherited default — follows it if you change it)`
            : resolution.status === 'dangling'
              ? 'Bound account was removed — pick another.'
              : 'Uses the default account (or your CLI login if none is set).'
        if (accounts.length === 0) {
          const add = document.createElement('div')
          add.className = 'fl-settings-hint'
          add.textContent = 'No accounts added yet — add one in Settings → Model settings.'
          section.appendChild(add)
          return
        }
        const select = document.createElement('select')
        select.className = 'fl-settings-select'
        const defaultOpt = document.createElement('option')
        defaultOpt.value = ''
        defaultOpt.textContent = 'Use default account'
        select.appendChild(defaultOpt)
        for (const account of accounts) {
          const opt = document.createElement('option')
          opt.value = account.id
          opt.textContent = account.label
          select.appendChild(opt)
        }
        // #1311: only a PINNED project selects a concrete account; an inherited
        // default leaves "Use default account" selected, so the stored state
        // is visible and re-selectable (#1108's rule, ported).
        select.value =
          resolution.status === 'ready' && resolution.source === 'override'
            ? resolution.accountId
            : ''
        // Optimistic with revert (#226) — the select never misrepresents the binding.
        let committed = select.value
        select.addEventListener('change', () => {
          const attempted = select.value
          const previous = committed
          committed = attempted
          window.flow.accounts
            .assignProject({ rootPath, accountId: attempted === '' ? null : attempted })
            .then(() => {
              // #1311: the post-assign hint flattened them too — assigning
              // "Use default account" then read as a pin to whatever the
              // default happens to be right now.
              if (attempted === '') {
                hint.textContent = 'Uses the default account (or your CLI login if none is set).'
              } else {
                const label = accounts.find((a) => a.id === attempted)?.label ?? attempted
                hint.textContent = `Pinned to: ${label}`
              }
            })
            .catch((error) => {
              const decision = resolveAssignRevert(select.value, attempted, previous)
              if (decision.revert) {
                select.value = decision.value
                committed = decision.value
              }
              hint.textContent = "Couldn't change the account — try again."
              console.error('flow: assignProject failed', error)
            })
        })
        section.appendChild(select)
      } catch (error) {
        hint.textContent = "Couldn't load accounts."
        console.warn('flow: account section load failed', error)
      }
    })()
    return section
  }

  /**
   * "Plan-flow provisioning" row (ide-auto-provisioning phase 5): the active
   * root's provisioned version + timestamp (or "Not provisioned"), plus a
   * manual "Re-provision now" action. Status text/actionability come from the
   * pure `flow-settings-model` helpers; this method only wires DOM + the IPC
   * call.
   */
  #renderProvisioningSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fl-settings-section'
    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = 'Plan-flow provisioning'
    section.appendChild(heading)

    const row = document.createElement('div')
    row.className = 'fl-fs-row'
    const label = document.createElement('div')
    label.className = 'fl-fs-label'
    const status = document.createElement('div')
    status.className = 'fl-fs-name'
    status.textContent = provisioningStatusText(this.#root)
    label.appendChild(status)
    row.appendChild(label)

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-settings-btn'
    button.textContent = this.#reprovisioning ? 'Re-provisioning…' : 'Re-provision now'
    button.disabled = this.#reprovisioning || !canReprovision(this.#root) || this.#rootPath === null
    button.addEventListener('click', () => this.#reprovision())
    row.appendChild(button)

    section.appendChild(row)

    // Progressive-learning (#513 phase 2): re-fire the basic-discovery request
    // for this root (the same event the one-time onboarding ask sends). Always
    // available for a known root — running it again is harmless.
    const learnRow = document.createElement('div')
    learnRow.className = 'fl-fs-row'
    const learnLabel = document.createElement('div')
    learnLabel.className = 'fl-fs-label'
    const learnName = document.createElement('div')
    learnName.className = 'fl-fs-name'
    learnName.textContent = 'Basic discovery'
    const learnHint = document.createElement('div')
    learnHint.className = 'fl-fs-help'
    learnHint.textContent =
      'Read the top-level modules and build understanding on the blueprint.'
    learnLabel.append(learnName, learnHint)
    learnRow.appendChild(learnLabel)

    const learnButton = document.createElement('button')
    learnButton.type = 'button'
    learnButton.className = 'fl-settings-btn'
    learnButton.textContent = 'Run basic discovery'
    learnButton.disabled = this.#rootPath === null
    learnButton.addEventListener('click', () => this.#runBasicDiscovery())
    learnRow.appendChild(learnButton)

    section.appendChild(learnRow)
    return section
  }

  /** Re-fire the basic-discovery request for the active root (#513 phase 2). */
  #runBasicDiscovery(): void {
    const rootPath = this.#rootPath
    if (rootPath === null) return
    void window.flow.learn
      .answerBasicDiscovery({ rootId: rootPath, answer: 'yes' })
      .catch((error: unknown) => console.error('flow: run basic discovery failed', error))
  }

  /** Fire the manual re-provision action; failures surface via the same
   *  flow:notification toast every other provisioning path uses. */
  #reprovision(): void {
    const rootPath = this.#rootPath
    if (rootPath === null || this.#reprovisioning) return
    this.#reprovisioning = true
    this.#renderSections()
    void window.flow.project
      .provisionRoot({ rootPath })
      .catch((error: unknown) => console.error('flow: re-provision failed', error))
      .finally(() => {
        this.#reprovisioning = false
        if (this.#open) this.#renderSections()
      })
  }

  /** Read-only "Auto re-learns per session: N" line under the Learning toggle. */
  #renderBudgetInfo(): HTMLElement {
    const row = document.createElement('div')
    row.className = 'fl-fs-row'
    const label = document.createElement('div')
    label.className = 'fl-fs-label'
    const name = document.createElement('div')
    name.className = 'fl-fs-help'
    name.textContent = learnBudgetText()
    label.appendChild(name)
    row.appendChild(label)
    return row
  }

  /**
   * The way in to what this project is holding on disk.
   *
   * THE ONLY DOOR. Three others — the status segment, the sidebar menu and the
   * landing bar's total — belonged to surfaces that managed a conversation's
   * files as an object, and all three are gone. This one was always the honest
   * door: it is reachable from anywhere, it does not require the reader to
   * already have the thing they came to look at, and it sits in the section
   * that decides whether conversations keep files at all.
   *
   * IT GOES TO A PAGE, NOT A DIALOG. Pressing it walks the panel to its second
   * page; there is a way back at the top of that page, and Escape still closes
   * the panel, which is what Escape did before and means the same thing.
   */
  #renderWorktreesRow(): HTMLElement {
    const row = document.createElement('div')
    row.className = 'fl-fs-row'

    const label = document.createElement('div')
    label.className = 'fl-fs-label'
    const name = document.createElement('div')
    name.className = 'fl-fs-name'
    name.textContent = STORAGE_PAGE_TITLE
    const help = document.createElement('div')
    help.className = 'fl-fs-help'
    help.textContent =
      'See what each conversation is keeping on disk — how much room it takes, when it was last used, and whether its work has landed.'
    label.append(name, help)
    row.appendChild(label)

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-settings-btn'
    button.textContent = 'Open'
    const rootPath = this.#rootPath
    button.disabled = rootPath === null
    button.addEventListener('click', () => {
      if (rootPath === null || button.disabled) return
      this.#openStorage(rootPath)
    })
    row.appendChild(button)
    return row
  }

  /**
   * Walk to the second page.
   *
   * THE READ STARTS BEFORE THE PAINT, not after it. The page renders its own
   * empty shell immediately and fills in when the inventory answers, so the
   * button never becomes a control that looks broken for the second a
   * directory walk takes.
   */
  #openStorage(rootPath: string): void {
    this.#storage = new StoragePage(rootPath, { onBack: () => this.#closeStorage() })
    this.#page = 'storage'
    this.#renderSections()
    void this.#storage.load()
  }

  /** Walk back to the fields, and let the page go with the visit. */
  #closeStorage(): void {
    this.#page = 'settings'
    this.#storage = null
    this.#renderSections()
  }

  /**
   * One field row, built by the shared renderer so the global defaults panel
   * (which has no project at all) draws the identical control.
   *
   * The inherit switch is offered ONLY for a field whose provenance the panel
   * actually knows. When `flow:worktreeSettings` could not be read, the field
   * still edits the project's own value — it just does not claim to know what
   * it would fall back to.
   */
  #buildRow(field: FieldDef, disabled: Set<string>): FieldNode {
    const row = renderFieldRow(fieldDocument(), field, this.#rowState(field, disabled), {
      onChange: (value: FieldValue) => this.#change(field.key, value),
      onInherit:
        field.setting === undefined || this.#sources[field.key] === undefined
          ? undefined
          : (useProjectValue: boolean) => this.#setInherit(field, useProjectValue),
      // The door beside the chip. The ROW decides when to show it (only a value
      // inherited from the person's own defaults leads anywhere); this side only
      // says where it goes.
      onChipAction: field.setting === undefined ? undefined : () => openGlobalSettings(),
    })
    this.#rows.set(field.key, row)
    return row.row
  }

  /** Everything about a field that can change while the panel stays open. */
  #rowState(field: FieldDef, disabled: Set<string>): FieldRowState {
    return {
      value: this.#values[field.key],
      disabled: disabled.has(field.key),
      // A row taken over but not yet written reads as this panel's own, because
      // that is exactly what it is about to be — editable, unbadged, offering
      // to hand itself back.
      source:
        field.setting === undefined
          ? undefined
          : this.#owning.has(field.key)
            ? ownedEditingSource('project')
            : this.#sources[field.key],
      validation: this.#validation.get(field.key) ?? null,
      // Turning the switch off strands nothing — and saying so is the whole
      // difference between a setting and a surprise. Only this field has one.
      note:
        field.key === 'thread_worktrees'
          ? worktreesOffNote(this.#values.thread_worktrees === true)
          : null,
    }
  }

  /** Paint (or clear) the resolver's warnings above the Conversation files fields. */
  #paintWarnings(): void {
    const host = this.#warningsHost
    if (host === null) return
    host.textContent = ''
    const box = renderWarnings(fieldDocument(), this.#warnings)
    if (box !== null) host.appendChild(asElement(box))
  }

  /**
   * The project file's values, with the resolved worktree answers over them.
   *
   * ORDER MATTERS. `readValues` gives an absent key this module's own built-in,
   * which for an inherited field is not the value in effect — the person's
   * default is. Overlaying the last resolved answer keeps the panel from
   * flashing a value that is about to be replaced by the re-resolve.
   */
  #applyConfig(config: Record<string, string>): void {
    const values = readValues(config)
    for (const [key, state] of Object.entries(this.#worktreeStates)) {
      values[key] = state.value
    }
    this.#values = values
  }

  /**
   * Read the resolved settings for a root; failures leave provenance unknown.
   *
   * There is no broadcast when the app-wide defaults change, so a default
   * edited while this panel is open reaches it on the next open. That is a
   * read, not a write: the values on screen stay correct for what is on disk,
   * and re-resolving on every open costs one call.
   */
  async #loadWorktreeSettings(rootPath: string): Promise<boolean> {
    try {
      const result = await window.flow.flow.worktreeSettings({ rootId: rootPath })
      return this.#applyWorktreeSettings(result)
    } catch (error) {
      console.warn('flow: failed to resolve worktree settings', error)
      return false
    }
  }

  /** Fold a resolved answer in; true when the set of known provenances changed. */
  #applyWorktreeSettings(result: ResolvedWorktreeSettingsResult): boolean {
    const states = worktreeFieldStates(result.settings)
    const had = Object.keys(this.#sources).length
    const sources: Record<string, WorktreeSettingSource> = {}
    const values: FlowSettingsValues = { ...this.#values }
    for (const [key, state] of Object.entries(states)) {
      sources[key] = state.source
      values[key] = state.value
    }
    // A claim ends the moment the file says the same thing: the write landed.
    for (const key of [...this.#owning]) {
      if (sources[key] === 'project') this.#owning.delete(key)
    }
    this.#worktreeStates = states
    this.#sources = sources
    this.#values = values
    this.#warnings = result.warnings
    return had === 0 && Object.keys(sources).length > 0
  }

  /**
   * Re-resolve after a write and reflect it.
   *
   * A full re-render happens ONLY when provenance became known for the first
   * time (the first read failed and a later one succeeded), because that adds
   * controls the rows do not have. Every other case is a patch — rebuilding a
   * body someone is clicking in is #1032.
   */
  async #reloadWorktreeSettings(): Promise<void> {
    const rootPath = this.#rootPath
    if (rootPath === null) return
    const gainedProvenance = await this.#loadWorktreeSettings(rootPath)
    if (!this.#open || this.#rootPath !== rootPath) return
    if (gainedProvenance) {
      this.#renderSections()
      return
    }
    this.#paintWarnings()
    this.#patchControls()
  }

  /**
   * Take an inherited value over as this project's own, or hand it back.
   *
   * THE ONLY PATH TO A REMOVAL. Handing a value back deletes the project's key,
   * and it happens here and nowhere else — never from a cleared field, never
   * from a write that merely failed to mention the key (forbidden-pattern #15).
   * Taking one over writes the value already on screen, which the value diff
   * cannot express: nothing about the value changed, only who owns it.
   */
  #setInherit(field: FieldDef, useProjectValue: boolean): void {
    const rootPath = this.#rootPath
    if (rootPath === null) return
    // The blank take-over: there is no value to write, so the row simply
    // becomes editable here and waits for one (see #owning).
    if (useProjectValue && takeOverAction(this.#values[field.key]) === 'own') {
      this.#owning.add(field.key)
      this.#validation.set(field.key, null)
      this.#patchControls()
      return
    }
    // …and its opposite: handing back a row that was never written removes
    // nothing, because nothing was ever put there.
    if (!useProjectValue && this.#owning.has(field.key)) {
      this.#owning.delete(field.key)
      this.#validation.set(field.key, null)
      this.#patchControls()
      return
    }
    const updates: Record<string, string | null> = {
      [field.key]: useProjectValue ? fieldConfigString(field, this.#values[field.key]) : null,
    }
    this.#validation.set(field.key, null)
    void window.flow.flow
      .setConfig({ rootId: rootPath, updates })
      .then(() => {
        this.#showWriteError(null)
        return this.#reloadWorktreeSettings()
      })
      .catch((error: unknown) => {
        console.error('flow: failed to change where a worktree setting comes from', error)
        this.#showWriteError("Couldn't save that setting — the project's settings file wouldn't take it.")
      })
  }

  // ── Editing ────────────────────────────────────────────────────────────

  /**
   * Reflect the current state onto the live rows without touching DOM identity:
   * values, disabled state, provenance chips, inherit labels, notes and
   * validation messages all patch in place. A key with no live row is skipped
   * (the structure changed and a render is already on its way).
   */
  #patchControls(): void {
    const disabled = disabledKeys(this.#values)
    const active: unknown = document.activeElement
    for (const section of FLOW_SETTINGS_SECTIONS) {
      for (const field of section.fields) {
        const row = this.#rows.get(field.key)
        if (row === undefined) continue
        // NEVER clobber the field the user is currently editing.
        const keepControlValue =
          active === (row.control as unknown) ||
          (row.companion !== null && active === (row.companion as unknown))
        row.update(this.#rowState(field, disabled), { keepControlValue })
      }
    }
  }

  /** Replace just the provisioning card in place (root data changed) — never
   *  the whole body, which would eat an in-flight click (#1032). */
  #refreshProvisioningSection(): void {
    const current = this.#provisioningSection
    const next = this.#renderProvisioningSection()
    this.#provisioningSection = next
    if (current !== null && current.parentNode === this.#body) {
      this.#body.replaceChild(next, current)
      return
    }
    this.#body.appendChild(next)
  }

  /**
   * Fill the Runtime caption from settings:getProjectProvider — which provider
   * the project resolves to, and whether that came from its own config
   * ('project' → pinned) or the app default ('default'/'builtin' → inherited).
   *
   * FAIL-SOFT. An older preload has no `getProjectProvider`; the caption is left
   * empty rather than guessed, exactly as a missing chip is better than a wrong
   * one. A fetch failure does the same.
   */
  async #refreshProviderCaption(): Promise<void> {
    const caption = this.#providerCaption
    const rootPath = this.#rootPath
    if (caption === null || rootPath === null) return
    const getProjectProvider = window.flow.settings.getProjectProvider
    if (getProjectProvider === undefined) {
      caption.textContent = ''
      return
    }
    try {
      const { provider, source } = await getProjectProvider({ rootPath })
      // Only paint if the panel is still on the same project and this caption is
      // the live one (a reopen swaps the node).
      if (this.#rootPath !== rootPath || this.#providerCaption !== caption) return
      caption.textContent =
        source === 'project'
          ? `Pinned to ${provider} for this project.`
          : `Inherited from the app default (${provider}).`
    } catch (error) {
      console.warn('flow: failed to read project provider', error)
      if (this.#providerCaption === caption) caption.textContent = ''
    }
  }

  /**
   * Apply a single change: validate, enforce dependencies, persist the diff.
   *
   * VALIDATED WHERE TYPED, NEVER SANITIZED (allowed-pattern #22). A worktree
   * value the panel cannot accept is shown back with what is wrong with it and
   * is NOT written — silently correcting a name someone deliberately typed is
   * how a project ends up publishing somewhere nobody chose. A warning is the
   * other case: the value is written, and the panel says what it noticed.
   */
  #change(key: string, value: boolean | number | string): void {
    if (this.#rootPath === null) return
    const field = fieldByKey(key)
    // A row taken over and left blank is a decision not taken: write nothing
    // and let it inherit again, rather than sit owned-but-empty.
    if (this.#owning.has(key) && ownedEditAction(value) === 'release') {
      this.#owning.delete(key)
      this.#validation.set(key, null)
      this.#values = { ...this.#values, [key]: value }
      this.#patchControls()
      return
    }
    if (field?.setting !== undefined) {
      const result = validateWorktreeField(key, String(value))
      this.#validation.set(key, 'ok' in result ? null : result)
      if (isRefusal(result)) {
        // Keep what they typed on screen so it can be fixed, and write nothing.
        this.#values = { ...this.#values, [key]: value }
        this.#patchControls()
        return
      }
    }
    // Pinning the project to a CONCRETE runtime it has not signed into (or
    // installed) is a first-turn failure minutes later, in a CLI's stderr — the
    // same trap the app-wide selector closes (settings-view.ts). Check before we
    // write; the write itself is reversible, so the check is fail-SOFT (an older
    // preload or a throwing probe lets it through). `inherit` clears the override
    // and is always safe, so it never gates.
    if (key === 'provider' && isConcreteProvider(value)) {
      void this.#gateProviderChange(String(value), field)
      return
    }
    // A non-concrete provider change is `inherit` — it clears the override, so
    // any lingering readiness refusal from a rejected pin is now moot.
    if (key === 'provider') this.#paintProviderGate({ kind: 'clear' })
    this.#writeChange(key, value, field)
  }

  /**
   * Compute the diff and persist it, patching the panel and rolling back on a
   * failed write. Split out of `#change` so the provider readiness gate can run
   * first and reach the identical write path once it passes.
   */
  #writeChange(key: string, value: boolean | number | string, field: FieldDef | undefined): void {
    const rootPath = this.#rootPath
    if (rootPath === null) return
    const before = this.#values
    const draft: FlowSettingsValues = { ...before, [key]: value }
    const after = applyDependencies(draft, key)
    // `setConfig` accepts null to UNSET a key. The provider select's `inherit`
    // option is not a value to store — it means "no project override, use the
    // app default" — so it clears the key rather than writing the literal
    // string 'inherit'. Every other field's diff is untouched.
    const updates: Record<string, string | null> = toConfigUpdates(before, after)
    if ('provider' in updates) updates.provider = providerWriteValue(String(updates.provider))
    this.#values = after
    // #1032: PATCH in place. The rebuild this used to do destroyed the body
    // between a field's change event (fired on blur) and the click that caused
    // it — so the next control's click, and any text still being typed, were
    // silently lost. Patching keeps every node (and focus) alive while still
    // reflecting guardrail-driven changes immediately.
    this.#patchControls()
    if (Object.keys(updates).length > 0) {
      // #1158: the write is no longer fire-and-forget. A rejected setConfig used
      // to reach nothing the user could see — the toggle stayed flipped, the
      // text stayed typed, and none of it was on disk, so the user walked away
      // believing autopilot / auto-push / auto-PR were configured as shown.
      // On failure the panel ROLLS BACK to the values it had (which are the
      // ones on disk) and says so, exactly as the account select directly above
      // these controls already does (#226) — and as #216/#217/#229/#307 did for
      // every sibling surface.
      void window.flow.flow
        .setConfig({ rootId: rootPath, updates })
        .then(() => {
          this.#showWriteError(null)
          // A first value written for an inherited field makes this project its
          // owner — the chip has to stop saying otherwise.
          if (field?.setting !== undefined) void this.#reloadWorktreeSettings()
          // Pinning or clearing the provider flips the caption between "pinned"
          // and "inherited" — re-read so it stays truthful, same as the chip above.
          // It also changes the runtime a project RESOLVES to, which the main
          // Settings view gates its "This project" account picker and model
          // routing on (Phase 3). Emit the app's existing runtime-changed signal
          // so that view re-gates without a bespoke listener on this overlay.
          if (key === 'provider') {
            void this.#refreshProviderCaption()
            document.dispatchEvent(new CustomEvent('flow:runtime-changed'))
          }
        })
        .catch((error: unknown) => {
          console.error('flow: failed to write flow settings', error)
          // Only roll back if the panel is still showing the same project and
          // no later edit has landed — a stale failure must not undo newer work.
          if (this.#rootPath === rootPath && this.#values === after) {
            this.#values = before
            this.#patchControls()
          }
          this.#showWriteError("Couldn't save that setting — the project's settings file wouldn't take it.")
        })
    }
  }

  /**
   * Gate a pin to a concrete runtime on that runtime being ready.
   *
   * FAIL-SOFT, unlike the app-wide selector's fail-closed gate (settings-view.ts):
   * a project override is a reversible key in one file, so an un-checkable runtime
   * — an older preload with no probe, or a probe that threw — is written anyway
   * rather than blocked. Only a probe that ANSWERS "not ready" refuses. A refusal
   * puts the select back to the value on disk and names what is missing; nothing
   * is written.
   */
  async #gateProviderChange(provider: string, field: FieldDef | undefined): Promise<void> {
    const check = window.flow.settings.checkRuntimeAuth
    if (typeof check !== 'function') {
      // Cannot verify ≠ not ready — let the reversible write through.
      this.#paintProviderGate({ kind: 'clear' })
      this.#writeChange('provider', provider, field)
      return
    }
    this.#paintProviderGate({ kind: 'checking', provider })
    let answer: RuntimeAuthAnswer
    try {
      answer = await check({ provider })
    } catch (error) {
      console.warn('flow: could not verify runtime readiness', error)
      // A probe that threw has not said "not ready"; the write is reversible.
      if (this.#open && this.#rootPath !== null) {
        this.#paintProviderGate({ kind: 'clear' })
        this.#writeChange('provider', provider, field)
      }
      return
    }
    // The panel may have moved to another project (or closed) while we asked.
    if (!this.#open || this.#rootPath === null) return
    if (requirementsMet(runtimeRequirements(answer))) {
      this.#paintProviderGate({ kind: 'clear' })
      this.#writeChange('provider', provider, field)
      return
    }
    // Answered "not ready": do not pin. Put the select back and say why.
    this.#revertProviderSelect()
    this.#paintProviderGate({ kind: 'refused', provider, answer })
  }

  /**
   * Put the Runtime select back to the value on disk after a refused pin. The
   * select is likely still focused, so `#patchControls` would keep its (rejected)
   * value — this writes the effective value onto the control directly, the same
   * revert the app-wide selector does.
   */
  #revertProviderSelect(): void {
    const row = this.#rows.get('provider')
    if (row === undefined) return
    const select = row.control as unknown as HTMLSelectElement
    const current = this.#values.provider
    // `inherit` is the option shown for an absent/undefined provider key.
    select.value = typeof current === 'string' && current.length > 0 ? current : 'inherit'
  }

  /**
   * Paint the inline readiness state under the Runtime select. `refused` names
   * the runtime and the unmet requirements, and offers a real action — the app's
   * Model settings, where install/sign-in live — rather than a command string a
   * settings panel cannot run (forbidden-pattern #12).
   */
  #paintProviderGate(state: ProviderGateState): void {
    const host = this.#providerRequirements
    if (host === null) return
    host.textContent = ''
    if (state.kind === 'clear') {
      host.hidden = true
      host.removeAttribute('role')
      return
    }
    host.hidden = false
    if (state.kind === 'checking') {
      host.removeAttribute('role')
      host.textContent = `Checking ${runtimeName(state.provider)}…`
      return
    }
    host.setAttribute('role', 'alert')
    const unmet = runtimeRequirements(state.answer).filter((requirement) => !requirement.met)
    const missing = unmet.map((requirement) => requirement.label).join(' · ')
    const line = document.createElement('div')
    line.textContent =
      missing.length > 0
        ? `${runtimeName(state.provider)} isn't ready — ${missing}.`
        : `${runtimeName(state.provider)} isn't ready to run yet.`
    host.appendChild(line)
    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'fl-fs-provider-gate-action'
    action.textContent = 'Open Model settings'
    action.addEventListener('click', () => openGlobalSettings())
    host.appendChild(action)
  }

  /** Inline write-failure line under the settings body (#1158), or clear it. */
  #showWriteError(message: string | null): void {
    if (message === null) {
      this.#writeError?.remove()
      this.#writeError = null
      return
    }
    if (this.#writeError === null || this.#writeError.parentNode !== this.#body) {
      const line = document.createElement('div')
      line.className = 'fl-fs-write-error'
      line.setAttribute('role', 'alert')
      this.#writeError = line
      this.#body.appendChild(line)
    }
    this.#writeError.textContent = message
  }
}

function projectName(rootPath: string): string {
  const trimmed = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

let flowStylesInjected = false

function injectFlowSettingsStyles(): void {
  if (flowStylesInjected) return
  flowStylesInjected = true
  // The rows' own CSS has ONE owner now (the app settings panel draws the same
  // rows); this injector keeps only what is this panel's alone.
  injectFieldRowStyles()
  const style = document.createElement('style')
  style.textContent = `
    .fl-fs-write-error {
      margin-top: var(--fl-space-sm); color: var(--fl-color-error);
      font-size: var(--fl-text-caption-size);
    }
    .fl-fs-provider-gate {
      margin-top: var(--fl-space-xs); color: var(--fl-color-error);
      font-size: var(--fl-text-caption-size);
      display: flex; flex-direction: column; align-items: flex-start;
      gap: var(--fl-space-xs);
    }
    .fl-fs-provider-gate[hidden] { display: none; }
    .fl-fs-provider-gate-action {
      background: none; border: none; padding: 0; cursor: pointer;
      color: var(--fl-color-accent); font-size: var(--fl-text-caption-size);
      text-decoration: underline;
    }
  `
  document.head.appendChild(style)
}
