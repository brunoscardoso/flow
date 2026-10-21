import {
  docMention,
  planRunStateFor,
  planSummary,
  PLAN_SUMMARY_MAX_CHARS,
  holdsNewArtifactCard,
  artifactEventIsHistorical,
  artifactRowActions,
  executeCommandFor,
  executeConfirmText,
  executePressState,
  EXECUTING_FALLBACK_LABEL,
  notePills,
  planCommandFor,
  planPhaseCount,
  planSlugOf,
  planWrittenFromDocument,
  PLAN_CREATE_LABEL,
  PLAN_EXECUTE_LABEL,
  PLAN_REVIEW_LABEL,
  EXECUTE_ANYWAY_LABEL,
  REVIEW_FIRST_LABEL,
  CANCEL_LABEL,
  rejectedLeftOutText,
  runHasEnded,
  cardRunAfter,
  startCardRun,
  PlanRequests,
  UNSEEN_RUN_IDLE_LIMIT_MS,
  openDocTooltip,
  type CardRun,
  runIsForPlan,
  runIsLive,
  runningLine,
  selectedDocOf,
  showsInnerStory,
} from './artifact-card-model'
import type { PlanNoteCounts } from '../../shared/ipc-contract'
import type {
  BlueprintStory,
  FlowArtifactChangedEvent,
  FlowArtifactKind,
} from '../../shared/ipc-contract'
import { WALKTHROUGH_WRITING_WINDOW_MS } from '../../shared/walkthrough-page'
import {
  artifactRenderDecision,
  buildArtifactModel,
  deriveFeatureViewAction,
  deriveFeatureName,
  deriveNarrateAction,
  deriveStoryStatus,
  firstHeading,
  formatMtimeLabel,
  sameDocPath,
  storyHostIndex,
  hasStorySection,
  latestPerKind,
  supersedes,
  type ArtifactCardModel,
  artifactCardHosts,
  artifactSubLine,
  showsOpenDocButton,
  docRefOf,
  docVersionLabel,
  ARTIFACT_GENERATE_LABEL,
  ARTIFACT_OPEN_LABEL,
  ARTIFACT_WRITING_LABEL,
  artifactCommandFor,
  artifactPageState,
  foldDoc,
  foldHostIndex,
  newestMtime,
  OPEN_DOC_LABEL,
  type ArtifactDocRef,
} from './artifact-card-model'

const NOW = Date.parse('2026-07-16T12:00:00.000Z')

const event = (over: Partial<FlowArtifactChangedEvent> = {}): FlowArtifactChangedEvent => ({
  rootId: '/repo',
  kind: 'plan',
  path: 'flow/plans/plan_blueprint-v2_v1.md',
  name: 'plan_blueprint-v2_v1.md',
  mtime: NOW,
  ...over,
})

const story = (over: Partial<BlueprintStory> = {}): BlueprintStory => ({
  plan: 'blueprint-v2',
  sourcePath: 'flow/plans/plan_blueprint-v2_v1.md',
  mode: 'strict',
  steps: [],
  warnings: [],
  ...over,
})

describe('deriveFeatureName', () => {
  it('strips the kind prefix and version suffix (plan)', () => {
    expect(deriveFeatureName('plan_blueprint-v2_v1.md')).toBe('blueprint-v2')
  })

  it('handles discovery and brainstorm prefixes', () => {
    expect(deriveFeatureName('discovery_foo_v3.md')).toBe('foo')
    expect(deriveFeatureName('brainstorm_bar_v1.md')).toBe('bar')
  })

  it('accepts a brainstorm name with no version segment', () => {
    expect(deriveFeatureName('brainstorm_wild-idea.md')).toBe('wild-idea')
  })

  it('keeps embedded underscores/versions in the feature name (non-greedy tail)', () => {
    expect(deriveFeatureName('plan_multi_word_feature_v12.md')).toBe('multi_word_feature')
  })

  it('strips a leading directory before matching', () => {
    expect(deriveFeatureName('flow/plans/plan_foo_v1.md')).toBe('foo')
  })

  it('returns null for a non-conventional filename', () => {
    expect(deriveFeatureName('notes.md')).toBeNull()
    expect(deriveFeatureName('README.md')).toBeNull()
    expect(deriveFeatureName('plan.md')).toBeNull()
  })
})

describe('firstHeading', () => {
  it('returns the first H1, trimmed', () => {
    expect(firstHeading('# The Title\n\nbody')).toBe('The Title')
    expect(firstHeading('#   Padded  \nbody')).toBe('Padded')
  })

  it('picks the FIRST H1 when several exist', () => {
    expect(firstHeading('intro\n# First\n# Second')).toBe('First')
  })

  it('ignores H2/H3 and hashtags without a space', () => {
    expect(firstHeading('## Story\n### Sub\n#nospace')).toBeNull()
  })

  it('returns null for an empty or heading-less doc', () => {
    expect(firstHeading('')).toBeNull()
    expect(firstHeading('just prose\nmore prose')).toBeNull()
  })

  it('treats an empty heading (# alone) as no title', () => {
    expect(firstHeading('#   \nbody')).toBeNull()
  })

  it('finds a later H1 when earlier lines are H2-only', () => {
    expect(firstHeading('## Section\ntext\n# Real Title')).toBe('Real Title')
  })
})

describe('hasStorySection', () => {
  it('detects a `## Story` heading anywhere in the doc', () => {
    expect(hasStorySection('# Plan\n\n## Story\n\n### Step: X')).toBe(true)
  })

  it('detects `## Story` at end-of-file with no trailing newline', () => {
    expect(hasStorySection('# Plan\n## Story')).toBe(true)
  })

  it('does not match `## Storyboard` or `## Story Layer` variants', () => {
    expect(hasStorySection('## Storyboard\nx')).toBe(false)
    expect(hasStorySection('## StoryLine')).toBe(false)
  })

  it('accepts a trailing space after `## Story`', () => {
    expect(hasStorySection('## Story \nx')).toBe(true)
  })

  it('returns false when there is no story section', () => {
    expect(hasStorySection('# Plan\n\n## Design Context')).toBe(false)
    expect(hasStorySection('')).toBe(false)
  })

  it('does not match a `## Story` that is not at line start', () => {
    expect(hasStorySection('see the ## Story below')).toBe(false)
  })
})

