/**
 * Tests for the saved-answer log of "Ask the Blueprint" (`qa-store.ts`) — the
 * ONE writer of `flow/brain/.structure/qa.jsonl` — plus one end-to-end run of
 * the shipped verb (`dist/cli/index.js blueprint qa …`) as a subprocess.
 *
 * Every refusal asserts the reason AND that nothing was written
 * (allowed-pattern #24); every absence is preceded by the positive that makes
 * it evidence (allowed-pattern #28). Staleness is checked against real files in
 * a real temp git repo, edited for real — not a fixture hash.
 *
 * The subprocess runs with an explicit `cwd` inside its own temp dir — the verb
 * reads the repo root from cwd, so a drifting cwd would write into THIS repo.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { serializeParts } from './feature-store.js';
import {
  appendQaEntry,
  foldQaEntries,
  listQaForFeature,
  QaRefusal,
  qaStaleness,
  readQaEntries,
  readQaThreads,
} from './qa-store.js';
import type { QaEntry, QaRecordInput } from './types.js';

const { getPackageRoot } = await import('../utils/files.js');
const CLI_PATH = join(getPackageRoot(), 'dist', 'cli', 'index.js');

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A real temp git repo with a source file and a feature graph (connectors + a credentials part, coworkers). */
function seedRepo(options: { features?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'qa-store-'));
  roots.push(root);
  const write = (rel: string, content: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content, 'utf-8');
  };
  write('src/connectors/credentials.ts', 'export const vault = 1\n');
  write('src/coworkers/invite.ts', 'export const invite = 1\n');
  if (options.features !== false) {
    write(
      'flow/brain/features/connectors.md',
      `---\nkind: core\nanchors: []\n---\n# Connectors\n\nThird-party connections.\n\n## Parts\n\n${serializeParts([
        { name: 'Credentials', summary: 'Where secrets live.', anchors: ['src/connectors/credentials.ts'], learnings: [] },
      ])}`,
    );
    write('flow/brain/features/coworkers.md', '---\nkind: core\nanchors: []\n---\n# Coworkers\n\nInviting people.\n');
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: root });
  return root;
}

function qaFile(root: string): string {
  return join(root, 'flow', 'brain', '.structure', 'qa.jsonl');
}

function base(patch: Partial<QaRecordInput> = {}): QaRecordInput {
  return { author: 'Ana', question: 'Where do connector secrets live?', answer: 'In the vault.', ...patch };
}

/** Run `fn`, expect a QaRefusal with `reason`, and return it. */
function refusalOf(fn: () => unknown): QaRefusal {
  try {
    fn();
  } catch (error) {
    if (error instanceof QaRefusal) return error;
    throw error;
  }
  throw new Error('expected a QaRefusal, nothing was thrown');
}

describe('appendQaEntry — record', () => {
  it('writes one line with a minted id, the resolved tags and a hash-stamped source file', () => {
    const root = seedRepo();
    const entry = appendQaEntry(
      root,
      base({
        tags: ['feature:connectors', 'feature:connectors'],
        sources: [{ label: 'Credentials', featureId: 'feature:connectors/credentials', file: './src/connectors/credentials.ts' }],
        verdict: { label: 'Yes · small effort', risk: 'Secrets rotate weekly.' },
        conversationCount: 1,
        usedConversation: true,
      }),
      new Date('2026-11-01T10:00:00Z'),
    );
    expect(entry.id).toMatch(/^qa-20261101T100000-[0-9a-f]{6}$/);
    expect(entry.tags).toEqual(['feature:connectors']);
    expect(entry.sources[0]).toMatchObject({
      featureId: 'feature:connectors/credentials',
      file: 'src/connectors/credentials.ts',
      hashStamp: { ref: 'src/connectors/credentials.ts' },
    });
    expect(entry.sources[0].hashStamp?.contentHash).toMatch(/\S/);
    const lines = readFileSync(qaFile(root), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ id: entry.id, usedConversation: true, conversationCount: 1 });
    expect(readQaEntries(root).map((e) => e.id)).toEqual([entry.id]);
  });

  it('checks tag grammar only when there is no feature graph to check existence against', () => {
    const root = seedRepo({ features: false });
    const entry = appendQaEntry(root, base({ tags: ['feature:anything-at-all'] }));
    expect(entry.tags).toEqual(['feature:anything-at-all']);
  });
});

