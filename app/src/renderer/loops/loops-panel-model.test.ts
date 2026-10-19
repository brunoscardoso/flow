import {
  approvalFor,
  buildLoopsStrip,
  buildRow,
  CYCLE_LOG_RELPATH,
  heldSlots,
  controlFor,
  directiveControlFor,
  digestLineFor,
  digestWindowLabel,
  dotStateFor,
  relativeAge,
  runningCountFor,
  shouldPollLoops,
  switchLoops,
  LOOPS_OPEN,
} from './loops-panel-model'
import type { LoopDigest, LoopStatusRow, LoopsSnapshot } from '../../shared/ipc-contract'

const NOW = Date.parse('2026-08-12T08:00:00.000Z')
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString()

function row(overrides: Partial<LoopStatusRow> = {}): LoopStatusRow {
  return {
    loop: 'find',
    pause: null,
    locks: [],
    queue: {
      open: 3,
      closed: 9,
      claimed: 0,
      awaitingApproval: 0,
      parked: 0,
      claimable: 3,
      maxOpenIssues: 8,
      capReached: false,
    },
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
    generatedAt: iso(0),
    ...overrides,
  }
}

describe('relativeAge', () => {
  it('reports one coarse unit', () => {
    expect(relativeAge(iso(30_000), NOW)).toBe('just now')
    expect(relativeAge(iso(4 * 60_000), NOW)).toBe('4m ago')
    expect(relativeAge(iso(3 * 3_600_000), NOW)).toBe('3h ago')
    expect(relativeAge(iso(2 * 86_400_000), NOW)).toBe('2d ago')
  })

  it('is null for absent or unparseable input — absent stays absent', () => {
    expect(relativeAge(undefined, NOW)).toBeNull()
    expect(relativeAge('', NOW)).toBeNull()
    expect(relativeAge('not a date', NOW)).toBeNull()
  })
})

describe('dotStateFor', () => {
  it('is active only while a lock is actually held', () => {
    const held = row({ locks: [{ owner: 'beat-1', slot: 1, acquiredAt: iso(60_000), expiresAt: iso(-60_000) }] })
    expect(dotStateFor(held, NOW)).toBe('active')
    // An EXPIRED lock is not a running beat — the loop died mid-beat and the
    // lock outlived it. Painting that as active is how a dead loop looks busy.
    const expired = row({ locks: [{ owner: 'beat-1', slot: 1, acquiredAt: iso(600_000), expiresAt: iso(60_000) }] })
    expect(dotStateFor(expired, NOW)).toBe('idle')
  })

  it('reports a running loop as active — the regression a mirrored type allowed', () => {
    // The CLI began emitting `locks` when concurrency landed; this file kept
    // reading `lock`, so the bridge parsed a missing field to null and every
    // RUNNING loop drew as idle. No crash, no warning — a control centre quietly
    // disagreeing with the thing it controls.
    const running = row({
      locks: [{ owner: 'run-a', slot: 1, acquiredAt: iso(60_000), expiresAt: iso(-60_000) }],
    })
    expect(dotStateFor(running, NOW)).toBe('active')
    expect(heldSlots(running, NOW)).toBe(1)
  })

  it('counts only the slots still held', () => {
    const mixed = row({
      locks: [
        { owner: 'live', slot: 1, acquiredAt: iso(60_000), expiresAt: iso(-60_000) },
        { owner: 'expired', slot: 2, acquiredAt: iso(600_000), expiresAt: iso(60_000) },
      ],
    })
    expect(heldSlots(mixed, NOW)).toBe(1)
  })

  it('says how many runs are in flight once a loop can have more than one', () => {
    // "working" alone cannot tell a person whether the loop is at capacity or
    // has room for the next beat.
    const two = buildRow(
      row({
        locks: [
          { owner: 'run-a', slot: 1, acquiredAt: iso(60_000), expiresAt: iso(-60_000) },
          { owner: 'run-b', slot: 2, acquiredAt: iso(30_000), expiresAt: iso(-60_000) },
        ],
        queue: { open: 9, closed: 0, claimed: 2, awaitingApproval: 0, parked: 0, claimable: 7, maxOpenIssues: 20, capReached: false },
      }),
      NOW,
    )
    expect(two.stage).toBe('working ×2')
    // ONE COMPUTATION, TWO READERS (#1627). `detail` opens with the same stage
    // word the `stage` field carries; they were derived by two separate calls,
    // which is two sites to edit and one of them to forget. The slot suffix is
    // the part that drifts most cheaply, so it is what this pins.
    expect(two.detail.startsWith(`${two.stage} · `)).toBe(true)
  })

  it('ranks paused above active', () => {
    const pause = { scope: 'loop' as const, reason: 'stop', since: iso(60_000) }
    const locks = [{ owner: 'b', slot: 1, acquiredAt: iso(60_000), expiresAt: iso(-60_000) }]
    expect(dotStateFor(row({ pause, locks }), NOW)).toBe('paused')
    expect(dotStateFor(row({ locks }), NOW)).toBe('active')
    expect(dotStateFor(row(), NOW)).toBe('idle')
  })

  it('counts a directive-file pause as paused', () => {
    expect(dotStateFor(row({ directivePaused: true }), NOW)).toBe('paused')
  })
})

