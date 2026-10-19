// The flow-link resolver runs against REAL temp directories with REAL symlinks
// — the whole point is how the filesystem resolves them, which a fake would
// only restate.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  CODEX_WRITABLE_ROOTS_NOTICE,
  CodexWritableRootsSupport,
  codexWritableRootsOverride,
  isWritableRootsRejection,
  defaultFlowLinkPolicy,
  resolveFlowLinkTargets as resolveWithPolicy,
  tomlBasicString,
  type FlowLinkPolicy,
} from './flow-link-roots'

describe('resolveFlowLinkTargets', () => {
  let base: string
  /** The temp sandbox's own Flow folder: a vault and a workspaces folder. */
  const policy = (): FlowLinkPolicy => ({
    bases: [join(base, 'vault'), join(base, 'ws')],
    home: join(base, 'home'),
  })
  const resolveFlowLinkTargets = (roots: readonly string[]): Promise<string[]> =>
    resolveWithPolicy(roots, undefined, policy())

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'flow-link-roots-')))
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  function project(name: string): string {
    const root = join(base, name)
    mkdirSync(root, { recursive: true })
    return root
  }

  it('resolves a flow link that points outside the project to its real target', async () => {
    const repo = project('repo')
    const target = project('vault/projects/repo/flow')
    symlinkSync(target, join(repo, 'flow'))
    expect(await resolveFlowLinkTargets([repo])).toEqual([target])
  })

  it('resolves the primary and every attached project, deduplicated', async () => {
    const a = project('a')
    const b = project('b')
    const c = project('c')
    const targetA = project('ws/a')
    const shared = project('ws/shared')
    symlinkSync(targetA, join(a, 'flow'))
    symlinkSync(shared, join(b, 'flow'))
    symlinkSync(shared, join(c, 'flow'))
    expect(await resolveFlowLinkTargets([a, b, c])).toEqual([targetA, shared])
  })

  it('adds nothing for a plain flow directory', async () => {
    const repo = project('repo')
    mkdirSync(join(repo, 'flow'))
    // The positive first: the folder is really there.
    expect(realpathSync(join(repo, 'flow'))).toBe(join(repo, 'flow'))
    expect(await resolveFlowLinkTargets([repo])).toEqual([])
  })

  it('adds nothing for a link that points inside the project', async () => {
    const repo = project('repo')
    mkdirSync(join(repo, 'docs', 'flow'), { recursive: true })
    symlinkSync(join(repo, 'docs', 'flow'), join(repo, 'flow'))
    expect(realpathSync(join(repo, 'flow'))).toBe(join(repo, 'docs', 'flow'))
    expect(await resolveFlowLinkTargets([repo])).toEqual([])
  })

  it('adds nothing for a dangling link, a link to a file, or a missing flow', async () => {
    const dangling = project('dangling')
    symlinkSync(join(base, 'gone'), join(dangling, 'flow'))
    const toFile = project('to-file')
    writeFileSync(join(base, 'a-file'), 'x')
    symlinkSync(join(base, 'a-file'), join(toFile, 'flow'))
    const missing = project('missing')
    expect(await resolveFlowLinkTargets([dangling, toFile, missing])).toEqual([])
  })

  it('never touches the synchronous fs — every call goes through the injected async one', async () => {
    const calls: string[] = []
    const fs = {
      lstat: async (path: string) => {
        calls.push(`lstat ${path}`)
        return { isSymbolicLink: () => true }
      },
      realpath: async (path: string) => {
        calls.push(`realpath ${path}`)
        return path === '/r/flow' ? '/outside/flow' : path
      },
      stat: async (path: string) => {
        calls.push(`stat ${path}`)
        return { isDirectory: () => true }
      },
    }
    expect(await resolveWithPolicy(['/r'], fs, { bases: ['/outside'], home: '/home/me' })).toEqual(['/outside/flow'])
    expect(calls).toEqual(['lstat /r/flow', 'realpath /r/flow', 'stat /outside/flow', 'realpath /r', 'realpath /outside', 'realpath /home/me'])
  })
  it('grants nothing for a link outside the Flow folder\'s workspaces and vault', async () => {
    const repo = project('repo')
    const elsewhere = project('somewhere-else/flow')
    symlinkSync(elsewhere, join(repo, 'flow'))
    // The positive first: inside the vault the same shape IS granted.
    const other = project('other')
    const inVault = project('vault/projects/other/flow')
    symlinkSync(inVault, join(other, 'flow'))
    expect(await resolveFlowLinkTargets([repo, other])).toEqual([inVault])
  })

  it('never grants the filesystem root, the home folder, or an ancestor of the repository', async () => {
    const home = project('home')
    const repo = project('home/code/repo')
    symlinkSync('/', join(repo, 'flow'))
    const repo2 = project('home/code/repo2')
    symlinkSync(home, join(repo2, 'flow'))
    const repo3 = project('home/code/repo3')
    symlinkSync(join(base, 'home', 'code'), join(repo3, 'flow'))
    // Even a policy that (wrongly) names home or `/` as a base grants none of them.
    const wide: FlowLinkPolicy = { bases: ['/', home], home }
    expect(await resolveWithPolicy([repo, repo2, repo3], undefined, wide)).toEqual([])
  })

  it('a link to the vault folder itself, rather than inside it, grants nothing', async () => {
    const repo = project('repo')
    const vault = project('vault')
    symlinkSync(vault, join(repo, 'flow'))
    expect(await resolveFlowLinkTargets([repo])).toEqual([])
  })
})

