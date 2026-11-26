// A conversation's Docker group — pure helpers, and the port with Docker faked
// as an argv-keyed table that THROWS on anything absent (allowed-pattern #24):
// a test asserts the questions the code asked Docker, not just its answers.

import type { ResolvedRunStep } from '../../shared/run-setup'
import { describeCompose } from './compose-describe'
import { LABEL_PROJECT, LABEL_THREAD, projectDataSlug, threadComposeOverride } from './compose-thread'
import type { DockerRunner, DockerRunResult } from './docker-runner'
import { GUARD_REFUSAL } from './migration-guard'
import {
  commandLine,
  composeCreateArgs,
  composeProjectName,
  composeStopArgs,
  createThreadDocker,
  DATA_RUNNING_CHECKS,
  DOCKER_SENTENCE,
  createThreadDockerSource,
  dockerStepsFor,
  foldHandMadeSteps,
  handMadeComposeServices,
  parseEnvFile,
  portClashSentence,
  publishedPortClash,
  shellQuote,
  type ComposeTarget,
  type DockerGroupPlan,
} from './thread-docker'

const THREAD = '3f2a9c1e-77b0-4d2e-9a10-5b6c7d8e9f00'
const LIVE = 'aaaaaaaa-1111-2222-3333-444444444444'
const ROOT = '/repos/shop'
const CHECKOUT = '/repos/.shop-threads/blue'

const WITH_APP = [
  'services:',
  '  web:',
  '    build: .',
  '    volumes:',
  '      - .:/app',
  '    ports:',
  '      - "3000:3000"',
  '  db:',
  '    image: postgres:16',
  '    volumes:',
  '      - pgdata:/var/lib/postgresql/data',
  '    ports:',
  '      - 5432:5432',
  'volumes:',
  '  pgdata:',
].join('\n')

/** No service mounts the code: no app service, so a migration runs locally or not at all. */
const NO_APP = [
  'services:',
  '  db:',
  '    image: postgres:16',
  '    volumes:',
  '      - pgdata:/var/lib/postgresql/data',
  '    ports:',
  '      - 5432:5432',
  'volumes:',
  '  pgdata:',
].join('\n')

function target(overridePath = `/data/compose-overrides/shop/${THREAD.slice(0, 8)}.yml`): ComposeTarget {
  return { projectName: 'shop', checkout: CHECKOUT, composeFile: `${CHECKOUT}/compose.yaml`, projectOverride: null, overridePath }
}

function groupPlan(text: string, options: { root?: string; name?: string; threadId?: string; checkout?: string } = {}): DockerGroupPlan {
  const threadId = options.threadId ?? THREAD
  const checkout = options.checkout ?? CHECKOUT
  const plan = threadComposeOverride({ project: describeCompose(text), projectSlug: 'shop', threadId, checkout })
  return {
    group: {
      projectRoot: options.root ?? ROOT,
      projectName: options.name ?? 'shop',
      threadId,
      checkout,
      services: [...plan.readableServices],
      dataServices: [...plan.dataServices],
      volumes: plan.volumes.map((v) => v.name),
      unreadable: [],
      folded: [],
      notes: [],
    },
    plan,
    target: { ...target(), checkout, composeFile: `${checkout}/compose.yaml`, overridePath: `/data/o/${threadId}.yml` },
  }
}

// ─── the fake Docker ────────────────────────────────────────────────────────

type Answer = Partial<DockerRunResult>

function fakeDocker(table: Record<string, Answer>): { runner: DockerRunner; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    runner: {
      run: async (args) => {
        calls.push(args)
        const key = args.join(' ')
        const answer = table[key]
        if (answer === undefined) throw new Error(`unexpected docker call: ${key}`)
        return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false, ...answer }
      },
    },
  }
}

const AVAILABLE: Record<string, Answer> = {
  'version --format {{.Server.Version}}': { stdout: '27.0.1\n' },
  'compose version --short': { stdout: '2.29.0\n' },
}

