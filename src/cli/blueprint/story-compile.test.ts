/**
 * Tests for the `blueprint narrate` compile core (`story-compile.ts`):
 * mode inference + flag overrides, plan-name derivation, strict refusals
 * (all violations at once, sorted), draft leniency, ghost resolution via
 * proposals, the step cap warning, serialization determinism, atomic-write
 * lock behavior, `--clear` outcomes, and the absent-`## Story` refusal.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearCompiledStory,
  compileStory,
  derivePlanName,
  hasStorySection,
  inferMode,
  readCompiledStory,
  serializeStory,
  STORY_FILENAME,
  STORY_STORE_BUSY_NOTICE,
  writeCompiledStory,
  type CompileStoryInput,
} from './story-compile.js';
import type { BlueprintGraph, CompiledStory } from './types.js';
import type { EffectiveProposal } from './proposal-store.js';

// ── fixtures ─────────────────────────────────────────────

/** An empty-but-valid derived graph (no nodes resolve). */
function emptyGraph(): BlueprintGraph {
  return {
    version: 1,
    derivedAt: '2026-07-15T00:00:00.000Z',
    coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: [], graphifyEnriched: false },
    nodes: [],
    edges: [],
  };
}

/** A graph containing a single module node `module:src/cli`. */
function graphWithCliModule(): BlueprintGraph {
  return {
    ...emptyGraph(),
    nodes: [
      { id: 'module:src/cli', kind: 'module', label: 'cli', sourceFile: 'src/cli' },
    ],
  };
}

/** A live (`proposed`) ghost for a predicted endpoint node. */
function endpointGhost(predictedNodeId: string): EffectiveProposal {
  return {
    fingerprint: `plan_x+${predictedNodeId}`,
    plan: 'plan_x',
    predictedNodeId,
    kind: 'endpoint',
    label: 'Widgets endpoint',
    anchors: [],
    state: 'proposed',
    provenance: 'cli:propose',
    proposedAt: '2026-07-15T00:00:00.000Z',
  };
}

/** Build a compile input with sane defaults. */
function input(overrides: Partial<CompileStoryInput> & Pick<CompileStoryInput, 'markdown'>): CompileStoryInput {
  return {
    sourcePath: 'flow/plans/plan_demo_v1.md',
    plan: 'demo',
    mode: 'strict',
    graph: emptyGraph(),
    proposals: [],
    ...overrides,
  };
}

const STORY_WITH_MODULE = [
  '# Plan',
  '',
  '## Story',
  '',
  '### Step: Wire the CLI',
  '- anchors: module:src/cli',
  '- flow: module:src/cli',
  '- phases: 1, 2',
  '',
  'The CLI gets a new verb.',
  '',
  '## Next section',
].join('\n');

// ── hasStorySection ──────────────────────────────────────

describe('hasStorySection', () => {
  it('detects a present ## Story heading and rejects its absence', () => {
    expect(hasStorySection(STORY_WITH_MODULE)).toBe(true);
    expect(hasStorySection('# Plan\n\nNo story here.')).toBe(false);
  });
});

// ── inferMode ────────────────────────────────────────────

describe('inferMode', () => {
  it('infers strict for plans, draft for discovery/brainstorms', () => {
    expect(inferMode('flow/plans/plan_a_v1.md')).toBe('strict');
    expect(inferMode('flow/discovery/discovery_a_v1.md')).toBe('draft');
    expect(inferMode('flow/brainstorms/brainstorm_a.md')).toBe('draft');
  });

  it('returns null for paths that do not carry a mode', () => {
    expect(inferMode('docs/random.md')).toBeNull();
  });

  it('lets an explicit flag override the inferred mode', () => {
    expect(inferMode('flow/plans/plan_a_v1.md', 'draft')).toBe('draft');
    expect(inferMode('docs/random.md', 'strict')).toBe('strict');
  });

  it('handles windows-style separators', () => {
    expect(inferMode('flow\\plans\\plan_a_v1.md')).toBe('strict');
  });
});

// ── derivePlanName ───────────────────────────────────────

