// Provisioner — the PURE decision core (exhaustive), the in-flight guard, the
// fail-soft bundle-version parse, and the effect wrapper's stamp-on-success /
// toast-on-failure behavior. All spawn/fs effects are injected, so the suite is
// sqlite-free and runs under plain CJS ts-jest (no Electron ABI needed).

import { EventEmitter } from 'events'
import type { ChildProcess, spawn } from 'child_process'

import type { FlowNotification } from '../../shared/ipc-contract'
import type { BundledCli } from '../blueprint/derive-runner'
import {
  decideProvisioning,
  initialProvisioningState,
  INIT_ARGS,
  nextStateForDecision,
  nextStateForOutcome,
  Provisioner,
  readBundleVersionFromDisk,
  bundleStamp,
  REFRESH_ARGS,
  runBundledCli,
  type ProvisionerRoot,
  type ProvisioningState,
  lastLine,
} from './provisioner'

const BUNDLED: BundledCli = { execPath: '/Flow', cliPath: '/res/cli/planflow-ai.mjs' }

// ── decision core ──────────────────────────────────────────────────────────

describe('decideProvisioning (pure)', () => {
  it('skips an unavailable root before anything else', () => {
    // Even with a stale stamp + a bundle version, unreachable roots never run.
    expect(decideProvisioning({ available: false, provisionedVersion: '0.1.0' }, '1.0.0', false)).toEqual({
      action: 'skip',
      reason: 'unavailable',
    })
  })

  it('skips when a run is already in flight (before the version checks)', () => {
    expect(decideProvisioning({ available: true }, '1.0.0', true)).toEqual({
      action: 'skip',
      reason: 'in-flight',
    })
  })

  it('skips when there is no bundled CLI version to run', () => {
    expect(decideProvisioning({ available: true }, null, false)).toEqual({
      action: 'skip',
      reason: 'no-bundled-cli',
    })
  })

  it('provisions an available, never-stamped root', () => {
    expect(decideProvisioning({ available: true }, '1.0.0', false)).toEqual({ action: 'provision' })
  })

  it('refreshes when the stamp differs from the bundle version', () => {
    expect(decideProvisioning({ available: true, provisionedVersion: '0.9.0' }, '1.0.0', false)).toEqual({
      action: 'refresh',
    })
  })

  it('skips when the stamp already equals the bundle version', () => {
    expect(decideProvisioning({ available: true, provisionedVersion: '1.0.0' }, '1.0.0', false)).toEqual({
      action: 'skip',
      reason: 'current',
    })
  })

  it('provisions a root stamped with an empty-string version (treated as unset only when undefined)', () => {
    // An explicit '' stamp is a value → it differs from a real bundle version → refresh.
    expect(decideProvisioning({ available: true, provisionedVersion: '' }, '1.0.0', false)).toEqual({
      action: 'refresh',
    })
  })
})

// ── readiness state machine (pure, #513 progressive-learning phase 1) ───────

describe('initialProvisioningState (pure, startup snapshot)', () => {
  it('starts ready when the stamp already equals the bundle version', () => {
    expect(initialProvisioningState({ available: true, provisionedVersion: '1.0.0' }, '1.0.0')).toBe('ready')
  })

  it('starts idle when never provisioned', () => {
    expect(initialProvisioningState({ available: true }, '1.0.0')).toBe('idle')
  })

  it('starts idle when the stamp differs from the bundle version (drift)', () => {
    expect(initialProvisioningState({ available: true, provisionedVersion: '0.9.0' }, '1.0.0')).toBe('idle')
  })

  it('starts idle when there is no bundled CLI version to compare against', () => {
    expect(initialProvisioningState({ available: true, provisionedVersion: '1.0.0' }, null)).toBe('idle')
  })
})

describe('nextStateForDecision (pure)', () => {
  it('provisioning for a provision decision', () => {
    expect(nextStateForDecision({ action: 'provision' })).toBe('provisioning')
  })

  it('provisioning for a refresh decision', () => {
    expect(nextStateForDecision({ action: 'refresh' })).toBe('provisioning')
  })

  it('ready immediately for a skip/current decision', () => {
    expect(nextStateForDecision({ action: 'skip', reason: 'current' })).toBe('ready')
  })

  it('undefined (leave existing state) for skip/unavailable', () => {
    expect(nextStateForDecision({ action: 'skip', reason: 'unavailable' })).toBeUndefined()
  })

  it('undefined (leave existing state) for skip/in-flight', () => {
    expect(nextStateForDecision({ action: 'skip', reason: 'in-flight' })).toBeUndefined()
  })

  it('undefined (leave existing state) for skip/no-bundled-cli', () => {
    expect(nextStateForDecision({ action: 'skip', reason: 'no-bundled-cli' })).toBeUndefined()
  })
})

