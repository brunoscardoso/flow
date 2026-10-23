/**
 * Tests for the feature-view contract.
 *
 * Validation IS the feature here, so most of this file is refusals. Each one is
 * a distinct way the surface could lie to a reader who has no way to check:
 * a line drawn from nowhere, a door that opens onto nothing, and — worst — a
 * code excerpt that was never in the file, which looks exactly like evidence.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  featureViewPath,
  healFeatureView,
  inspectFeatureView,
  inspectFeatureViews,
  readFeatureView,
  validateFeatureView,
  writeFeatureView,
  type FeatureView,
  checkExcerptFreshness,
  VIEW_PORT_CROSSES_MAX,
  PORTS_EXAMPLE_LINE,
  viewPortsPromptLines,
} from './feature-view.js';

function view(patch: Partial<FeatureView> = {}): FeatureView {
  return {
    feature: 'chats',
    provenance: 'plan:chat_session_cache_rework_v1',
    generatedAt: '2026-08-04',
    meta: { title: 'Chat persistence' },
    brief: {},
    views: {
      root: {
        title: 'Chat persistence',
        nodes: [
          { id: 'browser', kind: 'project', title: 'Browser · Chat UI', delta: 'stable' },
          { id: 'bff', kind: 'endpoint', title: 'Gateway BFF', delta: 'modify' },
        ],
        edges: [{ from: 'browser', to: 'bff', label: 'send message', delta: 'kept' }],
      },
    },
    ...patch,
  };
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'feature-view-'));
}

describe('validateFeatureView — shape', () => {
  it('accepts a well-formed view', () => {
    expect(validateFeatureView(view())).toEqual({ ok: true, errors: [] });
  });

  it('requires a root level — that is what opens', () => {
    const bad = view({ views: { detail: { title: 'x', nodes: [], edges: [] } } });
    const result = validateFeatureView(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('needs a "root" level');
  });

  it('refuses a component whose kind is not in the frozen set', () => {
    const bad = view()
    bad.views.root.nodes[0] = { id: 'x', kind: 'widget' as never, title: 'X', delta: 'stable' }
    expect(validateFeatureView(bad).errors.join('\n')).toContain("kind 'widget'");
  });

  it('refuses a component with no human title — the whole point is not showing paths', () => {
    const bad = view()
    bad.views.root.nodes[0] = { id: 'x', kind: 'module', title: '', delta: 'stable' }
    expect(validateFeatureView(bad).errors.join('\n')).toContain('needs a human title');
  });

  it('refuses duplicate component ids', () => {
    const bad = view()
    bad.views.root.nodes.push({ id: 'browser', kind: 'module', title: 'Dup', delta: 'stable' })
    expect(validateFeatureView(bad).errors.join('\n')).toContain("repeats component id 'browser'");
  });
});

describe('validateFeatureView — component roles (feature-type-icons FR-5)', () => {
  it('accepts a component with a role on the list, and one with none', () => {
    const ok = view()
    ok.views.root.nodes[0] = { id: 'browser', kind: 'project', title: 'Chat UI', delta: 'stable', role: 'ui' }
    ok.views.root.nodes[1] = { id: 'bff', kind: 'endpoint', title: 'Gateway BFF', delta: 'modify' }
    expect(validateFeatureView(ok)).toEqual({ ok: true, errors: [] });
  });

  it('refuses a role that is not on the list, naming the component', () => {
    const bad = view()
    bad.views.root.nodes[0] = { id: 'browser', kind: 'project', title: 'Chat UI', delta: 'stable', role: 'frontend' as never }
    const result = validateFeatureView(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain("component 'browser' has role 'frontend'");
  });

  it('refuses a role in the wrong case — the list is lower-case and exact', () => {
    const bad = view()
    bad.views.root.nodes[0] = { id: 'browser', kind: 'project', title: 'Chat UI', delta: 'stable', role: 'UI' as never }
    expect(validateFeatureView(bad).ok).toBe(false);
  });
});

describe('validateFeatureView — connections', () => {
  it('refuses an edge from a component that is not here — a line from nowhere', () => {
    const bad = view()
    bad.views.root.edges = [{ from: 'ghost', to: 'bff', label: 'x', delta: 'kept' }]
    expect(validateFeatureView(bad).errors.join('\n')).toContain("connection from 'ghost'");
  });

  it('refuses an edge to a component that is not here', () => {
    const bad = view()
    bad.views.root.edges = [{ from: 'browser', to: 'ghost', label: 'x', delta: 'kept' }]
    expect(validateFeatureView(bad).errors.join('\n')).toContain("connection to 'ghost'");
  });

  it('refuses an unlabelled connection — it explains nothing', () => {
    const bad = view()
    bad.views.root.edges = [{ from: 'browser', to: 'bff', label: '', delta: 'kept' }]
    expect(validateFeatureView(bad).errors.join('\n')).toContain('has no label');
  });

  it('refuses an unknown edge delta', () => {
    const bad = view()
    bad.views.root.edges = [{ from: 'browser', to: 'bff', label: 'x', delta: 'maybe' as never }]
    expect(validateFeatureView(bad).errors.join('\n')).toContain("delta 'maybe'");
  });
});

describe('validateFeatureView — drill targets', () => {
  it('accepts a drill into a real view', () => {
    const ok = view()
    ok.views.root.nodes[1].view = 'bffdetail'
    ok.views.bffdetail = { title: 'Inside the BFF', nodes: [], edges: [] }
    expect(validateFeatureView(ok).ok).toBe(true);
  });

  it('refuses a drill into a view that does not exist — a dead door', () => {
    const bad = view()
    bad.views.root.nodes[1].view = 'nowhere'
    expect(validateFeatureView(bad).errors.join('\n')).toContain('a dead door');
  });
});

describe('validateFeatureView — code excerpts', () => {
  it('refuses an excerpt with no note saying why it matters', () => {
    const bad = view()
    bad.views.root.nodes[1].code = { file: 'a.ts', from: 1, to: 2, note: '', text: 'x' }
    expect(validateFeatureView(bad).errors.join('\n')).toContain('needs a note');
  });

  it('refuses an impossible line range', () => {
    const bad = view()
    bad.views.root.nodes[1].code = { file: 'a.ts', from: 9, to: 2, note: 'why', text: 'x' }
    expect(validateFeatureView(bad).errors.join('\n')).toContain('impossible range');
  });

  it('refuses an excerpt from a file that does not exist', () => {
    const repo = tempRepo()
    const bad = view()
    bad.views.root.nodes[1].code = { file: 'missing.ts', from: 1, to: 2, note: 'why', text: 'x' }
    expect(validateFeatureView(bad, repo).errors.join('\n')).toContain('does not exist');
  });

  it('refuses an excerpt claiming lines the file does not have — FABRICATED EVIDENCE', () => {
    // The worst failure this surface can have: invented code that looks like
    // proof. A range past the end of the file is the clearest signal of it.
    const repo = tempRepo()
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\nthree\n', 'utf-8')
    const bad = view()
    bad.views.root.nodes[1].code = { file: 'a.ts', from: 1, to: 99, note: 'why', text: 'invented' }
    expect(validateFeatureView(bad, repo).errors.join('\n')).toContain('but it has');
  });

  it('accepts an excerpt that really is inside its file', () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\nthree\n', 'utf-8')
    const ok = view()
    ok.views.root.nodes[1].code = { file: 'a.ts', from: 1, to: 2, note: 'why', text: 'one\ntwo' }
    expect(validateFeatureView(ok, repo).ok).toBe(true);
  });
});

describe('validateFeatureView — ports (entries and exits)', () => {
  /** A repo with one source file and a feature store holding `chats` and `settings`. */
  function portRepo(): string {
    const repo = tempRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'bff.ts'), 'export function streamTurn() {}\n', 'utf-8');
    const features = join(repo, 'flow', 'brain', 'features');
    mkdirSync(features, { recursive: true });
    for (const [slug, name] of [['chats', 'Chats'], ['settings', 'Settings']]) {
      writeFileSync(
        join(features, `${slug}.md`),
        `---\nid: feature:${slug}\nname: ${name}\nkind: core\nanchors: []\nrelates: []\nlastFullRead: null\npatchCount: 0\n---\n\n# ${name}\n`,
        'utf-8',
      );
    }
    return repo;
  }

  function withPorts(ports: unknown, level = 'root'): FeatureView {
    const v = view();
    if (level !== 'root') {
      v.views.root.nodes[1].view = level;
      v.views[level] = { title: 'Inside', nodes: [{ id: 'inner', kind: 'function', title: 'Inner', delta: 'stable' }], edges: [] };
    }
    (v.views[level] as unknown as Record<string, unknown>).ports = ports;
    return v;
  }

  const good = {
    in: [{ crosses: 'chat request', node: 'browser', far: { feature: 'settings' } }],
    out: [
      { crosses: 'SSE tokens', node: 'bff', far: { file: 'src/bff.ts', symbol: 'streamTurn' } },
      { crosses: 'engine call', node: 'bff', far: { project: 'backend', feature: 'chat-engine' } },
    ],
  };

  it('keeps an old view with no ports valid', () => {
    expect(validateFeatureView(view(), portRepo())).toEqual({ ok: true, errors: [] });
  });

  it('accepts entries and exits that touch real components and cite real code', () => {
    expect(validateFeatureView(withPorts(good), portRepo())).toEqual({ ok: true, errors: [] });
  });

  it('accepts ports on a drill level, touching that level\'s components', () => {
    const ports = { in: [{ crosses: 'tick', node: 'inner', far: { feature: 'chats' } }] };
    expect(validateFeatureView(withPorts(ports, 'bffdetail'), portRepo()).ok).toBe(true);
    // …and refuses one naming a component of ANOTHER level.
    const wrong = { in: [{ crosses: 'tick', node: 'bff', far: { feature: 'chats' } }] };
    expect(validateFeatureView(withPorts(wrong, 'bffdetail'), portRepo()).errors.join('\n')).toContain("touches 'bff', which is not a component here");
  });

  it.each([
    ['a node that is not a component here', { in: [{ crosses: 'x', node: 'ghost', far: { feature: 'chats' } }] }, "touches 'ghost'"],
    ['no crossing', { in: [{ crosses: ' ', node: 'bff', far: { feature: 'chats' } }] }, 'says nothing about what crosses'],
    ['a crossing past the cap', { in: [{ crosses: 'x'.repeat(VIEW_PORT_CROSSES_MAX + 1), node: 'bff', far: { feature: 'chats' } }] }, `at most ${String(VIEW_PORT_CROSSES_MAX)}`],
    ['no far end', { in: [{ crosses: 'x', node: 'bff' }] }, 'names no far end'],
    ['an empty far end', { in: [{ crosses: 'x', node: 'bff', far: {} }] }, 'names no far end'],
    ['a file that does not exist', { out: [{ crosses: 'x', node: 'bff', far: { file: 'src/nope.ts' } }] }, "cites 'src/nope.ts', which does not exist"],
    ['a symbol the file never mentions', { out: [{ crosses: 'x', node: 'bff', far: { file: 'src/bff.ts', symbol: 'inventedFn' } }] }, "cites 'inventedFn' in 'src/bff.ts', which never mentions it"],
    ['a symbol with no file', { out: [{ crosses: 'x', node: 'bff', far: { symbol: 'streamTurn' } }] }, 'without the file it is in'],
    ['a file in another project', { out: [{ crosses: 'x', node: 'bff', far: { project: 'backend', file: 'src/bff.ts' } }] }, "in project 'backend'"],
    ['an unknown feature', { out: [{ crosses: 'x', node: 'bff', far: { feature: 'nope' } }] }, "names feature 'nope', which is not a feature in this project"],
    ['an unknown side', { sideways: [] }, "port side 'sideways'"],
    ['a side that is not a list', { in: {} }, 'ports.in is not a list'],
    ['ports that are not an object', [], 'ports that are not an object'],
  ])('refuses THE WHOLE VIEW over a port with %s', (_label, ports, message) => {
    const result = validateFeatureView(withPorts(ports), portRepo());
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(message);
  });

  it('checks a feature name against the list it is handed, over the store', () => {
    const ports = { in: [{ crosses: 'x', node: 'bff', far: { feature: 'elsewhere' } }] };
    expect(validateFeatureView(withPorts(ports), portRepo(), { knownFeatures: ['elsewhere'] }).ok).toBe(true);
  });

  it('checks only the shape without a repo, like excerpts', () => {
    const ports = { out: [{ crosses: 'x', node: 'bff', far: { feature: 'anything', file: 'src/nope.ts', symbol: 's' } }] };
    expect(validateFeatureView(withPorts(ports)).ok).toBe(true);
    expect(validateFeatureView(withPorts({ out: [{ crosses: 'x', node: 'ghost', far: { feature: 'a' } }] })).ok).toBe(false);
  });

  it('writes nothing when a port is refused', () => {
    const repo = portRepo();
    const flowDir = join(repo, 'flow');
    const bad = withPorts({ in: [{ crosses: 'x', node: 'ghost', far: { feature: 'chats' } }] });
    expect(writeFeatureView(flowDir, bad, repo).ok).toBe(false);
    expect(existsSync(featureViewPath(flowDir, 'chats'))).toBe(false);
    expect(writeFeatureView(flowDir, withPorts(good), repo).ok).toBe(true);
    expect(readFeatureView(flowDir, 'chats')?.views.root.ports?.out?.[0]?.far.symbol).toBe('streamTurn');
  });

  it('asks the pass for entries and exits, each on one component, never invented', () => {
    const prompt = viewPortsPromptLines().join('\n');
    expect(prompt).toContain('ENTRIES AND EXITS');
    expect(prompt).toContain('ports.in');
    expect(prompt).toContain('ports.out');
    expect(prompt).toContain('ONE component');
    expect(prompt).toContain(`at most ${String(VIEW_PORT_CROSSES_MAX)} characters`);
    expect(prompt).toContain('NEVER invent a file or a function');
    expect(PORTS_EXAMPLE_LINE).toContain('"ports"');
  });
});

