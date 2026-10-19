/**
 * Terminal split layout (#1133) — VS Code-style side-by-side terminals.
 *
 * The panel could only ever show ONE terminal: every host but the active tab's
 * was hidden, so comparing a server log against a test run meant flipping tabs
 * back and forth. This models the missing concept: terminals belong to GROUPS,
 * and a group's members are shown side by side as resizable panes. A lone
 * terminal is simply a group of one — the pre-split behaviour, unchanged.
 *
 * Pure and DOM-free (the repo's model-module convention): the panel owns the
 * hosts, <fl-split> owns the dragging, and this owns the answer to "which
 * terminals are on screen together, and in what order".
 */

/** Ordered groups; each group is an ordered list of terminal ids. */
export type SplitLayout = readonly (readonly string[])[]

/**
 * Panes per group. Not a technical limit — a fifth pane in a docked terminal
 * is a few characters wide, which is a worse answer than "open another group".
 */
export const MAX_SPLIT_PANES = 4

/** The group holding `terminalId`, or null when it isn't in the layout. */
export function groupOf(layout: SplitLayout, terminalId: string): readonly string[] | null {
  return layout.find((group) => group.includes(terminalId)) ?? null
}

/** A new terminal starts in its own group (today's behaviour). Idempotent. */
export function addTerminal(layout: SplitLayout, terminalId: string): SplitLayout {
  if (groupOf(layout, terminalId) !== null) return layout
  return [...layout, [terminalId]]
}

/**
 * Put `newId` beside `anchorId` — the Split action. It lands immediately after
 * the anchor, so the pane appears where the user is looking rather than at the
 * end of the row. An unknown anchor (or a full group) falls back to its own
 * group: splitting must never silently drop the new terminal.
 */
export function splitBeside(
  layout: SplitLayout,
  anchorId: string,
  newId: string,
): SplitLayout {
  const group = groupOf(layout, anchorId)
  if (group === null || group.length >= MAX_SPLIT_PANES) return addTerminal(layout, newId)
  const stripped = removeTerminal(layout, newId)
  return stripped.map((candidate) => {
    if (!candidate.includes(anchorId)) return candidate
    const next = [...candidate]
    next.splice(next.indexOf(anchorId) + 1, 0, newId)
    return next
  })
}

/** Drop a terminal; a group that empties disappears with it. */
export function removeTerminal(layout: SplitLayout, terminalId: string): SplitLayout {
  return layout
    .map((group) => group.filter((id) => id !== terminalId))
    .filter((group) => group.length > 0)
}

/** Whether the Split action should be offered for this terminal. */
export function canSplit(layout: SplitLayout, terminalId: string | null): boolean {
  if (terminalId === null) return false
  const group = groupOf(layout, terminalId)
  return group !== null && group.length < MAX_SPLIT_PANES
}

/**
 * The panes to show right now: the active terminal's group. Selecting a tab
 * outside the current group therefore switches to THAT terminal's group —
 * groups are implicit, so nothing has to be "left" or "entered".
 */
export function visiblePanes(
  layout: SplitLayout,
  activeId: string | null,
  isVisible: (terminalId: string) => boolean,
): string[] {
  const group = activeId === null ? null : groupOf(layout, activeId)
  return (group ?? []).filter(isVisible)
}

/**
 * Who takes focus when `terminalId` closes: its right-hand pane, else its
 * left-hand one — the same adjacency rule the tab strip uses (#408). Null when
 * it was alone, leaving the caller's cross-group fallback in charge.
 */
export function neighborInGroup(
  layout: SplitLayout,
  terminalId: string,
): string | null {
  const group = groupOf(layout, terminalId)
  if (group === null || group.length < 2) return null
  const index = group.indexOf(terminalId)
  return group[index + 1] ?? group[index - 1] ?? null
}

/** Drop everything not in `known` — terminals disposed elsewhere (a PTY exit,
 *  a scope change tearing tabs down) must not linger as phantom panes. */
export function pruneLayout(layout: SplitLayout, known: ReadonlySet<string>): SplitLayout {
  return layout
    .map((group) => group.filter((id) => known.has(id)))
    .filter((group) => group.length > 0)
}

