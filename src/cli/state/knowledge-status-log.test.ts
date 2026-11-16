import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyKnowledgePath } from '../handlers/knowledge-classes.js';
import type { KnowledgeProvenance } from './knowledge-provenance.js';
import {
  appendKnowledgeStatus,
  foldKnowledgeStatus,
  itemStampOf,
  knowledgeItemId,
  knowledgeStatusLine,
  KnowledgeStatusRefusal,
  readKnowledgeStatus,
  resolveItemStatus,
  type KnowledgeStatusEntry,
} from './knowledge-status-log.js';

const ITEM = knowledgeItemId({ kind: 'learning', scope: 'orders', text: 'Orders retry twice.', learnedAt: 'abcdefabcdefabcd' });
const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function entry(overrides: Partial<KnowledgeStatusEntry> = {}): KnowledgeStatusEntry {
  return { item: ITEM, status: 'solid', branch: 'feat/orders', commit: COMMIT, reason: 'ancestor', ts: '2026-11-16T10:00:00.000Z', ...overrides };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('knowledgeItemId', () => {
  it('is stable, and differs by kind, scope, text and learnedAt', () => {
    const base = { kind: 'learning' as const, scope: 'orders', text: 't', learnedAt: 'abcdefabcdefabcd' };
    expect(knowledgeItemId(base)).toBe(knowledgeItemId({ ...base }));
    expect(knowledgeItemId(base)).toMatch(/^[0-9a-f]{16}$/);
    const variants = [
      { ...base, kind: 'part-learning' as const },
      { ...base, scope: 'billing' },
      { ...base, text: 'u' },
      { ...base, learnedAt: null },
    ];
    for (const variant of variants) expect(knowledgeItemId(variant)).not.toBe(knowledgeItemId(base));
  });
});

describe('appendKnowledgeStatus — the only writer', () => {
  let flowDir: string;
  const logPath = (): string => join(flowDir, 'brain', '.structure', 'knowledge-status.jsonl');

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'pf-status-log-'));
  });

  afterEach(() => rmSync(flowDir, { recursive: true, force: true }));

  it('writes one canonical line, and the same promotion twice stays one line', () => {
    appendKnowledgeStatus(flowDir, entry());
    // Same instant spelled differently, keys in another order: same bytes.
    appendKnowledgeStatus(flowDir, {
      ts: '2026-11-16T12:00:00+02:00',
      reason: 'ancestor',
      commit: COMMIT,
      branch: 'feat/orders',
      status: 'solid',
      item: ITEM,
    });
    const lines = readFileSync(logPath(), 'utf-8').trim().split('\n');
    expect(lines).toEqual([
      `{"item":"${ITEM}","status":"solid","branch":"feat/orders","commit":"${COMMIT}","reason":"ancestor","ts":"2026-11-16T10:00:00.000Z"}`,
    ]);
  });

  it('refuses anything outside the vocabulary and writes nothing', () => {
    // Positive first (#28): a valid entry is accepted by the same call.
    expect(() => knowledgeStatusLine(entry())).not.toThrow();
    const bad: Array<Partial<KnowledgeStatusEntry> | Record<string, unknown>> = [
      { status: 'merged' as never },
      { item: 'not-an-id' },
      { commit: 'abc' },
      { reason: 'Promoted because it landed' },
      { ts: 'yesterday' },
      { branch: '' },
    ];
    for (const overrides of bad) {
      expect(() => appendKnowledgeStatus(flowDir, { ...entry(), ...overrides } as KnowledgeStatusEntry)).toThrow(
        KnowledgeStatusRefusal,
      );
    }
    expect(existsSync(logPath())).toBe(false);
  });

  it('reads back through the fold', () => {
    appendKnowledgeStatus(flowDir, entry({ status: 'draft', reason: 'stamped', ts: '2026-11-15T00:00:00Z' }));
    appendKnowledgeStatus(flowDir, entry());
    expect(readKnowledgeStatus(flowDir).get(ITEM)?.status).toBe('solid');
  });
});

