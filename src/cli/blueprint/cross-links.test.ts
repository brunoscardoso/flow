import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutboundFile } from './extractors/outbound.js';
import type { ProjectSurface } from './surface.js';
import {
  appendCrossLinkEvents,
  baseNamesSibling,
  crossDriftItems,
  matchAgainstSurface,
  readCrossLinks,
  consumerStillCalls,
  reconcileCrossLinks,
} from './cross-links.js';

const surface = (over: Partial<ProjectSurface> = {}): ProjectSurface => ({
  version: 1,
  project: 'orbit-core',
  repoPath: '/repos/orbit-core',
  derivedAt: '2026-07-24T10:00:00.000Z',
  endpoints: [
    { method: 'GET', path: '/api/v1/agents/stream' },
    { method: 'POST', path: '/v1/tenants' },
  ],
  graphqlOperations: [{ operation: 'query', name: 'GetTenants' }],
  graphHash: 'abc',
  ...over,
});

const outbound = (over: Partial<OutboundFile> = {}): OutboundFile => ({
  version: 1,
  extractedAt: 't',
  calls: [
    { base: 'ORBIT_ENGINE_API_URL', baseIsEnv: true, path: '/v1/agents/stream', file: 'src/datasources/EngineAPI.ts' },
    { base: 'cfg.other', baseIsEnv: false, path: '/v1/tenants', file: 'src/other.ts' },
  ],
  graphqlOperations: [{ operation: 'query', name: 'GetTenants', file: 'src/queries.ts' }],
  envHints: { ORBIT_ENGINE_API_URL: 'https://orbit-core-x.internal/api' },
  ...over,
});

describe('baseNamesSibling', () => {
  it('hint value naming the sibling is the strongest signal', () => {
    expect(baseNamesSibling('ORBIT_ENGINE_API_URL', true, { ORBIT_ENGINE_API_URL: 'https://orbit-core-x/api' }, 'orbit-core')).toBe(true);
  });
  it('token overlap on non-generic tokens', () => {
    expect(baseNamesSibling('ORBIT_ENGINE_API_URL', true, {}, 'orbit-core')).toBe(true);
    expect(baseNamesSibling('SOME_API_URL', true, {}, 'orbit-core')).toBe(false);
  });
});

describe('matchAgainstSurface', () => {
  it('tiers: named env base = high; path/op-only = medium; suffix paths match', () => {
    const matches = matchAgainstSurface(outbound(), surface());
    expect(matches).toEqual([
      { provider: 'orbit-core', endpoint: 'GET /api/v1/agents/stream', confidence: 'high', files: ['src/datasources/EngineAPI.ts'], surfaceDerivedAt: '2026-07-24T10:00:00.000Z', exact: false },
      { provider: 'orbit-core', endpoint: 'POST /v1/tenants', confidence: 'medium', files: ['src/other.ts'], surfaceDerivedAt: '2026-07-24T10:00:00.000Z', exact: true },
      { provider: 'orbit-core', endpoint: 'query GetTenants', confidence: 'medium', files: ['src/queries.ts'], surfaceDerivedAt: '2026-07-24T10:00:00.000Z', exact: true },
    ]);
  });
});

describe('pathMatches specificity (via matchAgainstSurface)', () => {
  it('one-segment tails never suffix-match — a /browse URL builder must not hit .../browse endpoints', () => {
    const generic = outbound({
      calls: [{ base: 'site', baseIsEnv: false, path: '/browse', file: 'src/issue-ref.ts' }],
      graphqlOperations: [],
    });
    const provider = surface({ endpoints: [{ method: 'GET', path: '/api/spaces/items/browse' }], graphqlOperations: [] });
    expect(matchAgainstSurface(generic, provider)).toEqual([]);
    // exact single-segment still matches
    const exact = surface({ endpoints: [{ method: 'GET', path: '/browse' }], graphqlOperations: [] });
    expect(matchAgainstSurface(generic, exact)).toHaveLength(1);
  });
});

describe('param-aware path matching', () => {
  it('{param} segments match concrete or {named} provider segments; deep param paths auto-confirm', () => {
    const paramOutbound = outbound({
      calls: [{ base: 'ORBIT_ENGINE_API_URL', baseIsEnv: true, path: '/v1/plans/{param}/import-issues/dismissals', file: 'src/api.ts' }],
      graphqlOperations: [],
    });
    const paramSurface = surface({
      endpoints: [{ method: 'PATCH', path: '/api/v1/plans/{plan_id}/import-issues/dismissals' }],
      graphqlOperations: [],
    });
    const matches = matchAgainstSurface(paramOutbound, paramSurface);
    expect(matches).toHaveLength(1);
    expect(matches[0].confidence).toBe('high'); // env base names the sibling
    const pass = reconcileCrossLinks([], matches, paramOutbound, 't');
    expect(pass.autoConfirmedCount).toBe(1);
    expect(pass.events[0].status).toBe('confirmed');
  });
});

