/**
 * Tests for the producer instruction store.
 *
 * Two properties carry the weight, and both are about a hunt that OUTLIVES the
 * run that started it — which is the only reason this store exists at all:
 *
 *   1. THE COUNT SURVIVES A RUN BOUNDARY. "Keep looking until 20" is
 *      unanswerable if each run counts from zero.
 *   2. STOPPING SAYS WHY. `stopped`, `dry` and `capped` are three different
 *      facts, and a reader deciding whether to go and look themselves needs to
 *      know which one happened.
 *
 * Pure — the transforms take a store and return one, so the cap and the
 * dry-detection are provable without touching a filesystem.
 */

import type { InstructionStore } from './instructions.js';

const { writeFileSync } = await import('node:fs');

const {
  DEFAULT_INSTRUCTION_CAP,
  DRY_RUNS,
  emptyInstructions,
  findInstruction,
  instructionKey,
  instructionRoom,
  readInstructions,
  readInstructionsResult,
  recordInstructionRun,
  resolveInstructionStop,
  instructionStopReached,
  describeInstructionStop,
  meetInstruction,
  MAX_INSTRUCTION_STOP_HOURS,
  MAX_INSTRUCTION_STOP_RULE_LENGTH,
  serializeInstructions,
  forgetInstruction,
  startInstruction,
  stopInstruction,
  writeInstructions,
} = await import('./instructions.js');

const NOW = '2026-08-13T10:00:00.000Z';
const HUNT = 'find gaps on the feature blueprint';

/** Start a hunt and run it N times, filing `filed` each time. */
function hunt(filedPerRun: readonly number[], cap = DEFAULT_INSTRUCTION_CAP) {
  let store = startInstruction(emptyInstructions(), HUNT, NOW, cap).store;
  for (const filed of filedPerRun) store = recordInstructionRun(store, HUNT, filed, NOW);
  return store;
}

describe('a hunt that outlives its run', () => {
  it('carries its count across run boundaries', () => {
    const store = hunt([4, 3, 2]);
    expect(findInstruction(store, HUNT)?.filed).toBe(9);
  });

  it('resumes rather than restarting when the same sentence is typed again', () => {
    const first = hunt([4]);
    const { store, instruction } = startInstruction(first, HUNT, '2026-08-14T10:00:00.000Z');
    expect(instruction.filed).toBe(4);
    expect(findInstruction(store, HUNT)?.since).toBe(NOW);
  });

  it('treats spacing and case as the same hunt — a person retyping will not match bytes', () => {
    const store = hunt([4]);
    expect(findInstruction(store, '  Find Gaps   ON the Feature Blueprint ')?.filed).toBe(4);
    expect(instructionKey(' A  B ')).toBe('a b');
  });
});

describe('the guard rail', () => {
  it('caps at the number and says so', () => {
    const store = hunt([9, 9, 9], 20);
    const found = findInstruction(store, HUNT);
    expect(found?.filed).toBe(27);
    expect(found?.status).toBe('capped');
  });

  it('defaults to 20, and honours an override', () => {
    expect(findInstruction(hunt([]), HUNT)?.cap).toBe(DEFAULT_INSTRUCTION_CAP);
    expect(findInstruction(hunt([], 5), HUNT)?.cap).toBe(5);
  });

  it('reports the room left, never a negative one', () => {
    const over = findInstruction(hunt([30], 20), HUNT);
    expect(instructionRoom(over as never)).toBe(0);
  });

  it('a capped hunt STAYS capped when the same sentence is typed again (#1578)', () => {
    // This used to restart at zero, on the theory that retyping is a person
    // saying "keep going". Nothing checked that a person was involved: the
    // automatic re-invocations type the same focus every run, so the cap held
    // for exactly one refused `loop file` and was cleared by the next gate.
    const capped = hunt([20], 20);
    const { instruction } = startInstruction(capped, HUNT, NOW);
    expect(instruction.status).toBe('capped');
    expect(instruction.filed).toBe(20);
  });

  it('a dry hunt is not restarted by retyping it either', () => {
    const dry = hunt([0, 0, 0]);
    expect(findInstruction(dry, HUNT)?.status).toBe('dry');
    expect(startInstruction(dry, HUNT, NOW).instruction.status).toBe('dry');
  });

  it('only a STOPPED hunt restarts at zero — the one status a person sets', () => {
    // The explicit resume path: stop it (a person's decision), then type it
    // again. `loop resume --focus <text>` is the caller that does both.
    const capped = hunt([20], 20);
    const { instruction } = startInstruction(stopInstruction(capped, HUNT), HUNT, NOW);
    expect(instruction.status).toBe('active');
    expect(instruction.filed).toBe(0);
  });
});

