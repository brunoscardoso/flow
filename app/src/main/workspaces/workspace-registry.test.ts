/**
 * THE WORKSPACE REGISTRY — the app's one route to Workspaces, over the CLI.
 *
 * The CLI is faked as a TABLE KEYED BY ARGV that throws on anything absent
 * (allowed-pattern #24): every test asserts the exact question the registry
 * asked, not just the answer it got. Workspaces are always on (decision
 * 2026-10-06): there is no switch for a test to turn off.
 */

import type { WorkspaceCliRun, WorkspaceCliRunner, WorkspaceSettings } from './workspace-registry'
import { createWorkspaceRegistry } from './workspace-registry'
import type { WorkspacesChangedEvent } from '../../shared/workspaces-contract'

const HOME = '/Users/person'
const FLOW = '/Users/person/.plan-flow'
const API = '/code/api'
const WEB = '/code/web'

const project = (slug: string, localPath: string | null, extra: Record<string, unknown> = {}) => ({
  id: `github.com/acme/${slug}`,
  name: slug,
  slug,
  remotes: [`git@github.com:acme/${slug}.git`],
  description: null,
  localPath,
  flowPath: `${FLOW}/workspaces/acme/projects/${slug}`,
  ...extra,
})

const ACME = { name: 'Acme', slug: 'acme', path: `${FLOW}/workspaces/acme`, remote: null }
/** What the app reads ACME as: the CLI's `default` is a local notion, absent → not the Default one. */
const ACME_APP = { ...ACME, isDefault: false }

const LIST = {
  action: 'status',
  flowFolder: FLOW,
  workspaces: [{ ...ACME, projects: [project('api', API), project('web', WEB)], raw: { secret: 'never crosses' } }],
  unreadable: [],
}

const ok = (payload: unknown): WorkspaceCliRun => ({ ok: true, stdout: `noise\n${JSON.stringify(payload)}\n` })
const refused = (payload: Record<string, unknown>, sentence = 'a terminal sentence'): WorkspaceCliRun => ({
  ok: false,
  stdout: `${JSON.stringify(payload)}\nworkspace refused: ${String(payload['refused'])} — ${sentence}\n`,
  error: 'exited with 1',
})

interface Harness {
  calls: Array<{ cwd: string; args: string[]; timeoutMs: number | undefined }>
  events: WorkspacesChangedEvent[]
  settings: WorkspaceSettings & { current: string | null }
  clock: { now: number }
  logs: Array<{ message: string; details: Record<string, unknown> }>
}

function harness(
  table: Record<string, WorkspaceCliRun | (() => WorkspaceCliRun)>,
  options: { links?: Record<string, string> } = {},
) {
  const h: Harness = {
    calls: [],
    events: [],
    clock: { now: 1_000 },
    logs: [],
    settings: {
      current: null,
      getCurrentWorkspace() {
        return this.current
      },
      setCurrentWorkspace(slug) {
        this.current = slug
      },
    },
  }
  const runCli: WorkspaceCliRunner = async (cwd, args, runOptions) => {
    h.calls.push({ cwd, args: [...args], timeoutMs: runOptions?.timeoutMs })
    const key = `${cwd} :: ${args.join(' ')}`
    const answer = table[key]
    if (answer === undefined) throw new Error(`unexpected CLI call: ${key}`)
    return typeof answer === 'function' ? answer() : answer
  }
  const registry = createWorkspaceRegistry({
    runCli,
    settings: h.settings,
    homeDir: HOME,
    onChanged: (event) => h.events.push(event),
    log: (message, details) => h.logs.push({ message, details }),
    realpath: async (path) => options.links?.[path] ?? path,
    now: () => h.clock.now,
  })
  return { registry, h }
}

const LIST_KEY = `${HOME} :: workspace status --json`

