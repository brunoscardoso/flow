/**
 * EVERY PROJECT LIVES IN A WORKSPACE — the launch migration and the placing of
 * a project added later, over a fake registry that RECORDS every question it
 * is asked (allowed-pattern #24: assert the question, not just the answer).
 */

import type { FlowNotification } from '../../shared/ipc-contract'
import type {
  WorkspaceAnswer,
  WorkspaceLinkResult,
  WorkspaceListing,
  WorkspaceMigrateResult,
  WorkspaceProject,
  WorkspaceRootMembership,
  WorkspacesList,
} from '../../shared/workspaces-contract'
import {
  placementProblem,
  FAILED_TITLE,
  MIGRATED_TITLE,
  MOVE_IN_LABEL,
  UNREADY_TITLE,
  WORKSPACE_MOVE_IN_EVENT,
  createWorkspacePlacement,
  failureReason,
  migratedBody,
  pendingBody,
} from './workspace-placement'
import type { WorkspaceLinkRequest, WorkspaceMigrateRequest } from './workspace-registry'
import { WORKSPACE_MOVE_IN_EVENT as RENDERER_EVENT } from '../../renderer/settings/workspace-settings-model'

const API = '/code/api'
const WEB = '/code/web'
const DOCS = '/code/docs'

function project(slug: string, localPath: string | null): WorkspaceProject {
  return { id: `github.com/acme/${slug}`, name: slug, slug, remotes: [], description: null, localPath, flowPath: `/flow/workspaces/default/projects/${slug}` }
}

const DEFAULT: WorkspaceListing = {
  name: 'Default',
  slug: 'default',
  path: '/flow/workspaces/default',
  remote: null,
  isDefault: true,
  projects: [],
}

interface Fake {
  workspaces: WorkspaceListing[]
  members: Map<string, string>
  current: string | null
  migrateAnswer: (request: WorkspaceMigrateRequest) => WorkspaceAnswer<WorkspaceMigrateResult>
  linkAnswer: (request: WorkspaceLinkRequest) => WorkspaceAnswer<WorkspaceLinkResult>
  migrations: WorkspaceMigrateRequest[]
  links: WorkspaceLinkRequest[]
  notices: FlowNotification[]
  changes: number
  listFails: boolean
}

function fake(overrides: Partial<Fake> = {}): Fake {
  return {
    workspaces: [],
    members: new Map(),
    current: null,
    migrations: [],
    links: [],
    notices: [],
    changes: 0,
    listFails: false,
    migrateAnswer: (request) => ({
      ok: true,
      dryRun: false,
      workspace: { ...DEFAULT, created: true },
      migrated: request.roots.map((root) => ({ root, project: project(root.split('/').pop() ?? root, root), previous: { kind: 'link' }, imported: { files: 1, skipped: 0, renamed: 0 } })),
      unchanged: [],
      pending: [],
      failed: [],
    }),
    linkAnswer: () => ({ ok: false, reason: 'failed', detail: 'x', payload: {} }),
    ...overrides,
  }
}

function placementOver(f: Fake, roots: string[]) {
  return createWorkspacePlacement({
    registry: {
      list: async (): Promise<WorkspaceAnswer<WorkspacesList>> =>
        f.listFails
          ? { ok: false, reason: 'unavailable', detail: 'x', payload: {} }
          : { ok: true, flowFolder: '/flow', workspaces: f.workspaces, unreadable: [] },
      membershipOf: async (asked): Promise<WorkspaceAnswer<WorkspaceRootMembership>> => ({
        ok: true,
        roots: asked.map((root) => ({ root, workspace: f.members.get(root) ?? null, project: null, linked: f.members.has(root) })),
      }),
      migrate: async (request) => {
        f.migrations.push(request)
        const answer = f.migrateAnswer(request)
        if (answer.ok) {
          f.workspaces = f.workspaces.some((workspace) => workspace.slug === 'default') ? f.workspaces : [DEFAULT, ...f.workspaces]
          for (const moved of answer.migrated) f.members.set(moved.root, 'default')
        }
        return answer
      },
      link: async (request) => {
        f.links.push(request)
        const answer = f.linkAnswer(request)
        if (answer.ok) f.members.set(request.repoPath, request.workspace)
        return answer
      },
      current: async () => ({ ok: true, slug: f.current ?? f.workspaces[0]?.slug ?? null }),
      invalidate: () => undefined,
    },
    roots: () => roots,
    notify: (notification) => f.notices.push(notification),
    onChanged: () => {
      f.changes += 1
    },
    log: () => undefined,
    now: () => '2026-10-06T12:00:00.000Z',
  })
}