describe('writeFeatureView / readFeatureView', () => {
  function flowIn(repo: string): string {
    const flowDir = join(repo, 'flow')
    mkdirSync(flowDir, { recursive: true })
    return flowDir
  }

  it('writes a valid view and reads it back', () => {
    const repo = tempRepo()
    const flowDir = flowIn(repo)
    expect(writeFeatureView(flowDir, view()).ok).toBe(true)
    const back = readFeatureView(flowDir, 'chats')
    expect(back?.meta.title).toBe('Chat persistence')
    expect(back?.views.root.edges[0].label).toBe('send message')
  });

  it('REFUSES an invalid view and writes nothing', () => {
    const repo = tempRepo()
    const flowDir = flowIn(repo)
    const bad = view()
    bad.views.root.edges = [{ from: 'ghost', to: 'bff', label: 'x', delta: 'kept' }]
    const result = writeFeatureView(flowDir, bad)
    expect(result.ok).toBe(false)
    expect(readFeatureView(flowDir, 'chats')).toBeNull()
  });

  it('REFUSES a view that names no feature — an artifact reachable from nothing (#1587)', () => {
    const repo = tempRepo()
    const flowDir = flowIn(repo)
    // The shape this repo's own store actually held: a pre-contract artifact,
    // complete in every other respect, one top-level field short of valid. It
    // was written before this gate existed, so nothing ever refused it — it
    // then read as `0/1 valid · 1 orphaned` forever, because an orphan is
    // reachable from no feature and no walk reopens it. The gate closes here,
    // at the only writer: a nameless view never lands, so a later orphan count
    // can only ever mean a file somebody put there by hand.
    const nameless = view() as Partial<FeatureView>
    delete nameless.feature
    const result = writeFeatureView(flowDir, nameless as FeatureView)
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain('view needs a non-empty "feature"')
    // Refused means nothing on disk — not even the directory the write would
    // have made, which is what keeps a refused write from minting an orphan.
    expect(existsSync(featureViewPath(flowDir, 'chats'))).toBe(false)
    expect(inspectFeatureViews(flowDir)).toEqual([])
  });

  it('rotates the previous view — derived, so losing it costs nothing', () => {
    const repo = tempRepo()
    const flowDir = flowIn(repo)
    writeFeatureView(flowDir, view())
    const second = view()
    second.meta.title = 'Second'
    writeFeatureView(flowDir, second)
    expect(readFeatureView(flowDir, 'chats')?.meta.title).toBe('Second')
    const prev = featureViewPath(flowDir, 'chats').replace(/\.json$/, '.prev.json')
    expect(JSON.parse(readFileSync(prev, 'utf-8')).meta.title).toBe('Chat persistence')
  });

  it('reads null for a feature with no view — the board keeps its old behaviour', () => {
    expect(readFeatureView(flowIn(tempRepo()), 'nope')).toBeNull()
  });

  it('reads null for a corrupt view rather than throwing', () => {
    const repo = tempRepo()
    const flowDir = flowIn(repo)
    mkdirSync(join(flowDir, 'brain', '.structure', 'feature-views'), { recursive: true })
    writeFileSync(featureViewPath(flowDir, 'chats'), '{ not json', 'utf-8')
    expect(readFeatureView(flowDir, 'chats')).toBeNull()
  });

  it('reads null for a structurally invalid view — never half-drawn', () => {
    const repo = tempRepo()
    const flowDir = flowIn(repo)
    mkdirSync(join(flowDir, 'brain', '.structure', 'feature-views'), { recursive: true })
    writeFileSync(featureViewPath(flowDir, 'chats'), JSON.stringify({ feature: 'chats', views: {} }), 'utf-8')
    expect(readFeatureView(flowDir, 'chats')).toBeNull()
  });
});

