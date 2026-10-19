import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { decideDiscoveryAction } from './empty-actions'
import {
  decideUnderstandAction,
  featureDisplayName,
  partNoAnchorRefusal,
  REDRAW_LABEL,
  UNDERSTAND_LABEL,
  UNDERSTAND_PART_LABEL,
  understandTarget,
  type UnderstandActionInput,
} from './understand-action'

const base = (over: Partial<UnderstandActionInput> = {}): UnderstandActionInput => ({
  level: 'derived',
  rootPath: '/Users/x/repo',
  featureRef: 'feature:chats',
  featureName: 'Chats',
  provisioning: 'ready',
  modulePaths: ['src/api/chat', 'src/sdk/chat'],
  running: false,
  ...over,
})

/**
 * ONE CONTROL. This suite is the regression net for the question that produced
 * it — "why do we have a button to learn and another to draw?" — so it asserts
 * the single label, the single vocabulary, and every state the retired pair
 * used to cover between them.
 */
describe('decideUnderstandAction — the one slow gesture', () => {
  it('offers ONE action on a derived level, named for what the reader wants', () => {
    const action = decideUnderstandAction(base())
    expect(action).not.toBeNull()
    expect(action?.label).toBe(UNDERSTAND_LABEL)
    expect(action?.disabled).toBe(false)
    expect(action?.running).toBe(false)
  })

  it('is the same one action on an empty level', () => {
    expect(decideUnderstandAction(base({ level: 'empty' }))?.label).toBe(UNDERSTAND_LABEL)
  })

  // The label must never say "learn" or "draw" — those were the two names for
  // one act, and keeping either would keep the split alive in the reader's head.
  it('speaks of neither store it writes', () => {
    const action = decideUnderstandAction(base())
    expect(action?.label.toLowerCase()).not.toMatch(/\b(learn|draw)\b/)
  })

  it('says what it will read AND what it costs before it is pressed', () => {
    const action = decideUnderstandAction(base())
    expect(action?.title).toContain('2 modules')
    expect(action?.title).toContain('several minutes')
    // BOTH artifacts, in one sentence — the whole point of the collapse.
    expect(action?.title).toMatch(/what it does/)
    expect(action?.title).toMatch(/how it works/)
  })

  it('counts modules in the singular when there is one', () => {
    expect(decideUnderstandAction(base({ modulePaths: ['a'] }))?.title).toContain('1 module')
  })

  it('offers nothing without a dispatchable identity — null IS the hiding', () => {
    expect(decideUnderstandAction(base({ rootPath: null }))).toBeNull()
    expect(decideUnderstandAction(base({ featureRef: null }))).toBeNull()
    expect(decideUnderstandAction(base({ featureName: null }))).toBeNull()
    expect(decideUnderstandAction(base({ featureName: '   ' }))).toBeNull()
  })

  it('shows a running state naming the feature, busy and unpressable', () => {
    const action = decideUnderstandAction(base({ running: true }))
    expect(action?.label).toBe('Understanding Chats…')
    expect(action?.running).toBe(true)
    expect(action?.disabled).toBe(true)
    expect(action?.title).toContain('several minutes')
  })

  it('disables with the readiness reason while the root is not set up', () => {
    const action = decideUnderstandAction(base({ provisioning: 'provisioning' }))
    expect(action?.label).toBe(UNDERSTAND_LABEL)
    expect(action?.disabled).toBe(true)
    expect(action?.title).toMatch(/still setting this project up/i)
  })

  it('QUEUES behind the feature holding the single caged turn', () => {
    // It used to disable itself here and name who to wait for — an accurate
    // description of the machine and a poor deal for the reader, who then has
    // to watch a pass they do not care about and remember to come back. Worse,
    // any surface that had not been told who held the turn showed a live-
    // looking button that did nothing at all.
    const action = decideUnderstandAction(base({ busyWith: 'Ingest Pipeline' }))
    expect(action?.disabled).toBe(false)
    expect(action?.title).toContain('Ingest Pipeline')
    expect(action?.title).toContain('starts when that finishes')
    expect(action?.running).toBe(false)
  })

  it('says a feature is waiting once it has been queued', () => {
    const queued = decideUnderstandAction(base({ busyWith: 'Ingest Pipeline', queued: true }))
    expect(queued?.label).toContain('queued')
    // Disabled because there is nothing left to ask for — and a reader coming
    // back must not press it again wondering whether the first one took.
    expect(queued?.disabled).toBe(true)
    expect(queued?.running).toBe(false)
    expect(queued?.title).toContain('Ingest Pipeline')
  })

  it('never claims "no code anchored" before anyone looked', () => {
    const pending = decideUnderstandAction(base({ modulePaths: null }))
    expect(pending?.disabled).toBe(true)
    expect(pending?.title).toMatch(/Looking up/)
  })

  // THE OLD `Learn` DISABLED ITSELF HERE, because `#learnFeature` returned
  // early on an empty path list — silently. The pass reads the feature's plan
  // and discovery documents too, and refuses out loud when there is genuinely
  // nothing, so a disabled control would now be hiding a working path.
  it('stays PRESSABLE with no anchored modules, and says what it will read', () => {
    const action = decideUnderstandAction(base({ modulePaths: [] }))
    expect(action?.disabled).toBe(false)
    expect(action?.title).toMatch(/plans and code/)
  })

  it('keeps the last failure beside the action, trimmed — never beside a running one', () => {
    expect(decideUnderstandAction(base({ error: '  no credentials  ' }))?.error).toBe(
      'no credentials',
    )
    expect(decideUnderstandAction(base({ error: '   ' }))?.error).toBeNull()
    expect(decideUnderstandAction(base({ running: true, error: 'old failure' }))?.error).toBeNull()
  })

  // ONE FAMILY, still. The board renders this and the discovery button through
  // the same builder; two shapes here would be the first step back to two
  // loader vocabularies.
  it('reads as the same family as the discovery button', () => {
    const a = decideDiscoveryAction({
      place: 'root',
      rootPath: '/repo',
      provisioning: 'ready',
      fetchFailed: false,
      running: false,
    })
    const b = decideUnderstandAction(base())
    expect(Object.keys(a ?? {}).sort()).toEqual(Object.keys(b ?? {}).sort())
    expect(a?.title).toMatch(/minutes/)
    expect(b?.title).toMatch(/minutes/)
  })
})