describe('running dry is observed, not felt', () => {
  it('needs consecutive quiet runs — one is just an unlucky slice', () => {
    expect(findInstruction(hunt([3, 0]), HUNT)?.status).toBe('active');
    expect(findInstruction(hunt(Array(DRY_RUNS).fill(0) as number[]), HUNT)?.status).toBe('dry');
  });

  it('a finding resets the quiet streak', () => {
    const store = hunt([0, 2, 0]);
    expect(findInstruction(store, HUNT)?.status).toBe('active');
    expect(findInstruction(store, HUNT)?.quietRuns).toBe(1);
  });

  it('the cap wins over dry — a hunt that filled up is not finished', () => {
    // It stopped because the guard rail fired, and there may well be more. A
    // reader deciding whether to look themselves needs that distinction.
    const store = hunt([20, 0, 0], 20);
    expect(findInstruction(store, HUNT)?.status).toBe('capped');
  });
});

describe('three ways to stop, never collapsed into one', () => {
  it('stopped is a person, dry is exhaustion, capped is the rail', () => {
    expect(findInstruction(stopInstruction(hunt([1]), HUNT), HUNT)?.status).toBe('stopped');
    expect(findInstruction(hunt([0, 0]), HUNT)?.status).toBe('dry');
    expect(findInstruction(hunt([20], 20), HUNT)?.status).toBe('capped');
  });

  it('stopping something nobody is hunting changes nothing', () => {
    const store = emptyInstructions();
    expect(stopInstruction(store, 'never typed')).toEqual(store);
  });
});

describe('finished hunts are deleted, not archived', () => {
  it('drops a finished instruction on the next write', () => {
    // The store answers "what is being hunted RIGHT NOW". A history of finished
    // hunts is what the run log is for, and two stores answering one question
    // is how they come to disagree.
    let store = hunt([0, 0]); // dry
    store = startInstruction(store, 'try to break the app', NOW).store;
    expect(store.instructions.map((entry) => entry.text)).toEqual(['try to break the app']);
  });
});

describe('forgetting a hunt is not stopping it', () => {
  // A STOPPED HUNT IS STILL A HUNT: it keeps its count, `loop status` still
  // reports it, and every surface that draws hunts still draws it offering a
  // resume. That is right for "I looked, carry on" and wrong for "this is
  // over" — a person clearing a loop out expects the hunt GONE, not sitting
  // there at 0/20, which is exactly what they saw.
  it('removes the instruction instead of marking it', () => {
    const store = forgetInstruction(hunt([4]), HUNT);
    expect(store.instructions).toEqual([]);
    expect(findInstruction(store, HUNT)).toBeUndefined();
  });

  it('leaves stopInstruction’s meaning alone — it still reports, still counts', () => {
    const stopped = stopInstruction(hunt([4]), HUNT);
    expect(findInstruction(stopped, HUNT)?.status).toBe('stopped');
    expect(findInstruction(stopped, HUNT)?.filed).toBe(4);
  });

  it('matches the sentence the way every other verb does — spacing and case', () => {
    const store = forgetInstruction(hunt([1]), `  ${HUNT.toUpperCase()} `);
    expect(store.instructions).toEqual([]);
  });

  it('touches nothing else', () => {
    let store = hunt([1]);
    store = startInstruction(store, 'try to break the app', NOW).store;
    const left = forgetInstruction(store, HUNT);
    expect(left.instructions.map((entry) => entry.text)).toEqual(['try to break the app']);
  });

  it('empties the store when no sentence is named', () => {
    let store = hunt([1]);
    store = startInstruction(store, 'try to break the app', NOW).store;
    expect(forgetInstruction(store).instructions).toEqual([]);
  });

  it('forgetting what was never there is not an error', () => {
    expect(forgetInstruction(emptyInstructions(), 'nothing like this').instructions).toEqual([]);
  });
});