describe('reads', () => {
  it('list rebuilds the CLI answer field by field — nothing beyond the contract crosses', async () => {
    const { registry, h } = harness({ [LIST_KEY]: ok(LIST) })
    const answer = await registry.list()
    expect(answer).toEqual({
      ok: true,
      flowFolder: FLOW,
      workspaces: [{ ...ACME_APP, projects: [project('api', API), project('web', WEB)] }],
      unreadable: [],
    })
    expect(JSON.stringify(answer)).not.toContain('never crosses')
    expect(h.calls).toEqual([{ cwd: HOME, args: ['workspace', 'status', '--json'], timeoutMs: 30_000 }])
  })

  it('caches a read for a few seconds and shares one in flight; a mutation drops it', async () => {
    const created = { action: 'create', flowFolder: FLOW, workspace: { ...ACME, slug: 'beta', name: 'Beta' }, projects: [] }
    const { registry, h } = harness({
      [LIST_KEY]: ok(LIST),
      [`${HOME} :: workspace create --name=Beta --json`]: ok(created),
    })
    await Promise.all([registry.list(), registry.list(), registry.membershipOf([API])])
    expect(h.calls).toHaveLength(1)
    h.clock.now += 4_000
    await registry.list()
    expect(h.calls).toHaveLength(1)
    h.clock.now += 2_000
    await registry.list()
    expect(h.calls).toHaveLength(2)
    await registry.create('Beta')
    await registry.list()
    expect(h.calls.map((call) => call.args[1])).toEqual(['status', 'status', 'create', 'status'])
  })

  it('never caches a refusal — the next read asks again', async () => {
    let answers = 0
    const { registry, h } = harness({
      [LIST_KEY]: () => (answers++ === 0 ? { ok: false, stdout: '', error: 'timed out' } : ok(LIST)),
    })
    expect(await registry.list()).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(await registry.list()).toMatchObject({ ok: true })
    expect(h.calls).toHaveLength(2)
  })

  it('statusFor asks about the root, in the root', async () => {
    const status = {
      action: 'status',
      flowFolder: FLOW,
      target: API,
      workspace: ACME,
      project: project('api', API),
      linked: true,
      via: 'flow-link',
      siblings: [project('web', WEB)],
      alsoIn: [],
    }
    const { registry, h } = harness({ [`${API} :: workspace status --target=${API} --json`]: ok(status) })
    const answer = await registry.statusFor(API)
    expect(answer).toMatchObject({ ok: true, membership: { workspace: ACME, linked: true, via: 'flow-link' } })
    expect(h.calls[0]).toEqual({ cwd: API, args: ['workspace', 'status', `--target=${API}`, '--json'], timeoutMs: 30_000 })
  })

  it('membership is derived from ONE listing, for any number of roots — Workspace, project and whether flow/ is linked', async () => {
    // API's flow/ resolves into its project folder; WEB's does not (yet).
    const { registry, h } = harness({ [LIST_KEY]: ok(LIST) }, { links: { [`${API}/flow`]: `${FLOW}/workspaces/acme/projects/api` } })
    expect(await registry.membershipOf([API, WEB, '/code/elsewhere'])).toEqual({
      ok: true,
      roots: [
        { root: API, workspace: 'acme', project: 'github.com/acme/api', linked: true },
        { root: WEB, workspace: 'acme', project: 'github.com/acme/web', linked: false },
        { root: '/code/elsewhere', workspace: null, project: null, linked: false },
      ],
    })
    expect(await registry.workspaceOfRoot(WEB)).toBe('acme')
    expect(h.calls).toHaveLength(1)
  })

  it('a malformed answer is unavailable, never half-used', async () => {
    const { registry, h } = harness({
      [LIST_KEY]: ok({ action: 'status', flowFolder: FLOW, workspaces: [{ ...ACME, projects: [{ id: 1 }] }], unreadable: [] }),
    })
    expect(await registry.list()).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(h.logs.at(-1)?.message).toMatch(/shape/)
  })

  it('an old CLI with no workspace verb is unavailable — no payload, no guess', async () => {
    const { registry } = harness({ [LIST_KEY]: { ok: false, stdout: '', error: "error: unknown command 'workspace'" } })
    expect(await registry.list()).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: expect.not.stringMatching(/workspace'|planflow|--/),
      payload: {},
    })
  })
})