describe('buildRow', () => {
  it('renders the hunting row from the design sheet', () => {
    const built = buildRow(
      row({
        mission: 'hunt for real defects',
        locks: [{ owner: 'beat-1', slot: 1, acquiredAt: iso(60_000), expiresAt: iso(-60_000) }],
        lastRunAt: iso(4 * 60_000),
      }),
      NOW,
    )
    expect(built.dot).toBe('active')
    expect(built.stage).toBe('hunting')
    expect(built.detail).toBe('hunting · 3/8 open · 4m ago')
    expect(built.control.action).toBe('pause')
    expect(built.control.glyph).toBe('⏸')
    expect(built.attention).toBe(false)
  })

  it('says `working` once an item is in hand', () => {
    const built = buildRow(
      row({
        loop: 'fix',
        locks: [{ owner: 'beat-2', slot: 1, acquiredAt: iso(60_000), expiresAt: iso(-60_000) }],
        queue: {
          open: 1,
          closed: 4,
          claimed: 1,
          awaitingApproval: 0,
          parked: 0,
          claimable: 0,
          maxOpenIssues: 8,
          capReached: false,
        },
        lastRunAt: iso(12 * 60_000),
      }),
      NOW,
    )
    expect(built.stage).toBe('working')
    expect(built.detail).toBe('working · 1/8 open · 12m ago')
  })

  it('renders the paused-needing-approval row, with a resume control', () => {
    const built = buildRow(
      row({
        loop: 'improve',
        pause: { scope: 'loop', reason: 'needs approval', since: iso(3_600_000) },
        queue: {
          open: 2,
          closed: 0,
          claimed: 0,
          awaitingApproval: 2,
          parked: 0,
          claimable: 0,
          maxOpenIssues: 8,
          capReached: false,
        },
      }),
      NOW,
    )
    expect(built.dot).toBe('paused')
    expect(built.detail).toBe('paused — needs approval · 2/8 open · needs approval ×2')
    expect(built.control).toEqual({
      action: 'resume',
      label: 'Resume',
      glyph: '▶',
      loop: 'improve',
      scope: 'runtime',
      disabled: false,
      disabledReason: null,
    })
  })

  it('reserves amber for a pending approval, nothing else', () => {
    expect(buildRow(row(), NOW).attention).toBe(false)
    expect(
      buildRow(row({ pause: { scope: 'loop', reason: 'later', since: iso(1) } }), NOW).attention,
    ).toBe(false)
    expect(
      buildRow(
        row({
          queue: {
            open: 1,
            closed: 0,
            claimed: 0,
            awaitingApproval: 1,
            parked: 0,
            claimable: 0,
            maxOpenIssues: 8,
            capReached: false,
          },
        }),
        NOW,
      ).attention,
    ).toBe(true)
  })

  it('carries the topic through from the CLI, and derives nothing when there is none', () => {
    // The SAME field `loop status --human` puts in its bracket. The panel does
    // not read the directive, and does not substitute the engine for a loop
    // that named no topic — that would be the second answer this panel is a
    // view precisely to avoid.
    expect(buildRow(row({ topic: 'codemap' }), NOW).topic).toBe('codemap')
    expect(buildRow(row({ engine: 'producer' }), NOW).topic).toBeNull()
    expect(buildRow(row({ topic: '  ' }), NOW).topic).toBeNull()
  })

  it('shows an unreadable queue as unreadable, never as zero', () => {
    // "0 open" tells the reader the loop has nothing to do. "queue unreadable"
    // tells them nobody could find out. These are different facts.
    const built = buildRow(row({ queue: null, queueError: 'gh: could not resolve host' }), NOW)
    expect(built.detail).toContain('queue unreadable')
    expect(built.detail).not.toContain('0 open')
    expect(built.error).toBe('gh: could not resolve host')
  })

  it('carries a directive error verbatim and still renders the row', () => {
    const built = buildRow(row({ queue: null, directiveError: "missing key 'mission'" }), NOW)
    expect(built.loop).toBe('find')
    expect(built.error).toBe("missing key 'mission'")
  })

  it('marks a queue at its cap', () => {
    const built = buildRow(
      row({
        queue: {
          open: 8,
          closed: 0,
          claimed: 0,
          awaitingApproval: 0,
          parked: 0,
          claimable: 0,
          maxOpenIssues: 8,
          capReached: true,
        },
      }),
      NOW,
    )
    expect(built.detail).toContain('8/8 open (cap)')
  })
})

