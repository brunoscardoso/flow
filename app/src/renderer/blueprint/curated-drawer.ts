/**
 * Curated component drawer (feature-view #4) — PURE, no DOM.
 *
 * The mock's richest surface: click a component and get what it IS, what it
 * does today, what the plan makes of it, the code that proves the claim, and
 * the references behind it.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE BRIEF'S DRAWER
 * ================================================
 * `buildBriefNodeDetail` describes a node the DERIVED MAP found, and its payload
 * is the anchored investigation notes. This describes a component the generator
 * NAMED, and its payload is the artifact's own prose. Neither can produce the
 * other's content, so they are separate models rather than one with branches.
 *
 * REFERENCES ARE CLAIMS UNTIL SOMETHING CHECKS THEM
 * =================================================
 * The mock labels this section "Verified references", and a generated `refs`
 * entry is a MODEL CLAIM — nothing verified it by existing in the artifact. So
 * each one is marked against what the brief could actually resolve, and an
 * unresolved reference is shown as unresolved rather than dropped. Hiding it
 * would leave a section titled "verified" whose contents were selected by
 * whether they happened to be checkable, which is worse than saying so.
 *
 * The CODE EXCERPT is the exception, and only because of where it comes from:
 * it was read off disk at generation time with its file and line range kept, so
 * the drawer can show it as evidence without re-reading anything.
 */
import type { CuratedCode, CuratedNode } from './curated-view'
import { splitHeadline } from './curated-view'

/** Plan/discovery prose, as opposed to source. */
function isDocument(file: string): boolean {
  return /\.(md|mdx|txt|rst)$/i.test(file)
}

/** One reference, with the verdict on whether anything could confirm it. */
export interface DrawerRef {
  ref: string
  what: string
  /** True only when the brief resolved this exact reference. */
  resolved: boolean
}

/** A prose block. Rendered in order; absent sections never render empty. */
export interface DrawerSection {
  label: string
  text: string
}

/** Everything the drawer paints for one component. */
export interface CuratedDrawer {
  nodeId: string
  title: string
  sub: string | null
  /** Word under the kind chip — the delta when it changes, else the kind. */
  tag: string
  sections: DrawerSection[]
  code: CuratedCode | null
  /**
   * THE ADDRESS IS A CLAIM TOO. The provenance line under the code box exists
   * so the reader can check the excerpt against the file — but when the CLI's
   * brief-time check already found the file changed, a confident `file:from-to`
   * above text the file no longer says presents deleted code as current
   * evidence. The excerpt stays, and stays openable: the text is true history,
   * evidence of what the generator read. Only the ASSERTION is downgraded —
   * 'gone' when the lines left the file entirely, 'changed' when they moved or
   * could not be verified, null when the CLI verified them fresh (absence of
   * a verdict IS the fresh verdict; the CLI never stamps a fresh excerpt).
   */
  codeCaveat: 'changed' | 'gone' | null
  refs: DrawerRef[]
  /** Nested view id, when this component drills. */
  drillTo: string | null
  /** Repo-relative file the drawer can open, when the excerpt names one. */
  openFile: string | null
  /** Rollout phases touching this component, in the artifact's order. */
  phases: number[]
  /**
   * What was learned about this component AS A PART, in its own right.
   *
   * Empty means one of two very different things, and the drawer says which:
   * this component is not a part at all, or it is a part nobody has learned
   * yet. Neither is "nothing to know".
   */
  learned: PartKnowledge | null
  /**
   * What the drawer says when it has nothing else to say — never an empty body.
   * Measured: a derived card carries only an id, a kind and a title, so every
   * section above skipped and the drawer opened as a blank panel. Null when
   * anything else renders.
   */
  emptyNote: string | null
}

/** Said in place of an empty drawer. */
export const DRAWER_NOTHING_RECORDED =
  'Nothing is recorded about this component yet beyond its name.'

/** What was LEARNED about one part, as the brief delivers it. */
export interface PartKnowledge {
  name: string
  summary: string
  anchors: string[]
  learnings: Array<{ text: string; provenance: string; date: string; supersededReason?: string }>
}

/** How a reference is checked: the anchors the brief already resolved. */
export interface DrawerContext {
  /**
   * The feature's parts. A component that matches one shows what was LEARNED
   * about that piece — investigated against its own anchors — rather than only
   * the prose the drawing pass inferred while naming it.
   */
  parts?: readonly PartKnowledge[]
  /** `ref → resolved`, as the brief reported it. */
  anchors?: ReadonlyMap<string, boolean>
  /** Time state — After sections are withheld in Today. */
  time?: 'now' | 'next'
}

