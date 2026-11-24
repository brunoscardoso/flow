/**
 * FLOW'S FEATURE GUIDE — the overview and the per-screen tours (user,
 * 2026-11-23: "the user don't know about it … when the user starts the first
 * time we show a overview and then … the first time of each screen we can
 * teach the user").
 *
 * This module is the DATA and the RULES, DOM-free, so main validates updates
 * with it and the renderer decides with it under the node jest runner.
 *
 *   - The overview shows once, after the setup wizard. Taking the tour and
 *     closing it both count as seen.
 *   - Each tour starts the first time its screen is ON SCREEN, never before.
 *     A tour is marked seen the moment it starts: a reload halfway through
 *     must not replay it, and a person who wants it again has Replay.
 *   - One thing at a time: nothing starts over a dialog, over another tour, or
 *     before the overview has been answered.
 *   - The switch turns every tour off. A replay a person asks for still runs.
 *
 * WORDING: what a person can see and do on that screen, in short sentences.
 * Never a command line, a file path or a config key (forbidden-pattern #12).
 */

export const GUIDE_IDS = [
  'threads',
  'tasks',
  'blueprint',
  'block',
  'diagram',
  'ask',
  'changes',
  'browser',
  'launchpad-menu',
  'launchpad',
  'launchpad-setup',
  'cards',
  'drafts',
  'settings',
] as const

export type GuideId = (typeof GUIDE_IDS)[number]

export function isGuideId(value: unknown): value is GuideId {
  return typeof value === 'string' && (GUIDE_IDS as readonly string[]).includes(value)
}

/** What is stored, per person (app-wide, never per project). */
export interface GuidesState {
  /** Show a tour the first time a screen opens. */
  enabled: boolean
  /** The overview has been shown and answered. */
  overviewSeen: boolean
  /** Tours that have started at least once. */
  seen: GuideId[]
}

/** A partial update. Omitted fields are left as they are. */
export interface GuidesUpdate {
  enabled?: boolean
  overviewSeen?: boolean
  /** Mark one tour seen. */
  seen?: GuideId
  /** Forget one tour, so it starts again next time its screen opens. */
  unseen?: GuideId
  /** Forget every tour and the overview. */
  resetAll?: boolean
}

export function defaultGuidesState(enabled: boolean): GuidesState {
  return { enabled, overviewSeen: false, seen: [] }
}

/**
 * Read a stored value. Anything unreadable falls back to the default, and an
 * unknown tour id (a tour removed in a later version) is dropped, not kept.
 */
export function parseGuidesState(raw: string | null | undefined, defaultEnabled: boolean): GuidesState {
  if (raw === null || raw === undefined || raw === '') return defaultGuidesState(defaultEnabled)
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return defaultGuidesState(defaultEnabled)
  }
  if (typeof value !== 'object' || value === null) return defaultGuidesState(defaultEnabled)
  const record = value as Record<string, unknown>
  const seen = Array.isArray(record['seen']) ? record['seen'].filter(isGuideId) : []
  return {
    enabled: typeof record['enabled'] === 'boolean' ? record['enabled'] : defaultEnabled,
    overviewSeen: record['overviewSeen'] === true,
    seen: [...new Set(seen)],
  }
}

/** Apply an update. Invalid ids are ignored; the input is never mutated. */
export function applyGuidesUpdate(state: GuidesState, update: GuidesUpdate): GuidesState {
  if (update.resetAll === true) {
    return { enabled: update.enabled ?? state.enabled, overviewSeen: false, seen: [] }
  }
  let seen = [...state.seen]
  if (isGuideId(update.seen) && !seen.includes(update.seen)) seen.push(update.seen)
  if (isGuideId(update.unseen)) seen = seen.filter((id) => id !== update.unseen)
  return {
    enabled: typeof update.enabled === 'boolean' ? update.enabled : state.enabled,
    overviewSeen: typeof update.overviewSeen === 'boolean' ? update.overviewSeen : state.overviewSeen,
    seen,
  }
}

// ── The tours ────────────────────────────────────────────────────────────────

export interface GuideStep {
  /**
   * Where the step points: the first selector in the list that is on screen.
   * A step whose anchor is not on screen is left out of the tour.
   */
  anchor: readonly string[]
  title: string
  body: string
}

