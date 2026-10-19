import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assembleProposals,
  computeBriefDelta,
  computeFeatureBrief,
  NOTHING_PROPOSED_SUMMARY,
  proposalBriefNodes,
  renderableProposals,
  resolveProposalSource,
} from './brief-model.js';
import { readCompiledStory, STORY_FILENAME } from './story-compile.js';
import type { EffectiveProposal, ProposalWithChange } from './proposal-store.js';
import type { BlueprintGraph, CompiledStory, StoryStep } from './types.js';

function moduleNode(dir: string, meta: Record<string, unknown> = {}): BlueprintGraph['nodes'][number] {
  return { id: `module:${dir}`, kind: 'module', label: dir, sourceFile: dir, meta };
}

const graph: BlueprintGraph = {
  version: 1,
  derivedAt: '2026-07-31T00:00:00.000Z',
  coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['modules'], graphifyEnriched: false },
  nodes: [moduleNode('src/a'), moduleNode('src/b'), moduleNode('src/legacy')],
  edges: [{ source: 'module:src/a', target: 'module:src/b', relation: 'imports' }],
};

function step(partial: Partial<StoryStep>): StoryStep {
  return {
    id: partial.id ?? 's',
    title: partial.title ?? 'S',
    body: '',
    anchors: partial.anchors ?? [],
    flow: partial.flowAfter ?? [],
    flowBefore: partial.flowBefore ?? [],
    flowAfter: partial.flowAfter ?? [],
    phases: partial.phases ?? [],
    decisions: [],
    rejected: [],
    questions: [],
    fails: partial.fails ?? [],
    ...(partial.unchanged !== undefined ? { unchanged: partial.unchanged } : {}),
    unresolvedAnchors: [],
    draft: false,
  };
}

function story(steps: StoryStep[]): CompiledStory {
  return { plan: 'p', sourcePath: 'flow/plans/plan_p_v1.md', mode: 'strict', steps, warnings: [] };
}

const ghost: EffectiveProposal = {
  fingerprint: 'p+module:src/new',
  plan: 'p',
  predictedNodeId: 'module:src/new',
  state: 'proposed',
} as EffectiveProposal;

const kindOf = (delta: ReturnType<typeof computeBriefDelta>, id: string) =>
  delta.nodes.find((n) => n.nodeId === id)?.kind;

describe('computeBriefDelta — node kinds', () => {
  it('derives a REMOVAL from before-minus-after (the signal anchors cannot give)', () => {
    const delta = computeBriefDelta(
      story([step({ flowBefore: ['module:src/a', 'module:src/legacy'], flowAfter: ['module:src/a', 'module:src/b'] })]),
      graph,
      [],
    );
    expect(kindOf(delta, 'module:src/legacy')).toBe('remove');
    expect(kindOf(delta, 'module:src/a')).toBe('stable');
    expect(kindOf(delta, 'module:src/b')).toBe('stable');
  });

  it('does NOT remove a node that survives in a different step\'s after-path', () => {
    const delta = computeBriefDelta(
      story([
        step({ id: 'one', flowBefore: ['module:src/legacy'], flowAfter: ['module:src/a'] }),
        step({ id: 'two', flowAfter: ['module:src/legacy'] }),
      ]),
      graph,
      [],
    );
    expect(kindOf(delta, 'module:src/legacy')).toBe('stable');
  });

  it('marks an after-only node NEW and absent from today', () => {
    const delta = computeBriefDelta(
      story([step({ flowBefore: ['module:src/a'], flowAfter: ['module:src/a', 'module:src/new'] })]),
      graph,
      [ghost],
    );
    expect(kindOf(delta, 'module:src/new')).toBe('new');
    expect(delta.nodes.find((n) => n.nodeId === 'module:src/new')?.existsToday).toBe(false);
    // A removed node still EXISTS today — that is the point of showing it.
    expect(delta.nodes.find((n) => n.nodeId === 'module:src/a')?.existsToday).toBe(true);
  });

  it('an empty before removes nothing', () => {
    const delta = computeBriefDelta(
      story([step({ flowBefore: [], flowAfter: ['module:src/a', 'module:src/b'] })]),
      graph,
      [],
    );
    expect(delta.nodes.every((n) => n.kind !== 'remove')).toBe(true);
  });

  it('strongest claim wins when a node is reached twice', () => {
    // In before, in no after → remove. Also anchored → modify. remove outranks.
    const delta = computeBriefDelta(
      story([
        step({
          anchors: [{ kind: 'module', ref: 'src/legacy' }],
          phases: [1],
          flowBefore: ['module:src/legacy'],
          flowAfter: ['module:src/a'],
        }),
      ]),
      graph,
      [],
    );
    expect(kindOf(delta, 'module:src/legacy')).toBe('remove');
  });
});

