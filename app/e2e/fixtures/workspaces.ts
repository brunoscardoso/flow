/**
 * Workspaces end-to-end sandbox — seeded code repos, a Flow folder, and a
 * Workspace "remote" that is a LOCAL bare repository.
 *
 * NO NETWORK, by three locks in the app's environment (`appEnv()`), the same
 * ones knowledge-sync.spec.ts uses:
 *
 *  · GIT_CONFIG_GLOBAL points at a config whose `url.<bare dir>.insteadOf`
 *    rewrites `https://git.example.test/team/` to a local folder of bare repos,
 *    so the Workspace keeps an ordinary https address (the CLI refuses a
 *    `file://` remote) and sync really reaches the bare repository;
 *  · GIT_ALLOW_PROTOCOL=file (every git the app spawns) and
 *    FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS=file (the CLI's own Workspace git, which
 *    sets GIT_ALLOW_PROTOCOL itself and honours this only under FLOW_E2E=1)
 *    make git refuse https outright — a rewrite that missed FAILS instead of
 *    reaching the internet;
 *  · HOME is the sandbox's own, so nothing the app or the CLI does lands in the
 *    developer's home folder or vault — and the host CLIs it probes (`az`,
 *    `gh`) find no sign-in to use, and are told not to send telemetry.
 *
 * Every seeded code repo's own `origin` is `https://example.com/team/<name>.git`
 * — an identity for the Workspace (which project a checkout is), never fetched,
 * and refused by the protocol lock if anything tried.
 *
 * The sandbox lives under the temp dir with the `flow-` prefix, so a run that
 * is killed before `cleanup()` is swept by e2e/global-setup.ts on the next one.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'

import { dismissOnboarding, expect } from './electron'

/** The repo's own CLI build — the same `workspace` verbs the app's bundle runs. */
export const REPO_CLI = resolve(__dirname, '../../../dist/cli/index.js')

/** The Workspace address every spec records; rewritten to the local bare repo. */
export const WORKSPACE_HOST = 'https://git.example.test/team/'

/** Names the IDE scaffolds into every added root, kept out of `git status` (see ux/fixtures/seed.ts). */
const IDE_SCAFFOLD_EXCLUDES = '.claude/\nflow\n.gitignore\nloops/\n'

export interface WorkspaceSandbox {
  root: string
  /** The first "machine": its folder (checkouts go here), Flow folder and HOME. */
  machine: Machine
  /** The first machine's Flow folder (PLAN_FLOW_HOME). */
  flowHome: string
  /** The Workspace's address, as the app and the CLI see it. */
  remoteUrl: string
  /** The bare repository behind it. */
  bareDir: string
  /** Git's environment for the spec's own git and CLI calls (the same locks). */
  gitEnv: Record<string, string>
  /** The app's environment: the locks, the machine's HOME and Flow folder. */
  appEnv(options?: { machine?: Machine }): Record<string, string>
  /** Another "machine": its own folder, Flow folder and HOME. */
  newMachine(name: string): Machine
  /** A git repo with one commit and an `origin` naming the project, on the first machine unless told. */
  seedRepo(name: string, machine?: Machine): string
  /** Another machine's checkout of a seeded repo, with the same `origin`. */
  cloneRepo(source: string, machine: Machine): string
  /** `planflow-ai workspace <args> --json` against a Flow folder; the parsed last JSON line. */
  cli(args: string[], flowHome?: string): Record<string, unknown>
  /** `git` as the spec, with the locks. */
  git(cwd: string, ...args: string[]): string
  /** Paths in the bare repo's `main`. */
  remoteFiles(): string[]
  /** A file's content in the bare repo's `main`, or null. */
  remoteFile(path: string): string | null
  cleanup(): Promise<void>
}

export interface Machine {
  dir: string
  flowHome: string
  home: string
}

