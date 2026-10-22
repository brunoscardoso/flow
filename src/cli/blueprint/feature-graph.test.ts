import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildFeatureGraph,
  buildFeatureIndexMarkdown,
  buildFeatureRoster,
  computeCoverage,
  FEATURE_INDEX_BANNER,
  FEATURE_INDEX_RELPATH,
  groupByDomain,
  moduleOfPartAnchor,
  normalizeAnchorRef,
  partNodeId,
  partUnderstandingOf,
  readModuleLearning,
  resolveAnchors,
  understandingOf,
  UNASSIGNED_DOMAIN,
  type FeatureUnderstanding,
  type FolderRowsFor,
} from './feature-graph.js';
import { createFolderRowsBuilder } from './feature-folders.js';
import type { SizeHost } from './feature-size.js';
import {
  addressPartNames,
  featureHome,
  parseFeatureFile,
  parseParts,
  splitParts,
  type FeatureNode,
  type FeaturePart,
} from './feature-store.js';
import type { BlueprintGraph } from './types.js';

function feature(slug: string, patch: Partial<FeatureNode> = {}): FeatureNode {
  return { ...parseFeatureFile(slug, `# Feature: ${slug}\n`), ...patch };
}

const learning = new Map<string, FeatureUnderstanding>([
  ['src/auth', 'learned'],
  ['src/billing', 'stale'],
  ['src/ui', 'learning'],
]);

const graph: BlueprintGraph = {
  version: 1,
  derivedAt: '2026-08-01T00:00:00.000Z',
  coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['modules'], graphifyEnriched: false },
  nodes: [
    { id: 'module:src/auth', kind: 'module', label: 'auth', sourceFile: 'src/auth', meta: {} },
    { id: 'module:src/auth/tokens', kind: 'module', label: 'tokens', sourceFile: 'x', meta: {} },
    { id: 'module:src/orphan', kind: 'module', label: 'orphan', sourceFile: 'x', meta: {} },
    { id: 'endpoint:GET /x', kind: 'endpoint', label: 'GET /x', sourceFile: 'x', meta: {} },
  ],
  edges: [],
};

/** A feature whose own `## Learned` section carries one entry. */
function learnedFeature(slug: string, patch: Partial<FeatureNode> = {}): FeatureNode {
  // The real serialized shape (feature-store's serializeLearnings) — a fixture
  // in a format the parser rejects would make these tests pass for the wrong
  // reason, or fail for one.
  const body =
    `# Feature: ${slug}\n\n## Learned\n` +
    `- Offsets commit once per poll batch. <!-- learned: blueprint-observe 2026-08-05 -->\n`;
  return { ...parseFeatureFile(slug, body), ...patch };
}

describe('understanding — the FEATURE’s own, not its modules’', () => {
  // THE BUG THIS ENCODES. Basic discovery learns modules; on orbit-core it
  // learned 29 of them, and ~30 feature cards then reported `learned` while
  // their body was still the bootstrap stub. Understanding a directory is not
  // understanding what the product does with it.
  it('a learned MODULE never makes the feature learned', () => {
    expect(understandingOf(feature('f', { anchors: ['module:src/auth'] }), learning)).toBe('none');
  });

  it('is learned when the feature itself carries learnings', () => {
    expect(understandingOf(learnedFeature('f', { anchors: ['module:src/auth'] }), learning)).toBe(
      'learned',
    );
    // …even when no module under it was ever learned: the knowledge is the
    // feature's, and it does not depend on the module tier having run.
    expect(
      understandingOf(learnedFeature('f', { anchors: ['module:src/never-seen'] }), learning),
    ).toBe('learned');
  });

  it('goes stale when the feature is learned but its code has drifted', () => {
    expect(understandingOf(learnedFeature('f', { anchors: ['module:src/billing'] }), learning)).toBe(
      'stale',
    );
  });

  it('drift under an UNLEARNED feature is not stale — there is nothing to go stale', () => {
    expect(understandingOf(feature('f', { anchors: ['module:src/billing'] }), learning)).toBe('none');
  });

  it('reports in-flight work as learning — honest, and not mistakable for knowledge', () => {
    expect(understandingOf(feature('f', { anchors: ['module:src/ui'] }), learning)).toBe('learning');
  });

  it('is none when no anchor names a module — unknown, not learned', () => {
    expect(understandingOf(feature('f', { anchors: [] }), learning)).toBe('none');
    expect(understandingOf(feature('f', { anchors: ['datastore:pg'] }), learning)).toBe('none');
  });

  it('rolls a file anchor up to its directory for the in-flight signal', () => {
    expect(understandingOf(feature('f', { anchors: ['file:src/ui/x.ts'] }), learning)).toBe(
      'learning',
    );
  });
});

/**
 * THE OTHER HALF OF UNDERSTANDING — a curated view is the feature's own
 * artifact, so it counts. See the essay on `understandingOf`: this is
 * `d5ae3b83`'s rule applied, not widened, and VALIDITY is the whole guard.
 */
describe('understanding — a valid curated view is the feature’s own evidence', () => {
  const drawn = new Set(['f']);

  it('is learned from a VALID view alone, with no `## Learned` at all', () => {
    expect(understandingOf(feature('f', { anchors: ['module:src/never-seen'] }), learning, drawn)).toBe(
      'learned',
    );
  });

  // THE d5ae3b83 GUARD. An artifact that is merely ON DISK proves nothing —
  // this repo's own stored view was dead for four days with three validator
  // errors nobody saw. The caller only ever puts a slug in this set after
  // `validateFeatureView` passed, so a broken view is simply absent from it,
  // and the feature reports what it actually is: unexamined.
  it('an INVALID view is not in the set, so the feature stays none', () => {
    expect(understandingOf(feature('f', { anchors: ['module:src/never-seen'] }), learning, new Set())).toBe(
      'none',
    );
  });

  it('a view belonging to ANOTHER feature never lights this one', () => {
    expect(
      understandingOf(feature('f', { anchors: ['module:src/never-seen'] }), learning, new Set(['other'])),
    ).toBe('none');
  });

  // STALE MEANS THE SAME THING FOR EITHER ARTIFACT: the code the evidence was
  // drawn from has drifted. A view is if anything MORE code-bound than prose —
  // it cites file-and-line excerpts — so the shared rule is the conservative one.
  it('goes stale when the evidence is a view and its code has drifted', () => {
    expect(understandingOf(feature('f', { anchors: ['module:src/billing'] }), learning, drawn)).toBe(
      'stale',
    );
  });

  it('in-flight module work never outranks a view that already exists', () => {
    expect(understandingOf(feature('f', { anchors: ['module:src/ui'] }), learning, drawn)).toBe(
      'learned',
    );
  });

  it('omitting the set leaves every existing caller exactly as it was', () => {
    expect(understandingOf(learnedFeature('f', { anchors: ['module:src/auth'] }), learning)).toBe(
      'learned',
    );
    expect(understandingOf(feature('f', { anchors: ['module:src/auth'] }), learning)).toBe('none');
  });
});