const liveKey = (slug: string): string => `ps --filter label=${LABEL_PROJECT}=${slug} --format {{.Label "${LABEL_THREAD}"}}`
const volumesKey = (slug: string, threadId: string): string =>
  `volume ls --filter label=${LABEL_PROJECT}=${slug} --filter label=${LABEL_THREAD}=${threadId} --format {{.Name}}\t{{.Label "dev.planflow.volume"}}\t{{.Label "${LABEL_THREAD}"}}`

const containersKey = (slug: string, threadId: string): string =>
  `ps --all --filter label=${LABEL_PROJECT}=${slug} --filter label=${LABEL_THREAD}=${threadId} --format {{.ID}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}`
const configKey = (threadId = THREAD): string =>
  `compose -p shop -f ${CHECKOUT}/compose.yaml -f /data/o/${threadId}.yml --project-directory ${CHECKOUT} config --format json`

/** This thread's own containers run db and web: the data step may go on. */
const OURS: Record<string, Answer> = {
  [liveKey('shop')]: { stdout: `${THREAD}\n${THREAD}\n` },
  [containersKey('shop', THREAD)]: { stdout: 'c1\tdb\trunning\nc2\tweb\trunning\n' },
}

/** Only reads were asked of Docker: no exec, run, up or stop. */
const onlyReads = (calls: string[][]): boolean =>
  calls.every((call) => call[0] === 'ps' || (call[0] === 'compose' && call.at(-3) === 'config'))

function port(table: Record<string, Answer>, extra: Partial<Parameters<typeof createThreadDocker>[0]> = {}) {
  const docker = fakeDocker(table)
  const written: string[] = []
  const thread = createThreadDocker({
    runner: docker.runner,
    overrides: {
      write: async (plan) => {
        written.push(plan.threadId)
        return `/data/o/${plan.threadId}.yml`
      },
    },
    fs: { readFile: async () => null, exists: async () => false },
    detectDataCommands: async () => ({ migrations: [], seeds: [] }),
    resolveThread: async () => null,
    processEnv: {},
    opener: async () => '',
    slugOf: () => 'shop',
    wait: async () => undefined,
    ...extra,
  })
  return { ...docker, thread, written }
}

// ─── pure helpers ───────────────────────────────────────────────────────────

describe('shell words', () => {
  it('quotes only what has to be, and survives a quote inside', () => {
    expect(shellQuote('/repos/shop/compose.yaml')).toBe('/repos/shop/compose.yaml')
    expect(shellQuote('/Users/me/My Projects/shop')).toBe(`'/Users/me/My Projects/shop'`)
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
    expect(shellQuote('')).toBe(`''`)
    expect(commandLine(['docker', 'compose', '-f', '/a b/c.yml'])).toBe(`docker compose -f '/a b/c.yml'`)
  })
})

describe('the Compose project name', () => {
  it("is the file's own name when written, else the folder made the way Compose makes it", () => {
    expect(composeProjectName('/repos/My.Shop', 'services: {}')).toBe('myshop')
    expect(composeProjectName('/repos/shop', 'name: storefront\nservices: {}')).toBe('storefront')
    expect(composeProjectName('/repos/shop', 'name: ${NAME}\nservices: {}')).toBe('shop')
  })
})

describe('the project slug', () => {
  it('is one function: readable, and different for two folders of the same name', () => {
    const a = projectDataSlug('/Users/me/work/api')
    const b = projectDataSlug('/Users/me/oss/api')
    expect(a).toMatch(/^api-[0-9a-f]{6}$/)
    expect(a).not.toBe(b)
    expect(projectDataSlug('/Users/me/work/api')).toBe(a)
  })
})