describe('appendQaEntry — follow-up', () => {
  it('appends a line naming its parent, and the fold attaches it to the root', () => {
    const root = seedRepo();
    const parent = appendQaEntry(root, base({ tags: ['feature:connectors'] }), new Date('2026-11-01T10:00:00Z'));
    const child = appendQaEntry(root, base({ question: 'And who rotates them?', parentId: parent.id }), new Date('2026-11-01T10:05:00Z'));
    const grandchild = appendQaEntry(root, base({ question: 'How often?', parentId: child.id }), new Date('2026-11-01T10:06:00Z'));
    expect(child.parentId).toBe(parent.id);
    const threads = readQaThreads(root);
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(parent.id);
    expect(threads[0].followUps.map((e) => e.id)).toEqual([child.id, grandchild.id]);
  });

  it('refuses a parentId that is not in the log, and writes nothing', () => {
    const root = seedRepo();
    const parent = appendQaEntry(root, base());
    const before = readFileSync(qaFile(root), 'utf-8');
    const refusal = refusalOf(() => appendQaEntry(root, base({ parentId: 'qa-nope' })));
    expect(refusal.reason).toBe('unknown-parent');
    expect(readFileSync(qaFile(root), 'utf-8')).toBe(before);
    expect(readQaEntries(root).map((e) => e.id)).toEqual([parent.id]);
  });
});

describe('listQaForFeature', () => {
  it('pins an entry to its tags and its source features; a part matches its parent feature', () => {
    const root = seedRepo();
    const byTag = appendQaEntry(root, base({ question: 'tagged', tags: ['feature:coworkers'] }), new Date('2026-11-01T10:00:00Z'));
    const bySource = appendQaEntry(
      root,
      base({ question: 'sourced', sources: [{ label: 'Credentials', featureId: 'feature:connectors/credentials' }] }),
      new Date('2026-11-01T11:00:00Z'),
    );
    const unrelated = appendQaEntry(root, base({ question: 'nothing' }), new Date('2026-11-01T12:00:00Z'));

    expect(listQaForFeature(root, 'feature:coworkers').map((t) => t.id)).toEqual([byTag.id]);
    // The part itself, and its parent feature, both find the entry its source named.
    expect(listQaForFeature(root, 'feature:connectors/credentials').map((t) => t.id)).toEqual([bySource.id]);
    expect(listQaForFeature(root, 'feature:connectors').map((t) => t.id)).toEqual([bySource.id]);
    // A bare slug resolves through the feature store.
    expect(listQaForFeature(root, 'connectors').map((t) => t.id)).toEqual([bySource.id]);
    expect(readQaThreads(root).map((t) => t.id)).toContain(unrelated.id);
    expect(listQaForFeature(root, 'feature:coworkers').map((t) => t.id)).not.toContain(unrelated.id);
  });

  it('lists a thread when only a follow-up touches the feature', () => {
    const root = seedRepo();
    const parent = appendQaEntry(root, base());
    appendQaEntry(root, base({ parentId: parent.id, tags: ['feature:coworkers'] }));
    expect(listQaForFeature(root, 'feature:coworkers').map((t) => t.id)).toEqual([parent.id]);
  });
});

