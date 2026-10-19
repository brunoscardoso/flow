import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  WorkspaceJoinResult,
  WorkspaceLinkResult,
  WorkspaceListing,
  WorkspaceProject,
  WorkspaceRefusal,
  WorkspaceSyncStatus,
} from '../../shared/workspaces-contract'
import {
  COMMIT_UNKNOWN_COUNT,
  DIRTY_CODE_REFUSAL,
  FIXED_STRINGS,
  KEEPS_OWN_REFUSAL,
  NOT_ON_THIS_COMPUTER,
  NOT_OPEN_IN_FLOW,
  NO_SHARED_REPOSITORY,
  DELETE_KEEPS,
  WORKSPACE_MOVE_IN_EVENT,
  commitConfirmText,
  commitFilesOf,
  deleteConfirmView,
  deletedLine,
  joinOutcome,
  mapCandidates,
  moveCandidateLabel,
  moveHereCandidates,
  movedLine,
  moveTitle,
  onboardingWorkspaceLine,
  relativeTime,
  settingsChangeAction,
  validateRename,
  JOIN_BODY,
  JOIN_CANDIDATES_LINE,
  ADD_CANDIDATES_LABEL,
  linkOutcome,
  newlyOpened,
  parseDismissed,
  projectRows,
  refusalStep,
  suggestionKey,
  suggestionText,
  syncLine,
  validateCreate,
  workspaceCard,
  createdLine,
  onboardingDoneLine,
  type OpenProject,
} from './workspace-settings-model'
import * as collision from '../threads/collision-card-model'
import { workspaceRefusalDetail } from '../../main/workspaces/workspace-registry'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const TWO_MIN_AGO = '2026-10-06T11:58:00Z'

function project(name: string, localPath: string | null, id = `example.com/team/${name}`): WorkspaceProject {
  return { id, name, slug: name, remotes: [], description: null, localPath, flowPath: `/home/flow/workspaces/acme/projects/${name}` }
}

const ACME: WorkspaceListing = {
  name: 'Acme',
  slug: 'acme',
  path: '/home/me/flowhome/workspaces/acme',
  remote: 'https://git.example.com/acme/knowledge.git',
  isDefault: false,
  projects: [project('backend', '/code/backend'), project('frontend', '/code/frontend'), project('mobile', null)],
}

const DEFAULT: WorkspaceListing = {
  name: 'Default',
  slug: 'default',
  path: '/home/me/flowhome/workspaces/default',
  remote: null,
  isDefault: true,
  projects: [project('docs', '/code/docs')],
}

const OPEN: OpenProject[] = [
  { rootPath: '/code/backend', label: 'backend', workspace: 'acme' },
  { rootPath: '/code/docs', label: 'docs', workspace: 'default' },
  { rootPath: '/code/loose', label: 'loose', workspace: null },
]

function status(partial: Partial<WorkspaceSyncStatus>): WorkspaceSyncStatus {
  return { state: 'idle', lastSyncedAt: null, detail: null, asks: [], reviews: [], ...partial }
}

function refusal(reason: WorkspaceRefusal['reason'], payload: Record<string, unknown> = {}): WorkspaceRefusal {
  return { ok: false, reason, detail: 'Main’s own sentence for this.', payload }
}

function linked(previous: WorkspaceLinkResult['previous']): { ok: true } & WorkspaceLinkResult {
  const { projects: _projects, ...summary } = ACME
  return {
    ok: true,
    workspace: summary,
    project: project('loose', '/code/loose'),
    link: 'created',
    previous,
    projectAdded: true,
    commit: null,
  }
}

describe('there is no on/off switch', () => {
  it('nothing in the settings words offers one', () => {
    expect(FIXED_STRINGS.join(' ')).not.toMatch(/Use Workspaces|turn(ed)? (on|off)|Projects outside a Workspace/i)
  })
})

