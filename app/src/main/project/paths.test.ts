// Symlink-dimension containment for the project file IPC (#94). The `flow`
// symlink exception must trust ONLY a link that resolves inside the central
// vault — a repointed `flow` link must not widen file access to the whole FS.

import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { realPathStaysInsideRoot, realPathThroughLinksSync } from './paths'

describe('realPathStaysInsideRoot — flow/ trusted-symlink exception (#94)', () => {
  let base: string
  let root: string
  let vault: string
  let outside: string
  const savedVaultEnv = process.env.PLAN_FLOW_VAULT_DIR

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'flow-paths-'))
    root = join(base, 'project')
    vault = join(base, 'vault')
    outside = join(base, 'outside')
    mkdirSync(root, { recursive: true })
    // A realistic vault target: <vault>/projects/project/flow
    const vaultFlow = join(vault, 'projects', 'project', 'flow')
    mkdirSync(vaultFlow, { recursive: true })
    writeFileSync(join(vaultFlow, 'plan.md'), 'x', 'utf8')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8')
    process.env.PLAN_FLOW_VAULT_DIR = vault
    // The legitimate flow/ symlink → into the vault.
    symlinkSync(vaultFlow, join(root, 'flow'), 'dir')
  })

  afterEach(() => {
    if (savedVaultEnv === undefined) delete process.env.PLAN_FLOW_VAULT_DIR
    else process.env.PLAN_FLOW_VAULT_DIR = savedVaultEnv
    rmSync(base, { recursive: true, force: true })
  })

  it('allows a target under a flow/ link that resolves inside the vault', async () => {
    expect(await realPathStaysInsideRoot(root, join(root, 'flow', 'plan.md'))).toBe(true)
  })

  it('allows a plain in-root target', async () => {
    expect(await realPathStaysInsideRoot(root, join(root, 'src', 'index.ts'))).toBe(true)
  })

  it('refuses a repointed flow/ link that escapes the vault (the reported bug)', async () => {
    // Attacker repoints flow → an arbitrary outside dir (an in-root `ln -s`).
    unlinkSync(join(root, 'flow'))
    symlinkSync(outside, join(root, 'flow'), 'dir')
    expect(await realPathStaysInsideRoot(root, join(root, 'flow', 'secret.txt'))).toBe(false)
  })

  it('refuses flow/ repointed at the filesystem root', async () => {
    unlinkSync(join(root, 'flow'))
    symlinkSync('/', join(root, 'flow'), 'dir')
    expect(await realPathStaysInsideRoot(root, join(root, 'flow', 'etc', 'hosts'))).toBe(false)
  })

  it('still rejects an arbitrary escaping symlink (non-flow name)', async () => {
    symlinkSync(outside, join(root, 'evil'), 'dir')
    expect(await realPathStaysInsideRoot(root, join(root, 'evil', 'secret.txt'))).toBe(false)
  })
})

describe('realPathStaysInsideRoot — a flow/ link into a Workspace (the hard migration)', () => {
  let base: string
  let root: string
  let flowHome: string
  let outside: string
  const saved = { home: process.env.PLAN_FLOW_HOME, vault: process.env.PLAN_FLOW_VAULT_DIR }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'flow-paths-ws-'))
    root = join(base, 'project')
    flowHome = join(base, 'plan-flow')
    outside = join(base, 'outside')
    mkdirSync(root, { recursive: true })
    const projectFolder = join(flowHome, 'workspaces', 'default', 'projects', 'project')
    mkdirSync(join(projectFolder, 'discovery'), { recursive: true })
    writeFileSync(join(projectFolder, 'discovery', 'discovery_x_v1.md'), '# x', 'utf8')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8')
    process.env.PLAN_FLOW_HOME = flowHome
    delete process.env.PLAN_FLOW_VAULT_DIR
    symlinkSync(projectFolder, join(root, 'flow'), 'dir')
  })

  afterEach(() => {
    if (saved.home === undefined) delete process.env.PLAN_FLOW_HOME
    else process.env.PLAN_FLOW_HOME = saved.home
    if (saved.vault === undefined) delete process.env.PLAN_FLOW_VAULT_DIR
    else process.env.PLAN_FLOW_VAULT_DIR = saved.vault
    rmSync(base, { recursive: true, force: true })
  })

  it('reads (and writes) a knowledge doc through a flow/ link into a Workspace project folder', async () => {
    expect(await realPathStaysInsideRoot(root, join(root, 'flow', 'discovery', 'discovery_x_v1.md'))).toBe(true)
    // A write target that does not exist yet.
    expect(await realPathStaysInsideRoot(root, join(root, 'flow', 'plans', 'plan_new_v1.md'))).toBe(true)
  })

  it('still refuses a flow/ link anywhere else outside', async () => {
    unlinkSync(join(root, 'flow'))
    symlinkSync(outside, join(root, 'flow'), 'dir')
    expect(await realPathStaysInsideRoot(root, join(root, 'flow', 'secret.txt'))).toBe(false)
  })

  it('refuses a flow/ link at the workspaces folder itself — every Workspace is not one project', async () => {
    unlinkSync(join(root, 'flow'))
    symlinkSync(join(flowHome, 'workspaces'), join(root, 'flow'), 'dir')
    expect(await realPathStaysInsideRoot(root, join(root, 'flow', 'default', 'projects', 'project', 'discovery', 'discovery_x_v1.md'))).toBe(false)
  })
})


describe('realPathThroughLinksSync', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'flow-paths-sync-'))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('resolves the link on the way to a path that does not exist yet', () => {
    const target = join(base, 'workspace', 'p')
    mkdirSync(target, { recursive: true })
    mkdirSync(join(base, 'repo'))
    symlinkSync(target, join(base, 'repo', 'flow'), 'dir')
    expect(realPathThroughLinksSync(join(base, 'repo', 'flow', 'brain', '.structure'))).toBe(
      join(realpathSync(target), 'brain', '.structure'),
    )
  })

  it('answers an existing path with its realpath', () => {
    expect(realPathThroughLinksSync(base)).toBe(realpathSync(base))
  })
})