/**
 * Phase 8 — the verdict, reportable.
 *
 * `readFeatureView` answers null for missing, corrupt and REFUSED alike. That
 * is right for a caller that has to draw something and useless for one asking
 * why, and until Phase 8 there was no second reader. These tests pin the two
 * halves of the deal: the validator does not get weaker, and its words survive.
 */
describe('inspectFeatureView (Task 8.1) — the refusal, with its own words', () => {
  function flowIn(repo: string): string {
    const flowDir = join(repo, 'flow')
    mkdirSync(join(flowDir, 'brain', '.structure', 'feature-views'), { recursive: true })
    return flowDir
  }

  function store(flowDir: string, slug: string, body: unknown): void {
    writeFileSync(featureViewPath(flowDir, slug), JSON.stringify(body), 'utf-8')
  }

  it('returns null for a feature with no artifact — an absence is not a fault', () => {
    expect(inspectFeatureView(flowIn(tempRepo()), 'nope')).toBeNull()
  });

  it('reports a valid artifact as valid, with the view and no errors', () => {
    const flowDir = flowIn(tempRepo())
    writeFeatureView(flowDir, view())
    const found = inspectFeatureView(flowDir, 'chats')
    expect(found?.state).toBe('valid')
    expect(found?.errors).toEqual([])
    expect(found?.view?.meta.title).toBe('Chat persistence')
    expect(found?.orphaned).toBe(false)
  });

  it("carries the validator's messages VERBATIM, not a summary of them", () => {
    const flowDir = flowIn(tempRepo())
    const bad = view()
    bad.views.root.edges = [{ from: 'ghost', to: 'bff', label: 'x', delta: 'kept' }]
    store(flowDir, 'chats', bad)
    const found = inspectFeatureView(flowDir, 'chats')
    expect(found?.state).toBe('invalid')
    // The exact strings the validator produced, so a surface can print them.
    expect(found?.errors).toEqual(validateFeatureView(bad).errors)
    expect(found?.errors.join('\n')).toContain("connection from 'ghost'")
  });

  it('still refuses to hand back a rotted view — reportable is not drawable', () => {
    const flowDir = flowIn(tempRepo())
    const bad = view()
    bad.views.root.edges = [{ from: 'ghost', to: 'bff', label: 'x', delta: 'kept' }]
    store(flowDir, 'chats', bad)
    expect(inspectFeatureView(flowDir, 'chats')?.view).toBeNull()
    // The existing contract is untouched: the old reader still sees nothing.
    expect(readFeatureView(flowDir, 'chats')).toBeNull()
  });

  it('reports unparseable JSON as unreadable rather than guessing at it', () => {
    const flowDir = flowIn(tempRepo())
    writeFileSync(featureViewPath(flowDir, 'chats'), '{ not json', 'utf-8')
    const found = inspectFeatureView(flowDir, 'chats')
    expect(found?.state).toBe('unreadable')
    expect(found?.errors.join(' ')).toContain('not readable JSON')
    // Which feature it belonged to is UNKNOWN, so it is not called an orphan.
    expect(found?.orphaned).toBe(false)
  });

  it('checks excerpts against the real repo when given a root — undiminished', () => {
    const repo = tempRepo()
    const flowDir = flowIn(repo)
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\n', 'utf-8')
    const rotted = view()
    rotted.views.root.nodes[0].code = { file: 'a.ts', from: 90, to: 99, note: 'why', text: 'x' }
    store(flowDir, 'chats', rotted)
    expect(inspectFeatureView(flowDir, 'chats')?.state).toBe('valid')
    const checked = inspectFeatureView(flowDir, 'chats', { repoRoot: repo })
    expect(checked?.state).toBe('invalid')
    expect(checked?.errors.join('\n')).toContain('lines 90..99, but it has 3')
  });
});