describe('the argv', () => {
  it('runs from the checkout with the thread override and renews anonymous volumes on create', () => {
    expect(composeCreateArgs(target('/o/t.yml'), ['web', 'db'])).toEqual([
      'compose', '-p', 'shop', '-f', `${CHECKOUT}/compose.yaml`, '-f', '/o/t.yml', '--project-directory', CHECKOUT,
      'up', '--no-start', '--renew-anon-volumes', 'web', 'db',
    ])
  })

  it("passes the project's own override explicitly", () => {
    const args = composeStopArgs({ ...target('/o/t.yml'), projectOverride: `${CHECKOUT}/compose.override.yaml` })
    expect(args.slice(0, 9)).toEqual(['compose', '-p', 'shop', '-f', `${CHECKOUT}/compose.yaml`, '-f', `${CHECKOUT}/compose.override.yaml`, '-f', '/o/t.yml'])
  })
})

describe('hand-made compose steps', () => {
  it('reads a plain `up` and the services it names', () => {
    expect(handMadeComposeServices('docker compose up db')).toEqual(['db'])
    expect(handMadeComposeServices('docker compose up -d db redis')).toEqual(['db', 'redis'])
    expect(handMadeComposeServices('docker-compose up --build db')).toEqual(['db'])
    expect(handMadeComposeServices('docker compose up')).toEqual([])
  })

  it('leaves anything else alone', () => {
    expect(handMadeComposeServices('docker compose -f other.yml up db')).toBeNull()
    expect(handMadeComposeServices('docker compose up --profile x db')).toBeNull()
    expect(handMadeComposeServices('npm run dev')).toBeNull()
    expect(handMadeComposeServices('docker compose run db')).toBeNull()
  })

  const step = (key: string, command: string, projectRoot = ROOT): ResolvedRunStep => ({
    key, projectRoot, projectName: 'shop', cwd: projectRoot, id: key, name: key, command, start: 'now',
    readyTimeoutMs: 60_000, from: { command: 'shared', ready: 'shared' },
  })

  it('folds a step that starts only group services, in the same project, and keeps the rest', () => {
    const groups = [{ projectRoot: ROOT, services: ['web', 'db'], unreadable: [] }]
    const { kept, folded } = foldHandMadeSteps(
      [
        step('db', 'docker compose up -d db'),
        step('all', 'docker compose up'),
        step('other', 'docker compose up db', '/repos/other'),
        step('mail', 'docker compose up mailhog'),
        step('dev', 'npm run dev'),
      ],
      groups,
    )
    expect(kept.map((s) => s.key)).toEqual(['other', 'mail', 'dev'])
    expect(folded.get(ROOT)).toEqual(['db', 'all'])
  })

  it('keeps a bare `up` when the group cannot run every service', () => {
    const { kept } = foldHandMadeSteps([step('all', 'docker compose up')], [
      { projectRoot: ROOT, services: ['db'], unreadable: [{ service: 'tools', reason: 'x' }] },
    ])
    expect(kept.map((s) => s.key)).toEqual(['all'])
  })
})

describe('the port clash between projects', () => {
  const ports = (published: number, hostIp: string | null = null) => [{ service: 's', published, target: published, hostIp, protocol: 'tcp' }]

  it('names both projects and the port', () => {
    const clash = publishedPortClash([
      { projectName: 'shop', publishedPorts: ports(5432) },
      { projectName: 'billing', publishedPorts: ports(5432, '127.0.0.1') },
    ])
    expect(clash).toEqual({ port: 5432, first: 'shop', second: 'billing' })
    expect(portClashSentence('shop', 'billing', 5432)).toContain('shop and billing both use port 5432')
  })

  it('is no clash on different ports or different single addresses', () => {
    expect(publishedPortClash([{ projectName: 'a', publishedPorts: ports(5432) }, { projectName: 'b', publishedPorts: ports(5433) }])).toBeNull()
    expect(
      publishedPortClash([{ projectName: 'a', publishedPorts: ports(80, '127.0.0.1') }, { projectName: 'b', publishedPorts: ports(80, '127.0.0.2') }]),
    ).toBeNull()
  })
})

