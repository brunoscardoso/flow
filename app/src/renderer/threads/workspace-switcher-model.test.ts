import type { WorkspaceListing, WorkspacePlacementState, WorkspaceProject } from '../../shared/workspaces-contract'
import {
  DELETE_WORKSPACE_LABEL,
  FAILED_ATTENTION_TEXT,
  JOIN_WORKSPACE_LABEL,
  MOVE_PROJECT_LABEL,
  NEEDS_ATTENTION_HEADING,
  NEW_WORKSPACE_LABEL,
  NO_WORKSPACE_LABEL,
  NOT_ON_THIS_MACHINE,
  NOT_OPEN_HERE,
  OPEN_PROJECT_LABEL,
  RENAME_WORKSPACE_LABEL,
  SETTING_UP_LINE,
  attentionEntries,
  choiceForRoot,
  comparablePath,
  defaultNewThreadProject,
  deriveScope,
  emptyWorkspaceMessage,
  moveProjectLabel,
  moveTargets,
  parseLastProjects,
  pendingAttentionText,
  memberOf,
  projectTag,
  registeredRootOf,
  rememberLastProject,
  rootInScope,
  rootsInScope,
  sameMembership,
  sameScope,
  switcherLabel,
  switcherMenu,
  switcherTitle,
  syncStatusText,
  UNAVAILABLE_TAG,
  unansweredDialogNotice,
  WORKSPACE_DIALOG_EVENT,
  type ScopeInputs,
  type SwitcherMenuEntry,
  type WorkspaceScope,
  workspaceAfterDelete,
} from './workspace-switcher-model'
import { PICKER_UNAVAILABLE } from '../editor/file-tree-picker-model'

function project(name: string, localPath: string | null): WorkspaceProject {
  return {
    id: `example.com/team/${name.toLowerCase()}`,
    name,
    slug: name.toLowerCase(),
    remotes: [],
    description: null,
    localPath,
    flowPath: `/flow/workspaces/x/projects/${name.toLowerCase()}`,
  }
}

const ACME: WorkspaceListing = {
  name: 'Acme',
  slug: 'acme',
  path: '/flow/workspaces/acme',
  remote: null,
  isDefault: false,
  projects: [project('Backend', '/code/backend'), project('Frontend', '/private/var/code/frontend'), project('Docs', null)],
}
const SIDE: WorkspaceListing = {
  name: 'Side',
  slug: 'side',
  path: '/flow/workspaces/side',
  remote: null,
  isDefault: false,
  projects: [project('Toy', '/code/toy')],
}

const MEMBERSHIP = new Map<string, string | null>([
  ['/code/backend', 'acme'],
  ['/var/code/frontend', 'acme'],
  ['/code/toy', 'side'],
  ['/code/loose', null],
])

function inputs(overrides: Partial<ScopeInputs> = {}): ScopeInputs {
  return {
    workspaces: [ACME, SIDE],
    currentSlug: null,
    membership: MEMBERSHIP,
    activeRoot: null,
    choice: null,
    ...overrides,
  }
}

const DEFAULT: WorkspaceListing = {
  name: 'Default',
  slug: 'default',
  path: '/flow/workspaces/default',
  remote: null,
  isDefault: true,
  projects: [],
}

describe('deriveScope', () => {
  it('follows the person’s choice first', () => {
    expect(deriveScope(inputs({ choice: { kind: 'workspace', slug: 'side' }, activeRoot: '/code/backend' }))).toEqual({
      kind: 'workspace',
      slug: 'side',
      name: 'Side',
    })
  })

  it('falls through a choice of a Workspace that is gone', () => {
    expect(deriveScope(inputs({ choice: { kind: 'workspace', slug: 'gone' }, activeRoot: '/code/backend' }))).toEqual({
      kind: 'workspace',
      slug: 'acme',
      name: 'Acme',
    })
  })

  it('without a choice, the active project decides', () => {
    expect(deriveScope(inputs({ activeRoot: '/code/backend' }))).toMatchObject({ kind: 'workspace', slug: 'acme' })
  })

  it('a project in no Workspace never puts you "outside": the current, then Default, then the first', () => {
    expect(deriveScope(inputs({ activeRoot: '/code/loose', currentSlug: 'side' }))).toMatchObject({ slug: 'side' })
    expect(deriveScope(inputs({ activeRoot: '/code/loose', workspaces: [ACME, DEFAULT] }))).toMatchObject({ slug: 'default' })
    expect(deriveScope(inputs({ activeRoot: '/code/loose' }))).toMatchObject({ slug: 'acme' })
  })

  it('is "none" only while no Workspace exists on this computer', () => {
    expect(deriveScope(inputs({ workspaces: [] }))).toEqual({ kind: 'none' })
  })
})

