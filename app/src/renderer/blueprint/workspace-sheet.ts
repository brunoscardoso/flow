/**
 * The WORKSPACE SHEET — the board's root level when the project is in a
 * Workspace (decision `workspace-blueprint`, 2026-10-06). PURE, no DOM.
 *
 * WHAT IT DRAWS
 * =============
 * One COUNTRY per project — the selected thread's own project leads, the others
 * share a side column sized by the lines their features stand on — each in
 * its own colour (border, header band, cell outlines) with a clear GUTTER
 * between countries — independent projects side by side, never one grid. Inside
 * each country, that project's capabilities packed exactly the way the
 * Territory packs them (`squarify`, sorted by size). The header band says what
 * the project holds and how much of it is understood; a chip says how many
 * connections it has.
 *
 * WHAT IT DOES NOT OWN
 * ====================
 * The treemap arithmetic (`territory-layout.ts`), the "% understood" arithmetic
 * (the CLI's `understood.ts`, re-exported through `shared/understood.ts`), how
 * connections are routed (`workspace-links.ts`), and every colour value (the
 * board's stylesheet owns the palette; this module hands out SLOTS).
 *
 * NOTHING IS MERGED. Each country reads only its own project's graph.
 *
 * Deterministic and fail-soft: same map, same stage → same sheet; a project
 * that could not be read is a country that says so, never a missing one.
 */

import type {
  BlueprintConnectionsLearning,
  BlueprintWorkspaceGraph,
  BlueprintWorkspaceProject,
  ConnectionsLearningStatus,
} from '../../shared/ipc-contract'
import { featuresUnderstood, rollUpUnderstood, understoodPercent } from '../../shared/understood'
import {
  hasRoomForSummary,
  cellLabelClass,
  detailsFit,
  focusLayout,
  grownBy,
  inset,
  isRoomy,
  layoutTree,
  reindexTree,
  squarifyFocused,
  squarifyPlan,
  restingFolderTier,
  DETAILS_TARGET,
  FOCUS_MIN,
  FOCUS_OUTER_SHARE,
  type CellSize,
  type FocusFit,
  type Rect,
  type SliceTree,
} from './territory-layout'
import {
  formatCount,
  secondLineFor,
  sheetRect,
  standingProgress,
  summaryParts,
  DETAILS_INNER_MAX_SHARE,
  type FocusMode,
  type StageSize,
} from './territory-view'
import type { TerritoryLabelClass } from './territory-view'
import { cellFolders, folderSlice, type CellFolders } from './folder-rows-model'

/** How many hues the palette holds. A slot is `colorIndex mod` this. */
export const WORKSPACE_PALETTE_SIZE = 8
/** The clear space between two projects — wide enough to read as a border between places. */
export const WS_GUTTER = 14
/** The header band across the top of a country: name, what it holds, the chip. */
export const WS_BAND_H = 26
/** A country's own padding around its cells. */
export const WS_PAD = 6
/** The gap between two cells inside a country. */
export const WS_CELL_INSET = 1.5
/**
 * The smallest share of the sheet a project is drawn with. Sized by lines, a
 * small service beside a monolith is a sliver whose name cannot be printed; a
 * floor keeps every project a place you can read and press.
 */
export const WS_MIN_SHARE = 0.06
/**
 * The share of the sheet's long side the THREAD'S OWN project is drawn with.
 * The map is read from where the reader is working: the project their selected
 * thread belongs to is the big ground, and its siblings share a side column —
 * sized among themselves by code — however large each is next to it.
 */
export const WS_LEAD_SHARE = 0.7
/** Below this, a country has no room for cells — its band says it all. */
const MIN_INNER = 20
/**
 * The smallest a project is drawn while a feature in another project is grown
 * in place: its band, and a row of cells at the short-name tier.
 */
export const WS_FOCUS_MIN: CellSize = { w: 150, h: WS_BAND_H + WS_PAD + 48 }

/** The palette slot a project wears — stable, because its index is. */
export function colourSlot(colorIndex: number): number {
  const slot = Math.trunc(colorIndex) % WORKSPACE_PALETTE_SIZE
  return slot < 0 ? slot + WORKSPACE_PALETTE_SIZE : slot
}