describe('the Flow folder block is gone — the Workspace cards say where things live', () => {
  it('no fixed string names the Flow folder or its move', () => {
    expect(FIXED_STRINGS.join(' ')).not.toMatch(/Flow folder|not supported yet/i)
  })
})

describe('sync lines', () => {
  it('reads every state', () => {
    expect(syncLine(status({ state: 'synced', lastSyncedAt: TWO_MIN_AGO }), NOW).text).toBe('Synced 2 minutes ago')
    expect(syncLine(status({ state: 'synced' }), NOW).text).toBe('Up to date')
    expect(syncLine(status({ state: 'idle', lastSyncedAt: TWO_MIN_AGO }), NOW).text).toBe('Last synced 2 minutes ago')
    expect(syncLine(status({ state: 'idle' }), NOW).text).toBe('Not synced yet')
    expect(syncLine(status({ state: 'offline' }), NOW)).toMatchObject({ text: 'Offline — will retry', tone: 'warning' })
    expect(syncLine(status({ state: 'local-only' }), NOW)).toMatchObject({ canSyncNow: false })
    expect(syncLine(status({ state: 'error', detail: 'The shared repository refused the sign-in.' }), NOW).text).toBe(
      'The shared repository refused the sign-in.',
    )
    expect(syncLine(status({ state: 'no-access' }), NOW)).toMatchObject({ tone: 'error', canSyncNow: true })
    expect(syncLine(null, NOW).text).toBe('Not read yet')
  })
  it('a pause counts what needs the person and marks the way in', () => {
    const paused = syncLine(
      status({
        state: 'paused',
        asks: [{ id: 'a', kind: 'decision', topic: 't', path: 'p', existingPath: 'p', existing: null, incoming: null, merged: null, truncated: false, options: ['ours'] }],
      }),
      NOW,
    )
    expect(paused).toMatchObject({ text: 'Paused — 1 change needs you', paused: true, tone: 'warning' })
  })
  it('a running sync cannot be started twice', () => {
    expect(syncLine(status({ state: 'synced' }), NOW, true)).toMatchObject({ text: 'Syncing…', canSyncNow: false })
  })
})

describe('a Workspace card', () => {
  it('names each project and says where it is', () => {
    const rows = projectRows(ACME, OPEN, true)
    expect(rows.map((row) => [row.name, row.note, row.canOpenSettings, row.canMapSameProject, row.canMove])).toEqual([
      ['backend', null, true, false, true],
      ['frontend', NOT_OPEN_IN_FLOW, false, false, true],
      ['mobile', NOT_ON_THIS_COMPUTER, false, true, true],
    ])
    expect(rows[0]?.root).toBe('/code/backend')
  })
  it('matches a checkout across the macOS private prefix', () => {
    const tmpWorkspace = { ...ACME, projects: [project('tmp', '/private/var/folders/x/tmp')] }
    const rows = projectRows(tmpWorkspace, [{ rootPath: '/var/folders/x/tmp/', label: 'tmp', workspace: 'acme' }])
    expect(rows[0]).toMatchObject({ root: '/var/folders/x/tmp/', note: null, canOpenSettings: true })
  })
  it('"Move a project here" offers the projects of every OTHER Workspace, named with where they are now', () => {
    expect(moveHereCandidates([ACME, DEFAULT], 'acme')).toEqual([
      { projectId: 'example.com/team/docs', from: 'default', label: moveCandidateLabel('docs', 'Default') },
    ])
    expect(moveCandidateLabel('docs', 'Default')).toBe('docs — in Default')
    expect(moveHereCandidates([ACME], 'acme')).toEqual([])
  })
  it('"It is on this computer" offers the open projects that are not already this Workspace\'s', () => {
    expect(mapCandidates(OPEN, 'acme')).toEqual([
      { root: '/code/docs', label: 'docs' },
      { root: '/code/loose', label: 'loose' },
    ])
  })
  it('Default is marked and can\'t be deleted; another Workspace can', () => {
    expect(workspaceCard({ workspace: DEFAULT, open: OPEN, sync: null, now: NOW, all: [ACME, DEFAULT] })).toMatchObject({
      isDefault: true,
      canDelete: false,
    })
    const acme = workspaceCard({ workspace: ACME, open: OPEN, sync: null, now: NOW, all: [ACME, DEFAULT] })
    expect(acme).toMatchObject({ isDefault: false, canDelete: true })
    expect(acme.projects.every((row) => row.canMove)).toBe(true)
    // With one Workspace there is nowhere to move a project to.
    expect(workspaceCard({ workspace: ACME, open: OPEN, sync: null, now: NOW }).projects.some((row) => row.canMove)).toBe(false)
  })
  it('shows the shared repository as typed, or says there is none', () => {
    expect(workspaceCard({ workspace: ACME, open: OPEN, sync: null, now: NOW })).toMatchObject({
      remoteText: 'https://git.example.com/acme/knowledge.git',
      hasRemote: true,
    })
    expect(workspaceCard({ workspace: { ...ACME, remote: null }, open: OPEN, sync: null, now: NOW }).remoteText).toBe(NO_SHARED_REPOSITORY)
  })
})