describe('deriveStoryStatus', () => {
  it('is compiled when the section exists and story.plan matches the feature', () => {
    expect(deriveStoryStatus('## Story\nx', 'blueprint-v2', story())).toBe('compiled')
  })

  it('is uncompiled when the section exists but no story is compiled', () => {
    expect(deriveStoryStatus('## Story\nx', 'blueprint-v2', undefined)).toBe('uncompiled')
  })

  it('is uncompiled when the compiled story is for a different plan', () => {
    expect(deriveStoryStatus('## Story\nx', 'blueprint-v2', story({ plan: 'other' }))).toBe(
      'uncompiled',
    )
  })

  it('is uncompiled when the section exists but the feature is unknown', () => {
    expect(deriveStoryStatus('## Story\nx', null, story())).toBe('uncompiled')
  })

  it('is missing when the doc has no story section', () => {
    expect(deriveStoryStatus('# Plan\nno story here', 'blueprint-v2', story())).toBe('missing')
  })

  it('is missing when the doc text is unavailable (name-only card)', () => {
    expect(deriveStoryStatus(null, 'blueprint-v2', story())).toBe('missing')
  })

  it('is compiled only for the version the story was compiled from', () => {
    const v2 = story({ sourcePath: 'flow/plans/plan_blueprint-v2_v2.md' })
    // Positive first (#28): the narrated version reads compiled…
    expect(deriveStoryStatus('## Story\nx', 'blueprint-v2', v2, 'flow/plans/plan_blueprint-v2_v2.md')).toBe('compiled')
    // …and v1 of the same feature keeps its Narrate button.
    expect(deriveStoryStatus('## Story\nx', 'blueprint-v2', v2, 'flow/plans/plan_blueprint-v2_v1.md')).toBe('uncompiled')
  })

  it('matches a ./-prefixed, backslashed or absolute sourcePath to the card path', () => {
    const path = 'flow/plans/plan_blueprint-v2_v1.md'
    for (const sourcePath of [`./${path}`, 'flow\\plans\\plan_blueprint-v2_v1.md', `/Users/me/repo/${path}`]) {
      expect(deriveStoryStatus('## Story\nx', 'blueprint-v2', story({ sourcePath }), path)).toBe('compiled')
    }
  })

  it('keeps the feature-only match for a legacy story with no sourcePath', () => {
    const legacy = story({ sourcePath: undefined as unknown as string })
    expect(deriveStoryStatus('## Story\nx', 'blueprint-v2', legacy, 'flow/plans/plan_blueprint-v2_v1.md')).toBe('compiled')
  })
})

describe('sameDocPath', () => {
  it('compares repo-relative doc paths through ./, backslashes and absolute prefixes', () => {
    expect(sameDocPath('./flow/a/b.md', 'flow/a/b.md')).toBe(true)
    expect(sameDocPath('/repo/flow/a/b.md', 'flow/a/b.md')).toBe(true)
    expect(sameDocPath('C:\\repo\\flow\\a\\b.md', 'flow/a/b.md')).toBe(true)
    expect(sameDocPath('flow/a/b.md', 'flow/a/c.md')).toBe(false)
    // A suffix match needs a whole segment: `xflow/…` is not `flow/…`.
    expect(sameDocPath('/repo/xflow/a/b.md', 'flow/a/b.md')).toBe(false)
  })
})

describe('deriveNarrateAction', () => {
  it('offers narrate for uncompiled, ask-agent for missing, nothing for compiled', () => {
    expect(deriveNarrateAction('uncompiled', 'plan')).toBe('narrate')
    expect(deriveNarrateAction('missing', 'plan')).toBe('ask-agent')
    expect(deriveNarrateAction('compiled', 'plan')).toBeNull()
  })

  it('non-plan kinds NEVER get a story action — narration is the plan-review surface', () => {
    expect(deriveNarrateAction('uncompiled', 'discovery')).toBeNull()
    expect(deriveNarrateAction('missing', 'discovery')).toBeNull()
    expect(deriveNarrateAction('uncompiled', 'brainstorm')).toBeNull()
    expect(deriveNarrateAction('missing', 'brainstorm')).toBeNull()
  })
})

describe('formatMtimeLabel', () => {
  it('reads "just now" under a minute', () => {
    expect(formatMtimeLabel(NOW - 30 * 1000, NOW)).toBe('just now')
  })

  it('reads minutes, hours, and days', () => {
    expect(formatMtimeLabel(NOW - 5 * 60 * 1000, NOW)).toBe('5m ago')
    expect(formatMtimeLabel(NOW - 3 * 60 * 60 * 1000, NOW)).toBe('3h ago')
    expect(formatMtimeLabel(NOW - 2 * 24 * 60 * 60 * 1000, NOW)).toBe('2d ago')
  })

  it('falls back to a UTC date a week or older', () => {
    expect(formatMtimeLabel(Date.parse('2026-07-01T00:00:00Z'), NOW)).toBe('2026-07-01')
  })

  it('falls back to a UTC date for a future mtime (clock skew)', () => {
    expect(formatMtimeLabel(Date.parse('2026-08-01T00:00:00Z'), NOW)).toBe('2026-08-01')
  })
})

describe('buildArtifactModel', () => {
  it('derives a full compiled model', () => {
    const model = buildArtifactModel(event(), '# Blueprint v2\n\n## Story\nx', story(), NOW)
    expect(model).toEqual<ArtifactCardModel>({
      kind: 'plan',
      path: 'flow/plans/plan_blueprint-v2_v1.md',
      name: 'plan_blueprint-v2_v1.md',
      title: 'Blueprint v2',
      feature: 'blueprint-v2',
      mtime: NOW,
      mtimeLabel: 'just now',
      storyStatus: 'compiled',
      narrateAction: null,
      featureViewAction: null,
      summary: null,
    })
  })

  it('falls back to the file name when the doc has no H1', () => {
    const model = buildArtifactModel(event(), '## Story\nx', undefined, NOW)
    expect(model.title).toBe('plan_blueprint-v2_v1.md')
    expect(model.storyStatus).toBe('uncompiled')
    expect(model.narrateAction).toBe('narrate')
  })

  it('degrades to a name-only, missing model when the doc is unreadable', () => {
    const model = buildArtifactModel(event(), null, story(), NOW)
    expect(model.title).toBe('plan_blueprint-v2_v1.md')
    expect(model.storyStatus).toBe('missing')
    expect(model.narrateAction).toBe('ask-agent')
  })

  it('handles a brainstorm with no version and no story section', () => {
    const model = buildArtifactModel(
      event({ kind: 'brainstorm', name: 'brainstorm_wild.md', path: 'flow/brainstorms/brainstorm_wild.md' }),
      '# Wild Idea\n\nsome prose',
      undefined,
      NOW,
    )
    expect(model.kind).toBe('brainstorm')
    expect(model.feature).toBe('wild')
    expect(model.title).toBe('Wild Idea')
    expect(model.storyStatus).toBe('missing')
    // Non-plan kinds get NO story action (narration is plan-only, 2026-07-22).
    expect(model.narrateAction).toBeNull()
  })
})

describe('supersedes / latestPerKind', () => {
  const model = (kind: FlowArtifactKind, mtime: number, name = `${kind}_x_v1.md`): ArtifactCardModel =>
    buildArtifactModel(event({ kind, mtime, name, path: `flow/${kind}s/${name}` }), '## Story\nx', undefined, NOW)

  it('supersedes when there is no prior card', () => {
    expect(supersedes(model('plan', NOW), undefined)).toBe(true)
  })

  it('supersedes a strictly older card and ties (latest-wins refresh)', () => {
    const older = model('plan', NOW - 1000)
    const newer = model('plan', NOW)
    expect(supersedes(newer, older)).toBe(true)
    expect(supersedes(newer, newer)).toBe(true)
  })

  it('does not supersede a strictly newer card', () => {
    const older = model('plan', NOW - 1000)
    const newer = model('plan', NOW)
    expect(supersedes(older, newer)).toBe(false)
  })

  it('keeps the latest per kind, in first-seen kind order', () => {
    const models = [
      model('plan', NOW - 5000),
      model('discovery', NOW - 4000),
      model('plan', NOW - 1000), // newer plan wins
      model('brainstorm', NOW - 3000),
    ]
    const latest = latestPerKind(models)
    expect(latest.map((m) => m.kind)).toEqual(['plan', 'discovery', 'brainstorm'])
    expect(latest.find((m) => m.kind === 'plan')?.mtime).toBe(NOW - 1000)
  })

  it('returns an empty list for no input', () => {
    expect(latestPerKind([])).toEqual([])
  })
})

