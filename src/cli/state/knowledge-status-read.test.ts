import { describe, expect, it, afterEach } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildFeatureGraph } from '../blueprint/feature-graph.js';
import { featureSummary, parseFeatureFile, type FeatureNode, type FeaturePart } from '../blueprint/feature-store.js';
import { hashFileContent } from '../blueprint/store.js';
import { chunkKnowledgeWeigher, DRAFT_CHUNK_WEIGHT } from './brain-search-status.js';
import { fileSearchLegs } from './brain-file-search.js';
import { provenanceLine, type KnowledgeProvenance } from './knowledge-provenance.js';
import {
  branchDisplayName,
  foldKnowledgeStatus,
  knowledgeStatusReaderFrom,
  nodeKnowledgeStatus,
  parseProvenanceRecords,
  type KnowledgeItemRef,
  type KnowledgeStatusReader,
  type ResolvedItemStatus,
} from './knowledge-status-fold.js';
import { appendKnowledgeStatus, knowledgeItemId } from './knowledge-status-log.js';
import { createKnowledgeStatusReader, itemStatusOf } from './knowledge-status-read.js';

const SOLID_REF = '1111111111111111';
const DRAFT_REF = '2222222222222222';
const GONE_REF = '3333333333333333';

/** A reader keyed by `learnedAt` alone — enough to steer every reader under test. */
function fakeReader(byRef: Record<string, ResolvedItemStatus>): KnowledgeStatusReader {
  return {
    of: (item: KnowledgeItemRef) => byRef[item.learnedAt ?? ''] ?? { status: 'solid', stale: false, branch: null },
  };
}

const READER = fakeReader({
  [SOLID_REF]: { status: 'solid', stale: false, branch: 'main' },
  [DRAFT_REF]: { status: 'draft', stale: false, branch: 'feat/orders' },
  [GONE_REF]: { status: 'abandoned', stale: false, branch: 'feat/old' },
});

function line(text: string, ref: string, date: string, extra = ''): string {
  return `- ${text} <!-- learnedAt: ${ref} --> <!-- learned: code ${date}${extra} -->`;
}

function body(...lines: string[]): string {
  return `# Feature: orders\n\nOrders prose.\n\n## Learned\n${lines.join('\n')}\n`;
}

describe('featureSummary — solid first, abandoned never (note 9)', () => {
  it('prefers an older solid learning over a newer draft', () => {
    const text = body(line('Solid sentence.', SOLID_REF, '2026-01-01'), line('Draft sentence.', DRAFT_REF, '2026-11-01'));
    // Positive first: without a reader the newest wins, as it always has.
    expect(featureSummary(text)).toBe('Draft sentence.');
    expect(featureSummary(text, { slug: 'orders', reader: READER })).toBe('Solid sentence.');
  });

  it('prefers solid over a PINNED draft — solid is chosen before the pin', () => {
    const text = body(line('Solid sentence.', SOLID_REF, '2026-01-01'), line('Pinned draft.', DRAFT_REF, '2026-11-01', ' pinned'));
    expect(featureSummary(text, { slug: 'orders', reader: READER })).toBe('Solid sentence.');
  });

  it('uses a draft when nothing solid exists, and drops an abandoned learning', () => {
    const text = body(line('Draft sentence.', DRAFT_REF, '2026-01-01'), line('Abandoned sentence.', GONE_REF, '2026-11-01'));
    expect(featureSummary(text)).toBe('Abandoned sentence.');
    expect(featureSummary(text, { slug: 'orders', reader: READER })).toBe('Draft sentence.');
  });

  it('falls back to the prose when every learning was abandoned', () => {
    const text = body(line('Abandoned sentence.', GONE_REF, '2026-11-01'));
    expect(featureSummary(text, { slug: 'orders', reader: READER })).toBe('Orders prose.');
  });
});

function feature(slug: string, text: string): FeatureNode {
  return parseFeatureFile(slug, `---\nname: ${slug}\nkind: core\n---\n${text}`);
}

