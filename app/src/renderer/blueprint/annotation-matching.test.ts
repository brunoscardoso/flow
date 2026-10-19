// Annotation ↔ node matching — pure logic, no DOM (node test env).
// Mirrors the CLI's anchorReferencesNode rules (src/cli/commands/blueprint.ts).

import type { BlueprintAnnotation, BlueprintNode } from '../../shared/ipc-contract'
import {
  anchorReferencesNode,
  annotationsForNode,
  annotationsForNodes,
  cliCommandName,
  fileMatchesNode,
  isCliEndpoint,
} from './annotation-matching'

const moduleNode: BlueprintNode = {
  id: 'module:cli-core',
  kind: 'module',
  label: 'CLI core',
  sourceFile: 'src/cli/index.ts',
  symbol: 'runCli',
}

const datastoreNode: BlueprintNode = {
  id: 'datastore:sqlite',
  kind: 'datastore',
  label: 'SQLite',
  sourceFile: 'src/main/store/db.ts',
  meta: { tables: ['threads', 'messages'] },
}

function annotation(
  refs: Array<{ kind: BlueprintAnnotation['anchors'][number]['kind']; ref: string }>,
  text = 'note',
): BlueprintAnnotation {
  return {
    ts: '2026-07-09T00:00:00Z',
    runId: null,
    type: 'decision',
    text,
    anchors: refs.map(({ kind, ref }) => ({ kind, ref })),
    provenance: 'test',
    status: 'active',
  }
}

// Directory-granularity module node, as produced by the CLI's v1 extractors
// (module sourceFiles are directories, e.g. `src/cli`; anchors carry files).
const dirModuleNode: BlueprintNode = {
  id: 'module:cli',
  kind: 'module',
  label: 'cli',
  sourceFile: 'src/cli',
}

describe('fileMatchesNode', () => {
  it('matches the exact sourceFile', () => {
    expect(fileMatchesNode('src/cli', dirModuleNode)).toBe(true)
    expect(fileMatchesNode('src/main/store/db.ts', datastoreNode)).toBe(true)
  })

  it('matches a file contained in a module directory', () => {
    expect(fileMatchesNode('src/cli/blueprint/store.ts', dirModuleNode)).toBe(true)
  })

  it('does not match a file under an unrelated module directory', () => {
    const testModule: BlueprintNode = { ...dirModuleNode, id: 'module:test', sourceFile: 'src/test' }
    expect(fileMatchesNode('src/cli/blueprint/store.ts', testModule)).toBe(false)
  })

  it('does not match a module whose directory merely shares a path prefix', () => {
    const prefixModule: BlueprintNode = { ...dirModuleNode, id: 'module:cl', sourceFile: 'src/cl' }
    expect(fileMatchesNode('src/cli/blueprint/store.ts', prefixModule)).toBe(false)
  })

  it('requires exact equality for non-module nodes', () => {
    const integrationNode: BlueprintNode = {
      id: 'integration:stripe',
      kind: 'integration',
      label: 'stripe',
      sourceFile: 'src/cli/blueprint',
    }
    expect(fileMatchesNode('src/cli/blueprint/store.ts', integrationNode)).toBe(false)
  })
})

