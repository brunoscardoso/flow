// Source Control graph — lane layout from commit parents. Pure and DOM-free:
// the panel turns each row's segments into an SVG, and this module decides
// which lane every commit sits in and which lines run through, into and out of
// its row.
//
// THE MODEL. Walk the commits newest first, keeping `lanes`: slot i holds the
// hash that lane is waiting to reach. A commit takes the lane already waiting
// for it (or a free one if nothing is — a branch tip), every OTHER lane waiting
// for it ends here (a branch converging into its merge base), its first parent
// continues in its own lane, and each further parent either joins the lane
// already waiting for it or opens a new one (a merge's second line).
//
// Lanes keep their slot: nothing is compacted mid-walk, so a line that passes
// through a row is always straight, and the only curves are the ones that mean
// something — a merge leaving a node, or a branch arriving at one.
//
// Tolerant of order: a parent that already appeared above its child (clock
// skew in date order, or a page boundary) simply waits in its lane forever and
// is dropped at the end of the page — the graph never throws on odd history.

/** The commits the layout needs: identity and parents, display order. */
export interface GraphCommitInput {
  hash: string
  parents?: readonly string[]
}

export type GraphY = 'top' | 'mid' | 'bottom'

/** One line in a row's 22px cell, in lane coordinates. */
export interface GraphSegment {
  fromLane: number
  fromY: GraphY
  toLane: number
  toY: GraphY
  /** The lane whose colour the line takes. */
  colorLane: number
}

export interface GraphRow {
  hash: string
  /** The lane the commit's node sits in. */
  lane: number
  segments: GraphSegment[]
  /** Lanes still running below this row — what an expanded commit's file rows
   *  draw as straight lines so the graph does not break under them. */
  continuing: number[]
  /** More than one parent. */
  merge: boolean
  /** Nothing above was waiting for it — the tip of a line. */
  tip: boolean
}

export interface GraphLayout {
  rows: GraphRow[]
  /** Widest lane count any row used — the SVG width the panel reserves. */
  width: number
}

/** How many lane colours the theme defines; lanes cycle through them. */
export const GRAPH_COLOR_COUNT = 4

export function laneColorIndex(lane: number): number {
  return ((lane % GRAPH_COLOR_COUNT) + GRAPH_COLOR_COUNT) % GRAPH_COLOR_COUNT
}

function freeSlot(lanes: Array<string | null>, avoid: number): number {
  for (let i = 0; i < lanes.length; i += 1) {
    if (lanes[i] === null && i !== avoid) return i
  }
  return lanes.length === avoid ? avoid + 1 : lanes.length
}

export function layoutGraph(commits: readonly GraphCommitInput[]): GraphLayout {
  const lanes: Array<string | null> = []
  const rows: GraphRow[] = []
  let width = 1

  for (const commit of commits) {
    const parents = commit.parents ?? []
    let lane = lanes.indexOf(commit.hash)
    const tip = lane === -1
    if (tip) {
      lane = freeSlot(lanes, -1)
      while (lanes.length <= lane) lanes.push(null)
    }
    const before = lanes.slice()
    const segments: GraphSegment[] = []

    // Top half: everything arriving from above.
    for (let i = 0; i < before.length; i += 1) {
      const waiting = before[i]
      if (waiting === null || waiting === undefined) continue
      if (i === lane) {
        segments.push({ fromLane: i, fromY: 'top', toLane: i, toY: 'mid', colorLane: i })
      } else if (waiting === commit.hash) {
        // Another line ends here: a branch converging into this commit.
        segments.push({ fromLane: i, fromY: 'top', toLane: lane, toY: 'mid', colorLane: i })
        lanes[i] = null
      }
    }

    // Bottom half: the first parent continues in this lane…
    lanes[lane] = parents[0] ?? null
    if (parents[0] !== undefined) {
      segments.push({ fromLane: lane, fromY: 'mid', toLane: lane, toY: 'bottom', colorLane: lane })
    }
    // …and every further parent joins a waiting lane or opens one.
    for (const parent of parents.slice(1)) {
      let target = lanes.indexOf(parent)
      if (target === -1) {
        target = freeSlot(lanes, lane)
        while (lanes.length <= target) lanes.push(null)
        lanes[target] = parent
      }
      segments.push({ fromLane: lane, fromY: 'mid', toLane: target, toY: 'bottom', colorLane: target })
    }

    // Lines passing straight through (neither this commit nor ending here).
    for (let i = 0; i < before.length; i += 1) {
      const waiting = before[i]
      if (waiting === null || waiting === undefined || i === lane || waiting === commit.hash) continue
      segments.unshift({ fromLane: i, fromY: 'top', toLane: i, toY: 'bottom', colorLane: i })
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
    width = Math.max(width, before.length, lanes.length, lane + 1)
    const continuing: number[] = []
    lanes.forEach((waiting, i) => {
      if (waiting !== null) continuing.push(i)
    })
    rows.push({ hash: commit.hash, lane, segments, continuing, merge: parents.length > 1, tip })
  }
  return { rows, width }
}

/** Pixel geometry shared by the panel's SVG and its tests. */
export const GRAPH_LANE_PX = 12
export const GRAPH_LEFT_PX = 9
export const GRAPH_ROW_PX = 22

export function laneX(lane: number): number {
  return GRAPH_LEFT_PX + lane * GRAPH_LANE_PX
}

export function yOf(y: GraphY): number {
  return y === 'top' ? 0 : y === 'mid' ? GRAPH_ROW_PX / 2 : GRAPH_ROW_PX
}

/** An SVG path for one segment: straight when it stays in its lane, a curve when it moves. */
export function segmentPath(segment: GraphSegment): string {
  const x1 = laneX(segment.fromLane)
  const y1 = yOf(segment.fromY)
  const x2 = laneX(segment.toLane)
  const y2 = yOf(segment.toY)
  if (x1 === x2) return `M${x1} ${y1} L${x2} ${y2}`
  const midY = (y1 + y2) / 2
  return `M${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
}

/** SVG width for a layout, capped so a repository with many open lines cannot eat the row. */
export function graphWidthPx(width: number, maxLanes = 8): number {
  return laneX(Math.min(width, maxLanes) - 1) + GRAPH_LEFT_PX
}
