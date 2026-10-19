// Brain-first compact variant — the app-injected 3-line form of the canonical
// contract at `.claude/resources/core/brain-first.md` (that doc's
// "Compact Variant" section names this constant and both consumers).
//
// ONE exported constant (allowed-pattern #14 — the invariant lives in one code
// path, never restated per prompt), used by BOTH:
//   • the IDE session seed (agent-manager first turn) — gated on `cliShimDir`
//     being non-null, so a session is never instructed to run a verb that is
//     not on its PATH;
//   • the caged learn session (buildLearnPrompt) — the cage has Read/Grep/Glob
//     only, no Bash, hence the Grep-over-`flow/brain/**.md` fallback clause.

/** Injected from `.claude/resources/core/brain-first.md` (compact variant). */
export const BRAIN_FIRST_COMPACT = [
  'Brain-first: search acquired knowledge before reading code — `planflow-ai brain search "<question>"` (no Bash tool? Grep/Read `flow/brain/**.md` — code cards, module docs, decisions — instead).',
  'Search the brain FIRST for any orientation question — where/who/what/how-does; read or grep code only for what search did not answer, or for strings seen in results. If search finds nothing useful, proceed with grep — do not retry variations more than once.',
  'A hit flagged stale means the source drifted since indexing — verify against the code before acting on it.',
].join('\n')