describe('anchorReferencesNode', () => {
  it('matches an anchor whose ref equals the node id', () => {
    expect(anchorReferencesNode({ kind: 'module', ref: 'module:cli-core' }, moduleNode)).toBe(true)
  })

  it('matches a kind-prefixed ref (module:<ref> === node id)', () => {
    expect(anchorReferencesNode({ kind: 'module', ref: 'cli-core' }, moduleNode)).toBe(true)
  })

  it('matches the node symbol', () => {
    expect(anchorReferencesNode({ kind: 'symbol', ref: 'runCli' }, moduleNode)).toBe(true)
  })

  it('matches the node source file', () => {
    expect(anchorReferencesNode({ kind: 'file', ref: 'src/cli/index.ts' }, moduleNode)).toBe(true)
  })

  it('matches a datastore table name', () => {
    expect(anchorReferencesNode({ kind: 'table', ref: 'messages' }, datastoreNode)).toBe(true)
  })

  it('matches a file anchor contained in a module directory', () => {
    expect(
      anchorReferencesNode({ kind: 'file', ref: 'src/cli/blueprint/store.ts' }, dirModuleNode),
    ).toBe(true)
  })

  it('matches a symbol anchor via containment of its file scope', () => {
    expect(
      anchorReferencesNode(
        { kind: 'symbol', ref: 'writeGraph', file: 'src/cli/blueprint/store.ts' },
        dirModuleNode,
      ),
    ).toBe(true)
  })

  it('does not containment-match a file anchor against non-module nodes', () => {
    expect(
      anchorReferencesNode({ kind: 'file', ref: 'src/main/store/db.ts.bak' }, datastoreNode),
    ).toBe(false)
  })

  describe('module-anchor legacy bridge (path id OR basename label OR sourceFile)', () => {
    // Path-based module node as produced by the folder-spine extractor.
    const pathModuleNode: BlueprintNode = {
      id: 'module:src/cli/blueprint',
      kind: 'module',
      label: 'blueprint',
      sourceFile: 'src/cli/blueprint',
    }

    it('matches the path-based id form (module:<ref> === node id)', () => {
      expect(
        anchorReferencesNode({ kind: 'module', ref: 'src/cli/blueprint' }, pathModuleNode),
      ).toBe(true)
    })

    it('matches the legacy basename form via the node label', () => {
      expect(anchorReferencesNode({ kind: 'module', ref: 'blueprint' }, pathModuleNode)).toBe(true)
    })

    it('matches the directory-path form via sourceFile', () => {
      expect(
        anchorReferencesNode({ kind: 'module', ref: 'src/cli/blueprint' }, pathModuleNode),
      ).toBe(true)
      // sourceFile equality also covers nodes whose id prefix differs.
      const oddNode: BlueprintNode = { ...pathModuleNode, id: 'module:legacy-id' }
      expect(anchorReferencesNode({ kind: 'module', ref: 'src/cli/blueprint' }, oddNode)).toBe(true)
    })

    it('does not label-match non-module anchors or non-module nodes', () => {
      expect(anchorReferencesNode({ kind: 'file', ref: 'blueprint' }, pathModuleNode)).toBe(false)
      const integrationNode: BlueprintNode = {
        id: 'integration:stripe',
        kind: 'integration',
        label: 'stripe-billing',
        sourceFile: 'src/pay/stripe.ts',
      }
      expect(anchorReferencesNode({ kind: 'module', ref: 'stripe-billing' }, integrationNode)).toBe(
        false,
      )
    })

    it('does not match an unrelated basename', () => {
      expect(anchorReferencesNode({ kind: 'module', ref: 'render' }, pathModuleNode)).toBe(false)
    })
  })

  it('does not match an unrelated ref', () => {
    expect(anchorReferencesNode({ kind: 'file', ref: 'src/other.ts' }, moduleNode)).toBe(false)
    expect(anchorReferencesNode({ kind: 'table', ref: 'users' }, datastoreNode)).toBe(false)
    expect(anchorReferencesNode({ kind: 'file', ref: 'src/test/x.ts' }, dirModuleNode)).toBe(false)
  })
})

describe('annotationsForNode', () => {
  it('returns only annotations with an anchor referencing the node', () => {
    const matching = annotation([{ kind: 'symbol', ref: 'runCli' }], 'match')
    const other = annotation([{ kind: 'file', ref: 'src/other.ts' }], 'no match')
    const anchorless = annotation([], 'anchorless')
    expect(annotationsForNode([matching, other, anchorless], moduleNode)).toEqual([matching])
  })
})

describe('annotationsForNodes', () => {
  it('deduplicates an annotation anchored to several member nodes', () => {
    const both = annotation(
      [
        { kind: 'file', ref: 'src/cli/index.ts' },
        { kind: 'table', ref: 'threads' },
      ],
      'both',
    )
    const result = annotationsForNodes([both], [moduleNode, datastoreNode])
    expect(result).toEqual([both])
  })
})

describe('CLI endpoint rollup', () => {
  const cliNode: BlueprintNode = {
    id: 'endpoint:cli derive',
    kind: 'endpoint',
    label: 'cli derive',
    sourceFile: 'src/cli/index.ts',
    meta: { route: 'derive', detectedVia: 'commander' },
  }
  const httpNode: BlueprintNode = {
    id: 'endpoint:GET /health',
    kind: 'endpoint',
    label: 'GET /health',
    sourceFile: 'src/server.ts',
    meta: { method: 'GET', route: '/health' },
  }

  it('classifies commander endpoints as CLI, HTTP endpoints as not', () => {
    expect(isCliEndpoint(cliNode)).toBe(true)
    expect(isCliEndpoint(httpNode)).toBe(false)
    expect(isCliEndpoint(moduleNode)).toBe(false)
  })

  it('derives the subcommand name from route (falling back to label)', () => {
    expect(cliCommandName(cliNode)).toBe('derive')
    expect(
      cliCommandName({ ...cliNode, meta: undefined, label: 'cli heartbeat' }),
    ).toBe('heartbeat')
  })
})
