// Ask the Blueprint at Workspace level — the panel's pure models (plan
// `ask_the_blueprint_workspace`, Phase 4): qualified tags and their dedupe, a
// same-slug collision across two projects staying two things in suggestions,
// the picker and the sheet's decoration, and every sentence the panel says.

import type { AskAnswer, AskSavedThread, AskSuggestedConnection } from '../../shared/ask-contract'
import {
  askDecoration,
  askScopeLine,
  askStatusLine,
  citedProjects,
  connectionButton,
  connectionView,
  initialAskState,
  knowledgeOnlySentence,
  linkTagId,
  projectWorkspaceDecoration,
  reduceAsk,
  factsSentence,
  savedSentence,
  tagFromId,
  tagsFromOpen,
  type AskPanelEvent,
  type AskPanelState,
  type AskScope,
  type AskTag,
  type AskTurn,
  type WorkspaceDrawnCell,
} from './ask-panel-model'
import { savedSectionView } from './ask-saved-model'
import { activeMention, graphCandidates, pickerMatches, suggestTags, workspaceCandidates, type SuggestNode } from './ask-tag-suggest'

const WORKSPACE: AskScope = {
  kind: 'workspace',
  workspace: 'team',
  name: 'Team',
  projects: [
    { slug: 'backend', name: 'Backend' },
    { slug: 'frontend', name: 'Frontend' },
    { slug: 'mobile', name: 'Mobile' },
  ],
}
const nameOf = (slug: string): string => WORKSPACE.kind === 'workspace' ? (WORKSPACE.projects.find((p) => p.slug === slug)?.name ?? slug) : slug

// The same slug, `chats`, in two projects — the collision the plan calls out.
const CHATS_FRONT: AskTag = { id: 'feature:frontend::chats', kind: 'feature', label: 'Chats', project: 'frontend' }
const CHATS_MOBILE: AskTag = { id: 'feature:mobile::chats', kind: 'feature', label: 'Chats', project: 'mobile' }
const PROJECT_BACKEND: AskTag = { id: 'project:backend', kind: 'project', label: 'Backend', project: 'backend' }

function run(events: AskPanelEvent[], from: AskPanelState = initialAskState()): AskPanelState {
  return events.reduce(reduceAsk, from)
}

function answer(patch: Partial<AskAnswer> = {}): AskAnswer {
  return { explanation: 'It does.', confidence: 'checked', thin: false, sources: [], factsLearned: 0, factsSaved: true, partial: false, ...patch }
}

function turn(patch: Partial<AskTurn> = {}): AskTurn {
  return {
    askId: 'ask-1',
    question: 'q',
    tags: [],
    phase: 'done',
    answer: answer(),
    firstExplanation: null,
    changedFromFirst: false,
    steps: [],
    reads: 0,
    digElapsedMs: 0,
    startedAt: 0,
    answeredAfterMs: 4000,
    error: null,
    stopping: false,
    saved: null,
    ...patch,
  }
}

const open = (tags: AskTag[] = []): AskPanelState => run([{ type: 'open', scope: WORKSPACE, tags, text: tags.length > 0 ? 'q' : undefined }])