describe('the roster — the vocabulary an edge writer names the other side from', () => {
  it('carries id, slug, name, kind and the SAME summary a card shows', () => {
    const chats = learnedFeature('chats', { name: 'Chats' });
    expect(buildFeatureRoster([chats])).toEqual([
      {
        id: 'feature:chats',
        slug: 'chats',
        name: 'Chats',
        kind: 'core',
        // featureSummary's own answer, not a second one authored here.
        summary: 'Offsets commit once per poll batch.',
      },
    ]);
  });

  it('includes an UNLEARNED feature — a name is a name before anyone reads it', () => {
    const roster = buildFeatureRoster([feature('auth'), learnedFeature('chats')]);
    expect(roster.map((entry) => entry.id)).toEqual(['feature:auth', 'feature:chats']);
    expect(roster[0].summary).toBe(''); // says nothing yet, and says so
  });

  it('includes change records, marked as such rather than silently dropped', () => {
    const roster = buildFeatureRoster([feature('migration', { kind: 'child', parent: 'feature:chats' })]);
    expect(roster[0].kind).toBe('child');
  });

  it('is sorted by id, so the same store yields the same roster', () => {
    const input = [feature('z'), feature('a'), feature('m')];
    expect(buildFeatureRoster(input).map((entry) => entry.id)).toEqual([
      'feature:a',
      'feature:m',
      'feature:z',
    ]);
    expect(buildFeatureRoster(input)).toEqual(buildFeatureRoster([...input].reverse()));
  });

  it('never mutates or reorders the caller’s array', () => {
    const input = [feature('z'), feature('a')];
    buildFeatureRoster(input);
    expect(input.map((entry) => entry.slug)).toEqual(['z', 'a']);
  });

  it('is empty for an empty store — never a synthesised placeholder', () => {
    expect(buildFeatureRoster([])).toEqual([]);
  });
});

describe('feature graph', () => {
  it('carries understanding and activity per node', () => {
    const built = buildFeatureGraph(
      [feature('auth', { anchors: ['module:src/auth'] }), feature('billing', { anchors: ['module:src/billing'] })],
      learning,
      new Set(['module:src/billing']),
    );
    expect(built.nodes.map((n) => [n.slug, n.understanding, n.active])).toEqual([
      // Both are unlearned FEATURES — auth's module being learned buys it
      // nothing, and billing's drift has no feature knowledge to stale.
      ['auth', 'none', false],
      ['billing', 'none', true],
    ]);
  });

  it('emits one edge per unordered relates pair', () => {
    const a = feature('a', { relates: [{ target: 'feature:b' }] });
    const b = feature('b', { relates: [{ target: 'feature:a' }] }); // both sides declare it
    expect(buildFeatureGraph([a, b], learning).edges).toEqual([{ from: 'feature:a', to: 'feature:b' }]);
  });

  it('drops a relates target that does not exist, and self-links', () => {
    const a = feature('a', { relates: [{ target: 'feature:ghost' }, { target: 'feature:a' }] });
    expect(buildFeatureGraph([a], learning).edges).toEqual([]);
  });

  it('reads the TARGET of a structured edge — via/note are for the reader, not the graph', () => {
    const a = feature('a', {
      relates: [
        { target: 'feature:b', via: 'src/bind.ts', note: 'a step names b by slug; bind.ts resolves it' },
      ],
    });
    const b = feature('b');
    expect(buildFeatureGraph([a, b], learning).edges).toEqual([{ from: 'feature:a', to: 'feature:b' }]);
  });

  it('renders a child with a missing parent at level 1 rather than losing it', () => {
    const orphan = feature('orphan', { kind: 'child', parent: 'feature:gone' });
    const built = buildFeatureGraph([orphan], learning);
    expect(built.nodes).toHaveLength(1);
    expect(built.nodes[0].parent).toBeUndefined();
  });

  it('is deterministic', () => {
    const input = [feature('b'), feature('a')];
    expect(buildFeatureGraph(input, learning)).toEqual(buildFeatureGraph(input, learning));
  });

  it('carries domain onto the graph node, absent stays absent', () => {
    const built = buildFeatureGraph(
      [feature('auth', { domain: 'CLI' }), feature('billing')],
      learning,
    );
    expect(built.nodes.find((n) => n.slug === 'auth')?.domain).toBe('CLI');
    expect(built.nodes.find((n) => n.slug === 'billing')?.domain).toBeUndefined();
  });
});

// ── Parts as nodes ───────────────────────────────────────────
//
// THE BUG THIS SECTION ENCODES. `buildFeatureGraph` read only frontmatter, so
// the ring showed `child` nodes — CHANGE records, plans and issues — while the
// ten real parts sitting in the same markdown file were invisible. Measured on
// three real stores: 7 changes shown, 81 parts hidden.

function part(name: string, patch: Partial<FeaturePart> = {}): FeaturePart {
  return { name, summary: '', anchors: [], learnings: [], ...patch };
}

/**
 * The ten parts of orbit-app's `chats`, in the order a human wrote them —
 * a message's journey through the system, which is the whole reason document
 * order is load-bearing.
 */
const CHATS_PARTS = [
  'Chat UI',
  'Chat SDK client',
  'Message renderer',
  'Chats list',
  'Gateway BFF stream',
  'SSE events endpoint',
  'Agent core engine',
  'History store',
  'Queue stream bus',
  'Chat control API',
];