describe('the launch migration', () => {
  it('moves every project outside a Workspace into Default with ONE question, and says so once', async () => {
    const f = fake()
    const placement = placementOver(f, [API, WEB])
    await placement.start()
    expect(f.migrations).toEqual([{ roots: [API, WEB] }])
    expect(f.notices).toHaveLength(1)
    expect(f.notices[0]).toMatchObject({ title: MIGRATED_TITLE, body: migratedBody('Default'), level: 'info' })
    expect(f.notices[0]?.body).toBe(
      'Your projects now live in the Default Workspace. Their knowledge came along; the old copies are kept as backups.',
    )
    expect(placement.state()).toEqual({ migrating: false, issues: [] })
    expect(f.changes).toBeGreaterThan(0)
  })

  it('is idempotent: a later launch with everything placed (and Default here) asks nothing to migrate', async () => {
    // Positive first: the same projects outside DO migrate.
    const outside = fake()
    await placementOver(outside, [API]).start()
    expect(outside.migrations).toHaveLength(1)

    const f = fake({ workspaces: [DEFAULT], members: new Map([[API, 'default']]) })
    await placementOver(f, [API]).start()
    expect(f.migrations).toEqual([])
    expect(f.notices).toEqual([])
  })

  it('re-runs only for roots still outside', async () => {
    const f = fake({ workspaces: [DEFAULT], members: new Map([[API, 'default']]) })
    await placementOver(f, [API, WEB]).start()
    expect(f.migrations).toEqual([{ roots: [WEB] }])
  })

  it('creates the Default Workspace even with no project yet', async () => {
    const f = fake()
    await placementOver(f, []).start()
    expect(f.migrations).toEqual([{ roots: [] }])
    // Nothing moved, so there is nothing to announce.
    expect(f.notices).toEqual([])
  })

  it('a committed knowledge folder waits: one card with its commit message and "Move it in"', async () => {
    const f = fake({
      migrateAnswer: () => ({
        ok: true,
        dryRun: false,
        workspace: { ...DEFAULT, created: true },
        migrated: [{ root: API, project: project('api', API), previous: { kind: 'folder', keptAt: 'x' }, imported: null }],
        unchanged: [],
        pending: [{ root: WEB, reason: 'committed-folder', commit: { message: 'chore: move knowledge', files: 3, from: 'flow', to: 'flow.pre-workspace' } }],
        failed: [],
      }),
    })
    const placement = placementOver(f, [API, WEB])
    await placement.start()
    const card = f.notices.find((notice) => notice.action !== undefined)
    expect(card).toMatchObject({
      title: 'Move web into Default?',
      action: { label: MOVE_IN_LABEL, event: WORKSPACE_MOVE_IN_EVENT, detail: { root: WEB } },
    })
    expect(card?.body).toContain('“chore: move knowledge”')
    expect(placement.state().issues).toEqual([
      {
        kind: 'pending',
        root: WEB,
        name: 'web',
        workspace: 'default',
        workspaceName: 'Default',
        commit: { message: 'chore: move knowledge', files: 3, from: 'flow', to: 'flow.pre-workspace' },
        problem: null,
      },
    ])
    // NO --confirm-commit was sent by the migration (forbidden-pattern #15).
    expect(f.links).toEqual([])
  })

  it('"Move it in" is the one press that sends the confirmation, with --import', async () => {
    const f = fake({
      migrateAnswer: () => ({
        ok: true,
        dryRun: false,
        workspace: { ...DEFAULT, created: true },
        migrated: [],
        unchanged: [],
        pending: [{ root: WEB, reason: 'committed-folder', commit: { message: 'm', files: 1, from: 'flow', to: 'flow.pre-workspace' } }],
        failed: [],
      }),
      linkAnswer: () => ({
        ok: true,
        workspace: DEFAULT,
        project: project('web', WEB),
        link: 'created',
        previous: { kind: 'committed-folder', keptAt: 'flow.pre-workspace' },
        projectAdded: true,
        commit: { sha: 'abc', message: 'm', files: 1 },
      }),
    })
    const placement = placementOver(f, [WEB])
    await placement.start()
    expect((await placement.moveIn(WEB)).ok).toBe(true)
    expect(f.links).toEqual([{ repoPath: WEB, workspace: 'default', importKnowledge: true, confirmCommit: true }])
    expect(placement.state().issues).toEqual([])
  })

  it('failures are named in ONE notification, in plain words — never the CLI\'s sentence', async () => {
    const f = fake({
      migrateAnswer: () => ({
        ok: true,
        dryRun: false,
        workspace: { ...DEFAULT, created: false },
        migrated: [],
        unchanged: [],
        pending: [],
        failed: [
          { root: API, reason: 'dirty-code', detail: 'git says /code/api is dirty' },
          { root: DOCS, reason: 'something-new', detail: 'a terminal sentence' },
        ],
      }),
    })
    const placement = placementOver(f, [API, DOCS])
    await placement.start()
    expect(f.notices).toHaveLength(1)
    expect(f.notices[0]).toMatchObject({ title: FAILED_TITLE, level: 'warn' })
    // Each project in its own words: an uncommitted knowledge file is not "try again".
    expect(f.notices[0]?.body).toContain("Some knowledge files in api have changes that aren't committed yet.")
    expect(f.notices[0]?.body).toContain("Flow couldn't move docs's knowledge in.")
    expect(f.notices[0]?.body).not.toMatch(/\/code|terminal sentence|planflow-ai/)
    expect(placement.state().issues.map((issue) => issue.kind)).toEqual(['failed', 'failed'])
  })

  it('a CLI that cannot answer says Flow could not set up the Workspace — and never blocks', async () => {
    const f = fake({ listFails: true })
    const placement = placementOver(f, [API])
    await placement.start()
    expect(f.migrations).toEqual([])
    expect(f.notices).toEqual([expect.objectContaining({ title: UNREADY_TITLE })])
    expect(placement.state().migrating).toBe(false)
  })

  it('start runs once, however often it is called', async () => {
    const f = fake()
    const placement = placementOver(f, [API])
    await Promise.all([placement.start(), placement.start()])
    await placement.start()
    expect(f.migrations).toHaveLength(1)
  })
})