describe('store + reconcile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-crosslinks-'));
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('conclusive matches auto-confirm; shape-only matches are counted, never linked', () => {
    const matches = matchAgainstSurface(outbound(), surface());
    const first = reconcileCrossLinks([], matches, outbound(), '2026-07-24T12:00:00.000Z');
    // high (env names sibling) + gql (name-exact) auto-confirm; the 2-segment
    // exact /v1/tenants is shape-only — observed in the note, no link event.
    expect(first.autoConfirmedCount).toBe(2);
    expect(first.proposedCount).toBe(0);
    expect(first.shapeOnlyCount).toBe(1);
    appendCrossLinkEvents(dir, first.events);
    expect(readCrossLinks(dir).find((l) => l.endpoint === 'GET /api/v1/agents/stream')?.status).toBe('confirmed');
    expect(readCrossLinks(dir).find((l) => l.endpoint === 'query GetTenants')?.status).toBe('confirmed');
    expect(readCrossLinks(dir).find((l) => l.endpoint === 'POST /v1/tenants')).toBeUndefined();
    const second = reconcileCrossLinks(readCrossLinks(dir), matches, outbound(), '2026-07-24T12:05:00.000Z');
    expect(second.events).toEqual([]);
  });

  it('consumer params never wildcard onto provider concrete segments', () => {
    const wildcard = outbound({
      calls: [{ base: 'SOME_URL', baseIsEnv: true, path: '/api/{param}', file: 'src/auth.ts' }],
      graphqlOperations: [],
    });
    const provider = surface({
      endpoints: [{ method: 'GET', path: '/api/blueprint' }],
      graphqlOperations: [],
    });
    expect(matchAgainstSurface(wildcard, provider)).toEqual([]);
    // …but provider params still abstract over consumer segments
    const abstracted = surface({
      endpoints: [{ method: 'GET', path: '/api/{name}' }],
      graphqlOperations: [],
    });
    expect(matchAgainstSurface(wildcard, abstracted)).toHaveLength(1);
  });

  it('a pre-existing proposal upgrades to confirmed when its evidence is conclusive', () => {
    appendCrossLinkEvents(dir, [{ ts: 't0', status: 'proposed', provider: 'orbit-core', endpoint: 'GET /api/v1/agents/stream', confidence: 'high', files: ['src/datasources/EngineAPI.ts'], surfaceDerivedAt: 'x' }]);
    const pass = reconcileCrossLinks(readCrossLinks(dir), matchAgainstSurface(outbound(), surface()), outbound(), 't1');
    appendCrossLinkEvents(dir, pass.events);
    const link = readCrossLinks(dir).find((l) => l.endpoint === 'GET /api/v1/agents/stream');
    expect(link?.status).toBe('confirmed');
  });

  it('confirmed link whose source call vanished goes stale; reappearing revives as proposed', () => {
    const matches = matchAgainstSurface(outbound(), surface());
    appendCrossLinkEvents(dir, reconcileCrossLinks([], matches, outbound(), 't1').events);
    // user confirms one
    appendCrossLinkEvents(dir, [{ ts: 't2', status: 'confirmed', provider: 'orbit-core', endpoint: 'POST /v1/tenants', confidence: 'medium', files: ['src/other.ts'], surfaceDerivedAt: 'x' }]);
    // consumer deletes the call → not matched anymore
    const without = outbound({ calls: outbound().calls.filter((c) => c.path !== '/v1/tenants') });
    const drift = reconcileCrossLinks(readCrossLinks(dir), matchAgainstSurface(without, surface()), without, 't3');
    expect(drift.staleCount).toBe(1);
    appendCrossLinkEvents(dir, drift.events);
    expect(readCrossLinks(dir).find((l) => l.endpoint === 'POST /v1/tenants')?.status).toBe('stale');
    // the call comes back → revived as proposed (user re-confirms)
    const revive = reconcileCrossLinks(readCrossLinks(dir), matchAgainstSurface(outbound(), surface()), outbound(), 't4');
    appendCrossLinkEvents(dir, revive.events);
    expect(readCrossLinks(dir).find((l) => l.endpoint === 'POST /v1/tenants')?.status).toBe('proposed');
  });

  it('provider dropping the endpoint does NOT stale a confirmed link — the call still exists (drift territory)', () => {
    appendCrossLinkEvents(dir, [{ ts: 't1', status: 'confirmed', provider: 'orbit-core', endpoint: 'POST /v1/tenants', confidence: 'medium', files: ['src/other.ts'], surfaceDerivedAt: 'x' }]);
    // provider removed the endpoint → the MATCH vanishes, but the consumer's call is still in outbound
    const shrunk = surface({ endpoints: [{ method: 'GET', path: '/api/v1/agents/stream' }] });
    const pass = reconcileCrossLinks(readCrossLinks(dir), matchAgainstSurface(outbound(), shrunk), outbound(), 't2');
    expect(pass.staleCount).toBe(0);
    expect(readCrossLinks(dir).find((l) => l.endpoint === 'POST /v1/tenants')?.status).toBe('confirmed');
  });

  it('rejected stays rejected across re-derives — auto-confirm never overrides the user', () => {
    const matches = matchAgainstSurface(outbound(), surface());
    appendCrossLinkEvents(dir, reconcileCrossLinks([], matches, outbound(), 't1').events);
    appendCrossLinkEvents(dir, [{ ts: 't2', status: 'rejected', provider: 'orbit-core', endpoint: 'query GetTenants', confidence: 'medium', files: [], surfaceDerivedAt: 'x' }]);
    const again = reconcileCrossLinks(readCrossLinks(dir), matches, outbound(), 't3');
    expect(again.events).toEqual([]);
    expect(readCrossLinks(dir).find((l) => l.endpoint === 'query GetTenants')?.status).toBe('rejected');
  });
});