describe('parts become nodes', () => {
  it('emits one node per part, parented to the feature and marked as a part', () => {
    const built = buildFeatureGraph(
      [feature('chats')],
      learning,
      new Set(),
      new Set(),
      new Map([
        [
          'chats',
          [
            part('SSE events endpoint', {
              summary: 'Streams live events to the browser.',
              anchors: ['src/app/api/events/route.ts', 'src/lib/sse.ts'],
            }),
          ],
        ],
      ]),
    );
    const node = built.nodes.find((n) => n.kind === 'part');
    expect(node).toEqual({
      id: 'feature:chats/sse-events-endpoint',
      slug: 'chats',
      name: 'SSE events endpoint',
      kind: 'part',
      parent: 'feature:chats',
      partOf: 'chats',
      understanding: 'none',
      active: false,
      anchorCount: 2,
      summary: 'Streams live events to the browser.',
      // One API anchor, one helper anchor: a tie, so the guess is neutral.
      role: 'neutral',
      roleSource: 'guess',
    });
  });

  it('keeps DOCUMENT order inside a feature while features still sort by id', () => {
    const built = buildFeatureGraph(
      [feature('zeta'), feature('chats')],
      learning,
      new Set(),
      new Set(),
      new Map([
        ['chats', CHATS_PARTS.map((name) => part(name))],
        ['zeta', [part('Only part')]],
      ]),
    );
    // Features by id: chats before zeta. Parts by the order they were written —
    // alphabetising would open with "Chat SDK client" and lose the narrative.
    expect(built.nodes.map((n) => n.name)).toEqual([
      'Chats',
      ...CHATS_PARTS,
      'Zeta',
      'Only part',
    ]);
  });

  it('reads parts written as real markdown, not just as literals', () => {
    // A fixture in a shape `parseParts` rejects would prove nothing about the
    // files this actually runs against.
    const body =
      '# Feature: chats\n\n## Parts\n\n' +
      '### Chat UI\nThe per-chat conversation surface.\nanchors: src/components/chat/Wrapper.tsx\n\n' +
      '### SSE events endpoint\nStreams live events.\nanchors: src/app/api/events/route.ts\n';
    const parts = parseParts(splitParts(body).parts);
    const built = buildFeatureGraph([feature('chats')], learning, new Set(), new Set(), new Map([['chats', parts]]));
    expect(built.nodes.filter((n) => n.kind === 'part').map((n) => [n.id, n.summary])).toEqual([
      ['feature:chats/chat-ui', 'The per-chat conversation surface.'],
      ['feature:chats/sse-events-endpoint', 'Streams live events.'],
    ]);
  });

  it('an absent parts map yields exactly today’s graph', () => {
    const features = [feature('a'), feature('b', { relates: [{ target: 'feature:a' }] })];
    expect(buildFeatureGraph(features, learning, new Set(), new Set(), new Map())).toEqual(
      buildFeatureGraph(features, learning),
    );
    expect(buildFeatureGraph(features, learning).nodes.every((n) => n.kind !== 'part')).toBe(true);
  });

  it('ignores parts keyed to a feature that is not in the graph', () => {
    const built = buildFeatureGraph(
      [feature('a')],
      learning,
      new Set(),
      new Set(),
      new Map([['ghost', [part('Nowhere')]]]),
    );
    expect(built.nodes.map((n) => n.id)).toEqual(['feature:a']);
  });

  it('is active only when a live plan touches the PART’s own anchor', () => {
    const built = buildFeatureGraph(
      [feature('chats', { anchors: ['module:src/app'] })],
      learning,
      new Set(['module:src/app', 'src/lib/sse.ts']),
      new Set(),
      new Map([['chats', [part('Stream', { anchors: ['src/lib/sse.ts'] }), part('List', { anchors: ['src/lib/list.ts'] })]]]),
    );
    expect(built.nodes.map((n) => [n.name, n.active])).toEqual([
      ['Chats', true],
      ['Stream', true],
      ['List', false], // its sibling being touched buys it nothing
    ]);
  });
});

describe('part ids — stable and collision-safe', () => {
  it('is the feature id plus the slugified part name', () => {
    expect(partNodeId('feature:chats', 'Gateway BFF stream')).toBe('feature:chats/gateway-bff-stream');
  });

  it('gives a duplicate name a deterministic suffix rather than dropping a node', () => {
    const built = buildFeatureGraph(
      [feature('chats')],
      learning,
      new Set(),
      new Set(),
      new Map([['chats', [part('Stream'), part('Stream'), part('Stream')]]]),
    );
    // NFR2: three parts in, three nodes out. A vanished node is not even
    // visible as a bug.
    expect(built.nodes.filter((n) => n.kind === 'part').map((n) => n.id)).toEqual([
      'feature:chats/stream',
      'feature:chats/stream-2',
      'feature:chats/stream-3',
    ]);
  });

  it('gives the same store the same ids on every build', () => {
    // FR7: the composer's reference chip stores this string and nothing
    // detects a broken reference, so instability is a silent failure.
    const features = [feature('chats'), feature('auth')];
    const parts = new Map([
      ['chats', CHATS_PARTS.map((name) => part(name, { anchors: ['src/a.ts'] }))],
      ['auth', [part('Session cookie'), part('Session cookie')]],
    ]);
    const first = buildFeatureGraph(features, learning, new Set(), new Set(), parts);
    const second = buildFeatureGraph(features, learning, new Set(), new Set(), parts);
    expect(first.nodes.map((n) => n.id)).toEqual(second.nodes.map((n) => n.id));
    expect(new Set(first.nodes.map((n) => n.id)).size).toBe(first.nodes.length);
  });

  it('skips an unnamed part — it would be unaddressable', () => {
    const built = buildFeatureGraph(
      [feature('a')],
      learning,
      new Set(),
      new Set(),
      new Map([['a', [part('  '), part('Real')]]]),
    );
    expect(built.nodes.filter((n) => n.kind === 'part').map((n) => n.name)).toEqual(['Real']);
  });
});

