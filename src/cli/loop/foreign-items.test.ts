/**
 * The local record for items a loop did not file.
 *
 * Everything here is about the FOLD, because the fold is where an event's
 * meaning is decided and every consumer of this store — both queue backends, the
 * CLI, a future app-side reader — goes through it (allowed-pattern #14). Two of
 * its four transitions are cross-cutting, and both exist because of a specific
 * failure:
 *
 *   - `handled` clears the claim, or the honest-ending rule would refuse a beat
 *     that finished correctly;
 *   - `reworked` clears both, or "the fix did not hold" would have no way back.
 *
 * The file half is one round-trip test: nothing derives a value from the file
 * before writing it, so there is no lock and no ordering subtlety to prove.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FOREIGN_ITEMS_FILENAME,
  ForeignItemStore,
  createMemoryForeignItemState,
  foldForeignItemEvents,
  foreignItemsPath,
  foreignKey,
  parseForeignItemEvent,
  readForeignItemEvents,
} from './foreign-items.js';
import type { ForeignItemEvent } from './foreign-items.js';

const T0 = '2026-08-12T09:00:00.000Z';
const T1 = '2026-08-12T09:30:00.000Z';

function event(overrides: Partial<ForeignItemEvent> = {}): ForeignItemEvent {
  return {
    ts: T0,
    backend: 'github',
    id: '1509',
    loop: 'fix',
    event: 'claimed',
    owner: 'beat-1',
    ...overrides,
  };
}

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foreign-items-'));
  dirs.push(dir);
  return dir;
}

describe('the fold — one place an event means anything', () => {
  it('records a claim, and releases it again', () => {
    const claimed = foldForeignItemEvents([event()]);
    expect(claimed.get(foreignKey('github', '1509'))).toEqual({
      backend: 'github',
      id: '1509',
      loop: 'fix',
      claim: { owner: 'beat-1', at: T0 },
    });

    const released = foldForeignItemEvents([event(), event({ ts: T1, event: 'released' })]);
    expect(released.get(foreignKey('github', '1509'))?.claim).toBeUndefined();
  });

  it('CLEARS THE CLAIM when the item is handled — finishing with it IS the release', () => {
    const folded = foldForeignItemEvents([
      event(),
      event({ ts: T1, event: 'handled', detail: 'done — fixed in loop/fix/1509' }),
    ]);
    const record = folded.get(foreignKey('github', '1509'));
    expect(record?.claim).toBeUndefined();
    expect(record?.handled).toEqual({ at: T1, detail: 'done — fixed in loop/fix/1509' });
  });

  it('CLEARS BOTH on rework — a fix that did not hold starts from nothing known', () => {
    const folded = foldForeignItemEvents([
      event(),
      event({ ts: T1, event: 'handled', detail: 'done' }),
      event({ ts: T1, event: 'reworked', detail: 'it came back' }),
    ]);
    expect(folded.get(foreignKey('github', '1509'))).toEqual({
      backend: 'github',
      id: '1509',
      loop: 'fix',
    });
  });

  it('keys by backend AND id — issue 12 and ledger item 12 are different things', () => {
    const folded = foldForeignItemEvents([
      event({ id: '12', backend: 'github' }),
      event({ id: '12', backend: 'ledger', owner: 'beat-2' }),
    ]);
    expect(folded.size).toBe(2);
    expect(folded.get(foreignKey('github', '12'))?.claim?.owner).toBe('beat-1');
    expect(folded.get(foreignKey('ledger', '12'))?.claim?.owner).toBe('beat-2');
  });

  it('ignores a claim with no owner rather than inventing one', () => {
    const folded = foldForeignItemEvents([{ ts: T0, backend: 'github', id: '1', loop: 'fix', event: 'claimed' }]);
    expect(folded.get(foreignKey('github', '1'))?.claim).toBeUndefined();
  });

  it('records which pipeline is being advanced — the plan a body marker cannot hold (#1599)', () => {
    const folded = foldForeignItemEvents([
      event(),
      event({ ts: T1, event: 'planned', plan: 'state-md-handoff' }),
    ]);
    expect(folded.get(foreignKey('github', '1509'))).toEqual({
      backend: 'github',
      id: '1509',
      loop: 'fix',
      claim: { owner: 'beat-1', at: T0 },
      plan: { name: 'state-md-handoff', at: T1 },
    });
  });

  it('takes the LAST plan named — one item, one live pipeline', () => {
    const folded = foldForeignItemEvents([
      event({ event: 'planned', plan: 'first-plan' }),
      event({ ts: T1, event: 'planned', plan: 'second-plan' }),
    ]);
    expect(folded.get(foreignKey('github', '1509'))?.plan?.name).toBe('second-plan');
  });

  it('CLEARS the plan when `planned` names none — one event, both directions', () => {
    const folded = foldForeignItemEvents([
      event({ event: 'planned', plan: 'state-md-handoff' }),
      event({ ts: T1, event: 'planned' }),
    ]);
    expect(folded.get(foreignKey('github', '1509'))?.plan).toBeUndefined();
  });

  it('LEAVES the plan on release — an item back in the queue still has a pipeline', () => {
    const folded = foldForeignItemEvents([
      event(),
      event({ ts: T0, event: 'planned', plan: 'state-md-handoff' }),
      event({ ts: T1, event: 'released' }),
    ]);
    const record = folded.get(foreignKey('github', '1509'));
    expect(record?.claim).toBeUndefined();
    expect(record?.plan?.name).toBe('state-md-handoff');
  });

  it('CLEARS the plan when the item is handled — a settled item carries no pipeline', () => {
    const folded = foldForeignItemEvents([
      event(),
      event({ ts: T0, event: 'planned', plan: 'state-md-handoff' }),
      event({ ts: T1, event: 'handled', detail: 'done' }),
    ]);
    const record = folded.get(foreignKey('github', '1509'));
    expect(record?.plan).toBeUndefined();
    expect(record?.handled).toEqual({ at: T1, detail: 'done' });
  });

  it('CLEARS the plan on rework too — working it again starts from nothing known', () => {
    const folded = foldForeignItemEvents([
      event({ event: 'planned', plan: 'state-md-handoff' }),
      event({ ts: T1, event: 'reworked', detail: 'it came back' }),
    ]);
    expect(folded.get(foreignKey('github', '1509'))).toEqual({
      backend: 'github',
      id: '1509',
      loop: 'fix',
    });
  });

  it('folds a store written before `planned` existed exactly as it did', () => {
    const folded = foldForeignItemEvents([event(), event({ ts: T1, event: 'handled', detail: 'done' })]);
    expect(folded.get(foreignKey('github', '1509'))).toEqual({
      backend: 'github',
      id: '1509',
      loop: 'fix',
      handled: { at: T1, detail: 'done' },
    });
  });
});

describe('parsing is defensive per line', () => {
  it('refuses a record missing anything the key or the meaning depends on', () => {
    expect(parseForeignItemEvent({ ...event(), id: '' })).toBeNull();
    expect(parseForeignItemEvent({ ...event(), backend: 'sqlite' })).toBeNull();
    expect(parseForeignItemEvent({ ...event(), event: 'deleted' })).toBeNull();
    expect(parseForeignItemEvent('not an object')).toBeNull();
  });

  it('carries the plan through the round trip, and drops a non-string one', () => {
    const planned = event({ event: 'planned', plan: 'state-md-handoff' });
    expect(parseForeignItemEvent(JSON.parse(JSON.stringify(planned)))).toEqual(planned);
    expect(parseForeignItemEvent({ ...planned, plan: 7 })?.plan).toBeUndefined();
  });

  it('skips a corrupt line without losing the rest of the file', () => {
    const dir = makeDir();
    const path = join(dir, FOREIGN_ITEMS_FILENAME);
    writeFileSync(path, `${JSON.stringify(event())}\n{ not json\n${JSON.stringify(event({ ts: T1, event: 'handled', detail: 'done' }))}\n`, 'utf-8');

    const events = readForeignItemEvents(path);
    expect(events).toHaveLength(2);
    expect(foldForeignItemEvents(events).get(foreignKey('github', '1509'))?.handled?.detail).toBe('done');
  });

  it('reads a missing file as an empty store — a project that never claimed is not broken', () => {
    expect(readForeignItemEvents(join(makeDir(), 'nope.jsonl'))).toEqual([]);
  });
});

describe('the file-backed store', () => {
  it('appends and folds back, creating the directory on first write', () => {
    const flowDir = join(makeDir(), 'flow');
    const store = new ForeignItemStore(foreignItemsPath(flowDir));
    expect(store.path.endsWith(join('loops', FOREIGN_ITEMS_FILENAME))).toBe(true);
    expect(store.snapshot().size).toBe(0);

    store.append(event());
    store.append(event({ ts: T1, event: 'handled', detail: 'done' }));

    const record = store.snapshot().get(foreignKey('github', '1509'));
    expect(record?.handled?.detail).toBe('done');
    expect(record?.claim).toBeUndefined();
  });

  it('folds identically in memory — one implementation of the meaning', () => {
    const memory = createMemoryForeignItemState();
    memory.append(event());
    memory.append(event({ ts: T1, event: 'handled', detail: 'done' }));
    expect(memory.snapshot().get(foreignKey('github', '1509'))).toEqual(
      foldForeignItemEvents(memory.events).get(foreignKey('github', '1509')),
    );
  });
});

/**
 * The branch ownership record (unattended-auto-branch, C-2). A `feat/<ticket>`
 * branch carries no loop identity, so which loop owns it for an item is written
 * down here — set by `branched`, cleared by `handled`/`reworked`, and left alone
 * by `released` (an item handed back mid-pipeline still has its branch).
 */
