import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFastapiEndpoints } from './fastapi.js';

/** Fixture mirrors the LIVE orbit-core shape: FastAPI app in a factory
 *  function (param mount → root), two-level include chain with prefixes,
 *  `__init__.py` re-export, `as` alias import, multi-line decorator + call. */
function seedRepo(root: string): void {
  mkdirSync(join(root, 'core/web/api/v1/agents'), { recursive: true });
  mkdirSync(join(root, 'core/web/api/v1/audit'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });

  writeFileSync(
    join(root, 'core/web/application.py'),
    [
      'from fastapi import FastAPI',
      'from core.web.api.router import api_router',
      '',
      'def get_app():',
      '    app = FastAPI(title="core")',
      '    app.include_router(router=api_router, prefix="/api")',
      '    return app',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(root, 'core/web/api/router.py'),
    [
      'from fastapi.routing import APIRouter',
      'from core.web.api.v1.router import api_v1_router',
      '',
      'api_router = APIRouter()',
      'api_router.include_router(api_v1_router, prefix="/v1")',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(root, 'core/web/api/v1/router.py'),
    [
      'from fastapi.routing import APIRouter',
      'from core.web.api.v1 import (',
      '    agents,',
      ')',
      'from core.web.api.v1.audit import router as audit_router',
      '',
      'api_v1_router = APIRouter()',
      'api_v1_router.include_router(agents.router, prefix="/agents", tags=["Agents"])',
      'api_v1_router.include_router(',
      '    audit_router, prefix="/audit", tags=["Audit"]',
      ')',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(root, 'core/web/api/v1/agents/__init__.py'),
    ['from core.web.api.v1.agents.views import router', '', '__all__ = ["router"]', ''].join('\n'),
  );

  writeFileSync(
    join(root, 'core/web/api/v1/agents/views.py'),
    [
      'from fastapi import APIRouter',
      '',
      'router = APIRouter()',
      '',
      '@router.post("/stream")',
      'async def stream(): ...',
      '',
      '@router.get(',
      '    "/{agent_id}/skills",',
      '    response_model=list,',
      ')',
      'async def skills(agent_id: str): ...',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(root, 'core/web/api/v1/audit/__init__.py'),
    [
      'from fastapi import APIRouter',
      '',
      'router = APIRouter(',
      '    prefix="/log",',
      ')',
      '',
      '@router.get("")',
      'async def read_log(): ...',
      '',
    ].join('\n'),
  );

  // Unmounted router: emits at its own partial prefix + counted in notes.
  writeFileSync(
    join(root, 'core/lab.py'),
    ['from fastapi import APIRouter', 'router = APIRouter()', '@router.delete("/scratch")', 'def wipe(): ...', ''].join('\n'),
  );

  // Python test conventions must be skipped (#538).
  writeFileSync(
    join(root, 'tests/test_routes.py'),
    ['from fastapi import APIRouter', 'router = APIRouter()', '@router.get("/fixture-only")', 'def f(): ...', ''].join('\n'),
  );
}

describe('extractFastapiEndpoints', () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'pf-fastapi-'));
    seedRepo(repoRoot);
  });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('resolves full paths through the include chain, __init__ re-exports, and as-aliases', () => {
    const fragment = extractFastapiEndpoints(repoRoot);
    const labels = fragment.nodes.map((node) => node.label);
    expect(labels).toContain('POST /api/v1/agents/stream');
    expect(labels).toContain('GET /api/v1/agents/{agent_id}/skills');
    expect(labels).toContain('GET /api/v1/audit/log'); // include prefix + APIRouter(prefix=) + empty route path
  });

  it('emits unmounted routers at their partial prefix and reports them; skips python test files', () => {
    const fragment = extractFastapiEndpoints(repoRoot);
    const labels = fragment.nodes.map((node) => node.label);
    expect(labels).toContain('DELETE /scratch');
    // Partial paths group under ONE umbrella so they never flood the board.
    const scratch = fragment.nodes.find((node) => node.label === 'DELETE /scratch');
    expect(scratch?.meta?.pathGroup).toBe('(partial)');
    const mounted = fragment.nodes.find((node) => node.label === 'POST /api/v1/agents/stream');
    expect(mounted?.meta?.pathGroup).toBe('/api/v1');
    expect(labels.some((label) => label.includes('fixture-only'))).toBe(false);
    expect(fragment.coverageNotes.some((note) => note.includes('1 unmounted router(s)'))).toBe(true);
  });

  it('nodes carry the endpoint grammar: meta.method/route/pathGroup + detectedVia fastapi', () => {
    const fragment = extractFastapiEndpoints(repoRoot);
    const stream = fragment.nodes.find((node) => node.label === 'POST /api/v1/agents/stream');
    expect(stream).toMatchObject({
      id: 'endpoint:POST /api/v1/agents/stream',
      kind: 'endpoint',
      sourceFile: 'core/web/api/v1/agents/views.py',
      meta: { method: 'POST', route: '/api/v1/agents/stream', pathGroup: '/api/v1', detectedVia: 'fastapi' },
    });
  });

  it('is deterministic and fail-soft on an empty repo', () => {
    const empty = mkdtempSync(join(tmpdir(), 'pf-fastapi-empty-'));
    try {
      const first = extractFastapiEndpoints(empty);
      expect(first.nodes).toEqual([]);
      expect(first.coverageNotes[0]).toContain('0 endpoint(s)');
      expect(extractFastapiEndpoints(repoRoot)).toEqual(extractFastapiEndpoints(repoRoot));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