describe('qualified tags', () => {
  it('two projects with the same slug are two tags; the same tag twice is one', () => {
    const state = run(
      [
        { type: 'add-tag', tag: CHATS_FRONT },
        { type: 'add-tag', tag: CHATS_MOBILE },
        { type: 'add-tag', tag: { ...CHATS_FRONT } },
      ],
      open(),
    )
    expect(state.tags.map((t) => t.id)).toEqual(['feature:frontend::chats', 'feature:mobile::chats'])
    expect(run([{ type: 'remove-tag', id: CHATS_FRONT.id }], state).tags.map((t) => t.id)).toEqual(['feature:mobile::chats'])
  })

  it('an opener with duplicate tags opens one chip each, and an unqualified opener tag is qualified by its project', () => {
    const state = run([{ type: 'open', scope: WORKSPACE, text: 'q', tags: [CHATS_FRONT, { ...CHATS_FRONT }, CHATS_MOBILE] }])
    expect(state.tags).toHaveLength(2)
    const tags = tagsFromOpen([{ id: 'feature:chats', kind: 'feature', project: 'mobile' }], undefined, undefined, WORKSPACE)
    expect(tags).toEqual([{ id: 'feature:mobile::chats', kind: 'feature', label: 'Chats', project: 'mobile' }])
    // On a project board the same opener is left alone (project scope unchanged).
    expect(tagsFromOpen([{ id: 'feature:chats', kind: 'feature', project: 'mobile' }])[0].id).toBe('feature:chats')
  })

  it('a suggestion already tagged is dropped, and accepting one adds the qualified chip', () => {
    const suggestion = { id: CHATS_MOBILE.id, kind: 'feature' as const, label: 'Chats', project: 'mobile' }
    const state = run(
      [
        { type: 'add-tag', tag: CHATS_FRONT },
        { type: 'suggest', suggestions: [{ ...suggestion, id: CHATS_FRONT.id, project: 'frontend' }, suggestion] },
        { type: 'accept-suggestion', id: CHATS_MOBILE.id },
      ],
      open(),
    )
    expect(state.tags.map((t) => t.id)).toEqual([CHATS_FRONT.id, CHATS_MOBILE.id])
    expect(state.suggestions).toEqual([])
  })

  it('a scope change starts over: a project\'s chips mean nothing to the Workspace', () => {
    const inProject = run([{ type: 'open', text: 'q', tags: [{ id: 'feature:chats', kind: 'feature', label: 'Chats' }] }])
    expect(inProject.scope.kind).toBe('project')
    const moved = run([{ type: 'open', scope: WORKSPACE }], inProject)
    expect(moved.scope.kind).toBe('workspace')
    expect(moved.tags).toEqual([])
    // Opening the same scope again, with nothing new, keeps where it was left.
    const kept = run([{ type: 'add-tag', tag: PROJECT_BACKEND }, { type: 'close' }, { type: 'open', scope: WORKSPACE }], moved)
    expect(kept.tags.map((t) => t.id)).toEqual(['project:backend'])
  })

  it('reads kinds, projects and labels off qualified ids', () => {
    expect(tagFromId('feature:frontend::chats/composer')).toEqual({ id: 'feature:frontend::chats/composer', kind: 'part', label: 'Composer', project: 'frontend' })
    expect(tagFromId('project:backend')).toMatchObject({ kind: 'project', project: 'backend', label: 'backend' })
    expect(tagFromId('link:backend::frontend')).toMatchObject({ kind: 'connection', label: 'backend ↔ frontend' })
    expect(linkTagId('frontend', 'backend')).toBe(linkTagId('backend', 'frontend'))
  })
})