describe('a part’s understanding is the PART’s own', () => {
  const learned = [{ text: 'Offsets commit once per batch.', provenance: 'code' as const, date: '2026-08-05' }];

  it('is learned from its own non-superseded learnings', () => {
    expect(partUnderstandingOf(part('p', { anchors: ['src/a.ts'], learnings: learned }), learning)).toBe(
      'learned',
    );
  });

  it('a SUPERSEDED learning is retained prose, not knowledge', () => {
    const superseded = [{ ...learned[0], supersededReason: 'the endpoint moved' }];
    expect(partUnderstandingOf(part('p', { anchors: ['src/a.ts'], learnings: superseded }), learning)).toBe(
      'none',
    );
  });

  // THE d5ae3b83 MISTAKE, ONE LEVEL DOWN. A sibling being learned must never
  // light this part up.
  it('never inherits from its feature, and a learned sibling lights nothing', () => {
    const built = buildFeatureGraph(
      [learnedFeature('chats', { anchors: ['module:src/auth'] })],
      learning,
      new Set(),
      new Set(['chats']), // the feature has a valid curated view AND learnings
      new Map([
        ['chats', [part('Known', { anchors: ['src/a.ts'], learnings: learned }), part('Unknown', { anchors: ['src/b.ts'] })]],
      ]),
    );
    expect(built.nodes.map((n) => [n.name, n.understanding])).toEqual([
      ['Chats', 'learned'],
      ['Known', 'learned'],
      ['Unknown', 'none'],
    ]);
  });

  it('a part with no anchors is none, even carrying learnings', () => {
    // The CLI refuses to learn such a part — "nothing to learn it from" — so it
    // must never be able to claim it has been.
    expect(partUnderstandingOf(part('p', { anchors: [], learnings: learned }), learning)).toBe('none');
  });

  it('reports in-flight work on its own anchors as learning', () => {
    expect(partUnderstandingOf(part('p', { anchors: ['src/ui/Panel.tsx'] }), learning)).toBe('learning');
  });

  it('goes stale when its own learnings exist and its own code drifted', () => {
    expect(
      partUnderstandingOf(part('p', { anchors: ['src/billing/charge.ts'], learnings: learned }), learning),
    ).toBe('stale');
    // Drift under an UNLEARNED part is not stale — there is nothing to go stale.
    expect(partUnderstandingOf(part('p', { anchors: ['src/billing/charge.ts'] }), learning)).toBe('none');
  });
});

describe('determinism over a whole fixture store', () => {
  // The blueprint render already holds this rule byte-for-byte, and the graph
  // needs it for a different reason: a ring that reshuffles between derives
  // makes the board unreadable and breaks every saved reference at once
  // (NFR1). Deep equality over the FULL result, not a spot-check on ids.
  const fixture: FeatureNode[] = [
    learnedFeature('chats', { domain: 'Renderer', anchors: ['module:src/ui'], relates: [{ target: 'feature:auth' }] }),
    feature('auth', { domain: 'CLI', anchors: ['module:src/auth'], relates: [{ target: 'feature:chats' }] }),
    feature('migration', { kind: 'child', parent: 'feature:chats' }),
    feature('orphan-change', { kind: 'child', parent: 'feature:gone' }),
  ];
  const parts = new Map<string, FeaturePart[]>([
    [
      'chats',
      CHATS_PARTS.map((name, index) =>
        part(name, {
          summary: `Piece ${index}.`,
          anchors: index % 2 === 0 ? ['src/ui/Panel.tsx'] : ['src/billing/charge.ts'],
          learnings:
            index < 3
              ? [{ text: 'Known.', provenance: 'code' as const, date: '2026-08-05' }]
              : [],
        }),
      ),
    ],
    ['auth', [part('Session cookie'), part('Session cookie'), part('Token refresh')]],
  ]);

  it('builds byte-identical results twice', () => {
    const first = buildFeatureGraph(fixture, learning, new Set(['module:src/auth']), new Set(['chats']), parts);
    const second = buildFeatureGraph(fixture, learning, new Set(['module:src/auth']), new Set(['chats']), parts);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('never loses a feature to its parts, and never loses a part to a collision', () => {
    const built = buildFeatureGraph(fixture, learning, new Set(), new Set(), parts);
    expect(built.nodes.filter((n) => n.kind === 'core')).toHaveLength(2);
    expect(built.nodes.filter((n) => n.kind === 'child')).toHaveLength(2);
    expect(built.nodes.filter((n) => n.kind === 'part')).toHaveLength(13);
    expect(new Set(built.nodes.map((n) => n.id)).size).toBe(built.nodes.length);
  });

  it('survives a malformed parts section rather than throwing', () => {
    // Whatever `## Parts` holds, `parseParts` yields a list and the graph
    // yields a graph — NFR2.
    const junk = parseParts(splitParts('# f\n\n## Parts\n\nanchors: dangling\n- orphan learning\n').parts);
    expect(() => buildFeatureGraph([feature('f')], learning, new Set(), new Set(), new Map([['f', junk]]))).not.toThrow();
  });
});

describe('moduleOfPartAnchor — bare paths, the form parts actually use', () => {
  it('rolls a bare file path up to its directory', () => {
    expect(moduleOfPartAnchor('src/components/chat/Wrapper.tsx')).toBe('src/components/chat');
  });

  it('treats an extension-less path as already a directory', () => {
    expect(moduleOfPartAnchor('e2e/tests/chats')).toBe('e2e/tests/chats');
  });

  it('still honours the prefixed forms — one grammar, not two', () => {
    expect(moduleOfPartAnchor('module:src/auth')).toBe('src/auth');
    expect(moduleOfPartAnchor('file:src/ui/x.ts')).toBe('src/ui');
  });

  it('names no module for an empty or top-level file anchor', () => {
    expect(moduleOfPartAnchor('  ')).toBeNull();
    expect(moduleOfPartAnchor('package.json')).toBeNull();
  });
});

describe('groupByDomain', () => {
  it('groups core nodes by domain, sorted by domain name', () => {
    const built = buildFeatureGraph(
      [
        feature('billing', { domain: 'Renderer' }),
        feature('cli-tool', { domain: 'CLI' }),
        feature('worker', { domain: 'CLI' }),
      ],
      learning,
    );
    const groups = groupByDomain(built.nodes);
    expect(groups.map((g) => g.domain)).toEqual(['CLI', 'Renderer']);
    expect(groups.find((g) => g.domain === 'CLI')?.features.map((f) => f.slug)).toEqual([
      'cli-tool',
      'worker',
    ]);
  });

  it('buckets features with no domain under an explicit Unassigned group, never drops them', () => {
    const built = buildFeatureGraph(
      [feature('auth', { domain: 'CLI' }), feature('mystery')],
      learning,
    );
    const groups = groupByDomain(built.nodes);
    const unassigned = groups.find((g) => g.domain === UNASSIGNED_DOMAIN);
    expect(unassigned).toBeDefined();
    expect(unassigned?.features.map((f) => f.slug)).toEqual(['mystery']);
  });

  it('sorts Unassigned last regardless of the other domain names', () => {
    const built = buildFeatureGraph(
      [feature('mystery'), feature('a-domain', { domain: 'Zebra' })],
      learning,
    );
    expect(groupByDomain(built.nodes).map((g) => g.domain)).toEqual(['Zebra', UNASSIGNED_DOMAIN]);
  });

  it('excludes child nodes — they group with their parent card, not independently', () => {
    const built = buildFeatureGraph(
      [
        feature('parent', { domain: 'CLI' }),
        feature('kid', { kind: 'child', parent: 'feature:parent', domain: 'CLI' }),
      ],
      learning,
    );
    const groups = groupByDomain(built.nodes);
    expect(groups).toHaveLength(1);
    expect(groups[0].features.map((f) => f.slug)).toEqual(['parent']);
  });
});

describe('coverage — the blind spot, computed not stored', () => {
  it('reports modules no feature anchors', () => {
    const report = computeCoverage([feature('auth', { anchors: ['module:src/auth'] })], graph);
    expect(report.uncovered).toEqual(['module:src/orphan']);
    expect(report.total).toBe(3); // endpoints are not counted
    expect(report.features).toBe(1);
  });

  it('treats a descendant of a claimed module as covered', () => {
    const report = computeCoverage([feature('auth', { anchors: ['module:src/auth'] })], graph);
    expect(report.uncovered).not.toContain('module:src/auth/tokens');
  });

  it('reports everything uncovered when there are no features', () => {
    expect(computeCoverage([], graph).uncovered).toHaveLength(3);
  });

  it('is empty and safe without a graph', () => {
    expect(computeCoverage([feature('a')], null)).toEqual({ uncovered: [], total: 0, features: 1 });
  });
});

describe('learning-state reader — fail-soft', () => {
  it('reads valid lines and skips corrupt ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-'));
    writeFileSync(
      join(dir, 'learning-state.jsonl'),
      '{"module":"src/a","status":"learned"}\n{bad\n{"module":"src/b","status":"bogus"}\n{"module":"src/c","status":"stale"}\n',
    );
    const map = readModuleLearning(dir);
    expect([...map.entries()].sort()).toEqual([
      ['src/a', 'learned'],
      ['src/c', 'stale'],
    ]);
  });

  it('is empty when the store is absent', () => {
    expect(readModuleLearning(mkdtempSync(join(tmpdir(), 'fg-'))).size).toBe(0);
  });
});