describe('crossDriftItems (Phase 4)', () => {
  const confirmed = (endpoint: string): ReturnType<typeof readCrossLinks>[number] => ({
    provider: 'orbit-core',
    endpoint,
    status: 'confirmed',
    confidence: 'high',
    files: ['src/datasources/EngineAPI.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts'],
    surfaceDerivedAt: 'x',
    ts: 't',
  });

  it('raises crit on a confirmed link the provider no longer exposes, with vintage + callers', () => {
    const items = crossDriftItems([confirmed('DELETE /api/tenants/[id]')], [surface()]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: 'crit', nodeId: 'project:orbit-core', source: 'cross-links' });
    expect(items[0].title).toBe('Consumed endpoint gone: DELETE /api/tenants/[id] (orbit-core)');
    expect(items[0].detail).toContain('vs orbit-core surface derived 2026-07-24');
    expect(items[0].detail).toContain('+1 more');
  });

  it('still-exposed confirmed links and non-confirmed links never alarm', () => {
    expect(crossDriftItems([confirmed('POST /v1/tenants')], [surface()])).toEqual([]);
    expect(crossDriftItems([{ ...confirmed('DELETE /gone'), status: 'proposed' }], [surface()])).toEqual([]);
  });

  it('providers with no published surface are skipped, never alarmed on', () => {
    expect(crossDriftItems([confirmed('GET /x')], [])).toEqual([]);
  });

  it('consumer-path links match provider full paths (suffix tolerance) — no false drift', () => {
    // surface exposes GET /api/v1/agents/stream; link named by consumer path
    expect(crossDriftItems([{ ...confirmed('GET /v1/agents/stream') }], [surface()])).toEqual([]);
    // wrong method on the same path still drifts
    expect(crossDriftItems([confirmed('PUT /v1/agents/stream')], [surface()])).toHaveLength(1);
  });

  it('blind surfaces (zero endpoints + zero ops — extraction cannot see that stack) never alarm', () => {
    const blind = surface({ endpoints: [], graphqlOperations: [] });
    expect(crossDriftItems([confirmed('POST /v1/agents/stream')], [blind])).toEqual([]);
  });
});

describe('consumerStillCalls', () => {
  it('matches REST link paths against outbound calls (suffix-tolerant) and GraphQL by op+name', () => {
    expect(consumerStillCalls(outbound(), 'POST /v1/tenants')).toBe(true);
    expect(consumerStillCalls(outbound(), 'GET /api/v1/agents/stream')).toBe(true); // provider prefix
    expect(consumerStillCalls(outbound(), 'query GetTenants')).toBe(true);
    expect(consumerStillCalls(outbound(), 'DELETE /nowhere')).toBe(false);
    expect(consumerStillCalls(outbound(), 'mutation GetTenants')).toBe(false);
  });
});