describe('feature graph — draft status on features and parts (note 9)', () => {
  const part = (name: string, ref: string): FeaturePart => ({
    name,
    summary: '',
    anchors: [],
    learnings: [{ text: `${name} learning.`, provenance: 'code', date: '2026-11-01', learnedAt: ref }],
  });

  it('tags a feature draft only when every live learning is a draft, with the branch', () => {
    const drafted = feature('orders', body(line('Draft sentence.', DRAFT_REF, '2026-11-01'), line('Gone.', GONE_REF, '2026-11-02')));
    const mixed = feature('billing', body(line('Solid.', SOLID_REF, '2026-01-01'), line('Draft.', DRAFT_REF, '2026-11-01')));
    const graph = buildFeatureGraph([drafted, mixed], new Map(), new Set(), new Set(), new Map(), new Set(), undefined, undefined, READER);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    expect(byId.get('feature:billing')).toMatchObject({ status: 'solid' });
    expect(byId.get('feature:billing')?.draftBranch).toBeUndefined();
    expect(byId.get('feature:orders')).toMatchObject({ status: 'draft', draftBranch: 'feat/orders' });
  });

  it('tags parts on their own learnings, never their feature', () => {
    const owner = feature('orders', body(line('Solid.', SOLID_REF, '2026-01-01')));
    const parts = new Map([['orders', [part('Retry queue', DRAFT_REF), part('Ledger', SOLID_REF)]]]);
    const graph = buildFeatureGraph([owner], new Map(), new Set(), new Set(), parts, new Set(), undefined, undefined, READER);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    expect(byId.get('feature:orders')).toMatchObject({ status: 'solid' });
    expect(byId.get('feature:orders/ledger')).toMatchObject({ status: 'solid' });
    expect(byId.get('feature:orders/retry-queue')).toMatchObject({ status: 'draft', draftBranch: 'feat/orders' });
  });

  it('adds no status at all without a reader (the shape stays additive)', () => {
    const graph = buildFeatureGraph([feature('orders', body(line('Draft.', DRAFT_REF, '2026-11-01')))], new Map());
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].status).toBeUndefined();
  });
});

describe('the pure rules', () => {
  it('nodeKnowledgeStatus: solid wins, abandoned counts for nothing, nothing stamped is solid', () => {
    expect(nodeKnowledgeStatus([{ status: 'draft', branch: 'a' }, { status: 'solid', branch: null }])).toEqual({ status: 'solid', draftBranch: null });
    expect(nodeKnowledgeStatus([{ status: 'draft', branch: 'a' }, { status: 'abandoned', branch: 'b' }])).toEqual({ status: 'draft', draftBranch: 'a' });
    expect(nodeKnowledgeStatus([{ status: 'abandoned', branch: 'b' }])).toEqual({ status: 'solid', draftBranch: null });
    expect(nodeKnowledgeStatus([])).toEqual({ status: 'solid', draftBranch: null });
  });

  it('branchDisplayName strips the ref prefix', () => {
    expect(branchDisplayName('refs/remotes/origin/main')).toBe('main');
    expect(branchDisplayName('refs/heads/develop')).toBe('develop');
    expect(branchDisplayName('trunk')).toBe('trunk');
  });

  it('parseProvenanceRecords reads what the record writer writes, and refuses a forged id', () => {
    const record: KnowledgeProvenance = { branch: 'feat/x', commit: 'a'.repeat(40), onDefault: false, hashes: [] };
    const written = provenanceLine(record);
    const parsed = parseProvenanceRecords(`${written}\n`, hashFileContent);
    expect([...parsed.values()]).toEqual([record]);
    const forged = written.replace(/"id":"[0-9a-f]{16}"/, '"id":"0000000000000000"');
    expect(parseProvenanceRecords(forged, hashFileContent).size).toBe(0);
  });
});

