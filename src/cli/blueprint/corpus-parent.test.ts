import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { codeVote, declaredFeatureOf, docPaths, linkCorpusDoc, ownerOf, type CorpusOwner } from './corpus-parent.js';
import { discoverFeatures } from './feature-discover.js';
import { parseFeatureFile, type FeatureNode } from './feature-store.js';
import { canonicalKey } from './feature-surfaces.js';

const owners: CorpusOwner[] = [
  { slug: 'auth', paths: ['src/app/api/auth', 'src/utils/tokenManager.ts'] },
  { slug: 'chats', paths: ['src/app/api/chat', 'src/components/chat'] },
];
// Keyed exactly as `discoverFeatures` keys them.
const coreKeys = ['auth', 'chats'].map(canonicalKey);
const coreSlugByKey = new Map(['auth', 'chats'].map((slug) => [canonicalKey(slug), slug] as const));

function link(slug: string, markdown: string, proposalPaths: string[] = []) {
  return linkCorpusDoc({ slug, markdown, proposalPaths, anchors: [], coreKeys, coreSlugByKey, owners });
}

describe('declared feature line', () => {
  it('reads the bold forms and drops backticks', () => {
    expect(declaredFeatureOf('# Plan\n\n**Feature**: `auth`\n')).toBe('auth');
    expect(declaredFeatureOf('- **Feature:** chats\n')).toBe('chats');
    expect(declaredFeatureOf('# Plan\nno line here\n')).toBeNull();
  });

  it('wins over the name and the code, and resolves a feature id', () => {
    const doc = '**Feature**: feature:lumen-app::chats\n`src/app/api/auth/a.ts` `src/app/api/auth/b.ts`';
    expect(link('auth_rework', doc)).toEqual({ featureSlug: 'chats', source: 'declared' });
  });

  it('treats none as an answer that stops the guesses', () => {
    const doc = '**Feature**: none\n`src/app/api/auth/a.ts` `src/app/api/auth/b.ts`';
    expect(link('auth_rework', doc)).toEqual({ featureSlug: null, source: 'declared' });
  });

  it('falls through when the declared slug is unknown', () => {
    expect(link('auth_rework', '**Feature**: billing\n')).toEqual({ featureSlug: 'auth', source: 'name' });
  });
});

describe('the code vote', () => {
  it('links a ticket-named doc by the files it names', () => {
    const doc = 'Touches `src/app/api/auth/mobile/login/route.ts:12-40` and src/utils/tokenManager.ts.';
    expect(link('sec_3226_secure_login', doc)).toEqual({ featureSlug: 'auth', source: 'code' });
  });

  it('counts the files a plan predicted through proposals', () => {
    expect(link('aai_2866', 'no paths', ['src/components/chat/A.tsx', 'src/app/api/chat/route.ts'])).toEqual({
      featureSlug: 'chats',
      source: 'code',
    });
  });

  it('leaves a single owned file unlinked', () => {
    expect(link('aai_1', '`src/app/api/auth/a.ts` `README.md`')).toEqual({ featureSlug: null, source: null });
  });

  it('leaves a tie unlinked', () => {
    expect(codeVote(['src/app/api/auth/a', 'src/app/api/auth/b', 'src/app/api/chat/a', 'src/app/api/chat/b'], owners)).toBeNull();
  });

  it('prefers the longest owned prefix and never matches a sibling name', () => {
    const nested: CorpusOwner[] = [
      { slug: 'chats', paths: ['src/app'] },
      { slug: 'auth', paths: ['src/app/api/auth'] },
    ];
    expect(ownerOf('src/app/api/auth/route.ts', nested)).toBe('auth');
    expect(ownerOf('src/app/api/authority.ts', nested)).toBe('chats');
    expect(ownerOf('lib/x.ts', nested)).toBeNull();
  });

  it('pulls repo paths out of prose and strips line suffixes', () => {
    expect(docPaths('see `./src/a/b.ts:10-20`, then src/c/d.ts. https://x.io/y')).toEqual(['src/a/b.ts', 'src/c/d.ts']);
  });
});

describe('discoverFeatures links docs through parts', () => {
  it('parents a ticket-named discovery under the core whose part owns its files', () => {
    const flow = mkdtempSync(join(tmpdir(), 'corpus-parent-'));
    for (const sub of ['plans', 'discovery', 'archive', 'brain/features']) mkdirSync(join(flow, sub), { recursive: true });
    writeFileSync(
      join(flow, 'brain/features/auth.md'),
      '---\nid: feature:auth\nkind: core\nanchors: [module:src/app/auth]\n---\n# Feature: Auth\n\n## Parts\n\n### Token manager\nRefreshes tokens.\nanchors: src/utils/tokenManager.ts, src/lib/session.ts\n',
    );
    writeFileSync(
      join(flow, 'discovery/discovery_sec_3226_v1.md'),
      '# Discovery: SEC-3226\n\nChanges `src/utils/tokenManager.ts` and `src/lib/session.ts`.\n',
    );
    const auth: FeatureNode = { ...parseFeatureFile('auth', '# Feature: Auth\n'), kind: 'core', anchors: ['module:src/app/auth'] };
    const result = discoverFeatures(flow, [auth], null, flow);
    // The positive first: the doc was walked and is in the index at all.
    expect(result.corpusDocs.map((doc) => doc.path)).toEqual(['flow/discovery/discovery_sec_3226_v1.md']);
    expect(result.corpusDocs[0].featureSlug).toBe('auth');
    expect(result.corpusLinks).toMatchObject({ docs: 1, code: 1, unlinked: 0 });
  });
});