describe('env files', () => {
  it('reads KEY=VALUE, export, quotes and comments', () => {
    expect(
      parseEnvFile(['# comment', 'export DATABASE_URL="postgres://u:p@localhost:5432/app"', "REDIS_URL='redis://x:6379'", 'PGPORT=5433 # local', 'not a line', ''].join('\n')),
    ).toEqual({ DATABASE_URL: 'postgres://u:p@localhost:5432/app', REDIS_URL: 'redis://x:6379', PGPORT: '5433' })
  })
})

describe('the group steps', () => {
  it('one per service, attached, waiting for its published port', () => {
    const steps = dockerStepsFor(groupPlan(WITH_APP))
    expect(steps.map((s) => [s.key, s.ready, s.docker])).toEqual([
      [`${ROOT}::docker:web`, { kind: 'port', port: 3000 }, { projectRoot: ROOT, service: 'web' }],
      [`${ROOT}::docker:db`, { kind: 'port', port: 5432 }, { projectRoot: ROOT, service: 'db' }],
    ])
    expect(steps[1]!.command).toContain('up --no-recreate db')
    expect(steps[1]!.cwd).toBe(CHECKOUT)
  })
})

// ─── the source ─────────────────────────────────────────────────────────────

describe('the source the store asks', () => {
  const fs = (files: Record<string, string>) => ({
    readFile: async (path: string) => files[path] ?? null,
    exists: async (path: string) => path in files,
  })

  it('reads the Compose file from the thread checkout — no setting, no question first', async () => {
    const source = createThreadDockerSource({
      fs: fs({ [`${CHECKOUT}/compose.yaml`]: WITH_APP }),
      overrides: { pathFor: (slug, id) => `/data/o/${slug}/${id}.yml` },
      slugOf: () => 'shop',
    })
    const entry = await source.groupFor({ root: ROOT, name: 'shop', cwd: CHECKOUT }, THREAD)
    expect(entry?.group.services).toEqual(['web', 'db'])
    expect(entry?.target).toEqual({
      projectName: 'shop',
      checkout: CHECKOUT,
      composeFile: `${CHECKOUT}/compose.yaml`,
      projectOverride: null,
      overridePath: `/data/o/shop/${THREAD}.yml`,
    })
  })

  it('is nothing without a Compose file in the checkout', async () => {
    const none = createThreadDockerSource({ fs: fs({ [`${ROOT}/compose.yaml`]: WITH_APP }), overrides: { pathFor: () => '/o' } })
    expect(await none.groupFor({ root: ROOT, name: 'shop', cwd: CHECKOUT }, THREAD)).toBeNull()
  })
})

// ─── the port: the switch ───────────────────────────────────────────────────

describe('stopThread — only ever this conversation', () => {
  it('the live conversation is stopped through Compose; one that is not live is stopped by its label alone', async () => {
    const mine = groupPlan(WITH_APP)
    const stopKey = composeStopArgs(mine.target).join(' ')
    const byLabel = `ps -q --filter label=${LABEL_THREAD}=${THREAD}`
    // Control: this conversation is the live one, so the Compose stop is its own.
    const live = port({ [liveKey('shop')]: { stdout: `${THREAD}\n` }, [stopKey]: {}, [byLabel]: { stdout: '' } }, { resolveThread: async () => [mine] })
    expect(await live.thread.stopThread(THREAD)).toBe(true)
    expect(live.calls.map((c) => c.join(' '))).toContain(stopKey)
    // Another conversation is live: a Compose stop would stop IT (they share the
    // project name), so only this conversation's labelled containers are stopped.
    const other = port(
      { [liveKey('shop')]: { stdout: `${LIVE}\n` }, [byLabel]: { stdout: 'c9\n' }, 'stop c9': {} },
      { resolveThread: async () => [mine] },
    )
    expect(await other.thread.stopThread(THREAD)).toBe(true)
    const asked = other.calls.map((c) => c.join(' '))
    expect(asked).toContain('stop c9')
    expect(asked).not.toContain(stopKey)
  })
})


