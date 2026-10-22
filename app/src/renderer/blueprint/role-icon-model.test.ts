/**
 * A feature's type, as the board draws it (plan feature-type-icons, Phase 5).
 * Pure: no DOM, no fl-icon — the table and the rules are what is pinned.
 */
import { FEATURE_ROLES, FEATURE_ROLE_LABELS, type FeatureRole } from '../../shared/feature-role'
import { ICON_PATHS } from '../components/icon-paths'
import {
  boxRole,
  partRolesOf,
  roleIconShownAt,
  roleMarkFor,
  roleOfferDismissKey,
  roleOfferView,
  roleToken,
  roleTooltip,
  ROLE_GLYPHS,
  type RoleOfferInput,
} from './role-icon-model'

describe('every role has a glyph and a colour', () => {
  it('maps all eleven roles to a glyph that exists in the icon table', () => {
    expect(Object.keys(ROLE_GLYPHS).sort()).toEqual([...FEATURE_ROLES].sort())
    for (const role of FEATURE_ROLES) {
      expect(ICON_PATHS[ROLE_GLYPHS[role]]).toEqual(expect.any(String))
    }
  })

  it('gives every role its own glyph', () => {
    const glyphs = FEATURE_ROLES.map((role) => ROLE_GLYPHS[role])
    expect(new Set(glyphs).size).toBe(FEATURE_ROLES.length)
  })

  it('names one --fb-role token per role', () => {
    expect(FEATURE_ROLES.map(roleToken)).toEqual(FEATURE_ROLES.map((role) => `--fb-role-${role}`))
  })
})

describe('the tooltip (FR-11)', () => {
  it('reads the label and where it came from', () => {
    expect(roleTooltip('api', 'learn')).toBe('API · learned')
    expect(roleTooltip('ui', 'person')).toBe('User interface · set by you')
    expect(roleTooltip('data', 'guess')).toBe('Data · guessed from its files')
  })

  it('uses the shared label for every role', () => {
    for (const role of FEATURE_ROLES) expect(roleTooltip(role, 'learn').startsWith(FEATURE_ROLE_LABELS[role])).toBe(true)
  })
})

describe('the mark — the guessed look (FR-9)', () => {
  it('draws a person and a learn pass alike, in the role colour', () => {
    const learned = roleMarkFor('api', 'learn')
    const person = roleMarkFor('api', 'person')
    expect(learned).toMatchObject({ guessed: false, className: 'fb-role-icon fb-role-api', glyph: 'role-api' })
    expect(person?.className).toBe(learned?.className)
  })

  it('draws a guess grey', () => {
    expect(roleMarkFor('data', 'guess')).toMatchObject({
      guessed: true,
      className: 'fb-role-icon fb-role-data fb-role-guessed',
      title: 'Data · guessed from its files',
    })
  })

  it('draws nothing for no role or an off-list one, and reads an unknown source as a guess', () => {
    expect(roleMarkFor(undefined)).toBeNull()
    expect(roleMarkFor(null, 'learn')).toBeNull()
    expect(roleMarkFor('wizard', 'person')).toBeNull()
    expect(roleMarkFor('ui', 'somebody')).toMatchObject({ source: 'guess', guessed: true })
  })
})

describe('the name tier (FR-8)', () => {
  it('shows only where the full name prints', () => {
    expect(roleIconShownAt('')).toBe(true)
    for (const tier of ['tiny', 'dot', 'blank']) expect(roleIconShownAt(tier)).toBe(false)
  })
})

describe("an opened feature's box", () => {
  it("draws the component's own role first, as learned", () => {
    expect(boxRole({ role: 'jobs', kind: 'endpoint' }, { role: 'ui', source: 'person' })).toEqual({ role: 'jobs', source: 'learn' })
    expect(boxRole({ role: ' Data ', kind: 'module' })).toEqual({ role: 'data', source: 'learn' })
  })

  it("falls back to the part's role, with the part's source", () => {
    expect(boxRole({ role: 'wizard', kind: 'endpoint' }, { role: 'ui', source: 'person' })).toEqual({ role: 'ui', source: 'person' })
    expect(boxRole({ kind: 'module' }, { role: 'logic', source: 'guess' })).toEqual({ role: 'logic', source: 'guess' })
  })

  it('then guesses from the kind', () => {
    const cases: Array<[string, FeatureRole]> = [
      ['endpoint', 'api'],
      ['datastore', 'data'],
      ['integration', 'integration'],
      ['function', 'function'],
      ['project', 'service'],
    ]
    for (const [kind, role] of cases) expect(boxRole({ kind })).toEqual({ role, source: 'guess' })
  })

  it("then from a module's file, else neutral", () => {
    expect(boxRole({ kind: 'module', code: { file: 'app/src/renderer/components/fl-icon.ts' } })).toEqual({ role: 'ui', source: 'guess' })
    expect(boxRole({ kind: 'module' })).toEqual({ role: 'neutral', source: 'guess' })
    expect(boxRole({ kind: 'something-new' })).toEqual({ role: 'neutral', source: 'guess' })
  })
})