describe('mutations', () => {
  it('create passes the name as one value and announces once', async () => {
    const created = { action: 'create', flowFolder: FLOW, workspace: ACME, projects: [] }
    const { registry, h } = harness({
      [`${HOME} :: workspace create --name=Acme --remote=git@github.com:acme/knowledge.git --json`]: ok(created),
    })
    expect(await registry.create('  Acme ', 'git@github.com:acme/knowledge.git')).toEqual({ ok: true, workspace: ACME_APP })
    expect(h.events).toEqual([{ cause: 'created' }])
  })

  it('refuses a bad name or remote before anything runs', async () => {
    const { registry, h } = harness({})
    expect(await registry.create('')).toMatchObject({ ok: false, reason: 'invalid-name' })
    expect(await registry.create('a\nb')).toMatchObject({ ok: false, reason: 'invalid-name' })
    expect(await registry.create('Acme', 'http://github.com/acme/k')).toMatchObject({ ok: false, reason: 'insecure-remote' })
    expect(await registry.join('--upload-pack=touch /tmp/x')).toMatchObject({ ok: false, reason: 'invalid-remote' })
    expect(await registry.join('https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b')).toMatchObject({
      ok: false,
      reason: 'credentials-in-url',
    })
    expect(await registry.link({ repoPath: 'relative/path', workspace: 'acme' })).toMatchObject({ reason: 'not-a-git-repo' })
    expect(await registry.link({ repoPath: API, workspace: '../etc' })).toMatchObject({ reason: 'unknown-workspace' })
    expect(await registry.link({ repoPath: API, workspace: 'acme', projectId: 'a b' })).toMatchObject({ reason: 'unknown-project' })
    expect(h.calls).toEqual([])
    expect(h.events).toEqual([])
  })

  it('a committed flow/ is a typed refusal carrying the commit — and no --confirm-commit unless a person said so', async () => {
    const commit = { message: 'chore(plan-flow): keep the old flow/', files: 12, from: 'flow', to: 'flow.pre-workspace' }
    const { registry, h } = harness({
      [`${API} :: workspace link --target=${API} --workspace=acme --json`]: refused(
        { action: 'link', refused: 'committed-flow', detail: 'this project commits its flow/ folder', commit, needs: 'confirm-commit' },
        'this project commits its flow/ folder (12 files)',
      ),
    })
    const answer = await registry.link({ repoPath: API, workspace: 'acme', confirmCommit: false })
    expect(answer).toEqual({
      ok: false,
      reason: 'committed-flow',
      detail: expect.any(String),
      payload: { commit, needs: 'confirm-commit' },
    })
    // The person's sentence is the app's own: no folder names, no commands.
    if (!answer.ok) expect(answer.detail).not.toMatch(/flow\/|flow\.pre-workspace|--|planflow/)
    expect(h.calls.flatMap((call) => call.args)).not.toContain('--confirm-commit')
    // The CLI's own sentence went to the log, not the answer.
    expect(h.logs.some((entry) => entry.details['detail'] === 'this project commits its flow/ folder')).toBe(true)
    expect(h.events).toEqual([])
  })

  it('confirmCommit: true is the only thing that passes the flag', async () => {
    const linked = {
      action: 'link',
      flowFolder: FLOW,
      workspace: ACME,
      project: project('api', API),
      link: 'created',
      previous: { kind: 'committed-folder', keptAt: `${API}/flow.pre-workspace` },
      projectAdded: true,
      codeRepo: { ignored: 'info-exclude', commit: { sha: 'abc1234', message: 'chore', files: 12 } },
    }
    const { registry, h } = harness({
      [`${API} :: workspace link --target=${API} --workspace=acme --project=github.com/acme/api --confirm-commit --json`]: ok(linked),
    })
    const answer = await registry.link({ repoPath: API, workspace: 'acme', projectId: 'github.com/acme/api', confirmCommit: true })
    expect(answer).toEqual({
      ok: true,
      workspace: ACME_APP,
      project: project('api', API),
      link: 'created',
      previous: { kind: 'committed-folder', keptAt: `${API}/flow.pre-workspace` },
      projectAdded: true,
      commit: { sha: 'abc1234', message: 'chore', files: 12 },
    })
    expect(h.calls[0]?.timeoutMs).toBe(120_000)
    expect(h.events).toEqual([{ cause: 'linked' }])
  })

  it('an unknown refusal code is reported as failed, with its payload', async () => {
    const { registry } = harness({
      [`${HOME} :: workspace join --remote=https://github.com/acme/knowledge --json`]: refused({
        action: 'join',
        refused: 'something-new',
        detail: 'x',
        extra: 1,
      }),
    })
    expect(await registry.join('https://github.com/acme/knowledge')).toMatchObject({ ok: false, reason: 'failed', payload: { extra: 1 } })
  })

  it('join reports what was linked, what has no checkout here, and what needs a person', async () => {
    const joined = {
      action: 'join',
      flowFolder: FLOW,
      workspace: ACME,
      linked: [project('api', API)],
      noLocalCheckout: [project('web', null)],
      needsReview: [{ ...project('docs', '/code/docs'), refusal: { refused: 'dirty-code', files: ['a.ts'] } }],
    }
    const { registry, h } = harness({ [`${HOME} :: workspace join --remote=https://github.com/acme/knowledge --name=Team --json`]: ok(joined) })
    const answer = await registry.join('https://github.com/acme/knowledge', 'Team')
    expect(answer).toMatchObject({
      ok: true,
      linked: [{ slug: 'api' }],
      noLocalCheckout: [{ slug: 'web', localPath: null }],
      needsReview: [{ slug: 'docs', refusal: { refused: 'dirty-code', files: ['a.ts'] } }],
    })
    expect(h.calls[0]?.timeoutMs).toBe(330_000)
    expect(h.events).toEqual([{ cause: 'joined' }])
  })

  // Live bug (Phase 11 deep e2e): a second computer joined with both projects
  // OPEN in Flow, and the dialog said "none of its projects are open on this
  // computer" — the CLI only knows checkouts its own Flow folder recorded.
  // The fix finds those open projects — but a Workspace is a file anyone in it
  // can write, and its project list could name the remote of any private repo
  // this person has open. So join only PROPOSES them; nothing is linked until
  // the person ticks them and presses "Add these projects" (an ordinary link).
  it('join proposes the projects already open in the app as candidates — it links none of them', async () => {
    const OTHER = '/code/other'
    const joined = {
      action: 'join',
      flowFolder: FLOW,
      workspace: ACME,
      linked: [],
      noLocalCheckout: [project('api', null), project('web', null)],
      needsReview: [],
    }
    const statusOf = (target: string, extra: Record<string, unknown>) => ({
      action: 'status',
      flowFolder: FLOW,
      target,
      workspace: null,
      project: null,
      linked: false,
      via: null,
      siblings: [],
      alsoIn: [],
      ...extra,
    })
    const { registry, h } = harness({
      [`${HOME} :: workspace join --remote=https://github.com/acme/knowledge --json`]: ok(joined),
      [`${WEB} :: workspace status --target=${WEB} --json`]: ok(
        statusOf(WEB, { workspace: ACME, project: project('web', WEB), via: 'remote' }),
      ),
      [`${API} :: workspace status --target=${API} --json`]: ok(
        statusOf(API, { workspace: ACME, project: project('api', API), via: 'remote' }),
      ),
      [`${OTHER} :: workspace status --target=${OTHER} --json`]: ok(statusOf(OTHER, {})),
    })
    const answer = await registry.join('https://github.com/acme/knowledge', undefined, { openRoots: [WEB, OTHER, API] })
    expect(answer).toMatchObject({
      ok: true,
      linked: [],
      noLocalCheckout: [{ slug: 'api' }, { slug: 'web' }],
      openCandidates: [
        { root: WEB, project: { slug: 'web' } },
        { root: API, project: { slug: 'api' } },
      ],
    })
    // Positive first: the open projects WERE asked about…
    expect(h.calls.filter((call) => call.args[1] === 'status')).toHaveLength(3)
    // …and none was linked.
    expect(h.calls.filter((call) => call.args[1] === 'link')).toEqual([])
    expect(h.events).toEqual([{ cause: 'joined' }])
  })

  it('the open projects are read AFTER the join leaves the mutation lock', async () => {
    const joined = { action: 'join', flowFolder: FLOW, workspace: ACME, linked: [], noLocalCheckout: [project('web', null)], needsReview: [] }
    const created = { action: 'create', flowFolder: FLOW, workspace: { ...ACME, slug: 'beta', name: 'Beta' }, projects: [] }
    let releaseStatus: (() => void) | null = null
    const statusAsked = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })
    let statusStarted = false
    const { registry } = harness({
      [`${HOME} :: workspace join --remote=https://github.com/acme/knowledge --json`]: ok(joined),
      // The read of the open project HANGS until released.
      [`${WEB} :: workspace status --target=${WEB} --json`]: (() => {
        statusStarted = true
        return statusAsked.then(() =>
          ok({ action: 'status', flowFolder: FLOW, target: WEB, workspace: null, project: null, linked: false, via: null, siblings: [], alsoIn: [] }),
        )
      }) as unknown as () => WorkspaceCliRun,
      [`${HOME} :: workspace create --name=Beta --json`]: ok(created),
    })
    const joining = registry.join('https://github.com/acme/knowledge', undefined, { openRoots: [WEB] })
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
    // Positive first: the join IS reading the open project right now…
    expect(statusStarted).toBe(true)
    // …and another mutation still goes through meanwhile.
    expect(await registry.create('Beta')).toMatchObject({ ok: true })
    ;(releaseStatus as unknown as () => void)()
    expect(await joining).toMatchObject({ ok: true })
  })

  it('join asks nothing more when the CLI linked everything itself', async () => {
    const joined = { action: 'join', flowFolder: FLOW, workspace: ACME, linked: [project('api', API)], noLocalCheckout: [], needsReview: [] }
    const { registry, h } = harness({ [`${HOME} :: workspace join --remote=https://github.com/acme/knowledge --json`]: ok(joined) })
    const answer = await registry.join('https://github.com/acme/knowledge', undefined, { openRoots: [API, WEB] })
    expect(answer).toMatchObject({ ok: true, linked: [{ slug: 'api' }] })
    expect(h.calls).toHaveLength(1)
  })

  it('mutations run one at a time', async () => {
    const order: string[] = []
    let release: (() => void) | null = null
    const created = { action: 'create', flowFolder: FLOW, workspace: ACME, projects: [] }
    // A runner whose first call waits until released.
    const slow = createWorkspaceRegistry({
      runCli: async (_cwd, args) => {
        order.push(`start ${args[2] ?? ''}`)
        if (order.length === 1) await new Promise<void>((resolve) => (release = resolve))
        order.push(`end ${args[2] ?? ''}`)
        return ok(created)
      },
      settings: { getCurrentWorkspace: () => null, setCurrentWorkspace: () => undefined },
      homeDir: HOME,
      realpath: async (path) => path,
    })
    const first = slow.create('One')
    const second = slow.create('Two')
    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(['start --name=One'])
    ;(release as unknown as () => void)()
    await Promise.all([first, second])
    expect(order).toEqual(['start --name=One', 'end --name=One', 'start --name=Two', 'end --name=Two'])
  })
})