describe('the wiring that makes dry reachable at all', () => {
  it('a quiet run is recorded as filedNow 0 — the only input dry has', () => {
    // This is the seam that was missing in the CLI: `loop file` counted each
    // NEW finding, so `quietRuns` was only ever reset and never incremented,
    // and `dry` could not fire however long a hunt ran. The store was right;
    // nothing fed it.
    let store = startInstruction(emptyInstructions(), HUNT, NOW).store;
    store = recordInstructionRun(store, HUNT, 1, NOW); // a run that found something
    expect(findInstruction(store, HUNT)?.quietRuns).toBe(0);

    for (let i = 0; i < DRY_RUNS; i += 1) store = recordInstructionRun(store, HUNT, 0, NOW);
    expect(findInstruction(store, HUNT)?.status).toBe('dry');
    // ...and the count it already earned is untouched by going quiet.
    expect(findInstruction(store, HUNT)?.filed).toBe(1);
  });
});

describe('the file', () => {
  it('serializes deterministically — same store, same bytes', () => {
    const store = hunt([2]);
    expect(serializeInstructions(store)).toBe(serializeInstructions(store));
  });

  it('round-trips through disk', () => {
    const dir = `${process.env.TMPDIR ?? '/tmp'}/instr-${String(process.pid)}-${String(Date.now())}`;
    writeInstructions(dir, hunt([3], 9));
    const back = findInstruction(readInstructions(dir), HUNT);
    expect(back?.filed).toBe(3);
    expect(back?.cap).toBe(9);
  });

  it('a corrupt file costs a COUNT, never the run', () => {
    // Deliberately unlike `loop-state.ts`, which refuses: a corrupt lock must
    // stop a loop, because the alternative is two runs holding it. A corrupt
    // progress number is worth restarting the count over, never worth refusing
    // to hunt at all.
    const dir = `${process.env.TMPDIR ?? '/tmp'}/instr-bad-${String(process.pid)}-${String(Date.now())}`;
    writeInstructions(dir, hunt([3]));
    writeFileSync(`${dir}/loops/instructions.json`, '{ not json', 'utf-8');
    expect(readInstructions(dir)).toEqual(emptyInstructions());
  });

  it('an unreadable entry is skipped, and its neighbours survive', () => {
    const dir = `${process.env.TMPDIR ?? '/tmp'}/instr-mix-${String(process.pid)}-${String(Date.now())}`;
    writeInstructions(dir, hunt([1]));
    writeFileSync(
      `${dir}/loops/instructions.json`,
      JSON.stringify({
        version: 1,
        instructions: [
          { text: HUNT, filed: 5, cap: 20, quietRuns: 0, status: 'active', since: NOW },
          { text: '', filed: 1, cap: 20, quietRuns: 0, status: 'active', since: NOW },
          { text: 'no status', filed: 1, cap: 20, quietRuns: 0, status: 'nonsense', since: NOW },
        ],
      }),
      'utf-8',
    );
    const store = readInstructions(dir);
    expect(store.instructions).toHaveLength(1);
    expect(findInstruction(store, HUNT)?.filed).toBe(5);
  });
});

