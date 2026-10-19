/**
 * THE LIMITATIONS SURFACE — PURE, no DOM.
 *
 * WHY THIS EXISTS
 * ===============
 * The feature map draws 28 features and every cell looks equally complete.
 * None of them is: `## Parts` appears on 0 of 28, `## Learned` on 0 of 28, and
 * the single stored curated view has failed the validator since 2026-08-04 with
 * errors nobody has ever been shown. A board that renders that identically to a
 * fully-documented one is making a claim, and the claim is false.
 *
 * So the gaps get a surface of their own. Three kinds of finding, in descending
 * order of how much they should worry a reader:
 *
 *   BROKEN — an artifact exists and does not work. The validator's own words are
 *            carried through VERBATIM, because a paraphrase is a second opinion
 *            about a check that already ran.
 *   MISSING — content nobody has written yet. Not a fault; a shape of the map.
 *   CAPPED — something the board itself chose not to draw. Every one says how
 *            much it hid (Task 8.4).
 *
 * WHAT IT MAY NEVER DO
 * ====================
 * Report an UNKNOWN as a zero. When the CLI sent no gap report — an older
 * bundle, an unavailable graph — this says "not measured" and stops. "0 of 0
 * features missing parts" would read as a clean bill of health issued by a
 * check that never ran, which is precisely the failure mode Phase 8 exists to
 * remove.
 *
 * THE CAP AUDIT (Task 8.4)
 * ========================
 * Every place the feature-map surface removes something, and
 * what it now says about it:
 *
 *   derived-level `DERIVED_EDGE_CAP`  DISCLOSED already — counted in `hidden`,
 *                                     written into the level's summary and into
 *                                     `resolveLevel`'s reason (Phase 6).
 *   territory-view `elide`           DISCLOSED — the `…` IS the mark, and the
 *                                     labels also carry a `truncated` flag.
 *   territory-view `wrapName`        WAS SILENT, now fixed. A name needing a
 *                                     fourth line lost it with no mark at all,
 *                                     so a cut name read as the whole name.
 *   brain-query `BRAIN_QUERY_LIMIT`   WAS SILENT, now fixed. The ASK is a cap:
 *                                     twelve hits requested, and a full answer
 *                                     printed as "12 matches" read as the total.
 *                                     Overflow is unknowable, so the line says
 *                                     "there may be more" and no number.
 *   territory-view root `note`       DISCLOSED — features assigned to no
 *                                     capability are counted, never dropped.
 *   title strip `nodes: N / total`    DISCLOSED — the sheet never claims to be
 *                                     the whole store.
 *   brain-query `offMap`              DISCLOSED — a hit that lit nothing here
 *                                     is counted in the status line.
 *
 * Deliberately NOT caps, so nothing is owed:
 *   feature-view-model's edge filter and derived-level's `mergeStructuralEdges`
 *     — SCOPE, not a limit: an edge to something off screen is not hidden, it
 *     is at a different level, and drawing it would assert a relationship the
 *     reader cannot see.
 *   focus-stack's `slice` calls — stack pops, not truncation.
 */

import type { BlueprintFeatureLimitations } from '../../shared/ipc-contract'

/** How much a row should worry the reader. Drives class names only. */
export type LimitationSeverity = 'broken' | 'missing' | 'capped' | 'unknown'

/** One finding. `detail` may be empty; `label` never is. */
export interface LimitationRow {
  severity: LimitationSeverity
  label: string
  detail: string
  /** The validator's own messages, when this row has any. Verbatim. */
  errors: string[]
}

export interface LimitationSection {
  id: 'broken' | 'missing' | 'capped' | 'excluded'
  title: string
  rows: LimitationRow[]
}

export interface LimitationsReport {
  /** One line, never blank — including the case where there is nothing wrong. */
  headline: string
  /** Only sections with rows. An empty section is chrome, not information. */
  sections: LimitationSection[]
  counts: { broken: number; missing: number; capped: number; excluded: number }
  /** True when every measurable thing was measured and nothing was found. */
  clean: boolean
}

/**
 * One cap the board applied, and what it cost.
 *
 * `hidden` is what did not get drawn; `of` is what there was. A cap that hid
 * nothing still passes through here — it simply produces no row, which is the
 * honest rendering of a limit that did not bite.
 */