describe('adding a project', () => {
  it('says it is added, and that earlier knowledge was kept', () => {
    expect(linkOutcome(linked({ kind: 'none' }), 'loose')).toEqual({ kind: 'done', text: 'loose is now part of Acme.' })
    expect(linkOutcome(linked({ kind: 'folder', keptAt: '/code/loose/flow.pre' }), 'loose').text).toBe(
      'loose is now part of Acme. Its knowledge came along; the old copy is kept as a backup.',
    )
  })
  it('asks before the one commit of a committed knowledge folder, with its size', () => {
    const payload = { commit: { message: 'chore: keep the old knowledge aside', files: 12, from: 'flow', to: 'flow.pre-workspace' }, needs: 'confirm-commit' }
    expect(commitFilesOf(payload)).toBe(12)
    const step = linkOutcome(refusal('committed-flow', payload), 'plan')
    expect(step.kind).toBe('confirm-commit')
    expect(step.text).toBe(commitConfirmText(12, 'chore: keep the old knowledge aside'))
    // The person sees the commit the CLI will actually write, not only its size.
    expect(step.text).toContain('“chore: keep the old knowledge aside”')
    expect(step.text).toContain('one commit of 12 files; review before continuing')
    expect(commitConfirmText(1)).toContain('one commit of 1 file;')
    expect(refusalStep(refusal('committed-flow', {})).text).toBe(COMMIT_UNKNOWN_COUNT)
  })
  it('a project with its own knowledge repository is told its knowledge comes along — no per-project settings to send it to', () => {
    expect(refusalStep(refusal('keeps-own-knowledge-repo'))).toEqual({ kind: 'refused', text: KEEPS_OWN_REFUSAL })
    expect(KEEPS_OWN_REFUSAL).not.toMatch(/Knowledge sync settings/)
  })
  it('explains uncommitted changes, and relays main’s sentence otherwise', () => {
    expect(refusalStep(refusal('dirty-code')).text).toBe(DIRTY_CODE_REFUSAL)
    // Named when the project is known — and no path.
    expect(linkOutcome(refusal('dirty-code'), 'storefront-mobile').text).toBe(
      "Some knowledge files in storefront-mobile have changes that aren't committed yet. Commit them first, then move it in.",
    )
    expect(refusalStep(refusal('unknown-workspace')).text).toBe('Main’s own sentence for this.')
  })
})