describe('the current Workspace', () => {
  it('is the stored one while it exists, the first one otherwise', async () => {
    const { registry, h } = harness({ [LIST_KEY]: ok(LIST) })
    expect(await registry.current()).toEqual({ ok: true, slug: 'acme' })
    h.settings.current = 'gone'
    expect(await registry.current()).toEqual({ ok: true, slug: 'acme' })
  })

  it('falls back to the Default Workspace when the stored one is gone (a delete)', async () => {
    const DEFAULT = { name: 'Default', slug: 'default', path: `${FLOW}/workspaces/default`, remote: null, default: true, projects: [] }
    const { registry, h } = harness({ [LIST_KEY]: ok({ ...LIST, workspaces: [...LIST.workspaces, DEFAULT] }) })
    h.settings.current = 'deleted'
    expect(await registry.current()).toEqual({ ok: true, slug: 'default' })
  })

  it('setCurrent refuses a Workspace that is not here, offering the ones that are', async () => {
    const { registry, h } = harness({ [LIST_KEY]: ok(LIST) })
    expect(await registry.setCurrent('nope')).toMatchObject({
      ok: false,
      reason: 'unknown-workspace',
      payload: { workspaces: [{ slug: 'acme', name: 'Acme' }] },
    })
    expect(h.settings.current).toBeNull()
    expect(await registry.setCurrent('acme')).toEqual({ ok: true, slug: 'acme' })
    expect(h.settings.current).toBe('acme')
    expect(await registry.setCurrent(null)).toEqual({ ok: true, slug: null })
    expect(h.events).toEqual([{ cause: 'current' }, { cause: 'current' }])
  })
})

