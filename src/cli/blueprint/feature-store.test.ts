import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AmbiguousLearnedSectionError,
  featuresDir,
  featureSummary,
  hasUnparsedContent,
  LEARNED_HEADING,
  parseLearnings,
  serializeLearnings,
  splitLearned,
  writeLearned,
  type Learning,
  isWorkingSetCapture,
  mintFeatureId,
  normalizeEdges,
  parseEdges,
  parseFeatureFile,
  readFeatures,
  readFeaturesWithExclusions,
  featureAdvisory,
  reclassFeatures,
  seedDomains,
  seedFeatures,
  serializeEdges,
  serializeFeature,
  slugifyFeatureName,
  writeFeature,
  writeEdges,
  reviewEdges,
  describeEdge,
  EMPTY_TARGET_REASON,
  SELF_TARGET_REASON,
  UNKNOWN_TARGET_REASON,
  type FeatureEdge,
  featureHome,
  homeValueOf,
  parseParts,
  readParts,
  serializeParts,
  setHomeInText,
  splitParts,
  writeFeatureHome,
  writeParts,
} from './feature-store.js';

function tempFlow(): string {
  const dir = mkdtempSync(join(tmpdir(), 'feat-store-'));
  mkdirSync(featuresDir(dir), { recursive: true });
  return dir;
}

/** A file exactly as brain-capture writes them today: no frontmatter. */
const LEGACY = `# Feature: Blueprint Simulation

**Status:** discovery complete

## What

A pre-execution simulation of a change.
`;

describe('parsing a legacy file (no frontmatter)', () => {
  it('parses with defaults and keeps the whole file as body', () => {
    const node = parseFeatureFile('blueprint-simulation', LEGACY);
    expect(node.id).toBe('feature:blueprint-simulation');
    expect(node.kind).toBe('core');
    expect(node.anchors).toEqual([]);
    expect(node.patchCount).toBe(0);
    expect(node.lastFullRead).toBeNull();
    expect(node.body).toBe(LEGACY);
  });

  it('derives the display name from the heading, never inventing prose', () => {
    expect(parseFeatureFile('x', LEGACY).name).toBe('Blueprint Simulation')
    expect(parseFeatureFile('my-slug', 'no heading here\n').name).toBe('my-slug')
  });
});

describe('round trip', () => {
  it('preserves the body byte-for-byte', () => {
    const node = parseFeatureFile('f', LEGACY);
    const out = serializeFeature(node);
    expect(out.endsWith(LEGACY)).toBe(true);
    expect(parseFeatureFile('f', out).body).toBe(LEGACY);
  });

  it('is deterministic — same node yields byte-identical output', () => {
    const node = parseFeatureFile('f', LEGACY);
    expect(serializeFeature(node)).toBe(serializeFeature(node));
  });

  it('preserves frontmatter keys it does not own', () => {
    const raw = `---\nid: feature:f\nname: F\nkind: core\nanchors: []\nrelates: []\nlastFullRead: null\npatchCount: 0\nmyOwnKey: keep me\n---\nbody\n`;
    const node = parseFeatureFile('f', raw);
    expect(node.extra.myOwnKey).toBe('keep me');
    expect(serializeFeature(node)).toContain('myOwnKey: keep me');
  });

  it('round-trips domain — a named, human-owned field', () => {
    const raw = `---\nid: feature:f\nname: F\nkind: core\ndomain: CLI\nanchors: []\nrelates: []\nlastFullRead: null\npatchCount: 0\n---\nbody\n`;
    const node = parseFeatureFile('f', raw);
    expect(node.domain).toBe('CLI');
    const out = serializeFeature(node);
    expect(out).toContain('domain: CLI');
    expect(parseFeatureFile('f', out).domain).toBe('CLI');
  });

  it('a file with no domain: stays without one — no synthesised default', () => {
    const node = parseFeatureFile('f', LEGACY);
    expect(node.domain).toBeUndefined();
    expect(serializeFeature(node)).not.toContain('domain:');
  });
});

// ── `relates`: the structured edge ──────────────────────────────────────────

/** A file carrying one structured edge, in the block form this store writes. */
const STRUCTURED = `---
id: feature:playbooks
name: Playbooks
kind: core
anchors: []
relates:
  - target: feature:skills
    via: src/cli/playbooks/manifest-binder.ts
    note: a playbook step names a skill by slug; the binder resolves it at authoring time
lastFullRead: null
patchCount: 0
---
body
`;

describe('relates — a structured edge, not a bare id', () => {
  it('parses target, via and note out of the block form', () => {
    expect(parseFeatureFile('playbooks', STRUCTURED).relates).toEqual([
      {
        target: 'feature:skills',
        via: 'src/cli/playbooks/manifest-binder.ts',
        note: 'a playbook step names a skill by slug; the binder resolves it at authoring time',
      },
    ]);
  });

  it('keeps a note carrying commas and colons — the reason it is not an inline list', () => {
    const raw = STRUCTURED.replace(
      'note: a playbook step names a skill by slug; the binder resolves it at authoring time',
      'note: skills bind at authoring time, not run time: the manifest is frozen, then read',
    );
    expect(parseFeatureFile('playbooks', raw).relates[0].note).toBe(
      'skills bind at authoring time, not run time: the manifest is frozen, then read',
    );
  });

  it('never leaks an edge key into `extra`, where it would resurface as a top-level key', () => {
    const node = parseFeatureFile('playbooks', STRUCTURED);
    expect(node.extra).toEqual({});
    expect(serializeFeature(node)).not.toMatch(/^via:/m);
  });

  it('parses the block after it, not before — the keys around it survive', () => {
    const node = parseFeatureFile('playbooks', STRUCTURED);
    expect(node.lastFullRead).toBeNull();
    expect(node.patchCount).toBe(0);
    expect(node.body).toBe('body\n');
  });

  it('drops an edge with no target — an edge to nothing is not an edge', () => {
    expect(parseEdges('', ['  - target:', '    via: x.ts'])).toEqual([]);
  });

  it('accepts a hand-written `- feature:x` item rather than losing the id', () => {
    expect(parseEdges('', ['  - feature:skills'])).toEqual([{ target: 'feature:skills' }]);
  });

  it('collapses a multi-word note to one line and drops empty via/note', () => {
    expect(normalizeEdges([{ target: 'feature:a', via: '  ', note: 'two   words' }])).toEqual([
      { target: 'feature:a', note: 'two words' },
    ]);
  });
});

/**
 * DETERMINISM — these files are about to be TRACKED in git.
 *
 * A re-write that reorders or reformats an edge list produces a diff in
 * somebody's PR that nothing in the change actually caused. So: same edges in,
 * same bytes out, whatever order the writer happened to emit them in.
 */