describe('nextStateForOutcome (pure)', () => {
  it('ready on success', () => {
    expect(nextStateForOutcome(true)).toBe('ready')
  })

  it('failed on failure', () => {
    expect(nextStateForOutcome(false)).toBe('failed')
  })
})

// ── fail-soft bundle-version parse ───────────────────────────────────────────

describe('readBundleVersionFromDisk (fail-soft)', () => {
  it('returns null when the package.json is missing/unreadable', () => {
    // The bundle dir does not exist in the dev checkout — must not throw.
    expect(readBundleVersionFromDisk({ execPath: '/x', cliPath: '/nope/cli/planflow-ai.mjs' })).toBeNull()
  })

  const made: string[] = []

  afterAll(() => {
    const { rmSync } = require('fs') as typeof import('fs')
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
  })

  function bundleWith(pkg: object): BundledCli {
    const { mkdtempSync, writeFileSync } = require('fs') as typeof import('fs')
    const dir = mkdtempSync(require('path').join(require('os').tmpdir(), 'flow-bundle-'))
    made.push(dir)
    writeFileSync(require('path').join(dir, 'package.json'), JSON.stringify(pkg))
    return { execPath: '/x', cliPath: require('path').join(dir, 'planflow-ai.mjs') }
  }

  it('stamps with the assets hash when the bundle carries one', () => {
    expect(readBundleVersionFromDisk(bundleWith({ version: '1.4.3', assetsHash: '66f2e13a48851e3e' }))).toBe(
      '1.4.3+66f2e13a48851e3e',
    )
  })

  it('stamps by version alone for an older bundle without a hash', () => {
    expect(readBundleVersionFromDisk(bundleWith({ version: '1.4.3' }))).toBe('1.4.3')
  })
})

describe('bundleStamp — a skill edit reaches projects without a version bump', () => {
  it('joins version and hash as semver build metadata, or is the version alone', () => {
    expect(bundleStamp('1.4.3', 'abc')).toBe('1.4.3+abc')
    expect(bundleStamp('1.4.3', undefined)).toBe('1.4.3')
    expect(bundleStamp('1.4.3', '')).toBe('1.4.3')
  })

  it('refreshes a project stamped at the same version when the assets changed', () => {
    // The live case: orbit-app was stamped 1.4.3 while the bundle's discovery
    // skill gained a whole step, still at 1.4.3 — and read as current.
    expect(decideProvisioning({ available: true, provisionedVersion: '1.4.3' }, '1.4.3', false)).toEqual({
      action: 'skip',
      reason: 'current',
    })
    expect(
      decideProvisioning({ available: true, provisionedVersion: '1.4.3' }, bundleStamp('1.4.3', 'new'), false),
    ).toEqual({ action: 'refresh' })
    expect(
      decideProvisioning(
        { available: true, provisionedVersion: bundleStamp('1.4.3', 'old') },
        bundleStamp('1.4.3', 'new'),
        false,
      ),
    ).toEqual({ action: 'refresh' })
  })
})

// ── injected spawn harness ───────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stderr = new EventEmitter()
  stdout = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

/** A fake spawn driving each FakeChild via `onSpawn`, capturing the calls. */
function fakeSpawn(onSpawn: (args: string[], child: FakeChild) => void) {
  const calls: Array<{ command: string; args: string[]; opts: { env?: Record<string, string>; cwd?: string } }> = []
  const spawnFn = ((command: string, args: string[], opts: { env?: Record<string, string>; cwd?: string }) => {
    const child = new FakeChild()
    calls.push({ command, args, opts })
    onSpawn(args, child)
    return child as unknown as ChildProcess
  }) as unknown as typeof spawn
  return { spawnFn, calls }
}

// ── runBundledCli (shared init-spawn helper) ─────────────────────────────────