describe('the reader over real files', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function flowWith(records: KnowledgeProvenance[]): { flowDir: string; refs: string[] } {
    const flowDir = mkdtempSync(join(tmpdir(), 'pf-status-read-'));
    dirs.push(flowDir);
    mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
    mkdirSync(join(flowDir, 'brain', 'features'), { recursive: true });
    const lines = records.map((record) => provenanceLine(record));
    writeFileSync(join(flowDir, 'brain', '.structure', 'knowledge-provenance.jsonl'), `${lines.join('\n')}\n`);
    return { flowDir, refs: lines.map((text) => (JSON.parse(text) as { id: string }).id) };
  }

  const onBranch: KnowledgeProvenance = { branch: 'feat/orders', commit: 'a'.repeat(40), onDefault: false, hashes: [] };
  const onMain: KnowledgeProvenance = { branch: 'main', commit: 'b'.repeat(40), onDefault: true, hashes: [] };

  it('resolves stamp + log through the one resolver: branch → draft, promoted → solid, abandoned', () => {
    const { flowDir, refs } = flowWith([onBranch, onMain]);
    const [branchRef, mainRef] = refs;
    const item = { kind: 'learning' as const, scope: 'orders', text: 'Draft.', learnedAt: branchRef };
    expect(itemStatusOf(flowDir, item)).toEqual({ status: 'draft', stale: false, branch: 'feat/orders' });
    expect(itemStatusOf(flowDir, { ...item, learnedAt: mainRef })).toEqual({ status: 'solid', stale: false, branch: 'main' });
    appendKnowledgeStatus(flowDir, {
      item: knowledgeItemId(item),
      status: 'abandoned',
      branch: 'feat/orders',
      commit: null,
      reason: 'branch-gone',
      ts: '2026-11-16T00:00:00.000Z',
    });
    expect(itemStatusOf(flowDir, item).status).toBe('abandoned');
  });

  it('the app-side reader (pure fold + injected digest) answers exactly what the CLI reader answers', () => {
    const { flowDir, refs } = flowWith([onBranch, onMain]);
    const items = refs.map((ref, index) => ({ kind: 'learning' as const, scope: 'orders', text: `t${index}`, learnedAt: ref }));
    appendKnowledgeStatus(flowDir, {
      item: knowledgeItemId(items[0]),
      status: 'stale',
      branch: 'feat/orders',
      commit: 'c'.repeat(40),
      reason: 'hashes-changed',
      ts: '2026-11-16T00:00:00.000Z',
    });
    const cli = createKnowledgeStatusReader(flowDir);
    const app = knowledgeStatusReaderFrom(
      foldKnowledgeStatus(readFileSync(join(flowDir, 'brain', '.structure', 'knowledge-status.jsonl'), 'utf-8').split('\n')),
      parseProvenanceRecords(readFileSync(join(flowDir, 'brain', '.structure', 'knowledge-provenance.jsonl'), 'utf-8'), hashFileContent),
      (item) => knowledgeItemId(item),
    );
    expect(cli.of(items[0])).toEqual({ status: 'solid', stale: true, branch: 'feat/orders' });
    for (const item of items) expect(app.of(item)).toEqual(cli.of(item));
  });

  it('search: a draft chunk ranks below an equal solid one, and an abandoned chunk is not found', () => {
    const { flowDir, refs } = flowWith([onBranch, onMain]);
    const [branchRef, mainRef] = refs;
    const projectRoot = join(flowDir, '..', `proj-${Date.now()}`);
    dirs.push(projectRoot);
    mkdirSync(join(projectRoot), { recursive: true });
    const write = (slug: string, ref: string): void =>
      writeFileSync(
        join(flowDir, 'brain', 'features', `${slug}.md`),
        `---\nname: ${slug}\nkind: core\n---\n# Feature: ${slug}\n\n## Learned\n${line('Refunds settle nightly through the ledger.', ref, '2026-11-01')}\n`,
      );
    write('aaa-draft', branchRef);
    write('bbb-solid', mainRef);
    write('ccc-gone', branchRef.replace(/./, 'f'));
    // Abandon ccc's learning in the log (its ref has no record → draft unless the log says otherwise).
    appendKnowledgeStatus(flowDir, {
      item: knowledgeItemId({ kind: 'learning', scope: 'ccc-gone', text: 'Refunds settle nightly through the ledger.', learnedAt: branchRef.replace(/./, 'f') }),
      status: 'abandoned',
      branch: 'feat/old',
      commit: null,
      reason: 'branch-gone',
      ts: '2026-11-16T00:00:00.000Z',
    });
    const search = (weigh: boolean) =>
      fileSearchLegs(projectRoot, 'refunds ledger nightly', ['flow/brain/features/'], {
        flowDir,
        roots: ['flow/brain/features'],
        ...(weigh ? { weightOf: chunkKnowledgeWeigher(flowDir) } : {}),
      }).chunks.map((chunk) => ({ file: chunk.file.split('/').pop(), score: chunk.score }));
    // Positive first: unweighed, all three are found and the draft sorts first by name.
    const plain = search(false);
    expect(plain.map((hit) => hit.file)).toEqual(['aaa-draft.md', 'bbb-solid.md', 'ccc-gone.md']);
    const weighed = search(true);
    expect(weighed.map((hit) => hit.file)).toEqual(['bbb-solid.md', 'aaa-draft.md']);
    expect(weighed[1].score).toBeCloseTo(plain[0].score * DRAFT_CHUNK_WEIGHT);
  });
});