describe('relates — deterministic serialization', () => {
  const EDGES: FeatureEdge[] = [
    { target: 'feature:skills', via: 'src/bind.ts', note: 'a step names a skill by slug' },
    { target: 'feature:chats', via: 'src/stream.ts' },
    { target: 'feature:auth' },
  ];

  it('round-trips the block form byte-identically', () => {
    expect(serializeFeature(parseFeatureFile('playbooks', STRUCTURED))).toBe(STRUCTURED);
  });

  it('is byte-identical whatever order the writer emitted the edges in', () => {
    const shuffled = [EDGES[2], EDGES[0], EDGES[1]];
    expect(serializeEdges(shuffled)).toBe(serializeEdges(EDGES));
    // …and that canonical order is target-ascending, not input order.
    expect(serializeEdges(EDGES).split('\n').filter((line) => line.includes('- target:'))).toEqual([
      '  - target: feature:auth',
      '  - target: feature:chats',
      '  - target: feature:skills',
    ]);
  });

  it('drops an exact duplicate — the same edge twice is one edge', () => {
    expect(normalizeEdges([EDGES[0], { ...EDGES[0] }])).toEqual([EDGES[0]]);
    // A second mechanism to the same feature is NOT a duplicate.
    expect(normalizeEdges([EDGES[0], { ...EDGES[0], via: 'src/other.ts' }])).toHaveLength(2);
  });

  it('serializes inline while every edge is bare, block as soon as one is not', () => {
    expect(serializeEdges([{ target: 'feature:b' }, { target: 'feature:a' }])).toBe(
      'relates: [feature:a, feature:b]',
    );
    expect(serializeEdges([{ target: 'feature:a', note: 'why' }])).toBe(
      'relates:\n  - target: feature:a\n    note: why',
    );
  });

  it('writing the same edges twice leaves the file byte-identical', () => {
    const flow = tempFlow();
    const path = join(featuresDir(flow), 'f.md');
    writeFeature(flow, parseFeatureFile('f', LEGACY), { relates: EDGES });
    const first = readFileSync(path, 'utf-8');
    writeFeature(flow, parseFeatureFile('f', LEGACY), { relates: [...EDGES].reverse() });
    expect(readFileSync(path, 'utf-8')).toBe(first);
    // And the write survives a read: this is the store's own round trip.
    expect(readFeatures(flow)[0].relates).toEqual(normalizeEdges(EDGES));
  });

  it('a machine write of relates leaves prose and human fields untouched', () => {
    const flow = tempFlow();
    writeFeature(flow, parseFeatureFile('f', LEGACY));
    const path = join(featuresDir(flow), 'f.md');
    writeFileSync(path, readFileSync(path, 'utf-8').replace('name: Blueprint Simulation', 'name: Mine'));

    writeFeature(flow, parseFeatureFile('f', LEGACY), { relates: EDGES });

    const after = readFeatures(flow)[0];
    expect(after.name).toBe('Mine');
    expect(after.body).toBe(LEGACY);
    expect(after.relates).toEqual(normalizeEdges(EDGES));
  });
});

/**
 * TASK 1.5 GUARD — the legacy `string[]` form.
 *
 * Every feature file in every project today carries `relates: []`, and a few
 * could carry `relates: [feature:x]`. Restructuring the field must not make one
 * of them fail to load or quietly drop the id it names: the schema change is
 * free precisely because the old form is the new form's bare case.
 */
describe('legacy `relates: [feature:x]` — loads, round-trips, keeps the id', () => {
  const LEGACY_EDGE = `---
id: feature:f
name: F
kind: core
anchors: []
relates: [feature:x]
lastFullRead: null
patchCount: 0
---
body
`;

  it('loads as a bare edge — no via, no note, id intact', () => {
    expect(parseFeatureFile('f', LEGACY_EDGE).relates).toEqual([{ target: 'feature:x' }]);
  });

  it('round-trips BYTE-IDENTICALLY — a schema change nobody sees in a diff', () => {
    expect(serializeFeature(parseFeatureFile('f', LEGACY_EDGE))).toBe(LEGACY_EDGE);
  });

  it('survives a machine write that never mentions relates', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'f.md'), LEGACY_EDGE);
    writeFeature(flow, parseFeatureFile('f', LEGACY_EDGE), { patchCount: 2 });
    const after = readFeatures(flow)[0];
    expect(after.relates).toEqual([{ target: 'feature:x' }]); // id not lost
    expect(after.patchCount).toBe(2);
    expect(readFileSync(join(featuresDir(flow), 'f.md'), 'utf-8')).toContain('relates: [feature:x]');
  });

  it('keeps `relates: []` byte-identical — the state of all 101 files today', () => {
    const empty = LEGACY_EDGE.replace('relates: [feature:x]', 'relates: []');
    expect(serializeFeature(parseFeatureFile('f', empty))).toBe(empty);
  });

  it('reads back off DISK with the id intact — the path a real store takes', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'f.md'), LEGACY_EDGE);
    expect(readFeatures(flow)[0].relates).toEqual([{ target: 'feature:x' }]);
  });

  it('adoption leaves an already-adopted legacy file byte-identical', () => {
    const flow = tempFlow();
    const path = join(featuresDir(flow), 'f.md');
    writeFileSync(path, LEGACY_EDGE);
    // Already carries an `id:`, so seeding must touch nothing at all — the
    // schema change must not turn a no-op sweep into a 101-file diff.
    expect(seedFeatures(flow)).toEqual([]);
    expect(readFileSync(path, 'utf-8')).toBe(LEGACY_EDGE);
  });

  it('keeps every id when the legacy list names several', () => {
    const many = LEGACY_EDGE.replace('relates: [feature:x]', 'relates: [feature:z, feature:a]');
    const node = parseFeatureFile('f', many);
    expect(node.relates.map((edge) => edge.target).sort()).toEqual(['feature:a', 'feature:z']);
  });
});