export function createWorkspaceSandbox(label: string): WorkspaceSandbox {
  const root = mkdtempSync(join(tmpdir(), `flow-ws-${label}-`))
  const remotes = join(root, 'remotes', 'team')
  const gitconfig = join(root, 'gitconfig')
  mkdirSync(remotes, { recursive: true })
  writeFileSync(
    gitconfig,
    [
      '[user]',
      '  name = Flow E2E',
      '  email = flow-e2e@example.invalid',
      '[init]',
      '  defaultBranch = main',
      `[url "${remotes}/"]`,
      `  insteadOf = ${WORKSPACE_HOST}`,
      '',
    ].join('\n'),
  )
  const gitEnv: Record<string, string> = {
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
    FLOW_E2E: '1',
    FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS: 'file',
    // The host CLIs the app probes (knowledge sync, integrations) run with the
    // sandbox HOME — signed in to nothing — and must not phone home either.
    AZURE_CORE_COLLECT_TELEMETRY: '0',
    GH_NO_UPDATE_NOTIFIER: '1',
    DO_NOT_TRACK: '1',
  }
  const newMachine = (name: string): Machine => {
    const dir = join(root, name)
    const machine = { dir, flowHome: join(dir, 'flow-home'), home: join(dir, 'user-home') }
    mkdirSync(machine.flowHome, { recursive: true })
    mkdirSync(machine.home, { recursive: true })
    return machine
  }
  const machine = newMachine('machine-1')
  const spawnEnv = { ...process.env, ...gitEnv, HOME: machine.home }
  const bareDir = join(remotes, 'ws.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bareDir], { env: spawnEnv })
  const flowHome = machine.flowHome

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env: spawnEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const seedRepo = (name: string, on: Machine = machine): string => {
    const dir = join(on.dir, name)
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q')
    writeFileSync(join(dir, '.git', 'info', 'exclude'), IDE_SCAFFOLD_EXCLUDES)
    writeFileSync(join(dir, 'index.ts'), `export const name = '${name}'\n`)
    writeFileSync(join(dir, 'README.md'), `# ${name}\n\nThe ${name} of the orders product.\n`)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'baseline')
    git(dir, 'remote', 'add', 'origin', `https://example.com/team/${name}.git`)
    return dir
  }

  const cloneRepo = (source: string, on: Machine): string => {
    const name = source.split('/').pop() as string
    const dir = join(on.dir, name)
    git(on.dir, 'clone', '-q', '--no-local', source, dir)
    writeFileSync(join(dir, '.git', 'info', 'exclude'), IDE_SCAFFOLD_EXCLUDES)
    git(dir, 'remote', 'set-url', 'origin', `https://example.com/team/${name}.git`)
    return dir
  }

  const cli = (args: string[], home = flowHome): Record<string, unknown> => {
    const out = execFileSync(process.execPath, [REPO_CLI, 'workspace', ...args, '--json'], {
      cwd: root,
      env: { ...spawnEnv, PLAN_FLOW_HOME: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const line = out
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith('{'))
      .pop()
    if (line === undefined) throw new Error(`workspace ${args[0] ?? ''}: no JSON answer:\n${out}`)
    return JSON.parse(line) as Record<string, unknown>
  }

  const remoteFiles = (): string[] => {
    try {
      return git(root, '--git-dir', bareDir, 'ls-tree', '-r', '--name-only', 'main')
        .split('\n')
        .filter((line) => line !== '')
    } catch {
      return [] // no commit on main yet
    }
  }

  const remoteFile = (path: string): string | null => {
    try {
      return git(root, '--git-dir', bareDir, 'show', `main:${path}`)
    } catch {
      return null
    }
  }

  return {
    root,
    machine,
    flowHome,
    remoteUrl: `${WORKSPACE_HOST}ws.git`,
    bareDir,
    gitEnv,
    // Workspaces are always on (the hard migration): there is no switch to force.
    appEnv: ({ machine: on = machine } = {}) => ({
      ...gitEnv,
      HOME: on.home,
      PLAN_FLOW_HOME: on.flowHome,
    }),
    newMachine,
    seedRepo,
    cloneRepo,
    cli,
    git,
    remoteFiles,
    remoteFile,
    // A child the app started (a host-tool probe writing into its HOME) can
    // outlive the app by a moment and recreate a folder just removed — so look
    // again, a few times, before giving up.
    cleanup: async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        } catch (error) {
          if (attempt === 3) console.warn(`[workspaces] could not remove ${root}`, error)
        }
        await new Promise((settle) => setTimeout(settle, 1_000))
        if (!existsSync(root)) return
      }
    },
  }
}