export interface GuideTour {
  id: GuideId
  /** The name in Settings › Guides and on the card's step line. */
  name: string
  /** One line for Settings › Guides. */
  summary: string
  /** The tour starts when one of these is on screen. */
  trigger: readonly string[]
  /** What Replay does to bring the screen up, when the screen is not open. */
  open?: { event: string } | { click: string }
  /**
   * The tour is ABOUT a dialog (the Brain's Ask panel), so it may start while
   * that dialog is open, and it leaves the keyboard focus where it is — the
   * dialog keeps it, and the person can keep typing.
   */
  inDialog?: boolean
  /**
   * The tour is about a popup menu that closes when it loses focus or gets a
   * key: the card never takes focus, so the menu stays open under it.
   */
  keepFocus?: boolean
  /** A popup the card must not cover while the tour points inside it. */
  avoid?: string
  steps: readonly GuideStep[]
}

export const GUIDE_TOURS: readonly GuideTour[] = [
  {
    id: 'threads',
    name: 'Threads and the composer',
    summary: 'Context, connectors, commands and Autopilot',
    trigger: ['.fl-composer'],
    open: { click: '[data-rail-item="threads"]' },
    steps: [
      {
        anchor: ['.fl-project-chips'],
        title: 'Work across projects',
        body: 'Each chip is a project the agent can see. Add another project and the agent can read and change it in this thread.',
      },
      {
        anchor: ['.fl-connector-chip'],
        title: 'Connectors',
        body: 'Connectors give the agent tools, such as your issue tracker or a database. Turn them on or off for each thread.',
      },
      {
        anchor: ['.fl-composer-input', '.fl-composer-shell'],
        title: 'Commands and files',
        body: 'Type / to see what Flow can run for you, such as a discovery or a plan. Type @ to point the agent at a file.',
      },
      {
        anchor: ['.fl-composer-asking', '.fl-composer-autopilot', '.fl-composer-controls'],
        title: 'How much the agent asks',
        body: 'With "Asks first", the agent asks before it changes files or runs commands. Autopilot lets it go from one step to the next on its own.',
      },
    ],
  },
  {
    id: 'tasks',
    name: 'Tasks and Loops',
    summary: 'The board, adding work, and letting the agent work it',
    trigger: ['.fl-board'],
    open: { event: 'flow:open-board' },
    steps: [
      {
        anchor: ['.fl-board-column'],
        title: 'Your board',
        body: 'Each card is a piece of work. Cards move from Todo to Done as the agent works on them.',
      },
      {
        anchor: ['.fl-board-column .fl-board-lane-controls'],
        title: 'Let the agent work the list',
        body: 'Add a task with +. Press play and the agent takes the Todo cards one at a time, each in its own thread.',
      },
      {
        anchor: ['.fl-board-column .fl-board-card'],
        title: 'Open a card',
        body: 'Open a card to see its thread, what it changed, and what is left to do.',
      },
    ],
  },
  {
    id: 'blueprint',
    name: 'Blueprint and the Brain',
    summary: 'The map of your project, learning, and asking questions',
    trigger: ['.flow-board-root'],
    open: { event: 'flow:open-blueprint' },
    steps: [
      {
        anchor: ['.flow-board-root'],
        title: 'A map of your project',
        body: 'Each block is a feature of your project. Bigger blocks hold more code. Open a block to see its parts.',
      },
      {
        anchor: ['.fb-learn-chip'],
        title: 'Flow learns your code',
        body: 'Flow reads your project and keeps notes on what each part does. This shows how much it understands so far.',
      },
      {
        anchor: ['.fb-askf'],
        title: 'Ask the Brain',
        body: 'Press / or click here to ask a question about your code. The answer comes from Flow\'s notes, with links to the source.',
      },
    ],
  },
  {
    id: 'block',
    name: 'An open block',
    summary: 'Folders, the diagram, connections, and zoom',
    trigger: ['.fb-terr-pinned'],
    steps: [
      {
        anchor: ['.fb-terr-pinned .fb-terr-grow-folders'],
        title: 'Where the code lives',
        body: 'The folders this block\'s code is in, with the share each one holds. Press a folder to find it in the file tree.',
      },
      {
        anchor: ['.fb-terr-pinned .fb-terr-grow-diagram'],
        title: 'How it works',
        body: 'Each box is a part: a service, an endpoint, a module or a store of data. Lines show what calls what, and the label on a line says what passes along it.',
      },
      {
        anchor: ['.fb-terr-pinned .fb-port'],
        title: 'Where it connects',
        body: 'Cards on the left come in from other code, even from other projects. Cards on the right go out. A dashed card is a link Flow suggests but has not confirmed.',
      },
      {
        anchor: ['.fb-terr-pinned .fb-terr-pin-bar'],
        title: 'Look closer',
        body: 'Zoom with the minus and plus, or drag to move around. Fit shows the whole diagram. Open shows it full size, where you can follow the code.',
      },
    ],
  },
  {
    id: 'diagram',
    name: 'A feature\'s diagram',
    summary: 'Blocks or diagram, and following the code',
    trigger: ['.fb-view-switch'],
    steps: [
      {
        anchor: ['.fb-view-switch'],
        title: 'Blocks or diagram',
        body: 'See a feature as its parts with Blocks, or as a picture of how the parts work together with Diagram. Flow remembers your choice.',
      },
      {
        anchor: ['.flow-board-root .fb-curated-scroll'],
        title: 'Read the diagram',
        body: 'Boxes are parts of the feature, grouped by layer. Lines show what calls what. Cards at the edges show where other code comes in and goes out. Press a box to see its code.',
      },
      {
        anchor: ['[data-feature-story]'],
        title: 'Follow the code',
        body: 'Read the feature\'s code in the order it runs, from where it starts. Each step shows the real code, with numbered arrows to what it calls next.',
      },
    ],
  },
  {
    id: 'ask',
    name: 'Asking the Brain',
    summary: 'Asking a question, choosing what it is about, and suggestions',
    trigger: ['.fb-ask-dim:not([hidden]) .fb-ask-compose'],
    inDialog: true,
    steps: [
      {
        anchor: ['.fb-ask-dim:not([hidden]) .fb-ask-big'],
        title: 'Ask in your own words',
        body: 'Ask how something works, where a change would start, or what could break. Press Enter to ask. The answer names the code it comes from.',
      },
      {
        anchor: ['.fb-ask-dim:not([hidden]) .fb-ask-scope'],
        title: 'Choose what to ask about',
        body: 'The question is about the features listed here. Type @ to add another feature, or press the x on one to take it out.',
      },
      {
        anchor: ['.fb-ask-dim:not([hidden]) .fb-ask-cols'],
        title: 'Not sure what to ask?',
        body: 'Start from a suggested question. Your recent questions are kept beside them, and only you can see them.',
      },
    ],
  },
  {
    id: 'changes',
    name: 'Changes and plan review',
    summary: 'What changed, and reviewing it step by step',
    trigger: ['.gp-root'],
    open: { click: '[data-rail-item="source-control"]' },
    steps: [
      {
        anchor: ['.gp-root'],
        title: 'What changed',
        body: 'Every file you or the agent changed shows here. Open a file to see what is different.',
      },
      {
        anchor: ['.fl-sc-viewbtn'],
        title: 'Review by plan',
        body: 'Switch views to see the changes grouped by the steps of a plan.',
      },
    ],
  },
  {
    id: 'browser',
    name: 'Browser',
    summary: 'Your app beside your code, inspect, console and network',
    trigger: ['.fl-browser-tab'],
    open: { event: 'flow:open-browser' },
    steps: [
      {
        anchor: ['.fl-browser-chrome input[aria-label="Address"]'],
        title: 'Your app beside your code',
        body: 'Open your local app or any site here. Each page has its own tab, and + opens a new one.',
      },
      {
        anchor: ['fl-button[aria-label="Inspect element"]'],
        title: 'Point at what to change',
        body: 'Press Inspect, then click part of the page. Flow adds it to the chat, so the agent knows what you mean.',
      },
      {
        anchor: ['.fl-bdrawer'],
        title: 'Console and network',
        body: 'Errors and requests from the page show here. Add any of them to the chat in one click.',
      },
    ],
  },
  {
    id: 'launchpad-menu',
    name: 'The Run menu',
    summary: 'New terminals, one-time actions, running everything, and changing the setup',
    trigger: ['.fl-run-menu'],
    keepFocus: true,
    avoid: '.fl-run-menu',
    steps: [
      {
        anchor: ['.fl-run-menu .fl-run-menu-item.once', '.fl-run-menu .fl-run-menu-empty'],
        title: 'Run once',
        body: 'Actions you run by hand, such as a migration, grouped by project. Press one and it runs in its own terminal tab, then stops. Run never starts these.',
      },
      {
        anchor: ['.fl-run-menu .fl-run-menu-tag'],
        title: 'Asks first',
        body: 'An action marked like this shows you what it will run and waits until you press Run. Use it for anything that changes or deletes data.',
      },
      {
        anchor: ['.fl-run-menu [data-menu-entry="run-all"]', '.fl-run-menu [data-menu-entry="stop-all"]'],
        title: 'Run everything',
        body: 'Starts every running step, in order, each in its own terminal tab. While they run, this menu can restart or stop them all.',
      },
      {
        anchor: ['.fl-run-menu [data-menu-entry="edit"]'],
        title: 'Change the setup',
        body: 'Add or change steps and actions, or try practice steps that only print text, to watch how it works.',
      },
    ],
  },
  {
    id: 'launchpad',
    name: 'Run',
    summary: 'Open terminals, and start your dev servers and scripts together',
    trigger: ['.fl-run-pill'],
    steps: [
      {
        anchor: ['.fl-run-pill'],
        title: 'Run',
        body: 'Run opens new terminals and starts your dev servers and scripts together, each in its own terminal tab. Set the steps up once, then start everything in one click. Press it to open the menu: open a terminal, run an action, stop everything, or change the setup. With several projects, the menu lists the three you use most; More projects shows them all. The (i) in the menu explains each part.',
      },
    ],
  },
  {
    id: 'launchpad-setup',
    name: 'Setting up run steps',
    summary: 'Running steps, one-time actions, and safe practice steps',
    trigger: ['.fl-run-setup'],
    steps: [
      {
        anchor: ['.fl-run-setup .fl-run-section'],
        title: 'Keeps running',
        body: 'These start when you press Run, from top to bottom, and keep running. Each one gets its own terminal tab. Drag a step or use the arrows to change the order.',
      },
      {
        anchor: ['.fl-run-setup .fl-run-card'],
        title: 'One step',
        body: 'Give it a name and the command you would type in a terminal. Pick the project it runs in, when it starts, and when it counts as ready, such as when a port opens. A step can wait for the one before it.',
      },
      {
        anchor: ['.fl-run-setup .fl-run-section + .fl-run-section'],
        title: 'Runs once',
        body: 'Actions you run by hand, such as a database migration. They never start with Run: press them from the Run menu. Tick "Ask before running" for anything that changes data.',
      },
      {
        anchor: ['.fl-run-setup .fl-run-practice'],
        title: 'Try it safely',
        body: 'Add practice steps that only print text. Save and run to watch them start in order, then remove them in one click.',
      },
    ],
  },
  {
    id: 'cards',
    name: 'Discovery and plan cards',
    summary: 'Reading, reviewing and running a plan from the chat',
    trigger: ['.fl-artifact-card'],
    steps: [
      {
        anchor: ['.fl-artifact-card'],
        title: 'Discoveries and plans',
        body: 'When the agent writes a discovery or a plan, it shows here as a card. Open it to read it, review the change, or run the plan.',
      },
    ],
  },
  {
    id: 'drafts',
    name: 'UI drafts',
    summary: 'Screens the agent drew for an idea',
    trigger: ['.fl-canvas-card'],
    steps: [
      {
        anchor: ['.fl-canvas-card'],
        title: 'UI drafts',
        body: 'The agent drew screens for this idea. Open the canvas to see them side by side in the browser, and point at what to change.',
      },
    ],
  },
  {
    id: 'settings',
    name: 'Settings',
    summary: 'Models, connectors, workspaces and these guides',
    trigger: ['.fl-settings-page'],
    open: { event: 'flow:open-settings' },
    steps: [
      {
        anchor: ['.fl-settings-nav'],
        title: 'Settings',
        body: 'Pick models, add connectors, group projects into workspaces, and more. Guides lets you replay any tour.',
      },
    ],
  },
]