describe('suggestJoin — FR-3 auto-suggest', () => {
  const statusOf = (overrides: Record<string, unknown>) =>
    ok({
      action: 'status',
      flowFolder: FLOW,
      target: API,
      workspace: ACME,
      project: project('api', API),
      linked: false,
      via: 'remote',
      siblings: [],
      alsoIn: [],
      ...overrides,
    })
  const key = `${API} :: workspace status --target=${API} --json`

  it('suggests linking a repo a local Workspace lists by its remote, not yet linked', async () => {
    const { registry } = harness({ [key]: statusOf({}) })
    expect(await registry.suggestJoin(API)).toEqual({
      ok: true,
      suggestion: { kind: 'link', workspace: ACME_APP, project: project('api', API), via: 'remote' },
    })
  })

  it.each([
    ['already linked', { linked: true, via: 'flow-link' }],
    ['in no Workspace', { workspace: null, project: null, via: null }],
  ])('suggests nothing when %s', async (_label, overrides) => {
    const { registry } = harness({ [key]: statusOf(overrides) })
    expect(await registry.suggestJoin(API)).toEqual({ ok: true, suggestion: { kind: 'none' } })
  })
})

describe('describe — a project description through the CLI', () => {
  const KEY = `${HOME} :: workspace describe --workspace=acme --project=web --text=The storefront. --if-empty --json`

  it('asks the one verb, reads the project back, and announces only a real change', async () => {
    const { registry, h } = harness({
      [KEY]: ok({ action: 'describe', workspace: ACME, project: project('web', WEB, { description: 'The storefront.' }), changed: true }),
    })
    const answer = await registry.describe({ workspace: 'acme', project: 'web', text: '  The storefront. ', ifEmpty: true })
    expect(answer).toMatchObject({ ok: true, changed: true, project: { slug: 'web', description: 'The storefront.' } })
    expect(h.calls.map((call) => call.args)).toEqual([
      ['workspace', 'describe', '--workspace=acme', '--project=web', '--text=The storefront.', '--if-empty', '--json'],
    ])
    expect(h.events).toEqual([{ cause: 'described' }])
  })

  it('an unchanged description announces nothing', async () => {
    const { registry, h } = harness({
      [KEY]: ok({ action: 'describe', workspace: ACME, project: project('web', WEB, { description: 'Kept.' }), changed: false }),
    })
    expect(await registry.describe({ workspace: 'acme', project: 'web', text: 'The storefront.', ifEmpty: true })).toMatchObject({
      ok: true,
      changed: false,
    })
    expect(h.events).toEqual([])
  })

  it('refuses empty text and a bad slug without asking anything', async () => {
    const { registry, h } = harness({})
    expect(await registry.describe({ workspace: 'acme', project: 'web', text: '   ' })).toMatchObject({ ok: false, reason: 'invalid-description' })
    expect(await registry.describe({ workspace: 'Not A Slug', project: 'web', text: 'x' })).toMatchObject({ ok: false, reason: 'unknown-workspace' })
    expect(h.calls).toEqual([])
  })
})

