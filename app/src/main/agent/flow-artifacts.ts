// Shared predicate for plan-flow's own `flow/` bookkeeping directory.
//
// `flow/` holds plan-flow's artifacts — tasklist, brain, plans, discovery,
// rounds, etc. — that the workflow writes as a matter of course. Agent edits
// there are AUTO-WRITTEN: they never prompt for permission (canUseTool) and
// never enter the diff-review strip (EditTracker). Only real project files get
// the accept/reject gate. Both layers key off this single predicate so the
// convention can't drift between them.

import { lstatSync, realpathSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'

import { resolveWorkspacesDir } from '../project/flow-folder'

/** Tools whose primary input is a file path we can scope to the flow/ dir. */
export const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

/**
 * True when `filePath` resolves inside `<projectRoot>/flow/`. Lexical (no
 * symlink following) — matches how the agent addresses `flow/…` relative to the
 * project root. Escapes (`../flow`) and sibling names (`flowers/`) are excluded.
 */
export function isFlowArtifactPath(projectRoot: string, filePath: string): boolean {
  const rel = relative(resolve(projectRoot), resolve(filePath))
  if (!rel || rel.startsWith('..')) return false
  return rel.split(sep)[0] === 'flow'
}

/**
 * True when `filePath` is a flow/ artifact of ANY of the thread's roots —
 * multi-project threads (#45) may edit flow/ under any of their projects.
 */
export function isFlowArtifactPathForAny(roots: readonly string[], filePath: string): boolean {
  return roots.some((root) => isFlowArtifactPath(root, filePath))
}

/**
 * The RESOLVED `flow/` directory of each root, when it is a symlink pointing
 * somewhere else — for the SDK's sandbox scope.
 *
 * The predicates above are lexical on purpose: they answer "did the agent
 * address this as `flow/…`", which is the right question for auto-approving an
 * Edit. But `flow/` is normally a symlink into the plan-flow vault, and the
 * SDK's own sandbox — which governs anything **Bash** spawns — resolves links.
 * So a CLI the agent runs was denied write access to the very directory the
 * Write tool could write freely, and the store reported the denial as a busy
 * lock that could never clear.
 *
 * Returns only genuinely symlinked, existing targets: a plain `flow/` directory
 * is already inside its root and needs no widening, and a missing one must not
 * invent scope. Deduplicated, since multi-project threads can share a vault.
 */
export function resolveFlowArtifactRoots(roots: readonly string[]): string[] {
  return resolveLinkedTargets(roots, ['flow'])
}

/**
 * The roots the project guard checks against: the thread's own roots plus the
 * real folder each one's `flow/` link points at.
 *
 * A PROJECT'S KNOWLEDGE IS NOT "OUTSIDE" IT (the user, 2026-10-08). `flow/` is a
 * link into the Workspace (`~/plan-flow/workspaces/<w>/projects/<p>`), and the
 * moment an agent used the real path a tool had printed — a `find` on the
 * project's own folder — the guard read it as another place entirely and
 * refused it (#503), while the SDK sandbox already let the session write there.
 * Only the links of roots this thread already has are followed, so no
 * sibling's knowledge comes with them.
 */
export function containmentRoots(roots: readonly string[]): string[] {
  return [...new Set([...roots, ...resolveFlowArtifactRoots(roots)])]
}

/**
 * plan-flow's own agent assets, which a thread worktree links back to the
 * project checkout because they are gitignored and a fresh worktree has none.
 */
export const PLAN_FLOW_ASSET_ENTRIES = ['.claude', '.claude/commands', '.claude/resources', '.claude/hooks'] as const

/**
 * The resolved target of every entry under every root that is a symlink
 * pointing OUTSIDE that root. A plain directory is already inside its root and
 * needs no widening, and a missing entry must not invent scope. Deduplicated,
 * since multi-project threads can share a vault or a checkout.
 */
export function resolveLinkedTargets(roots: readonly string[], entries: readonly string[]): string[] {
  const out = new Set<string>()
  for (const root of roots) {
    for (const entry of entries) {
      const linkPath = resolve(root, entry)
      try {
        if (!lstatSync(linkPath).isSymbolicLink()) continue
        const target = realpathSync(linkPath)
        // Already covered by the root itself — widening would be a no-op.
        // Compared REAL to real: on macOS a root under /var is /private/var
        // once resolved, and a lexical root made every inside link look out.
        if (!relative(realpathSync(root), target).startsWith('..')) continue
        out.add(target)
      } catch {
        // Not there yet, or an unreadable link: nothing to widen, never a throw.
      }
    }
  }
  return [...out]
}

/**
 * Every directory beyond the working directory a session may write: the
 * thread's extra roots, then the resolved `flow/` target of each root.
 *
 * ONE ANSWER FOR EVERY RUNTIME. The Claude SDK session computed this and the
 * external runtimes (Copilot, Codex) were handed the extra roots alone — so a
 * Copilot turn's sandbox resolved the `flow/` symlink into the vault, found it
 * outside every root, and denied the write ("Permission denied and could not
 * request permission from user"). The agent then saved its brainstorm into its
 * own session folder, where Flow never shows it. Both paths now ask here.
 */
export function sessionWritableRoots(primaryRoot: string, additionalRoots: readonly string[]): string[] {
  const flowRoots = resolveFlowArtifactRoots([primaryRoot, ...additionalRoots])
  return [...new Set([...additionalRoots, ...flowRoots])]
}

/**
 * The scope an EXTERNAL runtime (Copilot, Codex) is handed: everything it may
 * write, plus the resolved targets of plan-flow's linked `.claude` assets.
 *
 * A thread worktree links `.claude/{commands,resources,hooks}` back to the
 * project checkout. Claude Code follows those links; Copilot's sandbox
 * resolves them, finds the checkout outside every root, and denies the READ —
 * measured with a real `copilot -p` turn: "Permission denied and could not
 * request permission from user" without the target in `--add-dir`, the file's
 * contents with it. So a discovery on Copilot could not open the walkthrough
 * template its own skill tells it to fill, and gave up.
 */
export function externalRuntimeRoots(primaryRoot: string, additionalRoots: readonly string[]): string[] {
  const assetRoots = resolveLinkedTargets([primaryRoot, ...additionalRoots], PLAN_FLOW_ASSET_ENTRIES)
  return [...new Set([...sessionWritableRoots(primaryRoot, additionalRoots), ...assetRoots])]
}

/**
 * The Workspace-level FILES an agent's own plan-flow verbs write, for each
 * `flow/` target that is a Workspace project folder.
 *
 * REPORTED LIVE (2026-10-08): `planflow-ai workspace link-knowledge` appends to
 * `<Flow folder>/workspaces/<w>/links.jsonl` — ONE LEVEL ABOVE the project
 * folder `flow/` resolves to (`<w>/projects/<p>`). The session's sandbox held
 * the project folder and not the Workspace above it, so the append was refused
 * and the agent switched the sandbox off to get past it.
 *
 * FILES, NOT THE WORKSPACE FOLDER, ON PURPOSE. That folder holds three things
 * a session must not be able to write:
 *   - `projects/<other>/` — the knowledge of SIBLING projects this thread was
 *     not given (#503). An attached sibling is already writable through its own
 *     `flow/` link; an unattached one must stay out of reach.
 *   - `.git/` — the Workspace repository the APP commits and merges in, outside
 *     any sandbox. A hook planted there would run as the app on the next sync.
 *   - `workspace.json` and `merges/` — written by the app's own CLI calls
 *     (describe, sync), never by an agent's skill.
 * The only Workspace-level write a skill makes is `link-knowledge`
 * (connections learning and sync run in the app's main process, unsandboxed),
 * so the grant is exactly `links.jsonl`. The Claude SDK's sandbox takes file
 * paths (`sandbox.filesystem.allowWrite`, profiled as a `subpath`, which
 * matches the file itself); the external runtimes take directories only, so
 * they get nothing here — see agent-manager.ts.
 *
 * The Workspace is read off the target's own shape — `<workspaces>/<w>/projects/<p>`
 * — under the Flow folder's `workspaces/` as the CLI resolves it
 * (`resolveWorkspacesDir`, never re-derived), compared real to real. Anything
 * else (a vault link, a deeper or shallower path, a target outside the Flow
 * folder) grants nothing.
 */
export const WORKSPACE_AGENT_WRITE_FILES = ['links.jsonl'] as const

export function workspaceAgentWriteFiles(
  flowTargets: readonly string[],
  workspacesDir: string = resolveWorkspacesDir(),
  realpath: (path: string) => string = realpathSync,
): string[] {
  let realWorkspaces: string
  try {
    realWorkspaces = realpath(workspacesDir)
  } catch {
    return [] // no Workspaces on this machine — nothing to grant
  }
  const out = new Set<string>()
  for (const target of flowTargets) {
    const rel = relative(realWorkspaces, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue
    const parts = rel.split(sep)
    if (parts.length !== 3 || parts[1] !== 'projects') continue
    const [workspace, , project] = parts
    if (!isPlainName(workspace) || !isPlainName(project)) continue
    for (const file of WORKSPACE_AGENT_WRITE_FILES) out.add(join(realWorkspaces, workspace, file))
  }
  return [...out]
}

/** A single folder name — never empty, `.`/`..`, or hidden. */
function isPlainName(name: string): boolean {
  return name.length > 0 && !name.startsWith('.')
}

/** The Workspace-level files a Claude SDK session may write (see above). */
export function sessionWorkspaceWriteFiles(primaryRoot: string, additionalRoots: readonly string[]): string[] {
  return workspaceAgentWriteFiles(resolveFlowArtifactRoots([primaryRoot, ...additionalRoots]))
}