describe('artifactRenderDecision (#658)', () => {
  it('renders in the thread that owns the card', () => {
    expect(artifactRenderDecision('thread-a', 'thread-a')).toBe('render')
  })

  it('skips in a thread that does not own the card (the #658 leak)', () => {
    expect(artifactRenderDecision('thread-a', 'thread-b')).toBe('skip')
  })

  it('adopts an unowned card into the active thread', () => {
    expect(artifactRenderDecision(null, 'thread-a')).toBe('adopt')
  })

  it('skips when no thread is active, owned or not', () => {
    expect(artifactRenderDecision('thread-a', null)).toBe('skip')
    expect(artifactRenderDecision(null, null)).toBe('skip')
  })
})

describe('showsOpenDocButton', () => {
  it('shows "Open md file" on discovery and plan cards with a slug', () => {
    expect(showsOpenDocButton({ kind: 'discovery', feature: 'contract' })).toBe(true)
    expect(showsOpenDocButton({ kind: 'plan', feature: 'blueprint-v2' })).toBe(true)
  })

  it('shows none on a brainstorm, or on a doc with no derivable slug', () => {
    expect(showsOpenDocButton({ kind: 'brainstorm', feature: 'wild-idea' })).toBe(false)
    expect(showsOpenDocButton({ kind: 'discovery', feature: null })).toBe(false)
    expect(showsOpenDocButton({ kind: 'plan', feature: '   ' })).toBe(false)
  })
})

describe('storyHostIndex', () => {
  const card = (feature: string | null, mtime: number, paths: string[] = []) => ({ feature, mtime, paths })
  const story = (plan: string, sourcePath = 'flow/plans/plan_unmounted_v1.md') => ({ plan, sourcePath })

  it('returns -1 when no card carries the story feature', () => {
    expect(storyHostIndex([card('other', 5), card(null, 9)], story('ledger-sync'))).toBe(-1)
  })

  it('finds the single matching card', () => {
    expect(storyHostIndex([card('other', 5), card('ledger-sync', 1)], story('ledger-sync'))).toBe(1)
  })

  it('prefers the NEWEST card when none holds the story source', () => {
    expect(storyHostIndex([card('sync', 100), card('sync', 400), card('sync', 250)], story('sync'))).toBe(1)
  })

  it('keeps the earlier candidate on an mtime tie — the story must not hop', () => {
    expect(storyHostIndex([card('sync', 700), card('sync', 700)], story('sync'))).toBe(0)
  })

  it('handles an empty candidate list', () => {
    expect(storyHostIndex([], story('sync'))).toBe(-1)
  })

  it('puts the story on the card holding its source document, never an older version', () => {
    const v1 = card('pay', 100, ['flow/discovery/discovery_pay_v1.md'])
    const v2 = card('pay', 200, ['flow/discovery/discovery_pay_v2.md', 'flow/plans/plan_pay_v1.md'])
    // Compiled from the plan folded into v2's card: v2 hosts it.
    expect(storyHostIndex([v1, v2], story('pay', 'flow/plans/plan_pay_v1.md'))).toBe(1)
    // Compiled from v1 itself: v1 hosts it, though v2 is newer.
    expect(storyHostIndex([v1, v2], story('pay', 'flow/discovery/discovery_pay_v1.md'))).toBe(0)
  })

  it('finds the source card through a ./-prefixed or absolute sourcePath', () => {
    const v1 = card('pay', 100, ['flow/discovery/discovery_pay_v1.md'])
    const v2 = card('pay', 200, ['flow/discovery/discovery_pay_v2.md'])
    expect(storyHostIndex([v1, v2], story('pay', './flow/discovery/discovery_pay_v1.md'))).toBe(0)
    expect(storyHostIndex([v1, v2], story('pay', '/Users/me/repo/flow/discovery/discovery_pay_v1.md'))).toBe(0)
  })

  it('stands alone rather than host on another version when the source card is not mounted', () => {
    const v2 = card('pay', 200, ['flow/discovery/discovery_pay_v2.md'])
    const source = story('pay', 'flow/discovery/discovery_pay_v1.md')
    // Positive first (#28): with nothing known about v1, the newest card hosts.
    expect(storyHostIndex([v2], source)).toBe(0)
    // v1's card exists in this thread (collapsed behind "Show earlier"): no host.
    expect(storyHostIndex([v2], source, ['flow/discovery/discovery_pay_v1.md'])).toBe(-1)
    expect(storyHostIndex([v2], story('pay', './flow/discovery/discovery_pay_v1.md'), ['flow/discovery/discovery_pay_v1.md'])).toBe(-1)
  })
})

describe('deriveFeatureViewAction (the artifact door)', () => {
  const PATH = 'flow/discovery/discovery_pay_v1.md'
  const PAGE = 'flow/discovery/discovery_pay_v1.walkthrough.html'

  it('opens a written page, carrying the slug, the PAGE path and the doc', () => {
    expect(deriveFeatureViewAction('discovery', 'pay', PATH, true)).toEqual({
      slug: 'pay',
      path: PAGE,
      docPath: PATH,
      state: 'ready',
    })
  })

  it('offers to generate the page for a discovery that has none', () => {
    expect(deriveFeatureViewAction('discovery', 'pay', PATH, false)).toEqual({
      slug: 'pay',
      path: PAGE,
      docPath: PATH,
      state: 'generate',
    })
  })

  it('shows the loader while the page still carries the template blanks', () => {
    expect(deriveFeatureViewAction('discovery', 'pay', PATH, true, true)?.state).toBe('writing')
    // A page that is not there cannot be being written.
    expect(deriveFeatureViewAction('discovery', 'pay', PATH, false, true)?.state).toBe('generate')
  })

  it('offers nothing on a plan or a brainstorm, page or not', () => {
    // Positive first (allowed-pattern #28): only the kind differs.
    expect(deriveFeatureViewAction('discovery', 'pay', PATH, true)).not.toBeNull()
    expect(deriveFeatureViewAction('plan', 'pay', PATH, true)).toBeNull()
    expect(deriveFeatureViewAction('brainstorm', 'pay', PATH, true)).toBeNull()
    expect(deriveFeatureViewAction('plan', 'pay', PATH, false)).toBeNull()
  })

  it('offers nothing when the filename yields no slug', () => {
    expect(deriveFeatureViewAction('discovery', 'pay', PATH, true)).not.toBeNull()
    expect(deriveFeatureViewAction('discovery', null, PATH, true)).toBeNull()
    expect(deriveFeatureViewAction('discovery', '   ', PATH, false)).toBeNull()
  })

  it('offers nothing for a path that is not a markdown doc', () => {
    expect(deriveFeatureViewAction('discovery', 'pay', PATH, true)).not.toBeNull()
    expect(deriveFeatureViewAction('discovery', 'pay', 'flow/discovery/discovery_pay_v1.txt', false)).toBeNull()
  })

  it('labels the door in the words the user chose (2026-10-08: "artifact")', () => {
    expect(ARTIFACT_GENERATE_LABEL).toBe('Generate artifact')
    expect(ARTIFACT_WRITING_LABEL).toBe('Writing artifact…')
    expect(ARTIFACT_OPEN_LABEL).toBe('Open artifact')
  })
})