describe('suggestions and the picker with a same-slug collision', () => {
  const nodes: SuggestNode[] = [
    { id: 'feature:frontend::chats', name: 'Chats', kind: 'core', project: 'frontend', summary: 'The web chat list.' },
    { id: 'feature:mobile::chats', name: 'Chats', kind: 'core', project: 'mobile', summary: 'The phone chat list.' },
    { id: 'feature:mobile::chats/composer', name: 'Composer', kind: 'part', partOf: 'chats', project: 'mobile' },
    { id: 'feature:frontend::chats/composer', name: 'Composer', kind: 'part', partOf: 'chats', project: 'frontend' },
  ]

  it('both are suggested, each with its own id and project, and a part is labelled with ITS project\'s feature', () => {
    const found = suggestTags('How does the chats composer send a message?', nodes, { limit: 10 })
    const ids = found.map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining(nodes.map((n) => n.id)))
    expect(new Set(ids).size).toBe(ids.length)
    expect(found.find((s) => s.id === 'feature:mobile::chats/composer')).toMatchObject({ label: 'Chats · Composer', project: 'mobile' })
    // Excluding one project's tag leaves the other's.
    const without = suggestTags('chats', nodes, { exclude: new Set(['feature:frontend::chats']) })
    expect(without.map((s) => s.id)).toContain('feature:mobile::chats')
    expect(without.map((s) => s.id)).not.toContain('feature:frontend::chats')
  })

  it('the picker lists projects, then features, then connections, then parts, and a typed query narrows them', () => {
    const rows = [
      ...graphCandidates(nodes),
      ...workspaceCandidates(
        [
          { slug: 'frontend', name: 'Frontend', description: 'The web app' },
          { slug: 'mobile', name: 'Mobile', description: null },
        ],
        [{ from: { project: 'frontend' }, to: { project: 'mobile' } }, { from: { project: 'mobile' }, to: { project: 'frontend' } }],
      ),
    ]
    expect(pickerMatches('', rows, { limit: 20 }).map((r) => r.kind)).toEqual([
      'project', 'project', 'feature', 'feature', 'connection', 'part', 'part',
    ])
    const chats = pickerMatches('chat', rows, { limit: 20 }).filter((r) => r.kind === 'feature')
    expect(chats.map((r) => r.id).sort()).toEqual(['feature:frontend::chats', 'feature:mobile::chats'])
    expect(pickerMatches('', rows, { exclude: new Set(['project:mobile']), limit: 20 }).map((r) => r.id)).not.toContain('project:mobile')
    expect(activeMention('how does @fro', 13)).toEqual({ query: 'fro', start: 9 })
  })
})

describe('workspaceCandidates', () => {
  const projects = [
    { slug: 'backend', name: 'Backend', description: 'The API' },
    { slug: 'frontend', name: 'Frontend' },
    { slug: 'mobile', name: 'Mobile', description: '' },
  ]

  it('offers each project, and one connection per pair however many links and whichever way they point', () => {
    const rows = workspaceCandidates(projects, [
      { from: { project: 'frontend' }, to: { project: 'backend' } },
      { from: { project: 'backend' }, to: { project: 'frontend' } },
      { from: { project: 'mobile' }, to: { project: 'backend' } },
      { from: { project: 'mobile' }, to: { project: 'mobile' } }, // inside one project: not a connection
    ])
    expect(rows.filter((r) => r.kind === 'project').map((r) => [r.id, r.label, r.hint])).toEqual([
      ['project:backend', 'Backend', 'The API'],
      ['project:frontend', 'Frontend', undefined],
      ['project:mobile', 'Mobile', undefined],
    ])
    expect(rows.filter((r) => r.kind === 'connection').map((r) => [r.id, r.label, r.hint])).toEqual([
      ['link:backend::frontend', 'Backend ↔ Frontend', '2 connections recorded'],
      ['link:backend::mobile', 'Backend ↔ Mobile', '1 connection recorded'],
    ])
  })

  it('links that could not be read give projects only', () => {
    expect(workspaceCandidates(projects, null).every((r) => r.kind === 'project')).toBe(true)
    expect(workspaceCandidates(projects, null)).toHaveLength(3)
  })
})