describe('placing a project added later', () => {
  it('joins the Workspace it was added to, with its knowledge (link --import)', async () => {
    const acme: WorkspaceListing = { ...DEFAULT, name: 'Acme', slug: 'acme', isDefault: false }
    const f = fake({
      workspaces: [DEFAULT, acme],
      members: new Map([[API, 'default']]),
      linkAnswer: (request) => ({
        ok: true,
        workspace: acme,
        project: project('web', request.repoPath),
        link: 'created',
        previous: { kind: 'none' },
        projectAdded: true,
        commit: null,
      }),
    })
    // WEB is added after the launch: the launch migration only saw API.
    const placement = placementOver(f, [API])
    await placement.start()
    await placement.place(WEB, 'acme')
    expect(f.links).toEqual([{ repoPath: WEB, workspace: 'acme', importKnowledge: true }])
  })

  it('joins the CURRENT Workspace when the add named none — after the launch migration, never racing it', async () => {
    const f = fake({ workspaces: [DEFAULT], members: new Map([[API, 'default']]), current: 'default' })
    const placement = placementOver(f, [API])
    const started = placement.start()
    const placed = placement.place(WEB)
    await Promise.all([started, placed])
    expect(f.links).toEqual([{ repoPath: WEB, workspace: 'default', importKnowledge: true }])
  })

  it('asks nothing for a project already in a Workspace', async () => {
    const f = fake({ workspaces: [DEFAULT], members: new Map([[API, 'default']]) })
    const placement = placementOver(f, [API])
    await placement.place(API)
    expect(f.links).toEqual([])
    expect(f.migrations).toEqual([])
  })

  it('a committed folder on add becomes a pending card — no confirmation sent', async () => {
    const f = fake({
      workspaces: [DEFAULT],
      current: 'default',
      linkAnswer: () => ({ ok: false, reason: 'committed-flow', detail: 'x', payload: { commit: { message: 'chore: move', files: 2 } } }),
    })
    const placement = placementOver(f, [WEB])
    await placement.place(WEB)
    expect(f.links).toEqual([{ repoPath: WEB, workspace: 'default', importKnowledge: true }])
    expect(placement.state().issues[0]).toMatchObject({ kind: 'pending', root: WEB, workspaceName: 'Default' })
    expect(f.notices[0]?.action?.event).toBe(WORKSPACE_MOVE_IN_EVENT)
  })

  it('forgetting a removed project drops its issue', async () => {
    const f = fake({ workspaces: [DEFAULT], current: 'default' })
    const placement = placementOver(f, [WEB])
    await placement.place(WEB)
    expect(placement.state().issues).toHaveLength(1)
    placement.forget(WEB)
    expect(placement.state().issues).toEqual([])
  })
})