export const NOT_ON_THIS_COMPUTER = 'Not on this computer'
export const COULD_NOT_READ = "Couldn't read this project"

/** One capability, drawn inside its project's country. */
export interface WorkspaceCell {
  /** `<project>|<feature id>` — unique across the sheet even if two projects share a slug. */
  key: string
  id: string
  project: string
  name: string
  understanding: 'none' | 'learning' | 'learned' | 'stale'
  rect: Rect
  labelClass: TerritoryLabelClass
  roomy: boolean
  /** `1.2k lines`, when there is room and it was measured. */
  sizeLine: string | null
  /**
   * THE SAME CELL THE PROJECT'S OWN BOARD DRAWS (user, 2026-10-06: "if I zoom
   * in only the project I can see the description, percentual learning
   * complete, etc"): its description, its `N files · M parts · K changes`
   * line, its path, and its parts-understood fraction — each from the same
   * helper the project board uses, so the two never disagree.
   */
  summary: string | null
  /** The description whatever the cell's size — what the hover reveals. */
  description: string | null
  secondLine: string | null
  /** The provenance path — only when the node has no folder rows (see `TerritoryCell.path`). */
  path: string | null
  /** Where it lives, exactly as the project board's cell carries it (`TerritoryCell.folders`). */
  folders: CellFolders | null
  progress: { done: number; total: number; of: 'parts' | 'files' } | null
}

/** One project's ground. */
export interface WorkspaceCountry {
  slug: string
  name: string
  description: string | null
  slot: number
  state: BlueprintWorkspaceProject['state']
  current: boolean
  /** The whole country, gutter already taken out. */
  rect: Rect
  band: Rect
  inner: Rect
  /** `4 features · 12k lines · 50% understood`, or '' when there is nothing to say. */
  meta: string
  /** Plain words about where the data came from, or null. */
  note: string | null
  /**
   * How many connections the project takes part in — said on hover only: the
   * Workspace's own count is on the Connections control, and a chip per
   * project repeated it (user, 2026-10-06: "we are being redundant").
   */
  connections: number
  /** False for a project that could not be read — there is nothing to zoom into. */
  zoomable: boolean
  cellKeys: string[]
}

export interface WorkspaceTitle {
  name: string
  /** `3 projects · 12 features · 41k lines · 4 connections`. */
  kicker: string
  understood: { done: number; total: number } | null
  /** `50% understood`, or ''. */
  figure: string
  /** The figure's hover: how many of how many. */
  figureTitle: string
}

/** What a project's area is counted in, decided once for the whole sheet. */
export type WorkspaceUnit = 'lines' | 'features'

export interface WorkspaceSheetView {
  title: WorkspaceTitle
  countries: WorkspaceCountry[]
  cells: WorkspaceCell[]
  sheet: Rect
  unit: WorkspaceUnit
  /** The foot's title block: what the sheet is, and what area means. */
  block: string
}

export interface WorkspaceSheetOptions {
  stage: StageSize
  /** Connections drawn — the chip steps aside for the ribbon's own count. */
  showConnections: boolean
  /**
   * THE HOVERED FEATURE, grown in place (plan cell-hover-diagram): its cell
   * key, or null. Its project takes `FOCUS_OUTER_SHARE` of the sheet and the
   * feature `FOCUS_SHARE` of its project — each still containing where it
   * was; the other projects and features shrink around them.
   */
  focus?: string | null
  /** The feature grown before `focus` — see `TerritoryOptions.previous`. */
  previous?: string | null
  /** How far `focus` grows — see `TerritoryOptions.focusMode`. Default `open`. */
  focusMode?: FocusMode
}

/**
 * WHAT A DETAILS GROW ADDS AROUND ITS CELL on the Workspace map: the gutter,
 * the band and padding, the cell's own gap, and room for a row or a column of
 * the project's other features at their floor.
 */
