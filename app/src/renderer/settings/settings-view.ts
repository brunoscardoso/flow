/**
 * Settings overlay — the first settings surface in the app. v1 hosts the
 * per-project Anthropic **Accounts** manager: add + log in accounts (each an
 * isolated CLAUDE_CONFIG_DIR), set a default, remove, and bind a specific
 * account to the active project. Secrets never reach here — the bridge exposes
 * labels/ids/identity only.
 *
 * Self-mounting: `initSettings()` constructs one instance that listens for the
 * `flow:open-settings` event (dispatched by the titlebar button) and renders a
 * modal into document.body on demand.
 */
import { closeOtherSettingsOverlays } from './settings-overlay-stack'
import { mountIntegrations } from './integrations-settings-view'
import {
  TASK_LIST_CHOICES,
  taskListOutcome,
  taskListProblem,
  taskListStateFor,
  type TaskListChoice,
} from '../loops/task-list-model'
import { submitOnEnter } from './submit-on-enter-dom'
import { supportsModelRouting } from '../../shared/runtime-models'
import {
  canSignInHere,
  canSignOutHere,
  signOutConfirm,
  claudeOnlyNote,
  installConfirm,
  installingMessage,
  noCheckAnswer,
  projectAccountSurface,
  requirementsMet,
  runtimeName,
  runtimeRequirements,
  signInUnconfirmed,
  type RuntimeAuthAnswer,
} from './runtime-ready'
import { mountRuntimeLoginAssist, type RuntimeLoginAssist } from './runtime-login-assist'
import '../components'
import type {
  AccountSummary,
  EffortLevel,
  RuntimeContextChoice,
  WorktreeDefaults,
  WorktreeSettingKey,
} from '../../shared/ipc-contract'
import {
  GIT_PR_SECTION_TITLE,
  WORKTREE_DEFAULTS_NOTE,
  WORKTREE_DEFAULTS_OVERRIDE_NOTE,
  WORKTREE_DEFAULTS_TITLE,
  WORKTREE_SECTION_TITLE,
  applyDependencies,
  fieldConfigString,
  gitPrFields,
  isRefusal,
  ownedEditAction,
  ownedEditingSource,
  readValues,
  takeOverAction,
  toConfigUpdates,
  validateWorktreeField,
  worktreeDefaultsStates,
  worktreeFields,
  type FieldDef,
  type FieldValidation,
  type FieldValue,
  type FlowSettingsValues,
  type InheritableState,
} from './flow-settings-model'
import {
  FIELD_ROW_STYLES,
  renderFieldRow,
  type FieldDocument,
  type FieldNode,
  type FieldRow,
  type FieldRowState,
} from './settings-fields'
import {
  DEFAULT_MODEL_ROUTING,
  isRoutableModel,
  ROUTABLE_MODELS,
  type ModelRouting,
  type RoutableModel,
} from '../../shared/model-routing'
import { modelLabel } from '../threads/model-label'
import { mountLoginAssist } from '../accounts/login-assist'
import { resolveAssignRevert } from './account-assign'
import {
  accountActionFailedToast,
  modelRoutingSaveFailedToast,
  telemetryConsentSaveFailedToast,
  worktreeDefaultSaveFailedToast,
  type SettingsToast,
} from './settings-feedback'
import { isLatestRender } from './render-guard'
import { privacyCopy } from './privacy-model'
import { signInCopy, signInStateFrom, type SignInState } from './sign-in-model'
import type { EditorApi } from '../editor'
import { CARRY_KEY_ATTR, captureSettingsInput, restoreSettingsInput } from './input-carry'
import { FEED_DENSITY_OPTIONS, THEME_MODE_OPTIONS } from './appearance-model'
import { isFeedDensity } from '../threads/feed-density'
import { getFeedDensity, onFeedDensityChanged, setFeedDensity } from '../threads/feed-density-controller'
import { getThemeMode, setThemeMode, onThemeChanged } from '../theme/theme-controller'
import { isThemeMode } from '../theme/theme-model'

import { WorkspaceSettingsSection } from './workspace-settings-section'
import { WORKSPACES_GROUP_LABEL } from './workspace-settings-model'

const OPEN_EVENT = 'flow:open-settings'

/**
 * The seam between the real DOM and the shared field builders.
 *
 * `settings-fields` is typed against minimal structural interfaces so it runs
 * under the app's node-env jest, which omits the DOM lib. These two casts are
 * the entire cost of that, and they live at the one place a real document is
 * handed in and a real element taken back — the same idiom the project panel
 * uses, deliberately identical.
 */
function fieldDocument(): FieldDocument {
  return document as unknown as FieldDocument
}

function asElement(node: FieldNode): HTMLElement {
  return node as unknown as HTMLElement
}

/** Wire the singleton settings overlay. Call once during shell setup. */
export function initSettings(editorApi: EditorApi): void {
  if (!window.flow?.accounts) {
    console.warn('flow: accounts bridge missing — settings disabled')
    return
  }
  const view = new SettingsView(editorApi)
  // A CALLER MAY NAME THE GROUP. `flow:open-settings` with no detail opens
  // wherever the page was left; with `{ group: 'tasks' }` it lands on the
  // setting the caller is about — which is what makes a control elsewhere in
  // the app able to point AT something rather than merely at Settings.
  document.addEventListener(OPEN_EVENT, (event) => {
    const asked = (event as CustomEvent<{ group?: string }>).detail?.group
    void view.open(SETTINGS_GROUPS.some((g) => g.key === asked) ? (asked as SettingsGroup) : undefined)
  })
}

/** The settings page's tab id, and the id its editor tab is opened under. */
export const SETTINGS_TAB_ID = 'flow://settings'

/**
 * THE GROUPS, and the whole reason this stopped being one scroll.
 *
 * Settings was a single column: the runtime picker, then every Claude login,
 * then this project's account, then five worktree defaults, then the theme,
 * then updates, then model routing. Every one of those is a different KIND of
 * decision, and reading them as one list meant scrolling past four of them to
 * reach the fifth — the user's own words looking at it: "separate everything by
 * tabs inside to be clear each kind of config".
 *
 * Five groups, and the split is by what a person came to change:
 *  · Models — which agent runs, and who it runs as
 *  · Conversation files — what a conversation keeps on disk, and where its
 *    work goes
 *  · Tasks — where this project's work comes from
 *  · Integrations — the accounts that reach it
 *  · App — the things about Flow itself
 */
export const SETTINGS_GROUPS = [
  { key: 'models', label: 'Models' },
  // The KEY is the internal one and stays; the label is what a person reads,
  // and it stopped being the internal noun for a directory Flow makes
  // (worktree-ui-removal Phase 5, task 5.6).
  { key: 'worktrees', label: WORKTREE_SECTION_TITLE },
  { key: 'tasks', label: 'Tasks' },
  { key: 'integrations', label: 'Integrations' },
  // Grouping projects into Workspaces — the on/off switch and each Workspace's
  // projects, sync and shared repository (workspaces-knowledge-hub Phase 10).
  { key: 'workspaces', label: WORKSPACES_GROUP_LABEL },
  { key: 'app', label: 'App' },
] as const

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]['key']

// ── Appearance section primitives ───────────────────────────────────────────
//
// Two selectors now share this section (theme and conversation density), so the
// row/select/option shapes are built once. Two hand-rolled copies of the same
// 24px select would drift the moment either is touched.

function appearanceSelect(ariaLabel: string): HTMLSelectElement {
  const select = document.createElement('select')
  select.setAttribute('aria-label', ariaLabel)
  select.style.cssText =
    'height:24px;padding:0 var(--fl-space-xs);background:var(--fl-color-surface-raised);' +
    'border:var(--fl-border-width) solid var(--fl-color-border);border-radius:var(--fl-radius-sm);' +
    'color:var(--fl-color-text);font-size:var(--fl-text-caption-size);'
  return select
}

function appearanceOption(value: string, label: string, hint: string): HTMLOptionElement {
  const el = document.createElement('option')
  el.value = value
  el.textContent = label
  el.title = hint
  return el
}

function appearanceRow(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement('div')
  row.style.cssText =
    'display:flex;align-items:center;gap:var(--fl-space-sm);margin-top:var(--fl-space-xs);'
  const name = document.createElement('span')
  name.textContent = label
  name.style.cssText = 'flex:1;font-size:var(--fl-text-ui-size);color:var(--fl-color-text);'
  row.append(name, control)
  return row
}

class SettingsView {
  /** The page, handed to the editor as a view — not an overlay any more. */
  #page: HTMLDivElement
  #body: HTMLDivElement
  #open = false
  #editorApi: EditorApi
  /** Which group is showing. Survives a re-render and a tab round-trip. */
  #group: SettingsGroup = 'models'
  /** The Workspaces section — one instance for the page's life (see #render). */
  #workspaces: WorkspaceSettingsSection | null = null
  #tabButtons = new Map<SettingsGroup, HTMLButtonElement>()
  /** Retires the integrations renderer mounted by the last render, if any. */
  #integrationsMount: (() => void) | null = null
  // Monotonic render generation — open() and accounts.onChanged both trigger the
  // async #render, so each render checks it's still the latest before touching the
  // DOM; a superseded one bails, preventing duplicated sections (#308).
  #renderSeq = 0
  /**
   * Unsubscribe for the Appearance selector's theme-change listener (#399).
   *
   * Released in TWO places, because the section has two ends: the next render
   * of it replaces this one (the old selector is gone, and a listener writing
   * into a detached element is the leak), and `close()` drops it when the page
   * stops. It is deliberately NOT called "unsubscribed when the overlay closes"
   * any more — this has not been an overlay since Settings became a tab, and
   * the page element outlives its tab, so nothing else fires.
   */
  #appearanceUnsub: (() => void) | null = null
  /** Live subscription keeping the density selector honest if the value is
   *  ever changed from somewhere else. Held and released exactly like
   *  #appearanceUnsub — same two ends, same reason. */
  #densityUnsub: (() => void) | null = null
  /** The Account section's `auth:changed` subscription — one sign-in state:
   *  a sign-out made elsewhere (a session the share host refused) repaints
   *  the section. Held and released exactly like #appearanceUnsub. */
  #authUnsub: (() => void) | null = null
  // ── Worktree defaults (worktree_settings_ui) ──────────────────────────
  // The store's answer, and what each row is currently showing. The record IS
  // the provenance: a key present is a default this person set, a key absent is
  // Flow's built-in behaviour — read from PRESENCE, never from value equality,
  // so "publish to origin because I said so" and "publish to origin because
  // nobody was ever asked" stay two different states.
  #worktreeDefaults: Partial<WorktreeDefaults> = {}
  #worktreeStates: Record<string, InheritableState> = {}
  #worktreeValidation = new Map<string, FieldValidation | null>()
  /**
   * Defaults taken over on screen but not yet stored — the blank case.
   *
   * "Set my own default" normally stores the value already shown, and a blank
   * one has nothing to store: a blank default reads as absent, so the row would
   * resolve straight back to Flow's built-in and the press would look like it
   * did nothing. A key in here is a row editable as this person's own default,
   * waiting for the first real value; the store is untouched until one arrives.
   */
  #worktreeOwning = new Set<string>()
  #worktreeRows = new Map<string, FieldRow>()

  /**
   * "Git & PR" — commit/push/PR-on-completion, for the currently active
   * project. Plain `flow/.flowconfig` keys, not inheritable settings (there is
   * no app-wide default layer for "should this project push its own commits"),
   * so they read/write straight off `window.flow.flow` rather than through the
   * defaults-layer machinery above. Moved here from the per-project Flow
   * settings overlay (worktree_settings_ui) so this project's git behaviour has
   * one door, beside Publish to / Branch naming / Base branch.
   */
  #gitPrRootPath: string | null = null
  #gitPrValues: FlowSettingsValues = {}
  #gitPrRows = new Map<string, FieldRow>()

  /**
   * A PAGE, NOT A MODAL.
   *
   * Settings was a dialog floating over the app: 560px wide, capped at 76vh,
   * holding a single scrolling column of every decision the app can make. The
   * user asked for "a full dedicated tab page for the configuration instead of
   * just a modal", and the shape follows the same pattern the Tasks board and
   * the Blueprint already use — one element for the life of the window, handed
   * to `editorApi.openView`, idempotent per id, surviving a tab close.
   *
   * IT NO LONGER OWNS THE KEYBOARD, and that is the point of the change rather
   * than a side effect: `markModalOverlay` and the overlay stack existed to
   * stop panel shortcuts and the terminal's autofocus reaching past a modal.
   * A tab is not past anything — ⌘B still toggles the sidebar while it is open,
   * because that is what a tab is. The Integrations overlay it can open is
   * still a modal, and still declares itself one.
   */
  constructor(editorApi: EditorApi) {
    injectSettingsStyles()
    injectFieldRowStyles()
    this.#editorApi = editorApi

    this.#page = document.createElement('div')
    this.#page.className = 'fl-settings-page'

    const nav = document.createElement('div')
    nav.className = 'fl-settings-nav'
    nav.setAttribute('role', 'tablist')
    nav.setAttribute('aria-label', 'Settings sections')
    for (const group of SETTINGS_GROUPS) {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'fl-settings-tab'
      tab.setAttribute('role', 'tab')
      tab.textContent = group.label
      tab.addEventListener('click', () => this.#showGroup(group.key))
      nav.appendChild(tab)
      this.#tabButtons.set(group.key, tab)
    }

    this.#body = document.createElement('div')
    this.#body.className = 'fl-settings-body'

    this.#page.append(nav, this.#body)

    window.flow.accounts.onChanged(() => {
      if (this.#open) void this.#render()
    })

    // A RUNTIME CHANGE RE-GATES THE PROJECT SECTIONS. "This project" and "Model
    // routing" now follow the project's RESOLVED provider (Phase 3), so a change
    // to which runtime runs has to re-run that gating — otherwise a project that
    // just switched runtimes keeps the previous runtime's account picker on
    // screen. `flow:runtime-changed` is the app's existing signal for it,
    // dispatched by the runtime selector in this very view; re-rendering on it
    // covers every source without a bespoke listener per one.
    document.addEventListener('flow:runtime-changed', () => {
      if (this.#open) void this.#render()
    })
  }

  /** Show one group, and mark its tab. */
  #showGroup(group: SettingsGroup): void {
    this.#group = group
    for (const [key, tab] of this.#tabButtons) {
      const active = key === group
      tab.classList.toggle('active', active)
      tab.setAttribute('aria-selected', active ? 'true' : 'false')
    }
    for (const panel of this.#body.querySelectorAll<HTMLElement>('.fl-settings-group')) {
      panel.hidden = panel.dataset.group !== group
    }
    // The Workspaces section re-reads what changed while it was not on screen.
    if (group === 'workspaces') this.#workspaces?.shown()
  }

  async open(group?: SettingsGroup): Promise<void> {
    // #1395 STILL APPLIES, ONE DIRECTION. Settings is a tab now and cannot be
    // drawn under a sibling — but the Flow-settings and Integrations overlays
    // are still modals, and one of them sitting over this page while a person
    // navigates its tabs is a dialog covering the thing it is about.
    closeOtherSettingsOverlays('settings')
    if (group !== undefined) this.#group = group
    this.#open = true
    this.#editorApi.openView({
      id: SETTINGS_TAB_ID,
      label: 'Settings',
      icon: 'settings',
      element: this.#page,
    })
    await this.#render()
  }