describe('the words', () => {
  it('a pending card says how big the commit is and that nothing is deleted', () => {
    expect(pendingBody({ message: 'a\nb', files: 1, from: 'flow', to: 'x' })).toBe(
      "Its knowledge is part of the project's own history, so moving it in sets the old folder aside in one commit of 1 file. Nothing is deleted. The commit will say: “a b”",
    )
  })

  it('a failure reason is the one refusal table, or a plain fallback', () => {
    expect(failureReason('dirty-code')).toMatch(/not committed yet/)
    expect(failureReason('never-heard-of-it')).toBe("Flow couldn't move its knowledge in.")
  })

  it('the renderer listens on the same event main names', () => {
    expect(RENDERER_EVENT).toBe(WORKSPACE_MOVE_IN_EVENT)
  })
})

describe('a "Move it in" that did not finish', () => {
  it('keeps the project waiting — still "Move it in" — and says why, in its own words', async () => {
    const f = fake({
      migrateAnswer: () => ({
        ok: true,
        dryRun: false,
        workspace: { ...DEFAULT, created: true },
        migrated: [],
        unchanged: [],
        pending: [{ root: WEB, reason: 'committed-folder', commit: { message: 'm', files: 1, from: 'flow', to: 'flow.pre-workspace' } }],
        failed: [],
      }),
      linkAnswer: () => ({ ok: false, reason: 'dirty-code', detail: 'x', payload: {} }),
    })
    const placement = placementOver(f, [WEB])
    await placement.start()
    expect((await placement.moveIn(WEB)).ok).toBe(false)
    expect(placement.state().issues).toEqual([
      expect.objectContaining({ kind: 'pending', root: WEB, problem: placementProblem('dirty-code', 'web') }),
    ])
    expect(placementProblem('dirty-code', 'storefront-mobile')).toBe(
      "Some knowledge files in storefront-mobile have changes that aren't committed yet. Commit them first, then move it in.",
    )
    for (const reason of ['committed-flow', 'failed', 'commit-failed', 'unavailable', 'never-heard-of-it']) {
      const text = placementProblem(reason, 'web')
      expect(text).toContain('web')
      expect(text).not.toMatch(/\/|planflow-ai|--/)
    }
  })
})