describe('computeBriefDelta — wires', () => {
  it('tags kept / added / removed and withholds added wires from today', () => {
    const delta = computeBriefDelta(
      story([
        step({
          flowBefore: ['module:src/a', 'module:src/legacy'],
          flowAfter: ['module:src/a', 'module:src/b'],
        }),
      ]),
      graph,
      [],
    );
    const removed = delta.wires.find((w) => w.to === 'module:src/legacy');
    const added = delta.wires.find((w) => w.to === 'module:src/b');
    expect(removed?.delta).toBe('removed');
    expect(removed?.drawnToday).toBe(true); // it exists today — that is why it reads as a loss
    expect(added?.delta).toBe('added');
    expect(added?.drawnToday).toBe(false); // never painted in the pre-plan world
  });

  it('never draws a wire whose endpoint does not exist today', () => {
    const delta = computeBriefDelta(
      story([step({ flowAfter: ['module:src/a', 'module:src/new'] })]),
      graph,
      [ghost],
    );
    expect(delta.wires[0].drawnToday).toBe(false);
  });

  it('derives a label from the graph, and honours an authored override', () => {
    const routed: BlueprintGraph = {
      ...graph,
      nodes: [...graph.nodes, { id: 'endpoint:GET /v1/x', kind: 'endpoint', label: 'GET /v1/x', sourceFile: 'r.ts', meta: { method: 'GET', route: '/v1/x' } }],
    };
    const derived = computeBriefDelta(
      story([step({ flowAfter: ['module:src/a', 'endpoint:GET /v1/x'] })]),
      routed,
      [],
    );
    expect(derived.wires[0].labelAfter).toBe('GET /v1/x');

    const overridden = computeBriefDelta(
      story([step({ flowAfter: ['module:src/a -mints the id->', 'endpoint:GET /v1/x'] })]),
      routed,
      [],
    );
    expect(overridden.wires[0].labelAfter).toBe('mints the id');
  });
});

describe('computeBriefDelta — authored slots', () => {
  it('surfaces unchanged and fails verbatim', () => {
    const delta = computeBriefDelta(
      story([
        step({ id: 'a', unchanged: 'The UI is identical.', fails: ['persist throws'] }),
        step({ id: 'b', fails: ['row absent on reload'] }),
      ]),
      graph,
      [],
    );
    expect(delta.unchanged).toBe('The UI is identical.');
    expect(delta.fails).toEqual(['persist throws', 'row absent on reload']);
  });

  it('omits unchanged when no step authored one', () => {
    const delta = computeBriefDelta(story([step({})]), graph, []);
    expect(delta.unchanged).toBeUndefined();
    expect(delta.fails).toEqual([]);
  });
});

describe('computeBriefDelta — determinism', () => {
  it('is deep-equal across repeated runs on the same inputs', () => {
    const s = story([
      step({
        anchors: [{ kind: 'module', ref: 'src/a' }],
        phases: [1],
        flowBefore: ['module:src/a', 'module:src/legacy'],
        flowAfter: ['module:src/a', 'module:src/b', 'module:src/new'],
        unchanged: 'nothing user-visible',
        fails: ['x', 'y'],
      }),
    ]);
    expect(computeBriefDelta(s, graph, [ghost])).toEqual(computeBriefDelta(s, graph, [ghost]));
  });
});

describe('legacy story.json on disk', () => {
  it('normalizes pre-change-brief stories so the model never sees undefined flows', () => {
    // A story.json written BEFORE this feature: `flow` only, no flowBefore /
    // flowAfter / fails. Without normalization the model iterates undefined.
    const dir = mkdtempSync(join(tmpdir(), 'brief-legacy-'));
    writeFileSync(
      join(dir, STORY_FILENAME),
      JSON.stringify({
        plan: 'legacy',
        sourcePath: 'flow/plans/plan_legacy_v1.md',
        mode: 'strict',
        steps: [
          {
            id: 's',
            title: 'S',
            body: '',
            anchors: [],
            flow: ['module:src/a', 'module:src/b'],
            phases: [1],
            decisions: [],
            rejected: [],
            questions: [],
            unresolvedAnchors: [],
            draft: false,
          },
        ],
        warnings: [],
      }),
    );

    const loaded = readCompiledStory(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.steps[0].flowBefore).toEqual([]);
    expect(loaded!.steps[0].flowAfter).toEqual(['module:src/a', 'module:src/b']);
    expect(loaded!.steps[0].fails).toEqual([]);

    // And the model runs on it without throwing, claiming no removals.
    const delta = computeBriefDelta(loaded!, graph, []);
    expect(delta.nodes.every((n) => n.kind !== 'remove')).toBe(true);
  });
});