/**
 * Does this reference name the same thing as that anchor?
 *
 * Both are written by hand or by a model, so an exact match is too strict:
 * `src/chat/stream.ts` and `` `src/chat/stream.ts` `` are the same file. The
 * comparison strips decoration and compares tails, because an anchor is often
 * `file:src/chat/stream.ts` while the reference is the bare path.
 */
function sameTarget(ref: string, anchor: string): boolean {
  const clean = (value: string): string =>
    value
      .replace(/^[a-z]+:/i, '')
      .replace(/[`'"[\]]/g, '')
      .replace(/:\d+(-\d+)?$/, '')
      .trim()
      .toLowerCase()
  const a = clean(ref)
  const b = clean(anchor)
  if (a.length === 0 || b.length === 0) return false
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/**
 * The CLI's three freshness verdicts, folded to the two words the drawer says.
 *
 * 'shifted' and 'unknown' collapse to one word on purpose: both mean "the
 * cited lines are not what the file says there now", and the reader's next
 * move — open the file and look — is the same for either. 'gone' stays its
 * own verdict because it changes the sentence: there is nothing at that
 * address to look at. No verdict means the CLI verified the excerpt fresh —
 * absence IS the fresh case, so it maps to null, not to a fourth word.
 */
function caveatFor(code: CuratedCode | null): 'changed' | 'gone' | null {
  if (code === null || code.freshness === undefined) return null
  return code.freshness === 'gone' ? 'gone' : 'changed'
}

/**
 * Build the drawer for one curated component.
 *
 * TODAY WITHHOLDS THE PLAN. In the pre-plan world the drawer says only what the
 * component does now — the same rule the brief's drawer follows, and for the
 * same reason: a view whose purpose is "the world before this change" must not
 * leak the change into itself.
 */
export function buildCuratedDrawer(node: CuratedNode, context: DrawerContext = {}): CuratedDrawer {
  const headline = splitHeadline(node.title, node.sub)
  const today = (context.time ?? 'now') === 'now'

  const sections: DrawerSection[] = []
  const add = (label: string, text: string | undefined): void => {
    if (text !== undefined && text.trim().length > 0) sections.push({ label, text: text.trim() })
  }
  add('What it is', node.doc)
  add('Today', node.now)
  if (!today) add('After', node.next)
  if (node.code !== undefined) add('Why this code matters', node.code.note)

  const anchors = context.anchors
  const refs: DrawerRef[] = (node.refs ?? []).map(([ref, what]) => ({
    ref,
    what,
    resolved:
      anchors !== undefined &&
      [...anchors.entries()].some(([anchor, ok]) => ok && sameTarget(ref, anchor)),
  }))

  // A CODE BOX MUST CONTAIN CODE. The generation pass drops excerpts citing
  // plan/discovery markdown, but artifacts written before that rule still carry
  // them, and a stored artifact is not re-validated on read. Enforced here too:
  // the lines are real, and rendering prose inside a code box still presents an
  // argument as an implementation. The note survives as prose, which is where
  // that text belonged.
  const code = node.code !== undefined && !isDocument(node.code.file) ? node.code : null

  const codeCaveat = caveatFor(code)

  // Match by name. Parts are DERIVED from these components, so the names are
  // the same string — matching on anything looser would attach one part's
  // knowledge to a different piece of the system, which is worse than none.
  const learned =
    (context.parts ?? []).find((part) => part.name.trim() === node.title.trim()) ?? null

  return {
    nodeId: node.id,
    title: headline.title,
    sub: headline.sub,
    tag: node.delta === 'stable' ? node.kind : node.delta,
    sections,
    code,
    codeCaveat,
    refs,
    drillTo: node.view ?? null,
    // Only a SOURCE file is openable. The generation pass already drops
    // excerpts citing plan/discovery markdown, and this is the second place
    // that rule has to hold: an "open the code" button that opens an argument
    // about the code is the same lie in a different shape.
    openFile: code?.file ?? null,
    phases: node.phases ?? [],
    learned,
    emptyNote:
      sections.length === 0 &&
      code === null &&
      refs.length === 0 &&
      (node.phases ?? []).length === 0 &&
      learned === null &&
      (node.view ?? null) === null
        ? DRAWER_NOTHING_RECORDED
        : null,
  }
}

/** The excerpt's provenance line: `src/chat/stream.ts:851-857`. */
export function codeProvenance(code: CuratedCode): string {
  return `${code.file}:${String(code.from)}-${String(code.to)}`
}