describe('the sheet\'s decoration (projectWorkspaceDecoration)', () => {
  // Two cells with the SAME project-local id, one in each project.
  const drawn: WorkspaceDrawnCell[] = [
    { key: 'frontend|chats', project: 'frontend', id: 'feature:chats' },
    { key: 'mobile|chats', project: 'mobile', id: 'feature:chats' },
    { key: 'backend|engine', project: 'backend', id: 'feature:chat-engine' },
  ]

  it('a tagged feature lights its own project\'s cell only, and the rest recede', () => {
    const paint = projectWorkspaceDecoration(askDecoration(open([CHATS_FRONT])), drawn)
    expect([...paint.lit]).toEqual(['frontend|chats']) // the positive
    expect(paint.cells.get('frontend|chats')?.role).toBe('tagged')
    expect(paint.cells.has('mobile|chats')).toBe(false)
    expect([...paint.litProjects]).toEqual(['frontend'])
    expect(paint.dim).toBe(true)
  })

  it('tagging both same-slug features lights both cells, each as its own', () => {
    const paint = projectWorkspaceDecoration(askDecoration(open([CHATS_FRONT, CHATS_MOBILE])), drawn)
    expect([...paint.lit].sort()).toEqual(['frontend|chats', 'mobile|chats'])
    expect([...paint.litProjects].sort()).toEqual(['frontend', 'mobile'])
  })

  it('a part lands on its project\'s feature cell, never the other project\'s', () => {
    const part: AskTag = { id: 'feature:mobile::chats/composer', kind: 'part', label: 'Composer', project: 'mobile' }
    const paint = projectWorkspaceDecoration(askDecoration(open([part])), drawn)
    expect([...paint.cells.keys()]).toEqual(['mobile|chats'])
  })

  it('a project tag lights the whole band and its cells; a connection tag lights both ends', () => {
    const band = projectWorkspaceDecoration(askDecoration(open([PROJECT_BACKEND])), drawn)
    expect(band.bands.get('backend')).toEqual({ role: 'tagged', knowledgeOnly: false })
    expect([...band.lit]).toEqual(['backend|engine'])
    const link: AskTag = { id: linkTagId('frontend', 'backend'), kind: 'connection', label: 'a ↔ b' }
    const both = projectWorkspaceDecoration(askDecoration(open([link])), drawn)
    expect([...both.lit].sort()).toEqual(['backend|engine', 'frontend|chats'])
    expect([...both.litProjects].sort()).toEqual(['backend', 'frontend'])
  })

  it('an answer marks cited projects and the knowledge-only ones, and numbers land on the right cell', () => {
    const state = run(
      [
        { type: 'submit', question: 'q', followUp: false, at: 0 },
        { type: 'started', askId: 'ask-1' },
        {
          type: 'state',
          at: 1,
          event: {
            askId: 'ask-1',
            rootId: '/r',
            workspace: 'team',
            phase: { kind: 'done' },
            answer: answer({
              sources: [
                { n: 1, label: 'Engine', featureId: 'feature:backend::chat-engine', project: 'backend' },
                { n: 2, label: 'Chats', featureId: 'feature:mobile::chats', project: 'mobile' },
              ],
              knowledgeOnly: ['mobile'],
              projectsRead: ['backend', 'frontend'],
            }),
          },
        },
      ],
      open([CHATS_FRONT]),
    )
    const paint = projectWorkspaceDecoration(askDecoration(state), drawn)
    expect(paint.cells.get('backend|engine')?.numbers).toEqual([{ n: 1, label: 'Engine' }])
    expect(paint.cells.get('mobile|chats')?.numbers).toEqual([{ n: 2, label: 'Chats' }])
    expect(paint.cells.get('frontend|chats')?.numbers).toEqual([])
    expect(paint.bands.get('backend')?.role).toBe('mentioned')
    expect(paint.bands.get('mobile')).toMatchObject({ knowledgeOnly: true })
    // A tagged FEATURE lights its cell, not its project's whole band.
    expect(paint.bands.has('frontend')).toBe(false)
    expect(paint.cells.get('frontend|chats')?.role).toBe('tagged')
  })

  it('is empty while the panel is closed, and when nothing on the sheet is named', () => {
    const closed = projectWorkspaceDecoration(askDecoration(run([{ type: 'close' }], open([CHATS_FRONT]))), drawn)
    expect(closed).toMatchObject({ dim: false })
    expect(closed.lit.size + closed.cells.size + closed.bands.size).toBe(0)
    const none = projectWorkspaceDecoration(askDecoration(open()), drawn)
    expect(none.dim).toBe(false)
    expect(none.lit.size).toBe(0)
    // A tag for a project that is not on the sheet lights nothing it cannot find.
    const absent = projectWorkspaceDecoration(askDecoration(open([{ id: 'feature:ghost::x', kind: 'feature', label: 'X', project: 'ghost' }])), drawn)
    expect(absent.cells.size).toBe(0)
  })
})

