/**
 * Plain-language explanations for the Docs-by-trust-tier list (#1131).
 *
 * The list showed verdict pills, a `5 ✓ · 1 ✗ · 1 ?` rollup, a trust tier and
 * ⚙/✓/✕ buttons — and explained none of them. Clicking a row just opened the
 * file, so a doc marked *contradicted* never said what it was contradicting,
 * who decided, or what to do about it; the numbers and the tier had no stated
 * meaning at all.
 *
 * All the wording lives here, pure and unit-tested, so the vocabulary is
 * consistent across the pill, the legend and the tooltips rather than being
 * retyped at each call site.
 */
import type { BlueprintTierFileVerdict } from '../../shared/ipc-contract'

export interface VerdictExplanation {
  /** The pill's own label. */
  label: string
  /** What this verdict MEANS, in one sentence a user can act on. */
  meaning: string
  /** What to do next. */
  nextStep: string
}

const VERDICTS: Record<BlueprintTierFileVerdict, VerdictExplanation> = {
  corroborated: {
    label: 'verified',
    meaning: 'The code agrees with what this doc says — every claim checked out.',
    nextStep: 'Nothing to do. Re-verify if the code changes underneath it.',
  },
  contradicted: {
    label: 'contradicted',
    meaning: 'The code disagrees with something this doc says. Trust the code; this doc needs fixing.',
    nextStep: 'Open the doc, correct the claim the evidence names, then verify again.',
  },
  unverifiable: {
    label: 'unverified',
    meaning:
      'The checker read the code and still could not tell whether this doc is right — usually because the claim is about something outside the code it can see.',
    nextStep: 'Judge it yourself with ✓ / ✕, or narrow the claim so it can be checked.',
  },
  unadjudicated: {
    label: 'unverified',
    meaning: 'Nobody has checked this doc against the code yet. It is a claim, not ground truth.',
    nextStep: 'Run ⚙ Verify to have an agent check each claim against the code.',
  },
}

/** The verdict's explanation — `stale` overrides, since an expired stamp's old
 *  verdict is exactly the lie the tier system exists to prevent. */
export function explainVerdict(
  verdict: BlueprintTierFileVerdict,
  options: { stale?: boolean } = {},
): VerdictExplanation {
  if (options.stale === true) {
    return {
      label: 'stale',
      meaning:
        'This doc was verified once, but the doc or the code it was checked against has changed since — so the old result no longer means anything.',
      nextStep: 'Run ⟳ Re-verify to check it against the code as it is now.',
    }
  }
  return VERDICTS[verdict]
}

/** Who produced the verdict, in words rather than a provenance enum. */
export function explainProvenance(provenance: string | undefined): string {
  switch (provenance) {
    case 'user':
      return 'you marked this yourself'
    case 'verify-agent':
      return 'a verification agent checked it'
    case 'learn-pass':
      return 'the learn pass judged it while documenting this module'
    case 'auto':
      return 'decided automatically'
    default:
      return 'origin not recorded'
  }
}

/** "3 days ago" / "just now" — a verdict's age is what makes it trustworthy. */
export function explainWhen(verifiedAt: string | undefined, now: Date): string | null {
  if (verifiedAt === undefined) return null
  const then = new Date(verifiedAt)
  if (Number.isNaN(then.getTime())) return null
  const seconds = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** The `5 ✓ · 1 ✗ · 1 ?` rollup, spelled out — including the rule that makes
 *  one failing claim decide the whole doc. */
export function explainRollup(claims: {
  corroborated: number
  contradicted: number
  unverifiable: number
}): string {
  const parts = [
    `${claims.corroborated} claim${claims.corroborated === 1 ? '' : 's'} the code confirms`,
    `${claims.contradicted} it disagrees with`,
    `${claims.unverifiable} it could not check`,
  ]
  const rule =
    claims.contradicted > 0
      ? ' One contradicted claim makes the whole doc contradicted.'
      : ''
  return `${parts.join(' · ')}.${rule}`
}

/** What the tier means — the question "why is this Tier 2?" had no answer. */
export const CLAIM_TIER_LEGEND =
  'These are Tier-2 “claim” files: documentation written by people, which the system treats as unverified statements ABOUT the code rather than as truth. Code is Tier 1 — it is what actually runs. A claim stays unverified until something checks it against the code.'

/** What verifying actually does, for the ⚙ button and the legend. */
export const VERIFY_ACTION_LEGEND =
  'Verify reads the doc, extracts each statement it makes, checks each one against the code, and records the result with its evidence.'

/** What the manual ✓ / ✕ record — including that they are attributed to you. */
export const MANUAL_TRUST_LEGEND =
  '✓ and ✕ record YOUR judgment instead of an agent’s; the verdict is stored as decided by you.'

/** Said when a verdict carries no per-claim record (manual or legacy). */
export const NO_CLAIMS_RECORDED =
  'No individual claims were recorded for this verdict — it was decided as a whole. Run Verify to get a claim-by-claim breakdown.'