/**
 * Task 2.5 — the reader a REPORT uses.
 *
 * `readInstructions` collapses "nothing is being hunted" and "nobody could read
 * the file" into the same empty store, on purpose: a producer whose count is
 * unreadable is better off restarting the count than refusing to run. A report
 * cannot afford that collapse — `loop status` would tell a person a hunt had
 * ended when all that happened is that a file stopped parsing.
 */
describe('two answers a report must keep apart', () => {
  const tempDir = (name: string): string =>
    `${process.env.TMPDIR ?? '/tmp'}/instr-${name}-${String(process.pid)}-${String(Date.now())}`;

  it('reports two hunts as two, with the counts the store holds', () => {
    const dir = tempDir('two');
    let store = startInstruction(emptyInstructions(), HUNT, NOW).store;
    store = recordInstructionRun(store, HUNT, 7, NOW);
    store = startInstruction(store, 'find untested error paths', NOW, 5).store;
    writeInstructions(dir, store);

    const read = readInstructionsResult(dir);
    expect(read.error).toBeUndefined();
    expect(read.store?.instructions).toHaveLength(2);
    expect(findInstruction(read.store as InstructionStore, HUNT)).toMatchObject({
      filed: 7,
      cap: DEFAULT_INSTRUCTION_CAP,
      status: 'active',
    });
  });

  it('a file that was never written is an EMPTY store, not a failure', () => {
    // Never having typed an instruction is a perfectly good answer, and it is
    // the one a producer that was simply started gives.
    const read = readInstructionsResult(tempDir('missing'));
    expect(read.error).toBeUndefined();
    expect(read.store).toEqual(emptyInstructions());
  });

  it('a corrupt file is a failure that SAYS SO — and stays fail-soft for the run', () => {
    const dir = tempDir('unreadable');
    writeInstructions(dir, startInstruction(emptyInstructions(), HUNT, NOW).store);
    writeFileSync(`${dir}/loops/instructions.json`, '{ not json', 'utf-8');

    const read = readInstructionsResult(dir);
    expect(read.store).toBeNull();
    // Null and empty are different answers, and this is the whole point.
    expect(read.store).not.toEqual(emptyInstructions());
    expect(String(read.error)).toContain('JSON');
    // The run's reader is unchanged: same file, still an empty store, still
    // no refusal — one code path, two contracts.
    expect(readInstructions(dir)).toEqual(emptyInstructions());
  });

  it('a store whose shape is wrong is unreadable, not empty', () => {
    const dir = tempDir('shape');
    writeInstructions(dir, startInstruction(emptyInstructions(), HUNT, NOW).store);
    writeFileSync(`${dir}/loops/instructions.json`, JSON.stringify({ version: 1 }), 'utf-8');

    const read = readInstructionsResult(dir);
    expect(read.store).toBeNull();
    expect(String(read.error)).toContain('instructions.json');
  });

  it('one malformed ENTRY is still skipped, and the store still reads', () => {
    // The line between the two: a bad entry costs one hunt, a bad FILE costs
    // the answer. Only the second is a failure.
    const dir = tempDir('entry');
    writeInstructions(dir, startInstruction(emptyInstructions(), HUNT, NOW).store);
    writeFileSync(
      `${dir}/loops/instructions.json`,
      JSON.stringify({
        version: 1,
        instructions: [
          { text: HUNT, filed: 2, cap: 20, quietRuns: 0, status: 'active', since: NOW },
          { text: 'no status', filed: 1, cap: 20, quietRuns: 0, status: 'nonsense', since: NOW },
        ],
      }),
      'utf-8',
    );

    const read = readInstructionsResult(dir);
    expect(read.error).toBeUndefined();
    expect(read.store?.instructions).toHaveLength(1);
  });
});


// ── stop rules ───────────────────────────────────────────
//
// A hunt has always had two ways to finish that nobody chooses — the backstop
// and running dry — so in practice it was a thing you started and then had to
// remember to stop. These are the rules its author picks instead, and what has
// to hold about each one:
//
//  · `findings` keeps the count in ONE place. There is no second number.
//  · `duration` stamps its deadline ONCE, or a restart slides the window
//    forward forever and the hunt never expires.
//  · `custom` is never judged here. The CLI reports the sentence and the AGENT
//    decides — the same split the guard classifier draws.
//  · the backstop outranks all three, because "for 24 hours" is not consent to
//    file two hundred items.

