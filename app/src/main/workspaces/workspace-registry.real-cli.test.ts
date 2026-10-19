/**
 * ONE REAL RUN: the registry over the REAL built CLI (`<repo>/dist/cli/index.js`)
 * and real git, in an isolated Flow folder (PLAN_FLOW_HOME) — the fake-runner
 * suite proves the questions the registry asks; this one proves the CLI it
 * talks to answers them in the shape it reads.
 *
 * NO NETWORK: nothing here clones or pushes (create records no remote, link is
 * local), and GIT_ALLOW_PROTOCOL=file makes any https/ssh transport fail
 * rather than leave the machine. The env is passed EXPLICITLY to every child.
 * HOME, the Flow folder and the git config are all inside one temp folder.
 *
 * Requires `npm run build` at the repo root; fails loud when the bundle is
 * missing, because the built artifact IS the subject.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createWorkspaceRegistry, type WorkspaceCliRunner, type WorkspaceSettings } from './workspace-registry'

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli', 'index.js')
const CLI_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 120_000
const ORIGIN = 'git@github.com:acme/api.git'

const posix = process.platform !== 'win32'

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, env, encoding: 'utf8' }, (error, stdout, stderr) =>
      error ? reject(new Error(`${args.join(' ')}: ${stderr}`)) : resolvePromise(stdout),
    )
  })
}

;(posix ? describe : describe.skip)('the workspace registry over the REAL built CLI', () => {
  let base: string
  let env: NodeJS.ProcessEnv

  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(`workspace-registry.real-cli requires the built CLI at ${CLI_PATH} — run \`npm run build\` at the repo root first`)
    }
  })

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'flow-workspaces-real-cli-')))
    await mkdir(join(base, 'home'))
    await writeFile(
      join(base, 'gitconfig'),
      ['[user]', '  name = Flow Test', '  email = flow-test@example.invalid', '[init]', '  defaultBranch = main', ''].join('\n'),
    )
    env = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: join(base, 'home'),
      TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
      GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_TERMINAL_PROMPT: '0',
    }
    // Two checkouts of ONE repository: the first joins the Workspace, the
    // second is the "opened repo" the auto-suggest is about.
    for (const name of ['api', 'api-second-checkout']) {
      const repo = join(base, name)
      await mkdir(repo)
      await writeFile(join(repo, 'README.md'), 'code\n')
      await git(['init', '-q', '-b', 'main'], repo, env)
      await git(['remote', 'add', 'origin', ORIGIN], repo, env)
      await git(['add', '-A'], repo, env)
      await git(['commit', '-q', '-m', 'code'], repo, env)
    }
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it(
    'creates, links, lists, derives membership and suggests linking a second checkout',
    async () => {
      const cliEnv: NodeJS.ProcessEnv = {
        ...env,
        // Exactly how main runs the bundle: the host binary as Node.
        ELECTRON_RUN_AS_NODE: '1',
        PLAN_FLOW_HOME: join(base, 'flow-folder'),
        PLANFLOW_NO_BACKGROUND_WORK: '1',
      }
      const argv: string[][] = []
      const runCli: WorkspaceCliRunner = (cwd, args) =>
        new Promise((resolvePromise) => {
          argv.push([...args])
          const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd, env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] })
          let stdout = ''
          let stderr = ''
          const timer = setTimeout(() => child.kill('SIGKILL'), CLI_TIMEOUT_MS)
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
      let current: string | null = null
      const settings: WorkspaceSettings = {
        getCurrentWorkspace: () => current,
        setCurrentWorkspace: (slug) => {
          current = slug
        },
      }
      const registry = createWorkspaceRegistry({
        runCli,
        settings,
        homeDir: join(base, 'home'),
        log: () => undefined,
      })
      const api = join(base, 'api')
      const second = join(base, 'api-second-checkout')

      const created = await registry.create('Acme Team')
      expect(created).toMatchObject({ ok: true, workspace: { name: 'Acme Team', slug: 'acme-team', remote: null } })

      // A refusal comes back typed, with the CLI's payload — no flag means no guess.
      const unknown = await registry.link({ repoPath: api, workspace: 'nope' })
      expect(unknown).toMatchObject({ ok: false, reason: 'unknown-workspace', payload: { workspaces: [{ slug: 'acme-team' }] } })

      const linked = await registry.link({ repoPath: api, workspace: 'acme-team' })
      expect(linked).toMatchObject({
        ok: true,
        link: 'created',
        projectAdded: true,
        previous: { kind: 'none' },
        project: { id: 'github.com/acme/api', slug: 'api', localPath: api },
      })
      expect(lstatSync(join(api, 'flow')).isSymbolicLink()).toBe(true)

      const listed = await registry.list()
      expect(listed).toMatchObject({
        ok: true,
        flowFolder: join(base, 'flow-folder'),
        workspaces: [{ slug: 'acme-team', projects: [{ id: 'github.com/acme/api', localPath: api }] }],
      })

      expect(await registry.membershipOf([api, second])).toEqual({
        ok: true,
        roots: [
          // Linked: the real CLI's link resolves into the folder it lists for the project.
          { root: api, workspace: 'acme-team', project: 'github.com/acme/api', linked: true },
          { root: second, workspace: null, project: null, linked: false },
        ],
      })

      expect(await registry.suggestJoin(api)).toEqual({ ok: true, suggestion: { kind: 'none' } })
      expect(await registry.suggestJoin(second)).toMatchObject({
        ok: true,
        suggestion: { kind: 'link', via: 'remote', workspace: { slug: 'acme-team' }, project: { id: 'github.com/acme/api' } },
      })

      expect(await registry.current()).toEqual({ ok: true, slug: 'acme-team' })
      // Nothing reached for the network: no join, no clone, no push was ever asked.
      expect(argv.map((args) => args[1])).not.toContain('join')
    },
    TEST_TIMEOUT_MS,
  )
})