// ── Anchor resolution ────────────────────────────────────────
//
// Regression guard for a ledger that was wrong by construction: it judged
// EVERY anchor against graph node ids, but the graph has no `file:` nodes at
// all (its kinds are module / endpoint / integration / datastore). So a
// `file:` anchor pointing at a file plainly present on disk was reported
// unresolved forever, and briefs read as "nothing here is verified".

describe('normalizeAnchorRef', () => {
  it('leaves a clean anchor untouched', () => {
    expect(normalizeAnchorRef('module:src/auth')).toBe('module:src/auth');
    expect(normalizeAnchorRef('file:src/types/plan.ts')).toBe('file:src/types/plan.ts');
  });

  it('strips the backticks a code span leaves behind', () => {
    expect(normalizeAnchorRef('file:`src/stores/chatStore.ts`')).toBe('file:src/stores/chatStore.ts');
  });

  it('strips the brackets a markdown link leaves behind', () => {
    expect(normalizeAnchorRef('file:[KnowledgeHubDetail/index.tsx')).toBe('file:KnowledgeHubDetail/index.tsx');
    expect(normalizeAnchorRef('file:stores/knowledgeHubStore.ts]')).toBe('file:stores/knowledgeHubStore.ts');
  });

  it('drops a locator that names a place INSIDE the file', () => {
    expect(normalizeAnchorRef('file:src/hooks/useMessageCatchup.ts:findByClientId')).toBe(
      'file:src/hooks/useMessageCatchup.ts',
    );
    expect(normalizeAnchorRef('file:src/hooks/useMessageCatchup.ts:50')).toBe(
      'file:src/hooks/useMessageCatchup.ts',
    );
  });

  it('never mistakes a path segment for a locator', () => {
    // No extension before the colon — nothing to strip.
    expect(normalizeAnchorRef('module:src/app/api/chat')).toBe('module:src/app/api/chat');
  });

  it('passes through a ref with no kind prefix', () => {
    expect(normalizeAnchorRef('bare-string')).toBe('bare-string');
  });
});