describe('derivePlanName', () => {
  it('derives the name from plan/discovery/brainstorm filenames', () => {
    expect(derivePlanName('flow/plans/plan_blueprint-story_v2.md')).toBe('blueprint-story');
    expect(derivePlanName('flow/discovery/discovery_foo_v1.md')).toBe('foo');
    expect(derivePlanName('flow/brainstorms/brainstorm_bar.md')).toBe('bar');
  });

  it('prefers an explicit plan over the filename', () => {
    expect(derivePlanName('flow/plans/plan_foo_v1.md', 'override')).toBe('override');
  });

  it('returns null when the filename does not match and no plan is given', () => {
    expect(derivePlanName('docs/notes.md')).toBeNull();
  });
});

// ── compileStory: refusals ───────────────────────────────

describe('compileStory refusals', () => {
  it('refuses an absent ## Story section in both modes', () => {
    for (const mode of ['strict', 'draft'] as const) {
      const result = compileStory(input({ markdown: '# Plan\n\nnothing', mode, sourcePath: 'd.md' }));
      expect(result).toEqual({ status: 'refused', reasons: ['no ## Story section in d.md'] });
    }
  });

  it('refuses strict mode when no graph has been derived', () => {
    const result = compileStory(input({ markdown: STORY_WITH_MODULE, mode: 'strict', graph: null }));
    expect(result).toEqual({
      status: 'refused',
      reasons: ['no blueprint — run planflow-ai blueprint derive first'],
    });
  });

  it('lists ALL strict violations at once, sorted', () => {
    const markdown = [
      '## Story',
      '### Step: One',
      '- anchors: module:src/ghost',
      '- flow: module:src/nowhere',
      '- phases: 0',
      '### Step: Two',
      '- anchors: module:src/absent',
    ].join('\n');

    const result = compileStory(input({ markdown, mode: 'strict', graph: emptyGraph() }));
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') {
      throw new Error('expected refusal');
    }
    expect(result.reasons).toEqual([
      'invalid phase 0 (step "One")',
      'unknown flow id module:src/nowhere (step "One")',
      'unresolved anchor module:src/absent (step "Two")',
      'unresolved anchor module:src/ghost (step "One")',
    ]);
    // Explicitly sorted.
    expect([...result.reasons].sort()).toEqual(result.reasons);
  });

  it('compiles strictly when every anchor and flow id resolves', () => {
    const result = compileStory(input({ markdown: STORY_WITH_MODULE, mode: 'strict', graph: graphWithCliModule() }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected ok');
    }
    expect(result.story.steps).toHaveLength(1);
    expect(result.story.steps[0].draft).toBe(false);
    expect(result.story.steps[0].unresolvedAnchors).toEqual([]);
  });
});

// ── compileStory: draft leniency ─────────────────────────

