/**
 * Tests for the store's own gap report (Phase 8).
 *
 * The point of every case here is the same: a fact that is UNKNOWN must never
 * be reported as a zero, and a fact that is measured must be reported exactly.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeFeatureLimitations } from './feature-limitations.js';
import { featureViewPath, type FeatureView } from './feature-view.js';
import type { FeatureNode } from './feature-store.js';

function tempFlow(): string {
  const flowDir = join(mkdtempSync(join(tmpdir(), 'feature-limits-')), 'flow');
  mkdirSync(join(flowDir, 'brain', '.structure', 'feature-views'), { recursive: true });
  return flowDir;
}

function feature(slug: string, body: string, patch: Partial<FeatureNode> = {}): FeatureNode {
  return {
    id: `feature:${slug}`,
    slug,
    name: slug,
    kind: 'core',
    anchors: [],
    relates: [],
    lastFullRead: null,
    patchCount: 0,
    body,
    extra: {},
    ...patch,
  };
}

const LEARNED_BODY = [
  'Prose.',
  '',
  '## Learned',
  '- It streams over SSE <!-- learned: code 2026-08-01 -->',
].join('\n');

const PARTS_BODY = [
  'Prose.',
  '',
  '## Parts',
  '### Live events SSE',
  'anchors: src/a.ts',
].join('\n');

function view(patch: Partial<FeatureView> = {}): FeatureView {
  return {
    feature: 'chats',
    provenance: 'plan:x_v1',
    generatedAt: '2026-08-04',
    meta: { title: 'Chats' },
    brief: {},
    views: {
      root: {
        title: 'Chats',
        nodes: [{ id: 'a', kind: 'module', title: 'A', delta: 'stable' }],
        edges: [],
      },
    },
    ...patch,
  };
}

function store(flowDir: string, slug: string, body: unknown): void {
  writeFileSync(featureViewPath(flowDir, slug), JSON.stringify(body), 'utf-8');
}

describe('computeFeatureLimitations — content (Task 8.3 source of truth)', () => {
  it('counts a store where nothing is documented — this repo, exactly', () => {
    const flowDir = tempFlow();
    const features = ['a', 'b', 'c'].map((slug) => feature(slug, 'Just prose.'));
    const { content } = computeFeatureLimitations(features, flowDir);
    expect(content).toEqual({ features: 3, withParts: 0, withLearned: 0, unreadable: 0 });
  });

  it('counts parts and learnings through the store\'s own readers', () => {
    const flowDir = tempFlow();
    const features = [
      feature('a', LEARNED_BODY),
      feature('b', PARTS_BODY),
      feature('c', 'Just prose.'),
    ];
    const { content } = computeFeatureLimitations(features, flowDir);
    expect(content.features).toBe(3);
    expect(content.withLearned).toBe(1);
    expect(content.withParts).toBe(1);
  });

  it('calls a body that will not split UNREADABLE, never "has no learnings"', () => {
    const flowDir = tempFlow();
    const ambiguous = ['## Learned', '- one <!-- learned: code 2026-08-01 -->', '## Learned'].join('\n');
    const { content } = computeFeatureLimitations([feature('a', ambiguous)], flowDir);
    expect(content.unreadable).toBe(1);
    expect(content.withLearned).toBe(0);
    expect(content.features).toBe(1);
  });

  it('reports an empty store as empty rather than as fully documented', () => {
    const { content } = computeFeatureLimitations([], tempFlow());
    expect(content).toEqual({ features: 0, withParts: 0, withLearned: 0, unreadable: 0 });
  });
});

describe('computeFeatureLimitations — curated views', () => {
  it('reports no artifacts when there are none', () => {
    const { views } = computeFeatureLimitations([feature('chats', 'x')], tempFlow());
    expect(views).toEqual({
      total: 0,
      valid: 0,
      broken: 0,
      orphaned: 0,
      failures: [],
      validSlugs: [],
    });
  });

  it('reports a valid artifact as valid, with no failure entry', () => {
    const flowDir = tempFlow();
    store(flowDir, 'chats', view());
    const { views } = computeFeatureLimitations([feature('chats', 'x')], flowDir);
    expect(views.total).toBe(1);
    expect(views.valid).toBe(1);
    expect(views.broken).toBe(0);
    expect(views.failures).toEqual([]);
    // The feature-graph's second understanding source — see `understandingOf`.
    expect(views.validSlugs).toEqual(['chats']);
  });

  it('keeps a BROKEN artifact out of validSlugs — the d5ae3b83 guard', () => {
    const flowDir = tempFlow();
    const broken = view();
    broken.views.root.edges = [{ from: 'ghost', to: 'a', label: 'x', delta: 'kept' }];
    store(flowDir, 'chats', broken);
    const { views } = computeFeatureLimitations([feature('chats', 'x')], flowDir);
    expect(views.validSlugs).toEqual([]);
  });

  it("carries the validator's exact errors into the failure entry", () => {
    const flowDir = tempFlow();
    const broken = view();
    broken.views.root.edges = [{ from: 'ghost', to: 'a', label: 'x', delta: 'kept' }];
    store(flowDir, 'chats', broken);
    const { views } = computeFeatureLimitations([feature('chats', 'x')], flowDir);
    expect(views.broken).toBe(1);
    expect(views.failures[0].slug).toBe('chats');
    expect(views.failures[0].errors.join('\n')).toContain("connection from 'ghost'");
  });

  it('reports the orphan this repo actually has: an artifact naming no feature', () => {
    const flowDir = tempFlow();
    const nameless: Record<string, unknown> = { ...view() };
    delete nameless.feature;
    store(flowDir, 'feature-view', nameless);
    const { views } = computeFeatureLimitations([feature('chats', 'x')], flowDir);
    expect(views.orphaned).toBe(1);
    expect(views.failures[0].orphanReason).toBe('names no feature');
    expect(views.failures[0].errors.join('\n')).toContain('view needs a non-empty "feature"');
  });

  it('calls an artifact whose feature left the store an orphan', () => {
    const flowDir = tempFlow();
    store(flowDir, 'chats', view());
    const { views } = computeFeatureLimitations([feature('threads', 'x')], flowDir);
    expect(views.orphaned).toBe(1);
    expect(views.valid).toBe(1);
    expect(views.failures[0].orphanReason).toBe("names 'chats', which is not a feature in the store");
    // VALID BUT NOT THIS STORE'S. An orphan never counts as anyone's evidence.
    expect(views.validSlugs).toEqual([]);
  });

  it('checks excerpts against the repo when a root is given', () => {
    const flowDir = tempFlow();
    const rotted = view();
    rotted.views.root.nodes[0].code = { file: 'a.ts', from: 1, to: 9, note: 'why', text: 'x' };
    store(flowDir, 'chats', rotted);
    const repoRoot = join(flowDir, '..');
    const { views } = computeFeatureLimitations([feature('chats', 'x')], flowDir, { repoRoot });
    expect(views.broken).toBe(1);
    expect(views.failures[0].errors.join('\n')).toContain('does not exist');
  });
});

describe('missing homes — a pin the disk no longer has (plan feature-home-folders)', () => {
  const body = ['Prose.', '', '## Parts', '### Live stream', 'anchors: src/a.ts', 'home: src/gone', '### Kept', 'anchors: src/b.ts', 'home: src/b'].join('\n');
  const features = [
    feature('chats', body, { extra: { home: 'src/also-gone' } }),
    feature('fine', 'Prose.', { extra: { home: 'src/b' } }),
  ];
  const exists = (home: string): boolean => home === 'src/b';

  it('names every pinned feature and part whose folder is not there, by id', () => {
    const { missingHomes } = computeFeatureLimitations(features, tempFlow(), { homeExists: exists });
    expect(missingHomes).toEqual([
      { id: 'feature:chats', feature: 'chats', part: null, home: 'src/also-gone' },
      { id: 'feature:chats/live-stream', feature: 'chats', part: 'Live stream', home: 'src/gone' },
    ]);
  });

  it('checks nothing without a checkout — an unchecked pin is not a missing one', () => {
    const asked: string[] = [];
    const withCheck = computeFeatureLimitations(features, tempFlow(), {
      homeExists: (home) => {
        asked.push(home);
        return exists(home);
      },
    });
    expect(asked.length).toBeGreaterThan(0); // the check runs when it can
    expect(withCheck.missingHomes.length).toBe(2);
    expect(computeFeatureLimitations(features, tempFlow()).missingHomes).toEqual([]);
  });
});
