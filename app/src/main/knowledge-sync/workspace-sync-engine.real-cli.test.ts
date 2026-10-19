/**
 * ONE REAL RUN: the Workspace sync engine → the REAL built CLI
 * (`<repo>/dist/cli/index.js`) → real git → a local bare repository.
 *
 * The fake-runner suite proves the questions the engine asks; this proves the
 * CLI it talks to answers them in the shape it reads, and that a turn's
 * knowledge actually lands in the shared repository.
 *
 * Isolation (as in src/cli/commands/workspace-sync.test.ts): the Flow folder is
 * a temp PLAN_FLOW_HOME, git reads a private config whose `insteadOf` maps
 * https://git.example.test/ onto a local bare repo, and only the `file`
 * transport is allowed (FLOW_E2E=1 + FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS=file).
 * The env is passed EXPLICITLY to every child; nothing leaves the machine.
 *
 * Requires `npm run build` at the repo root; fails loud when the bundle is
 * missing, because the built artifact IS the subject.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { WorkspaceSyncStatus } from '../../shared/workspaces-contract'
import type { EngineTimers } from './sync-timing'
import { createWorkspaceSyncEngine, type WorkspaceSyncCliRunner } from './workspace-sync-engine'

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli', 'index.js')
const TEST_TIMEOUT_MS = 180_000
const REMOTE = 'https://git.example.test/team/ws.git'
const DECISION = 'projects/backend/brain/decisions/queue.md'

const posix = process.platform !== 'win32'

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, env, encoding: 'utf8' }, (error, stdout, stderr) =>
      error ? reject(new Error(`${args.join(' ')}: ${stderr}`)) : resolvePromise(stdout),
    )
  })
}

class ManualTimers implements EngineTimers {
  readonly tasks = new Map<number, () => void>()
  private seq = 0
  setTimeout(callback: () => void): unknown {
    this.seq += 1
    this.tasks.set(this.seq, callback)
    return this.seq
  }
  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number)
  }
  fireAll(): void {
    for (const [id, fn] of [...this.tasks.entries()]) {
      this.tasks.delete(id)
      fn()
    }
  }
}

;(posix ? describe : describe.skip)('the Workspace sync engine over the REAL built CLI', () => {
  let base: string
  let env: NodeJS.ProcessEnv
  let flowFolder: string
  let bare: string

  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(`workspace-sync-engine.real-cli requires the built CLI at ${CLI_PATH} — run \`npm run build\` at the repo root first`)
    }
  })

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'flow-workspace-sync-real-cli-')))
    flowFolder = join(base, 'flow-folder')
    await mkdir(join(base, 'home'))
    await mkdir(join(base, 'remotes', 'team'), { recursive: true })
    await writeFile(
      join(base, 'gitconfig'),
      `[user]\n\tname = Flow Test\n\temail = flow-test@example.invalid\n[init]\n\tdefaultBranch = main\n[url "file://${base}/remotes/"]\n\tinsteadOf = https://git.example.test/\n`,
    )
    env = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: join(base, 'home'),
      TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
      GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      FLOW_E2E: '1',
      FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS: 'file',
      PLAN_FLOW_HOME: flowFolder,
      PLAN_FLOW_VAULT_DIR: join(flowFolder, 'brain'),
      PLANFLOW_NO_BACKGROUND_WORK: '1',
      COPILOT_HOME: join(base, 'copilot'),
      // Exactly how main runs the bundle — and what keeps the Electron binary
      // (process.execPath under scripts/run-jest.mjs) from starting the app.
      ELECTRON_RUN_AS_NODE: '1',
    }
    bare = join(base, 'remotes', 'team', 'ws.git')
    await git(['init', '-q', '--bare', 'ws.git'], join(base, 'remotes', 'team'), env)
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it(
    'a turn → one `workspace sync` → the knowledge is in the bare repository; a decision collision pauses',
    async () => {
      const argv: string[][] = []
      const runCli: WorkspaceSyncCliRunner = (cwd, args, options) =>
        new Promise((resolvePromise) => {
          argv.push([...args])
          const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
          let stdout = ''
          let stderr = ''
          const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
          child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
          child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
          child.on('error', (error) => {
            clearTimeout(timer)
            resolvePromise({ ok: false, stdout, stderr, error: error.message })
          })
          child.on('close', (code) => {
            clearTimeout(timer)
            resolvePromise(code === 0 ? { ok: true, stdout } : { ok: false, stdout, stderr, error: `exit ${code}` })
          })
        })

      // The Workspace, created by the same door (no remote contact on create).
      const created = await runCli(base, ['workspace', 'create', '--name', 'Team', '--remote', REMOTE, '--json'], { timeoutMs: 60_000 })
      expect(created).toMatchObject({ ok: true })
      const workspaceDir = join(flowFolder, 'workspaces', 'team')

      const timers = new ManualTimers()
      const statuses: WorkspaceSyncStatus[] = []
      const rows = new Map<string, number>()
      const logs: unknown[] = []
      const engine = createWorkspaceSyncEngine({
        nameOf: async () => null,
        runCli,
        cwd: base,
        lastSynced: { get: (slug) => rows.get(slug) ?? null, set: (slug, at) => void rows.set(slug, at) },
        writeTempText: async () => {
          throw new Error('no merged text in this run')
        },
        now: () => Date.now(),
        timers,
        onStatus: (_slug, _name, status) => statuses.push(status),
        // Kept so a failure says what the CLI answered.
        log: (message, detail) => logs.push({ message, detail }),
      })

      // An agent's turn wrote knowledge through the project's `flow/` link.
      await mkdir(dirname(join(workspaceDir, DECISION)), { recursive: true })
      await writeFile(join(workspaceDir, DECISION), '# Queue\n\nSQS.\n')
      engine.commitAfterTurn('team', 'turn in backend')
      engine.commitAfterTurn('team', 'turn in backend')
      timers.fireAll()
      // Wait for the queued run to finish.
      await engine.syncNow('team')

      const syncs = argv.filter((args) => args[0] === 'workspace' && args[1] === 'sync')
      expect(syncs[0]).toEqual(['workspace', 'sync', '--workspace', 'team', '--message=Flow: turn in backend', '--json'])
      expect(statuses.find((status) => status.state === 'synced')).toBeDefined()
      expect({ state: engine.status('team').state, logs }).toMatchObject({ state: 'synced' })
      expect(rows.get('team')).toEqual(expect.any(Number))
      // In the bare repository, with the turn's label as its commit message.
      expect(await git(['--git-dir', bare, 'show', `main:${DECISION}`], base, env)).toBe('# Queue\n\nSQS.\n')
      expect(await git(['--git-dir', bare, 'log', '--format=%s', 'main'], base, env)).toContain('Flow: turn in backend')

      // A second computer changes the same decision and publishes first.
      const other = join(base, 'other')
      await git(['clone', '-q', REMOTE, other], base, env)
      await writeFile(join(other, DECISION), '# Queue\n\nKafka.\n')
      await git(['commit', '-qam', 'kafka'], other, env)
      await git(['push', '-q', 'origin', 'main'], other, env)

      // This computer changes it too: the CLI asks, the engine pauses, nothing is pushed.
      await writeFile(join(workspaceDir, DECISION), '# Queue\n\nSQS, FIFO.\n')
      const before = await git(['--git-dir', bare, 'rev-parse', 'main'], base, env)
      const paused = await engine.syncNow('team')
      expect({ state: paused.state, logs }).toMatchObject({ state: 'paused' })
      expect(paused.asks.map((ask) => ask.path)).toContain(DECISION)
      expect(paused.detail).toBe('Two people changed the same decision in Team. Flow needs you to choose which one to keep.')
      expect(await git(['--git-dir', bare, 'rev-parse', 'main'], base, env)).toBe(before)

      // The person keeps the Workspace's version: the pause clears and the merge is published.
      const decided = await engine.resolve({ slug: 'team', path: DECISION, take: 'theirs' })
      expect(decided).toMatchObject({ ok: true, status: { state: 'synced', asks: [], reviews: [] } })
      expect(await git(['--git-dir', bare, 'rev-parse', 'main'], base, env)).not.toBe(before)
      expect(await git(['--git-dir', bare, 'show', `main:${DECISION}`], base, env)).toBe('# Queue\n\nKafka.\n')

      // Closing: the last turn is COMMITTED, and nothing is fetched, merged or published.
      await mkdir(join(workspaceDir, 'projects', 'backend', 'plans'), { recursive: true })
      await writeFile(join(workspaceDir, 'projects', 'backend', 'plans', 'plan_quit_v1.md'), '# before closing\n')
      const published = await git(['--git-dir', bare, 'rev-parse', 'main'], base, env)
      engine.commitAfterTurn('team', 'turn before closing')
      await engine.quit()
      expect(argv[argv.length - 1]).toEqual(['workspace', 'sync', '--workspace', 'team', '--message=Flow: turn before closing', '--commit-only', '--json'])
      expect((await git(['log', '-1', '--format=%s'], workspaceDir, env)).trim()).toBe('Flow: turn before closing')
      expect(await git(['status', '--porcelain'], workspaceDir, env)).toBe('')
      expect(await git(['--git-dir', bare, 'rev-parse', 'main'], base, env)).toBe(published)
    },
    TEST_TIMEOUT_MS,
  )
})