describe('artifactPageState', () => {
  it('no page → generate; page with blanks → writing; written → ready', () => {
    expect(artifactPageState(false, false)).toBe('generate')
    expect(artifactPageState(true, true)).toBe('writing')
    expect(artifactPageState(true, false)).toBe('ready')
  })
})

describe('artifactCommandFor — what Generate artifact sends', () => {
  it('is the /artifact command naming the discovery by its repo-relative path', () => {
    expect(artifactCommandFor('flow/discovery/discovery_pay_v2.md')).toBe('/artifact @flow/discovery/discovery_pay_v2.md')
  })

  it('quotes a path the mention grammar would otherwise split', () => {
    expect(artifactCommandFor('flow/discovery/discovery_my pay_v1.md')).toBe('/artifact @"flow/discovery/discovery_my pay_v1.md"')
  })
})

describe('buildArtifactModel — featureViewAction', () => {
  const discoveryEvent = event({
    kind: 'discovery',
    name: 'discovery_pay_v2.md',
    path: 'flow/discovery/discovery_pay_v2.md',
  })

  it('derives the action from the event\'s page flag, the filename slug and the event path', () => {
    const model = buildArtifactModel({ ...discoveryEvent, walkthrough: true }, '# Pay', undefined, NOW)
    expect(model.featureViewAction).toEqual({
      slug: 'pay',
      path: 'flow/discovery/discovery_pay_v2.walkthrough.html',
      docPath: 'flow/discovery/discovery_pay_v2.md',
      state: 'ready',
    })
  })

  it('marks the door as writing while the page is the half-filled template, and only then', () => {
    const writing = { ...discoveryEvent, walkthrough: true, walkthroughWriting: true, walkthroughMtime: NOW - 30_000 }
    expect(buildArtifactModel(writing, '# Pay', undefined, NOW).featureViewAction?.state).toBe('writing')
    // The page finished: its change event carries no writing flag.
    const done = { ...writing, walkthroughWriting: undefined }
    expect(buildArtifactModel(done, '# Pay', undefined, NOW).featureViewAction?.state).toBe('ready')
  })

  it('stops spinning on a page left half-filled past the writing window', () => {
    const abandoned = {
      ...discoveryEvent,
      walkthrough: true,
      walkthroughWriting: true,
      walkthroughMtime: NOW - WALKTHROUGH_WRITING_WINDOW_MS - 1,
    }
    expect(buildArtifactModel(abandoned, '# Pay', undefined, NOW).featureViewAction?.state).toBe('ready')
  })

  it('needs no doc text — a name-only card with a page still offers the door', () => {
    const model = buildArtifactModel({ ...discoveryEvent, walkthrough: true }, null, undefined, NOW)
    expect(model.featureViewAction?.state).toBe('ready')
  })

  it('offers Generate for a discovery WITHOUT a page', () => {
    const model = buildArtifactModel(discoveryEvent, '# Pay\n\n## Overview\n\ntext', undefined, NOW)
    expect(model.featureViewAction?.state).toBe('generate')
    expect(model.featureViewAction?.docPath).toBe('flow/discovery/discovery_pay_v2.md')
  })
})

describe('the document button', () => {
  it('names the document button in the words the user chose', () => {
    expect(OPEN_DOC_LABEL).toBe('Open md file')
  })
})

describe('folded documents (foldDoc)', () => {
  const ref = (kind: ArtifactDocRef['kind'], version: number, mtime: number): ArtifactDocRef => ({
    kind,
    path: `flow/${kind === 'plan' ? 'plans' : kind}/${kind}_ledger_v${version}.md`,
    name: `${kind}_ledger_v${version}.md`,
    mtime,
  })

  it('lists a discovery and its plan together, discovery first', () => {
    const discovery = ref('discovery', 1, 100)
    expect(foldDoc([discovery], ref('plan', 1, 200)).map((doc) => doc.kind)).toEqual(['discovery', 'plan'])
  })

  it('orders by stage, not by arrival — a plan seen first still lists after its discovery', () => {
    const docs = foldDoc([ref('plan', 1, 200)], ref('discovery', 1, 100))
    expect(docs.map((doc) => doc.kind)).toEqual(['discovery', 'plan'])
  })

  it('replaces a fresher read of the same path rather than listing it twice', () => {
    const docs = foldDoc([ref('discovery', 1, 100), ref('plan', 1, 200)], ref('plan', 1, 300))
    expect(docs).toHaveLength(2)
    expect(docs[1]?.mtime).toBe(300)
  })

  it('does not mutate the list it was given', () => {
    const docs = [ref('discovery', 1, 100)]
    foldDoc(docs, ref('plan', 1, 200))
    expect(docs).toHaveLength(1)
  })

  it('reports the newest change across the documents', () => {
    expect(newestMtime([ref('discovery', 1, 100), ref('plan', 1, 250)])).toBe(250)
  })

  it('builds a reference from a card model', () => {
    expect(docRefOf({ kind: 'plan', path: 'flow/plans/plan_x_v1.md', name: 'plan_x_v1.md', mtime: 5 })).toEqual({
      kind: 'plan',
      path: 'flow/plans/plan_x_v1.md',
      name: 'plan_x_v1.md',
      mtime: 5,
    })
  })
})

describe('one card per document version (2026-10-01)', () => {
  const marker = (kind: 'discovery' | 'plan' | 'brainstorm', slug: string, version: number) => ({
    kind,
    path: `flow/${kind === 'plan' ? 'plans' : kind === 'brainstorm' ? 'brainstorms' : 'discovery'}/${kind}_${slug}_v${version}.md`,
  })

  it('gives every discovery version its own card, never folding one into another', () => {
    const markers = [1, 2, 3, 4, 5, 6, 7, 8].map((version) => marker('discovery', 'pay', version))
    const hosts = artifactCardHosts(markers)
    for (const doc of markers) expect(hosts.get(doc.path)).toBe(doc.path)
  })

  it('gives brainstorm versions their own cards too', () => {
    const hosts = artifactCardHosts([marker('brainstorm', 'pay', 1), marker('brainstorm', 'pay', 2)])
    expect(hosts.get(marker('brainstorm', 'pay', 2).path)).toBe(marker('brainstorm', 'pay', 2).path)
  })

  it('gives a plan its own card, separate from its discovery (user, 2026-10-08)', () => {
    const discovery = marker('discovery', 'pay', 1)
    const plan = marker('plan', 'pay', 1)
    const hosts = artifactCardHosts([discovery, plan])
    // Positive first (allowed-pattern #28): the discovery is a card of its own…
    expect(hosts.get(discovery.path)).toBe(discovery.path)
    // …and so is its plan, never a second chip on the discovery's card.
    expect(hosts.get(plan.path)).toBe(plan.path)
  })

  it('gives every plan version its own card', () => {
    const hosts = artifactCardHosts([marker('discovery', 'pay', 1), marker('plan', 'pay', 1), marker('discovery', 'pay', 2), marker('plan', 'pay', 2)])
    expect(hosts.get(marker('plan', 'pay', 1).path)).toBe(marker('plan', 'pay', 1).path)
    expect(hosts.get(marker('plan', 'pay', 2).path)).toBe(marker('plan', 'pay', 2).path)
  })

  it('folds nothing into anything', () => {
    const cards = [{ kind: 'discovery' as const, feature: 'pay', docs: [{ kind: 'discovery' as const }] }]
    expect(foldHostIndex(cards, { kind: 'plan', feature: 'pay' })).toBe(-1)
    expect(foldHostIndex(cards, { kind: 'discovery', feature: 'pay' })).toBe(-1)
    expect(foldHostIndex(cards, { kind: 'brainstorm', feature: 'pay' })).toBe(-1)
  })

  it('keeps a path seen twice on its first answer', () => {
    const discovery = marker('discovery', 'pay', 1)
    const hosts = artifactCardHosts([discovery, discovery])
    expect(hosts.size).toBe(1)
    expect(hosts.get(discovery.path)).toBe(discovery.path)
  })
})