export function wsDetailsCountryTarget(cellTarget: CellSize, siblings: boolean): CellSize {
  return grownBy(cellTarget, {
    w: WS_GUTTER + WS_PAD * 2 + WS_CELL_INSET * 2 + (siblings ? FOCUS_MIN.w : 0),
    h: WS_GUTTER + WS_BAND_H + WS_PAD + WS_CELL_INSET * 2 + (siblings ? FOCUS_MIN.h : 0),
  })
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`
}

/** The cell key for a feature of a project — the ONE spelling. */
export function cellKey(project: string, id: string): string {
  return `${project}|${id}`
}

/**
 * THE UNIT IS A PROPERTY OF THE SHEET (the Territory's own rule, one level up).
 * Lines when every project that has capabilities has a known size — measured
 * here, or the last size a teammate's machine recorded; capabilities counted
 * otherwise, so no country is drawn to a scale its neighbour is not.
 */
export function workspaceUnit(projects: readonly BlueprintWorkspaceProject[]): WorkspaceUnit {
  return projects.every((project) => project.graph === null || project.totals.features === 0 || project.totals.lines !== null)
    ? 'lines'
    : 'features'
}

/** A project's header-band sentence. */
export function countryMeta(project: BlueprintWorkspaceProject): string {
  if (project.graph === null) return ''
  const pieces = [plural(project.totals.features, 'feature')]
  if (project.totals.lines !== null && project.totals.lines > 0) pieces.push(`${formatCount(project.totals.lines)} lines`)
  const percent = understoodPercent(project.totals.understood)
  if (percent !== null) pieces.push(`${String(percent)}% understood`)
  return pieces.join(' · ')
}

/** `3 connections`, or null for none. */
export function connectionsChip(count: number): string | null {
  return count > 0 ? plural(count, 'connection') : null
}

/** `6 of 12 features · 50%` — the strip's figure, in the board's own wording. */
export function understoodFigure(fraction: { done: number; total: number } | null): string {
  const percent = understoodPercent(fraction)
  if (fraction === null || percent === null) return ''
  return `${String(percent)}% understood`
}

/** What the short figure stands for, on hover. */
export function understoodFigureTitle(fraction: { done: number; total: number } | null): string {
  if (fraction === null) return ''
  return `${String(fraction.done)} of ${String(fraction.total)} features understood, across every project — drifted ones not counted`
}

function noteFor(project: BlueprintWorkspaceProject): string | null {
  if (project.state === 'unreadable') return COULD_NOT_READ
  if (project.state === 'remote') return NOT_ON_THIS_COMPUTER
  return null
}

function titleFor(graph: BlueprintWorkspaceGraph): WorkspaceTitle {
  const projects = graph.projects
  const readable = projects.filter((project) => project.graph !== null)
  const features = readable.reduce((sum, project) => sum + project.totals.features, 0)
  const understood = rollUpUnderstood(projects.map((project) => project.totals.understood))
  // A QUIET STRIP (user, 2026-10-06: "cleanup that header"): what the
  // Workspace holds, and how much of it is understood. Its size is the foot's
  // (area = lines of code), and connections and pairs checked live on the
  // Connections control, which is where they are acted on.
  const pieces = [plural(projects.length, 'project'), plural(features, 'feature')]
  return {
    name: graph.workspace?.name ?? 'Workspace',
    kicker: pieces.join(' · '),
    understood,
    figure: understoodFigure(understood),
    figureTitle: understoodFigureTitle(understood),
  }
}

/** `6 of 10 pairs checked` — how far connections learning has got; null when there is nothing to say. */
export function pairsChecked(learning: BlueprintConnectionsLearning | null): string | null {
  if (learning === null || learning.pairs === 0) return null
  return `${String(learning.learned)} of ${plural(learning.pairs, 'pair')} checked`
}

/** Why the Connections control is off when the links cannot be read. */
export const CONNECTIONS_UNREADABLE = "The connections between these projects couldn't be read, so they can't be drawn."

/**
 * The Workspace's ONE Connections control (user, 2026-10-06: "one button for
 * connections … a more dynamic experience"):
 *   · `unreadable` — the links could not be read; off, with the reason;
 *   · `learning`   — a run is going: "Learning connections · 3 of 10";
 *   · `learn`      — nothing to draw yet and pairs to check: "Learn connections";
 *   · `none`       — every pair it can check is checked and none connect;
 *   · `toggle`     — there are connections: show/hide them, with an attached
 *                    "Update" while some pairs changed since they were checked.
 */
/** How far a run has got, 0–100 — whole pairs only, never a guess. */
export function learningPercent(run: Pick<ConnectionsLearningStatus, 'done' | 'total'>): number {
  return run.total === 0 ? 0 : Math.round((run.done / run.total) * 100)
}

export type ConnectionsControlMode = 'unreadable' | 'learning' | 'learn' | 'none' | 'toggle'

export interface ConnectionsControlView {
  mode: ConnectionsControlMode
  label: string
  title: string
  /** The toggle's state (only meaningful for `toggle`). */
  pressed: boolean
  disabled: boolean
  /** The attached "Update" segment, or null. */
  update: { label: string; title: string } | null
}

function pairsWord(count: number): string {
  return plural(count, 'pair')
}

export function connectionsControlView(input: {
  run: ConnectionsLearningStatus | null
  learning: BlueprintConnectionsLearning | null
  /** Connections on the map — null when they could not be read. */
  links: number | null
  showing: boolean
  /** A project's display name, for the pair being checked. */
  projectName?: (slug: string) => string
}): ConnectionsControlView {
  const { run, learning, links } = input
  const error = run !== null && !run.running && run.error !== null ? ` ${run.error}` : ''
  const base = { pressed: false, disabled: false, update: null }
  if (links === null) return { ...base, mode: 'unreadable', label: 'Connections', title: CONNECTIONS_UNREADABLE, disabled: true }
  if (run?.running === true) {
    const name = input.projectName ?? ((slug: string) => slug)
    const now = run.current ?? null
    return {
      ...base,
      mode: 'learning',
      // SMALL: a spinner (drawn by the board) and the figure. The sentence is
      // the tooltip.
      label: run.total === 0 ? '…' : `${String(learningPercent(run))}%`,
      title:
        run.total === 0
          ? 'Learning connections — reading every project’s endpoints, calls and features'
          : `Learning connections — ${now === null ? 'checking' : `checking ${name(now[0])} ↔ ${name(now[1])}`}, ${String(run.done)} of ${String(run.total)} pairs done`,
      disabled: true,
    }
  }
  const pending = learning?.pending ?? null
  if (links === 0) {
    if (learning !== null && learning.pairs > 0 && pending === 0) {
      const waiting = learning.blocked > 0 ? ` ${pairsWord(learning.blocked)} wait for a project to be learned first.` : ''
      return {
        ...base,
        mode: 'none',
        label: 'No connections found',
        title: `Every pair Flow could check is checked, and none showed a connection.${waiting}${error}`,
        disabled: true,
      }
    }
    const checked = learning === null || learning.pairs === 0 ? '' : `${String(learning.learned)} of ${pairsWord(learning.pairs)} checked · `
    return { ...base, mode: 'learn', label: 'Learn connections', title: `${checked}Find how these projects talk to each other.${error}` }
  }
  const update =
    pending !== null && pending > 0
      ? {
          label: 'Update',
          title: `${pairsWord(pending)} changed since ${pending === 1 ? 'it was' : 'they were'} checked — check ${pending === 1 ? 'it' : 'them'} again`,
        }
      : null
  const checked = pairsChecked(learning)
  return {
    ...base,
    mode: 'toggle',
    label: `Connections · ${String(links)}`,
    title: `${input.showing ? 'Hide how these projects connect' : 'Show how these projects connect'}${checked === null ? '' : ` · ${checked}`}${error}`,
    pressed: input.showing,
    update,
  }
}

/** The rectangle `inset(rect, d)` was cut from. */
function outset(rect: Rect, d: number): Rect {
  return { x: rect.x - d, y: rect.y - d, w: rect.w + 2 * d, h: rect.h + 2 * d }
}

/** A country's rectangles, from the cell `squarify` gave it. */
function groundOf(placed: Rect): { rect: Rect; band: Rect; inner: Rect } {
  const rect = inset(placed, WS_GUTTER / 2)
  const band: Rect = { x: rect.x, y: rect.y, w: rect.w, h: Math.min(WS_BAND_H, rect.h) }
  const inner: Rect = {
    x: rect.x + WS_PAD,
    y: rect.y + WS_BAND_H,
    w: Math.max(0, rect.w - WS_PAD * 2),
    h: Math.max(0, rect.h - WS_BAND_H - WS_PAD),
  }
  return { rect, band, inner }
}

/** Pack one project's capabilities into its country — the Territory's own rule. */
function cellsOf(
  project: BlueprintWorkspaceProject,
  inner: Rect,
  focus: string | null = null,
  before: Rect | null = null,
  was: Rect | null = null,
  shrunk = false,
  details = false,
): WorkspaceCell[] {
  if (project.graph === null || inner.w < MIN_INNER || inner.h < MIN_INNER) return []
  const cores = project.graph.nodes.filter((node) => node.kind === 'core')
  // ONE UNIT PER COUNTRY: lines when every capability was measured (or has a
  // last-known size), anchors otherwise — never a mix inside one packing.
  const byLines = cores.every((node) => node.size !== undefined)
  const focusIndex = focus === null ? -1 : cores.findIndex((node) => cellKey(project.slug, node.id) === focus)
  const fits = before !== null && before.w >= MIN_INNER && before.h >= MIN_INNER
  const items = cores.map((node) => ({ node, value: byLines ? (node.size?.lines ?? 0) : node.anchorCount }))
  // A DETAILS GROW asks only for what its details need (`detailsFit`).
  let fit: FocusFit | null = null
  if (details && focusIndex >= 0) {
    const now = was ?? (fits && before !== null ? squarifyFocused(items, before, -1).find((entry) => entry.node === cores[focusIndex]) : undefined)
    if (now !== undefined) {
      fit = detailsFit(inner, now, grownBy(DETAILS_TARGET, { w: WS_CELL_INSET * 2, h: WS_CELL_INSET * 2 }), DETAILS_INNER_MAX_SHARE)
    }
  }
  const placed = squarifyFocused(items, inner, focusIndex, {
    ...(focusIndex >= 0 && fits ? { from: before } : {}),
    ...(focusIndex >= 0 && was !== null ? { was } : {}),
    // A PROJECT THAT SHRANK for another's feature keeps its own names.
    ...(focusIndex < 0 && shrunk ? { floor: FOCUS_MIN } : {}),
    ...(fit === null ? {} : { share: fit.share, minSide: fit.minSide, maxShare: DETAILS_INNER_MAX_SHARE }),
  })
  const nodes = project.graph.nodes
  const standing = standingProgress(nodes)
  return placed.map((entry) => {
    const rect = inset({ x: entry.x, y: entry.y, w: entry.w, h: entry.h }, WS_CELL_INSET)
    const roomy = isRoomy(rect.w, rect.h)
    const lines = entry.node.size?.lines
    const node = entry.node
    const parts = nodes.filter((other) => other.kind === 'part' && other.partOf === node.slug).length
    const changes = nodes.filter((other) => other.kind === 'child' && other.parent === node.id).length
    const text = summaryParts(node.summary)
    // CALM AT REST: one home line at the roomy tier; the rows wait for the details.
    const folders = cellFolders(folderSlice(node.folders, node.name, project.name), restingFolderTier(rect.w, rect.h), 0)
    return {
      key: cellKey(project.slug, entry.node.id),
      id: entry.node.id,
      project: project.slug,
      name: entry.node.name,
      understanding: entry.node.understanding,
      rect,
      labelClass: cellLabelClass(rect.w, rect.h),
      roomy,
      sizeLine: roomy && lines !== undefined && lines > 0 ? `${formatCount(lines)} lines` : null,
      // At rest the description shows where there is room; the rows are the hover's details.
      summary: hasRoomForSummary(rect.w, rect.h) ? text.about : null,
      description: text.about,
      secondLine: roomy
        ? secondLineFor({ kind: 'feature', childCount: parts, changeCount: changes, anchorCount: node.anchorCount, active: false, files: node.size?.files ?? 0 })
        : null,
      path: roomy && folders === null ? text.path : null,
      folders,
      progress: standing.get(node.id) ?? null,
    }
  })
}

interface PlacedProject {
  project: BlueprintWorkspaceProject
  x: number
  y: number
  w: number
  h: number
}

/** The countries' cuts: a tree over `projects`' indices, with each one's weight. */
interface CountryPlan {
  tree: SliceTree
  weights: number[]
  order: number[]
}

/** Projects packed by size, with the floor that keeps a small one readable. */
function sizePlan(
  projects: readonly BlueprintWorkspaceProject[],
  indices: readonly number[],
  rect: Rect,
  valueOf: (project: BlueprintWorkspaceProject) => number,
): CountryPlan | null {
  const values = indices.map((index) => valueOf(projects[index] as BlueprintWorkspaceProject))
  const total = values.reduce((sum, value) => sum + value, 0)
  const floor = total * WS_MIN_SHARE
  const plan = squarifyPlan(
    values.map((value) => Math.max(floor, value)),
    rect,
  )
  if (plan.tree === null) return null
  const weights: number[] = []
  plan.weights.forEach((weight, i) => {
    weights[indices[i] as number] = weight
  })
  return { tree: reindexTree(plan.tree, indices), weights, order: plan.order.map((i) => indices[i] as number) }
}

/**
 * WHERE EACH PROJECT GOES, as cuts. With a current project (the selected
 * thread's) and siblings beside it, the current one leads: it takes
 * {@link WS_LEAD_SHARE} of the sheet's long side, first in reading order, and
 * the others are packed by size into what is left. Without one — nothing
 * selected, or a Workspace of one — every project is sized by its code.
 */
function countryPlan(
  projects: readonly BlueprintWorkspaceProject[],
  sheet: Rect,
  valueOf: (project: BlueprintWorkspaceProject) => number,
): CountryPlan | null {
  const all = projects.map((_, index) => index)
  const lead = projects.findIndex((project) => project.current)
  const rest = all.filter((index) => index !== lead)
  if (lead < 0 || rest.length === 0) return sizePlan(projects, all, sheet, valueOf)
  const wide = sheet.w >= sheet.h
  const restRect: Rect = wide
    ? { x: sheet.x + sheet.w * WS_LEAD_SHARE, y: sheet.y, w: sheet.w * (1 - WS_LEAD_SHARE), h: sheet.h }
    : { x: sheet.x, y: sheet.y + sheet.h * WS_LEAD_SHARE, w: sheet.w, h: sheet.h * (1 - WS_LEAD_SHARE) }
  const others = sizePlan(projects, rest, restRect, valueOf)
  if (others === null) return sizePlan(projects, all, sheet, valueOf)
  const restWeight = rest.reduce((sum, index) => sum + (others.weights[index] ?? 0), 0)
  const weights = [...others.weights]
  weights[lead] = (restWeight * WS_LEAD_SHARE) / (1 - WS_LEAD_SHARE)
  return {
    tree: { axis: wide ? 'x' : 'y', children: [{ leaf: lead }, others.tree] },
    weights,
    order: [lead, ...others.order],
  }
}

/**
 * WHERE EACH PROJECT GOES — the plain map (see `countryPlan`), or, with
 * `focus` naming a project's index, that project grown in place to
 * `FOCUS_OUTER_SHARE` of the sheet and the others shrunk around it.
 */
export function placeCountries(
  projects: readonly BlueprintWorkspaceProject[],
  sheet: Rect,
  valueOf: (project: BlueprintWorkspaceProject) => number,
  focus = -1,
  was?: Rect,
  fit?: (plain: Rect) => FocusFit | null,
): PlacedProject[] {
  const plan = countryPlan(projects, sheet, valueOf)
  if (plan === null || sheet.w <= 0 || sheet.h <= 0) return []
  const plainRects = layoutTree(plan.tree, sheet, plan.weights)
  const now = was ?? plainRects[focus]
  const asked = focus < 0 || fit === undefined || now === undefined ? null : fit(now)
  const rects =
    focus < 0
      ? plainRects
      : focusLayout(plan.tree, plan.weights, sheet, focus, {
          share: FOCUS_OUTER_SHARE,
          min: WS_FOCUS_MIN,
          ...(was === undefined ? {} : { was }),
          ...(asked === null ? {} : { share: asked.share, minSide: asked.minSide, maxShare: FOCUS_OUTER_SHARE }),
        })
  return plan.order.map((index) => ({ project: projects[index] as BlueprintWorkspaceProject, ...(rects[index] as Rect) }))
}

/**
 * Build the Workspace sheet. The current project leads (see
 * {@link placeCountries}); the others are packed largest first; a project that
 * could not be read is drawn at the floor share with its note and no cells.
 */
export function buildWorkspaceSheet(graph: BlueprintWorkspaceGraph, options: WorkspaceSheetOptions): WorkspaceSheetView {
  const sheet = sheetRect(options.stage)
  const unit = workspaceUnit(graph.projects)
  const valueOf = (project: BlueprintWorkspaceProject): number =>
    project.graph === null ? 0 : unit === 'lines' ? (project.totals.lines ?? 0) : project.totals.features
  const focus = options.focus ?? null
  const focusProject = focus === null ? -1 : graph.projects.findIndex((project) => focus.startsWith(`${project.slug}|`))
  // WHERE EACH PROJECT WAS before the focus — the cuts its features regrow in.
  const plainInner = new Map(
    placeCountries(graph.projects, sheet, valueOf).map((entry) => [entry.project.slug, groundOf(entry).inner]),
  )
  // WHERE THE GROWN FEATURE IS DRAWN NOW, when the grow moves to it from
  // another: the map around the previous one, read back (drawn inset).
  const previous = options.previous ?? null
  const prior =
    focus !== null && previous !== null && previous !== focus
      ? buildWorkspaceSheet(graph, { ...options, focus: previous, previous: null })
      : null
  const priorCell = prior?.cells.find((cell) => cell.key === focus) ?? null
  const priorCountry = priorCell === null ? null : (prior?.countries.find((country) => country.slug === priorCell.project) ?? null)
  const details = options.focusMode === 'details'
  const focusSiblings = (graph.projects[focusProject]?.graph?.nodes.filter((node) => node.kind === 'core').length ?? 0) > 1
  const placed = placeCountries(
    graph.projects,
    sheet,
    valueOf,
    focusProject,
    priorCountry === null ? undefined : outset(priorCountry.rect, WS_GUTTER / 2),
    details ? (now) => detailsFit(sheet, now, wsDetailsCountryTarget(DETAILS_TARGET, focusSiblings), FOCUS_OUTER_SHARE) : undefined,
  )
  const countries: WorkspaceCountry[] = []
  const cells: WorkspaceCell[] = []
  for (const entry of placed) {
    const { project } = entry
    const ground = groundOf({ x: entry.x, y: entry.y, w: entry.w, h: entry.h })
    const inside = cellsOf(
      project,
      ground.inner,
      focus,
      plainInner.get(project.slug) ?? null,
      priorCell === null || priorCell.project !== project.slug ? null : outset(priorCell.rect, WS_CELL_INSET),
      focusProject >= 0,
      details,
    )
    cells.push(...inside)
    countries.push({
      slug: project.slug,
      name: project.name,
      description: project.description,
      slot: colourSlot(project.colorIndex),
      state: project.state,
      current: project.current,
      ...ground,
      meta: countryMeta(project),
      note: noteFor(project),
      connections: project.connections,
      zoomable: project.graph !== null,
      cellKeys: inside.map((cell) => cell.key),
    })
  }
  return {
    title: titleFor(graph),
    countries,
    cells,
    sheet,
    unit,
    block: ['Workspace', unit === 'lines' ? 'area = lines of code' : 'area = features (a project’s size is not known yet)', graph.workspace?.name ?? '']
      .filter((part) => part.length > 0)
      .join(' · '),
  }
}

/** A project's own understood figure — the same function the CLI used for its band. */
export function projectUnderstood(project: BlueprintWorkspaceProject): { done: number; total: number } | null {
  return project.graph === null ? null : featuresUnderstood(project.graph.nodes)
}

/**
 * Should the board open at the Workspace?
 *
 * Only with a map that has somewhere to go: two or more projects. A Workspace
 * of one is the project itself, and a sheet holding one country that must be
 * pressed to see anything is a step with nothing on it — the board opens on
 * the project, with the Workspace still one crumb up.
 */
export function workspaceIsRoot(graph: BlueprintWorkspaceGraph | null): boolean {
  return graph !== null && graph.available && graph.projects.length >= 2
}
