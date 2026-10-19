// The rule this whole change exists to enforce, made mechanical.
//
// Forbidden pattern #12: no user-visible string may carry a terminal command, a
// file path or a config key. The board's loops strip broke it in the most
// literal way available — "find, fix are paused in their directives — edit the
// files to resume" — and four review agents, a mutation-checked suite and five
// thousand passing tests all walked past it, because the code was internally
// consistent and only the product claim was wrong. A claim no test makes is a
// claim nothing defends, so this file makes it.
//
// TWO CHECKS, ON PURPOSE:
//
//  1. A SOURCE SCAN over the two pure loops models. Every string literal in
//     them is either a value the CLI reads (a relative path handed to an open
//     call) or a sentence a person reads, and the allowlist below is the whole
//     of the first kind — so anything else carrying a path, a flag or a key is
//     copy that leaked internals.
//  2. AN OUTPUT SCAN over what those models actually produce for a project in
//     the exact state that used to trip the rule. The source scan cannot see a
//     sentence assembled from fragments; this one reads the finished string.
//
// The scan is deliberately NOT pointed at the view layers: their literals are
// CSS (`var(--fl-space-md)`) and class names, where `--` is a custom-property
// prefix rather than a CLI flag. The views render what these models decide, so
// the models are where the words are.

import { readFileSync } from 'fs'
import { join } from 'path'

import { loopBarFor } from './loops-panel-model'
import { describeHuntConfig, huntConfigRefusal, huntTargetFor } from './hunt-config'
import { runControlFor, runStartError, runWriteError, threadTitleFor } from './loop-run'
import { huntControlFor } from './hunt-instruction'
import { briefUnavailableText } from '../blueprint/brief-view-model'
import { MAX_HUNT_TEXT_LENGTH } from './hunt-limits'
import {
  buildBoardModel,
  type BoardCard,
  type BoardHunt,
  type BoardQueueGroup,
} from '../tasks/board-model'
import { cardShare, shareOutcome } from '../tasks/board-actions'
import {
  cardChips,
  planBoardRender,
  threadFilterCountLabel,
  threadFilterText,
  CLEAR_FILTERS_LABEL,
  HUNT_FILTER_APPROXIMATE_NOTE,
  HUNT_FILTER_HINT,
} from '../tasks/board-render'
import type {
  LoopFileResult,
  LoopStatusRow,
  LoopsSnapshot,
  TaskSummary,
} from '../../shared/ipc-contract'

/**
 * What a user-visible string may never contain (forbidden pattern #12).
 *
 * `/agent-loop` JOINED THE LIST when the screen grew a Run press. That press
 * BUILDS the command as data (`LoopRunPlan.message`, handed to
 * `threads:sendMessage`, never rendered), and the whole risk of holding a
 * command in a model is that it leaks into a sentence beside it — a title, a
 * consequence line, a thread's name. Naming the token is what makes that leak a
 * red test rather than a thing four reviewers walk past.
 */
const FORBIDDEN = ['planflow-ai', '/agent-loop', 'loops/', '.md', 'paused:', '--']

/**
 * The only literals in these files that are VALUES rather than copy: a
 * repo-relative path handed to the editor's open call. It never reaches a
 * sentence — the button that uses it says what pressing it does.
 *
 * `flow/brain/modules/${slug}.md` is the second, surfaced the moment the scan
 * reached blueprint (#1827). It is the module doc's path, and the popover
 * renders it as a BUTTON that peeks the file — the same affordance the Files
 * rows use. #12 bans a path the reader cannot act on; this one is the thing
 * being acted on, which is the distinction the allowlist exists to hold.
 */
const VALUE_LITERALS = new Set([
  'flow/loops/runs.jsonl',
  // The module doc the blueprint popover peeks (#1827) — the thing being acted
  // on, not a path the reader is told to go and open.
  'flow/brain/modules/${slug}.md',
  // The two halves of a MATCHER over absolute paths arriving from the project's
  // file watcher (`directiveEventsAffectLoops`). Neither is rendered, neither is
  // offered for editing, and neither reaches a sentence — the screen answers a
  // directive change by re-reading, and says nothing at all about it.
  '.md',
  '/loops',
])