describe('runBundledCli', () => {
  it('spawns the bundled CLI as Electron-as-node and resolves ok on exit 0', async () => {
    const { spawnFn, calls } = fakeSpawn((_args, child) => setImmediate(() => child.emit('close', 0)))
    const result = await runBundledCli(BUNDLED, '/proj', INIT_ARGS, { spawnFn })
    expect(result).toEqual({ ok: true, launched: true })
    expect(calls[0]?.command).toBe(BUNDLED.execPath)
    expect(calls[0]?.args).toEqual([BUNDLED.cliPath, ...INIT_ARGS])
    expect(calls[0]?.opts.cwd).toBe('/proj')
    expect(calls[0]?.opts.env?.['ELECTRON_RUN_AS_NODE']).toBe('1')
  })

  it('provisions as a Workspace project — the knowledge folder is left to the Workspace', async () => {
    expect(INIT_ARGS).toContain('--workspace-managed')
    expect(REFRESH_ARGS).not.toContain('--workspace-managed')
  })

  it('reports the last stderr line on a non-zero exit', async () => {
    const { spawnFn } = fakeSpawn((_args, child) =>
      setImmediate(() => {
        child.stderr.emit('data', 'working\ninit refused: no existing install\n')
        child.emit('close', 1)
      }),
    )
    const result = await runBundledCli(BUNDLED, '/proj', REFRESH_ARGS, { spawnFn })
    expect(result).toEqual({ ok: false, launched: true, error: 'init refused: no existing install' })
  })

  it('resolves launched:false when spawn throws synchronously', async () => {
    const spawnFn = (() => {
      throw new Error('ENOENT')
    }) as unknown as typeof spawn
    const result = await runBundledCli(BUNDLED, '/proj', INIT_ARGS, { spawnFn })
    expect(result).toEqual({ ok: false, launched: false, error: 'ENOENT' })
  })

  it('kills the child and reports a timeout when the run hangs', async () => {
    let spawned: FakeChild | null = null
    const { spawnFn } = fakeSpawn((_args, child) => {
      spawned = child // never emits close
    })
    const result = await runBundledCli(BUNDLED, '/proj', INIT_ARGS, { spawnFn, timeoutMs: 5 })
    expect(result).toEqual({ ok: false, launched: true, error: 'timed out' })
    expect(spawned!.killed).toBe(true)
  })
})

// ── Provisioner (effect wrapper) ─────────────────────────────────────────────

const ROOT: ProvisionerRoot = { id: 'r1', rootPath: '/proj' }

