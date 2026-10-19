import { computeTouchedSets, phaseCoverageGaps } from './simulation-model.js';
import type { EffectiveProposal } from './proposal-store.js';
import type { BlueprintGraph, CompiledStory, StoryStep } from './types.js';

function moduleNode(dir: string): BlueprintGraph['nodes'][number] {
  return { id: `module:${dir}`, kind: 'module', label: dir, sourceFile: dir, meta: {} };
}

const graph: BlueprintGraph = {
  version: 1,
  derivedAt: '2026-07-20T00:00:00.000Z',
  coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['modules'], graphifyEnriched: true },
  nodes: [moduleNode('src/a'), moduleNode('src/b')],
  edges: [],
};

function step(partial: Partial<StoryStep>): StoryStep {
  return {
    id: partial.id ?? 's',
    title: partial.title ?? 'S',
    body: '',
    anchors: partial.anchors ?? [],
    flow: [],
    phases: partial.phases ?? [],
    decisions: [],
    rejected: [],
    questions: [],
    unresolvedAnchors: [],
    draft: partial.draft ?? false,
  };
}

function story(steps: StoryStep[]): CompiledStory {
  return { plan: 'p', sourcePath: 'flow/plans/plan_p_v1.md', mode: 'strict', steps, warnings: [] };
}

const ghost: EffectiveProposal = {
  fingerprint: 'p+module:src/new',
  plan: 'p',
  predictedNodeId: 'module:src/new',
  kind: 'module',
  label: 'new',
  anchors: [{ kind: 'module', ref: 'src/new' }],
  state: 'accepted',
  provenance: 'test',
  proposedAt: '2026-07-20T00:00:00.000Z',
};

describe('computeTouchedSets', () => {
  it('derives modify for an existing node and new for a ghost', () => {
    const s = story([
      step({ id: 'one', phases: [1], anchors: [{ kind: 'module', ref: 'src/a' }] }),
      step({ id: 'two', phases: [2], anchors: [{ kind: 'module', ref: 'src/new' }] }),
    ]);
    const sets = computeTouchedSets(s, graph, [ghost]);
    expect(sets).toEqual([
      { phase: 1, touched: [{ nodeId: 'module:src/a', kind: 'modify', anchor: { kind: 'module', ref: 'src/a' } }] },
      { phase: 2, touched: [{ nodeId: 'module:src/new', kind: 'new', anchor: { kind: 'module', ref: 'src/new' } }] },
    ]);
  });

  it('unions touched nodes across steps covering the same phase, deduped', () => {
    const s = story([
      step({ id: 'one', phases: [1], anchors: [{ kind: 'module', ref: 'src/a' }] }),
      step({ id: 'two', phases: [1, 2], anchors: [{ kind: 'module', ref: 'src/b' }, { kind: 'module', ref: 'src/a' }] }),
    ]);
    const sets = computeTouchedSets(s, graph, []);
    const p1 = sets.find((x) => x.phase === 1)!;
    expect(p1.touched.map((t) => t.nodeId)).toEqual(['module:src/a', 'module:src/b']);
    // phase 2 is covered only by step 'two', whose anchors are [b, a] in order
    expect(sets.find((x) => x.phase === 2)!.touched.map((t) => t.nodeId)).toEqual([
      'module:src/b',
      'module:src/a',
    ]);
  });

  it('drops steps with no phases and unresolved anchors', () => {
    const s = story([
      step({ id: 'narrative', phases: [], anchors: [{ kind: 'module', ref: 'src/a' }] }),
      step({ id: 'gap', phases: [3], anchors: [{ kind: 'module', ref: 'src/missing' }] }),
    ]);
    const sets = computeTouchedSets(s, graph, []);
    // phase 3 has a step but the anchor doesn't resolve → no touched nodes
    expect(sets).toEqual([{ phase: 3, touched: [] }]);
  });

  it('never emits kind "remove" (no honest signal)', () => {
    const s = story([step({ id: 'one', phases: [1], anchors: [{ kind: 'module', ref: 'src/a' }] })]);
    const kinds = computeTouchedSets(s, graph, []).flatMap((set) => set.touched.map((t) => t.kind));
    expect(kinds).not.toContain('remove');
  });
});

describe('phaseCoverageGaps', () => {
  it('reports phases with no resolvable anchor, sorted', () => {
    const s = story([
      step({ id: 'one', phases: [1], anchors: [{ kind: 'module', ref: 'src/a' }] }),
      step({ id: 'gap', phases: [3], anchors: [{ kind: 'module', ref: 'src/missing' }] }),
    ]);
    // plan declares phases 1,2,3: 1 covered, 2 has no step, 3 has an unresolved anchor
    expect(phaseCoverageGaps([1, 2, 3], s, graph, [])).toEqual([2, 3]);
  });

  it('returns [] when every plan phase resolves', () => {
    const s = story([
      step({ id: 'one', phases: [1, 2], anchors: [{ kind: 'module', ref: 'src/a' }] }),
    ]);
    expect(phaseCoverageGaps([1, 2], s, graph, [])).toEqual([]);
  });

  it('treats a ghost-resolved phase as covered', () => {
    const s = story([step({ id: 'one', phases: [1], anchors: [{ kind: 'module', ref: 'src/new' }] })]);
    expect(phaseCoverageGaps([1], s, graph, [ghost])).toEqual([]);
  });
});