describe('version label', () => {
  it('reads the version off a doc name, a path or a walkthrough page', () => {
    expect(docVersionLabel('discovery_pay_v7.md')).toBe('v7')
    expect(docVersionLabel('flow/discovery/discovery_pay_v12.md')).toBe('v12')
    expect(docVersionLabel('flow/discovery/discovery_pay_v8.walkthrough.html')).toBe('v8')
    expect(docVersionLabel('notes.md')).toBeNull()
  })

  it('puts the version in the card\'s second line, beside the slug', () => {
    expect(artifactSubLine('pay', 'discovery_pay_v7.md', '5m ago')).toBe('pay · v7 · 5m ago')
    expect(artifactSubLine(null, 'notes.md', 'just now')).toBe('just now')
  })
})

// ── The next step, from the card (plan_change_review Phase 7) ──────────────


const counts = (over: Partial<PlanNoteCounts> = {}): PlanNoteCounts => ({
  total: 3,
  accepted: 1,
  rejected: 1,
  unreviewed: 1,
  ...over,
})

describe('planCommandFor / executeCommandFor — what the next-step buttons send', () => {
  it('Create the plan sends /create-plan naming the discovery', () => {
    expect(planCommandFor('flow/discovery/discovery_pay_v2.md')).toBe('/create-plan @flow/discovery/discovery_pay_v2.md')
  })

  it('Execute the plan sends /execute-plan naming the plan', () => {
    expect(executeCommandFor('flow/plans/plan_pay_v1.md')).toBe('/execute-plan @flow/plans/plan_pay_v1.md')
  })

  it('quotes a path the mention grammar would split', () => {
    expect(executeCommandFor('flow/plans/plan_my pay_v1.md')).toBe('/execute-plan @"flow/plans/plan_my pay_v1.md"')
    expect(planCommandFor('flow/discovery/discovery_my pay_v1.md')).toBe('/create-plan @"flow/discovery/discovery_my pay_v1.md"')
  })
})

describe('planSlugOf — the slug the notes reader takes', () => {
  it('is the feature of plan_<feature>_v<N>.md, a plan_ prefix in the slug kept', () => {
    expect(planSlugOf('flow/plans/plan_pay_v1.md')).toBe('pay')
    expect(planSlugOf('flow/plans/plan_plan_change_review_v1.md')).toBe('plan_change_review')
  })

  it('is null for anything but a plan file', () => {
    expect(planSlugOf('flow/discovery/discovery_pay_v1.md')).toBeNull()
    expect(planSlugOf('flow/plans/notes.txt')).toBeNull()
  })
})

describe('selectedDocOf — which document the row is about', () => {
  const disc: ArtifactDocRef = { kind: 'discovery', path: 'flow/discovery/discovery_pay_v1.md', name: 'discovery_pay_v1.md', mtime: 1 }
  const plan: ArtifactDocRef = { kind: 'plan', path: 'flow/plans/plan_pay_v1.md', name: 'plan_pay_v1.md', mtime: 2 }

  it('is the plan before any chip is pressed, when the card holds one', () => {
    expect(selectedDocOf([disc, plan], null, disc.path)).toBe(plan)
  })

  it('is the card’s own document before any chip is pressed, when there is no plan', () => {
    expect(selectedDocOf([disc], null, disc.path)).toBe(disc)
  })

  it('follows the pressed chip', () => {
    expect(selectedDocOf([disc, plan], plan.path, disc.path)).toBe(plan)
  })

  it('falls back to the own document when the chosen one is gone', () => {
    expect(selectedDocOf([disc], plan.path, disc.path)).toBe(disc)
  })

  it('is null for a card with no documents', () => {
    expect(selectedDocOf([], null, disc.path)).toBeNull()
  })
})

describe('planWrittenFromDocument — which document a plan was written from', () => {
  const DISC_V1 = 'flow/discovery/discovery_widget_v1.md'
  const DISC_V2 = 'flow/discovery/discovery_widget_v2.md'
  const PLAN_V1 = 'flow/plans/plan_widget_v1.md'
  const PLAN_V2 = 'flow/plans/plan_widget_v2.md'
  const PLAN_V3 = 'flow/plans/plan_widget_v3.md'

  // THE BUG. `deriveFeatureName` strips `_vN`, so both sides derived `widget`
  // and the v1 plan answered for a v2 discovery nobody had planned — taking
  // Create the plan off the v2 card.
  it('a v1 plan was NOT written from a v2 discovery', () => {
    // Positive first (allowed-pattern #28): the rule DOES answer true for the
    // document that plan really came from…
    expect(planWrittenFromDocument(DISC_V1, [PLAN_V1])).toBe(true)
    // …so the false below is the version comparison, not a dead function.
    expect(planWrittenFromDocument(DISC_V2, [PLAN_V1])).toBe(false)
  })

  it('a v2 discovery is answered by its own v2 plan', () => {
    expect(planWrittenFromDocument(DISC_V2, [PLAN_V2])).toBe(true)
  })

  it('a v2 discovery is answered by a LATER plan, which supersedes it', () => {
    expect(planWrittenFromDocument(DISC_V2, [PLAN_V3])).toBe(true)
  })

  it('a v1 discovery is answered by its v1 plan', () => {
    expect(planWrittenFromDocument(DISC_V1, [PLAN_V1])).toBe(true)
  })

  it('an unversioned name reads as v1 on either side', () => {
    expect(planWrittenFromDocument('flow/discovery/discovery_widget.md', ['flow/plans/plan_widget.md'])).toBe(true)
    expect(planWrittenFromDocument('flow/discovery/discovery_widget.md', [PLAN_V1])).toBe(true)
    expect(planWrittenFromDocument(DISC_V1, ['flow/plans/plan_widget.md'])).toBe(true)
    // …and an unversioned plan is the FIRST version, so it never answers for v2.
    expect(planWrittenFromDocument(DISC_V2, ['flow/plans/plan_widget.md'])).toBe(false)
  })

  it('finds the answering plan anywhere in the list', () => {
    expect(planWrittenFromDocument(DISC_V2, [PLAN_V1, PLAN_V2])).toBe(true)
    expect(planWrittenFromDocument(DISC_V2, [PLAN_V1, 'flow/plans/plan_other_v9.md'])).toBe(false)
  })

  it('another feature’s plan never answers, whatever its version', () => {
    expect(planWrittenFromDocument(DISC_V1, ['flow/plans/plan_gadget_v1.md'])).toBe(false)
    expect(planWrittenFromDocument(DISC_V1, ['flow/plans/plan_gadget_v9.md'])).toBe(false)
  })

  it('a path outside the naming convention is false on either side', () => {
    expect(planWrittenFromDocument('flow/discovery/notes.md', [PLAN_V1])).toBe(false)
    expect(planWrittenFromDocument(DISC_V1, ['flow/plans/notes.md'])).toBe(false)
  })

  it('no plans at all is false', () => {
    expect(planWrittenFromDocument(DISC_V1, [])).toBe(false)
  })
})