describe('writeFeature — the preserve-on-write guarantee', () => {
  it('NEVER alters human-owned fields or prose, even when the caller is stale', () => {
    const flow = tempFlow();
    const original = parseFeatureFile('auth', LEGACY);
    writeFeature(flow, original);

    // A human renames it, re-kinds it and edits the prose on disk.
    const path = join(featuresDir(flow), 'auth.md');
    const edited = readFileSync(path, 'utf-8')
      .replace('name: Blueprint Simulation', 'name: Auth & Sessions')
      .replace('kind: core', 'kind: child')
      .replace('A pre-execution simulation of a change.', 'MY OWN WORDS.');
    writeFileSync(path, edited);

    // A later sweep writes machine fields holding the STALE node.
    writeFeature(flow, original, { anchors: ['module:src/auth'], patchCount: 3 });

    const after = readFeatures(flow)[0];
    expect(after.name).toBe('Auth & Sessions'); // rename survived
    expect(after.kind).toBe('child'); // human field survived
    expect(after.body).toContain('MY OWN WORDS.'); // prose survived
    expect(after.anchors).toEqual(['module:src/auth']); // machine field applied
    expect(after.patchCount).toBe(3);
  });

  it('creates a new feature when none exists on disk', () => {
    const flow = tempFlow();
    writeFeature(flow, { ...parseFeatureFile('brand-new', '# Feature: Brand New\n'), anchors: [] });
    const read = readFeatures(flow);
    expect(read).toHaveLength(1);
    expect(read[0].slug).toBe('brand-new');
  });

  it('leaves unspecified machine fields untouched', () => {
    const flow = tempFlow();
    writeFeature(flow, parseFeatureFile('f', LEGACY), { anchors: ['a'], patchCount: 2 });
    writeFeature(flow, parseFeatureFile('f', LEGACY), { patchCount: 5 });
    const after = readFeatures(flow)[0];
    expect(after.anchors).toEqual(['a']); // not clobbered by the second write
    expect(after.patchCount).toBe(5);
  });

  it('a machine write never touches a human-set domain', () => {
    const flow = tempFlow();
    writeFeature(flow, parseFeatureFile('f', LEGACY));
    const path = join(featuresDir(flow), 'f.md');
    writeFileSync(path, readFileSync(path, 'utf-8').replace('kind: core', 'kind: core\ndomain: CLI'));

    writeFeature(flow, readFeatures(flow)[0], { anchors: ['module:src/x'], patchCount: 1 });

    const after = readFeatures(flow)[0];
    expect(after.domain).toBe('CLI');
    expect(after.anchors).toEqual(['module:src/x']);
  });
});

describe('identity', () => {
  it('mints a stable, content-free id from the slug', () => {
    expect(mintFeatureId('auth-sessions')).toBe('feature:auth-sessions');
  });

  it('slugifies names the same way story ids do', () => {
    expect(slugifyFeatureName('Auth & Sessions')).toBe('auth-sessions');
    expect(slugifyFeatureName('!!!')).toBe('feature');
  });

  it('keeps the id stable when the display name changes', () => {
    const raw = `---\nid: feature:original\nname: Renamed Later\nkind: core\nanchors: []\nrelates: []\nlastFullRead: null\npatchCount: 0\n---\nbody\n`;
    expect(parseFeatureFile('original', raw).id).toBe('feature:original');
  });
});

describe('seeding', () => {
  it('adopts legacy files in place and is idempotent', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'one.md'), LEGACY);
    writeFileSync(join(featuresDir(flow), 'two.md'), '# Feature: Two\n\nprose\n');

    expect(seedFeatures(flow).sort()).toEqual(['one', 'two']);
    const oneAfter = readFileSync(join(featuresDir(flow), 'one.md'), 'utf-8');
    expect(oneAfter).toContain('id: feature:one');
    expect(oneAfter.endsWith(LEGACY)).toBe(true); // prose untouched

    // Second run adopts nothing and changes nothing.
    expect(seedFeatures(flow)).toEqual([]);
    expect(readFileSync(join(featuresDir(flow), 'one.md'), 'utf-8')).toBe(oneAfter);
  });

  it('--dry-run reports without writing', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'one.md'), LEGACY);
    expect(seedFeatures(flow, { dryRun: true })).toEqual(['one']);
    expect(readFileSync(join(featuresDir(flow), 'one.md'), 'utf-8')).toBe(LEGACY);
  });

  it('skips index.md — it is the brain index, not a feature', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'index.md'), '# Index\n');
    expect(seedFeatures(flow)).toEqual([]);
    expect(readFeatures(flow)).toEqual([]);
  });
});

describe('working-set captures are not features', () => {
  const WORKING_SET = `---
feature: acme-2204-error-endpoint
title: "ACME-2204: Error endpoint when spaces is not enabled"
thread_id: 0e2dc73b-d27f-4f09-90b9-c1fa6c5a0628
captured_at: 2026-07-16T20:28:02.154Z
---

# ACME-2204: Error endpoint when spaces is not enabled

Working set for "ACME-2204" — 36 file(s): 5 edited, 31 read.
`;

  it('detects a capture by thread_id OR by the working-set body', () => {
    expect(isWorkingSetCapture(WORKING_SET)).toBe(true);
    expect(isWorkingSetCapture('# Feature: Real\n\nProse.\n')).toBe(false);
    // Body marker alone is enough — some captures carry no thread_id.
    expect(isWorkingSetCapture('# X\n\nWorking set for "Y" — 3 file(s).\n')).toBe(true);
  });

  it('readFeatures SKIPS them — a chat thread is not a product feature', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'acme-2204.md'), WORKING_SET);
    writeFileSync(join(featuresDir(flow), 'real.md'), '# Feature: Real Feature\n\nProse.\n');
    expect(readFeatures(flow).map((f) => f.slug)).toEqual(['real']);
  });

  it('a brain-capture note is excluded by the marker it CARRIES', () => {
    const flow = tempFlow();
    const note = `---\ncapture: brain\nstatus: active\n---\n\n# Tenant Id Alias Consolidation\n\nFindings.\n`;
    writeFileSync(join(featuresDir(flow), 'tenant-note.md'), note);
    writeFileSync(join(featuresDir(flow), 'chats.md'), '---\nkind: core\n---\n\n# Chats\n');
    const { features, excluded } = readFeaturesWithExclusions(flow);
    expect(features.map((f) => f.slug)).toEqual(['chats']);
    expect(excluded).toEqual([{ slug: 'tenant-note', reason: 'capture-note', dropped: true }]);
  });

  it('a file with no kind is ADMITTED and reported — never silently dropped', () => {
    // The stated failure this rule must not have: a real capability someone
    // wrote by hand disappearing with no reason shown.
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'hand-written.md'), '# Feature: Hand Written\n\nProse.\n');
    const { features, excluded } = readFeaturesWithExclusions(flow);
    expect(features.map((f) => f.slug)).toEqual(['hand-written']);
    expect(excluded).toEqual([{ slug: 'hand-written', reason: 'no-kind', dropped: false }]);
  });

  it('an unreadable kind value is reported too — a typo is not a capability claim', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'typo.md'), '---\nkind: cor\n---\n\n# Typo\n');
    expect(featureAdvisory('---\nkind: cor\n---\n\n# Typo\n')).toBe('no-kind');
    expect(readFeaturesWithExclusions(flow).excluded.map((e) => e.reason)).toEqual(['no-kind']);
  });

  it('an explicit kind is admitted and never reported', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'chats.md'), '---\nkind: core\n---\n\n# Chats\n');
    writeFileSync(join(featuresDir(flow), 'migration.md'), '---\nkind: child\n---\n\n# Migration\n');
    const { features, excluded } = readFeaturesWithExclusions(flow);
    expect(features.map((f) => `${f.slug}:${f.kind}`)).toEqual(['chats:core', 'migration:child']);
    expect(excluded).toEqual([]);
  });

  it('working sets stay out of the report — dozens of them would bury the rest', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'acme-2204.md'), WORKING_SET);
    expect(readFeaturesWithExclusions(flow).excluded).toEqual([]);
  });

  it('the adoption sweep still reaches a kindless file — it is what writes one', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'legacy.md'), '# Feature: Legacy\n\nProse.\n');
    writeFileSync(join(featuresDir(flow), 'note.md'), '---\ncapture: brain\n---\n\n# Note\n');
    expect(seedFeatures(flow)).toEqual(['legacy']);
  });

  it('seeding never adopts one', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'acme-2204.md'), WORKING_SET);
    const before = readFileSync(join(featuresDir(flow), 'acme-2204.md'), 'utf-8');
    expect(seedFeatures(flow)).toEqual([]);
    expect(readFileSync(join(featuresDir(flow), 'acme-2204.md'), 'utf-8')).toBe(before);
  });
});

