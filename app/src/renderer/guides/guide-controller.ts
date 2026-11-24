/**
 * WHEN THE GUIDE SPEAKS — one look a second at which screens are up, and the
 * pure decision in shared/guides.ts on what (if anything) to show.
 *
 * WHY A LOOK AND NOT EVENTS. The screens a tour belongs to open from many
 * places — a toolbar icon, a shortcut, the palette, a link in the chat, a
 * restored layout at launch. Hooking each would be a dozen call sites that
 * drift; asking "is it on screen?" has one answer. The look is a few
 * querySelector calls, skipped while the window is hidden, and it stops for
 * good once every tour has run (allowed-pattern #17: pay only for what someone
 * can see).
 *
 * TWO LOOKS IN A ROW. A screen counts as open only when it was up on the last
 * look too, so a pane flashing through on the way to another never triggers a
 * tour, and a screen that just opened has a second to settle first.
 *
 * Other parts of the app speak to it through document events, so nothing
 * imports the controller:
 *   flow:guide-replay   { id }  — a person asked for a tour (Settings, the ? button)
 *   flow:guide-current          — the ? button: the tour for what is on screen
 *   flow:guide-overview         — show the overview again
 *   flow:guides-changed         — the stored state changed elsewhere; read it again
 */
import {
  GUIDE_TOURS,
  guidesFinished,
  isGuideId,
  nextGuideAction,
  tourById,
  type GuideId,
  type GuidesState,
  type GuidesUpdate,
} from '../../shared/guides'
import { topmostModalOverlay } from '../modal-overlay'
import { firstOnScreen } from './guide-dom'
import { GuideOverview } from './guide-overview'
import { availableSteps, GuideTourView } from './guide-tour-view'

const LOOK_MS = 1000
/** How long a replay waits for its screen to come up. */
const REQUEST_WAIT_MS = 15_000

/**
 * The ? button's preference when several screens are up: the editor-area
 * screens first (the button sits on the editor's strip), the sidebar last.
 */
const CURRENT_ORDER: readonly GuideId[] = [
  'ask',
  'launchpad-menu',
  'launchpad-setup',
  'tasks',
  'block',
  'diagram',
  'blueprint',
  'browser',
  'settings',
  'changes',
  'drafts',
  'cards',
  'launchpad',
  'threads',
]

export class GuideController {
  #state: GuidesState | null = null
  #hasProject = false
  #lastOnScreen = new Set<GuideId>()
  #requested: { id: GuideId; until: number } | null = null
  #active: GuideTourView | GuideOverview | null = null
  #timer: ReturnType<typeof setInterval> | null = null
  #looks = 0

  async start(): Promise<void> {
    await this.#reload()
    document.addEventListener('flow:guide-replay', (event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id
      if (isGuideId(id)) this.replay(id)
    })
    document.addEventListener('flow:guide-current', () => this.replayCurrent())
    document.addEventListener('flow:guide-overview', () => this.showOverview())
    document.addEventListener('flow:guides-changed', () => void this.#reload())
    this.#ensureLooking()
  }

  /** Run one tour now, bringing its screen up first when it has a way to. */
  replay(id: GuideId): void {
    if (this.#active instanceof GuideTourView) this.#active.end('skipped')
    this.#requested = { id, until: Date.now() + REQUEST_WAIT_MS }
    const tour = tourById(id)
    if (firstOnScreen(tour.trigger) === null && tour.open !== undefined) {
      if ('event' in tour.open) document.dispatchEvent(new CustomEvent(tour.open.event))
      else document.querySelector<HTMLElement>(tour.open.click)?.click()
    }
    // A replay skips the two-look settle: the person is waiting for it.
    if (firstOnScreen(tour.trigger) !== null) this.#lastOnScreen.add(id)
    this.#ensureLooking()
    this.#look()
  }

  /** The ? button: the tour for the screen in front of the person. */
  replayCurrent(): void {
    for (const id of CURRENT_ORDER) {
      if (firstOnScreen(tourById(id).trigger) !== null) {
        this.replay(id)
        return
      }
    }
    document.dispatchEvent(new CustomEvent('flow:open-settings', { detail: { group: 'guides' } }))
  }

  showOverview(): void {
    if (this.#active !== null) return
    this.#openOverview()
  }

  async #reload(): Promise<void> {
    try {
      this.#state = await window.flow.settings.getGuides()
    } catch {
      this.#state = null // an older main without the channel: no guide at all
    }
    this.#ensureLooking()
  }

  async #update(update: GuidesUpdate): Promise<void> {
    try {
      this.#state = await window.flow.settings.setGuides(update)
      document.dispatchEvent(new CustomEvent('flow:guides-updated'))
    } catch {
      // The guide is a convenience: a failed write must not break the screen.
    }
  }

  #ensureLooking(): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => this.#look(), LOOK_MS)
  }

  #stopLooking(): void {
    if (this.#timer === null) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  #look(): void {
    const state = this.#state
    if (state === null) return
    if (document.visibilityState === 'hidden') return
    if (this.#requested !== null && Date.now() > this.#requested.until) this.#requested = null
    if (this.#requested === null && this.#active === null && guidesFinished(state)) {
      this.#stopLooking()
      return
    }
    this.#looks += 1
    if (!this.#hasProject && this.#looks % 5 === 1) void this.#checkProject()

    const dialog = topmostModalOverlay()
    const now = new Set<GuideId>()
    const inDialog: GuideId[] = []
    for (const tour of GUIDE_TOURS) {
      const at = firstOnScreen(tour.trigger)
      if (at === null) continue
      now.add(tour.id)
      if (dialog !== null && tour.inDialog === true && dialog.contains(at)) inDialog.push(tour.id)
    }
    const stable = [...now].filter((id) => this.#lastOnScreen.has(id))
    this.#lastOnScreen = now

    const action = nextGuideAction({
      state,
      busy: this.#active !== null,
      dialogOpen: dialog !== null,
      inDialog,
      hasProject: this.#hasProject,
      onScreen: stable,
      requested: this.#requested?.id ?? null,
    })
    if (action.kind === 'overview') this.#openOverview()
    else if (action.kind === 'tour') this.#openTour(action.id)
  }

  async #checkProject(): Promise<void> {
    try {
      this.#hasProject = (await window.flow.project.list()).length > 0
    } catch {
      this.#hasProject = false
    }
  }

  #openOverview(): void {
    const overview = new GuideOverview(this.#state?.enabled ?? true, (answer) => {
      this.#active = null
      void this.#update({ overviewSeen: true, enabled: answer.tips }).then(() => {
        if (answer.startTour) this.replay('threads')
      })
    })
    this.#active = overview
    overview.open()
  }

  #openTour(id: GuideId): void {
    const tour = tourById(id)
    const steps = availableSteps(tour)
    const wasRequested = this.#requested?.id === id
    if (steps.length === 0) {
      // Nothing of it is on screen yet (an empty board has no card to point
      // at, but it does have lanes — this is the rarer case of none at all).
      // Leave it unseen so it starts once there is something to show.
      if (wasRequested) this.#requested = null
      return
    }
    this.#requested = null
    const view = new GuideTourView(tour, steps, { keepFocus: tour.inDialog === true || tour.keepFocus === true }, () => {
      if (this.#active === view) this.#active = null
    })
    this.#active = view
    void this.#update({ seen: id })
    view.open()
  }
}

let controller: GuideController | null = null

/** Start the feature guide once, after the shell has mounted. */
export function startGuides(): void {
  if (controller !== null) return
  controller = new GuideController()
  void controller.start()
}