describe('prepare — the switch', () => {
  it('stops the live conversation first, then creates this one with renewed anonymous volumes', async () => {
    const mine = groupPlan(WITH_APP)
    const theirs = groupPlan(WITH_APP, { threadId: LIVE, checkout: '/repos/.shop-threads/red' })
    const stopKey = composeStopArgs(theirs.target).join(' ')
    const createKey = composeCreateArgs(mine.target, ['web', 'db']).join(' ')
    const stoppedFirst: string[] = []
    const h = port(
      {
        ...AVAILABLE,
        [liveKey('shop')]: { stdout: `${LIVE}\n${LIVE}\n` },
        [stopKey]: {},
        [`ps -q --filter label=${LABEL_THREAD}=${LIVE}`]: { stdout: '' },
        [volumesKey('shop', THREAD)]: { stdout: '' },
        [createKey]: {},
      },
      { resolveThread: async (id) => (id === LIVE ? [theirs] : null) },
    )
    const result = await h.thread.prepare({ threadId: THREAD, groups: [mine], beforeStop: (id) => stoppedFirst.push(id) })
    expect(result).toEqual({ ok: true, projects: new Map([[ROOT, { ok: true, newVolumes: true }]]) })
    expect(stoppedFirst).toEqual([LIVE])
    const order = h.calls.map((c) => c.join(' '))
    expect(order.indexOf(stopKey)).toBeGreaterThan(-1)
    expect(order.indexOf(stopKey)).toBeLessThan(order.indexOf(createKey))
    expect(h.calls.find((c) => c.includes('up'))).toContain('--renew-anon-volumes')
    expect(h.written).toEqual([THREAD])
  })

  it("every Compose call names the project's own Compose name and the checkout it is about: the live one's to stop, this one's to create", async () => {
    const mine = groupPlan(WITH_APP)
    const theirs = groupPlan(WITH_APP, { threadId: LIVE, checkout: '/repos/.shop-threads/red' })
    const stopKey = composeStopArgs(theirs.target).join(' ')
    const labelKey = `ps -q --filter label=${LABEL_THREAD}=${LIVE}`
    const createKey = composeCreateArgs(mine.target, ['web', 'db']).join(' ')
    const h = port(
      {
        ...AVAILABLE,
        [liveKey('shop')]: { stdout: `${LIVE}\n` },
        [stopKey]: {},
        [labelKey]: { stdout: 'c9\n' },
        'stop c9': {},
        [volumesKey('shop', THREAD)]: { stdout: '' },
        [createKey]: {},
      },
      { resolveThread: async (id) => (id === LIVE ? [theirs] : null) },
    )
    const result = await h.thread.prepare({ threadId: THREAD, groups: [mine], beforeStop: () => undefined })
    expect(result.ok).toBe(true)
    const order = h.calls.map((c) => c.join(' '))
    // Stopped with its own files, then whatever still carries its label, then this thread created.
    expect(order.indexOf(stopKey)).toBeLessThan(order.indexOf(labelKey))
    expect(order.indexOf(labelKey)).toBeLessThan(order.indexOf('stop c9'))
    expect(order.indexOf('stop c9')).toBeLessThan(order.indexOf(createKey))
    const compose = h.calls.filter((c) => c[0] === 'compose' && c[1] !== 'version')
    expect(compose).toHaveLength(2)
    for (const call of compose) {
      expect(call.slice(1, 3)).toEqual(['-p', 'shop'])
      expect(call).toContain('--project-directory')
    }
    const dirOf = (call: string[]): string => call[call.indexOf('--project-directory') + 1]!
    expect(dirOf(compose[0]!)).toBe('/repos/.shop-threads/red')
    expect(compose[0]!.slice(-1)).toEqual(['stop'])
    expect(dirOf(compose[1]!)).toBe(CHECKOUT)
    expect(compose[1]!).toEqual(expect.arrayContaining(['up', '--no-start', '--renew-anon-volumes', 'web', 'db']))
  })

  it('the live conversation will not stop: this one is neither written nor created', async () => {
    const mine = groupPlan(WITH_APP)
    const theirs = groupPlan(WITH_APP, { threadId: LIVE, checkout: '/repos/.shop-threads/red' })
    const stopKey = composeStopArgs(theirs.target).join(' ')
    const h = port(
      {
        ...AVAILABLE,
        [liveKey('shop')]: { stdout: `${LIVE}\n` },
        [stopKey]: { ok: false, code: 1 },
        [`ps -q --filter label=${LABEL_THREAD}=${LIVE}`]: { ok: false, code: 1 },
      },
      { resolveThread: async (id) => (id === LIVE ? [theirs] : null) },
    )
    const result = await h.thread.prepare({ threadId: THREAD, groups: [mine], beforeStop: () => undefined })
    // Positive first: the stop WAS attempted …
    expect(h.calls.map((c) => c.join(' '))).toContain(stopKey)
    expect(result).toEqual({ ok: true, projects: new Map([[ROOT, { ok: false, detail: expect.any(String) }]]) })
    // … and nothing of this thread was written or created.
    expect(h.written).toEqual([])
    expect(h.calls.some((c) => c.includes('up'))).toBe(false)
  })

  it('a volume list Docker cannot answer is never read as new volumes — so no seed runs', async () => {
    const mine = groupPlan(WITH_APP)
    const createKey = composeCreateArgs(mine.target, ['web', 'db']).join(' ')
    for (const volumes of [{ [volumesKey('shop', THREAD)]: { ok: false, code: 1 } }, {}]) {
      // `{}` leaves the list out of the table, so the fake throws on it.
      const h = port({ ...AVAILABLE, [liveKey('shop')]: { stdout: '' }, ...volumes, [createKey]: {} })
      const result = await h.thread.prepare({ threadId: THREAD, groups: [mine], beforeStop: () => undefined })
      // Positive first: the list was asked, and the create still ran.
      expect(h.calls.some((c) => c[0] === 'volume' && c[1] === 'ls')).toBe(true)
      expect(h.calls.map((c) => c.join(' '))).toContain(createKey)
      expect(result).toEqual({ ok: true, projects: new Map([[ROOT, { ok: true, newVolumes: false }]]) })
    }
    const seeds = port({}, { detectDataCommands: async () => ({ migrations: [], seeds: [{ command: 'make seed', source: 'Makefile' }] }) })
    expect((await seeds.thread.dataCommands(mine, true)).items.map((item) => item.kind)).toEqual(['seed'])
    expect((await seeds.thread.dataCommands(mine, false)).items).toEqual([])
  })

  it('knows the volumes were already there, so seeds will not run again', async () => {
    const mine = groupPlan(WITH_APP)
    const h = port({
      ...AVAILABLE,
      [liveKey('shop')]: { stdout: `${THREAD}\n` },
      [volumesKey('shop', THREAD)]: { stdout: `${mine.plan.volumes[0]!.name}\tpgdata\t${THREAD}\n` },
      [composeCreateArgs(mine.target, ['web', 'db']).join(' ')]: {},
    })
    const result = await h.thread.prepare({ threadId: THREAD, groups: [mine], beforeStop: () => undefined })
    expect(result).toEqual({ ok: true, projects: new Map([[ROOT, { ok: true, newVolumes: false }]]) })
    // Its own data is live: nothing was stopped.
    expect(h.calls.some((c) => c.includes('stop'))).toBe(false)
  })

  it('Docker not running: a sentence and the open-Docker offer, and nothing else asked', async () => {
    const h = port({ 'version --format {{.Server.Version}}': { ok: false, code: 1 } })
    const result = await h.thread.prepare({ threadId: THREAD, groups: [groupPlan(WITH_APP)], beforeStop: () => undefined })
    expect(result).toMatchObject({ ok: false, kind: 'docker-unavailable', offerOpenDocker: true })
    expect(h.calls).toEqual([['version', '--format', '{{.Server.Version}}']])
    expect(h.written).toEqual([])
  })

  it('two projects on one port: refused before Docker is asked anything', async () => {
    const h = port({})
    const result = await h.thread.prepare({
      threadId: THREAD,
      groups: [groupPlan(WITH_APP), groupPlan(NO_APP, { root: '/repos/billing', name: 'billing' })],
      beforeStop: () => undefined,
    })
    expect(result).toEqual({ ok: false, kind: 'port-clash', detail: portClashSentence('shop', 'billing', 5432), offerOpenDocker: false })
    expect(h.calls).toEqual([])
  })

  it('a create Docker refuses is that project failing, with what Docker said', async () => {
    const mine = groupPlan(WITH_APP)
    const h = port({
      ...AVAILABLE,
      [liveKey('shop')]: { stdout: '' },
      [volumesKey('shop', THREAD)]: { stdout: '' },
      [composeCreateArgs(mine.target, ['web', 'db']).join(' ')]: { ok: false, code: 1, stderr: 'pull access denied' },
    })
    const result = await h.thread.prepare({ threadId: THREAD, groups: [mine], beforeStop: () => undefined })
    expect(result.ok).toBe(true)
    const outcome = result.ok ? result.projects.get(ROOT) : undefined
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome !== undefined && !outcome.ok ? outcome.detail : '').toContain('pull access denied')
  })
})