describe('choiceForRoot', () => {
  it('is null while the root is in no Workspace, or unknown', () => {
    expect(choiceForRoot('/code/new', MEMBERSHIP)).toBeNull()
    expect(choiceForRoot('/code/loose', MEMBERSHIP)).toBeNull()
    expect(choiceForRoot('/code/toy', MEMBERSHIP)).toEqual({ kind: 'workspace', slug: 'side' })
  })
})

describe('rootInScope / rootsInScope', () => {
  const acme = { kind: 'workspace', slug: 'acme', name: 'Acme' } as const
  it('draws the Workspace’s projects, never another Workspace’s', () => {
    expect(rootInScope('/code/backend', acme, MEMBERSHIP)).toBe(true)
    expect(rootInScope('/code/toy', acme, MEMBERSHIP)).toBe(false)
  })

  it('never hides a project in no Workspace (or not known yet): it shows in the open one', () => {
    expect(rootInScope('/code/loose', acme, MEMBERSHIP)).toBe(true)
    expect(rootInScope('/code/new', acme, MEMBERSHIP)).toBe(true)
  })

  it('draws everything while no Workspace exists yet', () => {
    expect(rootInScope('/code/toy', { kind: 'none' }, MEMBERSHIP)).toBe(true)
  })

  it('keeps the given order', () => {
    expect(rootsInScope(['/code/toy', '/var/code/frontend', '/code/backend'], acme, MEMBERSHIP)).toEqual([
      '/var/code/frontend',
      '/code/backend',
    ])
  })
})

describe('sameScope / sameMembership', () => {
  it('compares by value', () => {
    expect(sameScope({ kind: 'workspace', slug: 'a', name: 'A' }, { kind: 'workspace', slug: 'a', name: 'A' })).toBe(true)
    expect(sameScope({ kind: 'workspace', slug: 'a', name: 'A' }, { kind: 'workspace', slug: 'b', name: 'B' })).toBe(false)
    expect(sameScope({ kind: 'none' }, { kind: 'none' })).toBe(true)
    expect(sameMembership(new Map(MEMBERSHIP), MEMBERSHIP)).toBe(true)
    expect(sameMembership(new Map([...MEMBERSHIP, ['/code/loose', 'side']]), MEMBERSHIP)).toBe(false)
  })
})

describe('project names', () => {
  it('reads a checkout under either spelling of a macOS private folder', () => {
    expect(comparablePath('/private/var/code/frontend/')).toBe('/var/code/frontend')
    expect(comparablePath('/private/tmp/x')).toBe('/tmp/x')
    expect(comparablePath('/privateer/x')).toBe('/privateer/x')
  })

  // THE REGISTRY'S ANSWER, never a path comparison: main says which Workspace
  // and which project a root is (`workspaces:membership`), and the renderer
  // only looks the name up.
  const membership = new Map<string, string | null>([
    ['/Users/me/fe-link', 'acme'],
    ['/code/loose', null],
    ['/code/backend', null],
  ])
  const projects = new Map<string, string | null>([
    ['/Users/me/fe-link', 'example.com/team/frontend'],
    ['/code/loose', null],
    ['/code/backend', null],
  ])

  it('tags a row with the Workspace’s name for the project the registry says it is, else its folder', () => {
    // A root whose path matches no listing path is still Frontend: the registry said so.
    expect(projectTag('/Users/me/fe-link', membership, projects, [ACME])).toBe('Frontend')
    expect(projectTag('/code/loose', membership, projects, [ACME])).toBe('loose')
    // …and a root whose path happens to equal a listing's is NOT re-derived.
    expect(projectTag('/code/backend', membership, projects, [ACME])).toBe('backend')
    expect(memberOf('/Users/me/fe-link', membership, projects, [ACME])?.workspace.slug).toBe('acme')
    expect(memberOf('/code/backend', membership, projects, [ACME])).toBeNull()
  })

  it('finds the app’s own root for a Workspace project by the registry’s answer', () => {
    const registered = ['/code/loose', '/Users/me/fe-link']
    expect(registeredRootOf('acme', 'example.com/team/frontend', registered, membership, projects)).toBe('/Users/me/fe-link')
    expect(registeredRootOf('acme', 'example.com/team/backend', registered, membership, projects)).toBeNull()
  })
})