describe('controlFor', () => {
  it('resumes a GLOBALLY paused loop globally', () => {
    // A per-loop resume only lifts that loop's own pause; the global
    // pause survives it. A row-scoped resume here is a button that reports
    // success and changes nothing the user can see.
    const control = controlFor(
      row({ pause: { scope: 'global', reason: 'all stop', since: iso(60_000) } }),
    )
    expect(control.action).toBe('resume')
    expect(control.loop).toBe('')
    expect(control.label).toBe('Resume all loops')
    expect(control.scope).toBe('runtime')
  })

  it('offers a REAL directive switch instead of a dead button and a file to edit', () => {
    // The pause lives in the loop's own committed directive. It used to have no
    // control at all — a disabled button carrying the path to open, which is
    // forbidden pattern #12 exactly. The CLI now has a verb for it, so the
    // control is live and addresses the directive's own scope.
    const control = controlFor(row({ loop: 'improve', directivePaused: true }))
    expect(control.disabled).toBe(false)
    expect(control.disabledReason).toBeNull()
    expect(control.action).toBe('resume')
    expect(control.scope).toBe('directive')
    expect(control.loop).toBe('improve')
    expect(control.label).toBe('Turn on improve')
  })

  it('prefers the state pause over the directive flag when both are set', () => {
    // TWO FACTS, AND THE PRESS ONLY LIFTS ONE. A loop stopped both ways gets the
    // runtime control, because that is the stop a resume actually clears — the
    // directive switch stays where a person configures it, not where they
    // unstick a five-minute pause.
    const control = controlFor(
      row({ directivePaused: true, pause: { scope: 'loop', reason: 'x', since: iso(1) } }),
    )
    expect(control.disabled).toBe(false)
    expect(control.loop).toBe('find')
    expect(control.scope).toBe('runtime')
  })

  it('switches a running loop OFF at the directive, never at the runtime pause', () => {
    const control = directiveControlFor(row({ loop: 'fix' }))
    expect(control).toMatchObject({
      action: 'pause',
      scope: 'directive',
      loop: 'fix',
      label: 'Turn off fix',
      disabled: false,
    })
  })
})

describe('approvalFor', () => {
  const gated = (ids?: string[]): LoopStatusRow =>
    row({
      loop: 'improve',
      queue: {
        open: 2,
        closed: 0,
        claimed: 0,
        awaitingApproval: 2,
        parked: 0,
        claimable: 0,
        maxOpenIssues: 8,
        capReached: false,
      },
      ...(ids === undefined ? {} : { awaitingApprovalIds: ids }),
    })

  it('is null when nothing is waiting', () => {
    expect(approvalFor(row())).toBeNull()
    expect(buildRow(row(), NOW).approval).toBeNull()
  })

  it('is actionable once the CLI names the waiting items', () => {
    const approval = approvalFor(gated(['1502', '1503']))
    expect(approval).toEqual({
      count: 2,
      label: 'Approve 2 items',
      ids: ['1502', '1503'],
      actionable: true,
      blockedReason: null,
    })
  })

  it('still renders — but is NOT pressable — when only a count is reported', () => {
    // Today's `loop status` emits counts, not ids, and `loop approve` needs an
    // --id. The affordance shows the state and points at the CLI rather than
    // offering a button with nothing to name; the app must not go read the
    // queue itself to find the ids, which is the second-source-of-truth this
    // whole panel exists to avoid.
    const approval = approvalFor(gated())
    expect(approval?.count).toBe(2)
    expect(approval?.actionable).toBe(false)
    expect(approval?.ids).toEqual([])
    // NO COMMAND IN A SENTENCE A PERSON READS — the reason says what the reader
    // can see (the count is known, the items are not) rather than handing them a
    // terminal invocation to finish the job by hand.
    expect(approval?.blockedReason).not.toContain('planflow-ai')
    expect(approval?.blockedReason).not.toContain('--id')
    expect(approval?.blockedReason).toContain('waiting for approval')
  })

  it('singularises one item', () => {
    const one = approvalFor(
      row({
        queue: {
          open: 1,
          closed: 0,
          claimed: 0,
          awaitingApproval: 1,
          parked: 0,
          claimable: 0,
          maxOpenIssues: 8,
          capReached: false,
        },
        awaitingApprovalIds: ['7'],
      }),
    )
    expect(one?.label).toBe('Approve 1 item')
  })
})

