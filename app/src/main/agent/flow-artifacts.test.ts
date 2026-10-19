import { join } from 'path'

import {
  FILE_EDIT_TOOLS,
  isFlowArtifactPath,
  isFlowArtifactPathForAny,
  externalRuntimeRoots,
  resolveFlowArtifactRoots,
  containmentRoots,
  resolveLinkedTargets,
  sessionWritableRoots,
  workspaceAgentWriteFiles,
} from './flow-artifacts'

const ROOT = '/home/user/project'

describe('isFlowArtifactPath', () => {
  it('matches files directly under flow/', () => {
    expect(isFlowArtifactPath(ROOT, join(ROOT, 'flow/tasklist.md'))).toBe(true)
    expect(isFlowArtifactPath(ROOT, join(ROOT, 'flow/brain/index.md'))).toBe(true)
    expect(isFlowArtifactPath(ROOT, join(ROOT, 'flow/plans/plan_x_v1.md'))).toBe(true)
  })

  it('does not match real project files', () => {
    expect(isFlowArtifactPath(ROOT, join(ROOT, 'src/index.ts'))).toBe(false)
    expect(isFlowArtifactPath(ROOT, join(ROOT, 'README.md'))).toBe(false)
  })

  it('does not match the flow directory entry itself or the root', () => {
    expect(isFlowArtifactPath(ROOT, join(ROOT, 'flow'))).toBe(true) // the dir counts as flow-scoped
    expect(isFlowArtifactPath(ROOT, ROOT)).toBe(false)
  })

  it('does not false-match a sibling like flowers/', () => {
    expect(isFlowArtifactPath(ROOT, join(ROOT, 'flowers/notes.md'))).toBe(false)
    expect(isFlowArtifactPath(ROOT, join(ROOT, 'flow-archive/x.md'))).toBe(false)
  })

  it('does not match a flow/ dir outside the project root', () => {
    expect(isFlowArtifactPath(ROOT, '/home/user/other/flow/tasklist.md')).toBe(false)
    expect(isFlowArtifactPath(ROOT, '/home/user/flow/tasklist.md')).toBe(false)
  })

  it('scopes the edit tools it applies to', () => {
    expect(FILE_EDIT_TOOLS.has('Edit')).toBe(true)
    expect(FILE_EDIT_TOOLS.has('Write')).toBe(true)
    expect(FILE_EDIT_TOOLS.has('Bash')).toBe(false)
  })
})

describe('isFlowArtifactPathForAny (#45 multi-project)', () => {
  const ENGINE = '/work/engine'
  const FRONTEND = '/work/frontend'

  it('matches a flow/ artifact under ANY thread root', () => {
    const roots = [ENGINE, FRONTEND]
    expect(isFlowArtifactPathForAny(roots, join(ENGINE, 'flow/tasklist.md'))).toBe(true)
    expect(isFlowArtifactPathForAny(roots, join(FRONTEND, 'flow/plans/p.md'))).toBe(true)
  })

  it('does not match a real source file in any root', () => {
    const roots = [ENGINE, FRONTEND]
    expect(isFlowArtifactPathForAny(roots, join(FRONTEND, 'src/app.tsx'))).toBe(false)
    expect(isFlowArtifactPathForAny([], join(ENGINE, 'flow/tasklist.md'))).toBe(false)
  })
})

/**
 * THE GAP BETWEEN WHAT WRITE MAY DO AND WHAT BASH MAY DO.
 *
 * `flow/` is normally a symlink into the plan-flow vault. The predicates above
 * are LEXICAL, so the Write tool has always been allowed to write `flow/x.md`.
 * Anything Bash spawns is bound by the SDK's sandbox instead, which RESOLVES the
 * link and lands outside every root — so `planflow-ai blueprint propose` /
 * `observe` / `narrate` were denied at the filesystem.
 *
 * The denial never said so. The store's lock treated it as contention and
 * reported `store busy — retry`, which cannot clear because nothing is locked; a
 * user regenerated the same document five times against it. `proposals.jsonl`
 * was never written by any agent in any project.
 */