describe('Provisioner.maybeProvision', () => {
  it('provisions a never-stamped root and stamps it with the bundle version', async () => {
    const stamps: Array<{ rootId: string; version: string; at: string }> = []
    const notifications: FlowNotification[] = []
    const { spawnFn, calls } = fakeSpawn((_args, child) => setImmediate(() => child.emit('close', 0)))
    const provisioner = new Provisioner({
      bundledCli: BUNDLED,
      stampProvisioned: (rootId, version, at) => stamps.push({ rootId, version, at }),
      notify: (n) => notifications.push(n),
      spawnFn,
      readBundleVersion: () => '1.0.0',
      now: () => new Date('2026-07-15T00:00:00.000Z'),
    })
    await provisioner.maybeProvision(ROOT)
    expect(calls[0]?.args).toEqual([BUNDLED.cliPath, ...INIT_ARGS])
    expect(stamps).toEqual([{ rootId: 'r1', version: '1.0.0', at: '2026-07-15T00:00:00.000Z' }])
    expect(notifications).toEqual([])
  })

  it('refreshes a version-drifted root via init --refresh-owned', async () => {
    const stamps: Array<{ rootId: string; version: string; at: string }> = []
    const { spawnFn, calls } = fakeSpawn((_args, child) => setImmediate(() => child.emit('close', 0)))
    const provisioner = new Provisioner({
      bundledCli: BUNDLED,
      stampProvisioned: (rootId, version, at) => stamps.push({ rootId, version, at }),
      notify: () => undefined,
      spawnFn,
      readBundleVersion: () => '1.0.0',
      hasInstall: async () => true,
    })
    await provisioner.maybeProvision({ id: 'r1', rootPath: '/proj', provisionedVersion: '0.9.0' })
    expect(calls[0]?.args).toEqual([BUNDLED.cliPath, ...REFRESH_ARGS])
    expect(stamps[0]?.version).toBe('1.0.0')
  })

  it('sets up in full a stamped root that has no install to refresh (live: orbit-argo-applications, "Could not update plan-flow")', async () => {
    const stamps: Array<{ rootId: string; version: string; at: string }> = []
    const notifications: FlowNotification[] = []
    const { spawnFn, calls } = fakeSpawn((_args, child) => setImmediate(() => child.emit('close', 0)))
    const asked: string[] = []
    const provisioner = new Provisioner({
      bundledCli: BUNDLED,
      stampProvisioned: (rootId, version, at) => stamps.push({ rootId, version, at }),
      notify: (n) => notifications.push(n),
      spawnFn,
      readBundleVersion: () => '1.0.0',
      hasInstall: async (rootPath) => (asked.push(rootPath), false),
    })
    await provisioner.maybeProvision({ id: 'r1', rootPath: '/proj', provisionedVersion: '0.9.0' })
    expect(asked).toEqual(['/proj'])
    expect(calls.map((call) => call.args)).toEqual([[BUNDLED.cliPath, ...INIT_ARGS]])
    expect(stamps[0]?.version).toBe('1.0.0')
    expect(notifications).toEqual([])
  })

  it('skips a root already at the bundle version (never spawns)', async () => {
    const { spawnFn, calls } = fakeSpawn(() => undefined)
    const stamps: unknown[] = []
    const provisioner = new Provisioner({
      bundledCli: BUNDLED,
      stampProvisioned: () => stamps.push(1),
      notify: () => undefined,
      spawnFn,
      readBundleVersion: () => '1.0.0',
    })
    await provisioner.maybeProvision({ id: 'r1', rootPath: '/proj', provisionedVersion: '1.0.0' })
    expect(calls).toEqual([])
    expect(stamps).toEqual([])
  })

  it('skips an unavailable root (never spawns)', async () => {
    const { spawnFn, calls } = fakeSpawn(() => undefined)
    const provisioner = new Provisioner({
      bundledCli: BUNDLED,
      stampProvisioned: () => undefined,
      notify: () => undefined,
      spawnFn,
      readBundleVersion: () => '1.0.0',
    })
    await provisioner.maybeProvision({ id: 'r1', rootPath: '/proj', available: false })
    expect(calls).toEqual([])
  })

  it('skips when there is no bundled CLI at all (never spawns)', async () => {
    const { spawnFn, calls } = fakeSpawn(() => undefined)
    const provisioner = new Provisioner({
      bundledCli: null,
      stampProvisioned: () => undefined,
      notify: () => undefined,
      spawnFn,
    })
    await provisioner.maybeProvision(ROOT)
    expect(calls).toEqual([])
  })

  it('emits ONE error toast and leaves the root unstamped on failure', async () => {
    const stamps: unknown[] = []
    const notifications: FlowNotification[] = []
    const { spawnFn } = fakeSpawn((_args, child) =>
      setImmediate(() => {
        child.stderr.emit('data', 'boom: write failed\n')
        child.emit('close', 1)
      }),
    )
    const provisioner = new Provisioner({
      bundledCli: BUNDLED,
      stampProvisioned: () => stamps.push(1),
      notify: (n) => notifications.push(n),
      spawnFn,
      readBundleVersion: () => '1.0.0',
    })
    await provisioner.maybeProvision(ROOT)
    expect(stamps).toEqual([]) // re-runnable — never stamped
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.level).toBe('error')
    expect(notifications[0]?.rootId).toBe('/proj')
    expect(notifications[0]?.body).toContain('boom: write failed')
  })

  it('serializes concurrent triggers for the same root (in-flight guard)', async () => {
    const children: FakeChild[] = []
    const stamps: Array<{ version: string }> = []
    const { spawnFn, calls } = fakeSpawn((_args, child) => children.push(child))
    const provisioner = new Provisioner({
      bundledCli: BUNDLED,
      stampProvisioned: (_r, version) => stamps.push({ version }),
      notify: () => undefined,
      spawnFn,
      readBundleVersion: () => '1.0.0',
    })
    // Two overlapping triggers — the second must see the first in flight and skip.
    const first = provisioner.maybeProvision(ROOT)
    const second = provisioner.maybeProvision(ROOT)
    expect(calls).toHaveLength(1) // only one spawn while the first is in flight
    children[0]?.emit('close', 0)
    await Promise.all([first, second])
    expect(stamps).toHaveLength(1)
  })
})