describe('askScopeLine', () => {
  it('names the whole Workspace until something is tagged, then the tags, and never a conversation', () => {
    const line = askScopeLine(open())
    expect(line.items).toEqual([{ label: 'All 3 projects', kind: 'scope' }])
    expect(line.hint).toMatch(/project, feature or connection/)
    const tagged = askScopeLine(run([{ type: 'add-tag', tag: CHATS_FRONT }, { type: 'add-tag', tag: { id: 'thread-1', kind: 'conversation', label: 'Work' } }], open()))
    expect(tagged.items).toEqual([{ label: 'Chats', kind: 'feature', project: 'frontend' }])
  })

  it('one project reads "The one project"; a project ask keeps its own words', () => {
    const one: AskScope = { ...WORKSPACE, projects: [{ slug: 'a', name: 'A' }] }
    expect(askScopeLine(run([{ type: 'open', scope: one }])).items[0].label).toBe('The one project')
    expect(askScopeLine(initialAskState()).items[0].label).toBe('This whole project')
    expect(askScopeLine(run([{ type: 'open', scope: { kind: 'project', name: 'Jupiter' } }])).items[0].label).toBe('All of Jupiter')
  })
})

describe('askStatusLine', () => {
  it('says what is happening while it works', () => {
    expect(askStatusLine(turn({ phase: 'fast', answer: null }), 0)).toEqual({ tone: 'busy', text: 'Looking at what Flow already knows…' })
    expect(askStatusLine(turn({ phase: 'fast', answer: null, stopping: true }), 0)?.text).toBe('Stopping…')
    expect(askStatusLine(turn({ phase: 'digging', reads: 1, digElapsedMs: 12_000 }), 0)).toEqual({ tone: 'busy', text: 'Reading the code · 1 file · 12 s' })
    expect(askStatusLine(turn({ phase: 'digging', reads: 14 }), 0)?.text).toBe('Reading the code · 14 files')
  })

  it('a checked Workspace answer says which projects were read; a partial one warns', () => {
    expect(askStatusLine(turn({ answer: answer({ projectsRead: ['backend'] }) }), 0)).toEqual({ tone: 'good', text: 'Checked against the code in backend · 4 s' })
    expect(askStatusLine(turn({ answer: answer({ projectsRead: ['backend', 'frontend'] }), changedFromFirst: true }), 0)?.text).toBe(
      'Checked against the code in 2 projects · 4 s · changed from the first answer',
    )
    expect(askStatusLine(turn({ answer: answer() }), 0)?.text).toBe('Checked against the code · 4 s')
    expect(askStatusLine(turn({ answer: answer(), reads: 6 }), 0)?.text).toBe('Checked against the code · 4 s · 6 files read')
    expect(askStatusLine(turn({ phase: 'partial', answer: answer({ partial: true, projectsRead: ['backend'] }) }), 0)).toEqual({
      tone: 'warn',
      text: 'Partial · the code check did not finish · 4 s',
    })
    expect(askStatusLine(turn({ answer: answer({ confidence: 'first' }) }), 0)).toMatchObject({ tone: 'warn', text: 'From what Flow already knows · 4 s' })
  })

  it('a saved answer says who and when; an error and an empty turn say nothing', () => {
    const now = Date.parse('2026-11-15T12:00:00Z')
    const saved = { id: 'a', author: 'Ana', ts: '2026-11-14T12:00:00Z', stale: false, usedConversation: false }
    expect(askStatusLine(turn({ saved }), now)).toEqual({ tone: 'plain', text: 'Saved answer · Ana · yesterday' })
    expect(askStatusLine(turn({ phase: 'error', error: 'x' }), now)).toBeNull()
    expect(askStatusLine(turn({ answer: null }), now)).toBeNull()
  })
})