describe('always on', () => {
  it('reads without any switch: the first question is the CLI\'s', async () => {
    const { registry, h } = harness({ [LIST_KEY]: ok(LIST) })
    expect((await registry.list()).ok).toBe(true)
    expect(h.calls).toHaveLength(1)
    expect('enabledState' in registry).toBe(false)
  })

  it('reads the CLI\'s Default marker', async () => {
    const DEFAULT = { name: 'Default', slug: 'default', path: `${FLOW}/workspaces/default`, remote: null, default: true, projects: [] }
    const { registry } = harness({ [LIST_KEY]: ok({ ...LIST, workspaces: [DEFAULT, ...LIST.workspaces] }) })
    const answer = await registry.list()
    if (!answer.ok) throw new Error('expected a listing')
    expect(answer.workspaces.map((workspace) => [workspace.slug, workspace.isDefault])).toEqual([
      ['default', true],
      ['acme', false],
    ])
  })
})

describe('migrate — every project into the Default Workspace', () => {
  const DEFAULT_WS = { name: 'Default', slug: 'default', path: `${FLOW}/workspaces/default`, remote: null, default: true }
  const ROOTS = JSON.stringify([API, WEB])
  const KEY = `${HOME} :: workspace migrate --roots=${ROOTS} --json`
  const ANSWER = {
    action: 'migrate',
    dryRun: false,
    workspace: { ...DEFAULT_WS, created: true },
    migrated: [
      {
        root: API,
        project: project('api', API),
        previous: { kind: 'link' },
        imported: { files: 12, skipped: 0, renamed: 1 },
        noise: 'never crosses',
      },
    ],
    unchanged: [],
    pending: [{ root: WEB, reason: 'committed-folder', commit: { message: 'chore: move knowledge', files: 3, from: 'flow', to: 'flow.pre-workspace' } }],
    failed: [{ root: '/code/gone', reason: 'not-a-git-repo', detail: 'a terminal sentence with /paths' }],
  }

  it('asks the one verb with every root as one JSON value, and rebuilds the answer field by field', async () => {
    const { registry, h } = harness({ [KEY]: ok(ANSWER) })
    const answer = await registry.migrate({ roots: [API, WEB] })
    expect(answer).toEqual({
      ok: true,
      dryRun: false,
      workspace: { name: 'Default', slug: 'default', path: `${FLOW}/workspaces/default`, remote: null, isDefault: true, created: true },
      migrated: [{ root: API, project: project('api', API), previous: { kind: 'link' }, imported: { files: 12, skipped: 0, renamed: 1 } }],
      unchanged: [],
      pending: [{ root: WEB, reason: 'committed-folder', commit: { message: 'chore: move knowledge', files: 3, from: 'flow', to: 'flow.pre-workspace' } }],
      failed: [{ root: '/code/gone', reason: 'not-a-git-repo', detail: 'a terminal sentence with /paths' }],
    })
    expect(JSON.stringify(answer)).not.toContain('never crosses')
    expect(h.calls).toEqual([{ cwd: HOME, args: ['workspace', 'migrate', `--roots=${ROOTS}`, '--json'], timeoutMs: 300_000 }])
    expect(h.events).toEqual([{ cause: 'migrated' }])
  })

  it('a dry run announces nothing; relative roots are refused before anything runs', async () => {
    const DRY = `${HOME} :: workspace migrate --roots=${ROOTS} --dry-run --json`
    const { registry, h } = harness({ [DRY]: ok({ ...ANSWER, dryRun: true }) })
    expect((await registry.migrate({ roots: [API, WEB], dryRun: true })).ok).toBe(true)
    expect(h.events).toEqual([])
    expect(await registry.migrate({ roots: ['relative/path'] })).toMatchObject({ ok: false, reason: 'not-a-git-repo' })
    expect(h.calls).toHaveLength(1)
  })

  it('link --import copies the knowledge in (the add flow)', async () => {
    const LINK = `${API} :: workspace link --target=${API} --workspace=default --import --json`
    const { registry, h } = harness({
      [LINK]: ok({
        action: 'link',
        flowFolder: FLOW,
        workspace: DEFAULT_WS,
        project: project('api', API),
        link: 'created',
        previous: { kind: 'none' },
        projectAdded: true,
        codeRepo: { commit: null },
        imported: { files: 0, skipped: 0, renamed: 0 },
      }),
    })
    expect(await registry.link({ repoPath: API, workspace: 'default', importKnowledge: true })).toMatchObject({ ok: true, link: 'created' })
    expect(h.calls[0]?.args).toContain('--import')
  })
})