describe('creating and joining', () => {
  it('needs a name; the shared repository is optional', () => {
    expect(validateCreate('  ', '')).toEqual({ ok: false, message: 'Give the Workspace a name.' })
    expect(validateCreate(' Acme ', '  ')).toEqual({ ok: true, name: 'Acme', remote: null })
    expect(validateCreate('Acme', ' git@example.com:a/b.git ')).toEqual({ ok: true, name: 'Acme', remote: 'git@example.com:a/b.git' })
  })
  it('a join reports what linked, what is not here, and what needs the person', () => {
    const { projects: _p, ...summary } = ACME
    const result: WorkspaceJoinResult = {
      workspace: summary,
      linked: [project('backend', '/code/backend')],
      noLocalCheckout: [project('mobile', null)],
      needsReview: [
        { ...project('plan', '/code/plan'), refusal: { refused: 'committed-flow', commit: { files: 3 } } },
        { ...project('secret', '/code/secret'), refusal: { refused: 'keeps-own-knowledge-repo' } },
      ],
      candidates: [],
      openCandidates: [],
    }
    const view = joinOutcome(result)
    expect(view.headline).toBe('Joined Acme.')
    expect(view.lines).toEqual([
      'Linked on this computer: backend.',
      'Not on this computer: mobile. When you open one in Flow, Flow asks whether to add it.',
      'Needs you first: plan, secret.',
    ])
    expect(view.candidates).toEqual([])
    expect(view.needsReview.map((entry) => [entry.name, entry.canConfirm])).toEqual([
      ['plan', true],
      ['secret', false],
    ])
    expect(view.needsReview[0]?.text).toBe(commitConfirmText(3))
  })
})

describe('a join\'s open-project candidates', () => {
  it('are proposed, never linked: listed unticked, with the press that adds them', () => {
    const { projects: _p, ...summary } = ACME
    const view = joinOutcome({
      workspace: summary,
      linked: [],
      noLocalCheckout: [project('mobile', null)],
      needsReview: [],
      candidates: [],
      openCandidates: [{ root: '/Users/me/web', project: project('web', '/Users/me/web') }],
    })
    expect(view.candidates).toEqual([{ root: '/Users/me/web', name: 'web', projectId: 'example.com/team/web', checked: false }])
    expect(view.lines).toContain(JOIN_CANDIDATES_LINE)
    expect(ADD_CANDIDATES_LABEL).toBe('Add these projects')
    // Nothing claims they were linked.
    expect(view.lines.join(' ')).not.toMatch(/linked|link up/i)
  })

  it('the Join dialog promises no linking it does not do', () => {
    expect(JOIN_BODY).not.toMatch(/on their own|automatically/i)
  })
})

describe('rename, delete, move', () => {
  it('a rename needs a new, non-blank name', () => {
    expect(validateRename('  ', 'Acme')).toEqual({ ok: false, message: 'Give the Workspace a name.' })
    expect(validateRename('Acme', 'Acme')).toMatchObject({ ok: false })
    expect(validateRename(' Acme Corp ', 'Acme')).toEqual({ ok: true, name: 'Acme Corp' })
  })
  it('a delete lists the projects that move to Default, and says the shared copy online stays', () => {
    expect(deleteConfirmView(ACME, 'Default')).toEqual({
      title: 'Delete Acme?',
      lines: ['Its 3 projects move to Default: backend, frontend, mobile.', DELETE_KEEPS],
      confirm: 'Delete Workspace',
    })
    expect(deleteConfirmView({ ...ACME, projects: [project('api', null)] }, 'Default').lines[0]).toBe('Its project moves to Default: api.')
    expect(deleteConfirmView({ ...ACME, projects: [] }, 'Default').lines[0]).toBe('It has no projects.')
    expect(DELETE_KEEPS).toMatch(/shared copy online is not deleted/)
    expect(deletedLine('Acme', 'Default')).toBe('Acme was deleted. Its projects are in Default now.')
  })
  it('a move names the project and where it went', () => {
    expect(moveTitle('backend')).toBe('Move backend to…')
    expect(movedLine('backend', 'Default')).toBe('backend is now in Default.')
  })
  it('"Move it in" listens on the event main names', () => {
    expect(WORKSPACE_MOVE_IN_EVENT).toBe('flow:workspace-move-in')
  })
})

describe('onboarding', () => {
  it('names the Workspace the projects are in', () => {
    expect(onboardingWorkspaceLine('Default')).toBe('Your projects are in Default.')
  })
})