describe('artifactRowActions — the row follows the selected chip', () => {
  it('a discovery with no plan offers Create the plan, Open md file, the artifact door', () => {
    expect(
      artifactRowActions({ selected: 'discovery', holds: ['discovery'], openDoc: true, artifact: true, notes: null }),
    ).toEqual(['create-plan', 'open-doc', 'artifact'])
  })

  it('once the card holds a plan, Create the plan is gone', () => {
    const row = artifactRowActions({ selected: 'discovery', holds: ['discovery', 'plan'], openDoc: true, artifact: true, notes: null })
    expect(row).toEqual(['open-doc', 'artifact'])
    expect(row).not.toContain('create-plan')
  })

  it('a plan with notes: Review the change, Execute the plan, Open md file, Open artifact', () => {
    expect(
      artifactRowActions({ selected: 'plan', holds: ['discovery', 'plan'], openDoc: true, artifact: true, notes: counts() }),
    ).toEqual(['review-change', 'execute-plan', 'open-doc', 'artifact'])
  })

  it('a plan without notes (or unread) has nothing to review, but can still execute', () => {
    expect(artifactRowActions({ selected: 'plan', holds: ['plan'], openDoc: true, artifact: false, notes: null })).toEqual([
      'execute-plan',
      'open-doc',
    ])
    expect(
      artifactRowActions({ selected: 'plan', holds: ['plan'], openDoc: true, artifact: false, notes: counts({ total: 0, accepted: 0, rejected: 0, unreviewed: 0 }) }),
    ).toEqual(['execute-plan', 'open-doc'])
  })

  it('a brainstorm is unchanged — no next-step buttons', () => {
    expect(artifactRowActions({ selected: 'brainstorm', holds: ['brainstorm'], openDoc: false, artifact: false, notes: null })).toEqual([])
  })

  // THE V2 BUG, at the row. With `selectedPath` the row asks the DOCUMENT's
  // question — is there a plan written from THIS version — instead of the
  // feature's.
  describe('a v2 discovery whose only plan is v1', () => {
    const DISC_V2 = 'flow/discovery/discovery_widget_v2.md'
    const DISC_V1 = 'flow/discovery/discovery_widget_v1.md'
    const PLAN_V1 = 'flow/plans/plan_widget_v1.md'
    const PLAN_V2 = 'flow/plans/plan_widget_v2.md'

    it('offers Create the plan — the v1 plan was written from the v1 document', () => {
      const row = artifactRowActions({
        selected: 'discovery',
        holds: ['discovery'],
        openDoc: true,
        artifact: true,
        notes: null,
        selectedPath: DISC_V2,
        planPaths: [PLAN_V1],
      })
      expect(row).toEqual(['create-plan', 'open-doc', 'artifact'])
    })

    it('the v1 document in the same thread does NOT offer it', () => {
      // Positive first (allowed-pattern #28): the v2 row above HAS the button,
      // so its absence here is the version rule and not an empty row.
      const row = artifactRowActions({
        selected: 'discovery',
        holds: ['discovery'],
        openDoc: true,
        artifact: true,
        notes: null,
        selectedPath: DISC_V1,
        planPaths: [PLAN_V1],
      })
      expect(row).toEqual(['open-doc', 'artifact'])
      expect(row).not.toContain('create-plan')
    })

    it('once the v2 document has its OWN plan, Create the plan is gone', () => {
      const row = artifactRowActions({
        selected: 'discovery',
        holds: ['discovery'],
        openDoc: true,
        artifact: true,
        notes: null,
        selectedPath: DISC_V2,
        planPaths: [PLAN_V1, PLAN_V2],
      })
      expect(row).toEqual(['open-doc', 'artifact'])
      expect(row).not.toContain('create-plan')
    })

    it('a selected PLAN is unaffected by the document question', () => {
      expect(
        artifactRowActions({
          selected: 'plan',
          holds: ['discovery', 'plan'],
          openDoc: true,
          artifact: true,
          notes: counts(),
          selectedPath: PLAN_V1,
          planPaths: [PLAN_V1],
        }),
      ).toEqual(['review-change', 'execute-plan', 'open-doc', 'artifact'])
    })
  })

  // THE BACKWARD-COMPATIBILITY PROMISE: a caller that passes no `selectedPath`
  // gets exactly the old `holds` question, with or without plan paths.
  describe('without selectedPath — the old holds rule, unchanged', () => {
    it('a discovery that holds no plan offers Create the plan', () => {
      expect(
        artifactRowActions({ selected: 'discovery', holds: ['discovery'], openDoc: true, artifact: true, notes: null }),
      ).toEqual(['create-plan', 'open-doc', 'artifact'])
    })

    it('a discovery that holds a plan does not, even though no path was given', () => {
      const row = artifactRowActions({
        selected: 'discovery',
        holds: ['discovery', 'plan'],
        openDoc: true,
        artifact: true,
        notes: null,
      })
      expect(row).toEqual(['open-doc', 'artifact'])
      expect(row).not.toContain('create-plan')
    })

    it('planPaths alone changes nothing — it is read only with selectedPath', () => {
      expect(
        artifactRowActions({
          selected: 'discovery',
          holds: ['discovery', 'plan'],
          openDoc: true,
          artifact: true,
          notes: null,
          planPaths: ['flow/plans/plan_widget_v2.md'],
        }),
      ).toEqual(['open-doc', 'artifact'])
      expect(
        artifactRowActions({
          selected: 'discovery',
          holds: ['discovery'],
          openDoc: true,
          artifact: true,
          notes: null,
          planPaths: ['flow/plans/plan_widget_v2.md'],
        }),
      ).toEqual(['create-plan', 'open-doc', 'artifact'])
    })
  })

  // A `selectedPath` with no plans anywhere still offers the button, so the new
  // branch cannot hide it by being taken.
  it('a discovery with a path and no plans at all offers Create the plan', () => {
    expect(
      artifactRowActions({
        selected: 'discovery',
        holds: ['discovery'],
        openDoc: true,
        artifact: false,
        notes: null,
        selectedPath: 'flow/discovery/discovery_widget_v2.md',
        planPaths: [],
      }),
    ).toEqual(['create-plan', 'open-doc'])
  })
})