  /**
   * Stop what this page has in flight.
   *
   * IT NO LONGER HIDES ANYTHING — a tab is closed from the tab strip, like
   * every other view. What survives is the half that was never about the
   * chrome: an interactive sign-in outlives this DOM, and abandoning it without
   * cancelling holds the single login slot until it times out.
   */
  close(): void {
    this.#open = false
    // #1107: an interactive sign-in outlives this DOM — the child process sits
    // on stdin forever and the orchestrator's single-flight guard never clears,
    // so EVERY later Add account / Re-login dies with "another sign-in is
    // already in progress". Dismissing the overlay abandons the login, so say
    // so out loud: cancel it here (fail-soft — nothing in flight is a no-op).
    if (this.#loginInFlight) {
      this.#loginInFlight = false
      void window.flow.accounts.cancelLogin?.().catch(() => undefined)
    }
    // Same rule for the runtime sign-in (#1107's lesson, one door further
    // along): its child process would otherwise sit waiting on an OAuth that
    // nobody can complete, holding the single login slot for five minutes.
    if (this.#runtimeLogin !== null) {
      this.#runtimeLogin.dispose()
      this.#runtimeLogin = null
      void window.flow.settings.cancelRuntimeLogin?.().catch(() => undefined)
    }
    // The Appearance section's two live subscriptions. A re-render replaces
    // them; nothing but this released them, so a page that opened and stopped
    // left both writing into a selector no longer on screen. They are re-made
    // by the next render, so dropping them here costs the reopened page
    // nothing.
    this.#appearanceUnsub?.()
    this.#appearanceUnsub = null
    this.#densityUnsub?.()
    this.#densityUnsub = null
    this.#authUnsub?.()
    this.#authUnsub = null
  }

  /** True while an accounts add/relogin round-trip is outstanding (#1107). */
  #loginInFlight = false

  /** The in-app runtime sign-in, while one is mounted. */
  #runtimeLogin: RuntimeLoginAssist | null = null