const MODEL_FILES = [
  'loops-panel-model.ts',
  // The "keep looking" control, which replaced the loops SCREEN as the place a
  // hunt is configured. Scanned from the day it shipped and for the same reason
  // the description editor was: the thing it configures is a hunt's stop rule,
  // so the easy label for each choice is exactly the leak.
  'hunt-config.ts',
  // NOT `hunt-config-view.ts`, for the reason the header already gives about
  // views: it carries the control's stylesheet, where `--` is a CSS custom
  // property's prefix and not a flag. Its copy is covered by the runtime check
  // below, which is where a view's finished sentences are reachable at all.
]

/**
 * The BLUEPRINT pure models, scanned by the same rule (#1827).
 *
 * The scan was pointed at loops only, and #12 came back on the surface it did
 * not reach: the feature map's empty state handed the reader
 * `blueprint features parts --feature <ref> --write` — a command, a flag and a
 * placeholder, as the whole message — and the brief band's failure state
 * printed the narrate command plus `flow/plans/<plan>.md`.
 *
 * Both are pure models, the same KIND of file this scan already covers, so
 * nothing about the original reasoning excluded them; the list simply stopped
 * at one directory. A guard that only watches where the bug was last found is
 * how the same rule breaks twice.
 *
 * Paths are relative to this file. Views stay excluded for the reason in the
 * header — their literals are CSS custom properties, where `--` is a prefix and
 * not a flag. That is why `#showBriefUnavailable`'s sentence was MOVED into
 * `brief-view-model.ts`: on the board it was unreachable by any mechanical
 * check, and a fix with no guard is the shape this file exists to end.
 */
const BLUEPRINT_MODEL_FILES = [
  '../blueprint/brief-view-model.ts',
  '../blueprint/feature-view-model.ts',
  '../blueprint/popover-model.ts',
  '../blueprint/sync-status-model.ts',
  '../blueprint/limitations-model.ts',
  '../blueprint/drift-panel-model.ts',
  '../blueprint/connections-model.ts',
]

/**
 * The CONVERSATION-HEADER pure models, scanned by the same rule.
 *
 * The autopilot chip reports a run that issues one workflow command after
 * another on somebody's behalf, and names each step in a sentence a person
 * reads. That is the exact shape of leak this file exists to catch: the easy
 * label for "what is it doing" is the command it is about to type. Scanned from
 * the day it shipped, for the reason the blueprint entry above gives — a guard
 * that only watches where the bug was last found is how the same rule breaks
 * twice.
 */
const THREADS_MODEL_FILES = ['../threads/chain-chip.ts', '../threads/chain-chip-popover.ts']

/** Comments are exempt and SHOULD keep naming the real commands — drop them. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n')
}

/** The literals in one scanned file that break the rule. */
function offendingLiteralsIn(file: string): string[] {
  const source = withoutComments(readFileSync(join(__dirname, file), 'utf8'))
  return literalsIn(source)
    .filter((literal) => !VALUE_LITERALS.has(literal))
    .filter((literal) => FORBIDDEN.some((token) => literal.includes(token)))
}

/** Every string / template literal in a source file. */
function literalsIn(source: string): string[] {
  const found: string[] = []
  const pattern = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g
  let match = pattern.exec(source)
  while (match !== null) {
    found.push(match[1] ?? match[2] ?? match[3] ?? '')
    match = pattern.exec(source)
  }
  return found
}

const NOW = Date.parse('2026-08-14T08:00:00.000Z')

/** A snapshot holding exactly these rows — the fields the loop row reads. */
function loopsWith(rows: Partial<LoopStatusRow>[]): LoopsSnapshot {
  return {
    available: true,
    reason: null,
    loops: rows.map((row) => ({ loop: 'x', pause: null, locks: [], queue: null, ...row })) as LoopStatusRow[],
    globalPause: null,
    digest: null,
    generatedAt: null,
  } as LoopsSnapshot
}

function row(overrides: Partial<LoopStatusRow> = {}): LoopStatusRow {
  return {
    loop: 'find',
    pause: null,
    locks: [],
    queue: null,
    ...overrides,
  }
}

function snapshot(overrides: Partial<LoopsSnapshot> = {}): LoopsSnapshot {
  return {
    available: true,
    reason: null,
    loops: [],
    globalPause: null,
    digest: null,
    generatedAt: null,
    ...overrides,
  }
}