describe('reclassFeatures — the one writer of kind/parent', () => {
  it('re-levels a change record under the capability it touches', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'chat-session-cache-rework.md'), LEGACY);
    seedFeatures(flow);
    expect(readFeatures(flow)[0].kind).toBe('core'); // seed's default, not a human choice

    const applied = reclassFeatures(flow, [
      { slug: 'chat-session-cache-rework', kind: 'child', parent: 'feature:chats' },
    ]);
    expect(applied).toEqual(['chat-session-cache-rework']);
    const after = readFeatures(flow)[0];
    expect(after.kind).toBe('child');
    expect(after.parent).toBe('feature:chats');
  });

  it('leaves prose and machine fields untouched', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'f.md'), LEGACY);
    seedFeatures(flow);
    writeFeature(flow, readFeatures(flow)[0], { anchors: ['module:src/x'], patchCount: 4 });

    reclassFeatures(flow, [{ slug: 'f', kind: 'child', parent: 'feature:p' }]);
    const after = readFeatures(flow)[0];
    expect(after.body).toBe(LEGACY);
    expect(after.anchors).toEqual(['module:src/x']);
    expect(after.patchCount).toBe(4);
  });

  it('is idempotent and reports only what actually changed', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'f.md'), LEGACY);
    seedFeatures(flow);
    const change = [{ slug: 'f', kind: 'child' as const, parent: 'feature:p' }];
    expect(reclassFeatures(flow, change)).toEqual(['f']);
    expect(reclassFeatures(flow, change)).toEqual([]);
  });

  it('clears a parent when none is given, rather than keeping a stale one', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'f.md'), LEGACY);
    seedFeatures(flow);
    reclassFeatures(flow, [{ slug: 'f', kind: 'child', parent: 'feature:old' }]);
    reclassFeatures(flow, [{ slug: 'f', kind: 'core' }]);
    const after = readFeatures(flow)[0];
    expect(after.kind).toBe('core');
    expect(after.parent).toBeUndefined();
  });

  it('--dry-run reports without writing', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'f.md'), LEGACY);
    seedFeatures(flow);
    const before = readFileSync(join(featuresDir(flow), 'f.md'), 'utf-8');
    expect(reclassFeatures(flow, [{ slug: 'f', kind: 'child' }], { dryRun: true })).toEqual(['f']);
    expect(readFileSync(join(featuresDir(flow), 'f.md'), 'utf-8')).toBe(before);
  });

  it('skips a slug that has no file, rather than creating one', () => {
    const flow = tempFlow();
    expect(reclassFeatures(flow, [{ slug: 'ghost', kind: 'child' }])).toEqual([]);
    expect(readFeatures(flow)).toEqual([]);
  });
});

describe('seedDomains — the one writer of domain', () => {
  it('sets domain on a feature that has none', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'f.md'), LEGACY);
    seedFeatures(flow);
    expect(seedDomains(flow, [{ slug: 'f', domain: 'CLI' }])).toEqual(['f']);
    expect(readFeatures(flow)[0].domain).toBe('CLI');
  });

  it('NEVER overwrites an existing domain', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'f.md'), LEGACY);
    seedFeatures(flow);
    seedDomains(flow, [{ slug: 'f', domain: 'CLI' }]);

    // A human corrects it by hand.
    const path = join(featuresDir(flow), 'f.md');
    writeFileSync(path, readFileSync(path, 'utf-8').replace('domain: CLI', 'domain: Renderer'));

    expect(seedDomains(flow, [{ slug: 'f', domain: 'CLI' }])).toEqual([]);
    expect(readFeatures(flow)[0].domain).toBe('Renderer'); // human correction survives
  });

  it('is idempotent — a second run against an already-seeded file sets nothing', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'f.md'), LEGACY);
    seedFeatures(flow);
    const seeds = [{ slug: 'f', domain: 'CLI' }];
    expect(seedDomains(flow, seeds)).toEqual(['f']);
    expect(seedDomains(flow, seeds)).toEqual([]);
  });

  it('leaves prose and machine fields untouched', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'f.md'), LEGACY);
    seedFeatures(flow);
    writeFeature(flow, readFeatures(flow)[0], { anchors: ['module:src/x'], patchCount: 4 });

    seedDomains(flow, [{ slug: 'f', domain: 'CLI' }]);
    const after = readFeatures(flow)[0];
    expect(after.body).toBe(LEGACY);
    expect(after.anchors).toEqual(['module:src/x']);
    expect(after.patchCount).toBe(4);
  });

  it('--dry-run reports without writing', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'f.md'), LEGACY);
    seedFeatures(flow);
    const before = readFileSync(join(featuresDir(flow), 'f.md'), 'utf-8');
    expect(seedDomains(flow, [{ slug: 'f', domain: 'CLI' }], { dryRun: true })).toEqual(['f']);
    expect(readFileSync(join(featuresDir(flow), 'f.md'), 'utf-8')).toBe(before);
  });

  it('skips a slug that has no file, rather than creating one', () => {
    const flow = tempFlow();
    expect(seedDomains(flow, [{ slug: 'ghost', domain: 'CLI' }])).toEqual([]);
    expect(readFeatures(flow)).toEqual([]);
  });
});

// ── The `## Learned` section ────────────────────────────────────────────────
//
// The body is HUMAN-OWNED. Learn needs to write it, so the invariant moves
// rather than breaks: a machine-owned section inside an otherwise human file.
// The parser is the whole risk — a mis-detected boundary destroys prose nobody
// can recover, so ambiguity must REFUSE, never write anyway.

