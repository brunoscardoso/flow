/**
 * THE ICON TABLE — path data only, no DOM.
 *
 * Split from `fl-icon.ts` because that file extends HTMLElement, and this
 * app's jest runs under a node environment: a module that touches the DOM
 * cannot be imported by a test at all. The glyph shapes are the part worth
 * pinning (one of them was wrong in a way only a test would keep honest), so
 * they live where a test can reach them.
 *
 * Stark style: 16x16 viewBox, stroke-based, currentColor.
 */

export const ICON_PATHS = {
  'chevron-right': 'M6 3.5 L10.5 8 L6 12.5',
  // The mirror of chevron-right, on the same 16-box, for a strip that grows
  // sideways rather than a list that grows down.
  'chevron-left': 'M10 3.5 L5.5 8 L10 12.5',
  'chevron-down': 'M3.5 6 L8 10.5 L12.5 6',
  'chevron-up': 'M3.5 10 L8 5.5 L12.5 10',
  close: 'M4 4 L12 12 M12 4 L4 12',
  plus: 'M8 3 L8 13 M3 8 L13 8',
  search: 'M10.5 10.5 L14 14 M7 11.5 A4.5 4.5 0 1 0 7 2.5 A4.5 4.5 0 0 0 7 11.5',
  file: 'M4 1.5 H9.5 L12.5 4.5 V14.5 H4 Z M9.5 1.5 V4.5 H12.5',
  folder: 'M1.5 3.5 H6 L7.5 5.5 H14.5 V13 H1.5 Z',
  'folder-open': 'M1.5 3.5 H6 L7.5 5.5 H13 V6.5 M1.5 13 L3 6.5 H14.5 L13 13 Z M1.5 3.5 V13',
  terminal: 'M2 3 H14 V13 H2 Z M4.5 6 L7 8.5 L4.5 11 M8.5 11 H11.5',
  // A pencil on a 16-box: the nib at lower-left, the body running up to the
  // right, and the ferrule line across it. Stroked like every other glyph here
  // (no fill), so it inherits colour and reads at 12px.
  pencil: 'M3 13 L3 10.5 L10.5 3 L13 5.5 L5.5 13 Z M9 4.5 L11.5 7',
  // A Workspace: three stacked layers — projects grouped into one place. The
  // top layer is a full rhombus, the two below show only their lower edges.
  layers: 'M8 2 L14.5 5.25 L8 8.5 L1.5 5.25 Z M1.5 8 L8 11.25 L14.5 8 M1.5 10.75 L8 14 L14.5 10.75',
  // Join a Workspace: a chain link — two interlocked links, "connect to an
  // existing one" (user's pick, 2026-10-06). Stroked like the rest of the set.
  link:
    'M6.67 8.67 A3.33 3.33 0 0 0 11.7 9.03 L13.7 7.03 A3.33 3.33 0 0 0 8.99 2.32 L7.84 3.46 M9.33 7.33 A3.33 3.33 0 0 0 4.3 6.97 L2.3 8.97 A3.33 3.33 0 0 0 7.01 13.68 L8.15 12.54',
  // A bin on a 16-box: lid line with its handle, the tapered body, two ribs.
  trash: 'M2.5 4 H13.5 M6 4 V2.5 H10 V4 M3.5 4 L4.5 14 H11.5 L12.5 4 M6.5 6.5 V11.5 M9.5 6.5 V11.5',
  'git-branch':
    'M4.5 4.5 V11.5 M4.5 4.5 A1.5 1.5 0 1 0 4.5 1.5 A1.5 1.5 0 0 0 4.5 4.5 M4.5 14.5 A1.5 1.5 0 1 0 4.5 11.5 A1.5 1.5 0 0 0 4.5 14.5 M11.5 6.5 A1.5 1.5 0 1 0 11.5 3.5 A1.5 1.5 0 0 0 11.5 6.5 M11.5 6.5 C11.5 9 9 10 4.5 10',
  // A merge glyph: a side branch curving down into the main line near its lower
  // commit — reads as "conflicts merging in" for the conflict panel controls.
  // A FOLDER ON A BRANCH: a branch line, a commit on it, and the working folder
  // hanging from that commit. The folder is the dominant shape because a
  // worktree IS a directory; the line above says which branch it is on.
  //
  // IT WAS TWO OFFSET RECTANGLES, which is the duplicate icon in every other
  // application — so beside `git-branch` it read as copy-paste rather than as a
  // working tree (user, 2026-09-17). The first redraw of this had two nodes
  // floating above the folder; at 15px they merged into its top edge, so it is
  // one node and a short stem instead — three strokes, and the silhouette
  // survives the size.
  checkouts:
    'M6.6 3 H14 M6.6 3 A1.6 1.6 0 1 1 3.4 3 A1.6 1.6 0 1 1 6.6 3 M5 4.6 V6.2 M1.5 6.2 H5.2 L6.5 7.7 H14.5 V13.8 H1.5 Z',
  'git-merge':
    'M4.5 5 V11 M4.5 5 A1.5 1.5 0 1 0 4.5 2 A1.5 1.5 0 0 0 4.5 5 M4.5 14 A1.5 1.5 0 1 0 4.5 11 A1.5 1.5 0 0 0 4.5 14 M11.5 5 A1.5 1.5 0 1 0 11.5 2 A1.5 1.5 0 0 0 11.5 5 M11.5 5 C11.5 8.5 6 8.5 4.5 11',
  message: 'M2 3 H14 V11 H8 L5 14 V11 H2 Z',
  check: 'M3 8.5 L6.5 12 L13 4.5',
  circle: 'M8 13.5 A5.5 5.5 0 1 0 8 2.5 A5.5 5.5 0 0 0 8 13.5',
  dot: 'M8 10 A2 2 0 1 0 8 6 A2 2 0 0 0 8 10',
  warning: 'M8 2 L15 13.5 H1 Z M8 6.5 V10 M8 11.5 V12',
  error:
    'M8 13.5 A5.5 5.5 0 1 0 8 2.5 A5.5 5.5 0 0 0 8 13.5 M5.8 5.8 L10.2 10.2 M10.2 5.8 L5.8 10.2',
  info: 'M8 13.5 A5.5 5.5 0 1 0 8 2.5 A5.5 5.5 0 0 0 8 13.5 M8 7 V11 M8 5 V5.5',
  'sidebar-left': 'M2 3 H14 V13 H2 Z M5.5 3 V13',
  'sidebar-right': 'M2 3 H14 V13 H2 Z M10.5 3 V13',
  // Two diagonal arrows pointing OUT (the right side takes the whole width),
  // and the same pair pointing IN (give the chat its column back).
  'expand-diagonal': 'M9.5 2.5 H13.5 V6.5 M6.5 13.5 H2.5 V9.5 M13.5 2.5 L9 7 M2.5 13.5 L7 9',
  'collapse-diagonal': 'M13.5 6.5 H9.5 V2.5 M2.5 9.5 H6.5 V13.5 M9.5 6.5 L14 2 M6.5 9.5 L2 14',
  'panel-bottom': 'M2 3 H14 V13 H2 Z M2 9.5 H14',
  'more-horizontal': 'M4 8 H4.01 M8 8 H8.01 M12 8 H12.01',
  map: 'M1.5 4 L6 2 L10 4 L14.5 2 V12 L10 14 L6 12 L1.5 14 Z M6 2 V12 M10 4 V14',
  refresh: 'M13.5 8 A5.5 5.5 0 1 1 11.6 3.9 M11.5 1.5 L11.8 4.2 L9 4.5',
  spinner: 'M8 2.5 A5.5 5.5 0 0 1 13.5 8',
  // A COG: a toothed ring around a hub.
  //
  // This was a centred circle with eight radial ticks floating around it, which
  // is the universal glyph for BRIGHTNESS, not for settings — the teeth have to
  // be attached to the ring or the eye reads rays. Six teeth rather than eight:
  // at the 15px this renders at, eight leaves the gaps between them narrower
  // than the 1.2px stroke and the ring fills in to a blob.
  settings:
    'M6.24 1.43 L9.76 1.43 L9.84 3.67 L10.83 4.25 L12.81 3.19 L14.57 6.24 L12.66 7.43 L12.66 8.57 L14.57 9.76 L12.81 12.81 L10.83 11.75 L9.84 12.33 L9.76 14.57 L6.24 14.57 L6.16 12.33 L5.17 11.75 L3.19 12.81 L1.43 9.76 L3.34 8.57 L3.34 7.43 L1.43 6.24 L3.19 3.19 L5.17 4.25 L6.16 3.67 Z M5.80 8.00 A2.2 2.2 0 1 0 10.20 8.00 A2.2 2.2 0 1 0 5.80 8.00',
  // A head-on thumbtack: top bar, tapered body, needle.
  pin: 'M5 2.5 H11 M6.2 2.5 L5.8 8 H10.2 L9.8 2.5 M8 8 V13.5',
  // A forward slash on a baseline — the character you actually type to reach a
  // command. `checklist` was standing in for this and read as tasks, which is a
  // different thing one button away on the same row.
  slash: 'M10.5 2.5 L5.5 13.5',
  // A lidded box with a pull slot — the archive verb, distinct from `folder`
  // (which is a place) and from `square` (which is a checkbox).
  archive: 'M1.8 3.5 H14.2 V6 H1.8 Z M3 6 V13 H13 V6 M6.3 8.6 H9.7',
  // AN INBOX TRAY: a box with a dipped front edge and two stacked lines above
  // it. Distinct from `archive` (a lidded box — things put AWAY) and from
  // `folder` (a place): this one is "what has arrived for me", which is exactly
  // what the board's Remote column shows.
  inbox: 'M1.8 8.5 H5 L6.2 10.6 H9.8 L11 8.5 H14.2 V13 H1.8 Z M1.8 8.5 L3.6 3 H12.4 L14.2 8.5',
  // A checklist: two ticked rows + a plain row — reads clearly as "tasks".
  checklist:
    'M2 4.3 L3.3 5.6 L5.4 3 M7.5 4.3 H14 M2 9 L3.3 10.3 L5.4 7.7 M7.5 9 H14 M7.5 13 H12',
  // An empty checkbox — the Todo lane glyph, clearly distinct from a status dot.
  square: 'M3.5 3.5 H12.5 V12.5 H3.5 Z',
  // A checkbox with a center mark — the Doing lane glyph (in progress).
  'square-dot': 'M3.5 3.5 H12.5 V12.5 H3.5 Z M8 9.3 A1.3 1.3 0 1 0 8 6.7 A1.3 1.3 0 0 0 8 9.3',
  // A checked checkbox — the Done lane glyph.
  'check-square': 'M12.5 7 V12.5 H3.5 V3.5 H10 M5.5 8 L7.5 10 L13 4',
  // A horizontal bar — "unstage / remove", the counterpart to plus.
  minus: 'M3 8 L13 8',
  // A discard / undo arrow: an arrowhead pointing left over a shaft that curves
  // back down — reads as "revert this change to HEAD".
  discard: 'M5.5 4 L2.5 7 L5.5 10 M2.5 7 H9.5 A3.5 3.5 0 0 1 9.5 14 H7',
  // A brain: two mirrored bumpy hemispheres joined top and bottom around a
  // central fissure — the "Knowledge search" glyph for brain-CLI tool calls.
  brain:
    'M8 3.2 C7.2 2 5.2 2 4.4 3.2 C3 3.3 2.2 4.8 2.8 6 C1.9 7 2.2 8.8 3.4 9.4 C3.4 11 5 12 6.5 11.4 L8 12.8 M8 3.2 C8.8 2 10.8 2 11.6 3.2 C13 3.3 13.8 4.8 13.2 6 C14.1 7 13.8 8.8 12.6 9.4 C12.6 11 11 12 9.5 11.4 L8 12.8 M8 3.2 V12.8',
  // Sparkles — the "AI / generate" glyph (replaces the ✨ emoji): a four-point
  // star with a smaller companion spark.
  sparkles:
    'M8 2.2 L9.1 6.1 L13 7.2 L9.1 8.3 L8 12.2 L6.9 8.3 L3 7.2 L6.9 6.1 Z M12.3 10.8 L12.7 12.1 L14 12.5 L12.7 12.9 L12.3 14.2 L11.9 12.9 L10.6 12.5 L11.9 12.1 Z',
  // A pane split down the middle — "split terminal" (#1133): the frame with a
  // divider, the right half kept clear so it reads as the NEW pane.
  'split-horizontal': 'M2 3 H14 V13 H2 Z M8 3 V13',
  // THREE LINES NARROWING DOWNWARD — "filter this list", the glyph Cursor puts
  // on the same control. Not a funnel: a funnel is a shape with sides, and at
  // the 12px this renders at its walls close into a solid wedge. Centred rather
  // than left-aligned so it stays symmetric beside the + it sits next to.
  filter: 'M2.5 4.5 H13.5 M4.5 8 H11.5 M6.5 11.5 H9.5',
  // A globe: a circle with an equator and two curved meridians — the embedded
  // browser tab's glyph (distinct from `map`, which is the blueprint).
  globe:
    'M8 13.5 A5.5 5.5 0 1 0 8 2.5 A5.5 5.5 0 0 0 8 13.5 M2.5 8 H13.5 M8 2.5 C10.2 4.5 10.2 11.5 8 13.5 C5.8 11.5 5.8 4.5 8 2.5',
  // A crosshair with a centre ring — "inspect element" (hover-to-tag mode).
  inspect: 'M8 1.8 V4.5 M8 11.5 V14.2 M1.8 8 H4.5 M11.5 8 H14.2 M8 10 A2 2 0 1 0 8 6 A2 2 0 0 0 8 10',
  // A solid disc inside a ring — the recording mark every device has used for
  // fifty years. Deliberately NOT a bug or a wrench: this does not find faults,
  // it records a window of time. It sits beside `inspect` in the browser
  // toolbar, so the two must not read alike at 14px — a ring around a SOLID
  // centre against a crosshair around a hollow one.
  //
  // The ring only; the centre is in ICON_FILL_PATHS below, because this
  // renderer strokes and does not fill. Drawn as two concentric strokes (the
  // first attempt) it read as a weak double ring at 14px and said nothing.
  record: 'M8 14.2 A6.2 6.2 0 1 0 8 1.8 A6.2 6.2 0 0 0 8 14.2',
} as const satisfies Record<string, string>

/**
 * Sub-paths drawn FILLED rather than stroked.
 *
 * This renderer is stroke-only, which is right for almost everything here — a
 * 1.2px line at 16px reads cleanly and inherits colour. But a few marks are
 * solid by definition, and faking one as a very small circle just produces a
 * ring with a smaller hole: the record glyph drawn that way was two concentric
 * rings, which is a generic target, not a record button.
 *
 * Optional and additive: an icon without an entry here is unchanged.
 */
export const ICON_FILL_PATHS: Partial<Record<keyof typeof ICON_PATHS, string>> = {
  record: 'M8 11.4 A3.4 3.4 0 1 0 8 4.6 A3.4 3.4 0 0 0 8 11.4 Z',
}

export type IconName = keyof typeof ICON_PATHS