/**
 * THE RE-RUN DOOR ON A CURATED LEVEL.
 *
 * This module used to return null here, inheriting "offer it only where there
 * is a gap". A drawing that passed the validator is not a drawing that is still
 * true: MEASURED (#1435) 6 of 29 excerpts across six PASSING views on this
 * machine cite lines that no longer match, within four days of being drawn, and
 * one cites a line that no longer exists at all. Combined with the collapse —
 * a drawn feature reports `learned` — hiding the control left the sequence
 * drawn → learned → drifted → `stale` → nothing to press.
 */
describe('decideUnderstandAction — a curated level offers the re-run', () => {
  const curated = (over: Partial<UnderstandActionInput> = {}): UnderstandActionInput =>
    base({ level: 'curated', ...over })

  it('offers the control, worded as a re-run rather than a first read', () => {
    const action = decideUnderstandAction(curated())
    expect(action).not.toBeNull()
    expect(action?.label).toBe(REDRAW_LABEL)
    expect(action?.disabled).toBe(false)
    // The reader can SEE a drawing; a label offering to make one reads as a
    // control that does nothing, and a control that reads as a no-op is not
    // pressed. The two wordings must differ.
    expect(action?.label).not.toBe(UNDERSTAND_LABEL)
    expect(decideUnderstandAction(base())?.title).not.toBe(action?.title)
  })

  it('says the current drawing is replaced, and that the previous one is kept', () => {
    const action = decideUnderstandAction(curated())
    // `writeFeatureView` renames the existing artifact before writing — the
    // reassurance is a fact about the writer, not a comfort invented here.
    expect(action?.title).toMatch(/replace the drawing that is there now/)
    expect(action?.title).toContain('.prev.json')
    expect(action?.title).toContain('several minutes')
  })

  // THE STRONGEST ARGUMENT THE CONTROL WILL EVER HAVE. The board already knows
  // the code has drifted; withholding it leaves the reader guessing whether a
  // re-run is worth ten minutes.
  it('leads with the reason when the feature is stale', () => {
    const action = decideUnderstandAction(curated({ understanding: 'stale' }))
    expect(action?.title).toMatch(/^Chats’s code has drifted since this was drawn/)
    expect(action?.title).toMatch(/may no longer be true/)
  })

  it('does not argue for itself when nothing says it should', () => {
    for (const understanding of ['learned', 'none', 'learning', undefined] as const) {
      const action = decideUnderstandAction(curated({ understanding }))
      expect(action?.title).not.toMatch(/drifted/)
      expect(action?.disabled).toBe(false)
    }
  })

  it('keeps every refusal and the one running vocabulary', () => {
    expect(decideUnderstandAction(curated({ running: true }))?.running).toBe(true)
    expect(decideUnderstandAction(curated({ running: true }))?.label).toBe('Understanding Chats…')
    const blocked = decideUnderstandAction(curated({ provisioning: 'idle' }))
    expect(blocked?.label).toBe(REDRAW_LABEL)
    expect(blocked?.disabled).toBe(true)
    const busy = decideUnderstandAction(curated({ busyWith: 'Ingest Pipeline' }))
    expect(busy?.label).toBe(REDRAW_LABEL)
    // Live, and honest about the wait: the press queues.
    expect(busy?.disabled).toBe(false)
    expect(busy?.title).toContain('one pass runs at a time')
  })

  it('still offers nothing without a dispatchable identity', () => {
    expect(decideUnderstandAction(curated({ featureRef: null }))).toBeNull()
    expect(decideUnderstandAction(curated({ rootPath: null }))).toBeNull()
  })
})

