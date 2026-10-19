/**
 * Capability-surface mining.
 *
 * The fixture is a miniature of the real Next.js product this was built
 * against: page routes, API routes, an e2e suite dir, plumbing that must NOT
 * be mistaken for a capability, and a nested leaf that belongs to a feature
 * rather than beside it.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalKey, mineSurfaces, parentKeyFor } from './feature-surfaces.js';

function repoWith(dirs: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'surfaces-'));
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

/** Mirrors the shape that motivated the whole module. */
const PRODUCT = [
  // pages
  'src/app/app/(protected)/playbooks',
  'src/app/app/(protected)/playbooks/import-summary',
  'src/app/app/(protected)/chats/[chatId]',
  'src/app/app/(protected)/spaces',
  'src/app/app/(protected)/settings',
  // api
  'src/app/api/chat',
  'src/app/api/playbooks',
  'src/app/api/spaces',
  'src/app/api/telemetry',
  'src/app/api/blob',
  'src/app/api/playbooks/import-summary',
  // tests
  'e2e/tests/playbooks',
  'e2e/tests/chats',
  'e2e/tests/navigation',
];

describe('mineSurfaces', () => {
  it('names capabilities the repo declares in more than one plane', () => {
    const found = mineSurfaces(repoWith(PRODUCT)).map((candidate) => candidate.name);
    expect(found).toContain('Playbooks');
    expect(found).toContain('Chats');
    expect(found).toContain('Spaces');
  });

  it('fuses singular and plural spellings into ONE capability', () => {
    // `api/chat` + `app/chats` + `e2e/tests/chats` is one feature, not two.
    const chats = mineSurfaces(repoWith(PRODUCT)).filter((c) => c.key === 'chat');
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Chats'); // the repo's own majority spelling
    expect(new Set(chats[0].signals.map((s) => s.kind)).size).toBe(3);
  });

  it('rejects plumbing — one API route is not a capability', () => {
    const found = mineSurfaces(repoWith(PRODUCT)).map((c) => c.key);
    expect(found).not.toContain('telemetry');
    expect(found).not.toContain('blob');
  });

  it('rejects a name seen in only ONE plane, however often', () => {
    // Two page routes, no api and no test → still one plane.
    const found = mineSurfaces(repoWith(['src/app/app/reports', 'src/app/app/admin/reports']));
    expect(found).toEqual([]);
  });

  it('demotes a leaf nested inside a stronger capability', () => {
    // `playbooks/import-summary` clears the two-plane rule on its own, but it
    // is part of Playbooks — a peer card for it is noise.
    const found = mineSurfaces(repoWith(PRODUCT)).map((c) => c.key);
    expect(found).toContain('playbook');
    expect(found).not.toContain('import-summary');
  });

  it('ignores route groups, dynamic params and private segments', () => {
    const found = mineSurfaces(repoWith(PRODUCT)).map((c) => c.key);
    expect(found).not.toContain('protected');
    expect(found).not.toContain('chatid');
  });

  it('anchors each capability to the directories that named it', () => {
    const playbooks = mineSurfaces(repoWith(PRODUCT)).find((c) => c.key === 'playbook');
    expect(playbooks?.anchors).toContain('module:e2e/tests/playbooks');
    expect(playbooks?.anchors).toContain('module:src/app/api/playbooks');
  });

  it('is deterministic — same repo yields deep-equal output', () => {
    const root = repoWith(PRODUCT);
    expect(mineSurfaces(root)).toEqual(mineSurfaces(root));
  });

  it('finds nothing in a repo with no surface conventions, rather than guessing', () => {
    expect(mineSurfaces(repoWith(['src/cli/commands', 'src/utils']))).toEqual([]);
  });

  it('reads conventional feature roots', () => {
    const root = repoWith([
      'src/features/billing',
      'src/features/onboarding',
      'e2e/tests/billing',
    ]);
    expect(mineSurfaces(root).map((c) => c.key)).toEqual(['billing']);
  });
});

describe('canonicalKey', () => {
  it('singularizes per word so plural drift never splits a feature', () => {
    expect(canonicalKey('knowledge-hubs')).toBe('knowledge-hub');
    expect(canonicalKey('chats')).toBe('chat');
    expect(canonicalKey('policies')).toBe('policy');
  });

  it('leaves words that merely end in s alone', () => {
    expect(canonicalKey('status')).toBe('status');
    expect(canonicalKey('access')).toBe('access');
  });
});

describe('parentKeyFor', () => {
  const CORES = ['chat', 'knowledge-hub', 'space'];

  it('parents a change-shaped name to the capability it names', () => {
    expect(parentKeyFor('chat-session-cache-rework', CORES)).toBe('chat');
    expect(parentKeyFor('spaces-admin-guard-acme-2204', CORES)).toBe('space');
  });

  it('prefers the LONGEST matching capability', () => {
    expect(parentKeyFor('knowledge-hub-availability', ['hub', 'knowledge-hub'])).toBe('knowledge-hub');
  });

  it('matches whole tokens only — shared letters are not kinship', () => {
    expect(parentKeyFor('chatter-box-rewrite', ['chat'])).toBeNull();
  });

  it('returns null when nothing matches, rather than guessing a parent', () => {
    expect(parentKeyFor('deprecate-workflows', CORES)).toBeNull();
  });
});