describe('the new thread’s project', () => {
  it('remembers the last project per Workspace, defensively', () => {
    expect(parseLastProjects(null)).toEqual({})
    expect(parseLastProjects('not json')).toEqual({})
    expect(parseLastProjects('["a"]')).toEqual({})
    expect(parseLastProjects('{"acme":"/code/backend","bad":3}')).toEqual({ acme: '/code/backend' })
    const before = { side: '/code/toy' }
    const after = rememberLastProject(before, 'acme', '/code/backend')
    expect(after).toEqual({ side: '/code/toy', acme: '/code/backend' })
    expect(before).toEqual({ side: '/code/toy' })
  })

  it('defaults to the last used, then the active one, then the first available', () => {
    const base = {
      scopeRoots: ['/code/backend', '/var/code/frontend'],
      available: (root: string) => root !== '/code/gone',
    }
    expect(defaultNewThreadProject({ ...base, lastUsed: '/var/code/frontend', activeRoot: '/code/backend' })).toBe(
      '/var/code/frontend',
    )
    expect(defaultNewThreadProject({ ...base, lastUsed: '/code/elsewhere', activeRoot: '/code/backend' })).toBe(
      '/code/backend',
    )
    expect(defaultNewThreadProject({ ...base, lastUsed: null, activeRoot: null })).toBe('/code/backend')
    expect(
      defaultNewThreadProject({ scopeRoots: ['/code/gone'], available: base.available, lastUsed: '/code/gone', activeRoot: null }),
    ).toBeNull()
  })
})

describe('syncStatusText', () => {
  it('says each sync state in plain words', () => {
    expect(syncStatusText({ state: 'synced' })).toBe('Up to date')
    expect(syncStatusText({ state: 'syncing' })).toBe('Syncing')
    expect(syncStatusText({ state: 'paused' })).toBe('Sync paused — needs you')
    expect(syncStatusText({ state: 'offline' })).toBe('Offline — saving here')
    expect(syncStatusText({ state: 'error' })).toBe('Sync failed')
    expect(syncStatusText({ state: 'local-only' })).toBe('Kept on this machine')
  })

  it('idle is not a claim: it never says "Up to date" (idle is also the state after a retry is armed)', () => {
    // Positive first: synced does say it.
    expect(syncStatusText({ state: 'synced' })).toBe('Up to date')
    expect(syncStatusText({ state: 'idle' })).not.toBe('Up to date')
  })

  it('a project that cannot be reached here says so in words', () => {
    expect(UNAVAILABLE_TAG).toBe('Not available on this computer')
    expect(PICKER_UNAVAILABLE).toBe(UNAVAILABLE_TAG)
  })

  it('no access: the engine’s own sentence, or a plain fallback', () => {
    expect(syncStatusText({ state: 'no-access', detail: "Flow can't reach Acme's shared repository with your access." })).toBe(
      "Flow can't reach Acme's shared repository with your access.",
    )
    expect(syncStatusText({ state: 'no-access', detail: null })).toBe('No access to the shared repository')
  })

  it('shows nothing it does not recognise', () => {
    expect(syncStatusText(undefined)).toBeNull()
    expect(syncStatusText({ state: 'disabled' })).toBeNull()
    expect(syncStatusText({ state: 42 })).toBeNull()
  })
})