describe('resolveAnchors', () => {
  it('resolves a module anchor against the graph', () => {
    expect(resolveAnchors(['module:src/auth'], graph, '/repo', () => false)).toEqual([
      { ref: 'module:src/auth', resolved: true },
    ]);
  });

  it('reports a module anchor the graph does not have — even when a like-named file exists', () => {
    // A module anchor is a claim about the MAP. The disk must not rescue it,
    // or a stale derive would look current.
    expect(resolveAnchors(['module:src/ghost'], graph, '/repo', () => true)).toEqual([
      { ref: 'module:src/ghost', resolved: false },
    ]);
  });

  it('resolves a file anchor against the DISK, not the graph', () => {
    const seen: string[] = [];
    const result = resolveAnchors(['file:src/types/plan.ts'], graph, '/repo', (path) => {
      seen.push(path);
      return true;
    });
    expect(result).toEqual([{ ref: 'file:src/types/plan.ts', resolved: true }]);
    expect(seen).toEqual([join('/repo', 'src/types/plan.ts')]);
  });

  it('resolves a MALFORMED file anchor by its normalized path, and reports it as authored', () => {
    const result = resolveAnchors(['file:`src/stores/chatStore.ts:update`'], graph, '/repo', (path) =>
      path === join('/repo', 'src/stores/chatStore.ts'),
    );
    // Resolved on the cleaned path, but displayed exactly as the human wrote it.
    expect(result).toEqual([{ ref: 'file:`src/stores/chatStore.ts:update`', resolved: true }]);
  });

  it('reports a file anchor whose file is genuinely absent', () => {
    expect(resolveAnchors(['file:src/gone.ts'], graph, '/repo', () => false)).toEqual([
      { ref: 'file:src/gone.ts', resolved: false },
    ]);
  });

  it('stays conservative with no repoRoot — file anchors fall back to the graph', () => {
    expect(resolveAnchors(['file:src/types/plan.ts'], graph, null, () => true)).toEqual([
      { ref: 'file:src/types/plan.ts', resolved: false },
    ]);
  });

  it('sorts the ledger and never drops an unresolvable anchor', () => {
    const result = resolveAnchors(['module:src/z', 'module:src/auth'], graph, '/repo', () => false);
    expect(result.map((entry) => entry.ref)).toEqual(['module:src/auth', 'module:src/z']);
    expect(result).toHaveLength(2);
  });
});

describe("a feature's own learning moves its rating (#1346)", () => {
  // The brief's one control for moving the Understanding dot is
  // `Learn this feature`. It could never move it: this rated a feature purely
  // by rolling up the MODULES its anchors name, so a complete successful pass
  // — which writes `## Learned` and stamps `lastFullRead` on the FEATURE —
  // left the dot and the `Learning · n/N` meter exactly where they were,
  // which reads as a failed run.
  const unlearnedModules = new Map<string, FeatureUnderstanding>([['src/auth', 'none']]);

  it('rates a fully-read feature as learned even when its modules are not', () => {
    const learnt = feature('f', { anchors: ['module:src/auth'] });
    expect(understandingOf({ ...learnt, lastFullRead: '2026-08-07T10:00:00Z' }, unlearnedModules)).toBe(
      'learned',
    );
  });

  it('still falls back to the module rollup without that stamp', () => {
    // Features nobody has learned individually keep the signal they had.
    expect(understandingOf(feature('f', { anchors: ['module:src/auth'] }), unlearnedModules)).toBe(
      'none',
    );
  });

  it('treats an empty stamp as no stamp', () => {
    const blank = { ...feature('f', { anchors: ['module:src/auth'] }), lastFullRead: '' };
    expect(understandingOf(blank, unlearnedModules)).toBe('none');
  });
});

// ── The generated index (INDEX.md) ──────────────────────────────────────────