describe('splitLearned', () => {
  it('treats a file with no section as entirely human', () => {
    const body = '# Chats\n\nOwned by the platform team.\n';
    expect(splitLearned(body)).toEqual({ human: body, learned: null });
  });

  it('cuts at the heading, keeping the human region byte-for-byte', () => {
    const body = '# Chats\n\nDo not change the stream contract.\n\n## Learned\n\n- a <!-- learned: code 2026-08-03 -->\n';
    const split = splitLearned(body);
    expect(split.human).toBe('# Chats\n\nDo not change the stream contract.\n');
    expect(split.learned).toContain('- a <!-- learned: code 2026-08-03 -->');
  });

  it('does NOT treat a heading inside a code fence as the boundary', () => {
    // A doc explaining the format would otherwise have its example eaten.
    const body = '# Chats\n\n```md\n## Learned\n- not real\n```\n\nstill human\n';
    expect(splitLearned(body)).toEqual({ human: body, learned: null });
  });

  it('refuses a file carrying more than one section heading', () => {
    const body = '# X\n\n## Learned\n\n- a <!-- learned: code 2026-08-03 -->\n\n## Learned\n\n- b <!-- learned: code 2026-08-03 -->\n';
    expect(() => splitLearned(body)).toThrow(AmbiguousLearnedSectionError);
  });

  it('refuses when a code fence never closes — the boundary is unknowable', () => {
    const body = '# X\n\n```\n## Learned\n';
    expect(() => splitLearned(body)).toThrow(AmbiguousLearnedSectionError);
  });

  it('does not mistake a deeper heading for the boundary', () => {
    const body = '# X\n\n### Learned\n\nprose\n';
    expect(splitLearned(body).learned).toBeNull();
  });
});

describe('learning entries round-trip', () => {
  const entries: Learning[] = [
    { text: 'Reload can duplicate a completed turn', provenance: 'plan:chat-session-cache-rework', date: '2026-07-28' },
    { text: 'Redis pub/sub is server-side only', provenance: 'code', date: '2026-08-03' },
    { text: 'Owned by the platform team', provenance: 'human', date: '2026-01-01', pinned: true },
    { text: 'Redis fans out client-side', provenance: 'code', date: '2026-07-11', supersededReason: 'server-side handler added' },
  ];

  it('survives serialize → parse with every field intact', () => {
    const parsed = parseLearnings(serializeLearnings(entries));
    expect(parsed).toHaveLength(4);
    expect(parsed).toEqual(expect.arrayContaining(entries));
  });

  it('puts pinned first, then newest, and never interleaves superseded ones', () => {
    const rendered = serializeLearnings(entries);
    const order = parseLearnings(rendered).map((entry) => entry.text);
    expect(order[0]).toBe('Owned by the platform team'); // pinned
    expect(order[1]).toBe('Redis pub/sub is server-side only'); // newest current
    expect(order[order.length - 1]).toBe('Redis fans out client-side'); // superseded, last
    expect(rendered.indexOf('<!-- superseded -->')).toBeLessThan(rendered.indexOf('fans out client-side'));
  });

  it('retains a superseded learning WITH its reason — history is not rewritten', () => {
    const parsed = parseLearnings(serializeLearnings(entries));
    const gone = parsed.find((entry) => entry.text === 'Redis fans out client-side');
    expect(gone?.supersededReason).toBe('server-side handler added');
  });

  it('is empty for an absent section', () => {
    expect(parseLearnings(null)).toEqual([]);
  });

  it('flags hand-written content the writer would discard', () => {
    expect(hasUnparsedContent(serializeLearnings(entries))).toBe(false);
    expect(hasUnparsedContent('\n- a <!-- learned: code 2026-08-03 -->\n\nI added a note by hand.\n')).toBe(true);
  });
});

describe('writeLearned', () => {
  function seedFeature(body: string): { flowDir: string; filePath: string } {
    const flowDir = join(mkdtempSync(join(tmpdir(), 'fs-learned-')), 'flow');
    mkdirSync(featuresDir(flowDir), { recursive: true });
    const filePath = join(featuresDir(flowDir), 'chats.md');
    writeFileSync(filePath, `---\nid: feature:chats\nname: Chats\nkind: core\nanchors: [module:src/chat]\n---\n${body}`, 'utf-8');
    return { flowDir, filePath };
  }

  const one: Learning[] = [{ text: 'Stream id differs from persisted id', provenance: 'code', date: '2026-08-03' }];

  it('appends the section to a file that has none, preserving the human prose', () => {
    const { flowDir, filePath } = seedFeature('# Chats\n\nOwned by the platform team.\n');
    writeLearned(flowDir, 'chats', one);
    const after = readFileSync(filePath, 'utf-8');
    expect(after).toContain('Owned by the platform team.');
    expect(after).toContain(LEARNED_HEADING);
    expect(after).toContain('Stream id differs from persisted id');
  });

  it('replaces ONLY the section on a re-learn — human bytes are identical', () => {
    const human = '# Chats\n\nDo not change the stream contract without ACME review.\n';
    const { flowDir, filePath } = seedFeature(human);
    writeLearned(flowDir, 'chats', one);
    writeLearned(flowDir, 'chats', [{ text: 'A totally different learning', provenance: 'code', date: '2026-08-04' }]);
    const after = readFileSync(filePath, 'utf-8');
    expect(after).toContain('Do not change the stream contract without ACME review.');
    expect(after).toContain('A totally different learning');
    expect(after).not.toContain('Stream id differs from persisted id');
    // exactly one section survives — a second write must not stack headings
    expect(after.split(LEARNED_HEADING)).toHaveLength(2);
  });

  it('refuses a file whose section was hand-edited, rather than discarding the edit', () => {
    const { flowDir, filePath } = seedFeature('# Chats\n\nhuman\n\n## Learned\n\nI wrote this by hand and it matters.\n');
    const before = readFileSync(filePath, 'utf-8');
    expect(() => writeLearned(flowDir, 'chats', one)).toThrow(AmbiguousLearnedSectionError);
    expect(readFileSync(filePath, 'utf-8')).toBe(before); // nothing written
  });

  it('refuses an ambiguous boundary and leaves the file untouched', () => {
    const { flowDir, filePath } = seedFeature('# X\n\n## Learned\n\n- a <!-- learned: code 2026-08-03 -->\n\n## Learned\n\n- b <!-- learned: code 2026-08-03 -->\n');
    const before = readFileSync(filePath, 'utf-8');
    expect(() => writeLearned(flowDir, 'chats', one)).toThrow(AmbiguousLearnedSectionError);
    expect(readFileSync(filePath, 'utf-8')).toBe(before);
  });

  it('re-reads from disk, so a stale caller cannot clobber prose written since', () => {
    const { flowDir, filePath } = seedFeature('# Chats\n\noriginal\n');
    writeLearned(flowDir, 'chats', one);
    // someone edits the human region behind our back
    const edited = readFileSync(filePath, 'utf-8').replace('original', 'edited by a human');
    writeFileSync(filePath, edited, 'utf-8');
    writeLearned(flowDir, 'chats', [{ text: 'newer', provenance: 'code', date: '2026-08-05' }]);
    expect(readFileSync(filePath, 'utf-8')).toContain('edited by a human');
  });

  it('refuses to write learnings for a feature that does not exist', () => {
    const { flowDir } = seedFeature('# Chats\n');
    expect(() => writeLearned(flowDir, 'nope', one)).toThrow(/no feature 'nope'/);
  });

  it('keeps the frontmatter contract intact', () => {
    const { flowDir, filePath } = seedFeature('# Chats\n\nhuman\n');
    writeLearned(flowDir, 'chats', one);
    const node = parseFeatureFile('chats', readFileSync(filePath, 'utf-8'));
    expect(node.id).toBe('feature:chats');
    expect(node.anchors).toEqual(['module:src/chat']);
    expect(node.kind).toBe('core');
  });
});