export function tourById(id: GuideId): GuideTour {
  const tour = GUIDE_TOURS.find((t) => t.id === id)
  if (tour === undefined) throw new Error(`no tour '${id}'`)
  return tour
}

// ── The decision ─────────────────────────────────────────────────────────────

export interface GuideMoment {
  state: GuidesState
  /** A tour or the overview is already on screen. */
  busy: boolean
  /** A dialog is open: only a tour about that dialog may start. */
  dialogOpen: boolean
  /** Tours whose screen is inside the open dialog. */
  inDialog: readonly GuideId[]
  /** A project is open, so the app is past setup. */
  hasProject: boolean
  /** Tours whose screen is on screen right now, and was on the last look too. */
  onScreen: readonly GuideId[]
  /** A replay a person asked for, waiting for its screen. */
  requested: GuideId | null
}

export type GuideAction = { kind: 'none' } | { kind: 'overview' } | { kind: 'tour'; id: GuideId }

/** What to show now, if anything. */
export function nextGuideAction(m: GuideMoment): GuideAction {
  if (m.busy) return { kind: 'none' }
  // OVER A DIALOG, only a tour about that dialog: the overview and every
  // other tour wait for it to close.
  const onScreen = m.dialogOpen ? m.onScreen.filter((id) => m.inDialog.includes(id)) : m.onScreen
  // A REQUEST IS A PERSON'S PRESS: it runs with tips off, and over the
  // overview question, as long as its screen is up.
  if (m.requested !== null) {
    return onScreen.includes(m.requested) ? { kind: 'tour', id: m.requested } : { kind: 'none' }
  }
  if (!m.state.enabled || !m.hasProject) return { kind: 'none' }
  if (!m.state.overviewSeen) return m.dialogOpen ? { kind: 'none' } : { kind: 'overview' }
  // GUIDE_IDS order is the priority when two screens open at once.
  for (const id of GUIDE_IDS) {
    if (onScreen.includes(id) && !m.state.seen.includes(id)) return { kind: 'tour', id }
  }
  return { kind: 'none' }
}

