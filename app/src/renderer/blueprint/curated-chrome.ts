/**
 * Curated brief chrome (feature-view #5) — PURE, no DOM.
 *
 * The header the mock leads with: the feature's title and one-clause subtitle,
 * the level's kicker, the summary that swaps between Today and After, the
 * KNOWN ISSUE / Unchanged bands, and the slot chips that open their lists.
 *
 * BANDS ARE NEVER SYNTHESISED
 * ===========================
 * A band renders only when the artifact supplies that exact field. This is not
 * defensiveness — it is the fix for a bug that already shipped once: the brief's
 * `problemText` fell back to the first story step when no problem was authored,
 * and a plan PHASE was presented to the reader under a heading reading
 * `KNOWN ISSUE`. A band is a strong claim in a loud box; taking whatever text
 * is nearest and putting it there manufactures the claim.
 *
 * AND THE BAND'S MEANING FLIPS WITH TIME
 * ======================================
 * Today states a PROBLEM that exists; After states a GUARANTEE about a world
 * that does not exist yet. Rendering the guarantee in Today would be a promise
 * about a change that has not happened, so each state gets only its own band.
 */
import type { CuratedLevel, CuratedView } from './curated-view'
import type { BriefTime } from './brief-view-model'

/** One slot item: a tone and its text, straight from the artifact. */
export interface ChromeItem {
  /** `yes` / `bad` / `warn` / … — the artifact's own word, unmapped. */
  tone: string
  text: string
}

/** One chip and the list behind it. */
export interface ChromeSlot {
  id: string
  label: string
  items: ChromeItem[]
}

/** The band above the stage, when the artifact supplies one. */
export interface ChromeBand {
  tone: 'problem' | 'guarantee'
  label: string
  text: string
}

export interface CuratedChrome {
  title: string
  /** One clause under the title, from `meta.sub`. */
  sub: string | null
  /** The level's kicker — "Level 0 · how chat actually works before …". */
  kicker: string | null
  /** Prose above the diagram, swapping with the time state when both exist. */
  summary: string | null
  band: ChromeBand | null
  slots: ChromeSlot[]
  /**
   * Authored claims — items no extractor produced and nothing in the code can
   * confirm. Counted so the ledger can say so out loud.
   */
  authoredClaims: number
}

function items(raw: ReadonlyArray<readonly [string, string]> | undefined): ChromeItem[] {
  return (raw ?? [])
    .filter((entry) => Array.isArray(entry) && typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map((entry) => ({ tone: String(entry[0]), text: entry[1].trim() }))
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Build the chrome for one curated level in one time state.
 *
 * Everything here is READ, never derived: if the artifact has no problem, there
 * is no problem band, and the reader sees a header with one less row rather
 * than a manufactured claim.
 */
export function buildCuratedChrome(
  view: CuratedView,
  level: CuratedLevel,
  time: BriefTime,
): CuratedChrome {
  const brief = (view.brief ?? {}) as {
    problem?: unknown
    unchanged?: unknown
    todayHow?: ReadonlyArray<readonly [string, string]>
    todayProblems?: ReadonlyArray<readonly [string, string]>
    why?: ReadonlyArray<readonly [string, string]>
    fails?: ReadonlyArray<readonly [string, string]>
  }

  const problem = text(brief.problem)
  const unchanged = text(brief.unchanged)
  // Today gets the problem; After gets the guarantee. Neither borrows the
  // other's text when its own is missing.
  const band: ChromeBand | null =
    time === 'now'
      ? problem === null
        ? null
        : { tone: 'problem', label: 'Known issue', text: problem }
      : unchanged === null
        ? null
        : { tone: 'guarantee', label: 'Unchanged', text: unchanged }

  const slots: ChromeSlot[] = []
  const push = (id: string, label: string, raw: ReadonlyArray<readonly [string, string]> | undefined): void => {
    const list = items(raw)
    if (list.length > 0) slots.push({ id, label, items: list })
  }
  push('todayHow', 'How it works today', brief.todayHow)
  push('todayProblems', 'Known problems', brief.todayProblems)
  push('why', 'Why this code matters', brief.why)
  // THE HONESTY SLOT. These are claims the artifact makes that nothing in the
  // code can confirm, and they are listed under a heading that says exactly
  // that rather than folded in with the rest.
  push('fails', 'Claims nothing can prove', brief.fails)

  const summaryNext = text((level as { summaryNext?: unknown }).summaryNext)
  const summary = text(level.summary)

  return {
    title: text(view.meta.title) ?? level.title,
    sub: text(view.meta.sub),
    kicker: text(level.kicker),
    // Swap only when the artifact wrote a second summary. Otherwise the one
    // summary stands in both worlds — better than showing nothing after a flip.
    summary: time === 'next' ? (summaryNext ?? summary) : summary,
    band,
    slots,
    // `unchanged` and every `fails` entry are AUTHORED — no extractor produces
    // them — so the count exists to stop the format's authority laundering them
    // into derived facts.
    authoredClaims: (unchanged === null ? 0 : 1) + items(brief.fails).length,
  }
}

/** True when there is anything at all to draw above the diagram. */
export function hasChrome(chrome: CuratedChrome): boolean {
  return (
    chrome.sub !== null ||
    chrome.kicker !== null ||
    chrome.summary !== null ||
    chrome.band !== null ||
    chrome.slots.length > 0
  )
}
