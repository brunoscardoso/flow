/**
 * `blueprint features home` — the one writer of the person-owned `home:`
 * (plan `feature-home-folders`, phase 2). Every refusal is asserted on its
 * transcript AND on the note being byte-identical afterwards (allowed-pattern
 * #24): a loud refusal that writes anyway is the failure this guards.
 */
import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runFeatureHomeVerb } from './feature-home.js';
import { featureHome, featuresDir, readFeatures, readParts } from './feature-store.js';

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
  '---',
  '# Chats',
  '',
  '## Parts',
  '',
  '### Live stream',
  'anchors: src/lib/sse.ts',
  '',
].join('\n');

function project(): { repo: string; notePath: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'feature-home-')));
  mkdirSync(join(repo, 'src', 'components', 'chat'), { recursive: true });
  mkdirSync(join(repo, 'src', 'lib'), { recursive: true });
  writeFileSync(join(repo, 'src', 'lib', 'sse.ts'), 'export {}\n');
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

describe('features home — writing', () => {
  it('pins a feature\'s home, changing only that one line', () => {
    const { repo, notePath } = project();
    const out = runFeatureHomeVerb({ repoRoot: repo, feature: 'chats', folder: './src/components/chat/', json: true });
    expect(out.exitCode).toBe(0);
    expect(payloadOf(out.stdout)).toEqual({
      action: 'features-home',
      feature: 'chats',
      part: null,
      home: 'src/components/chat',
      previous: null,
    });
    expect(readFileSync(notePath, 'utf-8')).toBe(NOTE.replace('patchCount: 0\n---', 'patchCount: 0\nhome: src/components/chat\n---'));
    expect(featureHome(readFeatures(join(repo, 'flow'))[0])).toBe('src/components/chat');
  });

  it('pins a part\'s home on its own entry, by the address the board hands out', () => {
    const { repo, notePath } = project();
    const out = runFeatureHomeVerb({ repoRoot: repo, feature: 'feature:chats/live-stream', folder: 'src/lib' });
    expect(out).toEqual({ exitCode: 0, stdout: 'features: feature:chats/live-stream — home is src/lib\n' });
    expect(readFileSync(notePath, 'utf-8')).toBe(NOTE.replace('anchors: src/lib/sse.ts\n', 'anchors: src/lib/sse.ts\nhome: src/lib\n'));
    expect(readParts(join(repo, 'flow'), 'chats')[0].home).toBe('src/lib');
  });

  it('clears a pin back to the note it was', () => {
    const { repo, notePath } = project();
    runFeatureHomeVerb({ repoRoot: repo, feature: 'chats', folder: 'src/lib' });
    const out = runFeatureHomeVerb({ repoRoot: repo, feature: 'chats', clear: true });
    expect(out).toEqual({ exitCode: 0, stdout: 'features: chats — home cleared (was src/lib)\n' });
    expect(readFileSync(notePath, 'utf-8')).toBe(NOTE);
  });
});

describe('features home — refusals carry their payload and write nothing', () => {
  const cases: Array<[string, { feature?: string; folder?: string; clear?: boolean }, string, Record<string, unknown>]> = [
    ['no feature', { folder: 'src/lib' }, 'arguments', {}],
    ['both --folder and --clear', { feature: 'chats', folder: 'src/lib', clear: true }, 'arguments', { feature: 'chats' }],
    ['neither --folder nor --clear', { feature: 'chats' }, 'arguments', { feature: 'chats' }],
    ['an unknown feature', { feature: 'ghost', folder: 'src/lib' }, 'unknown-feature', { feature: 'ghost' }],
    ['an unknown part', { feature: 'feature:chats/ghost', folder: 'src/lib' }, 'unknown-feature', { feature: 'feature:chats/ghost' }],
    ['an absolute path', { feature: 'chats', folder: '/etc' }, 'outside-project', { folder: '/etc' }],
    ['a path climbing out', { feature: 'chats', folder: 'src/../../x' }, 'outside-project', { folder: 'src/../../x' }],
    ['the project itself', { feature: 'chats', folder: '.' }, 'outside-project', { folder: '.' }],
    ['a folder that is not there', { feature: 'chats', folder: 'src/components/gone/deeper' }, 'missing-folder', {
      folder: 'src/components/gone/deeper',
      nearest: 'src/components',
    }],
    ['a file', { feature: 'chats', folder: 'src/lib/sse.ts' }, 'not-a-folder', { folder: 'src/lib/sse.ts', nearest: 'src/lib' }],
  ];

  it.each(cases)('refuses %s', (_label, flags, reason, payload) => {
    const { repo, notePath } = project();
    const out = runFeatureHomeVerb({ repoRoot: repo, ...flags });
    expect(out.exitCode).toBe(1);
    expect(payloadOf(out.stdout)).toEqual({ action: 'features-home', refused: reason, ...payload });
    expect(out.stdout).toMatch(new RegExp(`\\nfeatures refused: ${reason} — .+\\n$`));
    expect(readFileSync(notePath, 'utf-8')).toBe(NOTE);
  });

  it('refuses a folder that leads outside the project through a symlink', () => {
    const { repo, notePath } = project();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'feature-home-outside-')));
    symlinkSync(outside, join(repo, 'src', 'escape'));
    const out = runFeatureHomeVerb({ repoRoot: repo, feature: 'chats', folder: 'src/escape' });
    expect(out.exitCode).toBe(1);
    expect(payloadOf(out.stdout)).toMatchObject({ refused: 'outside-project', folder: 'src/escape' });
    expect(readFileSync(notePath, 'utf-8')).toBe(NOTE);
  });
});

describe('features home — through the command', () => {
  it('is dispatched by `blueprint features home`', async () => {
    const { repo, notePath } = project();
    const { runBlueprint } = await import('../commands/blueprint.js');
    const writes: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const previousCwd = process.cwd();
    const previousExit = process.exitCode;
    try {
      process.chdir(repo);
      await runBlueprint('features', 'home', { feature: 'chats', folder: 'src/lib', json: true });
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.chdir(previousCwd);
      spy.mockRestore();
      process.exitCode = previousExit;
    }
    expect(payloadOf(writes.join(''))).toMatchObject({ action: 'features-home', home: 'src/lib' });
    expect(readFileSync(notePath, 'utf-8')).toContain('home: src/lib\n');
  });
});
