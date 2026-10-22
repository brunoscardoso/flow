/**
 * `blueprint features role` — the one writer of the learn-owned `learnedRole:`
 * (plan `feature-type-icons`, phase 2). Every refusal is asserted on its
 * transcript AND on the note being byte-identical afterwards (allowed-pattern
 * #24), and every write on the person's `role:` line being left as it was.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runFeatureRoleVerb, type FeatureRoleVerbInput } from './feature-learned-role.js';
import { featureLearnedRole, featureRole, featuresDir, readFeatures, readParts } from './feature-store.js';

const NOTE = [
  '---',
  'id: feature:chats',
  'name: Chats',
  'kind: core',
  '# a comment a person left',
  'anchors: [module:src/app/chat]',
  'relates: []',
  'lastFullRead: null',
  'patchCount: 0',
  'role: ui',
  '---',
  '# Chats',
  '',
  '## Parts',
  '',
  '### Live stream',
  'anchors: src/lib/sse.ts',
  'role: api',
  '',
  '### List',
  'anchors: src/components/chat/list',
  'learnedRole: ui',
  '',
].join('\n');

function project(): { repo: string; notePath: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'feature-role-')));
  const flow = join(repo, 'flow');
  mkdirSync(featuresDir(flow), { recursive: true });
  const notePath = join(featuresDir(flow), 'chats.md');
  writeFileSync(notePath, NOTE);
  return { repo, notePath };
}

/** The JSON payload line of a transcript (the last parseable `{` line). */
function payloadOf(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

describe('features role — writing', () => {
  it('records a feature\'s learned role, adding exactly one line and keeping the person\'s role', () => {
    const { repo, notePath } = project();
    const out = runFeatureRoleVerb({ repoRoot: repo, feature: 'chats', learned: 'Service', json: true });
    expect(out.exitCode).toBe(0);
    expect(payloadOf(out.stdout)).toEqual({
      action: 'features-role',
      feature: 'chats',
      part: null,
      learnedRole: 'service',
      previous: null,
    });
    expect(readFileSync(notePath, 'utf-8')).toBe(NOTE.replace('role: ui\n---', 'role: ui\nlearnedRole: service\n---'));
    const [chats] = readFeatures(join(repo, 'flow'));
    expect([featureRole(chats), featureLearnedRole(chats)]).toEqual(['ui', 'service']);
  });

  it('records a part\'s learned role by its address or by --part, replacing a learned one in place', () => {
    const { repo, notePath } = project();
    const byAddress = runFeatureRoleVerb({ repoRoot: repo, feature: 'feature:chats/live-stream', learned: 'jobs' });
    expect(byAddress).toEqual({ exitCode: 0, stdout: 'features: feature:chats/live-stream — learned role is jobs\n' });
    const byName = runFeatureRoleVerb({ repoRoot: repo, feature: 'chats', part: 'List', learned: 'data', json: true });
    expect(payloadOf(byName.stdout)).toMatchObject({ part: 'feature:chats/list', learnedRole: 'data', previous: 'ui' });
    expect(readFileSync(notePath, 'utf-8')).toBe(
      NOTE.replace('anchors: src/lib/sse.ts\n', 'anchors: src/lib/sse.ts\nlearnedRole: jobs\n').replace(
        'learnedRole: ui\n',
        'learnedRole: data\n',
      ),
    );
    const parts = readParts(join(repo, 'flow'), 'chats');
    expect(parts.map((part) => [part.role, part.learnedRole])).toEqual([
      ['api', 'jobs'],
      [undefined, 'data'],
    ]);
  });
});

describe('features role — refusing, writing nothing', () => {
  const cases: Array<[string, Omit<FeatureRoleVerbInput, 'repoRoot'>, string]> = [
    ['a role off the list', { feature: 'chats', learned: 'widget' }, 'role'],
    ['no --learned', { feature: 'chats' }, 'arguments'],
    ['no --feature', { learned: 'ui' }, 'arguments'],
    ['an unknown feature', { feature: 'ghost', learned: 'ui' }, 'unknown-feature'],
    ['an unknown part', { feature: 'chats', part: 'Nope', learned: 'ui' }, 'unknown-part'],
    ['--part on a part address', { feature: 'feature:chats/list', part: 'List', learned: 'ui' }, 'arguments'],
  ];

  it.each(cases)('refuses %s', (_label, input, reason) => {
    const { repo, notePath } = project();
    const out = runFeatureRoleVerb({ repoRoot: repo, ...input });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain(`features refused: ${reason} — `);
    expect(payloadOf(out.stdout)).toMatchObject({ action: 'features-role', refused: reason });
    expect(readFileSync(notePath, 'utf-8')).toBe(NOTE);
  });

  it('names the list when it refuses a role', () => {
    const { repo } = project();
    const out = runFeatureRoleVerb({ repoRoot: repo, feature: 'chats', learned: 'widget' });
    expect(payloadOf(out.stdout)?.roles).toContain('integration');
  });
});