/**
 * A PART'S LEVEL OFFERS THE SAME ACT.
 *
 * Per-part learning already existed end to end — parts carry `learnings` with a
 * supersede lifecycle and `writeParts` persists them — and the only thing
 * missing was a door. There is exactly ONE existing path to it (`understandFeature`
 * draws the feature's view, then walks every part), so the control targets the
 * part and dispatches the owner, and says so rather than pretending the press
 * is smaller than it is.
 */
describe('decideUnderstandAction — a part', () => {
  const part = (over: Partial<UnderstandActionInput> = {}): UnderstandActionInput =>
    base({
      featureRef: 'feature:chats/sse-events-endpoint',
      featureName: 'SSE events endpoint',
      part: { anchorCount: 3, ownerRef: 'feature:chats', ownerName: 'Chats' },
      ...over,
    })

  it('offers the control on a part, with the right noun', () => {
    const action = decideUnderstandAction(part())
    expect(action).not.toBeNull()
    expect(action?.label).toBe(UNDERSTAND_PART_LABEL)
    expect(action?.label).not.toBe(UNDERSTAND_LABEL)
    expect(action?.disabled).toBe(false)
    expect(action?.running).toBe(false)
  })

  it('counts the PART’s own anchors, not the feature’s resolved modules', () => {
    // `modulePaths` describes the feature; a part's evidence is its anchors.
    const action = decideUnderstandAction(part())
    expect(action?.title).toContain('3 anchors')
    expect(action?.title).not.toContain('2 modules')
    expect(
      decideUnderstandAction(
        part({ part: { anchorCount: 1, ownerRef: 'feature:chats', ownerName: 'Chats' } }),
      )?.title,
    ).toContain('1 anchor')
  })

  // THE PRESS IS BIGGER THAN THE BUTTON. There is no learn-one-part channel;
  // the owner's pass IS the per-part path. A control that spent ten minutes on
  // a larger job than it appeared to offer would be the same class of surprise
  // this module exists to remove.
  it('admits that pressing it runs the owner’s whole pass, and what that costs', () => {
    const action = decideUnderstandAction(part())
    expect(action?.title).toContain('Chats')
    expect(action?.title).toMatch(/every one of its parts/)
    expect(action?.title).toContain('SSE events endpoint')
    expect(action?.title).toContain('several minutes')
  })

  it('dispatches the OWNER — a part id would resolve no feature at all', () => {
    expect(understandTarget(part())).toEqual({
      featureRef: 'feature:chats',
      featureName: 'Chats',
    })
    // …and a feature's level still dispatches itself.
    expect(understandTarget(base())).toEqual({
      featureRef: 'feature:chats',
      featureName: 'Chats',
    })
  })

  it('offers nothing when the part has no resolvable owner — null IS the hiding', () => {
    for (const owner of [{ ownerRef: null }, { ownerName: null }, { ownerName: '  ' }]) {
      const input = part({
        part: { anchorCount: 3, ownerRef: 'feature:chats', ownerName: 'Chats', ...owner },
      })
      expect(understandTarget(input)).toBeNull()
      expect(decideUnderstandAction(input)).toBeNull()
    }
  })

  it('names the PART while the owner’s pass runs, and says whose pass it is', () => {
    const action = decideUnderstandAction(part({ running: true }))
    expect(action?.label).toBe('Understanding SSE events endpoint…')
    expect(action?.running).toBe(true)
    expect(action?.disabled).toBe(true)
    // The pass is not this part's own — a reader who wandered off needs the
    // name of the thing that is actually working.
    expect(action?.title).toContain('Chats')
    expect(action?.title).toContain('several minutes')
  })

  it('keeps every refusal a feature’s level has', () => {
    const blocked = decideUnderstandAction(part({ provisioning: 'provisioning' }))
    expect(blocked?.label).toBe(UNDERSTAND_PART_LABEL)
    expect(blocked?.disabled).toBe(true)
    expect(blocked?.title).toMatch(/still setting this project up/i)

    const busy = decideUnderstandAction(part({ busyWith: 'Ingest Pipeline' }))
    expect(busy?.disabled).toBe(false)
    expect(busy?.title).toContain('one pass runs at a time')
  })

  it('never claims a part anchors nothing before anyone looked', () => {
    const pending = decideUnderstandAction(
      part({ part: { anchorCount: null, ownerRef: 'feature:chats', ownerName: 'Chats' } }),
    )
    expect(pending?.disabled).toBe(true)
    expect(pending?.title).toMatch(/Looking up/)
    // "not read yet" must never borrow the refusal's words.
    expect(pending?.title).not.toContain('names no anchors')
  })

  it('a curated part level offers the re-run wording, not a first read', () => {
    const action = decideUnderstandAction(part({ level: 'curated' }))
    expect(action?.label).toBe(REDRAW_LABEL)
    expect(action?.disabled).toBe(false)
    expect(action?.title).toMatch(/^Re-read/)
    expect(action?.title).toContain('.prev.json')
  })

  it('leads with the drift when the part is stale, and stays quiet otherwise', () => {
    expect(
      decideUnderstandAction(part({ level: 'curated', understanding: 'stale' }))?.title,
    ).toMatch(/^SSE events endpoint’s code has drifted/)
    expect(decideUnderstandAction(part({ level: 'curated' }))?.title).not.toMatch(/drifted/)
  })

  it('stays the same family — no extra keys on the action', () => {
    expect(Object.keys(decideUnderstandAction(part()) ?? {}).sort()).toEqual(
      Object.keys(decideUnderstandAction(base()) ?? {}).sort(),
    )
  })
})