  /** Mark a login as in flight and hand back its settle hook — ONE ownership
   *  path for both the add and re-login flows (pattern #14). */
  #beginLogin(): () => void {
    this.#loginInFlight = true
    return () => {
      this.#loginInFlight = false
    }
  }

  async #render(): Promise<void> {
    const gen = ++this.#renderSeq
    const api = window.flow
    // An older preload has no defaults channel at all; the section simply is
    // not there, and every project resolves exactly as it does today.
    const defaultsRead =
      api.settings.getWorktreeDefaults?.().catch(() => null) ?? Promise.resolve(null)
    const [accounts, activeProject, routing, providerResult, worktreeDefaults] = await Promise.all([
      api.accounts.list(),
      api.project.active().catch(() => null),
      api.settings.getModelRouting().catch(() => DEFAULT_MODEL_ROUTING),
      api.settings.getDefaultProvider().catch(() => ({ provider: null })),
      defaultsRead,
    ])
    // A newer render started while we were fetching — let it own the DOM (#308).
    if (!isLatestRender(gen, this.#renderSeq)) return
    // Build every section into DETACHED group panels; #body is never touched
    // mid-build, so a partial render can't leave duplicated/half sections behind.
    const fragment = document.createDocumentFragment()
    const panels = new Map<SettingsGroup, HTMLElement>()
    for (const group of SETTINGS_GROUPS) {
      const panel = document.createElement('div')
      panel.className = 'fl-settings-group'
      panel.dataset.group = group.key
      panel.setAttribute('role', 'tabpanel')
      panel.setAttribute('aria-label', group.label)
      panels.set(group.key, panel)
      fragment.appendChild(panel)
    }
    const into = (group: SettingsGroup, section: HTMLElement): void => {
      panels.get(group)?.appendChild(section)
    }

    // MODELS OWNS THE ACCOUNTS. Which agent runs is the decision every other
    // setting hangs off, and the Claude logins are that decision's
    // configuration — not a peer of it.
    //
    // EVERY SECTION IN THIS GROUP READS THE SAME ANSWER. Two of them are
    // Claude's — the project's account and the effort→model mapping — and both
    // used to render as though the runtime above them had not been chosen.
    const provider = providerResult.provider ?? 'claude'
    into('models', this.#renderProviderSection(providerResult.provider, accounts))
    // TWO SECTIONS FOLLOW THE PROJECT'S RESOLVED RUNTIME, NOT THE APP-WIDE
    // DEFAULT. "This project" assigns a Claude ACCOUNT; "Model routing" maps
    // effort onto Haiku/Sonnet/Opus — both are Claude's, and both used to gate
    // on the app-wide `provider`. That was the bug: a project pinned to Claude
    // while the app default ran Copilot showed NO account picker, and a project
    // pinned to Copilot showed an Anthropic account list. The provider a project
    // RESOLVES to is the runtime it actually runs, so it is the one these gate
    // on. The read is optional — an older preload without it falls back to the
    // app-wide provider, i.e. exactly today's behaviour.
    let resolved = provider
    if (activeProject) {
      resolved =
        (await api.settings.getProjectProvider?.({ rootPath: activeProject.rootPath }))?.provider ??
        provider
      // A newer render started while we asked the resolver — let it own the DOM
      // (#308); the extra await must not paint over it.
      if (!isLatestRender(gen, this.#renderSeq)) return
    }
    if (activeProject && projectAccountSurface(resolved) === 'claude-picker') {
      const projectSection = await this.#renderProjectSection(
        accounts,
        activeProject.rootPath,
        resolved,
      )
      if (!isLatestRender(gen, this.#renderSeq)) return
      into('models', projectSection)
    } else if (activeProject) {
      // A NON-CLAUDE PROJECT STILL GETS A "This project" BLOCK, the honest one:
      // its runtime keeps a single global sign-in, not a per-project account, so
      // it says that plainly rather than leaving an empty area — an Anthropic
      // account list here would be answering a question this runtime never asks
      // (forbidden-pattern #12).
      into('models', this.#renderProjectRuntimeBlock(activeProject.rootPath, resolved))
    }
    // Routing shows for the runtime the project will actually use; with no
    // project open it stays on the app-wide default, exactly as before.
    const routingProvider = activeProject ? resolved : provider
    if (supportsModelRouting(routingProvider)) {
      into('models', this.#renderModelRoutingSection(routing, routingProvider))
    }

    if (worktreeDefaults !== null && api.settings.setWorktreeDefaults !== undefined) {
      into('worktrees', this.#renderWorktreeDefaultsSection(worktreeDefaults.defaults))
    }

    // THIS PROJECT'S OWN GIT BEHAVIOUR. No project, nothing to configure — same
    // gate as Tasks below, and the same reason: these keys live in a project's
    // own flow/.flowconfig, not in any layer this page can edit with none open.
    if (activeProject) into('worktrees', this.#renderGitPrSection(activeProject.rootPath))

    // WHERE THE WORK COMES FROM. The setting that decides whether the board has
    // a Remote column at all, and the one that had no home after the Loops
    // screen went — a person could connect GitHub and have nothing to point at
    // it.
    if (activeProject) into('tasks', this.#renderTaskListSection(activeProject.rootPath))

    // INTEGRATIONS ARE ACCOUNTS, and every other account in this app is
    // configured here. On the board they were a permanent button about
    // something almost nobody changes twice, beside two controls people press
    // all day.
    into('integrations', this.#renderIntegrationsSection())

    // KEPT ALIVE ACROSS RENDERS, like Flow settings' knowledge section: it
    // repaints itself from the Workspace broadcasts, and an open "Add a
    // project" picker must survive an unrelated account change. An older
    // preload without the Workspaces bridge has no section and no tab.
    if (api.workspaces !== undefined) {
      this.#workspaces ??= new WorkspaceSettingsSection()
      into('workspaces', this.#workspaces.element)
      // Read when SHOWN (#showGroup below), not on every page render — an
      // account change re-renders the page and must not spawn the CLI.
    }

    into('app', this.#renderAppearanceSection())
    into('app', this.#renderUpdatesSection())
    into('app', this.#renderSignInSection())
    into('app', this.#renderPrivacySection())
    into('app', this.#renderGettingStarted())

    // A GROUP WITH NOTHING IN IT LOSES ITS TAB rather than offering an empty
    // page. Two of them are conditional — Tasks needs an open project, and
    // Conversation files needs a preload new enough to have the defaults channel — and
    // a tab that opens onto nothing is a worse answer than no tab.
    for (const group of SETTINGS_GROUPS) {
      const panel = panels.get(group.key)
      const tab = this.#tabButtons.get(group.key)
      if (tab) tab.hidden = panel === undefined || panel.childElementCount === 0
    }
    if (this.#tabButtons.get(this.#group)?.hidden === true) this.#group = 'models'
    // Final guard, then swap in atomically (clears existing children + inserts).
    if (!isLatestRender(gen, this.#renderSeq)) return
    // #1000: ANY account-row action broadcasts accounts:changed, which lands
    // here and replaces the body — silently destroying a half-typed "Add
    // account" name (and the caret). Carry in-progress text across the swap,
    // same capture/restore contract the git panel uses for its commit box.
    const carried = captureSettingsInput(this.#body)
    this.#body.replaceChildren(fragment)
    restoreSettingsInput(this.#body, carried)
    // Re-apply the selection LAST: the panels above are all visible until told
    // otherwise, and a render that forgot this would flash every group at once.
    this.#showGroup(this.#group)
  }

  /**
   * The app-wide defaults — the layer every project falls back to.
   *
   * The same three settings the project panel shows, drawn by the SAME row
   * renderer, because a setting that reads as two different things depending on
   * which screen you opened is two settings. What differs is the layer: here a
   * value is either one this person set (the panel's own, editable) or nothing
   * at all, in which case Flow's built-in behaviour applies and the row says so.
   *
   * NO PROJECT IS READ HERE. This surface has no project — it is reachable with
   * none open — so it never asks the resolver anything and never writes a
   * project's file.
   */
  #renderWorktreeDefaultsSection(defaults: Partial<WorktreeDefaults>): HTMLElement {
    this.#worktreeDefaults = defaults
    this.#worktreeStates = worktreeDefaultsStates(defaults)
    this.#worktreeRows.clear()

    const section = document.createElement('div')
    section.className = 'fl-settings-section'
    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = WORKTREE_DEFAULTS_TITLE
    section.appendChild(heading)

    const hint = document.createElement('div')
    hint.className = 'fl-settings-hint'
    hint.textContent = WORKTREE_DEFAULTS_NOTE
    section.appendChild(hint)

    // Said once, at the top: a default is a starting point, not a decision
    // taken away from a project that has already made its own.
    const override = document.createElement('div')
    override.className = 'fl-settings-hint'
    override.textContent = WORKTREE_DEFAULTS_OVERRIDE_NOTE
    section.appendChild(override)

    for (const field of worktreeFields()) {
      const row = renderFieldRow(fieldDocument(), field, this.#worktreeRowState(field), {
        onChange: (value: FieldValue) => this.#changeWorktreeDefault(field, value),
        onInherit: (useOwnValue: boolean) => this.#setWorktreeDefault(field, useOwnValue),
      })
      // Opt the text controls into the body's carry contract (#1000): ANY
      // account action re-renders this whole overlay, and a half-typed remote
      // or branch name has to survive that the same way the Add-account box
      // does. The keys are this section's own, so they cannot collide.
      row.control.setAttribute(CARRY_KEY_ATTR, `worktree-default:${field.key}`)
      row.companion?.setAttribute(CARRY_KEY_ATTR, `worktree-default:${field.key}:name`)
      this.#worktreeRows.set(field.key, row)
      section.appendChild(asElement(row.row))
    }
    return section
  }

  /** Everything about one defaults row that can change while the panel is open. */
  #worktreeRowState(field: FieldDef): FieldRowState {
    const state = this.#worktreeStates[field.key]
    return {
      value: state?.value ?? '',
      // A default taken over but not yet stored reads as one this person owns
      // — which is what the next keystroke makes it.
      source: this.#worktreeOwning.has(field.key)
        ? ownedEditingSource('global')
        : (state?.source ?? 'default'),
      // The layer this panel WRITES — what makes a `global` value read here as
      // owned and editable rather than as something inherited from elsewhere.
      layer: 'global',
      validation: this.#worktreeValidation.get(field.key) ?? null,
    }
  }

  /**
   * A value typed into a defaults row: validate, then write or refuse.
   *
   * VALIDATED WHERE TYPED, NEVER SANITIZED (allowed-pattern #22), and by the
   * SAME validator the project panel uses — the two surfaces write one grammar,
   * and a value one accepted while the other refused would be a setting nobody
   * could reason about. A refused value stays on screen to be fixed and is not
   * written.
   */
  #changeWorktreeDefault(field: FieldDef, value: FieldValue): void {
    // Taken over and left blank is a default not set: store nothing, and let
    // the row go back to Flow's built-in.
    if (this.#worktreeOwning.has(field.key) && ownedEditAction(value) === 'release') {
      this.#worktreeOwning.delete(field.key)
      this.#worktreeValidation.set(field.key, null)
      this.#patchWorktreeRows()
      return
    }
    const result = validateWorktreeField(field.key, String(value))
    this.#worktreeValidation.set(field.key, 'ok' in result ? null : result)
    if (isRefusal(result)) {
      const source = this.#worktreeStates[field.key]?.source ?? 'global'
      this.#worktreeStates = { ...this.#worktreeStates, [field.key]: { value, source } }
      this.#patchWorktreeRows()
      return
    }
    this.#writeWorktreeDefault(field, fieldConfigString(field, value))
  }

  /**
   * Take a setting over as this person's default, or hand it back to Flow's.
   *
   * THE ONLY PATH TO A REMOVAL on this panel (forbidden-pattern #15): handing
   * one back deletes the stored default, and it happens here and nowhere else —
   * never from a cleared field, never from a write that merely omitted a key.
   * Taking one over writes the value already on screen, which is not a change of
   * value at all: it is a change of who decides it.
   */
  #setWorktreeDefault(field: FieldDef, useOwnValue: boolean): void {
    this.#worktreeValidation.set(field.key, null)
    const shown = this.#worktreeStates[field.key]?.value ?? ''
    // Nothing on screen to store, and nothing stored to remove: both directions
    // of the blank case are local state, not a write (see #worktreeOwning).
    if (useOwnValue && takeOverAction(shown) === 'own') {
      this.#worktreeOwning.add(field.key)
      this.#patchWorktreeRows()
      return
    }
    if (!useOwnValue && this.#worktreeOwning.has(field.key)) {
      this.#worktreeOwning.delete(field.key)
      this.#patchWorktreeRows()
      return
    }
    this.#writeWorktreeDefault(field, useOwnValue ? fieldConfigString(field, shown) : null)
  }

  /** Persist one default (`null` unsets it) and reflect what the store now holds. */
  #writeWorktreeDefault(field: FieldDef, value: string | null): void {
    const setting: WorktreeSettingKey | undefined = field.setting
    const write = window.flow.settings.setWorktreeDefaults
    if (setting === undefined || write === undefined) return
    void write({ patch: { [setting]: value } })
      .then((result) => this.#applyWorktreeDefaults(result.defaults))
      .catch((error: unknown) => {
        console.error('flow: failed to save a worktree default', error)
        // Back to what the store still holds — the row must never sit showing a
        // value that was not written (#1158's rule, one panel further along).
        this.#applyWorktreeDefaults(this.#worktreeDefaults)
        this.#notify(worktreeDefaultSaveFailedToast(field.label, error))
      })
  }

  /** Fold the store's answer in and patch the live rows (never a rebuild). */
  #applyWorktreeDefaults(defaults: Partial<WorktreeDefaults>): void {
    this.#worktreeDefaults = defaults
    this.#worktreeStates = worktreeDefaultsStates(defaults)
    // A claim ends the moment the store says the same thing: the write landed.
    for (const key of [...this.#worktreeOwning]) {
      if (this.#worktreeStates[key]?.source === 'global') this.#worktreeOwning.delete(key)
    }
    this.#patchWorktreeRows()
  }

  /**
   * Reflect the current state onto the live rows without touching DOM identity.
   *
   * PATCHED, NEVER REBUILT (#1032): a rebuild between a field's change event
   * (fired on blur) and the mouseup of the click that caused it eats the next
   * click and any text still being typed — and the control the person is in is
   * never written over.
   */
  #patchWorktreeRows(): void {
    const active: unknown = document.activeElement
    for (const field of worktreeFields()) {
      const row = this.#worktreeRows.get(field.key)
      if (row === undefined) continue
      const keepControlValue =
        active === (row.control as unknown) ||
        (row.companion !== null && active === (row.companion as unknown))
      row.update(this.#worktreeRowState(field), { keepControlValue })
    }
  }

  /**
   * "Git & PR" for the active project — auto-commit per task, auto-push when
   * done, auto-create PR. Reads/writes `flow/.flowconfig` directly via
   * `window.flow.flow`, exactly as the retired per-project overlay did; there
   * is no defaults layer to resolve because these are plain project keys.
   *
   * IT READS ASYNCHRONOUSLY and paints twice, like the Task-list section below:
   * the row is built with whatever `#gitPrValues` already holds (empty on first
   * open), then patched once `flow:state` answers — never blocking every other
   * section on this one read.
   */
  #renderGitPrSection(rootPath: string): HTMLElement {
    this.#gitPrRootPath = rootPath
    this.#gitPrRows.clear()

    const section = document.createElement('div')
    section.className = 'fl-settings-section'
    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = GIT_PR_SECTION_TITLE
    section.appendChild(heading)

    for (const field of gitPrFields()) {
      const row = renderFieldRow(fieldDocument(), field, this.#gitPrRowState(field), {
        onChange: (value: FieldValue) => this.#changeGitPr(rootPath, field, value),
      })
      this.#gitPrRows.set(field.key, row)
      section.appendChild(asElement(row.row))
    }

    void window.flow.flow
      .state({ rootId: rootPath })
      .then((state) => {
        // A newer render (or a project switch) already owns this row set.
        if (this.#gitPrRootPath !== rootPath) return
        this.#gitPrValues = readValues(state.flowconfig)
        this.#patchGitPrRows()
      })
      .catch((error: unknown) => console.warn('flow: failed to load Git & PR settings', error))

    return section
  }

  /** Everything about one Git & PR row that can change while the panel is open. */
  #gitPrRowState(field: FieldDef): FieldRowState {
    return { value: this.#gitPrValues[field.key] ?? false }
  }

  /** Reflect current values onto the live rows without touching DOM identity
   *  (#1032's rule, same as `#patchWorktreeRows`). */
  #patchGitPrRows(): void {
    const active: unknown = document.activeElement
    for (const field of gitPrFields()) {
      const row = this.#gitPrRows.get(field.key)
      if (row === undefined) continue
      const keepControlValue = active === (row.control as unknown)
      row.update(this.#gitPrRowState(field), { keepControlValue })
    }
  }

  /**
   * Apply a Git & PR change: enforce the pr⇒push+commit dependency, diff, and
   * write. Optimistic with rollback on failure (#1158's rule) — a rejected
   * write must not leave a toggle showing a state that was never saved.
   */
  #changeGitPr(rootPath: string, field: FieldDef, value: FieldValue): void {
    const before = this.#gitPrValues
    const after = applyDependencies({ ...before, [field.key]: value }, field.key)
    const updates = toConfigUpdates(before, after)
    this.#gitPrValues = after
    this.#patchGitPrRows()
    if (Object.keys(updates).length === 0) return
    void window.flow.flow.setConfig({ rootId: rootPath, updates }).catch((error: unknown) => {
      console.error('flow: failed to write Git & PR settings', error)
      if (this.#gitPrRootPath === rootPath) {
        this.#gitPrValues = before
        this.#patchGitPrRows()
      }
      this.#notify(worktreeDefaultSaveFailedToast(field.label, error))
    })
  }

  /**
   * "Updates" — a manual Check-for-updates trigger (#update-check-focus). The
   * automatic cadence is launch + focus (throttled) + 6h; this gives certainty
   * on demand. A found update raises the normal update banner — this row only
   * reports the check's outcome.
   */
  #renderUpdatesSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fl-settings-section'
    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = 'Updates'
    section.appendChild(heading)

    const row = document.createElement('div')
    row.className = 'fl-settings-row'
    const status = document.createElement('div')
    status.className = 'fl-settings-add-status'
    status.hidden = true
    const checkBtn = this.#miniButton('Check for updates', () => {
      status.hidden = false
      status.classList.remove('error')
      status.textContent = 'Checking…'
      checkBtn.setAttribute('disabled', '')
      void window.flow.updater
        .check()
        .then((result) => {
          if (result.phase === 'available' || result.phase === 'downloading' || result.phase === 'downloaded') {
            status.textContent = `Update available: v${result.version ?? '?'} — see the banner to install.`
          } else if (result.phase === 'error') {
            status.textContent = result.message ?? 'Update check failed.'
            status.classList.add('error')
          } else {
            status.textContent = "You're on the latest version."
          }
        })
        .catch((error: unknown) => {
          status.textContent = error instanceof Error ? error.message : String(error)
          status.classList.add('error')
        })
        .finally(() => checkBtn.removeAttribute('disabled'))
    })
    row.append(checkBtn)
    section.append(row, status)
    return section
  }

  /**
   * "Task list" — which list this project's work comes from.
   *
   * ONE QUESTION, N WRITES. A project has one list and the store keeps one
   * answer per loop, in each loop's committed directive; the model beside this
   * (task-list-model.ts) says why that is deliberate and what it costs. This
   * performs the writes and reports what actually happened, including the half
   * that did not.
   *
   * IT READS ASYNCHRONOUSLY and paints twice: the section is returned
   * immediately with a "reading" line, then filled in when `loops:read` lands.
   * A settings panel that waited for it would hold every OTHER section back for
   * a subprocess-free file read this one section wanted.
   */
  #renderTaskListSection(rootPath: string): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fl-settings-section'

    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = 'Task list'
    section.appendChild(heading)

    const hint = document.createElement('div')
    hint.className = 'fl-settings-hint'
    hint.textContent =
      'Where the work on this project’s board comes from. A GitHub list also gives the board its Remote column.'
    section.appendChild(hint)

    const summary = document.createElement('div')
    summary.className = 'fl-settings-hint'
    summary.textContent = 'Reading this project’s loops…'
    section.appendChild(summary)

    const row = document.createElement('div')
    row.style.cssText =
      'display:flex;align-items:center;gap:var(--fl-space-sm);margin-top:var(--fl-space-xs);flex-wrap:wrap;'
    const picker = document.createElement('select')
    picker.setAttribute('aria-label', 'Which list this project reads')
    picker.style.cssText =
      'height:24px;padding:0 var(--fl-space-xs);background:var(--fl-color-surface-raised);' +
      'border:var(--fl-border-width) solid var(--fl-color-border);border-radius:var(--fl-radius-sm);' +
      'color:var(--fl-color-text);font-family:var(--fl-font-ui);font-size:var(--fl-text-ui-size);'
    for (const choice of TASK_LIST_CHOICES) {
      const option = document.createElement('option')
      option.value = choice.kind
      option.textContent = choice.label
      picker.appendChild(option)
    }
    // STARTS ON THE LIST THAT NEEDS NOTHING. The read below moves it to whatever
    // the project actually reads; until then, defaulting to GitHub would put an
    // amber "name the repository" under a picker nobody has touched.
    picker.value = 'ledger'
    const repo = document.createElement('input')
    repo.type = 'text'
    repo.className = 'fl-settings-input'
    repo.placeholder = 'acme/widgets'
    repo.setAttribute('aria-label', 'Repository to read')
    repo.style.cssText = 'flex:1;min-width:140px;'
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'fl-settings-inline-btn'
    save.textContent = 'Use this list'
    row.append(picker, repo, save)
    section.appendChild(row)

    const problem = document.createElement('div')
    problem.className = 'fl-settings-hint'
    problem.hidden = true
    problem.style.cssText = 'color:var(--fl-color-warning, #d9a441);'
    section.appendChild(problem)

    let loops: string[] = []
    const choice = (): TaskListChoice => ({
      kind: picker.value === 'github' ? 'github' : 'ledger',
      repo: repo.value,
    })
    const sync = (): void => {
      // NOTHING TO POINT, NOTHING TO SHOW. A project with no loops (or none that
      // could be read) has no list to change, and a live picker over it would
      // be an offer no write can honour — with an amber "name the repository"
      // under it, about a repository nobody asked for.
      row.hidden = loops.length === 0
      // The project's own list carries no location, which is why the box is not
      // shown for it rather than shown empty.
      repo.hidden = picker.value !== 'github'
      const said = loops.length === 0 ? null : taskListProblem(choice())
      problem.textContent = said ?? ''
      problem.hidden = said === null
      save.disabled = said !== null || loops.length === 0
    }
    picker.addEventListener('change', sync)
    repo.addEventListener('input', sync)

    const paint = (state: ReturnType<typeof taskListStateFor>): void => {
      loops = state.loops
      summary.textContent = state.summary
      if (state.agreed !== null) {
        picker.value = state.agreed.kind
        repo.value = state.agreed.repo
      }
      // A disagreement is NAMED, loop by loop — never reconciled behind the
      // reader's back and never reported as whichever answer came first.
      for (const entry of state.disagreement) {
        const line = document.createElement('div')
        line.className = 'fl-settings-hint'
        line.textContent = `${entry.loop} reads ${entry.label}`
        summary.after(line)
      }
      sync()
    }

    void window.flow.loops
      ?.read({ rootId: rootPath })
      .then((snapshot) => paint(taskListStateFor(snapshot)))
      .catch(() => paint(taskListStateFor(null)))

    save.addEventListener('click', () => {
      const api = window.flow.loops
      const setQueue = api?.setDirectiveQueue
      if (setQueue === undefined || loops.length === 0) return
      const asked = choice()
      save.disabled = true
      summary.textContent = 'Changing…'
      const accepted: string[] = []
      const refused: string[] = []
      // ONE WRITE PER LOOP, IN ORDER, and nothing is rolled back: undoing a
      // write that succeeded would be a second write nobody asked for, against
      // a file somebody may since have read.
      void loops
        .reduce(
          (chain, loop) =>
            chain.then(async () => {
              const result = await setQueue({
                rootId: rootPath,
                loop,
                queue: asked.kind,
                ...(asked.kind === 'github' ? { repo: asked.repo.trim() } : {}),
              }).catch(() => ({ ok: false as const, reason: null }))
              ;(result.ok ? accepted : refused).push(loop)
            }),
          Promise.resolve(),
        )
        .then(async () => {
          summary.textContent = taskListOutcome(accepted, refused)
          // Re-read rather than trusting the writes: the directives are the
          // store and this section is a view of them.
          const snapshot = await window.flow.loops?.read({ rootId: rootPath })
          loops = taskListStateFor(snapshot ?? null).loops
          sync()
          // The board is looking at the same files.
          document.dispatchEvent(new CustomEvent('flow:loops-changed'))
        })
    })

    return section
  }

  /**
   * "Integrations" — the trackers themselves, not a door to them.
   *
   * IT WAS A BUTTON THAT OPENED A MODAL, which is a door inside a door: you
   * pressed Integrations in Settings to be shown a dialog over Settings. The
   * user's own instruction was to stop — "don't show that 'manage integrations'
   * when the user click on integrations, show everything there" — so the
   * provider sections render here.
   *
   * MOUNTED, NOT COPIED. `mountIntegrations` is the same renderer the overlay
   * was; one surface owns what a provider needs, what its pill says and what a
   * Connect writes, so a field added for one is a field the other cannot be
   * missing (allowed-pattern #14).
   */
  #renderIntegrationsSection(): HTMLElement {
    // A CONTAINER, NOT A SECTION. The renderer below paints one
    // `.fl-settings-section` per provider, and wrapping those in another one
    // makes every "the Jira section" lookup match twice — the provider's, and
    // this one, which contains the word too.
    const section = document.createElement('div')
    section.className = 'fl-settings-integrations'
    // The previous mount's probes are retired before a new one starts: they
    // shell out to the `gh` / `az` CLIs, and one landing after this render has
    // been replaced would paint into a node that has left the document.
    this.#integrationsMount?.()
    this.#integrationsMount = mountIntegrations(section)
    return section
  }

  /**
   * "Appearance" — the app theme selector (Light / Dark / System). Writes through
   * the theme controller, which stamps <html data-theme>; the whole app, Monaco,
   * and xterm follow that one signal (#399). Reflects live System→OS flips.
   */

  /**
   * "Privacy" — where somebody who already answered goes to change their mind,
   * and where WHAT IS CURRENTLY BEING SENT is shown rather than described.
   *
   * A toggle whose consequences are invisible is a toggle nobody trusts, so the
   * derived disclosure sits under the switch and appears exactly when it is
   * true. The words come from telemetry-disclosure, which derives them from the
   * allowlist — the same source the first-run question reads, so the two
   * surfaces cannot drift into describing one promise two ways.
   *
   * IT READS ASYNCHRONOUSLY and paints twice, the same contract the task-list
   * section above uses: the section returns immediately in its pending state
   * (the switch inert, because a click must not be written against a value that
   * has not loaded) and fills in when the consent lands.
   */
  #renderPrivacySection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fl-settings-section'

    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = 'Privacy'
    section.appendChild(heading)

    const row = document.createElement('label')
    row.className = 'fl-settings-toggle'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.disabled = true
    const label = document.createElement('span')
    row.append(input, label)
    section.appendChild(row)

    const status = document.createElement('div')
    status.className = 'fl-settings-hint'
    section.appendChild(status)

    // What is sent, and what never is. Rebuilt on every paint because the first
    // half appears and disappears with the answer.
    const detail = document.createElement('div')
    detail.className = 'fl-settings-privacy-detail'
    section.appendChild(detail)

    const paint = (consent: boolean | null): void => {
      const copy = privacyCopy(consent)
      label.textContent = copy.toggleLabel
      input.checked = consent === true
      status.textContent = copy.status

      detail.replaceChildren()
      for (const line of copy.sending) {
        const block = document.createElement('div')
        block.className = 'fl-settings-privacy-line'
        const what = document.createElement('span')
        what.className = 'fl-settings-privacy-label'
        what.textContent = line.label
        const which = document.createElement('span')
        which.textContent = line.detail
        block.append(what, which)
        detail.appendChild(block)
      }

      // THE PROMISE IS SHOWN IN EVERY STATE, including while sharing is off.
      // What a person wants to check before turning something on is what it
      // will not do, and a list that appears only once you have agreed is a
      // list you had to agree to read.
      const neverTitle = document.createElement('div')
      neverTitle.className = 'fl-settings-privacy-label'
      neverTitle.textContent = 'Never sent, whatever this is set to'
      const never = document.createElement('ul')
      never.className = 'fl-settings-privacy-never'
      for (const item of copy.never) {
        const li = document.createElement('li')
        li.textContent = item
        never.appendChild(li)
      }
      detail.append(neverTitle, never)
    }

    // The pending paint: the promise and the label are true before anything is
    // read, so the section is never blank. Only the switch waits.
    paint(null)
    input.disabled = true

    void window.flow.settings
      .getTelemetryConsent()
      .then((consent) => {
        input.disabled = false
        paint(consent ?? null)
      })
      .catch((error: unknown) => {
        console.error('flow: getTelemetryConsent failed', error)
        // LEFT INERT AND SAID SO. A switch that reads as "off" when the answer
        // could not be read is the app asserting a choice nobody made.
        status.textContent =
          "Flow couldn't read this setting, so it can't be changed here right now."
      })

    input.addEventListener('change', () => {
      const next = input.checked
      input.disabled = true
      void window.flow.settings
        .setTelemetryConsent({ agreed: next })
        .then(() => {
          input.disabled = false
          paint(next)
        })
        .catch((error: unknown) => {
          console.error('flow: setTelemetryConsent failed', error)
          input.disabled = false
          input.checked = !next // revert
          paint(!next)
          this.#notify(telemetryConsentSaveFailedToast(next, error))
        })
    })

    return section
  }

  /**
   * "Account" — who you are signed in to Flow as.
   *
   * DISPLAY ONLY. This section draws a name and offers two buttons; nothing in
   * the app behaves differently for what it shows, and
   * `identity-is-not-a-gate.test.ts` fails the build if that ever stops being
   * true. Identity says who somebody is, never what they may have.
   *
   * It follows the ACCOUNT ROW patterns already here — `#miniButton`, the
   * status line, an inline confirm rather than a one-click sign-out — because a
   * second visual language for the same idea is how a settings page stops
   * looking like one thing.
   *
   * Reads asynchronously and paints twice, like the task-list section: returned
   * immediately with a reading line, filled in when the channels answer.
   */
  #renderSignInSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fl-settings-section'
    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = 'Account'
    section.appendChild(heading)

    const hint = document.createElement('div')
    hint.className = 'fl-settings-hint'
    hint.textContent = 'Reading…'
    section.appendChild(hint)

    const row = document.createElement('div')
    row.className = 'fl-settings-row'
    section.appendChild(row)

    const status = document.createElement('div')
    status.className = 'fl-settings-add-status'
    status.hidden = true
    section.appendChild(status)

    const paint = (state: SignInState): void => {
      const copy = signInCopy(state)
      hint.textContent = copy.hint
      row.replaceChildren()
      if (copy.who !== null) {
        const who = document.createElement('div')
        who.className = 'fl-settings-account-identity'
        who.textContent = copy.who
        row.appendChild(who)
      }
      if (copy.action === null) return

      if (state.kind === 'signed-in') {
        const out = this.#miniButton(copy.action, () => {
          // AN INLINE CONFIRM, never a one-click — the same courtesy the
          // account rows give a removal.
          out.hidden = true
          const confirm = document.createElement('div')
          confirm.className = 'fl-settings-confirm'
          const asks = document.createElement('span')
          asks.textContent = 'Sign out on this computer?'
          const cancel = this.#miniButton('Cancel', () => {
            confirm.remove()
            out.hidden = false
          })
          const yes = this.#miniButton(
            'Sign out',
            () => {
              confirm.remove()
              void window.flow.settings
                .signOut()
                .then((report) => {
                  // IT SAYS WHAT IT DID — "removed" and "there was nothing"
                  // are different facts, and main already distinguishes them.
                  status.hidden = false
                  status.textContent = report.detail
                  void refresh()
                })
                .catch(() => {
                  status.hidden = false
                  status.classList.add('error')
                  status.textContent = "Flow couldn't sign you out just now."
                  out.hidden = false
                })
            },
            true,
          )
          confirm.append(asks, cancel, yes)
          row.appendChild(confirm)
        }, true)
        row.appendChild(out)
        return
      }

      const inBtn = this.#miniButton(copy.action, () => {
        inBtn.setAttribute('disabled', '')
        inBtn.textContent = 'Opening browser…'
        status.hidden = false
        status.classList.remove('error')
        status.textContent = 'Finish signing in in your browser, then come back.'
        void window.flow.settings
          .signIn()
          .then((result) => {
            if (result.ok) {
              status.textContent = ''
              status.hidden = true
            } else {
              status.classList.add('error')
              status.textContent = result.reason
            }
            void refresh()
          })
          .catch(() => {
            status.classList.add('error')
            status.textContent = "The sign-in didn't complete. You can try again."
            void refresh()
          })
      })
      row.appendChild(inBtn)
    }

    const refresh = async (): Promise<void> => {
      try {
        const settings = window.flow.settings
        if (settings.whoAmI === undefined || settings.authAvailable === undefined) {
          paint({ kind: 'unavailable' })
          return
        }
        const [available, identity] = await Promise.all([
          settings.authAvailable(),
          settings.whoAmI(),
        ])
        paint(signInStateFrom(available, identity))
      } catch {
        // Not knowing reads as unavailable, which offers nothing and promises
        // nothing — the safe shape for a section nobody needs.
        paint({ kind: 'unavailable' })
      }
    }
    // ONE SIGN-IN STATE: when main signs somebody out because a session was
    // refused (or anything else signs in or out), re-read who is signed in —
    // never keep showing a name whose sign-in no longer works.
    this.#authUnsub?.()
    this.#authUnsub = window.flow.settings.onAuthChanged?.(() => void refresh()) ?? null
    void refresh()
    return section
  }

  #renderAppearanceSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fl-settings-section'

    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = 'Appearance'
    section.appendChild(heading)

    const hint = document.createElement('div')
    hint.className = 'fl-settings-hint'
    hint.textContent = 'Theme for the whole app — chrome, editor, and terminal.'
    section.appendChild(hint)

    const themeSelect = appearanceSelect('App theme')
    for (const option of THEME_MODE_OPTIONS) {
      themeSelect.appendChild(appearanceOption(option.mode, option.label, option.hint))
    }
    themeSelect.value = getThemeMode()
    themeSelect.addEventListener('change', () => {
      if (isThemeMode(themeSelect.value)) setThemeMode(themeSelect.value)
    })
    // Reflect a live System→OS flip (mode unchanged, but keep the selector honest if
    // the mode is ever changed elsewhere). Released by the next render of this
    // section, which is what replaces the selector it writes into, and by close().
    const off = onThemeChanged((_effective, mode) => {
      themeSelect.value = mode
    })
    this.#appearanceUnsub?.()
    this.#appearanceUnsub = off
    section.appendChild(appearanceRow('Theme', themeSelect))

    // Conversation density (plan_chat-feed-signal_v1, Q-1). It lives here, with
    // the theme, because it is the same KIND of setting: a per-user reading
    // preference for the whole app. Putting it in a project's flow/.flowconfig
    // would make a person reading two projects set it twice, and would commit
    // one reader's choice to the team's repository.
    const densitySelect = appearanceSelect('Conversation density')
    for (const option of FEED_DENSITY_OPTIONS) {
      densitySelect.appendChild(appearanceOption(option.density, option.label, option.hint))
    }
    densitySelect.value = getFeedDensity()
    densitySelect.addEventListener('change', () => {
      if (isFeedDensity(densitySelect.value)) setFeedDensity(densitySelect.value)
    })
    const offDensity = onFeedDensityChanged((density) => {
      densitySelect.value = density
    })
    this.#densityUnsub?.()
    this.#densityUnsub = offDensity
    section.appendChild(appearanceRow('Conversation', densitySelect))

    const densityHint = document.createElement('div')
    densityHint.className = 'fl-settings-hint'
    // Say what the reader gets, and say the escape hatch is real — Detailed is
    // the identity projection, not a looser fold (C-2 / FR-7).
    densityHint.textContent =
      'How much of a turn the conversation folds away. Detailed shows every tool call.'
    section.appendChild(densityHint)

    return section
  }

  /**
   * "Model routing (Auto)" — when a thread's model is Auto, its model is chosen
   * from its effort via this editable map (#129). Suggested defaults ship; the
   * user edits and it saves immediately.
   */
  /** Model settings — the agent RUNTIME new threads use (multi_runtime_support).
   *  A per-project flow/.flowconfig `provider` overrides this app-wide default. */
  /**
   * Model settings — WHICH runtime runs, and that runtime's own configuration.
   *
   * THE ACCOUNTS LIVE HERE NOW, and only under Claude. "Claude accounts" was a
   * top-level section, which said the logins were a peer of the runtime choice
   * rather than a consequence of it — so a project running Codex still opened
   * Settings to a list of Anthropic logins that had nothing to do with it. They
   * are the Claude runtime's configuration, they appear when Claude is
   * selected, and they go when it is not.
   *
   * The other two runtimes get the honest equivalent: nothing to configure
   * here, because their auth is their own CLI's and Flow never sees it.
   */
  #renderProviderSection(
    currentProvider: string | null,
    accounts: AccountSummary[],
  ): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fl-settings-section'

    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = 'Model settings'
    section.appendChild(heading)

    const hint = document.createElement('div')
    hint.className = 'fl-settings-hint'
    hint.textContent =
      'The agent runtime new threads use. A project can pick its own in its Flow settings.'
    section.appendChild(hint)

    const row = document.createElement('div')
    row.style.cssText =
      'display:flex;align-items:center;gap:var(--fl-space-sm);margin-top:var(--fl-space-xs);'
    const name = document.createElement('span')
    name.textContent = 'Runtime'
    name.style.cssText = 'flex:1;font-size:var(--fl-text-ui-size);color:var(--fl-color-text);'
    const select = document.createElement('select')
    select.setAttribute('aria-label', 'Default agent runtime')
    select.style.cssText =
      'height:24px;padding:0 var(--fl-space-xs);background:var(--fl-color-surface-raised);' +
      'border:var(--fl-border-width) solid var(--fl-color-border);border-radius:var(--fl-radius-sm);' +
      'color:var(--fl-color-text);font-size:var(--fl-text-caption-size);'
    const PROVIDER_OPTIONS: ReadonlyArray<{ value: string; label: string; hint: string }> = [
      { value: 'claude', label: 'Claude (Anthropic)', hint: 'The default — the Claude Agent SDK.' },
      { value: 'codex', label: 'Codex (OpenAI)', hint: 'Runs the codex CLI (must be installed and signed in).' },
      {
        value: 'copilot',
        label: 'GitHub Copilot',
        hint: 'The GitHub Copilot coding agent — signs in with your GitHub account.',
      },
    ]
    for (const option of PROVIDER_OPTIONS) {
      const el = document.createElement('option')
      el.value = option.value
      el.textContent = option.label
      el.title = option.hint
      select.appendChild(el)
    }
    let lastSaved = currentProvider ?? 'claude'
    select.value = lastSaved

    // The chosen runtime's own configuration, swapped in place — no full
    // re-render, so nothing else on the screen (a half-typed account name, the
    // scroll position) is disturbed by picking a runtime.
    const config = document.createElement('div')
    config.className = 'fl-settings-runtime-config'
    const paintConfig = (provider: string): void => {
      config.textContent = ''
      // Titled, for the same reason: this block is the SAVED runtime's, and it
      // is often on screen beside another runtime's refusal.
      const title = document.createElement('div')
      title.className = 'fl-settings-subheading'
      title.textContent = runtimeName(provider)
      config.appendChild(title)
      config.appendChild(
        provider === 'claude'
          ? this.#renderAccountsBlock(accounts)
          : this.#renderExternalRuntimeNote(provider),
      )
      // …and for an external runtime, the same requirement rows the refusal
      // shows. A person looking at the runtime they ALREADY chose gets the
      // same answer and the same buttons as one who has just picked it — the
      // panel used to end at a paragraph saying "there is nothing to add
      // here", under a Sign in that exists two lines further up.
      if (provider !== 'claude') {
        const status = document.createElement('div')
        config.appendChild(status)
        void this.#checkRuntimeReady(provider).then((answer) => {
          if (!status.isConnected) return
          status.replaceChildren(
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- defined below in the same closure
            requirementRows(provider, answer, () => paintConfig(provider)),
          )
        })
        // WHICH MODEL. Codex reported it was running gpt-5-mini and the
        // composer offered no way to change it: the picker had one entry
        // (Auto) because neither CLI can list what an account may use. It
        // cannot be discovered, so it is remembered — the model the runtime's
        // own config already names, plus the ids the user adds here.
        config.appendChild(this.#renderRuntimeModels(provider))
      }
    }
    paintConfig(lastSaved)

    // The refusal, when a runtime cannot be selected. Above the configuration
    // block, because it is about the choice rather than about the settings of a
    // choice that did not take.
    const refusal = document.createElement('div')
    refusal.className = 'fl-settings-refusal'
    refusal.hidden = true
    const refusalText = document.createElement('div')
    const refusalActions = document.createElement('div')
    refusalActions.className = 'fl-settings-refusal-actions'
    refusal.append(refusalText, refusalActions)

    /** A small settings button — the only kind this list makes. */
    const inlineButton = (label: string, onClick: () => void): HTMLButtonElement => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fl-settings-inline-btn'
      button.textContent = label
      button.addEventListener('click', onClick)
      return button
    }

    /**
     * What this runtime needs, and the one press that provides each — the
     * single builder BOTH places use.
     *
     * Two places, because they are the same question: the refusal after a
     * switch Flow would not save, and the block under the runtime already
     * chosen. That second one used to end at a paragraph — "signs in through
     * its own command-line tool, so there is nothing to add here" — which was
     * written before Flow could sign in for you, and read as a flat no to
     * somebody who knew perfectly well that OAuth was possible.
     *
     * What the CLI actually said never appears. Relaying it produced "Flow
     * could not confirm that Codex is signed in — Error loading configuration:
     * unknown variant `xhigh`…", asking the reader to debug a file they did not
     * open to answer a question they asked with a dropdown.
     */
    const requirementRows = (
      provider: string,
      answer: RuntimeAuthAnswer,
      onChanged: () => void,
      onOverride?: () => void,
    ): HTMLElement => {
      const host = document.createElement('div')

      const startInstall = (): void => {
        const confirm = installConfirm(provider)
        const question = document.createElement('div')
        question.textContent = `${confirm.question} ${confirm.detail}`
        const actions = document.createElement('div')
        actions.className = 'fl-settings-refusal-actions'
        const run = (): void => {
          const install = window.flow.settings.installRuntime
          if (typeof install !== 'function') {
            question.textContent = `This build of Flow cannot install ${runtimeName(provider)}.`
            actions.replaceChildren()
            return
          }
          question.textContent = installingMessage(provider)
          actions.replaceChildren()
          void install({ provider })
            .then((result) => {
              // Installed is not signed in — re-ask, and let the rows say what
              // is left rather than assuming it is nothing.
              if (result.ok) onChanged()
              else {
                question.textContent = `${runtimeName(provider)} could not be installed.`
                actions.replaceChildren(inlineButton('Try again', startInstall))
              }
            })
            .catch(() => {
              question.textContent = `${runtimeName(provider)} could not be installed.`
              actions.replaceChildren(inlineButton('Try again', startInstall))
            })
        }
        actions.append(inlineButton(confirm.accept, run), inlineButton('Not now', onChanged))
        host.replaceChildren(question, actions)
      }

      /** Ask, then run the runtime's own logout. */
      const confirmSignOut = (
        into: HTMLElement,
        target: string,
        after: () => void,
      ): void => {
        const question = document.createElement('div')
        question.textContent = signOutConfirm(target)
        const actions = document.createElement('div')
        actions.className = 'fl-settings-refusal-actions'
        const go = inlineButton(`Sign out of ${runtimeName(target)}`, () => {
          const run = window.flow.settings.signOutRuntime
          if (typeof run !== 'function') {
            question.textContent = `This build of Flow cannot sign out of ${runtimeName(target)}.`
            actions.replaceChildren()
            return
          }
          question.textContent = `Signing out of ${runtimeName(target)}…`
          actions.replaceChildren()
          void run({ provider: target })
            .then((result) => {
              // Re-ask either way: the requirement rows are the answer, and
              // they come from the runtime's own state, not from this press.
              if (result.ok) after()
              else {
                question.textContent = `${runtimeName(target)} could not be signed out.`
                actions.replaceChildren(inlineButton('Back', after))
              }
            })
            .catch(() => {
              question.textContent = `${runtimeName(target)} could not be signed out.`
              actions.replaceChildren(inlineButton('Back', after))
            })
        })
        actions.append(go, inlineButton('Cancel', after))
        into.replaceChildren(question, actions)
      }

      const startSignIn = (): void => {
        const slot = document.createElement('div')
        host.replaceChildren(slot)
        this.#runtimeLogin?.dispose()
        this.#runtimeLogin = mountRuntimeLoginAssist(slot, provider, {
          onFinished: (ok) => {
            if (ok) onChanged()
          },
        })
      }

      const list = document.createElement('div')
      list.className = 'fl-settings-requirements'
      for (const requirement of runtimeRequirements(answer)) {
        const row = document.createElement('div')
        row.className = 'fl-settings-requirement'
        const mark = document.createElement('span')
        mark.textContent = requirement.met ? '✓' : '○'
        mark.className = requirement.met ? 'fl-settings-status-ok' : 'fl-settings-status-out'
        const label = document.createElement('span')
        label.textContent =
          requirement.met && requirement.key === 'signed-in' && answer.detail.length > 0
            ? `${requirement.label} — ${answer.detail}`
            : requirement.label
        row.append(mark, label)
        if (!requirement.met && requirement.action === 'install') {
          row.appendChild(inlineButton(`Install ${runtimeName(provider)}`, startInstall))
        }
        if (!requirement.met && requirement.action === 'sign-in' && canSignInHere(provider)) {
          row.appendChild(inlineButton(`Sign in to ${runtimeName(provider)}`, startSignIn))
        }
        // AND A WAY BACK OUT. Flow starts these sign-ins, so it has to be able
        // to end one — an account you cannot leave is not an account you chose.
        if (requirement.met && requirement.key === 'signed-in' && canSignOutHere(provider)) {
          row.appendChild(inlineButton('Sign out', () => confirmSignOut(host, provider, onChanged)))
        }
        list.appendChild(row)
      }
      host.appendChild(list)

      const trailing = document.createElement('div')
      trailing.className = 'fl-settings-refusal-actions'
      // "COULD NOT TELL" IS NOT "NOT SIGNED IN". A tool that failed for its own
      // reasons has not said the user is logged out, and refusing outright
      // would trap somebody who is signed in behind a question never asked.
      if (onOverride !== undefined && signInUnconfirmed(answer)) {
        trailing.appendChild(inlineButton(`Use ${runtimeName(provider)} anyway`, onOverride))
      }
      trailing.appendChild(inlineButton('Check again', onChanged))
      host.appendChild(trailing)
      return host
    }

    /** Show the requirements as a refusal: the switch was not saved. */
    const showRequirements = (provider: string, answer: RuntimeAuthAnswer): void => {
      refusal.setAttribute('role', 'alert')
      // WHOSE STATE IS THIS, AND WHAT AM I RUNNING? The refusal sits directly
      // above the CURRENT runtime's configuration, so the screen carries two
      // runtimes at once: a person who clicked Copilot and was refused saw
      // Copilot's missing sign-in stacked on Codex's accounts and models, with
      // nothing saying which was which or that the switch had not taken.
      refusalText.replaceChildren()
      const heading = document.createElement('div')
      heading.textContent = `${runtimeName(provider)} needs:`
      refusalText.appendChild(heading)
      if (provider !== lastSaved) {
        const staying = document.createElement('div')
        staying.className = 'fl-settings-hint'
        staying.textContent = `Not switched — new threads still run on ${runtimeName(lastSaved)}.`
        refusalText.appendChild(staying)
      }
      const recheck = (): void => {
        select.value = provider
        select.dispatchEvent(new Event('change'))
      }
      refusalActions.replaceChildren(
        requirementRows(provider, answer, recheck, () => {
          refusal.hidden = true
          select.value = provider
          paintConfig(provider)
          void window.flow.settings
            .setDefaultProvider({ provider })
            .then(() => {
              lastSaved = provider
              document.dispatchEvent(new CustomEvent('flow:runtime-changed'))
            })
            .catch(() => {
              select.value = lastSaved
              paintConfig(lastSaved)
            })
        }),
      )
      refusal.hidden = false
    }

    select.addEventListener('change', () => {
      const chosen = select.value
      if (chosen === lastSaved) return
      // SAY THAT SOMETHING IS HAPPENING. The check spawns the runtime's own
      // CLI, and how long that takes is the machine's business, not ours — on a
      // busy one it is long enough to read as a frozen control. A disabled
      // selector with no words is indistinguishable from a hung app; the
      // onboarding step has said "Checking …" from the start and this did not.
      refusal.removeAttribute('role')
      refusalText.textContent = `Checking ${runtimeName(chosen)}…`
      refusalActions.textContent = ''
      refusal.hidden = false
      // CHECKED BEFORE IT IS SAVED. A runtime nobody has signed into is a
      // runtime that fails at the FIRST TURN — minutes later, in a CLI's
      // stderr, on a thread the person had already started thinking about. The
      // selector is disabled while the check runs so a second change cannot
      // race the first's verdict.
      select.disabled = true
      void this.#checkRuntimeReady(chosen)
        .then((answer) => {
          if (!requirementsMet(runtimeRequirements(answer))) {
            // NOT SAVED, and put back — the app must not hold a default it has
            // just been told will not run. What is missing, and the press that
            // provides it, is the whole message.
            select.value = lastSaved
            showRequirements(chosen, answer)
            return
          }
          refusal.hidden = true
          paintConfig(chosen)
          return window.flow.settings
            .setDefaultProvider({ provider: chosen })
            .then(() => {
              lastSaved = chosen
            })
            .catch(() => {
              // Revert BOTH halves on a failed save — a selector showing one
              // runtime over another's configuration is worse than either.
              select.value = lastSaved
              paintConfig(lastSaved)
              refusalText.textContent = 'That could not be saved. Try again.'
              refusalActions.textContent = ''
              refusal.hidden = false
            })
        })
        .finally(() => {
          select.disabled = false
        })
    })

    row.append(name, select)
    section.append(row, refusal, config)
    return section
  }

  /**
   * Ask main whether a runtime is usable, and turn that into a verdict.
   *
   * FAIL-CLOSED ON EVERY UNCERTAINTY — an older preload with no check, a probe
   * that threw, a CLI that answered something unreadable. The alternative is
   * saving a default the app has just failed to verify, which is exactly the
   * state this gate exists to prevent.
   */
  async #checkRuntimeReady(provider: string): Promise<RuntimeAuthAnswer> {
    const check = window.flow.settings.checkRuntimeAuth
    if (typeof check !== 'function') return noCheckAnswer(provider)
    try {
      return await check({ provider })
    } catch {
      return noCheckAnswer(provider)
    }
  }

  /**
   * What a non-Claude runtime has to say about its own setup: nothing to
   * configure, and where its credentials actually live.
   *
   * SAID, NOT LEFT BLANK. An empty area under a runtime the reader just picked
   * reads as a screen that failed to load — and the honest fact (Flow never
   * sees these credentials; the CLI owns them) is exactly what somebody
   * wondering where to sign in needs.
   */
  /**
   * "Models" for an external runtime — the picker's contents, editable.
   *
   * Flow cannot enumerate them (no subcommand, no file, and the set differs by
   * plan), so this is the honest alternative to a menu of guesses: the model
   * the runtime's own config names is offered ready to add, and anything else
   * the person knows their account has, they type once and keep.
   */
  #renderRuntimeModels(provider: string): HTMLElement {
    const block = document.createElement('div')
    block.className = 'fl-settings-subsection'
    const heading = document.createElement('div')
    heading.className = 'fl-settings-subheading'
    heading.textContent = 'Models'
    const hint = document.createElement('div')
    hint.className = 'fl-settings-hint'
    hint.textContent = `Models you can pick for a thread. ${runtimeName(provider)} chooses for itself under Auto.`
    block.append(heading, hint)

    const list = document.createElement('div')
    list.className = 'fl-settings-requirements'
    block.appendChild(list)

    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:var(--fl-space-xs);margin-top:var(--fl-space-xs);'
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'fl-settings-input'
    input.placeholder = 'Model id'
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'fl-settings-inline-btn'
    add.textContent = 'Add'
    row.append(input, add)
    block.appendChild(row)

    const save = (models: string[]): void => {
      void window.flow.settings
        .setRuntimeModels?.({ provider, models })
        .then(() => {
          document.dispatchEvent(new CustomEvent('flow:runtime-changed'))
          paint()
        })
        .catch(() => undefined)
    }

    // Tokens → a short label: `1M`, `128K`. Used for the catalogue provenance
    // note and the Default/Max control's size hint.
    const formatTokens = (tokens: number): string =>
      tokens >= 1_000_000
        ? `${Math.round(tokens / 100_000) / 10}M`.replace('.0M', 'M')
        : `${Math.round(tokens / 1_000)}K`

    let saved: string[] = []
    const paint = (): void => {
      void window.flow.settings
        .getRuntimeModels?.({ provider })
        .then((result) => {
          if (!list.isConnected || result === undefined) return
          saved = result.models
          // The live catalogue's context windows, keyed by id (#1929) — the
          // input to both the "context window" hint and the Default/Max control.
          const windowById = new Map<string, number>()
          const catalogIds = new Set<string>()
          for (const entry of result.catalog ?? []) {
            catalogIds.add(entry.id)
            if (entry.contextWindowTokens !== undefined) {
              windowById.set(entry.id, entry.contextWindowTokens)
            }
          }
          const contextPrefs = result.contextPreferences ?? {}
          list.replaceChildren()
          for (const model of saved) {
            const entry = document.createElement('div')
            entry.className = 'fl-settings-requirement'
            const name = document.createElement('span')
            name.textContent = model
            entry.appendChild(name)
            // The context-window choice (#1929). Shown for EVERY pinned Copilot
            // model, NOT gated on the live catalogue — the catalogue fetch needs
            // a working token + matching schema and often returns nothing, and a
            // control that only appears when a network call succeeds reads as a
            // control that is simply missing. The catalogue's window size is used
            // as enrichment when present (the `Max (1M)` label), never as the gate.
            //
            // WHY IT DOES NOT REACH THE TURN YET: the headless `copilot -p` CLI
            // has no context-window flag and the extended tier is an interactive
            // prompt (github/copilot-cli #700/#236 are open), so the choice is
            // remembered and shown rather than sent as a flag that would fail the
            // turn. When Copilot exposes a lever — or a distinct 1M model id in
            // the catalogue — this is where it wires in.
            if (provider === 'copilot') {
              entry.appendChild(
                this.#renderContextChoice(
                  provider,
                  model,
                  windowById.get(model),
                  contextPrefs[model] ?? 'default',
                  paint,
                ),
              )
            }
            const remove = document.createElement('button')
            remove.type = 'button'
            remove.className = 'fl-settings-inline-btn'
            remove.textContent = 'Remove'
            remove.addEventListener('click', () => save(saved.filter((m) => m !== model)))
            entry.appendChild(remove)
            list.appendChild(entry)
          }
          // TWO KINDS OF SUGGESTION, AND THE DIFFERENCE IS SAID OUT LOUD.
          // `suggested` is evidence — this runtime's own config, its sessions,
          // or a turn Flow watched it run. `candidates` are ids that plan
          // commonly offers, which this account may not have; a plan that
          // lacks one refuses it, and that refusal is visible now.
          const offer = (model: string, why: string): void => {
            const suggestion = document.createElement('div')
            suggestion.className = 'fl-settings-requirement'
            const name = document.createElement('span')
            name.textContent = model
            const note = document.createElement('span')
            note.className = 'fl-settings-hint'
            note.textContent = why
            const addIt = document.createElement('button')
            addIt.type = 'button'
            addIt.className = 'fl-settings-inline-btn'
            addIt.textContent = 'Add'
            addIt.addEventListener('click', () => save([...saved, model]))
            suggestion.append(name, note, addIt)
            list.appendChild(suggestion)
          }
          // A suggestion from the catalogue is a model the runtime offers (its
          // context window shown when the live fetch knew one); anything else in
          // `suggested` is a model Flow actually WATCHED run (#1929).
          for (const model of result.suggested) {
            const ctxWindow = windowById.get(model)
            if (ctxWindow !== undefined) {
              offer(model, `on your ${runtimeName(provider)} plan · ${formatTokens(ctxWindow)} context`)
            } else if (catalogIds.has(model)) {
              offer(model, `on your ${runtimeName(provider)} plan`)
            } else {
              offer(model, `${runtimeName(provider)} has used this`)
            }
          }
          for (const model of result.candidates ?? []) {
            offer(model, 'often available — add it to try')
          }
          if (list.childElementCount === 0) {
            const empty = document.createElement('div')
            empty.className = 'fl-settings-hint'
            empty.textContent = 'No models added — threads run on whatever this runtime picks.'
            list.appendChild(empty)
          }
        })
        .catch(() => undefined)
    }

    const addTyped = (): void => {
      const value = input.value.trim()
      if (value.length === 0) return
      input.value = ''
      save([...saved, value])
    }
    add.addEventListener('click', addTyped)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addTyped()
    })
    paint()
    return block
  }

  /**
   * The context-window choice for one model (#1929): Default, or the extended
   * (e.g. 1M) window the catalogue says it supports. Two small buttons, the
   * active one marked; picking one saves it and repaints.
   *
   * The title spells out the honest limit — the choice is remembered and shown,
   * but the headless CLI has no lever to force the extended tier yet (see the
   * caller). So this reads as a preference, not a switch that silently does
   * nothing.
   */
  #renderContextChoice(
    provider: string,
    model: string,
    windowTokens: number | undefined,
    current: RuntimeContextChoice,
    repaint: () => void,
  ): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'fl-settings-hint'
    wrap.style.cssText = 'display:inline-flex;gap:var(--fl-space-xxs);align-items:center;'
    // Prefix the pair so the row reads "Context: [Default] [Max]".
    const caption = document.createElement('span')
    caption.textContent = 'Context:'
    wrap.appendChild(caption)
    // The size rides on the Max label only when the catalogue told us one —
    // `Max (1M)` when known, plain `Max` otherwise. Never invent a number.
    const maxLabel =
      windowTokens === undefined
        ? 'Max'
        : windowTokens >= 1_000_000
          ? `Max (${Math.round(windowTokens / 100_000) / 10}M)`.replace('.0M', 'M')
          : `Max (${Math.round(windowTokens / 1_000)}K)`
    wrap.title = `GitHub Copilot applies the extended context in its own session; Flow remembers your choice and passes it through once the CLI accepts one.`
    const make = (choice: RuntimeContextChoice, text: string): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'fl-settings-inline-btn'
      btn.textContent = text
      if (choice === current) btn.setAttribute('aria-pressed', 'true')
      btn.disabled = choice === current
      btn.addEventListener('click', () => {
        void window.flow.settings
          .setModelContext?.({ provider, model, context: choice })
          .then(() => repaint())
          .catch(() => undefined)
      })
      return btn
    }
    wrap.append(make('default', 'Default'), make('max', maxLabel))
    return wrap
  }

  #renderExternalRuntimeNote(provider: string): HTMLElement {
    const note = document.createElement('div')
    note.className = 'fl-settings-hint'
    const name = runtimeName(provider)
    // WHAT IT IS, not what cannot be done here. The sentence this replaced —
    // "signs in through its own command-line tool, so there is nothing to add
    // here" — was written before Flow could run that sign-in, and stayed on
    // screen above a Sign in button, telling the reader the opposite.
    note.textContent =
      `New threads here run on ${name}. Flow starts its sign-in for you; the credentials stay with ${name}. ` +
      // Say where they went, so a hidden section reads as scoped rather than
      // deleted — switching back to Claude has to look reversible.
      `Claude accounts and model routing come back when Claude is selected.`
    return note
  }

  #renderModelRoutingSection(routing: ModelRouting, provider = 'claude'): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fl-settings-section'

    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = 'Model routing (Auto)'
    section.appendChild(heading)

    const hint = document.createElement('div')
    hint.className = 'fl-settings-hint'
    hint.textContent =
      'When a thread’s model is “Auto”, its model is picked from the thread’s effort. Pinning a specific model on a thread overrides this.'
    section.appendChild(hint)

    // HAIKU / SONNET / OPUS ARE CLAUDE'S NAMES. Under another runtime this
    // mapping is not what a thread will use — that runtime maps the effort TIER
    // to its own model — so the section says whose it is and stops offering to
    // change something that would not take effect. The stored mapping is kept
    // untouched, ready for the next Claude thread.
    const claudeNote = claudeOnlyNote(provider, 'routing')
    if (claudeNote !== null) {
      const note = document.createElement('div')
      note.className = 'fl-settings-hint fl-settings-scoped'
      note.textContent = claudeNote
      section.appendChild(note)
    }

    const current: ModelRouting = { ...routing }
    // DERIVED, NOT RESTATED. This was a third copy of the same three names, and
    // a model added to the picker would have been offered by a control that
    // then refused to save it (`isRoutableModel` guards the write).
    const MODELS: ReadonlyArray<{ value: RoutableModel; label: string }> = ROUTABLE_MODELS.map(
      (value) => ({ value, label: modelLabel(value) }),
    )
    const EFFORTS: ReadonlyArray<{ key: EffortLevel; label: string }> = [
      { key: 'low', label: 'Low effort' },
      { key: 'medium', label: 'Medium effort' },
      { key: 'high', label: 'High effort' },
    ]
    const selects = new Map<EffortLevel, HTMLSelectElement>()

    // The last routing the main process confirmed persisted. On a rejected save we
    // revert `current` + the dropdowns to this, so the UI never shows an unsaved
    // value, and toast the failure instead of swallowing it (#307).
    let persisted: ModelRouting = { ...current }
    const save = (): void => {
      const attempted: ModelRouting = { ...current }
      void window.flow.settings
        .setModelRouting({ routing: attempted })
        .then(() => {
          persisted = attempted
        })
        .catch((error: unknown) => {
          console.error('flow: failed to save model routing', error)
          for (const key of Object.keys(persisted) as EffortLevel[]) {
            current[key] = persisted[key]
            const select = selects.get(key)
            if (select) select.value = persisted[key]
          }
          this.#notify(modelRoutingSaveFailedToast(error))
        })
    }

    for (const { key, label } of EFFORTS) {
      const row = document.createElement('div')
      row.style.cssText =
        'display:flex;align-items:center;gap:var(--fl-space-sm);margin-top:var(--fl-space-xs);'
      const name = document.createElement('span')
      name.textContent = label
      name.style.cssText = 'flex:1;font-size:var(--fl-text-ui-size);color:var(--fl-color-text);'
      const arrow = document.createElement('span')
      arrow.textContent = '→'
      arrow.style.color = 'var(--fl-color-text-secondary)'
      const select = document.createElement('select')
      select.setAttribute('aria-label', `Model for ${label}`)
      select.style.cssText =
        'height:24px;padding:0 var(--fl-space-xs);background:var(--fl-color-surface-raised);' +
        'border:var(--fl-border-width) solid var(--fl-color-border);border-radius:var(--fl-radius-sm);' +
        'color:var(--fl-color-text);font-size:var(--fl-text-caption-size);'
      for (const model of MODELS) {
        const el = document.createElement('option')
        el.value = model.value
        el.textContent = model.label
        select.appendChild(el)
      }
      select.value = current[key]
      // INERT UNDER ANOTHER RUNTIME, and visibly so. A dropdown that saves a
      // Claude model while Codex threads ignore it is a control that lies about
      // its own effect; disabled with the sentence above it says what is true.
      select.disabled = claudeNote !== null
      select.addEventListener('change', () => {
        if (isRoutableModel(select.value)) {
          current[key] = select.value
          save()
        }
      })
      selects.set(key, select)
      row.append(name, arrow, select)
      section.appendChild(row)
    }

    const reset = document.createElement('button')
    reset.type = 'button'
    reset.disabled = claudeNote !== null
    reset.textContent = 'Reset to suggested'
    reset.style.cssText =
      'margin-top:var(--fl-space-sm);font-size:var(--fl-text-caption-size);padding:4px 10px;' +
      'border-radius:var(--fl-radius-sm);border:var(--fl-border-width) solid var(--fl-color-border);' +
      'background:transparent;color:var(--fl-color-text-secondary);cursor:pointer;'
    reset.addEventListener('click', () => {
      for (const key of Object.keys(DEFAULT_MODEL_ROUTING) as EffortLevel[]) {
        current[key] = DEFAULT_MODEL_ROUTING[key]
        const select = selects.get(key)
        if (select) select.value = current[key]
      }
      save()
    })
    section.appendChild(reset)

    return section
  }

  /** A "Getting Started" entry to (re-)open the first-run onboarding wizard (#48). */
  #renderGettingStarted(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.style.marginTop = 'var(--fl-space-lg)'
    wrap.style.paddingTop = 'var(--fl-space-md)'
    wrap.style.borderTop = 'var(--fl-border-width) solid var(--fl-color-border)'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = 'Getting Started…'
    btn.style.cssText =
      'font-size:var(--fl-text-ui-size);padding:6px 14px;border-radius:var(--fl-radius-md);' +
      'border:var(--fl-border-width) solid var(--fl-color-border);' +
      'background:var(--fl-color-surface-raised);color:var(--fl-color-text);cursor:pointer;'
    btn.addEventListener('click', () => {
      this.close()
      // Lazy import avoids a settings-view ↔ wizard-view module cycle.
      void import('../onboarding').then((m) => m.startOnboarding())
    })
    wrap.appendChild(btn)
    return wrap
  }

  /**
   * The Claude logins, as the Claude runtime's configuration.
   *
   * A BLOCK, NOT A SECTION: it sits inside Model settings now, so it carries a
   * sub-heading rather than a second top-level one — two headings at the same
   * weight would read as two unrelated screens' worth of settings.
   */
  #renderAccountsBlock(accounts: AccountSummary[]): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fl-settings-subsection'

    const heading = document.createElement('div')
    heading.className = 'fl-settings-subheading'
    heading.textContent = 'Accounts'
    section.appendChild(heading)

    const hint = document.createElement('div')
    hint.className = 'fl-settings-hint'
    hint.textContent =
      'Each account is a separate Claude login, isolated so projects never mix accounts.'
    section.appendChild(hint)

    if (accounts.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'fl-settings-empty'
      empty.textContent = 'No accounts yet. Add one to get started.'
      section.appendChild(empty)
    }

    for (const account of accounts) {
      section.appendChild(this.#renderAccountRow(account))
    }

    section.appendChild(this.#renderAddRow())
    return section
  }

  #renderAccountRow(account: AccountSummary): HTMLElement {
    const row = document.createElement('div')
    row.className = 'fl-settings-account'

    const info = document.createElement('div')
    info.className = 'fl-settings-account-info'
    const name = document.createElement('div')
    name.className = 'fl-settings-account-label'
    name.textContent = account.label
    if (account.isDefault) {
      const badge = document.createElement('span')
      badge.className = 'fl-settings-badge'
      badge.textContent = 'Default'
      name.appendChild(badge)
    }
    const identity = document.createElement('div')
    identity.className = 'fl-settings-account-identity'
    identity.textContent = account.identityHint ?? 'identity unknown'
    info.appendChild(name)
    info.appendChild(identity)
    // LIVE auth status (user call 2026-07-27): the stored hint said "fine"
    // while the enterprise session had expired — probe and say the truth.
    const status = document.createElement('div')
    status.className = 'fl-settings-account-status'
    status.textContent = 'checking…'
    info.appendChild(status)
    void window.flow.accounts
      .status?.({ id: account.id })
      .then((result) => {
        if (!result || !status.isConnected) return
        if (!result.checked) {
          status.textContent = '? status check failed — try again'
          status.classList.add('fl-settings-status-unknown')
        } else if (result.loggedIn) {
          status.textContent = `● signed in${result.identity ? ` — ${result.identity}` : ''}`
          status.classList.add('fl-settings-status-ok')
        } else {
          status.textContent = '○ signed out — sessions will fail until you re-login'
          status.classList.add('fl-settings-status-out')
        }
      })
      .catch(() => {
        if (status.isConnected) status.textContent = ''
      })

    const actions = document.createElement('div')
    actions.className = 'fl-settings-account-actions'
    const relogin = this.#miniButton('Re-login', () => {
      relogin.textContent = 'Signing in…'
      relogin.setAttribute('disabled', '')
      // #972: the login is interactive — surface the sign-in URL fallback and
      // the paste-your-code field right under this account's row.
      const assistHost = document.createElement('div')
      info.appendChild(assistHost)
      const assist = mountLoginAssist(assistHost)
      const settleLogin = this.#beginLogin()
      const reset = (): void => {
        settleLogin()
        assist.dispose()
        assistHost.remove()
        relogin.textContent = 'Re-login'
        relogin.removeAttribute('disabled')
      }
      window.flow.accounts
        .relogin?.({ id: account.id })
        .then((result) => {
          if (result?.ok !== true) {
            this.#notify(accountActionFailedToast('re-login', new Error(result && 'error' in result ? result.error : 'unknown error')))
            reset()
            return
          }
          settleLogin()
          assist.dispose()
          // Success re-renders via the accounts:changed broadcast.
        })
        .catch((error) => {
          this.#notify(accountActionFailedToast('re-login', error))
          reset()
        })
    })
    relogin.title = 'Run the sign-in flow again for this account (fixes expired sessions)'
    actions.appendChild(relogin)
    if (!account.isDefault) {
      const setDefault = this.#miniButton('Set default', () => {
        window.flow.accounts
          .setDefault({ id: account.id })
          .catch((error) => this.#notify(accountActionFailedToast('set-default', error)))
      })
      actions.appendChild(setDefault)
    }
    // Removing an account deletes its on-disk login dir — gate it behind an
    // inline confirm and surface any failure (#216).
    const remove = this.#miniButton('Remove', () => this.#confirmRemove(remove, account), true)
    actions.appendChild(remove)

    row.appendChild(info)
    row.appendChild(actions)
    return row
  }

  #renderAddRow(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'fl-settings-add'

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'fl-settings-input'
    input.placeholder = 'Account name (e.g. Personal, Acme Co)'
    // #1000: an account-row action re-renders the body — carry this text across.
    input.setAttribute(CARRY_KEY_ATTR, 'accounts.addLabel')

    const status = document.createElement('div')
    status.className = 'fl-settings-add-status'
    status.hidden = true

    const addBtn: HTMLElement = this.#miniButton('Add account', () => {
      const label = input.value.trim()
      if (!label) {
        // Same empty-field feedback as the Integrations/Tasks Connect forms
        // (#217/#412/#709) — a silent dead click reads as a broken button (#834).
        status.hidden = false
        status.textContent = 'Enter an account name first.'
        status.classList.add('error')
        input.focus()
        return
      }
      addBtn.setAttribute('disabled', '')
      input.disabled = true
      status.hidden = true
      status.classList.remove('error')
      // #972: the login is interactive — the assist renders the "Opening
      // browser sign-in…" line, the URL fallback, and the paste-your-code
      // field wired to accounts.submitLoginCode / cancelLogin.
      const assistHost = document.createElement('div')
      wrap.appendChild(assistHost)
      const assist = mountLoginAssist(assistHost)
      const settleLogin = this.#beginLogin()
      const fail = (message: string): void => {
        settleLogin()
        assist.dispose()
        assistHost.remove()
        status.hidden = false
        status.textContent = message
        status.classList.add('error')
        addBtn.removeAttribute('disabled')
        input.disabled = false
      }
      void window.flow.accounts
        .add({ label })
        .then((result) => {
          if ('error' in result) {
            fail(result.error)
          } else {
            settleLogin()
            assist.dispose()
            input.value = ''
            // accounts:changed fires → #render() refreshes the whole list.
          }
        })
        .catch((error: unknown) => {
          fail(error instanceof Error ? error.message : 'Failed to add account')
        })
    })

    // #1396: Enter submits. This field's primary action is the first thing in
    // the overlay, and pressing Enter did nothing at all — not even the
    // blank-field hint the button itself shows (#834). Wired to the BUTTON, so
    // validation, the disabled state and the feedback contract stay shared.
    submitOnEnter(input, addBtn)

    const inputRow = document.createElement('div')
    inputRow.className = 'fl-settings-add-row'
    inputRow.appendChild(input)
    inputRow.appendChild(addBtn)
    wrap.appendChild(inputRow)
    wrap.appendChild(status)
    return wrap
  }

  async #renderProjectSection(
    accounts: AccountSummary[],
    rootPath: string,
    provider: string,
  ): Promise<HTMLElement> {
    const section = document.createElement('div')
    section.className = 'fl-settings-section'

    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = 'This project'
    section.appendChild(heading)

    // WHOSE SETTING THIS IS, when it is not the runtime in use. Shown, not
    // hidden: the project may still have Claude threads, and a setting that
    // vanished would read as one that was deleted.
    const claudeNote = claudeOnlyNote(provider, 'accounts')
    if (claudeNote !== null) {
      const note = document.createElement('div')
      note.className = 'fl-settings-hint fl-settings-scoped'
      note.textContent = claudeNote
      section.appendChild(note)
    }

    const resolution = await window.flow.accounts.activeForProject({ rootPath })
    const current = document.createElement('div')
    current.className = 'fl-settings-hint'
    // #1108: name the STORED state, not just the effective account — a project
    // that merely follows the default must not read as pinned to it.
    current.textContent =
      resolution.status === 'ready'
        ? resolution.source === 'override'
          ? `Pinned to: ${resolution.label}`
          : `Runs under: ${resolution.label} (inherited default — follows it if you change it)`
        : resolution.status === 'dangling'
          ? 'Bound account was removed — pick another.'
          : 'Uses the default account (or your CLI login if none is set).'
    section.appendChild(current)

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
    // Only a PINNED project selects a concrete account; an inherited default
    // leaves "Use default account" selected so the stored state is visible and
    // re-selectable (#1108).
    select.value =
      resolution.status === 'ready' && resolution.source === 'override' ? resolution.accountId : ''
    // The select updates optimistically; on a failed assign revert it so it
    // never misrepresents which account the project is bound to (#226).
    let committed = select.value
    select.addEventListener('change', () => {
      const attempted = select.value
      const previous = committed
      committed = attempted
      window.flow.accounts
        .assignProject({
          rootPath,
          accountId: attempted === '' ? null : attempted,
        })
        .catch((error) => {
          const decision = resolveAssignRevert(select.value, attempted, previous)
          if (decision.revert) {
            select.value = decision.value
            committed = decision.value
          }
          this.#notify(accountActionFailedToast('assign', error))
        })
    })
    section.appendChild(select)
    return section
  }

  /**
   * "This project", when the project's runtime is not Claude.
   *
   * The Claude account picker cannot answer for Codex or Copilot: those runtimes
   * keep a SINGLE global sign-in — one account per runtime today, shared by every
   * project on the machine — not a per-project account. So instead of an
   * Anthropic account list this block states the runtime's own signed-in
   * identity and offers to sign in or out, and it says out loud that the login is
   * global, so nobody reads it as a per-project account that does not exist.
   *
   * SAID, NEVER LEFT BLANK (forbidden-pattern #12): the identity line reads
   * "Checking…" until the runtime's own probe answers, and the fix is always a
   * button here or a pointer to Model settings above — never a command string.
   * The probe and the sign-in/out plumbing are the SAME the Model settings
   * refusal uses, so both surfaces agree on who is signed in.
   */
  #renderProjectRuntimeBlock(_rootPath: string, provider: string): HTMLElement {
    const section = document.createElement('div')
    section.className = 'fl-settings-section'

    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = 'This project'
    section.appendChild(heading)

    const name = runtimeName(provider)
    const note = document.createElement('div')
    note.className = 'fl-settings-hint fl-settings-scoped'
    // GLOBAL, NOT PER-PROJECT. There is one sign-in per runtime today, and
    // implying otherwise would promise an account this project does not get. The
    // Claude account picker is Claude's alone; this runtime's login is its own,
    // configured with the runtime in Model settings above.
    note.textContent =
      `New threads here run on ${name}, which keeps a single sign-in for the whole machine — ` +
      `one ${name} account, shared by every project on it, not a per-project account. ` +
      (claudeOnlyNote(provider, 'accounts') ?? '')
    section.appendChild(note)

    const status = document.createElement('div')
    status.className = 'fl-settings-hint'
    status.textContent = 'Checking…'
    section.appendChild(status)

    const actions = document.createElement('div')
    actions.className = 'fl-settings-refusal-actions'
    section.appendChild(actions)

    // Flow's own sign-in for this runtime, mounted in place — the same assist the
    // Model settings sign-in uses, held in the single #runtimeLogin slot so two
    // logins cannot race.
    const startSignIn = (onDone: () => void): void => {
      const slot = document.createElement('div')
      actions.replaceChildren(slot)
      this.#runtimeLogin?.dispose()
      this.#runtimeLogin = mountRuntimeLoginAssist(slot, provider, {
        onFinished: (ok) => {
          if (ok) onDone()
        },
      })
    }

    // Ask, then run the runtime's own logout — signing out is a bigger promise
    // than running a tool (Copilot has no logout, so Flow removes what it
    // stored), which is why it is confirmed and the wording says what happens.
    const confirmSignOut = (onDone: () => void): void => {
      const question = document.createElement('div')
      question.className = 'fl-settings-hint'
      question.textContent = signOutConfirm(provider)
      const confirmActions = document.createElement('div')
      confirmActions.className = 'fl-settings-refusal-actions'
      const go = this.#miniButton(
        `Sign out of ${name}`,
        () => {
          const run = window.flow.settings.signOutRuntime
          if (typeof run !== 'function') {
            question.textContent = `This build of Flow cannot sign out of ${name}.`
            confirmActions.replaceChildren()
            return
          }
          question.textContent = `Signing out of ${name}…`
          confirmActions.replaceChildren()
          void run({ provider })
            .then((result) => {
              // Re-ask either way: the identity line is the answer, and it comes
              // from the runtime's own state, not from this press.
              if (result.ok) onDone()
              else {
                question.textContent = `${name} could not be signed out.`
                confirmActions.replaceChildren(this.#miniButton('Back', onDone))
              }
            })
            .catch(() => {
              question.textContent = `${name} could not be signed out.`
              confirmActions.replaceChildren(this.#miniButton('Back', onDone))
            })
        },
        true,
      )
      confirmActions.append(go, this.#miniButton('Cancel', onDone))
      actions.replaceChildren(question, confirmActions)
    }

    // The runtime's OWN state, not a stored hint (#renderAccountRow's lesson):
    // probe live, and offer the one press that changes it.
    const refresh = (): void => {
      status.textContent = 'Checking…'
      actions.replaceChildren()
      void this.#checkRuntimeReady(provider).then((answer) => {
        if (!status.isConnected) return
        const signedIn = answer.status === 'ready'
        status.textContent = signedIn
          ? `Signed in${answer.detail.length > 0 ? ` — ${answer.detail}` : ''}`
          : answer.status === 'not-installed'
            ? `${name} is not installed — install and sign in with the runtime in Model settings above.`
            : 'Not signed in.'
        actions.replaceChildren()
        if (!signedIn && answer.status !== 'not-installed' && canSignInHere(provider)) {
          actions.appendChild(this.#miniButton(`Sign in to ${name}`, () => startSignIn(refresh)))
        }
        if (signedIn && canSignOutHere(provider)) {
          actions.appendChild(this.#miniButton('Sign out', () => confirmSignOut(refresh), true))
        }
      })
    }
    refresh()
    return section
  }

  #miniButton(label: string, onClick: () => void, danger = false): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'fl-settings-btn'
    if (danger) btn.classList.add('danger')
    btn.textContent = label
    btn.addEventListener('click', onClick)
    return btn
  }

  /** Swap the Remove button for an inline "Remove <label>?" confirm — the action
   *  permanently deletes the account's on-disk login dir, so it must not fire on
   *  a single click (#216). Cancel restores the button; a rejection toasts. */
  #confirmRemove(removeBtn: HTMLButtonElement, account: AccountSummary): void {
    const confirm = document.createElement('div')
    confirm.className = 'fl-settings-confirm'
    const label = document.createElement('span')
    label.className = 'fl-settings-confirm-label'
    label.textContent = `Remove ${account.label}?`
    const cancel = this.#miniButton('Cancel', () => confirm.replaceWith(removeBtn))
    const yes = this.#miniButton(
      'Remove',
      () => {
        window.flow.accounts
          .remove({ id: account.id })
          .catch((error) => this.#notify(accountActionFailedToast('remove', error)))
      },
      true,
    )
    confirm.append(label, cancel, yes)
    removeBtn.replaceWith(confirm)
  }

  /** Surface a toast via the flow:notify bridge (→ NotificationCenter) (#216). */
  #notify(toast: SettingsToast): void {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId: '',
          title: toast.title,
          body: toast.body,
          timestamp: new Date().toISOString(),
          level: toast.level,
        },
      }),
    )
  }
}