describe('a stop rule is stamped once, and refuses what it cannot honour', () => {
  test('a duration rule turns hours into an instant, measured from now', () => {
    const stop = resolveInstructionStop({ kind: 'duration', hours: 2 }, NOW);
    expect(stop).toEqual({
      kind: 'duration',
      hours: 2,
      until: '2026-08-13T12:00:00.000Z',
    });
  });

  test('a restart re-stamps the window rather than inheriting the old deadline', () => {
    // The bug this guards: carrying `until` forward would restart a hunt that
    // expires the instant it begins.
    const first = startInstruction(
      emptyInstructions(),
      HUNT,
      NOW,
      20,
      resolveInstructionStop({ kind: 'duration', hours: 2 }, NOW),
    );
    const later = '2026-08-14T10:00:00.000Z';
    const stopped = stopInstruction(first.store, HUNT);
    const again = startInstruction(
      stopped,
      HUNT,
      later,
      20,
      resolveInstructionStop({ kind: 'duration', hours: 2 }, later),
    );
    expect(again.instruction.stop).toEqual({
      kind: 'duration',
      hours: 2,
      until: '2026-08-14T12:00:00.000Z',
    });
    expect(instructionStopReached(again.instruction, later)).toBeNull();
  });

  test('refuses hours it cannot honour rather than clamping them silently', () => {
    // Allowed-pattern #22: a number a person TYPED is validated and refused —
    // rewriting 500 to 168 would tell them their number was accepted.
    expect(() => resolveInstructionStop({ kind: 'duration', hours: 0 }, NOW)).toThrow(
      /positive number/,
    );
    expect(() =>
      resolveInstructionStop({ kind: 'duration', hours: MAX_INSTRUCTION_STOP_HOURS + 1 }, NOW),
    ).toThrow(new RegExp(String(MAX_INSTRUCTION_STOP_HOURS)));
  });

  test('refuses an empty custom rule, and one longer than a sentence', () => {
    expect(() => resolveInstructionStop({ kind: 'custom', rule: '   ' }, NOW)).toThrow(
      /needs a sentence/,
    );
    expect(() =>
      resolveInstructionStop(
        { kind: 'custom', rule: 'x'.repeat(MAX_INSTRUCTION_STOP_RULE_LENGTH + 1) },
        NOW,
      ),
    ).toThrow(/at most/);
  });
});

describe('what ends a hunt, and what only the agent may end', () => {
  test('the clock ends a duration hunt, and only once it has actually passed', () => {
    const started = startInstruction(
      emptyInstructions(),
      HUNT,
      NOW,
      20,
      resolveInstructionStop({ kind: 'duration', hours: 2 }, NOW),
    ).instruction;
    expect(instructionStopReached(started, '2026-08-13T11:59:59.000Z')).toBeNull();
    expect(instructionStopReached(started, '2026-08-13T12:00:00.000Z')).toBe('elapsed');
  });

  test('the backstop outranks the clock — 24 hours is not consent to file 200', () => {
    let store = startInstruction(
      emptyInstructions(),
      HUNT,
      NOW,
      3,
      resolveInstructionStop({ kind: 'duration', hours: 24 }, NOW),
    ).store;
    store = recordInstructionRun(store, HUNT, 3, NOW);
    // Well inside the window, and stopped anyway.
    expect(findInstruction(store, HUNT)?.status).toBe('capped');
  });

  test('a run that ends the window records `elapsed`, not `dry` and not `stopped`', () => {
    let store = startInstruction(
      emptyInstructions(),
      HUNT,
      NOW,
      20,
      resolveInstructionStop({ kind: 'duration', hours: 1 }, NOW),
    ).store;
    store = recordInstructionRun(store, HUNT, 1, '2026-08-13T11:30:00.000Z');
    expect(findInstruction(store, HUNT)?.status).toBe('elapsed');
  });

  test('a custom rule is never judged by the store — it stays active until the agent says', () => {
    const rule = 'you find a second place the same bug is written';
    let store = startInstruction(
      emptyInstructions(),
      HUNT,
      NOW,
      20,
      resolveInstructionStop({ kind: 'custom', rule }, NOW),
    ).store;
    store = recordInstructionRun(store, HUNT, 1, '2027-01-01T00:00:00.000Z');
    expect(findInstruction(store, HUNT)?.status).toBe('active');

    store = meetInstruction(store, HUNT);
    expect(findInstruction(store, HUNT)?.status).toBe('met');
  });

  test("`met` is refused for a hunt that never had a rule to meet", () => {
    // A run reporting on the wrong hunt must leave the store as it was, rather
    // than labelling a plain hunt with a verdict about a sentence nobody wrote.
    const store = startInstruction(emptyInstructions(), HUNT, NOW, 20).store;
    expect(findInstruction(meetInstruction(store, HUNT), HUNT)?.status).toBe('active');
  });
});

