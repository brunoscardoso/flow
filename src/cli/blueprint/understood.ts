/**
 * "% understood" — ONE arithmetic for every surface that prints it.
 *
 * The board's title strip, a domain's label row, a project's header band on the
 * Workspace sheet and the Workspace's own figure all answer the same question:
 * of the CAPABILITIES drawn here, how many has somebody actually read? The board
 * computed it in the renderer (`understoodFraction`) and the CLI's Workspace map
 * now needs the same number per project — so the rule lives here once and the
 * app re-exports it (`app/src/shared/understood.ts`), the precedent
 * `flowconfig-merge` set (allowed-pattern #14).
 *
 * THE RULE, unchanged from the board:
 *   • only `kind: 'core'` nodes count — a part is a piece of a feature and a
 *     change is a record about one; neither is a capability;
 *   • only `learned` is done — `stale` was learned once and the code moved
 *     underneath it, so counting it would report a project finished the moment
 *     it drifted;
 *   • no capabilities → `null`, never 0/0 drawn as empty or as full.
 *
 * A roll-up SUMS the fractions (done over total), never averages percentages:
 * a project with two features at 100% must not outweigh one with forty at 10%.
 *
 * Pure, no imports, no I/O — the app's CommonJS jest and the CLI's ESM build
 * both compile it as-is.
 */

/** The fields the count reads off a feature-graph node. */
export interface UnderstoodNode {
  kind: 'core' | 'child' | 'part';
  understanding: 'none' | 'learning' | 'learned' | 'stale';
}

/** How many capabilities are understood, of how many. */
export interface UnderstoodFraction {
  done: number;
  total: number;
}

/** Of the core features in `nodes`, how many are `learned`. Null when there are none. */
export function featuresUnderstood(nodes: readonly UnderstoodNode[] | null | undefined): UnderstoodFraction | null {
  if (nodes === null || nodes === undefined) return null;
  let total = 0;
  let done = 0;
  for (const node of nodes) {
    if (node.kind !== 'core') continue;
    total += 1;
    if (node.understanding === 'learned') done += 1;
  }
  return total === 0 ? null : { done, total };
}

/**
 * Several fractions as one — the Workspace's figure from its projects'. Sums
 * the counts; a `null` (a project with no capabilities, or one that could not
 * be read) contributes nothing. Null when nothing at all was counted.
 */
export function rollUpUnderstood(fractions: readonly (UnderstoodFraction | null | undefined)[]): UnderstoodFraction | null {
  let total = 0;
  let done = 0;
  for (const fraction of fractions) {
    if (fraction === null || fraction === undefined) continue;
    total += fraction.total;
    done += fraction.done;
  }
  return total === 0 ? null : { done, total };
}

/** A fraction as the whole percentage every surface prints. Null stays null. */
export function understoodPercent(fraction: UnderstoodFraction | null | undefined): number | null {
  if (fraction === null || fraction === undefined || fraction.total <= 0) return null;
  return Math.round((fraction.done / fraction.total) * 100);
}