describe('computeFeatureBrief — anatomy vs delta', () => {
  const routed: BlueprintGraph = {
    ...graph,
    nodes: [...graph.nodes, moduleNode('src/a/deep')],
    edges: [
      { source: 'module:src/a', target: 'module:src/b', relation: 'imports' },
      { source: 'module:src/a', target: 'module:src/a/deep', relation: 'imports' },
    ],
  };

  it('with NO plan in flight it is ANATOMY — everything stable, no authored claims', () => {
    const brief = computeFeatureBrief(['module:src/a'], null, routed, []);
    expect(brief.mode).toBe('anatomy');
    expect(brief.nodes.every((n) => n.kind === 'stable' && n.existsToday)).toBe(true);
    expect(brief.unchanged).toBeUndefined();
    expect(brief.fails).toEqual([]);
    // Descendants of a claimed module are part of the feature's own view.
    expect(brief.nodes.map((n) => n.nodeId).sort()).toEqual(['module:src/a', 'module:src/a/deep']);
  });

  it('anatomy wires come from the derived graph, labelled by relation', () => {
    const brief = computeFeatureBrief(['module:src/a'], null, routed, []);
    expect(brief.wires).toEqual([
      {
        from: 'module:src/a',
        to: 'module:src/a/deep',
        delta: 'kept',
        labelBefore: 'imports',
        labelAfter: 'imports',
        drawnToday: true,
      },
    ]);
  });

  it('with a plan in flight it is a DELTA, sliced to this feature', () => {
    const s = story([
      step({
        flowBefore: ['module:src/a', 'module:src/legacy'],
        flowAfter: ['module:src/a', 'module:src/b'],
        unchanged: 'nothing user-visible',
        fails: ['x'],
      }),
    ]);
    // A feature claiming only src/legacy sees the removal and NOT src/b.
    const brief = computeFeatureBrief(['module:src/legacy'], s, routed, []);
    expect(brief.mode).toBe('delta');
    expect(brief.nodes.map((n) => n.nodeId)).toEqual(['module:src/legacy']);
    expect(brief.nodes[0].kind).toBe('remove');
    expect(brief.unchanged).toBe('nothing user-visible');
  });

  it('a plan spanning several features appears in EACH, showing only its slice', () => {
    const s = story([
      step({ flowBefore: ['module:src/a'], flowAfter: ['module:src/a', 'module:src/b'] }),
    ]);
    const featureA = computeFeatureBrief(['module:src/a'], s, routed, []);
    const featureB = computeFeatureBrief(['module:src/b'], s, routed, []);
    expect(featureA.nodes.map((n) => n.nodeId)).toContain('module:src/a');
    expect(featureA.nodes.map((n) => n.nodeId)).not.toContain('module:src/b');
    expect(featureB.nodes.map((n) => n.nodeId)).toEqual(['module:src/b']);
  });

  it('a feature claiming nothing yields an empty brief, never a throw', () => {
    expect(computeFeatureBrief([], null, routed, []).nodes).toEqual([]);
    expect(computeFeatureBrief([], null, null, []).nodes).toEqual([]);
  });
});

// ── proposals as a delta source (discovery-view) ───────────────────────────

function proposal(partial: Partial<ProposalWithChange> = {}): ProposalWithChange {
  const base: ProposalWithChange = {
    fingerprint: partial.fingerprint ?? 'plan_p_v1+module:src/a',
    plan: partial.plan ?? 'plan_p_v1',
    predictedNodeId: partial.predictedNodeId ?? 'module:src/a',
    kind: partial.kind ?? 'module',
    label: partial.label ?? 'A change',
    anchors: partial.anchors ?? [{ kind: 'module', ref: 'src/a' }],
    state: partial.state ?? 'proposed',
    provenance: 'cli:propose',
    proposedAt: '2026-08-10T16:19:43.078Z',
    change: partial.change ?? 'changed',
    resolvedAnchors: partial.resolvedAnchors ?? ['src/a'],
  };
  if (partial.detail !== undefined) base.detail = partial.detail;
  return base;
}