describe('digest line', () => {
  const digest = (overrides: Partial<LoopDigest> = {}): LoopDigest => ({
    entries: 12,
    beats: 8,
    success: 6,
    failure: 2,
    filed: 6,
    closed: 4,
    breakerTrips: 1,
    pauses: 0,
    resumes: 0,
    approvals: 0,
    since: iso(8 * 3_600_000),
    until: iso(0),
    ...overrides,
  })

  it('labels the window the digest ACTUALLY covers', () => {
    expect(digestWindowLabel(digest())).toBe('last 8h')
    expect(digestWindowLabel(digest({ since: iso(45 * 60_000) }))).toBe('last 45m')
    expect(digestWindowLabel(digest({ since: iso(3 * 86_400_000) }))).toBe('last 3d')
    // No window reported → say nothing about one rather than invent "8h".
    expect(digestWindowLabel(digest({ since: undefined }))).toBe('so far')
  })

  it('rolls filed / fixed / breaker trips into one line', () => {
    expect(digestLineFor(digest())).toBe('last 8h: 6 filed · 4 fixed · 1 breaker trip')
    expect(digestLineFor(digest({ breakerTrips: 3 }))).toContain('3 breaker trips')
    expect(digestLineFor(digest({ approvals: 2 }))).toContain('2 approvals')
  })

  it('drops zero segments, and the whole line when there is nothing to say', () => {
    expect(digestLineFor(digest({ filed: 0 }))).toBe('last 8h: 4 fixed · 1 breaker trip')
    expect(digestLineFor(digest({ filed: 0, closed: 0, breakerTrips: 0 }))).toBeNull()
    expect(digestLineFor(digest({ entries: 0 }))).toBeNull()
    expect(digestLineFor(null)).toBeNull()
  })
})

// `buildLoopsViewModel` and its suite are GONE with the panel it modelled. The
// loops screen builds its cards from `buildRow` / `digestLineFor`, which are
// covered above; the deleted function's remaining tests only proved that a model
// nobody renders still assembles.

// ── The board's header strip (loops-on-the-board, Phase 7, Task 7.3) ─────