let stylesInjected = false

/** Shared settings-overlay styles (overlay/panel/header/section/inputs/btn).
 *  Exported so other settings surfaces (Flow settings) reuse the same look. */
let fieldRowStylesInjected = false

/**
 * The shared field-row CSS, injected once for every panel that draws a row.
 *
 * It used to live inside the project panel's own injector, which made the
 * defaults panel look right only because two unrelated `init` calls happened to
 * run in a helpful order. One owner, one injection, both callers.
 */
export function injectFieldRowStyles(): void {
  if (fieldRowStylesInjected) return
  fieldRowStylesInjected = true
  const style = document.createElement('style')
  style.textContent = FIELD_ROW_STYLES
  document.head.appendChild(style)
}

export function injectSettingsStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-settings-overlay {
      position: fixed;
      inset: 0;
      z-index: 2000;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 10vh;
      background: rgba(0, 0, 0, 0.45);
    }
    .fl-settings-overlay[hidden] { display: none; }
    .fl-settings-panel {
      width: min(560px, 92vw);
      max-height: 76vh;
      display: flex;
      flex-direction: column;
      background: var(--fl-color-surface);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-lg, 10px);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
      overflow: hidden;
    }
    .fl-settings-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--fl-space-md) var(--fl-space-lg);
      /* Region seam — the header strip against the body, both on the dialog's
         own ground. The dialog's OUTLINE stays the object-edge token. */
      border-bottom: var(--fl-border-width) solid var(--fl-color-separator);
      font-weight: var(--fl-text-ui-weight-medium);
      color: var(--fl-color-text);
    }
    .fl-settings-close {
      border: none;
      background: transparent;
      color: var(--fl-color-text-secondary);
      cursor: pointer;
      font-size: 14px;
    }
    .fl-settings-close:hover { color: var(--fl-color-text); }
    /* ── THE SETTINGS PAGE ─────────────────────────────────────────────
       A tab, not a dialog: it fills the editor area and scrolls in place.
       The overlay rules above still apply to the two surfaces that are still
       modals — Flow settings and Integrations. */
    .fl-settings-page {
      display: flex; flex-direction: column; height: 100%; min-height: 0;
      background: var(--fl-color-bg);
    }
    /* Region seam, not an object edge (see --fl-color-separator). */
    .fl-settings-nav {
      display: flex; align-items: center; gap: var(--fl-space-xs); flex: none;
      padding: var(--fl-space-xs) var(--fl-space-lg);
      border-bottom: var(--fl-border-width) solid var(--fl-color-separator);
    }
    .fl-settings-tab {
      height: 24px; padding: 0 var(--fl-space-sm);
      border: none; border-radius: var(--fl-radius-sm); background: transparent;
      color: var(--fl-color-text-secondary); cursor: pointer; white-space: nowrap;
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size);
    }
    .fl-settings-tab[hidden] { display: none; }
    .fl-settings-tab:hover { color: var(--fl-color-text); }
    .fl-settings-tab.active {
      background: var(--fl-color-surface-raised); color: var(--fl-color-text);
    }
    /* A GROUP IS A COLUMN WITH A MAXIMUM. The dialog was 560px wide and every
       row was written for that measure; a full-width editor area would set the
       same rows across 1,200px, where a label and its control end up a hand's
       width apart. */
    .fl-settings-group { max-width: 620px; }
    .fl-settings-group[hidden] { display: none; }
    .fl-settings-body { padding: var(--fl-space-lg); overflow-y: auto; flex: 1; min-height: 0; }
    .fl-settings-section { margin-bottom: var(--fl-space-lg); }
    .fl-settings-heading {
      font-size: var(--fl-text-caption-size);
      font-weight: var(--fl-text-ui-weight-medium);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--fl-color-text-secondary);
      margin-bottom: var(--fl-space-xs);
    }
    .fl-settings-hint {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      margin-bottom: var(--fl-space-sm);
    }
    .fl-settings-toggle {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      cursor: pointer;
      margin-bottom: var(--fl-space-xs);
    }
    /* What is actually sent, under the switch that sends it. Indented and ruled
       so it reads as the consequence of the control above rather than as the
       next setting down. */
    .fl-settings-privacy-detail {
      margin-top: var(--fl-space-sm);
      padding-left: var(--fl-space-md);
      border-left: var(--fl-border-width) solid var(--fl-color-border);
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
    }
    .fl-settings-privacy-line { margin-bottom: var(--fl-space-xs); }
    .fl-settings-privacy-label {
      display: block;
      color: var(--fl-color-text-primary);
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-settings-privacy-never { margin: var(--fl-space-xs) 0 0; padding-left: 1.1em; }
    .fl-settings-privacy-never li { margin-bottom: 2px; }
    /* The chosen runtime's own configuration, INSIDE Model settings — indented
       and ruled so it reads as belonging to the choice above it rather than as
       the next thing down the screen. */
    .fl-settings-runtime-config {
      margin-top: var(--fl-space-md);
      padding-left: var(--fl-space-md);
      border-left: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-settings-subsection { margin-bottom: var(--fl-space-sm); }
    /* A refusal sits where the choice was made, in the colour of a stop. */
    /* "This belongs to Claude" — a scope note, not a warning: it explains a
       section rather than reporting a problem with it. */
    .fl-settings-scoped {
      padding-left: var(--fl-space-sm);
      border-left: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-settings-refusal {
      margin-top: var(--fl-space-xs);
      font-size: var(--fl-text-caption-size);
      /* Not an error colour: a list of what a runtime still needs is a state,
         not a failure. Red belonged to the CLI text this replaced. */
      color: var(--fl-color-text-secondary);
      line-height: 1.5;
      /* SET APART FROM THE BLOCK BELOW IT. This is one runtime's state and the
         next element is another's; without an edge between them they read as
         one confusing list about nobody in particular. */
      padding: var(--fl-space-xs);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm, 4px);
      background: var(--fl-color-surface-2, transparent);
    }
    .fl-settings-runtime-config {
      margin-top: var(--fl-space-sm);
    }
    .fl-settings-requirements {
      display: flex; flex-direction: column; gap: var(--fl-space-xs);
      margin-top: var(--fl-space-xs); width: 100%;
    }
    .fl-settings-requirement {
      display: flex; align-items: center; gap: var(--fl-space-xs);
    }
    .fl-settings-refusal-actions {
      display: flex; gap: var(--fl-space-sm); flex-wrap: wrap;
      margin-top: var(--fl-space-xs);
    }
    .fl-settings-inline-btn {
      background: none; cursor: pointer;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm); padding: 2px 8px;
      color: var(--fl-color-text); font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
    }
    .fl-settings-inline-btn:hover { border-color: var(--fl-color-focus-ring); }
    .fl-settings-subheading {
      font-size: var(--fl-text-caption-size);
      font-weight: var(--fl-text-ui-weight-medium);
      color: var(--fl-color-text);
      margin-bottom: var(--fl-space-xs);
    }
    .fl-settings-empty {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-ui-size);
      padding: var(--fl-space-sm) 0;
    }
    .fl-settings-account {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--fl-space-sm);
      padding: var(--fl-space-sm) 0;
      border-top: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-settings-account-label {
      display: flex;
      align-items: center;
      gap: var(--fl-space-xs);
      color: var(--fl-color-text);
      font-size: var(--fl-text-ui-size);
    }
    .fl-settings-account-identity {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
  .fl-settings-account-status { font-size: 11px; margin-top: 2px; color: var(--fl-color-text-secondary, #8a93a3); }
  .fl-settings-status-ok { color: var(--fl-color-success, #2E9E5B); }
  .fl-settings-status-out { color: var(--fl-color-warning, #B8791E); }
  .fl-settings-status-unknown { font-style: italic; }
    .fl-settings-badge {
      padding: 1px 6px;
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-accent-muted);
      color: var(--fl-color-accent, var(--fl-color-text));
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .fl-settings-account-actions { display: flex; gap: var(--fl-space-xs); flex: none; }
    .fl-settings-btn {
      border: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
      cursor: pointer;
      padding: 3px var(--fl-space-sm);
      border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
    }
    .fl-settings-btn:hover { border-color: var(--fl-color-focus-ring); }
    .fl-settings-btn.danger { color: var(--fl-color-error); }
    .fl-settings-btn[disabled] { opacity: 0.5; cursor: default; }
    /* Inline "Remove <account>?" confirm (#216). */
    .fl-settings-confirm { display: flex; align-items: center; gap: var(--fl-space-xs); }
    .fl-settings-confirm-label { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }
    .fl-settings-add { margin-top: var(--fl-space-sm); }
    .fl-settings-add-row { display: flex; gap: var(--fl-space-xs); }
    .fl-settings-input, .fl-settings-select {
      flex: 1;
      min-width: 0;
      padding: 5px var(--fl-space-sm);
      background: var(--fl-color-bg);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
      outline: none;
    }
    .fl-settings-input:focus, .fl-settings-select:focus { border-color: var(--fl-color-focus-ring); }
    .fl-settings-select { width: 100%; }
    .fl-settings-add-status {
      margin-top: var(--fl-space-xs);
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
    }
    .fl-settings-add-status.error { color: var(--fl-color-error); }
  `
  document.head.appendChild(style)
}