export interface AppliedCap {
  /** What was capped. Singular and plural GIVEN — a naive `+ 's'` writes
   *  "1 matchs" for exactly the words these rows use. */
  noun: { one: string; many: string }
  /** How many were withheld. */
  hidden: number
  /** How many there were in total. */
  of: number
  /** The limit that was applied. */
  cap: number
  /** Where the cap bit — 'the derived level', 'the brain query'. May be empty. */
  where?: string
  /**
   * The cap demonstrably bit, but the overflow CANNOT BE COUNTED from here.
   *
   * `brain:query` is the live case: it is asked for twelve hits and answers
   * with at most twelve, and the store never says how many matched. Reporting
   * `0 hidden` would be a measurement nobody made; reporting nothing at all
   * would present a top-twelve as everything. So it says what is true — the
   * answer came back full — and stops.
   */
  unquantified?: boolean
}

export interface LimitationsInput {
  /** The CLI's gap report, or null when it was never measured. */
  limitations: BlueprintFeatureLimitations | null
  /** Caps the board applied on the surface currently drawn. */
  caps: readonly AppliedCap[]
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** `3 of 28` — the pair, never the bare numerator. */
function ratio(part: number, whole: number): string {
  return `${part} of ${whole}`
}

/**
 * The rows for artifacts that exist and do not work.
 *
 * An orphan gets its OWN row rather than a clause on the invalid one. They are
 * different faults with different fixes — a broken view is regenerated, an
 * orphan is deleted or re-filed — and this repo's single artifact is both, so
 * collapsing them would hide one behind the other in the only real case there
 * is.
 */
function brokenRows(limitations: BlueprintFeatureLimitations): LimitationRow[] {
  const rows: LimitationRow[] = []
  for (const failure of limitations.views.failures) {
    if (failure.orphaned) {
      rows.push({
        severity: 'broken',
        label: `${failure.slug} belongs to no feature`,
        detail: failure.orphanReason,
        errors: [],
      })
    }
    if (failure.state === 'unreadable') {
      rows.push({
        severity: 'broken',
        label: `${failure.slug} could not be read`,
        detail: failure.errors.join(' · '),
        errors: [],
      })
      continue
    }
    if (failure.errors.length > 0) {
      rows.push({
        severity: 'broken',
        label: `${failure.slug} fails the view validator`,
        detail: plural(failure.errors.length, 'refusal', 'refusals'),
        // VERBATIM, and this is the whole point of Task 8.1: before Phase 8
        // these strings existed, were computed, and were thrown away.
        errors: failure.errors,
      })
    }
  }
  return rows
}

/** The rows for content nobody has written. Absence, not breakage. */
function missingRows(limitations: BlueprintFeatureLimitations): LimitationRow[] {
  const { content, views } = limitations
  const rows: LimitationRow[] = []
  if (content.features === 0) {
    rows.push({
      severity: 'missing',
      label: 'No features in the store',
      detail: 'the board is drawing nothing because there is nothing to draw',
      errors: [],
    })
    return rows
  }
  // THE DETAIL IS FOR A READER OF THE BOARD, NOT A READER OF THE FILES.
  // These three said `## Parts on 5 of 35` — the name of a markdown heading
  // inside flow/brain/features/<slug>.md, which is a fact about how the store
  // is written and means nothing to someone looking at a map of their project
  // (forbidden-pattern #12: no file formats, paths or config keys in UI text).
  // The label already names the gap; the detail says how much of it is filled.
  const withoutParts = content.features - content.withParts - content.unreadable
  const withoutLearned = content.features - content.withLearned - content.unreadable
  if (withoutParts > 0) {
    rows.push({
      severity: 'missing',
      label: `${plural(withoutParts, 'feature has', 'features have')} no parts`,
      detail: `${ratio(content.withParts, content.features)} have them`,
      errors: [],
    })
  }
  if (withoutLearned > 0) {
    rows.push({
      severity: 'missing',
      label: `${plural(withoutLearned, 'feature has', 'features have')} nothing learned`,
      detail: `${ratio(content.withLearned, content.features)} have them`,
      errors: [],
    })
  }
  if (content.unreadable > 0) {
    rows.push({
      severity: 'broken',
      label: `${plural(content.unreadable, 'feature body', 'feature bodies')} could not be read`,
      detail: 'the learnings could not be told apart from the rest — counted here, never as "nothing learned"',
      errors: [],
    })
  }
  const uncurated = views.total - views.valid
  if (views.valid === 0) {
    rows.push({
      severity: 'missing',
      label: 'No feature has a curated view',
      detail:
        views.total === 0
          ? 'nothing has been generated; every level on this board is derived'
          : `${plural(uncurated, 'artifact is', 'artifacts are')} stored and none of them is usable`,
      errors: [],
    })
  }
  return rows
}

/**
 * The rows for what the board itself withheld (Task 8.4).
 *
 * A cap that did not bite produces NO row. That is not a silence: the caps were
 * handed in, were checked, and none of them removed anything — and inventing a
 * row saying so would push the ones that DID hide something down a list of
 * reassurances.
 */
function cappedRows(caps: readonly AppliedCap[]): LimitationRow[] {
  const rows: LimitationRow[] = []
  for (const cap of caps) {
    const unquantified = cap.unquantified === true
    if (cap.hidden <= 0 && !unquantified) continue
    const where = (cap.where ?? '').trim()
    const at = where.length > 0 ? ` in ${where}` : ''
    if (cap.hidden <= 0) {
      rows.push({
        severity: 'capped',
        label: `${cap.noun.many} beyond the cap are not shown${at}`,
        detail:
          `the answer came back full at ${cap.cap} — how many more there are ` +
          'is not knowable from here',
        errors: [],
      })
      continue
    }
    rows.push({
      severity: 'capped',
      label: `${plural(cap.hidden, cap.noun.one, cap.noun.many)} hidden${at}`,
      detail: `showing ${ratio(Math.max(0, cap.of - cap.hidden), cap.of)} — the cap is ${cap.cap}`,
      errors: [],
    })
  }
  return rows
}

/**
 * Build the report the board renders.
 *
 * Deterministic: the same input always produces the same rows in the same
 * order, so the surface does not reshuffle between renders of an unchanged
 * board.
 */
/**
 * WHAT THE DIRECTORY HELD THAT THE BOARD DID NOT DRAW — by name, and why.
 *
 * The rule these rows report is the one that decides whether a file is a
 * capability, and its stated failure is a real capability quietly not being
 * drawn. A count would leave a reader who suspects that with nowhere to look,
 * so every excluded file is named.
 *
 * `dropped: false` is the other half: the file IS on the board, but the board
 * had to guess what kind of thing it was. Saying so is what makes the guess
 * correctable — editing the file is the documented correction, and a reader
 * cannot edit what they were never told about.
 */
function excludedRows(limitations: BlueprintFeatureLimitations): LimitationRow[] {
  return (limitations.excluded ?? []).map((entry) => ({
    severity: entry.dropped ? ('missing' as const) : ('unknown' as const),
    label: entry.dropped ? `${entry.slug} — not shown` : `${entry.slug} — shown as a capability`,
    detail: EXCLUSION_DETAIL[entry.reason],
    errors: [],
  }))
}

/** One sentence per reason, in the reader's terms — no file path, no
 *  frontmatter key, no command (forbidden-pattern #12). */
const EXCLUSION_DETAIL: Record<'working-set' | 'capture-note' | 'no-kind', string> = {
  'working-set': 'a chat thread\u2019s working notes, not a capability',
  'capture-note': 'a note captured about a feature, not the feature itself',
  'no-kind':
    'this file does not say whether it is a capability or a change, so the board assumed a capability',
}

export function buildLimitationsReport(input: LimitationsInput): LimitationsReport {
  const capped = cappedRows(input.caps)

  if (input.limitations === null) {
    // NOT MEASURED IS ITS OWN ANSWER. Everything the board knows on its own —
    // the caps it just applied — still reports; what it was not told does not
    // become a zero.
    const rows: LimitationRow[] = [
      {
        severity: 'unknown',
        label: 'Store gaps not measured',
        detail: 'the feature graph arrived without a gap report — this is unknown, not clean',
        errors: [],
      },
    ]
    const sections: LimitationSection[] = [{ id: 'missing', title: 'Not measured', rows }]
    if (capped.length > 0) sections.push({ id: 'capped', title: 'Hidden by a cap', rows: capped })
    return {
      headline:
        capped.length > 0
          ? `Store gaps not measured · ${plural(capped.length, 'cap applied', 'caps applied')}`
          : 'Store gaps not measured.',
      sections,
      counts: { broken: 0, missing: 0, capped: capped.length, excluded: 0 },
      clean: false,
    }
  }

  const broken = brokenRows(input.limitations)
  const missing = missingRows(input.limitations)
  // A body that will not read is BREAKAGE, and `missingRows` emits it with that
  // severity — so it is counted where the reader sees it rather than where it
  // happened to be computed.
  const brokenInMissing = missing.filter((row) => row.severity === 'broken').length

  const excluded = excludedRows(input.limitations)

  const sections: LimitationSection[] = []
  if (broken.length > 0) sections.push({ id: 'broken', title: 'Broken', rows: broken })
  if (missing.length > 0) sections.push({ id: 'missing', title: 'Not written yet', rows: missing })
  if (excluded.length > 0) {
    sections.push({ id: 'excluded', title: 'Not drawn as a capability', rows: excluded })
  }
  if (capped.length > 0) sections.push({ id: 'capped', title: 'Hidden by a cap', rows: capped })

  const counts = {
    broken: broken.length + brokenInMissing,
    missing: missing.length - brokenInMissing,
    capped: capped.length,
    excluded: excluded.length,
  }
  const clean =
    counts.broken === 0 && counts.missing === 0 && counts.capped === 0 && counts.excluded === 0

  const parts: string[] = []
  if (counts.broken > 0) parts.push(plural(counts.broken, 'thing broken', 'things broken'))
  if (counts.missing > 0) parts.push(plural(counts.missing, 'gap', 'gaps'))
  if (counts.excluded > 0) {
    parts.push(plural(counts.excluded, 'file not a capability', 'files not capabilities'))
  }
  if (counts.capped > 0) parts.push(plural(counts.capped, 'cap applied', 'caps applied'))

  return {
    headline: clean ? 'Nothing broken, nothing hidden, nothing missing.' : `${parts.join(' · ')}.`,
    sections,
    counts,
    clean,
  }
}

/**
 * The one-line summary the board puts on its always-visible chrome.
 *
 * Separate from `headline` so the collapsed affordance can say something
 * shorter without either surface inventing its own arithmetic.
 */
export function limitationsLabel(report: LimitationsReport): string {
  if (report.clean) return 'Limitations: none'
  const total = report.counts.broken + report.counts.missing + report.counts.capped
  return `Limitations: ${total}`
}

/* ── Caps the board can report (Task 8.4) ──────────────────────────────────
 *
 * Each helper turns one surface's own numbers into an `AppliedCap`. They live
 * here rather than in the board so that "did this cap bite, and by how much"
 * is a tested question everywhere it is asked.
 */

/** The derived level's connection cap (Phase 6). Null when no level is drawn. */
export function derivedCap(
  derived: { hidden: { pairs: number }; totalPairs: number; cap: number } | null,
): AppliedCap | null {
  if (derived === null) return null
  return {
    noun: { one: 'connection', many: 'connections' },
    hidden: derived.hidden.pairs,
    of: derived.totalPairs,
    cap: derived.cap,
    where: 'the derived level',
  }
}

/**
 * The brain query's own limit (Phase 7).
 *
 * `brain:query` returns hits and no total, so how many matched beyond the limit
 * is genuinely unknowable from here. What IS knowable is that the answer came
 * back FULL, which is the only honest thing to say: there may be more, and the
 * reader is told that rather than shown a top-12 presented as everything.
 */
export function brainQueryCap(hitCount: number, limit: number): AppliedCap | null {
  if (limit <= 0 || hitCount < limit) return null
  return {
    noun: { one: 'match', many: 'matches' },
    hidden: 0,
    of: hitCount,
    cap: limit,
    where: 'the brain query',
    unquantified: true,
  }
}
