/**
 * The app reads knowledge status with the CLI's pure rules
 * (`app/src/shared/knowledge-status.ts` re-exports `knowledge-status-fold.ts`),
 * but over its OWN file reads and its OWN digest (`node:crypto` injected in
 * `app/src/main/blueprint/knowledge-status-read.ts`). This pins the whole app
 * reader against the CLI's `createKnowledgeStatusReader` on the same files,
 * written by the CLI's own writers — so a divergence in reading, splitting or
 * hashing shows up as a different answer, not as a board that disagrees with
 * Ask (plan `workspace_knowledge_draft_solid`, phase 6).
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  knowledgeStatusReaderFromText,
  readKnowledgeStatusReader,
} from '../../../app/src/main/blueprint/knowledge-status-read';
import { recordProvenance, type KnowledgeProvenance } from './knowledge-provenance.js';
import type { KnowledgeItemRef, KnowledgeStatusEntry } from './knowledge-status-fold.js';
import { appendKnowledgeStatus, knowledgeItemId } from './knowledge-status-log.js';
import { createKnowledgeStatusReader } from './knowledge-status-read.js';

const ON_BRANCH: KnowledgeProvenance = { branch: 'feat/refunds', commit: 'a'.repeat(40), onDefault: false, hashes: [] };
const ON_MAIN: KnowledgeProvenance = { branch: 'main', commit: 'b'.repeat(40), onDefault: true, hashes: [] };
const DETACHED: KnowledgeProvenance = { branch: null, commit: 'c'.repeat(40), onDefault: null, hashes: [] };
const HASHED: KnowledgeProvenance = {
  branch: 'feat/hashed',
  commit: 'd'.repeat(40),
  onDefault: false,
  hashes: [{ path: 'src/a.ts', contentHash: 'e'.repeat(64) }],
};

describe('the app reader answers exactly as the CLI reader', () => {
  let flowDir: string;
  const statusFile = (): string => join(flowDir, 'brain', '.structure', 'knowledge-status.jsonl');
  const provenanceFile = (): string => join(flowDir, 'brain', '.structure', 'knowledge-provenance.jsonl');

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'pf-status-parity-'));
  });
  afterEach(() => rmSync(flowDir, { recursive: true, force: true }));

  /** Items covering every status, every kind, unstamped and unknown stamps. */
  function seed(): KnowledgeItemRef[] {
    const refs = {
      branch: recordProvenance(flowDir, ON_BRANCH),
      main: recordProvenance(flowDir, ON_MAIN),
      detached: recordProvenance(flowDir, DETACHED),
      hashed: recordProvenance(flowDir, HASHED),
    };
    const items: KnowledgeItemRef[] = [
      { kind: 'learning', scope: 'refunds', text: 'Draft, never promoted.', learnedAt: refs.branch },
      { kind: 'learning', scope: 'refunds', text: 'Promoted solid.', learnedAt: refs.branch },
      { kind: 'part-learning', scope: 'refunds/settle', text: 'Promoted stale.', learnedAt: refs.hashed },
      { kind: 'note', scope: '', text: 'Abandoned note.', learnedAt: refs.branch },
      { kind: 'view', scope: 'refunds', text: 'Learned on main.', learnedAt: refs.main },
      { kind: 'learning', scope: 'invoices', text: 'Detached head.', learnedAt: refs.detached },
      { kind: 'learning', scope: 'invoices', text: 'Unstamped, written before stamping.' },
      { kind: 'learning', scope: 'invoices', text: 'Stamp nobody recorded.', learnedAt: 'f'.repeat(16) },
      { kind: 'learning', scope: 'invoices', text: 'Solid then a later draft line.', learnedAt: refs.branch },
    ];
    const entry = (item: KnowledgeItemRef, patch: Partial<KnowledgeStatusEntry>): KnowledgeStatusEntry => ({
      item: knowledgeItemId(item),
      status: 'solid',
      branch: 'feat/refunds',
      commit: '9'.repeat(40),
      reason: 'ancestor',
      ts: '2026-11-16T00:00:00.000Z',
      ...patch,
    });
    appendKnowledgeStatus(flowDir, entry(items[1], {}));
    appendKnowledgeStatus(flowDir, entry(items[2], { status: 'stale', branch: 'feat/hashed', reason: 'hashes-match' }));
    appendKnowledgeStatus(flowDir, entry(items[3], { status: 'abandoned', commit: null, reason: 'branch-gone' }));
    appendKnowledgeStatus(flowDir, entry(items[8], { ts: '2026-11-15T00:00:00.000Z' }));
    appendKnowledgeStatus(flowDir, entry(items[8], { status: 'draft', reason: 'learned', ts: '2026-11-17T00:00:00.000Z' }));
    // A second machine's identical promotion, union-merged in: the writer de-duplicates.
    appendKnowledgeStatus(flowDir, entry(items[1], {}));
    // Lines no writer wrote: corrupt JSON, a forged provenance id, blank lines.
    appendFileSync(statusFile(), '{not json\n\n{"item":"zz","status":"solid"}\n');
    appendFileSync(provenanceFile(), `{"id":"0000000000000000","branch":"main","commit":null,"onDefault":true,"hashes":[]}\n\n`);
    return items;
  }

  const answers = (reader: { of: (item: KnowledgeItemRef) => unknown }, items: KnowledgeItemRef[]): unknown[] =>
    items.map((item) => reader.of(item));

  it('gives the same answer for every item, read from the same files', async () => {
    const items = seed();
    const cli = answers(createKnowledgeStatusReader(flowDir), items);
    const app = answers(await readKnowledgeStatusReader(flowDir), items);
    // Positive first: the fixture really spans the statuses, so equality means something.
    const seen = cli as { status: string; stale: boolean }[];
    expect(new Set(seen.map((answer) => answer.status))).toEqual(new Set(['solid', 'draft', 'abandoned']));
    expect(seen.some((answer) => answer.stale)).toBe(true);
    expect(app).toEqual(cli);
  });

  it('agrees in either merge order of both files', async () => {
    const items = seed();
    const cliBefore = answers(createKnowledgeStatusReader(flowDir), items);
    for (const file of [statusFile(), provenanceFile()]) {
      const lines = readFileSync(file, 'utf-8').split('\n').filter((line) => line !== '');
      writeFileSync(file, `${lines.reverse().join('\n')}\n`);
    }
    const cliAfter = answers(createKnowledgeStatusReader(flowDir), items);
    const appAfter = answers(await readKnowledgeStatusReader(flowDir), items);
    expect(cliAfter).toEqual(cliBefore);
    expect(appAfter).toEqual(cliAfter);
  });

  it('agrees when neither file exists: everything is solid', async () => {
    const items: KnowledgeItemRef[] = [{ kind: 'learning', scope: 'x', text: 'Anything.', learnedAt: 'a'.repeat(16) }];
    const cli = answers(createKnowledgeStatusReader(flowDir), items);
    expect(answers(await readKnowledgeStatusReader(flowDir), items)).toEqual(cli);
    expect(answers(knowledgeStatusReaderFromText('', ''), items)).toEqual(cli);
  });
});