describe('qaStaleness', () => {
  it('is fresh until a cited source file changes, then names it; a deleted file is missing', () => {
    const root = seedRepo();
    const entry = appendQaEntry(
      root,
      base({
        sources: [
          { label: 'Credentials', file: 'src/connectors/credentials.ts' },
          { label: 'Invite', file: 'src/coworkers/invite.ts' },
        ],
      }),
    );
    const fresh = qaStaleness(root, readQaEntries(root)).get(entry.id);
    expect(fresh).toEqual({ stale: false, changedFiles: [], missingFiles: [] });

    writeFileSync(join(root, 'src/connectors/credentials.ts'), 'export const vault = 2\n', 'utf-8');
    rmSync(join(root, 'src/coworkers/invite.ts'));
    const after = qaStaleness(root, readQaEntries(root)).get(entry.id);
    expect(after).toEqual({
      stale: true,
      changedFiles: ['src/connectors/credentials.ts'],
      missingFiles: ['src/coworkers/invite.ts'],
    });
  });

  it('an entry with no stamped source is never stale', () => {
    const root = seedRepo();
    const entry = appendQaEntry(root, base({ sources: [{ label: 'Just a label' }] }));
    expect(qaStaleness(root, readQaEntries(root)).get(entry.id)?.stale).toBe(false);
  });
});

describe('readQaEntries', () => {
  it('skips corrupt lines and keeps the first of two lines with the same id', () => {
    const root = seedRepo();
    const first = appendQaEntry(root, base({ question: 'first' }));
    appendFileSync(qaFile(root), 'not json at all\n{"half": \n["an","array"]\n{"id":"","question":"q","answer":"a"}\n', 'utf-8');
    appendFileSync(qaFile(root), `${JSON.stringify({ ...first, question: 'twin' })}\n`, 'utf-8');
    const second = appendQaEntry(root, base({ question: 'second' }));
    const entries = readQaEntries(root);
    expect(entries.map((e) => e.id)).toEqual([first.id, second.id]);
    expect(entries[0].question).toBe('first');
  });

  it('reads a missing log as empty', () => {
    const root = seedRepo();
    expect(existsSync(qaFile(root))).toBe(false);
    expect(readQaEntries(root)).toEqual([]);
  });
});

describe('foldQaEntries', () => {
  it('keeps an orphan follow-up as its own thread, newest threads first', () => {
    const entry = (id: string, ts: string, parentId?: string): QaEntry => ({
      id,
      ts,
      author: 'a',
      question: id,
      tags: [],
      conversationCount: 0,
      usedConversation: false,
      answer: 'x',
      sources: [],
      factsLearned: 0,
      partial: false,
      ...(parentId !== undefined ? { parentId } : {}),
    });
    const threads = foldQaEntries([entry('a', '2026-01-01'), entry('orphan', '2026-01-03', 'gone'), entry('b', '2026-01-02', 'a')]);
    expect(threads.map((t) => t.id)).toEqual(['orphan', 'a']);
    expect(threads[1].followUps.map((e) => e.id)).toEqual(['b']);
  });
});

describe('appendQaEntry — refusals write nothing', () => {
  const cases: Array<[string, Partial<QaRecordInput> | Record<string, unknown>, string]> = [
    ['conversation text', { conversation: 'the person said…' }, 'conversation-content'],
    ['a transcript under messages', { messages: ['hi'] }, 'conversation-content'],
    ['an unknown key', { mood: 'curious' }, 'unknown-field'],
    ['a writer-owned id', { id: 'qa-mine' }, 'writer-owned'],
    ['bad tag grammar', { tags: ['connectors'] }, 'bad-tag'],
    ['a tag the Blueprint does not have', { tags: ['feature:ghost'] }, 'unknown-tag'],
    ['a part the feature does not have', { tags: ['feature:connectors/ghost'] }, 'unknown-tag'],
    ['a missing source file', { sources: [{ label: 'Gone', file: 'src/gone.ts' }] }, 'bad-source'],
    ['a source file outside the repo', { sources: [{ label: 'Out', file: '../outside.ts' }] }, 'bad-source'],
    ['a caller-supplied hash stamp', { sources: [{ label: 'X', file: 'src/coworkers/invite.ts', hashStamp: { ref: 'x', contentHash: 'y' } }] }, 'writer-owned'],
    ['usedConversation without a count', { usedConversation: true }, 'bad-field'],
  ];

  it.each(cases)('refuses %s', (_name, patch, reason) => {
    const root = seedRepo();
    // The positive first: a valid record lands in the same file (allowed-pattern #28).
    const ok = appendQaEntry(root, base());
    const before = readFileSync(qaFile(root), 'utf-8');
    const refusal = refusalOf(() => appendQaEntry(root, { ...base(), ...patch } as QaRecordInput));
    expect(refusal.reason).toBe(reason);
    expect(refusal.payload).toMatchObject({ refused: reason });
    expect(readFileSync(qaFile(root), 'utf-8')).toBe(before);
    expect(readQaEntries(root).map((e) => e.id)).toEqual([ok.id]);
  });

  it('a refused FIRST record leaves no log file at all', () => {
    const root = seedRepo();
    expect(refusalOf(() => appendQaEntry(root, { ...base(), transcript: 'x' } as unknown as QaRecordInput)).reason).toBe(
      'conversation-content',
    );
    expect(existsSync(qaFile(root))).toBe(false);
  });
});