describe('defaultFlowLinkPolicy', () => {
  it('follows the CLI rule: PLAN_FLOW_HOME/workspaces, and the vault (PLAN_FLOW_VAULT_DIR or <flow folder>/brain)', () => {
    expect(defaultFlowLinkPolicy({ PLAN_FLOW_HOME: '/f' }, '/h').bases).toEqual(['/f/workspaces', '/f/brain'])
    expect(defaultFlowLinkPolicy({ PLAN_FLOW_HOME: '/f', PLAN_FLOW_VAULT_DIR: '/v' }, '/h').bases).toEqual([
      '/f/workspaces',
      '/v',
    ])
    expect(defaultFlowLinkPolicy({ PLAN_FLOW_VAULT_DIR: '/x/brain' }, '/h').bases).toEqual(['/x/workspaces', '/x/brain'])
    expect(defaultFlowLinkPolicy({}, '/h')).toEqual({ bases: ['/h/plan-flow/workspaces', '/h/plan-flow/brain'], home: '/h' })
  })
})

describe('the Codex override', () => {
  it('escapes backslashes, quotes and control characters as a TOML basic string', () => {
    expect(tomlBasicString('/plain/path')).toBe('"/plain/path"')
    expect(tomlBasicString('C:\\Users\\me')).toBe('"C:\\\\Users\\\\me"')
    expect(tomlBasicString('/a "quoted" dir')).toBe('"/a \\"quoted\\" dir"')
    expect(tomlBasicString('/tab\there\nline')).toBe('"/tab\\there\\nline"')
    expect(tomlBasicString('/bell\u0007')).toBe('"/bell\\u0007"')
    expect(tomlBasicString('/café/naïve')).toBe('"/café/naïve"')
  })

  it('names every absolute root in one array value', () => {
    expect(codexWritableRootsOverride(['/ws/a/flow', '/other/b'])).toBe(
      'sandbox_workspace_write.writable_roots=["/ws/a/flow", "/other/b"]',
    )
  })

  it('drops relative and empty paths, and duplicates', () => {
    expect(codexWritableRootsOverride(['/ws/a', 'relative/flow', '', '/ws/a'])).toBe(
      'sandbox_workspace_write.writable_roots=["/ws/a"]',
    )
  })

  it('is absent when nothing is left to grant', () => {
    expect(codexWritableRootsOverride([])).toBeNull()
    expect(codexWritableRootsOverride(['flow'])).toBeNull()
  })
})

describe('refusal detection', () => {
  it('recognises the config error Codex prints when it rejects the key', () => {
    // Measured on codex 0.19 with a value of the wrong type.
    const said =
      'Reading prompt from stdin... ERROR codex_core::config: Failed to deserialize overridden config: ' +
      'invalid type: integer `5`, expected a sequence in `sandbox_workspace_write.writable_roots`'
    expect(isWritableRootsRejection(said)).toBe(true)
  })

  it('does not mistake another config error for it', () => {
    const said =
      'Failed to deserialize overridden config: unknown variant `xhigh`, expected one of `low`, `medium`, `high` in `model_reasoning_effort`'
    expect(isWritableRootsRejection(said)).toBe(false)
  })

  it('remembers a refusal per executable and reports only the first', () => {
    const support = new CodexWritableRootsSupport()
    expect(support.refuses('codex')).toBe(false)
    expect(support.markRefused('codex')).toBe(true)
    expect(support.refuses('codex')).toBe(true)
    expect(support.markRefused('codex')).toBe(false)
    expect(support.refuses('/opt/other/codex')).toBe(false)
  })

  it('says it in plain words — no paths, config keys or commands', () => {
    expect(CODEX_WRITABLE_ROOTS_NOTICE).not.toMatch(/[`/]|writable_roots|sandbox|codex exec|-c /)
  })
})