// ── featureSummary ──────────────────────────────────────────────────────
//
// "coworkers · 2 anchors" tells a reader the scale of a thing whose purpose
// they still do not know. A card should say what the feature IS.

describe('featureSummary', () => {
  it('prefers a pinned learning — a human chose it', () => {
    const body = [
      '# Chats',
      '',
      '## Learned',
      '',
      '- Newest thing <!-- learned: code 2026-08-03 -->',
      '- The one that matters <!-- learned: human 2026-01-01 pinned -->',
      '',
    ].join('\n')
    expect(featureSummary(body)).toBe('The one that matters')
  })

  it('falls back to the newest current learning', () => {
    const body = [
      '# Chats', '', '## Learned', '',
      '- Older <!-- learned: code 2026-07-01 -->',
      '- Newer <!-- learned: code 2026-08-03 -->',
      '',
    ].join('\n')
    expect(featureSummary(body)).toBe('Newer')
  })

  it('never speaks with a superseded learning', () => {
    const body = [
      '# Chats', '', '## Learned', '',
      '- Was true once <!-- learned: code 2026-08-03 superseded: replaced -->',
      '- Still true <!-- learned: code 2026-01-01 -->',
      '',
    ].join('\n')
    expect(featureSummary(body)).toBe('Still true')
  })

  it('uses the lead prose when nothing is learned, stopping at the first section', () => {
    const body = [
      '# Chat Session Cache Rework',
      '',
      '**Project**: [[orbit-app]]',
      '**Status**: active',
      '',
      '## Links',
      '',
      '- Discovery: [[discovery_v1]]',
      '',
    ].join('\n')
    const summary = featureSummary(body)
    expect(summary).toBe('Project: orbit-app Status: active')
    expect(summary).not.toContain('##')
    expect(summary).not.toContain('[[')
    expect(summary).not.toContain('Discovery')
  })

  it('is empty for the bootstrap stub — provenance is not a description', () => {
    expect(featureSummary('# Home\n\nConfirmed from surface:e2e-suite+ui-route.\n')).toBe('')
  })

  it('is empty for a feature that says nothing', () => {
    expect(featureSummary('# Home\n')).toBe('')
  })

  it('is fail-soft on an ambiguous section boundary', () => {
    const body = '# X\n\nlead line\n\n## Learned\n\n- a <!-- learned: code 2026-08-03 -->\n\n## Learned\n\n- b <!-- learned: code 2026-08-03 -->\n'
    expect(() => featureSummary(body)).not.toThrow()
    expect(featureSummary(body)).toBe('lead line')
  })
})

// ── Writing edges: the refusal is the feature ───────────────────────────────
//
// A hallucinated feature id is WORSE than a missing edge. A missing edge costs
// the reader one search; an invented one is written into a tracked, shared file
// that reads exactly like recorded knowledge, and nobody ever re-derives it to
// find out it was never true. So the store — the only thing that knows which
// features exist — judges every target, and says why when it says no.

/** Seed a store with `slugs`, each a minimal feature file. */
function seedStore(slugs: readonly string[], bodies: Record<string, string> = {}): string {
  const flowDir = tempFlow();
  for (const slug of slugs) {
    const name = slug.charAt(0).toUpperCase() + slug.slice(1);
    writeFileSync(
      join(featuresDir(flowDir), `${slug}.md`),
      `---\nid: feature:${slug}\nname: ${name}\nkind: core\nanchors: []\nrelates: []\nlastFullRead: null\npatchCount: 0\n---\n${bodies[slug] ?? `# ${name}\n`}`,
      'utf-8',
    );
  }
  return flowDir;
}

describe('reviewEdges', () => {
  const known = new Set(['feature:playbooks', 'feature:skills']);

  it('accepts an edge naming a feature that exists', () => {
    const review = reviewEdges([{ target: 'feature:skills', via: 'binder.ts' }], known, 'feature:playbooks');
    expect(review.accepted).toEqual([{ target: 'feature:skills', via: 'binder.ts' }]);
    expect(review.refused).toEqual([]);
  });

  it('REFUSES a target no feature carries, and says why', () => {
    const review = reviewEdges([{ target: 'feature:skill-registry' }], known, 'feature:playbooks');
    expect(review.accepted).toEqual([]);
    expect(review.refused).toEqual([
      { target: 'feature:skill-registry', reason: UNKNOWN_TARGET_REASON },
    ]);
  });

  it('refuses a self-edge and an empty target, each with its own reason', () => {
    const review = reviewEdges(
      [{ target: 'feature:playbooks' }, { target: '  ' }],
      known,
      'feature:playbooks',
    );
    expect(review.accepted).toEqual([]);
    expect(review.refused.map((r) => r.reason)).toEqual([SELF_TARGET_REASON, EMPTY_TARGET_REASON]);
  });

  it('recognises a real feature written as a bare slug — that is not a hallucination', () => {
    const review = reviewEdges([{ target: 'skills' }], known, 'feature:playbooks');
    expect(review.accepted).toEqual([{ target: 'feature:skills' }]);
    // …but a bare slug for a feature that does not exist is still refused.
    expect(reviewEdges([{ target: 'skulls' }], known, 'feature:playbooks').refused).toEqual([
      { target: 'skulls', reason: UNKNOWN_TARGET_REASON },
    ]);
  });

  it('reports the target EXACTLY as proposed, so the refusal is checkable', () => {
    const review = reviewEdges([{ target: 'Feature:Skills' }], known, 'feature:playbooks');
    expect(review.refused[0].target).toBe('Feature:Skills');
  });
});