/** The live store's shape: every proposal CHANGED, on a node that exists. */
const liveDocs = new Set(['discovery_p_v1']);

describe('proposals as a brief source — the shape the renderer already draws', () => {
  it('a proposal on an EXISTING node is a modify that exists today', () => {
    const [node] = proposalBriefNodes([proposal()], graph, liveDocs);
    expect(node.nodeId).toBe('module:src/a');
    expect(node.kind).toBe('modify');
    expect(node.existsToday).toBe(true);
    // The node is real; the CLAIM about it is not. Both facts, separately.
    expect(node.provenance.predicted).toBe(true);
    expect(node.provenance.source).toBe('proposal');
  });

  it('a proposal on an UNKNOWN node is new, absent today, titled by the proposal', () => {
    const [node] = proposalBriefNodes(
      [proposal({ predictedNodeId: 'module:src/ghost', label: 'Parts store invariant' })],
      graph,
      liveDocs,
    );
    expect(node.kind).toBe('new');
    expect(node.existsToday).toBe(false);
    // A ghost titled `module:src/ghost` tells the reader nothing.
    expect(node.label).toBe('Parts store invariant');
  });

  it('emits exactly the BriefNode shape — no second node type for the renderer', () => {
    const fromStory = computeBriefDelta(story([step({ flowAfter: ['module:src/a'] })]), graph, []);
    const [fromProposal] = proposalBriefNodes([proposal()], graph, liveDocs);
    expect(Object.keys(fromProposal).sort()).toEqual(Object.keys(fromStory.nodes[0]).sort());
  });

  it('several proposals on one node accumulate rather than overwrite', () => {
    const [node] = proposalBriefNodes(
      [
        proposal({ fingerprint: 'plan_p_v1+module:src/a', label: 'first' }),
        proposal({ fingerprint: 'zz+module:src/a', label: 'second' }),
      ],
      graph,
      liveDocs,
    );
    expect(node.provenance.proposals.map((p) => p.label)).toEqual(['first', 'second']);
  });

  it('a plan brief renders only ITS plan\'s proposals, matched by slug not name', () => {
    // The store records `plan_p_v1`; the compiled story calls the same work `p`.
    const delta = computeBriefDelta(story([step({ flowAfter: ['module:src/b'] })]), graph, [], {
      proposals: [proposal(), proposal({ fingerprint: 'other+module:src/b', plan: 'plan_other_v1', predictedNodeId: 'module:src/b' })],
      docs: liveDocs,
    });
    expect(delta.proposed.nodes.map((n) => n.nodeId)).toEqual(['module:src/a']);
    // …and it lands in `nodes`, so the existing renderer draws it unchanged.
    expect(delta.nodes.map((n) => n.nodeId)).toEqual(['module:src/a', 'module:src/b']);
  });

  it('a node claimed by both the story and a proposal keeps one entry', () => {
    const delta = computeBriefDelta(
      story([step({ flowBefore: ['module:src/a'], flowAfter: ['module:src/a'] })]),
      graph,
      [],
      { proposals: [proposal()], docs: liveDocs },
    );
    const hits = delta.nodes.filter((n) => n.nodeId === 'module:src/a');
    expect(hits).toHaveLength(1);
    // The story called it stable; the proposal upgrades it to modify.
    expect(hits[0].kind).toBe('modify');
    expect(hits[0].provenance.source).toBe('story');
    expect(hits[0].provenance.proposals).toHaveLength(1);
  });

  it('a terminal proposal is excluded WITH a reason, never silently', () => {
    const { live, skipped } = renderableProposals([
      proposal({ fingerprint: 'gone', state: 'stale' }),
      proposal(),
    ]);
    expect(live).toHaveLength(1);
    expect(skipped).toEqual([
      { fingerprint: 'gone', predictedNodeId: 'module:src/a', reason: 'proposal is stale — no longer a prediction' },
    ]);
  });
});