// ── The app ────────────────────────────────────────────────────────────────

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
/** How long a graceful quit may take before the process is reaped (as the fixture does). */
const CLOSE_BUDGET_MS = 15_000

export interface LaunchedFlow {
  app: ElectronApplication
  window: Page
  userDataDir: string
  /** Quit (bounded, then reaped) and remove the profile. */
  close(): Promise<void>
}

/**
 * Launch another Flow — a second "machine" — with its own throwaway profile.
 * The same production-renderer flags as the `app` fixture; `env` is merged
 * over the inherited environment (so FLOW_E2E_BACKGROUND carries through).
 */
export async function launchFlow(env: Record<string, string>, options: { dismissWizard?: boolean } = {}): Promise<LaunchedFlow> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-ws-profile-'))
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: 'production',
      FLOW_E2E: '1',
      DISABLE_AUTO_UPDATE: 'true',
      ...env,
    },
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  if (options.dismissWizard !== false) await dismissOnboarding(window)
  return {
    app,
    window,
    userDataDir,
    close: async () => {
      let pid: number | undefined
      try {
        pid = app.process().pid
      } catch {
        pid = undefined
      }
      await Promise.race([app.close().catch(() => undefined), new Promise((settle) => setTimeout(settle, CLOSE_BUDGET_MS))])
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already exited — the normal path.
        }
      }
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    },
  }
}

/** Add projects through the real "Add project" path (minus its native picker) and make the first active. */
export async function addProjects(window: Page, roots: readonly string[]): Promise<void> {
  await window.evaluate(async (paths) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge, untyped in the spec
    const api = (window as unknown as { flow: any }).flow
    for (const path of paths) await api.project.add({ path })
    await api.project.setActive({ rootPath: paths[0] })
  }, roots)
}

/**
 * On screen, not merely "visible": a box inside the viewport. Polled — a list
 * that redraws between the visibility check and the measurement hands back a
 * detached node once, which is a redraw, not a box outside the window.
 */
export async function expectOnScreen(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeVisible()
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox({ timeout: 2_000 }).catch(() => null)
        if (box === null) return 'no box'
        const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
        const inside =
          box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1
        return inside ? 'on screen' : `outside the window: ${JSON.stringify(box)}`
      },
      { timeout: 10_000 },
    )
    .toBe('on screen')
}

/**
 * On screen AND on top: the point at the element's centre hits the element
 * itself, not a card painted over it. A box inside the viewport is not enough
 * for a control a person has to press.
 */
export async function expectHittable(page: Page, locator: Locator): Promise<void> {
  await expectOnScreen(page, locator)
  const hit = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (top === null) return 'nothing at its centre'
    if (element === top || element.contains(top)) return 'ok'
    // Inside a custom element's shadow root the hit is retargeted to its host.
    const root = element.getRootNode()
    if (root instanceof ShadowRoot && (root.host === top || top.contains(root.host))) return 'ok'
    return `covered by ${top.tagName.toLowerCase()}.${String(top.className)}`
  })
  expect(hit).toBe('ok')
}

/** The per-project Flow settings open once on a project's first activation — not these specs' subject. */
export async function closeProjectOnboarding(page: Page, appearWithinMs = 0): Promise<void> {
  const overlay = page.locator('.fl-settings-overlay:not([hidden]):has(.fl-settings-close[aria-label="Close flow settings"])')
  if (appearWithinMs > 0) await overlay.first().waitFor({ timeout: appearWithinMs }).catch(() => undefined)
  for (let attempt = 0; attempt < 3 && (await overlay.count()) > 0; attempt += 1) {
    await overlay.locator('.fl-settings-close').first().click()
    await page.waitForTimeout(200)
  }
  await expect(overlay).toHaveCount(0)
}