describe('notePills', () => {
  it('prints no pills on the card', () => {
    expect(notePills(counts())).toEqual([])
  })


  it('shows nothing for a plan without notes, or unread counts', () => {
    expect(notePills(null)).toEqual([])
    expect(notePills(counts({ total: 0, accepted: 0, rejected: 0, unreviewed: 0 }))).toEqual([])
  })
})

describe('showsInnerStory', () => {
  it('hides the STORY section while a plan with notes is selected', () => {
    expect(showsInnerStory('plan', counts())).toBe(false)
  })

  it('keeps it for a plan without notes, a discovery, a brainstorm', () => {
    expect(showsInnerStory('plan', null)).toBe(true)
    expect(showsInnerStory('plan', counts({ total: 0, accepted: 0, rejected: 0, unreviewed: 0 }))).toBe(true)
    expect(showsInnerStory('discovery', counts())).toBe(true)
    expect(showsInnerStory('brainstorm', null)).toBe(true)
    expect(showsInnerStory(null, null)).toBe(true)
  })
})

describe('Execute the plan — confirm or run', () => {
  it('asks first when any note is unreviewed', () => {
    expect(executePressState(counts())).toBe('confirm')
  })

  it('runs straight away when everything is reviewed, or the plan has no notes', () => {
    expect(executePressState(counts({ unreviewed: 0 }))).toBe('running')
    expect(executePressState(null)).toBe('running')
  })

  it('the confirm names the unreviewed (built as written) and the rejected (left out)', () => {
    expect(executeConfirmText(counts())).toBe(
      '1 note has not been reviewed. It is built as written; the 1 rejected note is left out.',
    )
    expect(executeConfirmText(counts({ unreviewed: 2, rejected: 2 }))).toBe(
      '2 notes have not been reviewed. They are built as written; the 2 rejected notes are left out.',
    )
    expect(executeConfirmText(counts({ rejected: 0 }))).toBe('1 note has not been reviewed. It is built as written.')
    expect(executeConfirmText(counts({ unreviewed: 0 }))).toBeNull()
  })

  it('the running footnote names rejected notes only when there are some', () => {
    expect(rejectedLeftOutText(counts({ rejected: 2 }))).toBe('2 rejected notes are left out.')
    expect(rejectedLeftOutText(counts({ rejected: 0 }))).toBeNull()
  })
})

describe('running line', () => {
  const run = { activeSkill: 'execute-plan', activePlan: 'pay', activePhase: '2 — Wire the gate' }

  it('names the phase of THIS plan with the plan’s phase count', () => {
    expect(runningLine(run, 'pay', 3)).toBe('Executing — phase 2 of 3: Wire the gate')
  })

  it('reads "Phase N: name" and drops "of N" without a count', () => {
    expect(runningLine({ ...run, activePhase: 'Phase 1: Lite gate' }, 'pay', null)).toBe('Executing — phase 1: Lite gate')
  })

  it('falls back while the run state is about another plan, or says no phase', () => {
    expect(runningLine({ ...run, activePlan: 'other' }, 'pay', 3)).toBe(EXECUTING_FALLBACK_LABEL)
    expect(runningLine({ activeSkill: 'execute-plan', activePlan: 'pay' }, 'pay', 3)).toBe(EXECUTING_FALLBACK_LABEL)
    expect(runningLine(null, 'pay', 3)).toBe(EXECUTING_FALLBACK_LABEL)
  })

  it('matches the plan by slug or by file, never by stripping a slug’s own plan_ prefix', () => {
    expect(runIsForPlan('plan_change_review', 'plan_change_review')).toBe(true)
    expect(runIsForPlan('flow/plans/plan_plan_change_review_v1.md', 'plan_change_review')).toBe(true)
    expect(runIsForPlan('plan_pay_v2.md', 'pay')).toBe(true)
    expect(runIsForPlan('plan_change_review', 'change_review')).toBe(false)
    expect(runIsForPlan(undefined, 'pay')).toBe(false)
  })

  it('a run ends once it was seen live and the state stops naming it', () => {
    expect(runIsLive(run, 'pay')).toBe(true)
    expect(runHasEnded(run, 'pay', true)).toBe(false)
    expect(runHasEnded({ activeSkill: 'idle' }, 'pay', true)).toBe(true)
    // Not yet seen: the agent may not have started, so it keeps running.
    expect(runHasEnded({ activeSkill: 'idle' }, 'pay', false)).toBe(false)
  })

  it('counts the plan’s phase headings', () => {
    expect(planPhaseCount('### Phase 1: A\n\n### Phase 2: B\n### Phase 3: Tests (Final)\n')).toBe(3)
    expect(planPhaseCount('# no phases')).toBeNull()
    expect(planPhaseCount(null)).toBeNull()
  })
})