describe('buildLoopsStrip — one card, not a row of parts', () => {
  it('the control is the DIRECTIVE switch, in both directions — the runtime global scope no longer drives it (loops-pause-all-unify)', () => {
    // THIS TEST USED TO ASSERT THE OLD RUNTIME-BASED CONTROL: a label of
    // 'Resume all'/'Pause all' derived from `snapshot.globalPause`. That control
    // is GONE (`globalControlFor` was removed) — `buildLoopsStrip`'s `control`
    // field is now exactly `projectSwitchFor(snapshot)`, the same
    // reachable-loops/`anyOff` computation the Loops screen's own project
    // switch uses (see loops-screen-model.test.ts's "projectSwitchFor — one
    // press, one write per loop" suite), driven by each row's own
    // `directivePaused` field rather than the snapshot's runtime pause.
    const anyOff = buildLoopsStrip(
      snapshot({
        loops: [row({ loop: 'find', directivePaused: true })],
        // A RUNTIME pause can still be standing at the same time — it is a
        // SEPARATE fact (state.json vs. the directive file), and the control
        // beside it must not claim to lift it: `state` still reports it, but
        // `control` reads only the directive.
        globalPause: { scope: 'global', reason: 'deploying', since: iso(60_000) },
      }),
    )
    expect(anyOff.control).toMatchObject({
      action: 'resume',
      loop: '',
      scope: 'directive',
      disabled: false,
      label: 'Turn them all on',
      loops: ['find'],
    })
    expect(anyOff.state).toBe('All paused — deploying')

    const allOn = buildLoopsStrip(snapshot({ loops: [row({ loop: 'find', directivePaused: false })] }))
    expect(allOn.control).toMatchObject({
      action: 'pause',
      loop: '',
      scope: 'directive',
      disabled: false,
      label: 'Turn them all off',
      loops: ['find'],
    })
    expect(allOn.state).toBe('1 of 1 running')
  })

  it('counts what is RUNNING, not what is switched on', () => {
    // The card's whole job is "is anything happening here" — a loop stopped in
    // either way is not.
    const strip = buildLoopsStrip(
      snapshot({
        loops: [
          row({ loop: 'find', directivePaused: false }),
          row({ loop: 'fix', directivePaused: true }),
          row({
            loop: 'ops',
            directivePaused: false,
            pause: { scope: 'loop', reason: 'x', since: iso(1) },
          }),
        ],
      }),
    )
    expect(strip.state).toBe('1 of 3 running')
  })

  it('does not call an unreadable loop running', () => {
    // THREE STATES, NOT TWO: `directivePaused` is ABSENT when the settings could
    // not be read at all, and the CLI's own gate throws before such a loop ever
    // beats. `!== true` would have reported it as running, which is the one
    // thing certainly false about it.
    expect(buildLoopsStrip(snapshot({ loops: [row()] })).state).toBe('None of the 1 are running')
    expect(runningCountFor(snapshot({ loops: [row()] }))).toBe(0)
  })

  it('says so plainly when the project has no loops', () => {
    expect(buildLoopsStrip(snapshot({ loops: [] })).state).toBe('No loops in this project yet')
  })

  it('never shows the count beside a project-wide stop', () => {
    // The two would contradict each other: a globally paused project has loops
    // that are switched on and going nowhere. One sentence, and it is the one
    // that decides what happens next.
    const strip = buildLoopsStrip(
      snapshot({
        loops: [row({ loop: 'find', directivePaused: false }), row({ loop: 'fix', directivePaused: false })],
        globalPause: { scope: 'global', reason: '', since: iso(60_000) },
      }),
    )
    expect(strip.state).toBe('All paused')
    expect(strip.state).not.toContain('running')
  })

  it('is exactly a name, a state, one press and a fail-soft line', () => {
    // The per-loop switches and their caveat stay gone. They said something true
    // — "resuming above will not start it" — in a vocabulary the reader has no
    // reason to own; the screen has room to explain the consequence instead.
    const strip = buildLoopsStrip(
      snapshot({
        loops: [row({ loop: 'find', directivePaused: true }), row({ loop: 'fix', directivePaused: false })],
        globalPause: { scope: 'global', reason: 'deploying', since: iso(60_000) },
      }),
    )
    expect(strip.open).toEqual(LOOPS_OPEN)
    expect(strip.open.label).toBe('Loops')
    expect(Object.keys(strip).sort()).toEqual(['control', 'notice', 'open', 'state'])
  })

  it('keeps a present-but-dead control when nobody could read the loops — and the door', () => {
    // An absent control reads as "this project has no loops"; an unreadable one
    // is not that. The way in stays too: the screen is where a reader finds out
    // what a loop even is, and a failed read is no reason to withhold that.
    const strip = buildLoopsStrip(snapshot({ available: false, reason: 'bundled CLI unavailable' }))
    expect(strip.control.disabled).toBe(true)
    expect(strip.control.disabledReason).toBe('bundled CLI unavailable')
    expect(strip.state).toBe("Couldn't read the loops here")
    expect(strip.notice).toBe('bundled CLI unavailable')
    expect(strip.open).toEqual(LOOPS_OPEN)

    const none = buildLoopsStrip(null)
    expect(none.control.disabled).toBe(true)
    expect(none.notice).toBe('loops unavailable')
    expect(none.open).toEqual(LOOPS_OPEN)
  })

  it('points at the log the CLI actually writes', () => {
    expect(CYCLE_LOG_RELPATH).toBe('flow/loops/runs.jsonl')
  })

  it('still computes the digest line the modal now shows', () => {
    // The line moved off the strip and onto the modal; the computation is
    // unchanged and shared, so this stays as its guard.
    const digest: LoopDigest = {
      entries: 4,
      beats: 4,
      success: 4,
      failure: 0,
      filed: 6,
      closed: 4,
      breakerTrips: 0,
      pauses: 0,
      resumes: 0,
      approvals: 0,
      since: iso(8 * 3_600_000),
      until: iso(0),
    }
    expect(digestLineFor(digest)).toBe('last 8h: 6 filed · 4 fixed')
  })
})