describe('inspectFeatureViews (Task 8.2) — the artifact that belongs to nobody', () => {
  function flowIn(repo: string): string {
    const flowDir = join(repo, 'flow')
    mkdirSync(join(flowDir, 'brain', '.structure', 'feature-views'), { recursive: true })
    return flowDir
  }

  function store(flowDir: string, slug: string, body: unknown): void {
    writeFileSync(featureViewPath(flowDir, slug), JSON.stringify(body), 'utf-8')
  }

  it('calls an artifact that names no feature an orphan', () => {
    const flowDir = flowIn(tempRepo())
    const nameless: Record<string, unknown> = { ...view() }
    delete nameless.feature
    store(flowDir, 'feature-view', nameless)
    const found = inspectFeatureView(flowDir, 'feature-view')
    expect(found?.orphaned).toBe(true)
    expect(found?.orphanReason).toBe('names no feature')
    // And the validator still says so in its own words, unweakened.
    expect(found?.errors.join('\n')).toContain('view needs a non-empty "feature"')
  });

  it('calls an artifact filed under one slug and naming another an orphan', () => {
    const flowDir = flowIn(tempRepo())
    store(flowDir, 'threads', view({ feature: 'chats' }))
    const found = inspectFeatureView(flowDir, 'threads')
    expect(found?.orphaned).toBe(true)
    expect(found?.orphanReason).toBe("is filed as 'threads' but names 'chats'")
  });

  it('calls an artifact naming a feature the store does not hold an orphan', () => {
    const flowDir = flowIn(tempRepo())
    store(flowDir, 'chats', view())
    expect(inspectFeatureView(flowDir, 'chats', { knownFeatures: ['chats'] })?.orphaned).toBe(false)
    const gone = inspectFeatureView(flowDir, 'chats', { knownFeatures: ['threads'] })
    expect(gone?.orphaned).toBe(true)
    expect(gone?.orphanReason).toBe("names 'chats', which is not a feature in the store")
  });

  it('asserts nothing about the store when no store was handed in', () => {
    const flowDir = flowIn(tempRepo())
    store(flowDir, 'chats', view())
    expect(inspectFeatureView(flowDir, 'chats')?.orphaned).toBe(false)
  });

  it('scans the DIRECTORY, so an orphan no feature points at is still seen', () => {
    const flowDir = flowIn(tempRepo())
    const nameless: Record<string, unknown> = { ...view() }
    delete nameless.feature
    store(flowDir, 'ghost', nameless)
    store(flowDir, 'chats', view())
    const all = inspectFeatureViews(flowDir, { knownFeatures: ['chats'] })
    expect(all.map((entry) => entry.slug)).toEqual(['chats', 'ghost'])
    expect(all.find((entry) => entry.slug === 'ghost')?.orphaned).toBe(true)
  });

  it('ignores rotations and in-flight writes — they are not artifacts', () => {
    const flowDir = flowIn(tempRepo())
    writeFeatureView(flowDir, view())
    writeFeatureView(flowDir, view({ meta: { title: 'Second' } }))
    writeFileSync(featureViewPath(flowDir, 'half').replace(/\.json$/, '.json.tmp'), '{}', 'utf-8')
    expect(inspectFeatureViews(flowDir).map((entry) => entry.slug)).toEqual(['chats'])
  });

  it('reads no artifacts, rather than throwing, when the directory is absent', () => {
    expect(inspectFeatureViews(join(tempRepo(), 'flow'))).toEqual([])
  });
});

