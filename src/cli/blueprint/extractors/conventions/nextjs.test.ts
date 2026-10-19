import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  appRoutePathOf,
  extractNextJsEndpoints,
  pagesApiPathOf,
  pathGroupOf,
} from './nextjs.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-nextjs-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe('appRoutePathOf', () => {
  it('derives the URL path, stripping route groups and keeping dynamic segments', () => {
    expect(appRoutePathOf('api/coworkers/')).toBe('/api/coworkers');
    expect(appRoutePathOf('api/documents/[id]/')).toBe('/api/documents/[id]');
    expect(appRoutePathOf('(dashboard)/api/events/')).toBe('/api/events');
    expect(appRoutePathOf('api/files/[...slug]/')).toBe('/api/files/[...slug]');
    expect(appRoutePathOf('')).toBe('/');
  });

  it('rejects parallel and intercepting segments', () => {
    expect(appRoutePathOf('@modal/api/x/')).toBeNull();
    expect(appRoutePathOf('api/(.)photo/')).toBeNull();
  });
});

describe('pagesApiPathOf', () => {
  it('prefixes /api, keeps params, collapses index', () => {
    expect(pagesApiPathOf('users')).toBe('/api/users');
    expect(pagesApiPathOf('users/[id]')).toBe('/api/users/[id]');
    expect(pagesApiPathOf('index')).toBe('/api');
  });
});

describe('pathGroupOf', () => {
  it('takes the first two segments', () => {
    expect(pathGroupOf('/api/coworkers/[id]/tags')).toBe('/api/coworkers');
    expect(pathGroupOf('/api')).toBe('/api');
    expect(pathGroupOf('/')).toBe('/');
  });
});

describe('extractNextJsEndpoints', () => {
  it('emits one endpoint per exported verb from App Router route files (src/ prefix included)', () => {
    write(
      'src/app/api/coworkers/route.ts',
      'export async function GET(req: Request) {}\nexport async function POST(req: Request) {}\n',
    );
    write('src/app/api/documents/[id]/route.ts', 'export const DELETE = handler\n');
    const { nodes, coverageNotes } = extractNextJsEndpoints(root);
    expect(nodes.map((n) => n.id)).toEqual([
      'endpoint:DELETE /api/documents/[id]',
      'endpoint:GET /api/coworkers',
      'endpoint:POST /api/coworkers',
    ]);
    expect(nodes[0].meta).toMatchObject({
      pathGroup: '/api/documents',
      detectedVia: 'nextjs-app-router',
      method: 'DELETE',
    });
    expect(coverageNotes[0]).toContain('3 App Router endpoint(s)');
  });

  it('strips route groups from the URL and skips parallel slots', () => {
    write('app/(marketing)/api/leads/route.ts', 'export function POST() {}\n');
    write('app/@modal/api/x/route.ts', 'export function GET() {}\n');
    const { nodes } = extractNextJsEndpoints(root);
    expect(nodes.map((n) => n.id)).toEqual(['endpoint:POST /api/leads']);
  });

  it('emits pages/api endpoints with method *', () => {
    write('src/pages/api/legacy/users.ts', 'export default function handler() {}\n');
    const { nodes } = extractNextJsEndpoints(root);
    expect(nodes.map((n) => n.id)).toEqual(['endpoint:* /api/legacy/users']);
    expect(nodes[0].meta).toMatchObject({ detectedVia: 'nextjs-pages-api', pathGroup: '/api/legacy' });
  });

  it('skips test files (#538) and non-handler exports', () => {
    write('src/app/api/x/route.test.ts', 'export function GET() {}\n');
    write('src/app/api/y/route.ts', 'export function helper() {}\nexport const config = {}\n');
    const { nodes } = extractNextJsEndpoints(root);
    expect(nodes).toEqual([]);
  });

  it('is deterministic across runs', () => {
    write('app/api/a/route.ts', 'export function GET() {}\n');
    write('app/api/b/route.ts', 'export function GET() {}\n');
    const first = extractNextJsEndpoints(root);
    const second = extractNextJsEndpoints(root);
    expect(second.nodes).toEqual(first.nodes);
  });
});

describe('convention-pack contract lockstep (#901)', () => {
  it('CONVENTION_PACKS names match the canonical CONVENTION_PACK_EXTRACTORS set', async () => {
    const { CONVENTION_PACKS } = await import('./pack.js');
    const { CONVENTION_PACK_EXTRACTORS } = await import('../../validate.js');
    expect(CONVENTION_PACKS.map((pack) => pack.name)).toEqual([...CONVENTION_PACK_EXTRACTORS]);
  });
});
