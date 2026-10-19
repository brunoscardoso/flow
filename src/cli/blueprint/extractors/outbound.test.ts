import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { extractOutbound } from './outbound.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-outbound-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe('extractOutbound (cross-project federation)', () => {
  it('captures template-literal calls and resolves file-local env bases (orbit shape)', () => {
    write(
      'src/datasources/EngineAPI.ts',
      [
        'class EngineAPI {',
        '  private baseURL: string',
        '  constructor() { this.baseURL = env.ORBIT_ENGINE_API_URL }',
        '  stream() { return new URL(`${this.baseURL}/v1/agents/stream`) }',
        '  direct() { return fetch(`${process.env.OTHER_API_URL}/v2/things`) }',
        '}',
      ].join('\n'),
    );
    const { outbound } = extractOutbound(root);
    expect(outbound.calls).toEqual([
      { base: 'ORBIT_ENGINE_API_URL', baseIsEnv: true, path: '/v1/agents/stream', file: 'src/datasources/EngineAPI.ts' },
      { base: 'OTHER_API_URL', baseIsEnv: true, path: '/v2/things', file: 'src/datasources/EngineAPI.ts' },
    ]);
  });

  it('keeps unresolvable bases as raw expressions (manual-link fodder), skips non-paths', () => {
    write('src/x.ts', 'const u = `${cfg.apiRoot}/api/items`\nconst s = `${label}: value`\n');
    const { outbound } = extractOutbound(root);
    expect(outbound.calls).toEqual([
      { base: 'cfg.apiRoot', baseIsEnv: false, path: '/api/items', file: 'src/x.ts' },
    ]);
  });

  it('collects GraphQL client operations and env hints', () => {
    write('src/queries.ts', 'const Q = gql`\n  query GetTenants($id: ID!) { tenants { id } }\n  mutation RenameChat { rename }\n`\n');
    writeFileSync(join(root, '.env.example'), 'ORBIT_ENGINE_API_URL=https://orbit-core-x.internal/api\n# comment\n');
    const { outbound } = extractOutbound(root);
    expect(outbound.graphqlOperations).toEqual([
      { operation: 'query', name: 'GetTenants', file: 'src/queries.ts' },
      { operation: 'mutation', name: 'RenameChat', file: 'src/queries.ts' },
    ]);
    expect(outbound.envHints).toEqual({ ORBIT_ENGINE_API_URL: 'https://orbit-core-x.internal/api' });
  });

  it('skips test files (#538) and dedupes', () => {
    write('src/a.server.test.ts', 'const u = `${env.API_URL}/api/x`\n');
    write('src/b.ts', 'const u = `${env.API_URL}/api/x`\nconst v = `${env.API_URL}/api/x`\n');
    const { outbound } = extractOutbound(root);
    expect(outbound.calls).toHaveLength(1);
    expect(outbound.calls[0].file).toBe('src/b.ts');
  });
});

describe('parameterized template paths', () => {
  it('captures the FULL path across mid-template interpolations, attributed to the real base', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-outbound-param-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'src', 'api.ts'),
        [
          'const env = process.env as Record<string, string>',
          'class Api {',
          '  baseURL = env.CORE_API_URL',
          '  dismiss(planId: string) {',
          '    return fetch(`${this.baseURL}/v1/plans/${planId}/import-issues/dismissals`)',
          '  }',
          '}',
        ].join('\n'),
      );
      const { outbound } = extractOutbound(dir);
      expect(outbound.calls).toEqual([
        {
          base: 'CORE_API_URL',
          baseIsEnv: true,
          path: '/v1/plans/{param}/import-issues/dismissals',
          file: 'src/api.ts',
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