describe('knowledgeOnlySentence', () => {
  it('is silent when every project was read, singular and plural otherwise, and never names a path or command', () => {
    expect(knowledgeOnlySentence([], nameOf)).toBeNull()
    const one = knowledgeOnlySentence(['mobile'], nameOf)
    expect(one).toBe('Mobile is not open on this computer. Its code was not read; this answer uses its shared knowledge only.')
    const two = knowledgeOnlySentence(['mobile', 'backend'], nameOf)
    expect(two).toBe('Mobile and Backend are not open on this computer. Their code was not read; this answer uses their shared knowledge only.')
    expect(`${one}${two}`).not.toMatch(/planflow|--|\//)
  })
})

describe('savedSentence', () => {
  const fresh = (tags: AskTag[], sources: AskAnswer['sources'] = []): AskTurn => turn({ tags, answer: answer({ savedId: 'wqa-1', sources }) })

  it('says nothing for a saved answer, or one that is not in the log (yet)', () => {
    expect(savedSentence(turn({ answer: answer() }), WORKSPACE, nameOf)).toBeNull()
    const saved = { id: 'a', author: 'Ana', ts: '2026-11-14T12:00:00Z', stale: false, usedConversation: false }
    expect(savedSentence(turn({ saved, answer: answer({ savedId: 'x' }) }), WORKSPACE, nameOf)).toBeNull()
  })

  it('a Workspace answer is saved for the Workspace and the projects it names', () => {
    expect(savedSentence(fresh([]), WORKSPACE, nameOf)).toBe('Saved to your questions across the Workspace. Only you see it.')
    expect(savedSentence(fresh([CHATS_FRONT]), WORKSPACE, nameOf)).toBe('Saved to your questions across the Workspace and on Frontend. Only you see it.')
    expect(savedSentence(fresh([CHATS_FRONT, CHATS_MOBILE]), WORKSPACE, nameOf)).toBe('Saved to your questions across the Workspace and on both projects. Only you see it.')
    expect(savedSentence(fresh([CHATS_FRONT, CHATS_MOBILE, PROJECT_BACKEND]), WORKSPACE, nameOf)).toBe('Saved to your questions across the Workspace and on 3 projects. Only you see it.')
    // A project named only by a source or a connection tag counts too.
    expect(citedProjects(fresh([{ id: linkTagId('backend', 'mobile'), kind: 'connection', label: 'x' }], [{ n: 1, label: 'S', project: 'frontend' }])).sort()).toEqual(['backend', 'frontend', 'mobile'])
  })

  it('a project answer keeps its own sentence, and a conversation adds the privacy note', () => {
    const project: AskScope = { kind: 'project', name: null }
    expect(savedSentence(fresh([{ id: 'feature:chats', kind: 'feature', label: 'Chats' }]), project, nameOf)).toBe('Saved to your questions about Chats. Only you see it.')
    expect(savedSentence(fresh([]), project, nameOf)).toBe('Saved to your questions. Only you see it.')
    expect(savedSentence(fresh([{ id: 't', kind: 'conversation', label: 'Work' }]), WORKSPACE, nameOf)).toMatch(/Used one of your conversations \(its content stays private\)\.$/)
  })
})

describe('connectionView / connectionButton', () => {
  const suggested = (patch: Partial<AskSuggestedConnection> = {}): AskSuggestedConnection => ({
    id: 'mobile/login|calls|backend/endpoint:POST /auth',
    kind: 'calls',
    fromProject: 'mobile',
    from: 'mobile/login',
    toProject: 'backend',
    to: 'backend/endpoint:POST /auth',
    ...patch,
  })

  it('reads each end as a feature of its project, or as an anchor when it is not one', () => {
    const view = connectionView(suggested())
    expect(view.from).toEqual({ project: 'mobile', featureId: 'feature:login', ref: 'login' })
    expect(view.verb).toBe('calls')
    expect(view.to).toEqual({ project: 'backend', featureId: null, ref: 'endpoint:POST /auth' })
    expect(connectionView(suggested({ kind: 'relates' })).verb).toBe('relates to')
    expect(connectionView(suggested({ kind: 'consumes' })).verb).toBe('consumes')
    expect(connectionView(suggested({ kind: 'exposes' })).verb).toBe('exposes')
    // An end that is only its project names no feature.
    expect(connectionView(suggested({ from: 'mobile/' })).from.featureId).toBeNull()
  })

  it('the button walks save → saving → saved / exists / failed, and only the first and last can be pressed', () => {
    expect(connectionButton(undefined)).toEqual({ label: 'Save as connection', disabled: false, note: null })
    expect(connectionButton({ status: 'saving' })).toEqual({ label: 'Saving…', disabled: true, note: null })
    expect(connectionButton({ status: 'saved' })).toEqual({ label: 'Saved', disabled: true, note: null })
    expect(connectionButton({ status: 'exists' })).toMatchObject({ label: 'Saved', disabled: true, note: expect.stringMatching(/already had/) })
    expect(connectionButton({ status: 'failed', sentence: 'Nope.' })).toEqual({ label: 'Save as connection', disabled: false, note: 'Nope.' })
  })

  it('the reducer carries a connection through its states and clears them with the question', () => {
    const id = suggested().id
    const saving = run([{ type: 'connection-saving', id }], open())
    expect(saving.connections[id]).toEqual({ status: 'saving' })
    expect(run([{ type: 'connection-saved', id, recorded: true }], saving).connections[id]).toEqual({ status: 'saved' })
    expect(run([{ type: 'connection-saved', id, recorded: false }], saving).connections[id]).toEqual({ status: 'exists' })
    expect(run([{ type: 'connection-failed', id, sentence: 'x' }], saving).connections[id]).toEqual({ status: 'failed', sentence: 'x' })
    expect(run([{ type: 'new-question' }], saving).connections).toEqual({})
  })
})

describe('savedSectionView with a Workspace pointer', () => {
  const NOW = Date.parse('2026-11-15T12:00:00Z')
  const base: AskSavedThread = {
    id: 'wqa-1',
    ts: '2026-11-15T11:59:50Z',
    author: 'Ana',
    question: 'How do chats reach the engine?',
    tags: ['feature:frontend::chats'],
    conversationCount: 0,
    usedConversation: false,
    answer: '',
    sources: [],
    factsLearned: 0,
    partial: false,
    followUps: [],
  }

  it('a pointer row carries the Workspace entry to open and says it was asked across the Workspace', () => {
    const view = savedSectionView(
      [
        { ...base, workspaceAnswer: { workspace: 'team', entryId: 'wqa-1' } },
        { ...base, id: 'qa-2', ts: '2026-11-14T12:00:00Z', question: 'A project question' },
      ],
      [],
      NOW,
    )
    expect(view?.rows[0]).toMatchObject({ id: 'wqa-1', workspaceEntry: 'wqa-1', meta: 'Ana · just now · asked across the Workspace' })
    // The plain row beside it is untouched.
    expect(view?.rows[1]).toMatchObject({ id: 'qa-2', workspaceEntry: null, meta: 'Ana · yesterday' })
  })
})

describe('factsSentence', () => {
  it('names the tagged feature, else the first cited one, else the project; nothing learned says nothing', () => {
    const label = (id: string): string | null => (id === 'feature:auth' ? 'Auth' : null)
    expect(factsSentence(turn({ answer: answer({ factsLearned: 0 }) }), label)).toBeNull()
    expect(factsSentence(turn({ tags: [{ id: 'feature:tenant', kind: 'feature', label: 'Tenant' }], answer: answer({ factsLearned: 2 }) }), label)).toBe(
      '2 facts added to Tenant’s knowledge, shared with the team',
    )
    expect(factsSentence(turn({ answer: answer({ factsLearned: 1, sources: [{ n: 1, label: 'x', featureId: 'feature:auth' }] }) }), label)).toBe(
      '1 fact added to Auth’s knowledge, shared with the team',
    )
    expect(factsSentence(turn({ answer: answer({ factsLearned: 3 }) }), label)).toBe('3 facts added to the project’s knowledge, shared with the team')
  })
})