describe('writeEdges', () => {
  it('writes an accepted edge through the store, prose untouched', () => {
    const flowDir = seedStore(['playbooks', 'skills'], {
      playbooks: '# Playbooks\n\nOwned by the platform team.\n',
    });
    const result = writeEdges(flowDir, 'playbooks', [
      { target: 'feature:skills', via: 'src/playbooks/binder.ts', note: 'the binder resolves a skill slug' },
    ]);
    expect(result.refused).toEqual([]);
    const raw = readFileSync(join(featuresDir(flowDir), 'playbooks.md'), 'utf-8');
    expect(raw).toContain('Owned by the platform team.');
    const node = parseFeatureFile('playbooks', raw);
    expect(node.name).toBe('Playbooks');
    expect(node.relates).toEqual([
      { target: 'feature:skills', via: 'src/playbooks/binder.ts', note: 'the binder resolves a skill slug' },
    ]);
  });

  it('refuses an out-of-roster target and writes NOTHING for it', () => {
    const flowDir = seedStore(['playbooks', 'skills']);
    const result = writeEdges(flowDir, 'playbooks', [{ target: 'feature:skill-registry', note: 'invented' }]);
    expect(result.accepted).toEqual([]);
    expect(result.refused).toEqual([
      { target: 'feature:skill-registry', reason: UNKNOWN_TARGET_REASON },
    ]);
    const node = parseFeatureFile(
      'playbooks',
      readFileSync(join(featuresDir(flowDir), 'playbooks.md'), 'utf-8'),
    );
    expect(node.relates).toEqual([]);
  });

  it('one bad name never costs the good edges in the same batch', () => {
    const flowDir = seedStore(['playbooks', 'skills', 'chats']);
    const result = writeEdges(flowDir, 'playbooks', [
      { target: 'feature:skills', via: 'binder.ts' },
      { target: 'feature:nope' },
      { target: 'feature:chats', via: 'thread.ts' },
    ]);
    expect(result.accepted.map((edge) => edge.target)).toEqual(['feature:chats', 'feature:skills']);
    expect(result.refused).toHaveLength(1);
    expect(result.relates.map((edge) => edge.target)).toEqual(['feature:chats', 'feature:skills']);
  });

  it('refreshes an edge to the same target instead of stacking near-duplicates', () => {
    const flowDir = seedStore(['playbooks', 'skills']);
    writeEdges(flowDir, 'playbooks', [{ target: 'feature:skills', note: 'first reading' }]);
    const result = writeEdges(flowDir, 'playbooks', [{ target: 'feature:skills', note: 'a closer reading' }]);
    expect(result.relates).toEqual([{ target: 'feature:skills', note: 'a closer reading' }]);
  });

  it('keeps edges an earlier pass recorded to features it did not read', () => {
    // A pass reads ONE feature's files, so its view of the relationships is
    // partial by construction — replacing the list would delete real knowledge.
    const flowDir = seedStore(['playbooks', 'skills', 'chats']);
    writeEdges(flowDir, 'playbooks', [{ target: 'feature:chats', note: 'recorded earlier' }]);
    const result = writeEdges(flowDir, 'playbooks', [{ target: 'feature:skills', note: 'recorded now' }]);
    expect(result.relates).toEqual([
      { target: 'feature:chats', note: 'recorded earlier' },
      { target: 'feature:skills', note: 'recorded now' },
    ]);
  });

  it('never touches a human-owned field', () => {
    const flowDir = seedStore(['playbooks', 'skills']);
    const path = join(featuresDir(flowDir), 'playbooks.md');
    writeFileSync(
      path,
      readFileSync(path, 'utf-8')
        .replace('name: Playbooks', 'name: Runbooks')
        .replace('kind: core', 'kind: child'),
      'utf-8',
    );
    writeEdges(flowDir, 'playbooks', [{ target: 'feature:skills' }]);
    const node = parseFeatureFile('playbooks', readFileSync(path, 'utf-8'));
    expect(node.name).toBe('Runbooks');
    expect(node.kind).toBe('child');
  });

  it('refuses to write edges for a feature that does not exist', () => {
    const flowDir = seedStore(['playbooks']);
    expect(() => writeEdges(flowDir, 'nope', [{ target: 'feature:playbooks' }])).toThrow(
      /no feature 'nope'/,
    );
  });
});

// ── REGRESSION: "how do skills impact playbooks" ───────────────────────────
//
// The question that started this work, asked of a brain that could not answer
// it. `relates` was a bare `string[]` and empty in all 101 features across
// three projects, so the best the store could ever have said was "these two
// touch" — which sends the reader into BOTH features to find out how, and is
// why nobody bothered writing one.
//
// The test is deliberately shaped like the failure: it reads ONLY the
// Playbooks file. Skills is never opened, and the assertions are about whether
// the answer is present in what a reader of Playbooks actually has in front of
// them. THE NOTE IS WHAT MAKES THAT TRUE — a target and a via alone would still
// leave "so what?" to the reader.

describe('reading Playbooks answers "how do skills impact playbooks"', () => {
  const MECHANISM = 'src/playbooks/playbook_manifest_binder.ts';
  const NOTE =
    'a playbook step names a skill by slug; playbook_manifest_binder resolves it at authoring time, so a renamed skill breaks the playbook at bind time rather than at run time';

  function storeWithTheEdge(): string {
    const flowDir = seedStore(['playbooks', 'skills'], {
      playbooks: '# Playbooks\n\nSequenced steps a user runs against a project.\n',
      skills: '# Skills\n\nReusable instruction sets.\n',
    });
    writeEdges(flowDir, 'playbooks', [{ target: 'feature:skills', via: MECHANISM, note: NOTE }]);
    return flowDir;
  }

  it('answers the question from the Playbooks file alone — Skills is never opened', () => {
    const flowDir = storeWithTheEdge();
    const playbooksPath = join(featuresDir(flowDir), 'playbooks.md');
    const skillsPath = join(featuresDir(flowDir), 'skills.md');

    // ONLY this file is read. Anything the answer needs has to be in here.
    const playbooks = parseFeatureFile('playbooks', readFileSync(playbooksPath, 'utf-8'));
    const edge = playbooks.relates.find((candidate) => candidate.target === 'feature:skills');

    expect(edge).toBeDefined();
    // The three things a reader needs, in the order they need them: WHICH
    // capability, WHERE they meet, and HOW — the last one being the answer.
    expect(edge?.target).toBe('feature:skills');
    expect(edge?.via).toBe(MECHANISM);
    expect(edge?.note).toBe(NOTE);

    const answer = describeEdge(edge as FeatureEdge);
    expect(answer).toContain('feature:skills');
    expect(answer).toContain(MECHANISM);
    expect(answer).toContain('resolves it at authoring time');

    // The proof that it was answered WITHOUT the other feature: nothing in the
    // answer came from the Skills file, whose prose says something else entirely.
    expect(readFileSync(skillsPath, 'utf-8')).toContain('Reusable instruction sets.');
    expect(answer).not.toContain('Reusable instruction sets.');
  });

  it('the bare id — the rejected design — could not have answered it', () => {
    // The legacy form still parses (nothing fails to load), and this is exactly
    // what it can say: two capabilities touch, go read both.
    const bare = parseEdges('[feature:skills]');
    expect(bare).toEqual([{ target: 'feature:skills' }]);
    expect(describeEdge(bare[0])).toBe('feature:skills');
    expect(describeEdge(bare[0])).not.toContain('authoring time');
  });

  it('survives a round trip through the file — the answer is not a runtime artifact', () => {
    const flowDir = storeWithTheEdge();
    const path = join(featuresDir(flowDir), 'playbooks.md');
    const raw = readFileSync(path, 'utf-8');
    // It is IN the markdown, readable by a human or an agent with a grep.
    expect(raw).toContain(`via: ${MECHANISM}`);
    expect(raw).toContain('resolves it at authoring time');
    // …and byte-stable: re-serializing the parsed file changes nothing, so a
    // tracked feature file never churns just for having been read.
    expect(serializeFeature(parseFeatureFile('playbooks', raw))).toBe(raw);
  });
});