// ── Provisioner.onStateChange (readiness transitions, #513 phase 1) ─────────

describe('Provisioner.onStateChange', () => {
  it('emits provisioning then ready for a successful never-stamped run', async () => {
    const transitions: Array<{ rootId: string; state: ProvisioningState }> = []
    const { spawnFn, calls } = fakeSpawn((_args, child) => setImmediate(() => child.emit('close', 0)))
    const provisioner = new Provisioner({
      bundledCli: BUNDLED,
      stampProvisioned: () => undefined,
      notify: () => undefined,
      spawnFn,
      readBundleVersion: () => '1.0.0',
    })
    provisioner.onStateChange((rootId, state) => transitions.push({ rootId, state }))
    await provisioner.maybeProvision(ROOT)
    expect(calls).toHaveLength(1)
    expect(transitions).toEqual([
      { rootId: 'r1', state: 'provisioning' },
      { rootId: 'r1', state: 'ready' },
    ])
  })

  it('resolves ready immediately (no run) for an already-current root', async () => {
    const transitions: Array<{ rootId: string; state: ProvisioningState }> = []
    const { spawnFn, calls } = fakeSpawn(() => undefined)
    const provisioner = new Provisioner({
      bundledCli: BUNDLED,
      stampProvisioned: () => undefined,
      notify: () => undefined,
      spawnFn,
      readBundleVersion: () => '1.0.0',
    })
    provisioner.onStateChange((rootId, state) => transitions.push({ rootId, state }))
    await provisioner.maybeProvision({ id: 'r1', rootPath: '/proj', provisionedVersion: '1.0.0' })
    expect(calls).toEqual([])
    expect(transitions).toEqual([{ rootId: 'r1', state: 'ready' }])
  })

  it('transitions failure → retry → ready across two triggers', async () => {
    const transitions: Array<{ rootId: string; state: ProvisioningState }> = []
    const stamps: Array<{ rootId: string; version: string }> = []
    let call = 0
    const { spawnFn, calls } = fakeSpawn((_args, child) => {
      call += 1
      if (call === 1) {
        setImmediate(() => {
          child.stderr.emit('data', 'boom: write failed\n')
          child.emit('close', 1)
        })
      } else {
        setImmediate(() => child.emit('close', 0))
      }
    })
    const provisioner = new Provisioner({
      bundledCli: BUNDLED,
      stampProvisioned: (rootId, version) => stamps.push({ rootId, version }),
      notify: () => undefined,
      spawnFn,
      readBundleVersion: () => '1.0.0',
    })
    provisioner.onStateChange((rootId, state) => transitions.push({ rootId, state }))

    // First trigger: the run fails and leaves the root unstamped.
    await provisioner.maybeProvision(ROOT)
    // Second trigger (retry): decideProvisioning sees the same unstamped root
    // and provisions again — this time it succeeds.
    await provisioner.maybeProvision(ROOT)

    expect(calls).toHaveLength(2)
    expect(stamps).toEqual([{ rootId: 'r1', version: '1.0.0' }])
    expect(transitions).toEqual([
      { rootId: 'r1', state: 'provisioning' },
      { rootId: 'r1', state: 'failed' },
      { rootId: 'r1', state: 'provisioning' },
      { rootId: 'r1', state: 'ready' },
    ])
  })

  it('reports provisioning for a direct provisionRoot call (manual re-provision, bypasses decideProvisioning)', async () => {
    const transitions: Array<{ rootId: string; state: ProvisioningState }> = []
    const { spawnFn } = fakeSpawn((_args, child) => setImmediate(() => child.emit('close', 0)))
    const provisioner = new Provisioner({
      bundledCli: BUNDLED,
      stampProvisioned: () => undefined,
      notify: () => undefined,
      spawnFn,
      readBundleVersion: () => '1.0.0',
    })
    provisioner.onStateChange((rootId, state) => transitions.push({ rootId, state }))
    await provisioner.provisionRoot({ id: 'r1', rootPath: '/proj', provisionedVersion: '1.0.0' }, 'provision')
    expect(transitions).toEqual([
      { rootId: 'r1', state: 'provisioning' },
      { rootId: 'r1', state: 'ready' },
    ])
  })

  it('unsubscribe stops further notifications', async () => {
    const transitions: Array<{ rootId: string; state: ProvisioningState }> = []
    const { spawnFn } = fakeSpawn((_args, child) => setImmediate(() => child.emit('close', 0)))
    const provisioner = new Provisioner({
      bundledCli: BUNDLED,
      stampProvisioned: () => undefined,
      notify: () => undefined,
      spawnFn,
      readBundleVersion: () => '1.0.0',
    })
    const unsubscribe = provisioner.onStateChange((rootId, state) => transitions.push({ rootId, state }))
    unsubscribe()
    await provisioner.maybeProvision(ROOT)
    expect(transitions).toEqual([])
  })
})

