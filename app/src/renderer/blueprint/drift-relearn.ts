/**
 * What a drift row's [re-learn] should actually learn (#1156).
 *
 * `#learnModule` strips a `module:` prefix and forwards the rest as a module
 * PATH. Drift rows exist for file-backed nodes — integration / endpoint /
 * datastore — so clicking [re-learn] on `integration:api.stripe.com` enqueued a
 * learn pass for a directory literally named `integration:api.stripe.com`. That
 * spent a real agent pass (~30–40s) on a path that does not exist, wrote a
 * PHANTOM module into learning-state.jsonl (recorded `learned` in 2 of 3
 * measured runs — a false claim the store then carries), briefly showed the
 * phantom in the user's module list, and never re-learned the module that owns
 * the changed code.
 *
 * The board's own rule already said this shouldn't happen: `popover-model`
 * documents `learning: null` as "no learning affordance on integrations /
 * datastores / endpoints / ghosts", so the drift row contradicted the popover
 * for the very same node.
 *
 * The answer the user is actually asking for is "re-learn the code that
 * changed", so the target is resolved from the drifted FILE: the deepest module
 * node whose sourceFile directory contains it. When nothing owns it, there is
 * no honest target and the action is withheld rather than fabricated.
 *
 * The containment rule is the same one drift attribution uses (#1155,
 * drift-owner.ts in the CLI and in main). It is restated here because the
 * renderer shares no module with either; if the three are ever unified, this is
 * one of the three call sites.
 */

/** Only what target resolution needs from a graph node. */
export interface ModuleNodeLike {
  id: string
  kind?: string | undefined
  sourceFile?: string | undefined
  ghost?: boolean | undefined
}

/** Normalize to forward slashes with no trailing separator. */
function normalize(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  return slashed.endsWith('/') ? slashed.slice(0, -1) : slashed
}

/**
 * The module PATH to re-learn for a drift row, or null when none can be named.
 *
 * - a `module:` row re-learns itself (unchanged behaviour);
 * - any other row re-learns the deepest real module node owning its first
 *   changed file;
 * - ghosts are never targets — they are not learnable.
 */
export function driftRelearnPath(
  nodeId: string,
  changedFiles: readonly string[],
  nodes: readonly ModuleNodeLike[],
): string | null {
  if (nodeId.startsWith('module:')) {
    const path = nodeId.slice('module:'.length)
    return path.length > 0 ? path : null
  }

  const file = changedFiles[0]
  if (file === undefined || file.length === 0) return null
  const target = normalize(file)

  let best: { path: string; depth: number } | null = null
  for (const node of nodes) {
    if (node.kind !== 'module' || node.ghost === true) continue
    const raw = node.sourceFile
    if (typeof raw !== 'string' || raw.length === 0) continue
    const dir = normalize(raw)
    if (dir.length === 0) continue
    if (!target.startsWith(`${dir}/`)) continue
    // Deepest wins: src/api/client.ts belongs to src/api, not to src.
    if (best === null || dir.length > best.depth) {
      best = { path: dir, depth: dir.length }
    }
  }
  return best?.path ?? null
}