// ── The shared write orchestration (loops-pause-all-unify, Phase 1) ──────
//
// `switchLoops` is the one loop both the board's strip and the Loops screen's
// `#switchEveryLoop` call — `#switchEveryLoop` used to have its own inline
// copy of exactly this (allowed-pattern #14). It is tested here, ONCE, rather
// than once per caller: the write function is injected, so no DOM and no IPC
// mock are needed to prove the orchestration itself is correct.

describe('switchLoops — the shared write orchestration', () => {
  it('writes every loop once, in order, when nothing is refused', async () => {
    const setDirectivePaused = jest.fn().mockResolvedValue({ ok: true })
    const { refused } = await switchLoops(['find', 'fix', 'improve'], true, { setDirectivePaused })
    expect(refused).toEqual([])
    expect(setDirectivePaused).toHaveBeenCalledTimes(3)
    // ORDER MATTERS: a caller reporting "which loops failed" relies on this
    // being the CLI's own loop order, not an arbitrary one.
    expect(setDirectivePaused).toHaveBeenNthCalledWith(1, { loop: 'find', paused: true })
    expect(setDirectivePaused).toHaveBeenNthCalledWith(2, { loop: 'fix', paused: true })
    expect(setDirectivePaused).toHaveBeenNthCalledWith(3, { loop: 'improve', paused: true })
  })

  it('keeps the writes that succeeded when one is refused — nothing rolled back', async () => {
    const setDirectivePaused = jest.fn(({ loop }: { loop: string; paused: boolean }) =>
      Promise.resolve(loop === 'fix' ? { ok: false, reason: 'the file is read-only' } : { ok: true }),
    )
    const { refused } = await switchLoops(['find', 'fix', 'improve'], false, { setDirectivePaused })
    // Only the refused loop is named — the OTHER two writes still happened;
    // undoing them would be a write nobody asked for (see loops-panel-model.ts's
    // own comment on `switchLoops`).
    expect(refused).toEqual(['fix'])
    expect(setDirectivePaused).toHaveBeenCalledTimes(3)
    expect(setDirectivePaused).toHaveBeenNthCalledWith(1, { loop: 'find', paused: false })
    expect(setDirectivePaused).toHaveBeenNthCalledWith(3, { loop: 'improve', paused: false })
  })

  it('treats a REJECTED write exactly like an {ok:false} result — never an unhandled rejection', async () => {
    // The screen and the board both pass a real IPC call as this dependency;
    // an IPC round trip can reject (a timeout, a dropped process) as easily as
    // it can resolve `{ ok: false }`. The loop must catch either the same way,
    // or a single rejection would abort every write still queued behind it.
    const setDirectivePaused = jest.fn(({ loop }: { loop: string; paused: boolean }) =>
      loop === 'fix' ? Promise.reject(new Error('IPC timed out')) : Promise.resolve({ ok: true }),
    )
    const { refused } = await switchLoops(['find', 'fix', 'improve'], true, { setDirectivePaused })
    expect(refused).toEqual(['fix'])
    // The write AFTER the rejection still ran.
    expect(setDirectivePaused).toHaveBeenCalledTimes(3)
    expect(setDirectivePaused).toHaveBeenNthCalledWith(3, { loop: 'improve', paused: true })
  })

  it('writes nothing and refuses nothing for an empty loop list', async () => {
    const setDirectivePaused = jest.fn().mockResolvedValue({ ok: true })
    const { refused } = await switchLoops([], true, { setDirectivePaused })
    expect(refused).toEqual([])
    expect(setDirectivePaused).not.toHaveBeenCalled()
  })
})

describe('shouldPollLoops — poll only what someone can see (#1640)', () => {
  it('spends nothing while the window is hidden', () => {
    expect(shouldPollLoops({ documentHidden: true, paneVisible: true })).toBe(false)
  })

  it('spends nothing while the loops pane is display:none', () => {
    expect(shouldPollLoops({ documentHidden: false, paneVisible: false })).toBe(false)
  })

  it('polls when the pane is actually in front of someone', () => {
    expect(shouldPollLoops({ documentHidden: false, paneVisible: true })).toBe(true)
  })
})