// ── #1435: a citation nobody re-checks ──────────────────────────────────────
//
// The format's guarantee is that the model names a file and line range and the
// executor reads the text from disk, so a drawer can never show invented code.
// That held at write time and was never re-checked: validateCode only asked
// whether the range fit inside the file. Measured on real data, 6 of 29
// excerpts across 6 PASSING views had drifted within 4 days — and one quoted a
// line that exists nowhere in the file.
describe('checkExcerptFreshness (#1435)', () => {
  const FILE = ['import x', '', 'function a() {', '  return 1', '}', '', 'const z = 2']

  it('is fresh when the text still sits exactly where it says', () => {
    expect(checkExcerptFreshness(FILE, 3, 5, 'function a() {\n  return 1\n}')).toEqual({
      kind: 'fresh',
    })
  })

  it('reports where the text actually starts after a positive shift', () => {
    // Insertions above the block — 5 of the 6 real drifts were exactly this.
    const shifted = ['// added', '// added', ...FILE]
    expect(checkExcerptFreshness(shifted, 3, 5, 'function a() {\n  return 1\n}')).toEqual({
      kind: 'shifted',
      from: 5,
      to: 7,
    })
  })

  it('reports a negative shift too', () => {
    const shifted = FILE.slice(1)
    expect(checkExcerptFreshness(shifted, 3, 5, 'function a() {\n  return 1\n}')).toEqual({
      kind: 'shifted',
      from: 2,
      to: 4,
    })
  })

  it("a shifted verdict's span is the MATCHED text's, not the stored range's", () => {
    // The stored text legitimately captured two trailing blank lines at write
    // time; the comparison strips them before matching. Rebuilding the span
    // from the stored range would claim 5 lines where only 3 were checked —
    // and near EOF that addresses lines the file does not have, which the
    // validator then refuses (found in review, reproduced live).
    const shifted = ['// added', '// added', 'function a() {', '  return 1', '}']
    expect(checkExcerptFreshness(shifted, 1, 5, 'function a() {\n  return 1\n}\n\n')).toEqual({
      kind: 'shifted',
      from: 3,
      to: 5,
    })
  })

  it('says GONE when the text is nowhere in the file — deleted code, cited', () => {
    expect(checkExcerptFreshness(FILE, 3, 4, 'const platformEngine = new EngineAPI()')).toEqual({
      kind: 'gone',
    })
  })

  it('does not report drift for a trailing newline the slice added', () => {
    expect(checkExcerptFreshness(FILE, 3, 5, 'function a() {\n  return 1\n}\n')).toEqual({
      kind: 'fresh',
    })
  })

  it('normalises CRLF rather than calling every Windows-written excerpt stale', () => {
    expect(checkExcerptFreshness(FILE, 3, 5, 'function a() {\r\n  return 1\r\n}')).toEqual({
      kind: 'fresh',
    })
  })

  it('says nothing when there is no stored text to compare', () => {
    expect(checkExcerptFreshness(FILE, 1, 2, undefined)).toEqual({ kind: 'unknown' })
    expect(checkExcerptFreshness(FILE, 1, 2, '')).toEqual({ kind: 'unknown' })
    expect(checkExcerptFreshness(FILE, 1, 2, '\n\n')).toEqual({ kind: 'unknown' })
  })

  it('does not run off the end of the file for a range past it', () => {
    expect(checkExcerptFreshness(FILE, 900, 905, 'function a() {')).toEqual({
      kind: 'shifted',
      from: 3,
      to: 3,
    })
  })
})