// ── Divider ratios (#1294) ───────────────────────────────────────────────────
//
// The row advertises a resizable split, and the drag works — but renderPanes
// moves the hosts to the stash whenever the visible group changes, leaving
// <fl-split> with zero children. Its MutationObserver rebuilds and resets the
// sizes on any pane-COUNT change, so a tuned 82/18 came back 50/50 after a
// two-second visit to a sibling tab. Hiding the whole panel kept the ratio,
// which is what made it a bug rather than a missing feature: the same control
// was inconsistent with itself.
//
// Ratios are keyed by the row's MEMBERSHIP, not by position, so a row keeps
// its shape as long as it holds the same terminals.

/** localStorage key for the persisted ratios (survives relaunch, like #1059). */
export const SPLIT_SIZES_KEY = 'flow.terminal.splitSizes'

/** Stable key for a row: its members, order-independent. */
export function groupKey(group: readonly string[]): string {
  return [...group].sort().join(' ')
}

/** Ratios are only meaningful for the row they were measured on: same pane
 *  count, all finite and positive. Anything else is discarded rather than
 *  applied to a row it cannot describe. */
export function isUsableSizes(sizes: unknown, paneCount: number): sizes is number[] {
  return (
    Array.isArray(sizes) &&
    sizes.length === paneCount &&
    paneCount > 1 &&
    sizes.every((size) => typeof size === 'number' && Number.isFinite(size) && size > 0)
  )
}

/** Parse the persisted map, dropping anything malformed. Never throws — a
 *  corrupt entry must cost a ratio, never the terminal panel. */
export function parseSplitSizes(raw: string | null): Record<string, number[]> {
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number[]> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value) && isUsableSizes(value, value.length)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

// ── Arrangement across a reload (#1445) ──────────────────────────────────────
//
// The ratios above survive a reload; the layout they describe did not. `layout`
// and each tab's `customTitle` were renderer-closure state rebuilt from
// `terminal:list` as one unnamed group per terminal, so ⌘R collapsed a split row
// into plain tabs and reverted every name — leaving two identically-labelled
// tabs and no split, with no message. The shells were never in danger; what was
// lost was purely what the user had arranged, and the one piece that survived
// was the sizes, which by then had nothing left to size.

/** localStorage key for the persisted arrangement (rows + custom tab names). */
export const ARRANGEMENT_KEY = 'flow.terminal.arrangement'

export interface TerminalArrangement {
  /** Rows of terminal ids, in strip order. */
  layout: SplitLayout
  /** User-set tab names by terminal id — the ones rename exists to protect. */
  titles: Record<string, string>
}

/** Parse the persisted arrangement, dropping anything malformed. Never throws —
 *  a corrupt entry must cost an arrangement, never the terminal panel. */
export function parseArrangement(raw: string | null): TerminalArrangement {
  const empty: TerminalArrangement = { layout: [], titles: {} }
  if (raw === null) return empty
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
    const record = parsed as { layout?: unknown; titles?: unknown }
    const layout: string[][] = Array.isArray(record.layout)
      ? record.layout
          .filter((group): group is unknown[] => Array.isArray(group))
          .map((group) => group.filter((id): id is string => typeof id === 'string'))
          .filter((group) => group.length > 0)
      : []
    const titles: Record<string, string> = {}
    if (record.titles !== null && typeof record.titles === 'object' && !Array.isArray(record.titles)) {
      for (const [id, value] of Object.entries(record.titles as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > 0) titles[id] = value
      }
    }
    return { layout, titles }
  } catch {
    return empty
  }
}

/**
 * The layout to boot with: the saved rows, restricted to terminals that still
 * exist, plus anything live the save doesn't mention as its own group.
 *
 * Both halves matter. Terminal ids are per-process and a killed shell's id never
 * comes back, so an unfiltered restore would rebuild rows out of ghosts; and a
 * terminal created after the last save (or by another window) must still get a
 * tab rather than silently vanish because the arrangement didn't list it.
 */
export function restoreLayout(saved: SplitLayout, known: ReadonlySet<string>): SplitLayout {
  const restored = pruneLayout(saved, known)
  const placed = new Set(restored.flat())
  const newcomers = [...known].filter((id) => !placed.has(id)).map((id) => [id])
  return [...restored, ...newcomers]
}
