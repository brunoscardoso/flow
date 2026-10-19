/**
 * Enforced, or reporting — the one place a chain id becomes a decision.
 *
 * Every gate in the enforced-autopilot family answers the SAME question twice:
 * once for a chain that is driving (a missing record refuses, exit 1) and once
 * for a person asking by hand (the same verdict, exit 0, nothing refused). That
 * split is discovery R3, and it is the difference between enforcement and a new
 * law for everybody — a person running `/create-plan` against a year-old
 * discovery, or `/execute-plan` on a changeset nobody rated, is never refused
 * into a corner.
 *
 * THE MODE IS A TAGGED VALUE, NOT "IS THE CHAIN STRING EMPTY". A mode inferred
 * from an absent field flips when a caller forgets an argument, and the
 * direction it flips in — silently enforcing, or silently not — is exactly the
 * thing nobody would notice. `enforced` cannot exist without the chain that
 * justifies it.
 *
 * ONE FUNCTION, EVERY GATE (allowed-pattern #14). `flow stage` and `flow risk`
 * both come through here; `stageCheckModeOf` survives as its original name in
 * `flow-stage.ts` and is this function, not a copy of it.
 *
 * Pure. No I/O, no model, no clock.
 */

/** Whether this call is a chain driving, or a person asking. */
export type EnforcementMode =
  | { mode: 'enforced'; chain: string }
  | { mode: 'reporting'; chain: null };

/**
 * The mode a `--chain <id>` argument puts a gate in.
 *
 * A blank chain is a caller that meant to pass one and did not; it REPORTS
 * rather than enforcing, because the failure of an absent chain must be visible
 * (nothing refused) and not silent (everything refused).
 */
export function enforcementModeOf(chain: string | undefined): EnforcementMode {
  const named = (chain ?? '').trim();
  return named.length === 0
    ? { mode: 'reporting', chain: null }
    : { mode: 'enforced', chain: named };
}
