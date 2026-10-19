/**
 * Central map of renderer selectors used across E2E specs. The renderer has no
 * data-testids, so these track the real DOM (fl-* class convention). Keep this
 * file in sync when the shell markup changes — it's the single point of churn.
 */
export const sel = {
  shell: '#app.fl-shell',
  titlebar: '.fl-titlebar',
  // The titlebar carries several icons now (sidebar, right side, editor area,
  // Settings) — name the sidebar one, or a strict locator matches all of them.
  sidebarToggle: '.fl-titlebar-icon[title^="Toggle sidebar"]',
  // The Workspace switcher (the project switcher is gone since the hard migration).
  projectSwitcher: '.fl-ws-switcher',
  projectName: '.fl-project-name',
  brand: '.fl-brand-word',

  threadSidebar: '.fl-thread-sidebar',
  threadSearch: '.fl-thread-search input, .fl-thread-search',
  threadList: '.fl-thread-list',
  threadEmpty: '.fl-thread-empty',
  addProject: 'fl-button[aria-label="Add project"]',
  newTask: 'fl-button[aria-label="New task"]',
  // Top toolbar "+" — its aria-label is the stable "New thread" (accurate for
  // every project count; the multi-project detail lives only in the tooltip,
  // #131). Distinct from the per-project "+" (aria-label "New thread or task in
  // <project>"), so this still resolves only the top button.
  newThread: 'fl-button[aria-label="New thread"]',

  conversation: '.fl-conversation',
  composer: '.fl-composer',
  composerInput: '.fl-composer-input',
  // Live "· using <model>" indicator next to the model picker — shown only
  // while the turn is working, hidden when idle (#129 / PR #137).
  composerModelIndicator: '.fl-composer-model-indicator',

  // The former .fl-sidetabs Files|Source-Control tab strip was removed by the #674
  // activity-bar redesign — side-panel switching is now the rail
  // (`.fl-activity-bar .fl-rail-item[data-rail-item="files"|"source-control"]`).
  // Source Control (#335) still folds Git + Review into one pane with a
  // Changes|Phases view-mode toggle (.fl-sc-viewbtn).
  scViewBtn: '.fl-sc-viewbtn',
  scViewActive: '.fl-sc-viewbtn.active',

  // Git tab body of the right-hand side panel. On a fresh, project-less launch
  // the panel mounts its root and shows the "No project roots" empty state.
  gitPanelRoot: '.gp-root',
  gitPanelEmpty: '.gp-empty',

  statusBar: '.fl-status-bar',
  statusButton: '.fl-status-button',
  flowLine: '.fl-flow-line',

  // Responsive layout (#580): movable panels carry data-panel-id; the root split
  // is the reorder container; each movable panel has a ⋯ reposition menu trigger.
  rootSplit: '#fl-split-root',
  panelById: (id: string): string => `[data-panel-id="${id}"]`,
  panelMenuTrigger: '.fl-panel-menu-trigger',
  panelMenu: '.fl-panel-menu',
  // Focus-mode exit pill (#616) — shown only while focus mode is on.
  focusHint: '.fl-focus-hint',

  // Feature surfaces (roots, confirmed from renderer source).
  terminalPanel: '#fl-panel-terminal',
  terminalRoot: '.fl-term-root',
  board: '.fl-board',
  // The board's own structure, not a heading and no longer a header row: the
  // tasks board prints no "Tasks" title (the tab above it says so) and has no
  // toolbar at all (its two verbs live on Todo's column head). A lane head is
  // what proves the view mounted — and it exists only WITH a project open,
  // which is the one state this selector is used in.
  //
  // NOT `:first-child`: the first column is the REMOTE one, which is hidden for
  // a project with no remote list configured. This names a LANE head, which is
  // what every caller means. Callers assert `.first()` on it.
  boardTitle: '.fl-board-column:not(.fl-board-remote) .fl-board-column-head',
  // The live blueprint board's root (blueprint-board.ts:1236). The retired
  // BlueprintView's `.bpv-root` this used to name exists nowhere in the source
  // (#1814) — every assertion through it either failed or, for `toBeHidden()`,
  // passed on a zero-match locator.
  blueprintRoot: '.flow-board-root',
  // The board's header chrome, appended unconditionally in the constructor
  // (blueprint-board.ts:1258/1421) — proof the view mounted, not just that a
  // div exists. Replaces the retired `.bpv-title`.
  blueprintHeader: '.fb-header',
  // STILL THE OVERLAY FAMILY, and it still has two members: Flow settings and
  // Integrations. The app's own Settings left it — it is a tabbed PAGE in the
  // editor area now (`settingsPage`), so a spec driving accounts, worktree
  // defaults or model routing wants that and a tab click, not this.
  settingsOverlay: '.fl-settings-overlay',
  settingsPanel: '.fl-settings-panel',
  settingsClose: '.fl-settings-close',
  /** The app's Settings, as a page. */
  settingsPage: '.fl-settings-page',
  /** The titlebar gear that opens it. */
  settingsButton: '.fl-titlebar-icon[aria-label="Settings"]',

  // First-run onboarding wizard (reuses .fl-settings-overlay chrome, but has a
  // wizard body + Skip/Next footer). Shown on a fresh userData dir.
  onboardingOverlay: '.fl-settings-overlay:has(.fl-wizard-body)',
  onboardingVisible: '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)',
  onboardingSkip: '.fl-wizard-btn:has-text("Skip for now")',
  wizardBody: '.fl-wizard-body',
} as const

/** A surface-action button located by its label. Historically these lived in
 *  the status bar; the activity-bar redesign (#663/#668) moved Blueprint,
 *  Tasks, and Terminal onto the icon rail as aria-labeled action items, while
 *  others (e.g. "Settings") remain status-bar buttons, and the Workspaces
 *  layout put Tasks, Blueprint, Browser and Terminal in the editor area's view
 *  actions (`.fl-editor-actions`). The union
 *  selector resolves whichever surface carries the label, so specs stay
 *  markup-agnostic. */
export const statusButtonByText = (text: string) =>
  `.fl-status-button:has(span:text-is("${text}")), .fl-activity-bar .fl-rail-item[aria-label="${text}"], .fl-editor-actions .fl-rail-item[aria-label="${text}"]`