describe('feature-scoped assembly — including the empty answer', () => {
  it('a feature with attached proposals gets them merged into its anatomy', () => {
    const brief = computeFeatureBrief(['module:src/a'], null, graph, [], {
      proposals: [proposal({ detail: 'writeParts refuses a non-core feature.' })],
      docs: liveDocs,
    });
    expect(brief.mode).toBe('anatomy');
    const node = brief.nodes.find((n) => n.nodeId === 'module:src/a');
    expect(node?.kind).toBe('modify');
    expect(node?.provenance.proposals[0].detail).toBe('writeParts refuses a non-core feature.');
    expect(brief.proposed.nothingProposed).toBe(false);
  });

  it('a proposal outside the feature\'s claimed nodes still shows on it', () => {
    // Attachment already decided this belongs here; the claim set must not
    // silently veto the decision.
    const brief = computeFeatureBrief(['module:src/a'], null, graph, [], {
      proposals: [proposal({ predictedNodeId: 'module:src/ghost', label: 'New store' })],
      docs: liveDocs,
    });
    expect(brief.nodes.map((n) => n.nodeId)).toContain('module:src/ghost');
  });

  it('NOTHING PROPOSED is an answer — stated, not an empty list to interpret', () => {
    const brief = computeFeatureBrief(['module:src/a'], null, graph, [], {
      proposals: [],
      docs: liveDocs,
    });
    expect(brief.proposed.nothingProposed).toBe(true);
    expect(brief.proposed.summary).toBe(NOTHING_PROPOSED_SUMMARY);
    expect(brief.proposed.nodes).toEqual([]);
    expect(brief.proposed.sources).toEqual([]);
    // And the feature's own anatomy is untouched by the absence.
    expect(brief.nodes.map((n) => n.nodeId)).toEqual(['module:src/a']);
    expect(brief.nodes[0].provenance.predicted).toBe(false);
  });

  it('a caller passing no options behaves exactly as before, with an empty layer', () => {
    const brief = computeFeatureBrief(['module:src/a'], null, graph, []);
    expect(brief.proposed.nothingProposed).toBe(true);
    expect(brief.nodes.every((n) => n.kind === 'stable')).toBe(true);
  });

  it('proposals survive the delta slice too', () => {
    const s = story([step({ flowBefore: ['module:src/a'], flowAfter: ['module:src/a', 'module:src/b'] })]);
    const brief = computeFeatureBrief(['module:src/a'], s, graph, [], {
      proposals: [proposal()],
      docs: liveDocs,
    });
    expect(brief.mode).toBe('delta');
    expect(brief.nodes.find((n) => n.nodeId === 'module:src/a')?.provenance.proposals).toHaveLength(1);
  });
});