describe('buildFeatureIndexMarkdown', () => {
  function withBody(slug: string, body: string, patch: Partial<FeatureNode> = {}): FeatureNode {
    return { ...feature(slug, patch), body };
  }

  const playbooks = withBody(
    'playbooks',
    '# Playbooks\n\nRuns a saved sequence of steps against a project.\n',
    {
      name: 'Playbooks',
      kind: 'core',
      domain: 'Renderer',
      anchors: ['module:src/playbooks', 'file:src/playbooks/runner.ts'],
      relates: [
        {
          target: 'feature:skills',
          via: 'src/main/skills/binder.ts',
          note: 'a playbook step names a skill slug, which the binder resolves',
        },
      ],
    },
  );
  const skills = withBody('skills', '# Skills\n\nPackaged instructions the agent can invoke.\n', {
    name: 'Skills',
    kind: 'core',
  });

  it('is DERIVED, and says so in its first line', () => {
    const md = buildFeatureIndexMarkdown([skills, playbooks]);

    // The banner is the file's opening bytes — not buried where a grep result
    // drops a reader past it.
    expect(md.startsWith(FEATURE_INDEX_BANNER)).toBe(true);
    expect(md.split('\n')[0]).toContain('DO NOT EDIT');
    // It names the regenerating command AND where to edit instead, because a
    // reader told not to edit something needs somewhere to go.
    expect(md).toContain('planflow-ai blueprint features index');
    expect(md).toContain('flow/brain/features/<slug>.md');
  });

  it('lives OUTSIDE the human-owned layer, in a wholly-disposable directory', () => {
    // Not `flow/brain/` (precious, Obsidian-visible) and not `.structure/`
    // (which mixes disposable graph.json with irreplaceable notes).
    expect(FEATURE_INDEX_RELPATH).toBe('brain/.derived/INDEX.md');
    expect(FEATURE_INDEX_RELPATH.startsWith('brain/.structure/')).toBe(false);
    // Dot-prefixed: hidden from the Obsidian vault, like `.raw/`.
    expect(FEATURE_INDEX_RELPATH).toContain('/.derived/');
  });

  it('carries every feature with its summary, parts and edges', () => {
    const parts = new Map<string, FeaturePart[]>([
      [
        'playbooks',
        [
          { name: 'Step runner', summary: 'executes one step', anchors: ['src/playbooks/runner.ts'], learnings: [] },
          { name: 'Catalog', summary: 'lists saved playbooks', anchors: [], learnings: [] },
        ],
      ],
    ]);

    const md = buildFeatureIndexMarkdown([playbooks, skills], parts);

    expect(md).toContain('## Playbooks — feature:playbooks');
    expect(md).toContain('## Skills — feature:skills');
    expect(md).toContain('summary: Runs a saved sequence of steps against a project.');
    expect(md).toContain('kind: core · domain: Renderer · file: flow/brain/features/playbooks.md');
    expect(md).toContain('anchors: file:src/playbooks/runner.ts, module:src/playbooks');
    expect(md).toContain('- Step runner — executes one step [anchors: src/playbooks/runner.ts]');
    expect(md).toContain('- Catalog — lists saved playbooks');
    // THE POINT: the edge answers the relational question in one line, naming
    // the mechanism and the reason, so a reader never has to open Skills.
    expect(md).toContain(
      '- Skills (feature:skills) via src/main/skills/binder.ts — ' +
        'a playbook step names a skill slug, which the binder resolves',
    );
    expect(md).toContain('2 feature(s) · 1 relationship(s)');
  });

  it('keeps parts in DOCUMENT order and features in id order', () => {
    const parts = new Map<string, FeaturePart[]>([
      [
        'playbooks',
        [
          { name: 'Zulu', summary: '', anchors: [], learnings: [] },
          { name: 'Alpha', summary: '', anchors: [], learnings: [] },
        ],
      ],
    ]);

    const md = buildFeatureIndexMarkdown([skills, playbooks], parts);

    // Features: sorted by id (nobody authored their order).
    expect(md.indexOf('## Playbooks')).toBeLessThan(md.indexOf('## Skills'));
    // Parts: the human's order, preserved (somebody DID author it).
    expect(md.indexOf('- Zulu')).toBeLessThan(md.indexOf('- Alpha'));
  });

  it('is byte-identical for the same inputs, whatever order they arrive in', () => {
    const parts = new Map<string, FeaturePart[]>([
      ['playbooks', [{ name: 'Step runner', summary: 's', anchors: ['b.ts', 'a.ts'], learnings: [] }]],
    ]);

    const first = buildFeatureIndexMarkdown([playbooks, skills], parts);
    const second = buildFeatureIndexMarkdown([skills, playbooks], parts);

    // A rebuild that reorders anything turns `git status` into noise, and noise
    // is how a real change gets waved through.
    expect(second).toBe(first);
    expect(buildFeatureIndexMarkdown([playbooks, skills], parts)).toBe(first);
    // No clock anywhere: a timestamp would make every rebuild a diff.
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    // Exactly one trailing newline.
    expect(first.endsWith('\n')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(false);
  });

  it('sorts multiple edges deterministically and renders a bare edge honestly', () => {
    const bare = withBody('bare', '# Bare\n', {
      name: 'Bare',
      relates: [
        { target: 'feature:skills' },
        { target: 'feature:zzz-unknown', note: 'points at a feature this store does not have' },
      ],
    });

    const md = buildFeatureIndexMarkdown([bare, skills]);

    // A target the store knows gets its NAME; one it does not keeps the raw id
    // rather than being dropped or invented.
    expect(md).toContain('- Skills (feature:skills)');
    expect(md).toContain('- feature:zzz-unknown — points at a feature this store does not have');
    expect(md.indexOf('- Skills (feature:skills)')).toBeLessThan(md.indexOf('- feature:zzz-unknown'));
  });

  it('renders an empty store without inventing anything', () => {
    const md = buildFeatureIndexMarkdown([]);
    expect(md).toContain('0 feature(s) · 0 relationship(s)');
    expect(md.startsWith(FEATURE_INDEX_BANNER)).toBe(true);
  });

  it('omits sections a feature genuinely has nothing to say for', () => {
    const md = buildFeatureIndexMarkdown([withBody('quiet', '', { name: 'Quiet' })]);
    expect(md).toContain('## Quiet — feature:quiet');
    expect(md).not.toContain('summary:');
    expect(md).not.toContain('anchors:');
    expect(md).not.toContain('relates:');
    expect(md).not.toContain('parts:');
  });
});

describe('size — how much code a node stands on (2026-08-28)', () => {
  it('carries the measurer\'s answer on features and parts, and nothing when there is no measurer', () => {
    const measure = (anchors: readonly string[]) => ({ files: anchors.length, lines: anchors.length * 10 });
    const features = [feature('chats', { anchors: ['module:src/chat', 'file:src/chat/index.ts'] })];
    const parts = new Map([['chats', [part('SSE', { anchors: ['src/lib/sse.ts'] })]]]);
    const measured = buildFeatureGraph(features, learning, new Set(), new Set(), parts, new Set(), measure);
    expect(measured.nodes.find((n) => n.id === 'feature:chats')?.size).toEqual({ files: 2, lines: 20 });
    expect(measured.nodes.find((n) => n.kind === 'part')?.size).toEqual({ files: 1, lines: 10 });
    const unmeasured = buildFeatureGraph(features, learning, new Set(), new Set(), parts);
    expect(unmeasured.nodes.every((n) => n.size === undefined)).toBe(true);
  });
});

describe('folders — where a node lives (plan feature-home-folders, phase 2)', () => {
  /** A world of literal files (path → content); every path prefix is a folder. */
  function world(files: Record<string, string>): SizeHost {
    const dirs = new Set<string>();
    for (const path of Object.keys(files)) {
      const segments = path.split('/');
      for (let i = 1; i < segments.length; i += 1) dirs.add(segments.slice(0, i).join('/'));
    }
    return {
      classify: (path) => (path in files ? 'file' : dirs.has(path) ? 'dir' : null),
      list: (dir) => {
        const names = new Set<string>();
        for (const path of [...Object.keys(files), ...dirs]) {
          if (path.startsWith(`${dir}/`)) names.add(path.slice(dir.length + 1).split('/')[0]);
        }
        return [...names].map((name) => ({ name, kind: `${dir}/${name}` in files ? 'file' : 'dir' }) as const);
      },
      read: (path) => files[path] ?? null,
    };
  }
  const text = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
  const files: Record<string, string> = {
    'src/app/automations/page.tsx': text(10),
    'src/components/automations/Builder.tsx': text(60),
    'src/components/automations/List.tsx': text(30),
    'src/components/chat/Chat.tsx': text(50),
    'src/components/chat/stream/Sse.tsx': text(20),
  };
  const host = world(files);
  const imports = { sourceFiles: Object.keys(files).sort(), importersOf: (): string[] => [] };
  const features = [
    feature('automations', { anchors: ['module:src/app/automations'] }),
    feature('chats', { anchors: ['module:src/components/chat'], extra: { home: 'src/components/chat/stream' } }),
    feature('chat-tweak', { kind: 'child', anchors: ['module:src/components/chat'] }),
  ];
  const parts = new Map([['chats', [part('Live stream', { anchors: ['src/components/chat/stream'], home: 'src/gone' })]]]);

  function folderBuilder(): { rowsFor: FolderRowsFor; calls: string[] } {
    const builder = createFolderRowsBuilder(host, {
      coreFeatures: features
        .filter((f) => f.kind === 'core')
        .map((f) => ({ id: f.id, slug: f.slug, anchors: f.anchors, home: featureHome(f) })),
      imports,
    });
    const calls: string[] = [];
    return {
      calls,
      rowsFor: (input) => {
        calls.push(input.slug);
        return builder.rowsFor(input);
      },
    };
  }

  it('puts a feature\'s name-matched home first — anchors stop at the route folder, the rows do not', () => {
    const graph = buildFeatureGraph(features, learning, new Set(), new Set(), parts, new Set(), undefined, folderBuilder().rowsFor);
    const automations = graph.nodes.find((n) => n.id === 'feature:automations');
    expect(automations?.folders?.rows[0]).toMatchObject({ path: 'src/components/automations', lines: 90, files: 2 });
    expect(automations?.folders?.spread).toBe(false);
  });

  it('honours a person-pinned home on a feature, and ignores a part\'s pin that no longer exists', () => {
    const graph = buildFeatureGraph(features, learning, new Set(), new Set(), parts, new Set(), undefined, folderBuilder().rowsFor);
    const chats = graph.nodes.find((n) => n.id === 'feature:chats');
    expect(chats?.folders?.pinned).toBe(true);
    expect(chats?.folders?.rows[0]).toMatchObject({ path: 'src/components/chat/stream', pinned: true });
    const stream = graph.nodes.find((n) => n.kind === 'part');
    expect(stream?.folders?.pinned).toBe(false);
    expect(stream?.folders?.pinMissing).toBe('src/gone');
    expect(stream?.folders?.rows[0]?.path).toBe('src/components/chat/stream');
  });

  it('asks ONE builder for every feature and part, by the part\'s own name — and never for a change', () => {
    const { rowsFor, calls } = folderBuilder();
    const graph = buildFeatureGraph(features, learning, new Set(), new Set(), parts, new Set(), undefined, rowsFor);
    expect(calls.sort()).toEqual(['automations', 'chats', 'live-stream']);
    expect(graph.nodes.find((n) => n.kind === 'child')?.folders).toBeUndefined();
  });

  it('leaves folders absent without a builder, and when no files were found', () => {
    const bare = buildFeatureGraph(features, learning, new Set(), new Set(), parts);
    expect(bare.nodes.every((n) => n.folders === undefined)).toBe(true);
    const nowhere = [feature('nowhere-feature', { anchors: ['module:src/missing'] })];
    const built = createFolderRowsBuilder(host, { coreFeatures: [], imports });
    const graph = buildFeatureGraph(nowhere, learning, new Set(), new Set(), new Map(), new Set(), undefined, (input) =>
      built.rowsFor(input),
    );
    expect(graph.nodes[0]).not.toHaveProperty('folders');
  });

  it('mints part ids through the store\'s one address rule', () => {
    const named = [part('Live stream'), part('Live stream'), part('Other')];
    const graph = buildFeatureGraph([feature('chats')], learning, new Set(), new Set(), new Map([['chats', named]]));
    expect(graph.nodes.filter((n) => n.kind === 'part').map((n) => n.id)).toEqual(
      addressPartNames('feature:chats', ['Live stream', 'Live stream', 'Other']),
    );
  });
});

describe('role — resolved once, in the graph (plan feature-type-icons, phase 2)', () => {
  const features = [
    feature('chats', { anchors: ['module:src/renderer/chat'], extra: { role: 'api', learnedRole: 'data' } }),
    feature('billing', { anchors: ['module:src/renderer/billing'], extra: { learnedRole: 'integration' } }),
    feature('jobs', { anchors: ['module:src/workers', 'module:src/cron'] }),
    feature('odd', { anchors: ['endpoint:GET /x'], extra: { role: 'widget', learnedRole: 'nope' } }),
    feature('plan-x', { kind: 'child', parent: 'feature:chats', anchors: ['module:src/renderer/chat'] }),
  ];
  const parts = new Map<string, FeaturePart[]>([
    [
      'chats',
      [
        part('Person', { anchors: ['src/db/a.ts'], role: 'ui', learnedRole: 'data' }),
        part('Learned', { anchors: ['src/db/a.ts'], learnedRole: 'service' }),
        part('Guessed', { anchors: ['src/db/a.ts', 'src/db/b.ts'] }),
        part('Off list', { anchors: [], role: 'widget' }),
      ],
    ],
  ]);
  const built = buildFeatureGraph(features, learning, new Set(), new Set(), parts);
  const byId = new Map(built.nodes.map((n) => [n.id, n]));
  const roleOf = (id: string): [unknown, unknown] => [byId.get(id)?.role, byId.get(id)?.roleSource];

  it('a feature takes the person\'s role, else the learned one, else the guess', () => {
    expect(roleOf('feature:chats')).toEqual(['api', 'person']);
    expect(roleOf('feature:billing')).toEqual(['integration', 'learn']);
    expect(roleOf('feature:jobs')).toEqual(['jobs', 'guess']);
    // Off-list values read as absent — the guess answers.
    expect(roleOf('feature:odd')).toEqual(['api', 'guess']);
  });

  it('a part follows the same precedence over its own keys and anchors', () => {
    expect(roleOf('feature:chats/person')).toEqual(['ui', 'person']);
    expect(roleOf('feature:chats/learned')).toEqual(['service', 'learn']);
    expect(roleOf('feature:chats/guessed')).toEqual(['data', 'guess']);
    expect(roleOf('feature:chats/off-list')).toEqual(['neutral', 'guess']);
  });

  it('a change gets no role — it gets no rectangle to draw one on', () => {
    const change = built.nodes.find((n) => n.kind === 'child');
    expect(change?.id).toBe('feature:plan-x'); // the change IS in the graph
    expect(change).not.toHaveProperty('role');
    expect(change).not.toHaveProperty('roleSource');
  });
});