describe('rename, move a project, delete', () => {
  it('rename passes the new name as one value and announces once', async () => {
    const KEY = `${HOME} :: workspace rename --workspace=acme --name=Acme Corp --json`
    const { registry, h } = harness({ [KEY]: ok({ action: 'rename', workspace: { ...ACME, name: 'Acme Corp' } }) })
    expect(await registry.rename('acme', '  Acme Corp ')).toEqual({ ok: true, workspace: { ...ACME_APP, name: 'Acme Corp' } })
    expect(h.events).toEqual([{ cause: 'renamed' }])
  })

  it('rename refuses a bad slug or a blank name without asking anything', async () => {
    const { registry, h } = harness({})
    expect(await registry.rename('Not A Slug', 'x')).toMatchObject({ ok: false, reason: 'unknown-workspace' })
    expect(await registry.rename('acme', '   ')).toMatchObject({ ok: false, reason: 'invalid-name' })
    expect(h.calls).toEqual([])
  })

  it('move-project names the project, where it goes and where it comes from', async () => {
    const KEY = `${HOME} :: workspace move-project --project=github.com/acme/api --to=beta --from=acme --json`
    const { registry, h } = harness({ [KEY]: ok({ action: 'move-project', project: project('api', API) }) })
    expect(await registry.moveProject({ project: 'github.com/acme/api', to: 'beta', from: 'acme' })).toEqual({ ok: true, to: 'beta' })
    expect(h.events).toEqual([{ cause: 'moved' }])
  })

  it('delete always carries --confirm (only ever asked after a person confirmed) and reports what moved', async () => {
    const KEY = `${HOME} :: workspace delete --workspace=acme --confirm --json`
    const { registry, h } = harness({ [KEY]: ok({ action: 'delete', moved: [project('api', API), 'web'] }) })
    expect(await registry.deleteWorkspace('acme')).toEqual({ ok: true, workspace: 'acme', moved: ['api', 'web'] })
    expect(h.events).toEqual([{ cause: 'deleted' }])
  })

  it('the Default Workspace refuses to be deleted, in plain words', async () => {
    const KEY = `${HOME} :: workspace delete --workspace=default --confirm --json`
    const { registry, h } = harness({ [KEY]: refused({ action: 'delete', refused: 'default-workspace' }) })
    const answer = await registry.deleteWorkspace('default')
    expect(answer).toMatchObject({ ok: false, reason: 'default-workspace' })
    if (answer.ok) throw new Error('expected a refusal')
    expect(answer.detail).not.toMatch(/terminal sentence|planflow-ai|\//)
    expect(h.events).toEqual([])
  })
})

describe('a change refused because a sync holds the Workspace', () => {
  it('waits and asks again, then succeeds — the person never loses that race', async () => {
    const KEY = `${HOME} :: workspace move-project --project=github.com/acme/api --to=beta --json`
    const answers = [
      refused({ action: 'move-project', refused: 'sync-busy' }),
      refused({ action: 'move-project', refused: 'sync-busy' }),
      ok({ action: 'move-project', project: project('api', API) }),
    ]
    const sleeps: number[] = []
    const calls: string[][] = []
    const registry = createWorkspaceRegistry({
      runCli: async (cwd, args) => {
        calls.push([...args])
        const key = `${cwd} :: ${args.join(' ')}`
        if (key !== KEY) throw new Error(`unexpected CLI call: ${key}`)
        return answers.shift() as WorkspaceCliRun
      },
      settings: { getCurrentWorkspace: () => null, setCurrentWorkspace: () => undefined },
      homeDir: HOME,
      log: () => undefined,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(await registry.moveProject({ project: 'github.com/acme/api', to: 'beta' })).toEqual({ ok: true, to: 'beta' })
    expect(calls).toHaveLength(3)
    expect(sleeps).toHaveLength(2)
  })
})

describe('connecting a Workspace to a shared repository', () => {
  const TEAM = 'https://github.com/acme/acme-knowledge.git'
  const SET_KEY = `${HOME} :: workspace set-remote --workspace=acme --remote=${TEAM} --json`

  it('set-remote names the Workspace and the address as one value each, and announces once', async () => {
    const { registry, h } = harness({
      [SET_KEY]: ok({ action: 'set-remote', workspace: { ...ACME, remote: TEAM }, remote: TEAM, previous: null, changed: true, pushed: false }),
    })
    expect(await registry.setRemote('acme', `  ${TEAM}  `)).toEqual({ ok: true, workspace: { ...ACME_APP, remote: TEAM }, changed: true })
    expect(h.events).toEqual([{ cause: 'remote' }])
  })

  it('--replace is passed only when the caller says a person chose it', async () => {
    const KEY = `${HOME} :: workspace set-remote --workspace=acme --remote=${TEAM} --replace --json`
    const { registry, h } = harness({
      [KEY]: ok({ action: 'set-remote', workspace: { ...ACME, remote: TEAM }, remote: TEAM, previous: 'x', changed: true, pushed: false }),
    })
    expect((await registry.setRemote('acme', TEAM, { replace: true })).ok).toBe(true)
    expect(h.calls.map((call) => call.args)).toEqual([['workspace', 'set-remote', '--workspace=acme', `--remote=${TEAM}`, '--replace', '--json']])
  })

  it('an unchanged answer announces nothing', async () => {
    const { registry, h } = harness({
      [SET_KEY]: ok({ action: 'set-remote', workspace: { ...ACME, remote: TEAM }, remote: TEAM, previous: TEAM, changed: false, pushed: false }),
    })
    expect(await registry.setRemote('acme', TEAM)).toMatchObject({ ok: true, changed: false })
    expect(h.events).toEqual([])
  })

  it('refuses an unsafe address or a bad slug before anything is spawned', async () => {
    const { registry, h } = harness({})
    expect(await registry.setRemote('acme', 'https://bob:hunter2@github.com/acme/ws.git')).toMatchObject({ ok: false, reason: 'credentials-in-url' })
    expect(await registry.setRemote('acme', '--upload-pack=evil')).toMatchObject({ ok: false, reason: 'invalid-remote' })
    expect(await registry.setRemote('../acme', TEAM)).toMatchObject({ ok: false, reason: 'unknown-workspace' })
    expect(await registry.unsetRemote('Acme Corp')).toMatchObject({ ok: false, reason: 'unknown-workspace' })
    expect(h.calls).toEqual([])
  })

  it('a remote-exists refusal reads in plain words and carries the CLI payload', async () => {
    const { registry, h } = harness({
      [SET_KEY]: refused({ action: 'set-remote', refused: 'remote-exists', current: 'https://github.com/acme/old.git', wanted: TEAM, needs: 'replace' }),
    })
    const answer = await registry.setRemote('acme', TEAM)
    expect(answer).toMatchObject({ ok: false, reason: 'remote-exists', payload: { needs: 'replace', wanted: TEAM } })
    if (answer.ok) throw new Error('expected a refusal')
    expect(answer.detail).not.toMatch(/--replace|planflow|workspace\.json/)
    expect(h.events).toEqual([])
  })

  it('unset-remote asks the one verb and announces once', async () => {
    const { registry, h } = harness({
      [`${HOME} :: workspace unset-remote --workspace=acme --json`]: ok({
        action: 'unset-remote',
        workspace: ACME,
        previous: TEAM,
        changed: true,
        remoteUntouched: true,
      }),
    })
    expect(await registry.unsetRemote('acme')).toEqual({ ok: true, workspace: ACME_APP, changed: true })
    expect(h.events).toEqual([{ cause: 'remote' }])
  })
})