/** True when nothing is left to show without a person asking. */
export function guidesFinished(state: GuidesState): boolean {
  return !state.enabled || (state.overviewSeen && GUIDE_IDS.every((id) => state.seen.includes(id)))
}

// ── Placing the card ─────────────────────────────────────────────────────────

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export type CardSide = 'right' | 'left' | 'below' | 'above' | 'center'

export interface CardPlacement {
  side: CardSide
  left: number
  top: number
}

/**
 * Where the card goes beside its anchor: the first side it fits on, in the
 * order right, left, below, above; centred over the window when it fits
 * nowhere (an anchor as big as the screen, such as a whole board). The card
 * is always kept inside the window by `margin`.
 */
export function placeCard(
  anchor: Rect | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 14,
  margin = 12,
): CardPlacement {
  const clampX = (x: number): number => Math.max(margin, Math.min(x, viewport.width - card.width - margin))
  const clampY = (y: number): number => Math.max(margin, Math.min(y, viewport.height - card.height - margin))
  const center: CardPlacement = {
    side: 'center',
    left: clampX((viewport.width - card.width) / 2),
    top: clampY((viewport.height - card.height) / 2),
  }
  if (anchor === null) return center
  const right = anchor.left + anchor.width
  const bottom = anchor.top + anchor.height
  if (right + gap + card.width + margin <= viewport.width) {
    return { side: 'right', left: right + gap, top: clampY(anchor.top) }
  }
  if (anchor.left - gap - card.width >= margin) {
    return { side: 'left', left: anchor.left - gap - card.width, top: clampY(anchor.top) }
  }
  if (bottom + gap + card.height + margin <= viewport.height) {
    return { side: 'below', left: clampX(anchor.left), top: bottom + gap }
  }
  if (anchor.top - gap - card.height >= margin) {
    return { side: 'above', left: clampX(anchor.left), top: anchor.top - gap - card.height }
  }
  return center
}

/**
 * Which tour an (i) means right now: the first of `ids` whose screen is up,
 * else the last (the broadest). Most specific first — the Blueprint's one (i)
 * means an open block, a feature's diagram, or the map.
 */
export function pickGuide(ids: readonly GuideId[], onScreen: (id: GuideId) => boolean): GuideId | null {
  for (const id of ids) if (onScreen(id)) return id
  return ids[ids.length - 1] ?? null
}