describe('relative times', () => {
  it('says them in words', () => {
    expect(relativeTime('2026-10-06T11:59:50Z', NOW)).toBe('just now')
    expect(relativeTime('2026-10-06T11:00:00Z', NOW)).toBe('an hour ago')
    expect(relativeTime('garbage', NOW)).toBe('a while ago')
  })
})

describe('one table of refusal sentences', () => {
  it('the settings say exactly what main says for the same refusal', () => {
    for (const reason of ['keeps-own-knowledge-repo', 'dirty-code', 'linked-elsewhere'] as const) {
      expect(refusalStep(refusal(reason)).text).toBe(workspaceRefusalDetail(reason))
    }
  })
})

describe('when the Workspaces settings re-read', () => {
  it('re-reads on a change that alters what it shows — only while on screen; otherwise when next shown', () => {
    // Positive first: a real change on screen re-reads.
    expect(settingsChangeAction({ cause: 'joined', onScreen: true })).toBe('reload')
    expect(settingsChangeAction({ cause: 'linked', onScreen: false })).toBe('mark-stale')
  })
  it('ignores the selection and a card\'s extra projects — nothing it draws', () => {
    expect(settingsChangeAction({ cause: 'current', onScreen: true })).toBe('ignore')
    expect(settingsChangeAction({ cause: 'task-projects', onScreen: true })).toBe('ignore')
  })
})

describe('the join suggestion', () => {
  const { projects: _p, ...summary } = ACME
  const suggestion = { kind: 'link' as const, workspace: summary, project: project('backend', '/code/backend'), via: 'remote' as const }
  it('names the project and the Workspace', () => {
    expect(suggestionText(suggestion)).toBe('This project, backend, belongs to the Acme Workspace. Add it?')
    expect(suggestionText({ kind: 'none' })).toBeNull()
  })
  it('is remembered per Workspace, project and folder once dismissed', () => {
    expect(suggestionKey('/code/backend', suggestion)).toBe('acme\u0000example.com/team/backend\u0000/code/backend')
    expect(parseDismissed('["a","b",3]')).toEqual(new Set(['a', 'b']))
    expect(parseDismissed('not json')).toEqual(new Set())
    expect(parseDismissed(null)).toEqual(new Set())
  })
  it('asks only about projects that just appeared', () => {
    expect(newlyOpened(new Set(['/a']), ['/a', '/b'])).toEqual(['/b'])
  })
})

// ── forbidden-pattern #12: the whole surface ────────────────────────────────

function everyString(): string[] {
  const out: string[] = [...FIXED_STRINGS, ...collision.FIXED_STRINGS]
  const { projects: _p, ...summary } = ACME
  for (const state of ['idle', 'syncing', 'synced', 'paused', 'offline', 'no-access', 'error', 'local-only'] as const) {
    for (const last of [null, TWO_MIN_AGO]) out.push(syncLine(status({ state, lastSyncedAt: last }), NOW).text)
  }
  out.push(syncLine(status({ state: 'paused' }), NOW).text)
  for (const files of [0, 1, 7]) out.push(commitConfirmText(files))
  for (const reason of ['committed-flow', 'keeps-own-knowledge-repo', 'dirty-code', 'linked-elsewhere'] as const) {
    out.push(refusalStep(refusal(reason, { commit: { files: 4 } })).text)
  }
  out.push(linkOutcome(linked({ kind: 'committed-folder', keptAt: '/x' }), 'loose').text)
  const card = workspaceCard({ workspace: { ...ACME, remote: null }, open: OPEN, sync: null, now: NOW })
  out.push(card.remoteText, ...card.projects.flatMap((row) => (row.note === null ? [] : [row.note])))
  const join = joinOutcome({
    workspace: summary,
    linked: [],
    noLocalCheckout: [project('mobile', null)],
    needsReview: [{ ...project('plan', '/code/plan'), refusal: { refused: 'committed-flow', commit: { files: 2 } } }],
    candidates: [],
    openCandidates: [{ root: '/code/web', project: project('web', '/code/web') }],
  })
  out.push(join.headline, ...join.lines, ...join.needsReview.map((entry) => entry.text), ADD_CANDIDATES_LABEL)
  out.push(suggestionText({ kind: 'link', workspace: summary, project: project('backend', null), via: 'remote' }) ?? '')
  out.push(createdLine('Acme'), onboardingDoneLine('Acme'), onboardingWorkspaceLine('Default'))
  const deleting = deleteConfirmView(ACME, 'Default')
  out.push(deleting.title, ...deleting.lines, deleting.confirm, deletedLine('Acme', 'Default'))
  out.push(moveTitle('backend'), movedLine('backend', 'Acme'), moveCandidateLabel('docs', 'Default'))
  out.push(collision.introLine('Acme', 1), collision.introLine('Acme', 3))
  for (const choice of collision.choicesFor(['ours', 'theirs', 'merged', 'file'], 'x')) out.push(choice.label)
  return out
}