// ── #1435: the stale walk sees the REAL artifact shape ──────────────────────
//
// The first cut of the staleness walk read `levels[].components[]` — a shape no
// real artifact has — so it visited nothing and every drifted citation passed
// silently. The contract is `views` (a record of levels) → `nodes[]` →
// `node.code`, and the regression that matters most is a drifted excerpt in a
// NESTED, non-root level: root-only iteration would find a root drift by
// accident, only the record walk finds this one.
describe('inspectFeatureView staleExcerpts — the stale walk sees the real artifact shape (#1435)', () => {
  function flowIn(repo: string): string {
    const flowDir = join(repo, 'flow')
    mkdirSync(join(flowDir, 'brain', '.structure', 'feature-views'), { recursive: true })
    return flowDir
  }

  function store(flowDir: string, slug: string, body: unknown): void {
    writeFileSync(featureViewPath(flowDir, slug), JSON.stringify(body), 'utf-8')
  }

  /** A real-shaped artifact: `views` record with root AND a nested level. */
  function nestedView(): FeatureView {
    const base = view()
    base.views.root.nodes[1].view = 'bffdetail'
    base.views.bffdetail = {
      title: 'Inside the BFF',
      nodes: [
        {
          id: 'tee',
          kind: 'function',
          title: 'The tee',
          delta: 'modify',
          code: { file: 'stream.ts', from: 1, to: 3, note: 'where the tee happens', text: 'function a() {\n  return 1\n}' },
        },
      ],
      edges: [],
    }
    return base
  }

  it('reports a drifted excerpt in a NESTED level — the shape the old walk silently missed', () => {
    const repo = tempRepo()
    const flowDir = flowIn(repo)
    // Two lines landed ABOVE the cited block: the text now starts at line 3,
    // but the range 1..3 still fits inside the file, so validation stays green.
    writeFileSync(join(repo, 'stream.ts'), '// added\n// added\nfunction a() {\n  return 1\n}\n', 'utf-8')
    store(flowDir, 'chats', nestedView())

    const inspection = inspectFeatureView(flowDir, 'chats', { repoRoot: repo })
    expect(inspection?.state).toBe('valid')
    expect(inspection?.staleExcerpts).toHaveLength(1)
    expect(inspection?.staleExcerpts[0]).toContain("component 'tee'")
    expect(inspection?.staleExcerpts[0]).toContain('stream.ts:1-3')
    expect(inspection?.staleExcerpts[0]).toContain('now starts at line 3')
  })

  it('reports [] for a view whose excerpts all sit exactly where they say', () => {
    const repo = tempRepo()
    const flowDir = flowIn(repo)
    writeFileSync(join(repo, 'stream.ts'), 'function a() {\n  return 1\n}\n', 'utf-8')
    store(flowDir, 'chats', nestedView())

    const inspection = inspectFeatureView(flowDir, 'chats', { repoRoot: repo })
    expect(inspection?.state).toBe('valid')
    expect(inspection?.staleExcerpts).toEqual([])
  })
})

