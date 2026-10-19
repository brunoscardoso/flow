import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverFeatures } from './feature-discover.js';
import { featuresDir, readFeatures, seedFeatures, writeFeature } from './feature-store.js';

/**
 * The guarantee this whole layer rests on: discovery has NO confirmation gate,
 * so editing a feature file IS the correction mechanism. If a sweep can quietly
 * revert a boundary someone fixed by hand, the design is unsafe — every brief
 * hanging off that node inherits the error and nothing reports it.
 *
 * This exercises the FULL lifecycle against one hand-edited file, rather than
 * testing each step in isolation where the interaction is exactly what breaks.
 */
function tempFlow(): string {
  const dir = mkdtempSync(join(tmpdir(), 'feat-life-'));
  mkdirSync(featuresDir(dir), { recursive: true });
  for (const sub of ['plans', 'discovery', 'archive']) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

/** Exactly how brain-capture writes a feature today: no frontmatter. */
const LEGACY = `# Feature: Auth

**Status:** shipped

## What

Sessions, tokens, and the refresh dance.

## Why it is like this

Because the token store predates the session store — do not "fix" that.
`;

/** Mirror the store's own split so the assertion tests the STORE, not this helper. */
function bodyOf(raw: string): string {
  if (!raw.startsWith('---\n')) return raw;
  const end = raw.indexOf('\n---\n', 3);
  return end === -1 ? raw : raw.slice(end + 5);
}

describe('the full lifecycle preserves human prose', () => {
  it('survives seed → hand-edit → discover with the body byte-identical', () => {
    const flow = tempFlow();
    const file = join(featuresDir(flow), 'auth.md');
    writeFileSync(file, LEGACY);
    // A plan that names the same feature, so discovery MATCHES rather than stages.
    writeFileSync(
      join(flow, 'plans', 'plan_auth_v1.md'),
      '## Story\n\n### Step: S\n- anchors: src/auth/session.ts, src/auth/token.ts\n',
    );

    // 1. SEED — adopt in place.
    expect(seedFeatures(flow)).toEqual(['auth']);
    expect(bodyOf(readFileSync(file, 'utf-8'))).toBe(LEGACY);

    // 2. HAND EDIT — a human renames it, re-kinds it, and rewrites the prose.
    const edited = readFileSync(file, 'utf-8')
      .replace('name: Auth', 'name: Auth & Sessions')
      .replace('kind: core', 'kind: child')
      .replace('Sessions, tokens, and the refresh dance.', 'MY OWN WORDS — do not touch.');
    writeFileSync(file, edited);
    const humanBody = bodyOf(edited);

    // 3. DISCOVER — a sweep runs and updates anchors.
    const result = discoverFeatures(flow, readFeatures(flow), null);
    expect(result.candidates).toEqual([]); // matched, not re-proposed
    for (const update of result.updated) writeFeature(flow, update.feature, { anchors: update.anchors });

    let after = readFeatures(flow)[0];
    expect(after.name).toBe('Auth & Sessions'); // rename survived a sweep
    expect(after.kind).toBe('child'); // human field survived
    expect(bodyOf(readFileSync(file, 'utf-8'))).toBe(humanBody); // prose survived
    expect(after.anchors).toEqual(['file:src/auth/session.ts', 'file:src/auth/token.ts']);

    // 4. A SECOND MACHINE WRITE — the sweep runs again over its own output.
    // Idempotence is the real guarantee here: repeated machine writes must keep
    // converging on the same human-owned fields, not erode them one pass at a
    // time.
    writeFeature(flow, after, { anchors: after.anchors });
    after = readFeatures(flow)[0];
    expect(after.name).toBe('Auth & Sessions');
    expect(after.kind).toBe('child');
    expect(bodyOf(readFileSync(file, 'utf-8'))).toBe(humanBody);
  });

  it('a DELETED feature is not resurrected by the next sweep', () => {
    // Deleting the file is how a human says "that was not a feature". A sweep
    // may re-propose it as a CANDIDATE, but must never re-author the file.
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'plan_ghost_v1.md'), '## Story\n\n### Step: S\n- anchors: src/x.ts\n');
    const result = discoverFeatures(flow, [], null);
    expect(result.candidates.map((c) => c.slug)).toEqual(['ghost']);
    expect(result.updated).toEqual([]);
    expect(readFeatures(flow)).toEqual([]); // nothing authored
  });

  it('an unreadable file never hides the rest of the store', () => {
    const flow = tempFlow();
    writeFileSync(join(featuresDir(flow), 'good.md'), '# Feature: Good\n');
    writeFileSync(join(featuresDir(flow), 'weird.md'), '---\nunterminated frontmatter\n');
    const features = readFeatures(flow);
    expect(features.map((f) => f.slug).sort()).toEqual(['good', 'weird']);
  });
});