describe('compileStory draft leniency', () => {
  it('compiles unresolved steps as drafts with populated unresolvedAnchors', () => {
    const markdown = [
      '## Story',
      '### Step: Ghosty',
      '- anchors: module:src/absent',
      '- flow: module:src/nowhere',
      '- phases: 0',
    ].join('\n');

    const result = compileStory(input({ markdown, mode: 'draft', graph: emptyGraph() }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected ok');
    }
    const step = result.story.steps[0];
    expect(step.draft).toBe(true);
    expect(step.unresolvedAnchors).toEqual(['module:src/absent']);
    // Unresolved flow ids are kept (not dropped) even though they mark draft.
    expect(step.flow).toEqual(['module:src/nowhere']);
  });

  it('tolerates a null graph in draft mode', () => {
    const result = compileStory(input({ markdown: STORY_WITH_MODULE, mode: 'draft', graph: null }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected ok');
    }
    expect(result.story.steps[0].draft).toBe(true);
  });
});

// ── compileStory: ghost resolution ───────────────────────

describe('compileStory ghost resolution', () => {
  it('resolves an anchor against a live proposal ghost (strict passes)', () => {
    const markdown = [
      '## Story',
      '### Step: New endpoint',
      '- anchors: endpoint:GET /widgets',
      '- flow: endpoint:GET /widgets',
    ].join('\n');

    const proposals = [endpointGhost('endpoint:GET /widgets')];
    const result = compileStory(input({ markdown, mode: 'strict', graph: emptyGraph(), proposals }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected ok');
    }
    expect(result.story.steps[0].draft).toBe(false);
    expect(result.story.steps[0].unresolvedAnchors).toEqual([]);
  });
});

// ── compileStory: step cap ───────────────────────────────

describe('compileStory step cap', () => {
  it('caps at STORY_STEP_CAP and warns with the dropped titles', () => {
    const steps = Array.from({ length: 7 }, (_unused, i) => `### Step: Step ${i + 1}`);
    const markdown = ['## Story', ...steps].join('\n');

    const result = compileStory(input({ markdown, mode: 'draft', graph: emptyGraph() }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected ok');
    }
    expect(result.story.steps).toHaveLength(5);
    expect(result.story.warnings).toContain(
      'story step cap (5) exceeded — dropped 2 step(s): "Step 6", "Step 7"',
    );
  });
});

// ── serialization determinism ────────────────────────────

describe('serialization determinism', () => {
  it('produces byte-identical output for the same inputs (double compile)', () => {
    const compileOnce = () =>
      compileStory(input({ markdown: STORY_WITH_MODULE, mode: 'strict', graph: graphWithCliModule() }));
    const a = compileOnce();
    const b = compileOnce();
    if (a.status !== 'ok' || b.status !== 'ok') {
      throw new Error('expected ok');
    }
    expect(serializeStory(a.story)).toBe(serializeStory(b.story));
  });

  it('serializes with stable key order and no timestamp field', () => {
    const result = compileStory(input({ markdown: STORY_WITH_MODULE, mode: 'strict', graph: graphWithCliModule() }));
    if (result.status !== 'ok') {
      throw new Error('expected ok');
    }
    const json = serializeStory(result.story);
    expect(json.endsWith('\n')).toBe(true);
    expect(json).not.toMatch(/"ts"|"derivedAt"|"timestamp"/);
    const topKeys = Object.keys(JSON.parse(json) as Record<string, unknown>);
    expect(topKeys).toEqual(['plan', 'sourcePath', 'mode', 'steps', 'warnings']);
  });
});

// ── store I/O: write / read / lock ───────────────────────

describe('store I/O', () => {
  let flowDir: string;
  let structureDir: string;

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'story-compile-test-'));
    structureDir = join(flowDir, 'brain', '.structure');
  });

  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true });
  });

  function sampleStory(plan = 'demo'): CompiledStory {
    const result = compileStory(input({ plan, markdown: STORY_WITH_MODULE, mode: 'strict', graph: graphWithCliModule() }));
    if (result.status !== 'ok') {
      throw new Error('expected ok');
    }
    return result.story;
  }

  it('writes atomically and reads the story back', () => {
    const story = sampleStory();
    writeCompiledStory(structureDir, story);
    expect(existsSync(join(structureDir, STORY_FILENAME))).toBe(true);
    expect(readCompiledStory(structureDir)).toEqual(story);
  });

  it('writes byte-identical files on repeat (determinism on disk)', () => {
    const story = sampleStory();
    writeCompiledStory(structureDir, story);
    const first = readFileSync(join(structureDir, STORY_FILENAME), 'utf-8');
    writeCompiledStory(structureDir, story);
    const second = readFileSync(join(structureDir, STORY_FILENAME), 'utf-8');
    expect(second).toBe(first);
  });

  it('throws the busy notice when the store lock is held', () => {
    mkdirSync(structureDir, { recursive: true });
    writeFileSync(join(structureDir, 'story.lock'), '', 'utf-8');
    expect(() => writeCompiledStory(structureDir, sampleStory())).toThrow(STORY_STORE_BUSY_NOTICE);
  });

  it('returns null when no story exists', () => {
    expect(readCompiledStory(structureDir)).toBeNull();
  });

  // ── clear ──────────────────────────────────────────────

  it('clears a story only when the plan matches', () => {
    writeCompiledStory(structureDir, sampleStory('alpha'));

    // Wrong plan → no-op, file survives.
    expect(clearCompiledStory(structureDir, 'beta')).toEqual({ cleared: false });
    expect(existsSync(join(structureDir, STORY_FILENAME))).toBe(true);

    // Matching plan → cleared, file gone.
    expect(clearCompiledStory(structureDir, 'alpha')).toEqual({ cleared: true });
    expect(existsSync(join(structureDir, STORY_FILENAME))).toBe(false);
  });

  it('is a silent no-op when no story exists', () => {
    expect(clearCompiledStory(structureDir, 'alpha')).toEqual({ cleared: false });
  });
});
