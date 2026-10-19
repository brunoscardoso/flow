/**
 * Drop a "run this command" tail from a reason before a person reads it.
 *
 * THE CLI WRITES FOR TWO AUDIENCES AND ONLY ONE OF THEM HAS BUTTONS. Its
 * refusals deliberately end with the invocation that would undo them — "…
 * release it with `planflow-ai loop unclaim --loop fix --id 1533`" — which is
 * exactly right in a terminal and exactly wrong on a board that has a Release
 * control two pixels away. The substance of the reason is kept verbatim; only
 * the instruction to go and do it by hand is removed (forbidden-pattern #12).
 *
 * This is a DISPLAY decision, not a semantic one: nothing that decides
 * behaviour reads its output. Anchored on the backticked command span the CLI
 * itself formats, and it leaves any reason that carries none untouched.
 *
 * Shared so main (which must not import from the renderer) applies the same
 * rule at its own display boundary — the plan-notes runner does.
 */
export function withoutCommandHint(reason: string): string {
  const stripped = reason
    .replace(/[—-]?\s*[a-z ]*\bwith\s+`planflow-ai[^`]*`/gi, '')
    .replace(/`planflow-ai[^`]*`/g, '')
    .replace(/\s+([—-])\s*$/, '')
    .trim()
  return stripped.length > 0 ? stripped : reason
}