function hunt(overrides: Partial<BoardHunt> = {}): BoardHunt {
  return {
    key: 'find ui gaps',
    text: 'find UI gaps',
    loops: ['find'],
    topics: [],
    filed: 20,
    cap: 20,
    quietRuns: 0,
    status: 'capped',
    ageLabel: '3d ago',
    ...overrides,
  }
}

function huntLoops(rows: LoopStatusRow[] = [row()]): LoopsSnapshot {
  return snapshot({ loops: rows })
}




describe('no user-visible string leaks a command, a path or a config key', () => {
  it.each(MODEL_FILES)('%s carries no such literal', (file) => {
    expect(offendingLiteralsIn(file)).toEqual([])
  })

  it.each(BLUEPRINT_MODEL_FILES)('%s carries no such literal', (file) => {
    expect(offendingLiteralsIn(file)).toEqual([])
  })

  it.each(THREADS_MODEL_FILES)('%s carries no such literal', (file) => {
    expect(offendingLiteralsIn(file)).toEqual([])
  })

  it('the board’s loop row says nothing forbidden, in any of its states', () => {
    // THE SURFACE THAT REPLACED THE SCREEN. Everything the loops screen used to
    // say about "is this on, and why not" is now these four fields, and two of
    // them are assembled from text the CLI handed over at runtime (a pause's
    // reason, a snapshot's `reason`) — the shape the source scan above cannot
    // see and the one that has broken this rule before.
    const rows: (LoopsSnapshot | null)[] = [
      null,
      { available: false, reason: "no directive for loop 'fix'", loops: [], globalPause: null, digest: null, generatedAt: null },
      loopsWith([{ loop: 'fix', engine: 'consumer', directivePaused: false }]),
      loopsWith([{ loop: 'fix', engine: 'consumer', directivePaused: true }]),
      loopsWith([
        {
          loop: 'fix',
          engine: 'consumer',
          directivePaused: false,
          pause: { scope: 'loop', reason: 'nothing left in the list — switched off until there is work again', since: '' },
        },
      ]),
      loopsWith([{ loop: 'find', engine: 'producer', directivePaused: false }]),
      loopsWith([
        { loop: 'fix', engine: 'consumer', directivePaused: false },
        { loop: 'drain', engine: 'consumer', directivePaused: false },
      ]),
    ]
    for (const snapshot of rows) {
      const bar = loopBarFor(snapshot)
      for (const token of FORBIDDEN) {
        expect(`${bar.label} ${bar.state} ${bar.title} ${bar.disabledReason ?? ''}`).not.toContain(token)
      }
    }
  })

  it('the "keep looking" control says nothing forbidden either', () => {
    // Its refusals and its one-line description are the whole of what it says,
    // and both are built from what a person typed — including a stop rule,
    // which is free text somebody could paste a path into. The rule is about
    // what WE write, so the check is over the frames, with an innocuous rule.
    const configs = [
      { on: false, kind: 'findings' as const, findings: 5, hours: 2, rule: '' },
      { on: true, kind: 'findings' as const, findings: 5, hours: 2, rule: '' },
      { on: true, kind: 'duration' as const, findings: 5, hours: 24, rule: '' },
      { on: true, kind: 'custom' as const, findings: 5, hours: 2, rule: '' },
      { on: true, kind: 'custom' as const, findings: 5, hours: 2, rule: 'the same bug appears twice' },
    ]
    for (const config of configs) {
      const said = `${describeHuntConfig(config)} ${huntConfigRefusal(config) ?? ''}`
      for (const token of FORBIDDEN) expect(said).not.toContain(token)
    }
    // And the three answers to "which loop would this run as".
    for (const snapshot of [null, loopsWith([]), loopsWith([{ loop: 'a', engine: 'producer' }, { loop: 'b', engine: 'producer' }])]) {
      const target = huntTargetFor(snapshot)
      if (target.ok) continue
      for (const token of FORBIDDEN) expect(target.reason).not.toContain(token)
    }
  })

  it('the brief band’s failure sentence names no command and no path', () => {
    // The board assembles this from a CLI-supplied reason, so the source scan
    // above cannot see the finished string — this reads it, with a reason of
    // the exact shape the CLI really answers with.
    for (const reason of [
      "no compiled story for 'thread-worktrees'",
      'bundled CLI unavailable',
      '',
    ]) {
      const text = briefUnavailableText(reason)
      for (const token of FORBIDDEN) expect(text).not.toContain(token)
    }
  })

  it('says nothing forbidden about a run that cannot start, or one that failed', () => {
    // THE SENTENCES THAT ONLY EXIST AT THE MOMENT SOMEBODY PRESSES RUN. Every
    // state the gate refuses gets its own line, and the two failures a press can
    // end in are assembled from text handed over at runtime — the shape that has
    // escaped every source-literal scan this file has ever run.
    const base = { aim: 'gaps in the feature blueprint', cap: 20 }
    const refusals = [
      "/Users/someone/projects/thing/loops/find.md: unknown frontmatter key 'quee' — " +
        'expected one of loop, engine, paused, mission, scope, slice, queue, repo, path, label',
      'resume requires --loop <name>',
      "instruction 'x' has filed 20 of 20 — stop here and let a person look at what is already " +
        "in the list (to carry on after looking: loop resume --loop find --focus 'x')",
      null,
    ]
    const visible = [
      // Every way the gate refuses, in the order runBlockedReason tests them.
      runControlFor(row({ loop: 'find' }), huntLoops(), base).blockedReason,
      runControlFor(row({ loop: 'find', directivePaused: true }), huntLoops(), base).blockedReason,
      runControlFor(
        row({ loop: 'find', directivePaused: false }),
        snapshot({ globalPause: { scope: 'global', reason: 'deploying', since: '2026-08-14T07:00:00.000Z' } }),
        base,
      ).blockedReason,
      runControlFor(
        row({
          loop: 'find',
          directivePaused: false,
          pause: { scope: 'loop', reason: 'the list is long', since: '2026-08-14T07:00:00.000Z' },
        }),
        huntLoops(),
        base,
      ).blockedReason,
      runControlFor(row({ loop: 'find', directivePaused: false }), huntLoops(), {
        aim: 'x'.repeat(MAX_HUNT_TEXT_LENGTH + 1),
        cap: 20,
      }).blockedReason,
      runControlFor(row({ loop: 'find', directivePaused: false }), huntLoops(), {
        aim: 'anything',
        cap: 0,
      }).blockedReason,
      // The name the thread would get, both with an aim and without one.
      threadTitleFor('find', ''),
      threadTitleFor('find', 'gaps in the feature blueprint'),
      ...refusals.flatMap((reason) => [
        runStartError('find', reason),
        runWriteError('find', reason),
      ]),
    ]
    // Every refusal path really answered — a null here is a case that silently
    // stopped being tested.
    expect(visible.every((text) => text !== null && text.length > 0)).toBe(true)
    for (const text of visible.filter((entry): entry is string => entry !== null)) {
      for (const token of FORBIDDEN) expect(text).not.toContain(token)
    }
  })

  it('never tells the reader to go and edit a file', () => {
    // The two sentences this change deleted, by their substance rather than
    // their spelling: an instruction to open something is not an action.
    const source = MODEL_FILES.map((file) =>
      withoutComments(readFileSync(join(__dirname, file), 'utf8')),
    ).join('\n')
    for (const literal of literalsIn(source)) {
      expect(literal.toLowerCase()).not.toContain('edit the')
      expect(literal.toLowerCase()).not.toContain('directive to resume')
    }
  })

  it('says nothing forbidden in a hunt control\'s reasons either', () => {
    // hunt-instruction.ts is not source-scanned: its doc comments name the real
    // CLI verbs its intents become, so a literal scan there would be all false
    // positives. Its user-visible fields are these, and they get the same rule.
    const rows: LoopStatusRow[] = [row({ loop: 'find', directivePaused: true })]
    const visible = [
      huntControlFor(hunt(), huntLoops(rows)),
      huntControlFor(hunt({ text: 'x'.repeat(MAX_HUNT_TEXT_LENGTH + 1) }), huntLoops()),
      huntControlFor(hunt({ loops: ['find', 'fix'] }), huntLoops()),
      huntControlFor(hunt({ loops: [] }), huntLoops()),
    ].flatMap((control) => [control?.label ?? null, control?.blockedReason ?? null, control?.title ?? null])
    for (const text of visible.filter((entry): entry is string => entry !== null)) {
      for (const token of FORBIDDEN) expect(text).not.toContain(token)
    }
  })

  it('says nothing forbidden in the board\'s filter bar either', () => {
    // THE FIELDS THIS SWEEP DID NOT COLLECT UNTIL PHASE 4. The bar above the
    // columns is assembled in board-render.ts from a model, so no literal scan
    // of the two loops models can see it — and the thread filter added a whole
    // line to it. Both filters' lines get the rule, on every field a person can
    // read: what the board is narrowed to, the caveat, the count and the way out.
    //
    // The thread's TITLE is relayed verbatim and is not this rule's business —
    // it is the reader's own words for their own conversation, exactly as the
    // hunt line relays the sentence the reader typed. What is checked is the
    // frame we write around it, which is why the null-title form is here too.
    const model = buildBoardModel({
      // TWO QUEUES, one of them a LEDGER — because a ledger's location is a
      // FILE PATH, and the heading over its column is where that path used to
      // reach the reader. An empty queue exercises no heading at all, which is
      // how this sweep collected section labels and still caught nothing.
      queue: {
        available: true,
        reason: null,
        state: 'open',
        generatedAt: null,
        loops: [
          {
            loop: 'find',
            queueKind: 'github',
            queueLocation: 'acme/widgets',
            items: [{ id: '1', loop: 'find', title: 'a', fingerprint: '', state: 'open', labels: [], approved: true, body: '', createdAt: '2026-08-15T00:00:00.000Z' }],
          },
          {
            loop: 'ops',
            queueKind: 'ledger',
            queueLocation: 'flow/loops/queue.jsonl',
            items: [{ id: '2', loop: 'ops', title: 'b', fingerprint: '', state: 'open', labels: [], approved: true, body: '', createdAt: '2026-08-15T00:00:00.000Z' }],
          },
        ],
      },
      loops: huntLoops([row({ loop: 'find', topic: 'codemap', instructions: [
        { text: 'find UI gaps', filed: 7, cap: 20, quietRuns: 0, status: 'active', since: '2026-08-11T08:00:00.000Z' },
      ] })]),
      tasks: [],
      now: NOW,
      threadFilter: { threadId: 'th-1', label: 'the board filter' },
    })
    const plan = planBoardRender(model)
    const visible = [
      plan.threadFilter?.text ?? null,
      plan.threadFilter?.note ?? null,
      plan.threadFilter?.countLabel ?? null,
      plan.threadFilter?.clearLabel ?? null,
      threadFilterText(null),
      threadFilterCountLabel(0, 3),
      threadFilterCountLabel(2, 0),
      HUNT_FILTER_APPROXIMATE_NOTE,
      HUNT_FILTER_HINT,
      CLEAR_FILTERS_LABEL,
      // THE HEADING OVER A COLUMN, which this sweep never collected until a
      // ledger queue was pointed at it: the group label was the raw location,
      // and a ledger's location is a file path. Every lane's every section, so
      // a heading can never quietly become a path again.
      ...plan.lanes.flatMap((lane) => lane.sections.map((section) => section.label)),
      ...plan.lanes.flatMap((lane) => lane.sections.map((section) => section.note)),
    ]
    for (const text of visible.filter((entry): entry is string => entry !== null)) {
      for (const token of FORBIDDEN) expect(text).not.toContain(token)
    }
  })

  it('says nothing forbidden on the card that goes to the shared list either', () => {
    // THE FIELDS THIS SWEEP DID NOT COLLECT UNTIL PHASE 5, and the ones likeliest
    // to break the rule of anything added since it was written: the share control
    // is the only place in the app that runs a WRITE verb against somebody else's
    // list, so every sentence it can produce is either the app's own words or a
    // CLI refusal handed over at runtime — and `loop file` refuses with three
    // shapes, one of which (`file requires --loop <name>`) carries a flag with no
    // backticks and no path for the existing cleaners to anchor on.
    //
    // Collected here as WHOLE OBJECTS rather than as the two or three fields that
    // looked interesting: the last two blind spots were both a field somebody
    // decided not to collect.
    const shareCard: BoardCard = {
      key: 'task:mirror-1',
      title: 'run the tests',
      origin: 'assistant',
      lane: 'todo',
      taskId: 'mirror-1',
      itemId: null,
      queueKey: null,
      loop: null,
      url: null,
      prUrl: null,
      attention: false,
      blockedReason: null,
      heldBy: null,
      missingReason: null,
      ageLabel: '2d ago',
      autoFix: false,
      threadStatus: null,
    backgroundTasks: 0,
    }
    const shareTask: TaskSummary = {
      id: 'mirror-1',
      projectRoot: '/repo',
      title: 'run the tests',
      source: 'manual',
      externalKey: 'th-abc#run the tests',
      externalUrl: null,
      lane: 'todo',
      suggestDone: false,
      threadId: null,
      originThreadId: 'th-abc',
      description: null,
      images: null,
      autoFix: false,
      prUrl: null,
      brief: null,
      briefStatus: 'idle',
      archivedAt: null,
      createdAt: '2026-08-14T12:00:00.000Z',
      updatedAt: '2026-08-14T12:00:00.000Z',
    }
    const listGroup = (overrides: Partial<BoardQueueGroup> = {}): BoardQueueGroup => ({
      key: 'github::acme/widgets',
      kind: 'github',
      location: 'acme/widgets',
      label: 'acme/widgets',
      loops: ['fix'],
      readable: true,
      reason: null,
      todo: [],
      ...overrides,
    })
    // Every state the control has: offered, no list, two lists, two producers on
    // one list, a list nothing reads.
    const controls = [
      cardShare(shareCard, shareTask, [listGroup()]),
      cardShare(shareCard, shareTask, []),
      cardShare(shareCard, shareTask, [listGroup(), listGroup({ key: 'ledger::flow/loops/queue.jsonl', kind: 'ledger', location: 'flow/loops/queue.jsonl', label: 'flow/loops/queue.jsonl' })]),
      cardShare(shareCard, shareTask, [listGroup({ loops: ['find', 'fix'] })]),
      cardShare(shareCard, shareTask, [listGroup({ loops: [] })]),
    ]
    // And every answer the write can come back with, including the four refusals
    // the CLI can really produce for this verb — verbatim shapes, not sentences
    // chosen to pass.
    const answers: LoopFileResult[] = [
      { ok: true, reason: null, status: 'filed' },
      { ok: true, reason: null, status: 'duplicate' },
      { ok: true, reason: null, status: null },
      { ok: false, reason: 'file requires --loop <name>', status: null },
      {
        ok: false,
        reason:
          "no directive for loop 'fix' at /Users/someone/thing/flow/loops/fix.md or " +
          '/Users/someone/vault/loops/fix.md',
        status: null,
      },
      {
        ok: false,
        reason:
          "instruction 'find UI gaps' has filed 20 of 20 — stop here and let a person look at " +
          "what is already in the list (to carry on after looking: loop resume --loop find --focus 'find UI gaps')",
        status: null,
      },
      {
        ok: false,
        reason:
          'held by @rival since Tuesday — release it with `planflow-ai loop unclaim --loop fix --id 1533`',
        status: null,
      },
      { ok: false, reason: null, status: null },
    ]
    const visible = [
      ...controls.flatMap((control) => [
        control?.label ?? null,
        control?.blockedReason ?? null,
        control?.listLabel ?? null,
      ]),
      ...answers.flatMap((answer) => {
        const outcome = shareOutcome('run the tests', 'acme/widgets', answer)
        return [outcome.note, outcome.notice.title, outcome.notice.body]
      }),
      // The chip itself — the sixth origin word, which a person reads on the
      // card and again in its hover text.
      ...cardChips(shareCard).flatMap((chip) => [chip.text, chip.title]),
    ]
    for (const text of visible.filter((entry): entry is string => entry !== null)) {
      for (const token of FORBIDDEN) expect(text).not.toContain(token)
    }
    // A LIST WHOSE NAME IS ITSELF A PATH is the one case the rule cannot fix by
    // rewording, and it is not this rule's business for the same reason a
    // thread's title is not: it is the user's own name for their own list,
    // relayed. What is checked above is the frame written around it — which is
    // why the two-list reason, the only sentence that would have quoted it, is
    // asserted here to be about the ambiguity rather than about the location.
    expect(controls[2]?.blockedReason).toContain('more than one list')
  })

})