describe('blueprint qa — the shipped verb (subprocess)', () => {
  it('record with a parentId is refused: payload line, refusal line, exit 1, nothing written; a valid record then lands', () => {
    expect(existsSync(CLI_PATH)).toBe(true);
    const root = seedRepo({ features: false });
    const inputs = mkdtempSync(join(tmpdir(), 'qa-input-'));
    roots.push(inputs);
    const run = (input: Record<string, unknown>): { status: number | null; out: string } => {
      const file = join(inputs, `input-${Math.random().toString(16).slice(2)}.json`);
      writeFileSync(file, JSON.stringify(input), 'utf-8');
      const result = spawnSync(process.execPath, [CLI_PATH, 'blueprint', 'qa', 'record', '--input', file, '--json'], {
        cwd: root,
        encoding: 'utf-8',
        env: { ...process.env, NO_COLOR: '1' },
        timeout: 60_000,
      });
      return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
    };

    const refused = run({ ...base(), parentId: 'qa-whatever' });
    expect(refused.status).toBe(1);
    expect(refused.out).toContain('qa refused: bad-field');
    const payloadLine = refused.out.split('\n').find((line) => line.trim().startsWith('{'));
    expect(payloadLine).toBeDefined();
    expect(JSON.parse(payloadLine as string)).toMatchObject({ action: 'qa-record', refused: 'bad-field', field: 'parentId' });
    expect(existsSync(qaFile(root))).toBe(false);

    // The positive: the same verb, same cwd, writes to the path just checked.
    const ok = run({ ...base(), sources: [{ label: 'Invite', file: 'src/coworkers/invite.ts' }] });
    expect(ok.status).toBe(0);
    expect(existsSync(qaFile(root))).toBe(true);
    expect(readQaEntries(root)).toHaveLength(1);
  }, 120_000);

  it('list --all reads every saved question in one call; list without --feature or --all is still refused', () => {
    const root = seedRepo({ features: false });
    appendQaEntry(root, { ...base(), question: 'First?' });
    appendQaEntry(root, { ...base(), question: 'Second?' });
    const list = (args: string[]): { status: number | null; out: string } => {
      const result = spawnSync(process.execPath, [CLI_PATH, 'blueprint', 'qa', 'list', ...args, '--json'], {
        cwd: root,
        encoding: 'utf-8',
        env: { ...process.env, NO_COLOR: '1' },
        timeout: 60_000,
      });
      return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
    };
    const all = list(['--all']);
    expect(all.status).toBe(0);
    const payload = JSON.parse(all.out.split('\n').find((line) => line.trim().startsWith('{')) as string) as { threads: Array<{ question: string }> };
    expect(payload.threads.map((thread) => thread.question).sort()).toEqual(['First?', 'Second?']);
    const refused = list([]);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain('qa refused: missing-feature');
  }, 120_000);
});