/**
 * THE NO-ANCHOR REFUSAL — the CLI's sentence, not a paraphrase of it.
 *
 * `blueprint features parts` refuses to write a part with no anchors and
 * explains itself in full. Before this, that explanation only ever reached
 * stderr; the level showed nothing. The board's empty states are specific
 * everywhere else, and a generic "couldn't learn this" here would explain
 * strictly less than a sentence that was already written.
 */
describe('a part with no anchors repeats the CLI’s refusal', () => {
  const stranded = (): UnderstandActionInput =>
    base({
      featureRef: 'feature:chats/legacy-poller',
      featureName: 'Legacy poller',
      part: { anchorCount: 0, ownerRef: 'feature:chats', ownerName: 'Chats' },
    })

  it('says it verbatim, and does not offer a press that could never work', () => {
    const action = decideUnderstandAction(stranded())
    expect(action).not.toBeNull()
    expect(action?.title).toBe(partNoAnchorRefusal('Legacy poller'))
    expect(action?.disabled).toBe(true)
    expect(action?.running).toBe(false)
    // Visible, not hidden: a vanished control explains nothing at all.
    expect(action?.label).toBe(UNDERSTAND_PART_LABEL)
  })

  it('gives both halves of the reason — no evidence, and no way to re-check', () => {
    const said = partNoAnchorRefusal('Legacy poller')
    expect(said).toContain("part 'Legacy poller' names no anchors")
    expect(said).toContain('nothing to learn it from')
    expect(said).toContain('nothing to re-check when the code drifts')
  })

  /**
   * THE DRIFT GUARD. Two wordings for one rule is how they stop being one rule,
   * so this reads the CLI's own source and fails the moment the sentences part
   * company. It asserts the template literal as written in `runFeaturesParts`.
   */
  it('is the exact sentence `blueprint features parts` refuses with', () => {
    const cli = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'src', 'cli', 'commands', 'blueprint.ts'),
      'utf8',
    )
    // The CLI builds it from `${name}`; rendering the app's copy with that same
    // placeholder reproduces the literal character for character.
    expect(cli).toContain(partNoAnchorRefusal('${name}'))
  })
})