describe('switcherMenu', () => {
  const registered = [
    { rootPath: '/code/backend', available: true },
    { rootPath: '/var/code/frontend', available: true },
    { rootPath: '/code/loose', available: true },
  ]
  const placement: WorkspacePlacementState = {
    migrating: false,
    issues: [
      {
        kind: 'pending',
        root: '/code/loose',
        name: 'loose',
        workspace: 'default',
        workspaceName: 'Default',
        commit: { message: 'chore: move knowledge', files: 3, from: 'flow', to: 'flow.pre-workspace' },
        problem: null,
      },
    ],
  }
  const menu = (scope: WorkspaceScope, extra: Partial<Parameters<typeof switcherMenu>[0]> = {}): SwitcherMenuEntry[] =>
    switcherMenu({
      workspaces: [ACME, SIDE],
      scope,
      registered,
      membership: MEMBERSHIP,
      activeRoot: '/code/backend',
      syncStatus: new Map([['acme', { state: 'synced' }]]),
      placement,
      label: (root) => root.split('/').pop() ?? root,
      ...extra,
    })

  it('lists every Workspace, then what needs attention, then the actions — never "projects outside a Workspace"', () => {
    const entries = menu({ kind: 'workspace', slug: 'acme', name: 'Acme' })
    expect(entries.map((entry) => entry.kind)).toEqual([
      'workspace',
      'workspace',
      'heading',
      'attention',
      'action',
    ])
    expect(entries[2]).toEqual({ kind: 'heading', text: NEEDS_ATTENTION_HEADING })
    expect(entries[3]).toEqual({
      kind: 'attention',
      root: '/code/loose',
      label: 'loose',
      text: pendingAttentionText('Default'),
      action: 'move-in',
    })
    // New / Join live as icons on the open Workspace's row (user, 2026-10-06);
    // the one row left is "Add project…".
    expect(entries.slice(-1).map((entry) => (entry.kind === 'action' ? entry.label : ''))).toEqual([OPEN_PROJECT_LABEL])
    expect(OPEN_PROJECT_LABEL).toBe('Add project…')
    expect(entries[0]).toMatchObject({ kind: 'workspace', active: true, actions: ['rename', 'delete', 'new', 'join'] })
    // With no Workspace open the rows are the only way in, so they stay.
    const none = menu({ kind: 'none' })
    expect(none.filter((entry) => entry.kind === 'action').map((entry) => (entry.kind === 'action' ? entry.label : ''))).toEqual([
      NEW_WORKSPACE_LABEL,
      JOIN_WORKSPACE_LABEL,
      OPEN_PROJECT_LABEL,
    ])
    expect(JSON.stringify(entries)).not.toMatch(/outside/i)
  })

  it('lists the current Workspace’s projects, with why one cannot be used here and whether it can move', () => {
    const [acme, side] = menu({ kind: 'workspace', slug: 'acme', name: 'Acme' })
    // The open Workspace lists its projects right below, so its line carries only the sync status.
    expect(acme).toMatchObject({ kind: 'workspace', active: true, detail: 'Up to date' })
    // A Workspace kept on this machine is the ordinary case, not news: the menu
    // row says nothing then (user, 2026-10-06).
    const local = switcherMenu({
      workspaces: [{ ...ACME }],
      scope: { kind: 'workspace', slug: ACME.slug, name: ACME.name },
      registered: [],
      membership: new Map(),
      activeRoot: null,
      label: (root) => root,
      syncStatus: new Map([[ACME.slug, { state: 'local-only' }]]),
    })
    expect(local[0]).toMatchObject({ kind: 'workspace', active: true, detail: '' })
    if (acme.kind !== 'workspace' || side.kind !== 'workspace') throw new Error('expected Workspaces')
    expect(acme.projects).toEqual([
      { id: 'example.com/team/backend', name: 'Backend', root: '/code/backend', note: null, canMove: true, slot: 0 },
      // The checkout was recorded under /private; the app has it under /var.
      { id: 'example.com/team/frontend', name: 'Frontend', root: '/var/code/frontend', note: null, canMove: true, slot: 1 },
      { id: 'example.com/team/docs', name: 'Docs', root: null, note: NOT_ON_THIS_MACHINE, canMove: true, slot: 2 },
    ])
    expect(side).toMatchObject({ active: false, detail: 'Toy', projects: [], actions: [] })
  })

  it('offers Rename and Delete on the current Workspace — never Delete on Default', () => {
    const [acme] = menu({ kind: 'workspace', slug: 'acme', name: 'Acme' })
    expect(acme).toMatchObject({ actions: ['rename', 'delete', 'new', 'join'] })
    const [fallback] = menu({ kind: 'workspace', slug: 'default', name: 'Default' }, { workspaces: [DEFAULT, ACME] })
    expect(fallback).toMatchObject({ isDefault: true, actions: ['rename', 'new', 'join'] })
  })

  it('a project cannot move when there is nowhere to move it', () => {
    const [only] = menu({ kind: 'workspace', slug: 'acme', name: 'Acme' }, { workspaces: [ACME] })
    if (only.kind !== 'workspace') throw new Error('expected a Workspace')
    expect(only.projects.every((entry) => !entry.canMove)).toBe(true)
  })

  it('says when a project is in the Workspace but not open in the app', () => {
    const entries = switcherMenu({
      workspaces: [SIDE],
      scope: { kind: 'workspace', slug: 'side', name: 'Side' },
      registered: [],
      membership: new Map(),
      activeRoot: null,
      label: (root) => root,
    })
    expect(entries[0]).toMatchObject({ projects: [{ name: 'Toy', root: null, note: NOT_OPEN_HERE }] })
  })

  it('says when a project is open in the app but its folder is gone (#974)', () => {
    const at = (available: boolean) =>
      switcherMenu({
        workspaces: [SIDE],
        scope: { kind: 'workspace', slug: 'side', name: 'Side' },
        registered: [{ rootPath: '/code/toy', available }],
        membership: MEMBERSHIP,
        activeRoot: null,
        label: (root) => root,
      })
    expect(at(false)[0]).toMatchObject({ projects: [{ name: 'Toy', root: '/code/toy', note: UNAVAILABLE_TAG }] })
    expect(at(true)[0]).toMatchObject({ projects: [{ name: 'Toy', root: '/code/toy', note: null }] })
  })

  it('says the Workspace is being set up while the first migration runs', () => {
    const entries = menu({ kind: 'none' }, { workspaces: [], placement: { migrating: true, issues: [] } })
    expect(entries[0]).toEqual({ kind: 'note', text: SETTING_UP_LINE })
  })

  it('folds a long project list', () => {
    const many: WorkspaceListing = {
      ...SIDE,
      projects: ['A', 'B', 'C', 'D', 'E'].map((name) => project(name, null)),
    }
    const [entry] = switcherMenu({
      workspaces: [many],
      scope: { kind: 'none' },
      registered: [],
      membership: new Map(),
      activeRoot: null,
      label: (root) => root,
    })
    expect(entry).toMatchObject({ detail: 'A, B, C and 2 more' })
  })
})