describe('the rule survives the file, and a broken one costs only itself', () => {
  test('a stop rule round-trips through serialize/read', () => {
    const store = startInstruction(
      emptyInstructions(),
      HUNT,
      NOW,
      20,
      resolveInstructionStop({ kind: 'duration', hours: 4 }, NOW),
    ).store;
    const dir = `${process.env.TMPDIR ?? '/tmp'}/instr-stop-${String(process.pid)}-${String(Date.now())}`;
    writeInstructions(dir, store);
    expect(findInstruction(readInstructions(dir), HUNT)?.stop).toEqual({
      kind: 'duration',
      hours: 4,
      until: '2026-08-13T14:00:00.000Z',
    });
  });

  test('a duration rule with no readable deadline drops the RULE, never the hunt', () => {
    // The hunt's count is the precious part. A hand-edited rule that will not
    // parse leaves a hunt on its backstop, which is a valid hunt.
    const dir = `${process.env.TMPDIR ?? '/tmp'}/instr-stop-bad-${String(process.pid)}-${String(Date.now())}`;
    // `writeInstructions` creates `loops/` — seeded with a valid store first, so
    // this test writes only the malformed field it is about.
    writeInstructions(dir, startInstruction(emptyInstructions(), HUNT, NOW).store);
    writeFileSync(
      `${dir}/loops/instructions.json`,
      JSON.stringify({
        version: 1,
        instructions: [
          {
            text: HUNT,
            filed: 7,
            cap: 20,
            quietRuns: 0,
            status: 'active',
            since: NOW,
            stop: { kind: 'duration', hours: 2, until: 'whenever' },
          },
        ],
      }),
      'utf-8',
    );
    const kept = findInstruction(readInstructions(dir), HUNT);
    expect(kept?.filed).toBe(7);
    expect(kept?.stop).toBeUndefined();
  });

  test('every rule says how it ends, in words a run can act on', () => {
    const plain = startInstruction(emptyInstructions(), HUNT, NOW, 20).instruction;
    expect(describeInstructionStop(plain)).toContain('20 findings');

    const timed = startInstruction(
      emptyInstructions(),
      HUNT,
      NOW,
      20,
      resolveInstructionStop({ kind: 'duration', hours: 1 }, NOW),
    ).instruction;
    expect(describeInstructionStop(timed)).toContain('1 hour');

    const custom = startInstruction(
      emptyInstructions(),
      HUNT,
      NOW,
      20,
      resolveInstructionStop({ kind: 'custom', rule: 'the same bug appears twice' }, NOW),
    ).instruction;
    // The sentence reaches the run verbatim — it is the agent that judges it.
    expect(describeInstructionStop(custom)).toContain('the same bug appears twice');
  });
});