describe('containmentRoots', () => {
  const made: string[] = []

  function tmp(prefix: string): string {
    const dir = require('fs').mkdtempSync(join(require('os').tmpdir(), prefix))
    made.push(dir)
    return dir
  }

  afterAll(() => {
    for (const dir of made) require('fs').rmSync(dir, { recursive: true, force: true })
  })

  it('counts a root\'s own linked knowledge folder as inside it, and nothing else', () => {
    const root = tmp('flow-cr-')
    const workspace = tmp('flow-cr-ws-')
    const own = join(workspace, 'projects', 'core')
    const sibling = join(workspace, 'projects', 'app')
    require('fs').mkdirSync(own, { recursive: true })
    require('fs').mkdirSync(sibling, { recursive: true })
    require('fs').symlinkSync(own, join(root, 'flow'))
    const roots = containmentRoots([root])
    expect(roots).toEqual([root, require('fs').realpathSync(own)])
    expect(roots.some((r) => r.includes(join('projects', 'app')))).toBe(false)
  })

  it('is just the roots when flow/ is a plain folder or missing', () => {
    const root = tmp('flow-cr-')
    expect(containmentRoots([root])).toEqual([root])
  })
})

describe('resolveFlowArtifactRoots', () => {
  const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = require('fs') as typeof import('fs')
  const { tmpdir } = require('os') as typeof import('os')
  const made: string[] = []

  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'flow-artifacts-'))
    made.push(dir)
    return dir
  }

  afterAll(() => {
    for (const dir of made) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  })

  it('returns the resolved target when flow/ is a symlink out of the root', () => {
    const root = tmp()
    const vault = tmp()
    const target = join(vault, 'flow')
    mkdirSync(target)
    symlinkSync(target, join(root, 'flow'))

    // The whole point: the target is OUTSIDE the root, so the SDK sandbox needs
    // it named explicitly or Bash cannot write there.
    expect(resolveFlowArtifactRoots([root])).toEqual([require('fs').realpathSync(target)])
  })

  it('returns nothing for a PLAIN flow/ directory — it is already in scope', () => {
    const root = tmp()
    mkdirSync(join(root, 'flow'))
    // Widening here would grant scope that already exists; an empty result keeps
    // the session byte-identical for projects that never used the vault.
    expect(resolveFlowArtifactRoots([root])).toEqual([])
  })

  it('returns nothing when flow/ does not exist, rather than inventing scope', () => {
    expect(resolveFlowArtifactRoots([tmp()])).toEqual([])
  })

  it('never throws on an unreadable or dangling link', () => {
    const root = tmp()
    symlinkSync(join(root, 'nowhere-at-all'), join(root, 'flow'))
    expect(() => resolveFlowArtifactRoots([root])).not.toThrow()
    expect(resolveFlowArtifactRoots([root])).toEqual([])
  })

  it('deduplicates — multi-project threads can share one vault', () => {
    const vault = tmp()
    const target = join(vault, 'flow')
    mkdirSync(target)
    const a = tmp()
    const b = tmp()
    symlinkSync(target, join(a, 'flow'))
    symlinkSync(target, join(b, 'flow'))

    expect(resolveFlowArtifactRoots([a, b])).toHaveLength(1)
  })
})

describe('sessionWritableRoots', () => {
  const { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } = require('fs') as typeof import('fs')
  const { tmpdir } = require('os') as typeof import('os')
  const made: string[] = []
  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'flow-writable-'))
    made.push(dir)
    return dir
  }
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })

  it('lists the extra roots, then the resolved flow/ target of every root', () => {
    const primary = tmp()
    const extra = tmp()
    const vault = tmp()
    const target = join(vault, 'flow')
    mkdirSync(target)
    symlinkSync(target, join(primary, 'flow'))
    expect(sessionWritableRoots(primary, [extra])).toEqual([extra, realpathSync(target)])
  })

  it('adds nothing for a plain flow/ directory and no extra roots', () => {
    const primary = tmp()
    mkdirSync(join(primary, 'flow'))
    expect(sessionWritableRoots(primary, [])).toEqual([])
  })
})

describe('externalRuntimeRoots', () => {
  const { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } = require('fs') as typeof import('fs')
  const { tmpdir } = require('os') as typeof import('os')
  const made: string[] = []
  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'flow-external-'))
    made.push(dir)
    return dir
  }
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })

  it('adds the resolved targets of a worktree\'s linked .claude assets after the writable roots', () => {
    const checkout = tmp()
    const worktree = tmp()
    const vault = tmp()
    mkdirSync(join(vault, 'flow'))
    symlinkSync(join(vault, 'flow'), join(worktree, 'flow'))
    mkdirSync(join(worktree, '.claude'))
    for (const entry of ['commands', 'resources', 'hooks']) {
      mkdirSync(join(checkout, '.claude', entry), { recursive: true })
      symlinkSync(join(checkout, '.claude', entry), join(worktree, '.claude', entry))
    }
    expect(externalRuntimeRoots(worktree, [])).toEqual([
      realpathSync(join(vault, 'flow')),
      ...['commands', 'resources', 'hooks'].map((entry) => realpathSync(join(checkout, '.claude', entry))),
    ])
  })

  it('adds nothing for plain .claude directories, and never a link that stays inside the root', () => {
    const root = tmp()
    mkdirSync(join(root, '.claude', 'commands'), { recursive: true })
    mkdirSync(join(root, 'shared'))
    symlinkSync(join(root, 'shared'), join(root, '.claude', 'resources'))
    expect(externalRuntimeRoots(root, [])).toEqual([])
    expect(resolveLinkedTargets([root], ['.claude/missing'])).toEqual([])
  })
})