describe('needs attention', () => {
  it('a failed project says its own reason, and offers to try again', () => {
    expect(
      attentionEntries({ migrating: false, issues: [{ kind: 'failed', root: '/code/x', name: 'x', reason: 'x could not move.' }] }, () => 'x'),
    ).toEqual([{ root: '/code/x', label: 'x', text: 'x could not move.', action: 'retry' }])
    expect(
      attentionEntries({ migrating: false, issues: [{ kind: 'failed', root: '/code/x', name: 'x', reason: ' ' }] }, () => 'x')[0]?.text,
    ).toBe(FAILED_ATTENTION_TEXT)
    expect(attentionEntries(null, () => '')).toEqual([])
  })

  it('a waiting project whose move stopped keeps "Move it in" and says why', () => {
    const [entry] = attentionEntries(
      {
        migrating: false,
        issues: [
          {
            kind: 'pending',
            root: '/code/m',
            name: 'm',
            workspace: 'default',
            workspaceName: 'Default',
            commit: { message: 'x', files: 1, from: 'flow', to: 'y' },
            problem: "Some knowledge files in m have changes that aren't committed yet. Commit them first, then move it in.",
          },
        ],
      },
      () => 'm',
    )
    expect(entry).toMatchObject({ action: 'move-in', text: expect.stringContaining("aren't committed yet") })
  })
})

