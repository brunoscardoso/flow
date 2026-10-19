import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { braceBlockAt, extractGraphqlOperations } from './graphql.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-graphql-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function withServer(deps: Record<string, string> = {}): void {
  write('package.json', JSON.stringify({ dependencies: { '@pothos/core': '4.0.0', ...deps } }));
}

describe('braceBlockAt', () => {
  it('returns the balanced block content', () => {
    expect(braceBlockAt('x({ a: { b: 1 } })', 0)).toBe(' a: { b: 1 } ');
    expect(braceBlockAt('no braces', 0)).toBeNull();
    expect(braceBlockAt('open { never closed', 0)).toBeNull();
  });
});

describe('extractGraphqlOperations', () => {
  it('returns nothing (silently) for a repo without a GraphQL server dep', () => {
    write('package.json', JSON.stringify({ dependencies: { '@apollo/client': '3.0.0' } }));
    write('src/schema.ts', "queryField('ghost', () => {})\n");
    const result = extractGraphqlOperations(root);
    expect(result.nodes).toEqual([]);
    expect(result.coverageNotes).toEqual([]);
  });

  it('extracts Pothos queryField/mutationField helpers', () => {
    withServer();
    write(
      'src/graphql/fields.ts',
      "queryField('getChats', (t) => t.field({}))\nmutationField('createChat', (t) => t.field({}))\n",
    );
    const { nodes, coverageNotes } = extractGraphqlOperations(root);
    expect(nodes.map((n) => n.id)).toEqual([
      'endpoint:mutation createChat',
      'endpoint:query getChats',
    ]);
    expect(nodes[0].meta).toMatchObject({ operation: 'mutation', pathGroup: 'graphql', detectedVia: 'pothos' });
    expect(coverageNotes[0]).toBe('graphql: 1 query · 1 mutation(s) (server: @pothos/core)');
  });

  it('extracts field keys from queryType/mutationType blocks, excluding t.arg args', () => {
    withServer();
    write(
      'src/graphql/types/Query.ts',
      [
        'builder.queryType({',
        '  fields: (t) => ({',
        '    getTenants: t.field({',
        '      args: { page: t.arg.int({ required: false }) },',
        '      resolve: () => [],',
        '    }),',
        '    getCurrentUser: t.prismaField({ resolve: () => null }),',
        '  }),',
        '})',
        'builder.mutationType({',
        '  fields: (t) => ({',
        '    renameChat: t.field({ args: { chatId: t.arg.string() }, resolve: () => null }),',
        '  }),',
        '})',
      ].join('\n'),
    );
    const { nodes } = extractGraphqlOperations(root);
    expect(nodes.map((n) => n.id)).toEqual([
      'endpoint:mutation renameChat',
      'endpoint:query getCurrentUser',
      'endpoint:query getTenants',
    ]);
  });

  it('extracts SDL Query/Mutation fields from template literals', () => {
    write('package.json', JSON.stringify({ dependencies: { '@apollo/server': '4.0.0' } }));
    write(
      'src/schema.ts',
      [
        'const typeDefs = gql`',
        '  type Query {',
        '    coworkers(page: Int): [Coworker!]!',
        '    documents: [Document!]!',
        '  }',
        '  type Mutation {',
        '    uploadDocument(input: UploadInput!): Document!',
        '  }',
        '`',
      ].join('\n'),
    );
    const { nodes } = extractGraphqlOperations(root);
    expect(nodes.map((n) => n.id)).toEqual([
      'endpoint:mutation uploadDocument',
      'endpoint:query coworkers',
      'endpoint:query documents',
    ]);
    expect(nodes[0].meta).toMatchObject({ detectedVia: 'sdl' });
  });

  it('honesty note when a server is detected but nothing extracted; skips test files', () => {
    withServer();
    write('src/graphql/schema.server.test.ts', "queryField('onlyInTests', () => {})\n");
    const { nodes, coverageNotes } = extractGraphqlOperations(root);
    expect(nodes).toEqual([]);
    expect(coverageNotes[0]).toBe('graphql: server detected (@pothos/core) but 0 operations extracted');
  });
});