/** Open Settings → Workspaces and answer the section. */
export async function openWorkspaceSettings(page: Page): Promise<Locator> {
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('flow:open-settings', { detail: { group: 'workspaces' } })),
  )
  const section = page.locator('.fl-settings-page .fl-wss')
  await expect(section).toBeVisible({ timeout: 15_000 })
  return section
}

// ── Stand-ins in main (e2e-seams.ts) ───────────────────────────────────────

/** One session start, as the stand-in runtime saw it. */
export interface RecordedStart {
  threadId: string
  cwd: string
  additionalRoots: string[]
  writableRoots: string[]
  prompt: string
}

export interface StandInOptions {
  /** The context gate's answer to a first message (the JSON text the fast model would reply). */
  gateAnswer: string
  /** Written by the runtime's FIRST turn into `<session cwd>/flow/<path>` — an agent writing knowledge. */
  knowledgeWrite?: { path: string; text: string }
}

/**
 * Stand in for the context gate's model and for the agent runtime, in main.
 * Every session start is recorded (`recordedStarts`); each turn answers one
 * line of text and ends, so the thread rests and the next send works as it
 * would after a real turn. Nothing is spawned and nothing reaches a model.
 */
export async function installStandIns(app: ElectronApplication, options: StandInOptions): Promise<void> {
  await app.evaluate((_electron, opts) => {
    type Callbacks = {
      onEvent(event: Record<string, unknown>): void
      onSessionId(id: string): void
      onDone?(): void
    }
    const g = globalThis as unknown as {
      __flowE2ESeams?: unknown
      __flowE2EStarts?: unknown[]
      __flowE2EGateCalls?: string[]
    }
    const fs = (process as unknown as { getBuiltinModule(id: string): typeof import('node:fs') }).getBuiltinModule('node:fs')
    const path = (process as unknown as { getBuiltinModule(id: string): typeof import('node:path') }).getBuiltinModule('node:path')
    g.__flowE2EStarts = []
    g.__flowE2EGateCalls = []
    let wrote = false
    let turn = 0
    const answerTurn = (threadId: string, callbacks: Callbacks): void => {
      turn += 1
      const messageId = `stand-in-${turn}`
      setTimeout(() => {
        callbacks.onEvent({ kind: 'message-start', threadId, messageId })
        callbacks.onEvent({ kind: 'message-delta', threadId, messageId, text: `Stand-in answer ${turn}.` })
        callbacks.onEvent({ kind: 'text-stop', threadId, messageId })
        callbacks.onDone?.()
      }, 150)
    }
    g.__flowE2ESeams = {
      askFastModel: async (input: { prompt: string }) => {
        g.__flowE2EGateCalls?.push(input.prompt)
        if (input.prompt.includes('"primary"')) return opts.gateAnswer
        if (input.prompt.includes('"needs"')) return '{"needs": null, "reason": ""}'
        return null // a description: nothing — the projects keep their names
      },
      runtime: () => ({
        id: 'codex',
        capabilities: {
          driveHeadless: true,
          parseableStream: true,
          resumeHandle: true,
          containment: 'native',
          toolApproval: 'none',
          toolEvents: false,
          subAgents: 'instance-spawn',
          modelSelection: false,
        },
        start(start: { threadId: string; cwd: string; additionalRoots: string[]; writableRoots?: string[]; prompt: string }, callbacks: Callbacks) {
          g.__flowE2EStarts?.push({
            threadId: start.threadId,
            cwd: start.cwd,
            additionalRoots: [...start.additionalRoots],
            writableRoots: [...(start.writableRoots ?? [])],
            prompt: start.prompt,
          })
          if (opts.knowledgeWrite !== undefined && !wrote) {
            wrote = true
            const target = path.join(start.cwd, 'flow', opts.knowledgeWrite.path)
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.writeFileSync(target, opts.knowledgeWrite.text)
          }
          callbacks.onSessionId(`stand-in-session-${start.threadId}`)
          answerTurn(start.threadId, callbacks)
          return {
            sessionId: `stand-in-session-${start.threadId}`,
            send: () => answerTurn(start.threadId, callbacks),
            setModel: () => undefined,
            interrupt: () => undefined,
            dispose: () => undefined,
          }
        },
      }),
    }
  }, options)
}