describe('next-step UI words name no command, path or key (forbidden-pattern #12)', () => {
  it.each([
    PLAN_CREATE_LABEL,
    PLAN_REVIEW_LABEL,
    PLAN_EXECUTE_LABEL,
    EXECUTE_ANYWAY_LABEL,
    REVIEW_FIRST_LABEL,
    CANCEL_LABEL,
    EXECUTING_FALLBACK_LABEL,
    executeConfirmText(counts()) ?? '',
    runningLine({ activeSkill: 'execute-plan', activePlan: 'pay', activePhase: '2 — Wire' }, 'pay', 3),
  ])('%s', (text) => {
    expect(text).not.toMatch(/\/[a-z-]+|flow\/|\.md\b|planflow|`|_v\d/)
  })
})

describe('holdsNewArtifactCard — a card appears once, whole', () => {
  it('holds a live doc while the turn is running', () => {
    expect(holdsNewArtifactCard({ turnRunning: true, seeded: false })).toBe(true)
  })

  it('mounts it once the turn has ended', () => {
    expect(holdsNewArtifactCard({ turnRunning: false, seeded: false })).toBe(false)
  })

  it('never holds a seeded doc (it has no feed-end card to hold)', () => {
    expect(holdsNewArtifactCard({ turnRunning: true, seeded: true })).toBe(false)
  })
})

describe('planSummary — the description on the plan card', () => {
  it('reads the first paragraph of the Overview, as plain text', () => {
    const plan = ['# Plan: X', '', '## Overview', '', 'Sort the **playbooks** on the server, so `Edited by` applies to all pages.', 'Two repos change.', '', '- **Discovery**: x', '', '## Intent'].join('\n')
    expect(planSummary(plan)).toBe('Sort the playbooks on the server, so Edited by applies to all pages. Two repos change.')
  })

  it('falls back to the Intent goal when there is no Overview', () => {
    const plan = ['# Plan: X', '', '## Intent', '', '**Goal** — Fix the endless spinner on shared chat links.', ''].join('\n')
    expect(planSummary(plan)).toBe('Fix the endless spinner on shared chat links.')
  })

  it('is null for a plan with neither', () => {
    expect(planSummary('# Plan: X\n\n## Phases\n')).toBeNull()
  })

  it('ends a long description at a word, with an ellipsis', () => {
    const long = 'word '.repeat(200)
    const out = planSummary(`## Overview\n\n${long}`) ?? ''
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(PLAN_SUMMARY_MAX_CHARS + 1)
  })
})

describe('planRunStateFor — a plan in an attached project is run from the thread\'s', () => {
  const executing = { activeSkill: 'execute-plan', activePlan: 'plan_widgets_v1', activePhase: '2: Wiring' }
  const resting = {}

  it('the project whose run state shows the plan executing wins, whichever it is', () => {
    expect(runIsLive(executing, 'widgets')).toBe(true)
    expect(planRunStateFor([resting, executing], 'widgets')).toBe(executing)
    expect(planRunStateFor([executing, resting], 'widgets')).toBe(executing)
  })

  it('else the first that answered — the plan\'s own project first', () => {
    expect(planRunStateFor([null, resting], 'widgets')).toBe(resting)
    expect(planRunStateFor([resting, null], 'widgets')).toBe(resting)
    expect(planRunStateFor([null, null], 'widgets')).toBeNull()
  })
})

describe('docMention — a message names a doc where the agent can find it', () => {
  it('the thread\'s own project: the relative path', () => {
    expect(docMention('flow/plans/plan_a_v1.md', '/repo/home', '/repo/home')).toBe('flow/plans/plan_a_v1.md')
    expect(docMention('flow/plans/plan_a_v1.md', null, '/repo/home')).toBe('flow/plans/plan_a_v1.md')
    expect(docMention('flow/plans/plan_a_v1.md', '', '/repo/home')).toBe('flow/plans/plan_a_v1.md')
  })

  it('an attached project: the absolute path', () => {
    expect(docMention('flow/plans/plan_a_v1.md', '/repo/sibling', '/repo/home')).toBe('/repo/sibling/flow/plans/plan_a_v1.md')
    expect(executeCommandFor(docMention('flow/plans/plan_a_v1.md', '/repo/sibling', '/repo/home'))).toBe(
      '/execute-plan @/repo/sibling/flow/plans/plan_a_v1.md',
    )
  })
})

describe('artifactEventIsHistorical — a re-listed doc is history, not a write', () => {
  const base = { replayed: true, eventThreadId: null, threadId: 't-open', priorLive: false }

  it('treats a re-listing nobody owns as history', () => {
    expect(artifactEventIsHistorical(base)).toBe(true)
  })

  it("treats a re-listing of ANOTHER thread's doc as history", () => {
    expect(artifactEventIsHistorical({ ...base, eventThreadId: 't-writer' })).toBe(true)
  })

  it('lets the writer thread keep its own doc live', () => {
    expect(artifactEventIsHistorical({ ...base, eventThreadId: 't-open' })).toBe(false)
  })

  it('never demotes a doc this pane already saw written', () => {
    expect(artifactEventIsHistorical({ ...base, priorLive: true })).toBe(false)
  })

  it('a real write is never history', () => {
    expect(artifactEventIsHistorical({ ...base, replayed: false })).toBe(false)
  })
})

describe('a run started from a card ends even when the run state never names it', () => {
  const live = { activeSkill: 'execute-plan', activePlan: 'pay' }
  const idle = { activeSkill: 'idle' }

  it('ends when the turn that carried the message ends without the run state naming the plan', () => {
    let run = startCardRun(0, false) as CardRun | null
    run = cardRunAfter(run!, { kind: 'turn-start' }, 'pay')
    expect(run).not.toBeNull()
    // The agent declined, or the run ended before any broadcast.
    expect(cardRunAfter(run!, { kind: 'turn-end', now: 5, run: idle }, 'pay')).toBeNull()
    expect(cardRunAfter(run!, { kind: 'turn-end', now: 5, run: null }, 'pay')).toBeNull()
  })

  it('a queued message: the earlier turn ending only starts the idle clock; its own turn decides', () => {
    let run: CardRun | null = startCardRun(0, true)
    run = cardRunAfter(run, { kind: 'turn-end', now: 10, run: idle }, 'pay')
    expect(run).toEqual({ seen: false, turnStarted: false, idleSince: 10 })
    run = cardRunAfter(run!, { kind: 'turn-start' }, 'pay')
    expect(run?.idleSince).toBeNull()
    run = cardRunAfter(run!, { kind: 'state', run: live }, 'pay')
    expect(run?.seen).toBe(true)
    run = cardRunAfter(run!, { kind: 'state', run: idle }, 'pay')
    expect(run).toBeNull()
  })

  it('a cancelled queued message: the resting thread ends the run after the bounded wait', () => {
    const run = cardRunAfter(startCardRun(0, true), { kind: 'turn-end', now: 100, run: idle }, 'pay')!
    expect(cardRunAfter(run, { kind: 'tick', now: 100 + UNSEEN_RUN_IDLE_LIMIT_MS - 1, turnLive: false }, 'pay')).toBe(run)
    expect(cardRunAfter(run, { kind: 'tick', now: 100 + UNSEEN_RUN_IDLE_LIMIT_MS, turnLive: false }, 'pay')).toBeNull()
    // A live turn may be the one carrying it: the clock waits for its end.
    expect(cardRunAfter(run, { kind: 'tick', now: 10 * UNSEEN_RUN_IDLE_LIMIT_MS, turnLive: true }, 'pay')).not.toBeNull()
  })

  it('a run seen live outlives its turn and never ends by the clock', () => {
    let run: CardRun | null = cardRunAfter(startCardRun(0, false), { kind: 'turn-start' }, 'pay')
    run = cardRunAfter(run!, { kind: 'turn-end', now: 5, run: live }, 'pay')
    expect(run?.seen).toBe(true)
    expect(cardRunAfter(run!, { kind: 'tick', now: 10 * UNSEEN_RUN_IDLE_LIMIT_MS, turnLive: false }, 'pay')).toBe(run)
    expect(cardRunAfter(run!, { kind: 'state', run: idle }, 'pay')).toBeNull()
  })
})

describe('Create the plan is asked once per thread and discovery, whatever the card', () => {
  const doc = 'flow/discovery/discovery_pay_v1.md'

  it('survives a rebuilt card: the pane keeps the request', () => {
    const requests = new PlanRequests()
    expect(requests.isRequested('t1', doc, false)).toBe(false)
    requests.record('t1', doc)
    // A fresh card asks the same pane.
    expect(requests.isRequested('t1', doc, false)).toBe(true)
    expect(requests.isRequested('t2', doc, false)).toBe(false)
    expect(requests.isRequested(null, doc, false)).toBe(false)
  })

  it('is forgotten once a plan for the feature is known', () => {
    const requests = new PlanRequests()
    requests.record('t1', doc)
    expect(requests.isRequested('t1', doc, true)).toBe(false)
    expect(requests.isRequested('t1', doc, false)).toBe(false)
  })
})

describe('the Open md file hover names the kind, never the file (forbidden-pattern #12)', () => {
  it.each([
    ['plan', 'Open the plan as a rendered preview'],
    ['discovery', 'Open the discovery as a rendered preview'],
  ] as const)('%s', (kind, text) => {
    expect(openDocTooltip(kind)).toBe(text)
    expect(openDocTooltip(kind)).not.toMatch(/\.md|_v\d|flow\//)
  })
})