describe('home: — a person-owned key (plan feature-home-folders, phase 2)', () => {
  const NOTE = [
    '---',
    'id: feature:chats',
    'name: Chats',
    'kind: core',
    'anchors: [module:src/app/chat]',
    'relates: []',
    'lastFullRead: null',
    'patchCount: 0',
    'home: src/components/chat',
    'zeta: keep me',
    '---',
    '# Chats',
    '',
    'Prose.',
    '',
    '## Parts',
    '',
    '### Live stream',
    'The SSE half.',
    'anchors: src/lib/sse.ts',
    'home: src/lib',
    '',
    '### List',
    'anchors: src/components/chat/list',
    '',
  ].join('\n');

  function seeded(): string {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'chats.md'), NOTE);
    return flow;
  }

  it('reads a feature\'s home from its frontmatter and a part\'s from its entry', () => {
    const flow = seeded();
    const [chats] = readFeatures(flow);
    expect(featureHome(chats)).toBe('src/components/chat');
    expect(chats.extra.home).toBe('src/components/chat');
    expect(readParts(flow, 'chats').map((part) => part.home)).toEqual(['src/lib', undefined]);
    // A home line is not the part's summary.
    expect(readParts(flow, 'chats')[0].summary).toBe('The SSE half.');
  });

  it('reads blank, `null` and quoted values the way a person meant them', () => {
    expect(homeValueOf(undefined)).toBeNull();
    expect(homeValueOf('  ')).toBeNull();
    expect(homeValueOf('null')).toBeNull();
    expect(homeValueOf('"src/a b"')).toBe('src/a b');
  });

  it('survives every machine write: anchors, learnings, parts, reclass and domain seeding', () => {
    const flow = seeded();
    writeFeature(flow, readFeatures(flow)[0], { anchors: ['module:src/elsewhere'], patchCount: 3 });
    writeLearned(flow, 'chats', [{ text: 'It streams.', provenance: 'code', date: '2026-10-07' }]);
    reclassFeatures(flow, [{ slug: 'chats', kind: 'core' }]);
    seedDomains(flow, [{ slug: 'chats', domain: 'Chat' }]);
    const [after] = readFeatures(flow);
    expect(after.anchors).toEqual(['module:src/elsewhere']); // the writes did land
    expect(featureHome(after)).toBe('src/components/chat');
  });

  it('keeps a part\'s home through `writeParts`, ignoring whatever home the caller passed', () => {
    const flow = seeded();
    writeParts(flow, 'chats', [
      { name: 'Live stream', summary: 'Rewritten.', anchors: ['src/lib/sse.ts'], learnings: [], home: 'src/hijack' },
      { name: 'List', summary: '', anchors: ['src/components/chat/list'], learnings: [], home: 'src/hijack' },
    ]);
    const parts = readParts(flow, 'chats');
    expect(parts[0].summary).toBe('Rewritten.'); // the write did land
    expect(parts.map((part) => part.home)).toEqual(['src/lib', undefined]);
  });

  it('round-trips a part\'s home through serialize and parse', () => {
    const parts = parseParts(splitParts(NOTE.split('---\n')[2]).parts);
    expect(parseParts(serializeParts(parts))).toEqual(parts);
  });

  describe('setHomeInText — one line changes, every other byte stays', () => {
    it('replaces, clears and adds a feature\'s home in place', () => {
      const replaced = setHomeInText(NOTE, { kind: 'feature' }, 'src/components/chat/v2');
      expect(replaced.previous).toBe('src/components/chat');
      expect(replaced.text).toBe(NOTE.replace('home: src/components/chat\n', 'home: src/components/chat/v2\n'));

      const cleared = setHomeInText(NOTE, { kind: 'feature' }, null);
      expect(cleared.text).toBe(NOTE.replace('home: src/components/chat\n', ''));

      const added = setHomeInText(cleared.text, { kind: 'feature' }, 'src/x');
      expect(added.previous).toBeNull();
      expect(added.text).toBe(cleared.text.replace('zeta: keep me\n---', 'zeta: keep me\nhome: src/x\n---'));
    });

    it('keeps CRLF line ends, comments and key order', () => {
      const crlf = '---\r\n# a comment\r\nkind: core\r\nname: X\r\n---\r\nBody\r\n';
      const added = setHomeInText(crlf, { kind: 'feature' }, 'src/x');
      expect(added.text).toBe('---\r\n# a comment\r\nkind: core\r\nname: X\r\nhome: src/x\r\n---\r\nBody\r\n');
      expect(setHomeInText(added.text, { kind: 'feature' }, null).text).toBe(crlf);
    });

    it('gives a note with no frontmatter one holding only the home', () => {
      const added = setHomeInText(LEGACY, { kind: 'feature' }, 'src/sim');
      expect(added.text).toBe(`---\nhome: src/sim\n---\n${LEGACY}`);
      expect(parseFeatureFile('blueprint-simulation', added.text).body).toBe(LEGACY);
    });

    it('edits a part\'s entry by its address — below its anchors, or replacing its own line', () => {
      const target = { kind: 'part' as const, featureId: 'feature:chats', partId: 'feature:chats/list' };
      const added = setHomeInText(NOTE, target, 'src/components/chat/list');
      expect(added.text).toBe(
        NOTE.replace('anchors: src/components/chat/list\n', 'anchors: src/components/chat/list\nhome: src/components/chat/list\n'),
      );
      const stream = { kind: 'part' as const, featureId: 'feature:chats', partId: 'feature:chats/live-stream' };
      const moved = setHomeInText(NOTE, stream, 'src/lib/sse');
      expect(moved.previous).toBe('src/lib');
      expect(moved.text).toBe(NOTE.replace('home: src/lib\n', 'home: src/lib/sse\n'));
      // The feature's own home line is not a part's.
      expect(moved.text).toContain('home: src/components/chat\n');
    });

    it('reports a part it cannot find and changes nothing', () => {
      const missing = setHomeInText(NOTE, { kind: 'part', featureId: 'feature:chats', partId: 'feature:chats/nope' }, 'src');
      expect(missing).toEqual({ text: NOTE, previous: null, found: false });
    });
  });

  it('writeFeatureHome writes through the store and refuses an unknown part', () => {
    const flow = seeded();
    expect(writeFeatureHome(flow, 'chats', { kind: 'feature' }, 'src/app')).toEqual({ previous: 'src/components/chat' });
    expect(featureHome(readFeatures(flow)[0])).toBe('src/app');
    expect(() =>
      writeFeatureHome(flow, 'chats', { kind: 'part', featureId: 'feature:chats', partId: 'feature:chats/nope' }, 'src'),
    ).toThrow(/no part/);
    expect(() => writeFeatureHome(flow, 'ghost', { kind: 'feature' }, 'src')).toThrow(/no feature/);
  });
});