describe('foldKnowledgeStatus — the same answer in every order', () => {
  it('solid outranks a NEWER draft, in every order', () => {
    const lines = [
      knowledgeStatusLine(entry({ status: 'draft', reason: 'stamped', ts: '2026-11-20T00:00:00Z' })),
      knowledgeStatusLine(entry({ status: 'solid', ts: '2026-11-16T00:00:00Z' })),
    ];
    for (const order of permutations(lines)) {
      const folded = foldKnowledgeStatus(order).get(ITEM);
      expect(folded?.status).toBe('solid');
      expect(folded?.stale).toBe(false);
    }
  });

  it('among outranking lines the newest wins; an exact tie breaks on the bytes', () => {
    const solid = knowledgeStatusLine(entry({ status: 'solid', ts: '2026-11-16T00:00:00Z' }));
    const abandoned = knowledgeStatusLine(entry({ status: 'abandoned', reason: 'branch-gone', commit: null, ts: '2026-11-17T00:00:00Z' }));
    const stale = knowledgeStatusLine(entry({ status: 'stale', reason: 'merged-with-changes', commit: OTHER, ts: '2026-11-17T00:00:00Z' }));
    const draft = knowledgeStatusLine(entry({ status: 'draft', reason: 'stamped', ts: '2026-11-18T00:00:00Z' }));
    const answers = new Set<string>();
    for (const order of permutations([solid, abandoned, stale, draft, 'not json', ''])) {
      const folded = foldKnowledgeStatus(order).get(ITEM);
      answers.add(JSON.stringify(folded));
    }
    // One answer for all 720 orders.
    expect(answers.size).toBe(1);
    const folded = foldKnowledgeStatus([solid, abandoned, stale, draft]).get(ITEM);
    // abandoned vs stale tie on ts → the larger line wins ("status":"stale" > "status":"abandoned").
    expect(folded?.status).toBe('solid');
    expect(folded?.stale).toBe(true);
  });

  it('a stale line reads as solid, carried with the stale flag', () => {
    const folded = foldKnowledgeStatus([knowledgeStatusLine(entry({ status: 'stale', reason: 'merged-with-changes' }))]).get(ITEM);
    expect(folded).toMatchObject({ status: 'solid', stale: true });
  });

  it('keeps items apart', () => {
    const other = knowledgeItemId({ kind: 'note', scope: '', text: 'x' });
    const folded = foldKnowledgeStatus([
      knowledgeStatusLine(entry()),
      knowledgeStatusLine(entry({ item: other, status: 'abandoned', reason: 'pr-closed' })),
    ]);
    expect(folded.get(ITEM)?.status).toBe('solid');
    expect(folded.get(other)?.status).toBe('abandoned');
  });
});

describe('resolveItemStatus — the one status resolver', () => {
  const onMain: KnowledgeProvenance = { branch: 'main', commit: COMMIT, onDefault: true, hashes: [] };
  const onBranch: KnowledgeProvenance = { branch: 'feat/orders', commit: OTHER, onDefault: false, hashes: [] };
  const records = new Map([
    ['1111111111111111', onMain],
    ['2222222222222222', onBranch],
  ]);

  it('knowledge without provenance is solid (FR-13)', () => {
    expect(resolveItemStatus(itemStampOf(undefined, records), undefined)).toEqual({ status: 'solid', stale: false, branch: null });
  });

  it('stamped on the default branch is solid; on another branch it is a draft naming the branch', () => {
    expect(resolveItemStatus(itemStampOf('1111111111111111', records), undefined).status).toBe('solid');
    expect(resolveItemStatus(itemStampOf('2222222222222222', records), undefined)).toEqual({
      status: 'draft',
      stale: false,
      branch: 'feat/orders',
    });
  });

  it('the log promotes or archives a draft; a draft line changes nothing', () => {
    const stamp = itemStampOf('2222222222222222', records);
    const promoted = foldKnowledgeStatus([knowledgeStatusLine(entry({ status: 'stale', reason: 'merged-with-changes' }))]).get(ITEM);
    expect(resolveItemStatus(stamp, promoted)).toEqual({ status: 'solid', stale: true, branch: 'feat/orders' });
    const abandoned = foldKnowledgeStatus([knowledgeStatusLine(entry({ status: 'abandoned', reason: 'pr-closed' }))]).get(ITEM);
    expect(resolveItemStatus(stamp, abandoned).status).toBe('abandoned');
    const draft = foldKnowledgeStatus([knowledgeStatusLine(entry({ status: 'draft', reason: 'stamped' }))]).get(ITEM);
    expect(resolveItemStatus(stamp, draft).status).toBe('draft');
  });

  it('a stamp whose record has not arrived is a draft — never promoted on a guess', () => {
    expect(resolveItemStatus(itemStampOf('3333333333333333', records), undefined).status).toBe('draft');
  });
});

describe('the status log and provenance records sync as append-only', () => {
  it('classifies both paths append-only in a Workspace and in a project repo', () => {
    // Positive control: an annotation store, already known to be append-only.
    expect(classifyKnowledgePath('projects/p/brain/.structure/annotations.jsonl', { root: 'workspace' })).toBe('append-only');
    for (const file of ['knowledge-status.jsonl', 'knowledge-provenance.jsonl']) {
      expect(classifyKnowledgePath(`projects/p/brain/.structure/${file}`, { root: 'workspace' })).toBe('append-only');
      expect(classifyKnowledgePath(`brain/.structure/${file}`)).toBe('append-only');
    }
  });
});
