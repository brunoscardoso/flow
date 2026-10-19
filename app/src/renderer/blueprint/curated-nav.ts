/**
 * Curated view navigation (feature-view #6) — PURE, no DOM.
 *
 * What makes the view an experience rather than a page: a trail showing where
 * you are and how to get back, and a phase ladder that answers "what does phase
 * 3 actually touch?" by lighting those components and dimming the rest.
 *
 * THE LADDER LIGHTS, IT NEVER FILTERS
 * ===================================
 * Selecting a phase dims the untouched components instead of removing them.
 * Removing would re-lay-out the diagram on every selection, and the question
 * being asked — "what does this phase touch?" — is only answerable against the
 * whole picture. A dimmed card still says "this exists and this phase leaves it
 * alone", which is half the answer.
 *
 * AN EMPTY SELECTION DIMS NOTHING. A phase that touches no component, or no
 * selection at all, lights everything — never invent a highlight, and never
 * present a blank diagram as an answer.
 */
import type { CuratedLevel, CuratedView } from './curated-view'

/** One step of the trail. The first is always the root. */
export interface Crumb {
  /** Level id — `root` for the first. */
  id: string
  title: string
  /** True for the level currently on the stage. */
  current: boolean
}

/** One rung of the phase ladder. */
export interface PhaseRung {
  phase: number
  /** Components this phase touches. */
  count: number
}

/**
 * The trail from the root to wherever the reader has drilled.
 *
 * Always includes the root, so there is always a way back — a drilled view with
 * no visible exit is the one-way-door complaint in a smaller shape.
 */
export function curatedCrumbs(view: CuratedView | null, trail: readonly string[]): Crumb[] {
  if (view === null) return []
  const root = view.views['root']
  if (root === undefined) return []
  const crumbs: Crumb[] = [{ id: 'root', title: root.title, current: trail.length === 0 }]
  trail.forEach((id, index) => {
    const level = view.views[id]
    if (level === undefined) return
    crumbs.push({ id, title: level.title, current: index === trail.length - 1 })
  })
  return crumbs
}

/** The phases this level's components claim, ascending, with their weights. */
export function curatedLadder(level: CuratedLevel): PhaseRung[] {
  const counts = new Map<number, number>()
  for (const node of level.nodes) {
    for (const phase of node.phases ?? []) {
      if (!Number.isFinite(phase)) continue
      counts.set(phase, (counts.get(phase) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([phase, count]) => ({ phase, count }))
}

/**
 * Which components a phase lights, and which it dims.
 *
 * `null` (nothing selected) lights everything. A phase that touches nothing
 * also lights everything rather than blanking the diagram — the honest reading
 * of "this phase touches none of these" is not "these do not exist".
 */
export function phaseHighlight(
  level: CuratedLevel,
  phase: number | null,
): { lit: string[]; dimmed: string[] } {
  const all = level.nodes.map((node) => node.id)
  if (phase === null) return { lit: all, dimmed: [] }
  const lit: string[] = []
  const dimmed: string[] = []
  for (const node of level.nodes) {
    ;((node.phases ?? []).includes(phase) ? lit : dimmed).push(node.id)
  }
  if (lit.length === 0) return { lit: all, dimmed: [] }
  return { lit, dimmed }
}

/**
 * A wire is lit only when BOTH its ends are.
 *
 * A wire with one lit end would read as "this phase changes this connection",
 * which is a different and stronger claim than "this phase touches a component
 * at one end of it".
 */
export function litWire(from: string, to: string, lit: ReadonlySet<string>): boolean {
  return lit.has(from) && lit.has(to)
}