describe("a feature's part roles by name", () => {
  const nodes = [
    { id: 'feature:chats', slug: 'chats', name: 'Chats', kind: 'core', role: 'ui', roleSource: 'learn' },
    { id: 'part:chats/engine', name: 'Engine', kind: 'part', parent: 'feature:chats', role: 'logic', roleSource: 'person' },
    { id: 'part:chats/store', name: 'Store', kind: 'part', partOf: 'chats', role: 'data', roleSource: 'guess' },
    { id: 'part:chats/odd', name: 'Odd', kind: 'part', parent: 'feature:chats', role: 'wizard' },
    { id: 'feature:runs', slug: 'runs', name: 'Runs', kind: 'core' },
    { id: 'part:runs/engine', name: 'Engine', kind: 'part', parent: 'feature:runs', role: 'jobs', roleSource: 'learn' },
  ]

  it("reads the feature's own parts, by id or slug", () => {
    const byId = partRolesOf(nodes, 'feature:chats')
    expect(byId.get('Engine')).toEqual({ role: 'logic', source: 'person' })
    expect(byId.get('Store')).toEqual({ role: 'data', source: 'guess' })
    expect(byId.has('Odd')).toBe(false)
    expect(partRolesOf(nodes, 'chats')).toEqual(byId)
    // Another feature's part of the same name is never borrowed.
    expect(partRolesOf(nodes, 'runs').get('Engine')).toEqual({ role: 'jobs', source: 'learn' })
  })

  it('is empty for a feature not in the graph', () => {
    expect(partRolesOf(nodes, 'feature:gone').size).toBe(0)
    expect(partRolesOf(nodes, undefined).size).toBe(0)
  })
})

describe('the classify offer (FR-10)', () => {
  const base: RoleOfferInput = { count: 12, dismissed: false, finished: false, running: null, failure: null }

  it('offers while something is left, in the words of the approved mockup', () => {
    expect(roleOfferView(base)).toEqual({
      kind: 'offer',
      text: '12 learned features have no type yet. Flow can classify them from what it already learned.',
      primary: 'Classify types',
      secondary: 'Not now',
    })
    expect(roleOfferView({ ...base, count: 1 })).toMatchObject({
      text: '1 learned feature has no type yet. Flow can classify it from what it already learned.',
    })
  })

  it('hides when nothing is left, when put off, or once a pass has run', () => {
    expect(roleOfferView({ ...base, count: 0 })).toEqual({ kind: 'hidden' })
    expect(roleOfferView({ ...base, dismissed: true })).toEqual({ kind: 'hidden' })
    expect(roleOfferView({ ...base, finished: true })).toEqual({ kind: 'hidden' })
  })

  it('shows progress and a Stop while running, whatever else is true', () => {
    expect(roleOfferView({ ...base, dismissed: true, running: { done: 8, total: 20 } })).toEqual({
      kind: 'running',
      text: 'Classifying types · 8 of 20',
      stop: 'Stop',
    })
    expect(roleOfferView({ ...base, running: { done: 0, total: 0 } })).toMatchObject({ text: 'Classifying types…' })
  })

  it('keeps the offer after a failed start and says why', () => {
    expect(roleOfferView({ ...base, failure: 'Learning is paused.' })).toMatchObject({
      kind: 'offer',
      text: '12 learned features have no type yet. The last attempt did not run: Learning is paused.',
    })
  })

  it('never names a role, a command, a path or a config key', () => {
    const views = [
      roleOfferView(base),
      roleOfferView({ ...base, count: 1 }),
      roleOfferView({ ...base, running: { done: 1, total: 2 } }),
    ]
    for (const view of views) {
      const words = JSON.stringify(view)
      expect(words).not.toMatch(/role|planflow|flowconfig|\//i)
    }
  })

  it('remembers "Not now" per project', () => {
    expect(roleOfferDismissKey('/code/a')).not.toBe(roleOfferDismissKey('/code/b'))
  })
})

describe('every string the reader sees (forbidden-pattern #12)', () => {
  const SOURCES = ['person', 'learn', 'guess'] as const

  it('no tooltip or mark title says "role", names a path or a command', () => {
    for (const role of FEATURE_ROLES) {
      for (const source of SOURCES) {
        const words = [roleTooltip(role, source), roleMarkFor(role, source)?.title ?? '']
        expect(words[1]).toBe(words[0]) // the mark really carries the tooltip
        for (const text of words) expect(text).not.toMatch(/role|planflow|flowconfig|\/|\.md|`/i)
      }
    }
  })

  it('the offer moves offer -> running -> hidden as a pass starts and ends', () => {
    const base: RoleOfferInput = { count: 3, dismissed: false, finished: false, running: null, failure: null }
    expect(roleOfferView(base).kind).toBe('offer')
    expect(roleOfferView({ ...base, running: { done: 1, total: 3 } }).kind).toBe('running')
    expect(roleOfferView({ ...base, running: null, finished: true }).kind).toBe('hidden')
  })
})