/** The session starts the stand-in runtime recorded, oldest first. */
export async function recordedStarts(app: ElectronApplication): Promise<RecordedStart[]> {
  return app.evaluate(() => ((globalThis as unknown as { __flowE2EStarts?: RecordedStart[] }).__flowE2EStarts ?? []) as RecordedStart[])
}

/** The prompts the stand-in model was asked. */
export async function gateCalls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __flowE2EGateCalls?: string[] }).__flowE2EGateCalls ?? [])
}

/**
 * Stand in for every project's basic discovery (e2e-seams.ts `basicDiscovery`).
 * Setting it is also what turns the automatic layer ON in a hidden run — the
 * app sweeps Workspace projects and holds first messages only once a spec has
 * stood in for the sweep. Each sweep WAITS until the spec ends it
 * (`finishBasicDiscovery`), so a spec controls exactly when a held message may
 * go out. Install it after `installStandIns` (it adds to the same seams).
 */
export async function installBasicDiscoveryStandIn(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    type Outcome = { kind: 'done'; learned: number; failed: number } | { kind: 'failed'; reason: string }
    const g = globalThis as unknown as {
      __flowE2ESeams?: Record<string, unknown>
      __flowE2ESweepRuns?: string[]
      __flowE2ESweeps?: Map<string, (outcome: Outcome) => void>
    }
    g.__flowE2ESweepRuns = []
    g.__flowE2ESweeps = new Map()
    g.__flowE2ESeams = {
      ...(g.__flowE2ESeams ?? {}),
      basicDiscovery: (root: string) =>
        new Promise<Outcome>((resolve) => {
          g.__flowE2ESweepRuns?.push(root)
          g.__flowE2ESweeps?.set(root, resolve)
        }),
    }
  })
}

/** The roots whose basic discovery the stand-in was asked to run, oldest first. */
export async function basicDiscoveryRuns(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __flowE2ESweepRuns?: string[] }).__flowE2ESweepRuns ?? [])
}

/** End the stand-in sweep running for `root` (the root as main passed it). Returns whether one was running. */
export async function finishBasicDiscovery(
  app: ElectronApplication,
  root: string,
  outcome: { kind: 'done'; learned: number; failed: number } | { kind: 'failed'; reason: string },
): Promise<boolean> {
  return app.evaluate(
    (_electron, input) => {
      const sweeps = (globalThis as unknown as { __flowE2ESweeps?: Map<string, (outcome: unknown) => void> }).__flowE2ESweeps
      const resolve = sweeps?.get(input.root)
      if (resolve === undefined) return false
      sweeps?.delete(input.root)
      resolve(input.outcome)
      return true
    },
    { root, outcome },
  )
}

// ── Lazily, in the worker ──────────────────────────────────────────────────

export interface LazySandbox<T> {
  /** The sandbox and what `seed` made — created on first use, in the worker that runs the tests. */
  get(): { sandbox: WorkspaceSandbox } & T
  /** Remove it, if it was ever made. */
  cleanup(): Promise<void>
}

/**
 * A sandbox made on first use, never at module load: Playwright also loads a
 * spec file in its runner process just to list the tests, and anything a
 * describe body creates there is never cleaned up (no hooks run there) — every
 * run leaked one seeded sandbox per describe that way.
 */
export function lazySandbox<T>(label: string, seed: (sandbox: WorkspaceSandbox) => T): LazySandbox<T> {
  let made: ({ sandbox: WorkspaceSandbox } & T) | null = null
  return {
    get() {
      if (made === null) {
        const sandbox = createWorkspaceSandbox(label)
        made = { sandbox, ...seed(sandbox) }
      }
      return made
    },
    async cleanup() {
      const sandbox = made?.sandbox
      made = null
      await sandbox?.cleanup()
    },
  }
}