// ─── the port: migrations and seeds through the guard ───────────────────────

describe('dataCommands — through the guard', () => {
  const detected = { migrations: [{ command: 'alembic upgrade head', source: 'Alembic' }], seeds: [{ command: 'make seed', source: 'Makefile' }] }

  it('inside the app service: an exec in the thread run; seeds only on new volumes', async () => {
    const config = { stdout: JSON.stringify({ services: { web: { environment: { DATABASE_URL: 'postgres://u:p@db:5432/app' } }, db: {} } }) }
    const h = port({ ...OURS, [configKey()]: config }, { detectDataCommands: async () => detected })
    const fresh = await h.thread.dataCommands(groupPlan(WITH_APP), true)
    expect(fresh.items.map((item) => item.kind)).toEqual(['migration', 'seed'])
    const first = fresh.items[0]!
    expect('run' in first && first.run.command).toContain('exec -T web sh -lc')
    expect('run' in first && first.run.command).toContain(`'alembic upgrade head'`)
    const again = await h.thread.dataCommands(groupPlan(WITH_APP), false)
    expect(again.items.map((item) => item.kind)).toEqual(['migration'])
    // Deciding runs nothing: Docker was only asked whose containers run and what the services' settings are.
    expect(h.calls.length).toBeGreaterThan(0)
    expect(onlyReads(h.calls)).toBe(true)
  })

  it('inside the app service: refused when its own settings point at another server', async () => {
    const config = { stdout: JSON.stringify({ services: { web: { environment: ['DATABASE_URL=postgres://u:p@db.prod.example:5432/app'] }, db: {} } }) }
    const h = port({ ...OURS, [configKey()]: config }, { detectDataCommands: async () => detected })
    const result = await h.thread.dataCommands(groupPlan(WITH_APP), false)
    expect(result.items).toEqual([{ kind: 'migration', name: 'Update database', refused: GUARD_REFUSAL.foreign }])
  })

  it("refused when this thread's containers are not the ones running — a port that answers proves nothing", async () => {
    const local = { readFile: async (path: string) => (path === `${CHECKOUT}/.env` ? 'DATABASE_URL=postgres://u:p@localhost:5432/app\n' : null), exists: async () => false }
    // Positive control: with this thread's containers running, the same setup runs locally.
    const ours = port(OURS, { detectDataCommands: async () => detected, fs: local })
    expect((await ours.thread.dataCommands(groupPlan(NO_APP), false)).items[0]).toMatchObject({ run: { command: 'alembic upgrade head' } })
    // Another thread's containers run: refused at once.
    const theirs = port({ [liveKey('shop')]: { stdout: `${LIVE}\n` } }, { detectDataCommands: async () => detected, fs: local })
    expect((await theirs.thread.dataCommands(groupPlan(NO_APP), false)).items).toEqual([
      { kind: 'migration', name: 'Update database', refused: DOCKER_SENTENCE.notOurs },
    ])
    // Nothing of ours ever runs (something else holds the port): refused after the checks.
    let waits = 0
    const none = port(
      { [liveKey('shop')]: { stdout: '' }, [containersKey('shop', THREAD)]: { stdout: 'c1\tdb\texited\n' } },
      { detectDataCommands: async () => detected, fs: local, wait: async () => void (waits += 1) },
    )
    expect((await none.thread.dataCommands(groupPlan(NO_APP), false)).items).toEqual([
      { kind: 'migration', name: 'Update database', refused: DOCKER_SENTENCE.notOurs },
    ])
    expect(waits).toBe(DATA_RUNNING_CHECKS - 1)
  })

  it("refused when the database is not this thread's: the reason, and no command at all", async () => {
    const h = port(
      OURS,
      {
        detectDataCommands: async () => detected,
        fs: { readFile: async (path) => (path === `${CHECKOUT}/.env` ? 'DATABASE_URL=postgres://u:p@db.prod.example:5432/app\n' : null), exists: async () => false },
      },
    )
    const result = await h.thread.dataCommands(groupPlan(NO_APP), true)
    expect(result.items).toEqual([
      { kind: 'migration', name: 'Update database', refused: GUARD_REFUSAL.foreign },
      { kind: 'seed', name: 'Fill new database', refused: GUARD_REFUSAL.foreign },
    ])
    expect(result.items.some((item) => 'run' in item)).toBe(false)
  })

  it('an inherited variable counts too: a local file pointing home does not hide it', async () => {
    const h = port(
      OURS,
      {
        detectDataCommands: async () => detected,
        fs: { readFile: async (path) => (path === `${CHECKOUT}/.env` ? 'DATABASE_URL=postgres://u:p@localhost:5432/app\n' : null), exists: async () => false },
        processEnv: { DATABASE_URL: 'postgres://u:p@db.prod.example:5432/app' },
      },
    )
    const result = await h.thread.dataCommands(groupPlan(NO_APP), false)
    expect(result.items).toEqual([{ kind: 'migration', name: 'Update database', refused: GUARD_REFUSAL.foreign }])
  })

  it("locally, only on this thread's published port", async () => {
    const h = port(
      OURS,
      {
        detectDataCommands: async () => detected,
        fs: { readFile: async (path) => (path === `${CHECKOUT}/.env.local` ? 'DATABASE_URL=postgres://u:p@localhost:5432/app\n' : null), exists: async () => false },
      },
    )
    const result = await h.thread.dataCommands(groupPlan(NO_APP), false)
    expect(result.items).toEqual([{ kind: 'migration', name: 'Update database', run: { command: 'alembic upgrade head', cwd: CHECKOUT } }])
  })

  it('a database on a local socket, or found by a name lookup, is refused — and nothing is built for it', async () => {
    for (const env of ['PGHOST=/var/run/postgresql\n', 'MONGODB_URI=mongodb+srv://u:p@cluster0.example.net/app\n', 'DATABASE_URL=postgres://u@${DB_HOST}:5432/app\n']) {
      const h = port(
        OURS,
        {
          detectDataCommands: async () => detected,
          fs: { readFile: async (path) => (path === `${CHECKOUT}/.env` ? env : null), exists: async () => false },
        },
      )
      const result = await h.thread.dataCommands(groupPlan(NO_APP), true)
      expect(result.items).toEqual([
        { kind: 'migration', name: 'Update database', refused: GUARD_REFUSAL.unreadable },
        { kind: 'seed', name: 'Fill new database', refused: GUARD_REFUSAL.unreadable },
      ])
      expect(onlyReads(h.calls)).toBe(true)
    }
  })

  it('no migration found: nothing runs, and it says so', async () => {
    const h = port({})
    const result = await h.thread.dataCommands(groupPlan(WITH_APP), true)
    expect(result.items).toEqual([])
    expect(result.notice).not.toBeNull()
  })
})