// ── #1435: the self-heal — rewrite addresses, never claims ──────────────────
//
// Healing moves a shifted excerpt's from/to to where its text sits NOW, and
// touches nothing else: the text, note and noteSrc are the claim, and the
// claim did not change. `gone` and `unknown` are counted, never rewritten —
// there is no true address to move a `gone` citation to, and silently editing
// either would hide the finding the staleness report exists to surface.
describe('healFeatureView (#1435)', () => {
  function flowIn(repo: string): string {
    const flowDir = join(repo, 'flow')
    mkdirSync(join(flowDir, 'brain', '.structure', 'feature-views'), { recursive: true })
    return flowDir
  }

  function store(flowDir: string, slug: string, body: unknown): void {
    writeFileSync(featureViewPath(flowDir, slug), JSON.stringify(body), 'utf-8')
  }

  const SHIFTED_TEXT = 'function a() {\n  return 1\n}'

  /** A view citing `stream.ts:1-3` — fresh or shifted depending on the repo. */
  function citingView(code: Partial<FeatureView['views'][string]['nodes'][number]['code']> = {}): FeatureView {
    const base = view()
    base.views.root.nodes[1].code = {
      file: 'stream.ts',
      from: 1,
      to: 3,
      note: 'where the tee happens',
      noteSrc: 'source: the comment block',
      text: SHIFTED_TEXT,
      ...code,
    }
    return base
  }

  /** stream.ts with two lines landed above the cited block: text now at 3..5. */
  function shiftedRepo(): { repo: string; flowDir: string } {
    const repo = tempRepo()
    const flowDir = flowIn(repo)
    writeFileSync(join(repo, 'stream.ts'), '// added\n// added\nfunction a() {\n  return 1\n}\n', 'utf-8')
    return { repo, flowDir }
  }

  it('rewrites a shifted excerpt: from/to move, span preserved, text and note verbatim', () => {
    const { repo, flowDir } = shiftedRepo()
    store(flowDir, 'chats', citingView())

    expect(healFeatureView(flowDir, 'chats', repo)).toEqual({ healed: 1, gone: 0, unknown: 0 })

    const healed = JSON.parse(readFileSync(featureViewPath(flowDir, 'chats'), 'utf-8')) as FeatureView
    const code = healed.views.root.nodes[1].code
    expect(code?.from).toBe(3)
    expect(code?.to).toBe(5) // span 2, preserved
    expect(code?.text).toBe(SHIFTED_TEXT)
    expect(code?.note).toBe('where the tee happens')
    expect(code?.noteSrc).toBe('source: the comment block')
    // And the healed artifact reads back FRESH — the address now tells the truth.
    expect(inspectFeatureView(flowDir, 'chats', { repoRoot: repo })?.staleExcerpts).toEqual([])
  })

  it('counts gone and unknown but never rewrites them', () => {
    const { repo, flowDir } = shiftedRepo()
    const mixed = citingView()
    mixed.views.root.nodes[0].code = {
      file: 'stream.ts',
      from: 1,
      to: 1,
      note: 'deleted code, cited',
      text: 'const platformEngine = new EngineAPI()',
    }
    mixed.views.detail = {
      title: 'Detail',
      nodes: [
        {
          id: 'older',
          kind: 'module',
          title: 'Older artifact',
          delta: 'stable',
          // Blank-only text is non-empty (so the artifact stays valid) but
          // carries nothing to compare — the walk answers `unknown`.
          code: { file: 'stream.ts', from: 1, to: 1, note: 'no stored text', text: '\n\n' },
        },
      ],
      edges: [],
    }
    store(flowDir, 'chats', mixed)

    expect(healFeatureView(flowDir, 'chats', repo)).toEqual({ healed: 1, gone: 1, unknown: 1 })

    const after = JSON.parse(readFileSync(featureViewPath(flowDir, 'chats'), 'utf-8')) as FeatureView
    // The gone citation still says what it said — stale, visible, unhidden.
    expect(after.views.root.nodes[0].code).toEqual(mixed.views.root.nodes[0].code)
    // The unknown one too.
    expect(after.views.detail.nodes[0].code).toEqual(mixed.views.detail.nodes[0].code)
    // Only the shifted one moved.
    expect(after.views.root.nodes[1].code?.from).toBe(3)
  })

  it('anchors duplicated text to its FIRST occurrence — the accepted limitation', () => {
    // The excerpt's text appears twice; the heal anchors at the first match,
    // possibly a twin above the original site. Both addresses print the same
    // text, so the drawer still shows true evidence — only the line number may
    // name the twin. Accepted, and pinned here so a change to it is deliberate.
    const repo = tempRepo()
    const flowDir = flowIn(repo)
    writeFileSync(join(repo, 'stream.ts'), 'pad\nconst dup = 1\npad2\nconst dup = 1\n', 'utf-8')
    const duplicated = citingView({ from: 3, to: 3, text: 'const dup = 1' })
    store(flowDir, 'chats', duplicated)

    expect(healFeatureView(flowDir, 'chats', repo)).toEqual({ healed: 1, gone: 0, unknown: 0 })
    const code = (JSON.parse(readFileSync(featureViewPath(flowDir, 'chats'), 'utf-8')) as FeatureView)
      .views.root.nodes[1].code
    expect(code?.from).toBe(2) // first occurrence — not line 4
    expect(code?.to).toBe(2)
  })

  it('does NOT write on a no-op heal — no rotation churn, bytes untouched', () => {
    const repo = tempRepo()
    const flowDir = flowIn(repo)
    writeFileSync(join(repo, 'stream.ts'), 'function a() {\n  return 1\n}\n', 'utf-8')
    store(flowDir, 'chats', citingView()) // 1..3 is exactly where the text sits
    const path = featureViewPath(flowDir, 'chats')
    const before = readFileSync(path, 'utf-8')

    expect(healFeatureView(flowDir, 'chats', repo)).toEqual({ healed: 0, gone: 0, unknown: 0 })

    expect(readFileSync(path, 'utf-8')).toBe(before)
    expect(existsSync(path.replace(/\.json$/, '.prev.json'))).toBe(false)
  })

  it('a real heal rotates the stale version to .prev.json and leaves no .tmp', () => {
    const { repo, flowDir } = shiftedRepo()
    store(flowDir, 'chats', citingView())
    const path = featureViewPath(flowDir, 'chats')

    healFeatureView(flowDir, 'chats', repo)

    const prev = JSON.parse(readFileSync(path.replace(/\.json$/, '.prev.json'), 'utf-8')) as FeatureView
    expect(prev.views.root.nodes[1].code?.from).toBe(1) // the stale address, kept
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('is deterministic — healing twice heals nothing the second time', () => {
    const { repo, flowDir } = shiftedRepo()
    store(flowDir, 'chats', citingView())
    const path = featureViewPath(flowDir, 'chats')

    expect(healFeatureView(flowDir, 'chats', repo)?.healed).toBe(1)
    const afterFirst = readFileSync(path, 'utf-8')
    expect(healFeatureView(flowDir, 'chats', repo)).toEqual({ healed: 0, gone: 0, unknown: 0 })
    expect(readFileSync(path, 'utf-8')).toBe(afterFirst)
  })

  it('returns null when there is no artifact to heal', () => {
    const repo = tempRepo()
    expect(healFeatureView(flowIn(repo), 'nope', repo)).toBeNull()
  })

  it('returns null for an invalid artifact — healing evidence nobody trusts helps no one', () => {
    const { repo, flowDir } = shiftedRepo()
    const bad = citingView()
    bad.views.root.edges = [{ from: 'ghost', to: 'bff', label: 'x', delta: 'kept' }]
    store(flowDir, 'chats', bad)
    expect(healFeatureView(flowDir, 'chats', repo)).toBeNull()
  })

  it('counts but does NOT rewrite a misfiled artifact — healing must not re-home it', () => {
    // Filed as threads.json but claiming 'chats': writing would come out at the
    // CLAIMED feature's path, leaving the stale original behind and minting a
    // duplicate. The counts still say what was found; the file stays put.
    const { repo, flowDir } = shiftedRepo()
    store(flowDir, 'threads', citingView()) // view.feature is 'chats'
    const path = featureViewPath(flowDir, 'threads')
    const before = readFileSync(path, 'utf-8')

    expect(healFeatureView(flowDir, 'threads', repo)).toEqual({ healed: 1, gone: 0, unknown: 0 })

    expect(readFileSync(path, 'utf-8')).toBe(before)
    expect(existsSync(featureViewPath(flowDir, 'chats'))).toBe(false)
  })

  it('converges when the stored text carries trailing blank lines near EOF (review find)', () => {
    // The comparison strips the stored text's trailing blanks, so the heal must
    // take the verdict's own span. The earlier span-preserving version computed
    // `to` past the end of this 5-line file, the validator refused, the refusal
    // was discarded — and every run re-reported `healed 1` over an unchanged
    // artifact.
    const repo = tempRepo()
    const flowDir = flowIn(repo)
    writeFileSync(join(repo, 'stream.ts'), '// added\n// added\nfunction a() {\n  return 1\n}', 'utf-8')
    store(flowDir, 'chats', citingView({ from: 1, to: 5, text: `${SHIFTED_TEXT}\n\n` }))

    expect(healFeatureView(flowDir, 'chats', repo)).toEqual({ healed: 1, gone: 0, unknown: 0 })

    const healed = JSON.parse(readFileSync(featureViewPath(flowDir, 'chats'), 'utf-8')) as FeatureView
    const code = healed.views.root.nodes[1].code
    expect(code?.from).toBe(3)
    expect(code?.to).toBe(5) // the MATCHED span — never past EOF
    // And it CONVERGED: the write happened, so the second heal finds nothing.
    expect(healFeatureView(flowDir, 'chats', repo)).toEqual({ healed: 0, gone: 0, unknown: 0 })
  })

  it('reads a CRLF checkout as fresh, not as every excerpt gone (review find)', () => {
    // The comparator normalizes the STORED text's line endings; the walker must
    // normalize the FILE's too, or a Windows checkout renders "no longer in
    // the file" under perfectly current code — on every excerpt it cites.
    const repo = tempRepo()
    const flowDir = flowIn(repo)
    writeFileSync(join(repo, 'stream.ts'), 'function a() {\r\n  return 1\r\n}\r\n', 'utf-8')
    store(flowDir, 'chats', citingView())

    expect(healFeatureView(flowDir, 'chats', repo)).toEqual({ healed: 0, gone: 0, unknown: 0 })
    expect(inspectFeatureView(flowDir, 'chats', { repoRoot: repo })?.staleExcerpts).toEqual([])
  })
})