describe('featureDisplayName — a control that vanishes explains nothing', () => {
  // THE BUG: `decideUnderstandAction` needs a name (the pass is dispatched by
  // name) and the board fed it `brief.delta.identity?.name`, which the contract
  // marks OPTIONAL. A brief with no identity hid the re-learn control entirely
  // — on exactly the levels that have something to re-learn — while the board
  // was holding that name in two other places.
  const stack = [{ id: 'feature:chats', name: 'Chats' }]
  const graph = [{ id: 'feature:chats', name: 'Chats (graph)' }]

  it('prefers what the brief calls it', () => {
    expect(
      featureDisplayName('feature:chats', { fromBrief: 'Chats (brief)', stack, graph }),
    ).toBe('Chats (brief)')
  })

  it('falls back to the node the reader actually drilled into', () => {
    expect(featureDisplayName('feature:chats', { fromBrief: null, stack, graph })).toBe('Chats')
    expect(featureDisplayName('feature:chats', { fromBrief: '   ', stack, graph })).toBe('Chats')
  })

  it('falls back to the graph when the stack does not have it', () => {
    expect(featureDisplayName('feature:chats', { graph })).toBe('Chats (graph)')
  })

  it('is null only when NO source knows — the one honest hide', () => {
    expect(featureDisplayName('feature:ghost', { stack, graph })).toBeNull()
    expect(featureDisplayName(null, { stack, graph })).toBeNull()
    expect(featureDisplayName('feature:chats', {})).toBeNull()
  })

  it('restores the control the missing identity used to hide', () => {
    // End to end through the decision this feeds: a name from ANY source is
    // enough for the action to exist.
    const action = decideUnderstandAction({
      ...base(),
      level: 'curated',
      featureName: featureDisplayName('feature:chats', { fromBrief: null, stack, graph }),
    })
    expect(action).not.toBeNull()
    expect(action?.label).toBe(REDRAW_LABEL)
  })
})