describe('workspaceAgentWriteFiles (2026-10-08 — link-knowledge under the sandbox)', () => {
  const { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } = require('fs') as typeof import('fs')
  const { tmpdir } = require('os') as typeof import('os')
  const made: string[] = []
  function tmp(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flow-ws-files-')))
    made.push(dir)
    return dir
  }
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })

  /** `<Flow folder>/workspaces/<w>/projects/{a,b}` plus a repo linked to `a`. */
  function workspace(): { workspaces: string; ws: string; repo: string; target: string } {
    const flowFolder = tmp()
    const workspaces = join(flowFolder, 'workspaces')
    const ws = join(workspaces, 'orbit')
    const target = join(ws, 'projects', 'orbit-app')
    mkdirSync(target, { recursive: true })
    mkdirSync(join(ws, 'projects', 'orbit-core'), { recursive: true })
    mkdirSync(join(ws, '.git'), { recursive: true })
    const repo = tmp()
    symlinkSync(target, join(repo, 'flow'))
    return { workspaces, ws, repo, target }
  }

  it("grants the Workspace's links.jsonl for a flow/ that is a Workspace project folder", () => {
    const { workspaces, ws, repo } = workspace()
    const targets = resolveFlowArtifactRoots([repo])
    expect(workspaceAgentWriteFiles(targets, workspaces)).toEqual([join(ws, 'links.jsonl')])
  })

  it('grants ONLY that file — never the Workspace folder, its .git, workspace.json or a sibling', () => {
    const { workspaces, ws, target } = workspace()
    const granted = workspaceAgentWriteFiles([target], workspaces)
    // The positive first (allowed-pattern #28): something IS granted.
    expect(granted).toHaveLength(1)
    for (const forbidden of [
      ws,
      join(ws, '.git'),
      join(ws, '.git', 'hooks'),
      join(ws, 'workspace.json'),
      join(ws, 'merges'),
      join(ws, 'connections-learning.jsonl'),
      join(ws, 'projects'),
      join(ws, 'projects', 'orbit-core'),
    ]) {
      expect(granted).not.toContain(forbidden)
      // and nothing granted CONTAINS a forbidden path (a subpath grant would)
      expect(granted.some((path) => forbidden.startsWith(`${path}/`))).toBe(false)
    }
  })

  it('grants nothing for a vault link, a non-project shape, or a target outside workspaces/', () => {
    const { workspaces, ws } = workspace()
    const vaultTarget = join(tmp(), 'brain', 'projects', 'x', 'flow')
    expect(workspaceAgentWriteFiles([vaultTarget], workspaces)).toEqual([])
    expect(workspaceAgentWriteFiles([ws], workspaces)).toEqual([]) // the Workspace itself
    expect(workspaceAgentWriteFiles([join(ws, 'projects')], workspaces)).toEqual([])
    expect(workspaceAgentWriteFiles([join(ws, 'projects', 'p', 'brain')], workspaces)).toEqual([])
    expect(workspaceAgentWriteFiles([join(ws, 'other', 'p')], workspaces)).toEqual([])
    expect(workspaceAgentWriteFiles([join(ws, 'projects', '.hidden')], workspaces)).toEqual([])
    // Same shape, wrong Flow folder: a repointed link earns nothing.
    const elsewhere = join(tmp(), 'workspaces', 'w', 'projects', 'p')
    expect(workspaceAgentWriteFiles([elsewhere], workspaces)).toEqual([])
  })

  it('deduplicates two projects of one Workspace and grants nothing without a workspaces/ folder', () => {
    const { workspaces, ws } = workspace()
    const both = [join(ws, 'projects', 'orbit-app'), join(ws, 'projects', 'orbit-core')]
    expect(workspaceAgentWriteFiles(both, workspaces)).toEqual([join(ws, 'links.jsonl')])
    expect(workspaceAgentWriteFiles(both, join(tmp(), 'missing'))).toEqual([])
  })
})
