// WHAT THE CHAIN CALLS THE THING IT IS BUILDING — the subject, minted once.
//
// WHY THIS EXISTS AT ALL. The stage gate (`planflow-ai flow stage … --check`)
// judges a rung by the artifact its predecessor left behind, and three of the
// four artifacts are files NAMED for a feature: `discovery_<f>_v<N>.md`,
// `plan_<f>_v<N>.md`, `review_<f>.md`. The chain drives a CONVERSATION, not a
// plan slug, so for the whole of #1915's first cut there was nothing to put in
// that `<f>` — which is the real reason the gate shipped with no caller and the
// "refuse" half of autopilot was unreachable (review C2).
//
// THE DRIVER MINTS THE SUBJECT, exactly as it mints the identity. The chain
// already invents a `chainId` nothing else can forge; the feature slug is the
// same move for the other half of the question. Minted at `begin()`, carried in
// every stage's message so the rung KNOWS what to name its document, and passed
// to the gate so the gate asks about the same thing the rung was told to write.
// Nothing is read back out of the files being judged — a subject resolved from
// the record it is about is C1's defect, one field over.
//
// SANITIZED, NEVER REFUSED (allowed-pattern #22). This value is DERIVED — from
// a sentence a person typed at a chat box, or a ticket's own free text — so
// refusing it would leave the chain with nothing to be about at the one moment
// it must start. A typed value would be validated and refused instead; that
// path is elsewhere and this one must never grow one. The output is therefore
// total: every input, including an empty one and one with no Latin letters in
// it at all, produces a slug that matches `FEATURE_SLUG_PATTERN`.
//
// THE RUN'S OWN SUFFIX IS NOT DECORATION. Two chains with the same aim in one
// project would otherwise share a slug, and the older run's documents would
// then answer for the newer one's rungs: a stage that ended cleanly and wrote
// NOTHING would be cleared by a file from last week — the precise failure this
// gate exists to catch, and the precise shape of C1 (a record nominating itself
// as the answer). Binding the subject to the run makes each chain's proofs its
// own. The cost is a filename with six characters of run id in it, which is the
// cheaper half of that trade.
//
// Pure — no store, no clock, no filesystem, no id minting of its own.

/**
 * What a slug is allowed to look like, and what every caller may assume.
 *
 * Deliberately narrower than what the CLI's proof patterns tolerate (they
 * RegExp-escape the slug, so a `.` or a `+` would not reopen the gate): a
 * feature slug becomes part of a filename a person reads and types, so it
 * carries lowercase letters, digits and hyphens, and it starts with one of the
 * first two.
 */
export const FEATURE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** What a slug is called when the aim contributed no usable characters. */
export const UNNAMED_SUBJECT = 'unnamed'

/** How many words of the aim survive. Enough to recognise, short enough to type. */
const MAX_WORDS = 6

/** How many characters of the aim's half survive, before the run's suffix. */
const MAX_AIM_CHARS = 40

/** How many characters of the run's id ride along. */
const MAX_SUFFIX_CHARS = 8

/** What the suffix falls back to when the chain id yields nothing usable. */
const UNNAMED_RUN = 'run'

/**
 * The slug for one chain's work — `add-a-dark-mode-k3f9a1`.
 *
 * Total by construction: the result always matches `FEATURE_SLUG_PATTERN`, for
 * every aim including `''`, `'!!!'` and `'日本語'`. See the header for why that
 * is a requirement rather than a nicety.
 */
export function featureSlugFrom(aim: string, chainId: string): string {
  const subject = slugWords(aim)
  const suffix = runSuffix(chainId)
  const slug = `${subject.length === 0 ? UNNAMED_SUBJECT : subject}-${suffix}`
  // A LAST LOOK, because the promise above is the one every caller leans on and
  // a sanitizer that ever returned an invalid value would be discovered as a
  // gate refusing every rung of every chain, which reads as the gate being
  // broken rather than as this line being wrong.
  return FEATURE_SLUG_PATTERN.test(slug) ? slug : `${UNNAMED_SUBJECT}-${UNNAMED_RUN}`
}

/**
 * The readable half — the aim's own words, as far as they survive ASCII.
 *
 * Accents are FOLDED rather than dropped (`café` → `cafe`), because a person
 * who wrote a word expects to recognise it in the filename; a script with no
 * Latin form at all folds to nothing, and the caller's fallback names it.
 */
function slugWords(aim: string): string {
  return aim
    .normalize('NFKD')
    // Combining marks left behind by the decomposition above.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .slice(0, MAX_WORDS)
    .join('-')
    .slice(0, MAX_AIM_CHARS)
    .replace(/-+$/, '')
}

/** The run's half — the tail of the chain id, reduced to slug characters. */
function runSuffix(chainId: string): string {
  const tail = chainId.split('-').filter((part) => part.length > 0).at(-1) ?? ''
  const reduced = tail.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, MAX_SUFFIX_CHARS)
  return reduced.length === 0 ? UNNAMED_RUN : reduced
}