// ── Provisioner.initialStateFor (#513 phase 1) ───────────────────────────────

describe('Provisioner.initialStateFor', () => {
  it('delegates to initialProvisioningState using the resolved bundle version', () => {
    const provisioner = new Provisioner({
      bundledCli: BUNDLED,
      stampProvisioned: () => undefined,
      notify: () => undefined,
      readBundleVersion: () => '1.0.0',
    })
    expect(provisioner.initialStateFor({ available: true, provisionedVersion: '1.0.0' })).toBe('ready')
    expect(provisioner.initialStateFor({ available: true, provisionedVersion: '0.9.0' })).toBe('idle')
    expect(provisioner.initialStateFor({ available: true })).toBe('idle')
  })

  it('starts idle when there is no bundled CLI (bundleVersion resolves null)', () => {
    const provisioner = new Provisioner({
      bundledCli: null,
      stampProvisioned: () => undefined,
      notify: () => undefined,
    })
    expect(provisioner.initialStateFor({ available: true, provisionedVersion: '1.0.0' })).toBe('idle')
  })
})

// #1463 — the toast body was `lastLine(stderrTail)`, and for a bundled-CLI
// process that dies on an uncaught error the last line is ALWAYS Node's version
// banner. The cause sat two lines above it in the same buffer.
describe('lastLine picks the reason, not the crash banner (#1463)', () => {
  const CRASH = [
    'file:///opt/flow/cli.js:12',
    '    throw err',
    '    ^',
    '',
    "Error: EACCES: permission denied, mkdir '/tmp/ro/.claude/commands'",
    '    at mkdirSync (node:fs:1349:26)',
    '    at provision (file:///opt/flow/cli.js:12:5)',
    '',
    'Node.js v24.18.0',
  ].join('\n')

  it('names the failure instead of the Node version', () => {
    const reason = lastLine(CRASH)
    expect(reason).toContain('EACCES')
    expect(reason).toContain('permission denied')
    expect(reason).not.toMatch(/^Node\.js v/)
  })

  it('does not fall back to a stack frame or the caret line', () => {
    expect(lastLine(CRASH)).not.toMatch(/^\s*at\s/)
    expect(lastLine(CRASH)).not.toBe('^')
  })

  it.each([
    ['ENOSPC', 'Error: ENOSPC: no space left on device, write'],
    ['EROFS', "Error: EROFS: read-only file system, mkdir '/mnt/ro'"],
    ['ENOENT', "Error: ENOENT: no such file or directory, open '/x/y'"],
  ])('surfaces %s from a crash dump', (_code, errorLine) => {
    const dump = ['    throw err', '    ^', '', errorLine, '    at x (node:fs:1)', '', 'Node.js v24.18.0'].join('\n')
    expect(lastLine(dump)).toBe(errorLine)
  })

  it("keeps this CLI's own refusal line, which is already a good message", () => {
    const refusal = ['some noise', 'init refused: target is not a directory', 'Node.js v24.18.0'].join('\n')
    expect(lastLine(refusal)).toBe('init refused: target is not a directory')
  })

  it('passes an ordinary one-line message through unchanged', () => {
    expect(lastLine('something went sideways')).toBe('something went sideways')
  })

  it('still returns SOMETHING when every line looks like framing', () => {
    // Never swallow the only thing we have — an unrecognised message beats none.
    expect(lastLine('Node.js v24.18.0')).toBe('Node.js v24.18.0')
  })

  it('is null for empty output', () => {
    expect(lastLine('')).toBeNull()
    expect(lastLine('   \n  \n')).toBeNull()
  })
})