describe('forbidden-pattern #12: nothing the Workspace surfaces say names a command, a path, a key or an internal word', () => {
  const strings = everyString()

  it('collected a real surface to scan (the positive before the absence)', () => {
    expect(strings.length).toBeGreaterThan(120)
    expect(strings).toContain('Move a project here…')
    expect(strings).toContain('Synced 2 minutes ago')
    expect(strings).toContain('Let Flow adapt it')
    expect(strings).toContain(commitConfirmText(7))
    expect(strings).toContain('Joined Acme.')
  })

  const FORBIDDEN: [string, RegExp][] = [
    ['a slash path', /[A-Za-z0-9_.~-]\/[A-Za-z0-9_.~-]|^\/|\s\/|\\/],
    ['a dotfile', /(^|\s)\.[a-z]|\.(gitignore|flowconfig|gitattributes|git)\b/i],
    ['the flow folder', /\bflow\//i],
    ['a git command', /\bgit\s+(?!sign-in|host)/i],
    ['a GitHub CLI command', /\bgh\s/],
    ['the CLI', /planflow|plan-flow/i],
    ['npm', /\bnpm\b|\bnpx\b/i],
    ['a flag', /(^|\s)--?[a-z][a-z-]*/],
    ['a URL', /https?:|www\.|:\/\/|git@/i],
    ['a backtick', /`/],
    ['a config assignment', /\b[a-z]+_[a-z_]+\b|\b[a-z_]+:\s*(true|false)\b/],
    ['an internal word', /\b(slug|symlink|projectId|payload|refus(al|ed)|CLI|IPC|JSON|ours|theirs|repo)\b/],
    ['an emoji', /\p{Extended_Pictographic}/u],
  ]

  it.each(FORBIDDEN)('contains no %s', (_what, pattern) => {
    const offenders = strings.filter((text) => pattern.test(text))
    expect(offenders).toEqual([])
  })
})

describe('the Workspace views write no copy of their own', () => {
  const files = [
    'workspace-settings-section.ts',
    'workspace-dialogs-view.ts',
    join('..', 'threads', 'collision-card.ts'),
  ]
  it.each(files)('%s assigns no literal text — every visible string is a model export', (file) => {
    const source = readFileSync(join(__dirname, file), 'utf8')
    // POSITIVE FIRST: the file does put text on screen.
    expect(source).toMatch(/textContent\s*=/)
    // Clearing a line ('') is not copy; a letter after the quote is.
    expect(source).not.toMatch(/(?<!style\.)textContent\s*=\s*['"`][A-Za-z]/)
    expect(source).not.toMatch(/(?:#button|actionButton|button|line|paragraph|#line|#pair)\(\s*['"`][A-Z]/)
    expect(source).not.toMatch(/placeholder\s*=\s*['"`][A-Za-z]/)
    expect(source).not.toMatch(/setAttribute\('aria-label',\s*['"`]/)
  })
})