describe('the branched event — ownership that is not in the name', () => {
  it('records which branch a loop owns for an item, with its loop', () => {
    const folded = foldForeignItemEvents([
      event({ event: 'branched', branch: 'feat/TPL-019-fix' }),
    ]);
    const record = folded.get(foreignKey('github', '1509'));
    expect(record?.branch).toBe('feat/TPL-019-fix');
    expect(record?.loop).toBe('fix');
  });

  it('an empty branch clears the record (one writer, both directions)', () => {
    const folded = foldForeignItemEvents([
      event({ event: 'branched', branch: 'feat/TPL-019-fix' }),
      event({ ts: T1, event: 'branched', branch: '' }),
    ]);
    expect(folded.get(foreignKey('github', '1509'))?.branch).toBeUndefined();
  });

  it('handled clears the branch — it does not outlive being finished with', () => {
    const folded = foldForeignItemEvents([
      event({ event: 'branched', branch: 'feat/TPL-019-fix' }),
      event({ ts: T1, event: 'handled', detail: 'landed' }),
    ]);
    expect(folded.get(foreignKey('github', '1509'))?.branch).toBeUndefined();
  });

  it('release leaves the branch — a mid-pipeline handoff still has one', () => {
    const folded = foldForeignItemEvents([
      event({ event: 'branched', branch: 'feat/TPL-019-fix' }),
      event({ ts: T1, event: 'released' }),
    ]);
    expect(folded.get(foreignKey('github', '1509'))?.branch).toBe('feat/TPL-019-fix');
  });

  it('parses the branch field off a raw event', () => {
    const parsed = parseForeignItemEvent({
      ts: T0,
      backend: 'github',
      id: '1509',
      loop: 'fix',
      event: 'branched',
      branch: 'feat/TPL-019-fix',
    });
    expect(parsed?.branch).toBe('feat/TPL-019-fix');
  });
});