describe('provenance in the payload — nothing left for a renderer to infer', () => {
  it('carries the proposal label and detail per node (the CHANGED-only case)', () => {
    // The measured reality: three proposals, all CHANGED, all on nodes that
    // already exist. Without label + detail this is three marks on three boxes.
    const brief = computeFeatureBrief(['module:src/a'], null, graph, [], {
      proposals: [
        proposal({
          label: 'Parts store invariant',
          detail: 'writeParts refuses a feature whose kind is not core.',
        }),
      ],
      docs: liveDocs,
    });
    const claim = brief.nodes.find((n) => n.nodeId === 'module:src/a')!.provenance.proposals[0];
    expect(claim.label).toBe('Parts store invariant');
    expect(claim.detail).toBe('writeParts refuses a feature whose kind is not core.');
    expect(claim.change).toBe('changed');
    expect(claim.state).toBe('proposed');
    expect(claim.resolvedAnchors).toEqual(['src/a']);
  });

  it('resolves the SOURCE DOC and its kind — a discovery must not read as a plan', () => {
    // The live store's exact situation: recorded under a plan name whose plan
    // does not exist yet, backed on disk by the discovery that named it.
    expect(resolveProposalSource('plan_change-record-parts_v1', new Set(['discovery_change-record-parts_v1']))).toEqual({
      plan: 'plan_change-record-parts_v1',
      doc: 'discovery_change-record-parts_v1',
      kind: 'discovery',
    });
    // An exact match wins outright.
    expect(resolveProposalSource('plan_x_v1', new Set(['plan_x_v1', 'discovery_x_v1']))).toEqual({
      plan: 'plan_x_v1',
      doc: 'plan_x_v1',
      kind: 'plan',
    });
    // Nothing on disk is STATED, never guessed at.
    expect(resolveProposalSource('plan_gone_v1', new Set())).toEqual({
      plan: 'plan_gone_v1',
      doc: null,
      kind: 'none',
    });
  });

  it('marks every node predicted-or-real without the renderer computing anything', () => {
    const delta = computeBriefDelta(
      story([step({ flowBefore: ['module:src/a', 'module:src/legacy'], flowAfter: ['module:src/a', 'module:src/new'] })]),
      graph,
      [ghost],
      { proposals: [proposal()], docs: liveDocs },
    );
    const by = (id: string) => delta.nodes.find((n) => n.nodeId === id)!;
    // Observed fact: present in both worlds, untouched, no proposal.
    expect(by('module:src/legacy').provenance.predicted).toBe(true); // removal is a claim
    expect(by('module:src/new').provenance.predicted).toBe(true);
    expect(by('module:src/new').existsToday).toBe(false);
    // Real node, predicted change — the two fields disagreeing IS the point.
    expect(by('module:src/a').existsToday).toBe(true);
    expect(by('module:src/a').provenance.predicted).toBe(true);
  });

  it('a purely observed node is not predicted and carries no proposals', () => {
    const brief = computeFeatureBrief(['module:src/a'], null, graph, []);
    expect(brief.nodes[0].provenance).toEqual({ source: 'graph', predicted: false, proposals: [] });
  });

  it('carries every filed anchor and the building phase — a new part resolves none of them', () => {
    const fresh = { ...proposal({ fingerprint: 'n', predictedNodeId: 'feature:board/review', kind: 'part', change: 'new', resolvedAnchors: [], anchors: [{ kind: 'file', ref: 'src/review.ts' }, { kind: 'module', ref: 'module:src/a' }] }), phase: 2 };
    const layer = assembleProposals([fresh, proposal({ fingerprint: 'o' })], graph, liveDocs);
    const claimOf = (fingerprint: string) =>
      layer.nodes.flatMap((n) => n.provenance.proposals).find((p) => p.fingerprint === fingerprint)!;
    expect(claimOf('n').anchors).toEqual(['file:src/review.ts', 'module:src/a']);
    expect(claimOf('n').phase).toBe(2);
    expect(claimOf('o').phase).toBeUndefined();
  });

  it('lists the source documents once each, sorted', () => {
    const layer = assembleProposals(
      [
        proposal({ fingerprint: 'b', plan: 'plan_zeta_v1', predictedNodeId: 'module:src/b' }),
        proposal({ fingerprint: 'a' }),
        proposal({ fingerprint: 'c', predictedNodeId: 'module:src/legacy' }),
      ],
      graph,
      new Set(['discovery_p_v1', 'plan_zeta_v1']),
    );
    expect(layer.sources).toEqual([
      { plan: 'plan_p_v1', doc: 'discovery_p_v1', kind: 'discovery' },
      { plan: 'plan_zeta_v1', doc: 'plan_zeta_v1', kind: 'plan' },
    ]);
    expect(layer.summary).toBe('proposed: 3 node(s) from 2 source(s) — 0 new, 3 changed');
  });
});

describe('determinism — same store + same graph, byte-identical output', () => {
  const proposals = [
    proposal({ fingerprint: 'z+module:src/legacy', predictedNodeId: 'module:src/legacy', label: 'Zeta' }),
    proposal({ fingerprint: 'a+module:src/a', detail: 'first', resolvedAnchors: ['src/a', 'src/a/deep'] }),
    proposal({ fingerprint: 'm+module:src/ghost', predictedNodeId: 'module:src/ghost', label: 'Mid' }),
  ];

  it('the plan-scoped brief serializes identically across two runs', () => {
    const s = story([
      step({
        anchors: [{ kind: 'module', ref: 'src/a' }],
        phases: [1],
        flowBefore: ['module:src/a', 'module:src/legacy'],
        flowAfter: ['module:src/a', 'module:src/b'],
        unchanged: 'nothing user-visible',
        fails: ['x'],
      }),
    ]);
    const run = () => JSON.stringify(computeBriefDelta(s, graph, [ghost], { proposals, docs: liveDocs }));
    expect(run()).toBe(run());
  });

  it('the feature-scoped brief serializes identically across two runs', () => {
    const run = () =>
      JSON.stringify(computeFeatureBrief(['module:src/a'], null, graph, [], { proposals, docs: liveDocs }));
    expect(run()).toBe(run());
  });

  it('input ORDER does not change the output — the store\'s order is not the view\'s', () => {
    const forward = JSON.stringify(assembleProposals(proposals, graph, liveDocs).nodes);
    const reversed = JSON.stringify(assembleProposals([...proposals].reverse(), graph, liveDocs).nodes);
    expect(forward).toBe(reversed);
  });

  it('the empty case is byte-identical too', () => {
    const run = () => JSON.stringify(assembleProposals([], graph, liveDocs));
    expect(run()).toBe(run());
    expect(JSON.parse(run()).nothingProposed).toBe(true);
  });
});