describe('after a delete, and where a project can move', () => {
  it('lands on Default, else the first one left', () => {
    expect(workspaceAfterDelete([ACME, DEFAULT, SIDE], 'acme')).toBe('default')
    expect(workspaceAfterDelete([ACME, SIDE], 'acme')).toBe('side')
    expect(workspaceAfterDelete([ACME], 'acme')).toBeNull()
  })

  it('a project moves to any Workspace but its own', () => {
    expect(moveTargets([ACME, SIDE, DEFAULT], 'acme')).toEqual([
      { slug: 'side', name: 'Side' },
      { slug: 'default', name: 'Default' },
    ])
  })
})

describe('the switcher button', () => {
  it('names the Workspace, or says there is none yet', () => {
    expect(switcherLabel({ kind: 'workspace', slug: 'acme', name: 'Acme' })).toBe('Acme')
    expect(switcherLabel({ kind: 'none' })).toBe(NO_WORKSPACE_LABEL)
    expect(switcherLabel({ kind: 'none' }, true)).toBe(SETTING_UP_LINE)
  })

  it('hovers with the projects and the sync status', () => {
    expect(
      switcherTitle({ kind: 'workspace', slug: 'acme', name: 'Acme' }, [ACME], new Map([['acme', { state: 'paused' }]])),
    ).toBe('Acme — Backend, Frontend, Docs\nSync paused — needs you')
    expect(switcherTitle({ kind: 'none' }, [ACME])).toBe('')
  })

  it('has its own empty-list line for a Workspace', () => {
    const scope = { kind: 'workspace', slug: 'acme', name: 'Acme' } as const
    expect(emptyWorkspaceMessage(scope, true)).toBe('No threads in Acme yet')
    expect(emptyWorkspaceMessage(scope, false)).toBe("None of Acme's projects are open in Flow yet")
    expect(emptyWorkspaceMessage({ kind: 'none' }, true)).toBeNull()
  })
})

describe('every string a person reads', () => {
  const strings = [
    NEEDS_ATTENTION_HEADING,
    SETTING_UP_LINE,
    NO_WORKSPACE_LABEL,
    NEW_WORKSPACE_LABEL,
    JOIN_WORKSPACE_LABEL,
    OPEN_PROJECT_LABEL,
    RENAME_WORKSPACE_LABEL,
    DELETE_WORKSPACE_LABEL,
    MOVE_PROJECT_LABEL,
    FAILED_ATTENTION_TEXT,
    pendingAttentionText('Default'),
    moveProjectLabel('Backend'),
    NOT_ON_THIS_MACHINE,
    NOT_OPEN_HERE,
    ...['idle', 'syncing', 'synced', 'paused', 'offline', 'error', 'local-only'].map(
      (state) => syncStatusText({ state }) ?? '',
    ),
    emptyWorkspaceMessage({ kind: 'workspace', slug: 'a', name: 'A' }, true) ?? '',
    emptyWorkspaceMessage({ kind: 'workspace', slug: 'a', name: 'A' }, false) ?? '',
  ]

  it('carries no command, path, setting name or emoji (forbidden-pattern #12)', () => {
    for (const text of strings) {
      expect(text).not.toMatch(/planflow-ai|\bflow\/|\.flowconfig|workspaces_enabled|\/[a-z]+\//i)
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })

  it('never uses the internal words for a thread’s checkout', () => {
    for (const text of strings) expect(text).not.toMatch(/\bworktrees?\b|\bcop(y|ies)\b/i)
  })
})

describe('the dialog seam', () => {
  it('names one event that a dialog answers by cancelling it', () => {
    expect(WORKSPACE_DIALOG_EVENT).toBe('flow:workspace-dialog')
  })
  it('tells the person in plain words while no dialog answers', () => {
    for (const kind of ['create', 'join', 'rename', 'delete', 'move-project', 'move-in', 'open-project'] as const) {
      const notice = unansweredDialogNotice(kind)
      expect(notice.title).toMatch(/Workspace/)
      expect(`${notice.title} ${notice.body}`).not.toMatch(/planflow-ai|\/|worktree|\p{Extended_Pictographic}/u)
    }
  })
})
