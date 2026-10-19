import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeDocTouches,
  docAnchorPaths,
  matchDocTouches,
  placeDocAnchor,
  rankTouches,
  siblingResolution,
  type DocTouch,
  type TouchProjectData,
  type TouchWorkspace,
} from './doc-touches.js';
import type { FeatureNode, FeaturePart } from './feature-store.js';
import { writeFeature, writeParts } from './feature-store.js';
import type { StoryStep } from './types.js';

function feature(slug: string, name: string, anchors: string[], kind: FeatureNode['kind'] = 'core'): FeatureNode {
  return {
    id: `feature:${slug}`,
    slug,
    name,
    kind,
    anchors,
    relates: [],
    lastFullRead: null,
    patchCount: 0,
    body: `# ${name}\n`,
    extra: {},
  };
}

function part(name: string, anchors: string[]): FeaturePart {
  return { name, summary: `${name} part`, anchors, learnings: [] };
}

type Steps = Array<Pick<StoryStep, 'anchors' | 'flow' | 'flowBefore' | 'flowAfter'>>;

function step(anchors: string[], flowAfter: string[] = []): Steps[number] {
  return {
    anchors: anchors.map((ref) => ({ kind: 'file' as const, ref })),
    flow: flowAfter,
    flowBefore: [],
    flowAfter,
  };
}

function data(overrides: Partial<TouchProjectData> = {}): TouchProjectData {
  return { project: null, root: '/repo', features: [], partsBySlug: new Map(), filesFor: null, ...overrides };
}

describe('docAnchorPaths', () => {
  it('collects file anchors and module flow ids once each, kinds stripped', () => {
    const paths = docAnchorPaths([
      step(['src/a.ts', 'src/b.ts'], ['module:src/lib', 'endpoint:POST /x', 'feature:chats/sse']),
      step(['src/a.ts']),
    ]);
    expect(paths).toEqual(['src/a.ts', 'src/b.ts', 'src/lib']);
  });
});

describe('placeDocAnchor', () => {
  const workspace: TouchWorkspace = {
    selfSlug: 'core',
    siblings: [{ slug: 'web', localPath: '/web', flowPath: '/ws/projects/web' }],
  };

  it('strips a sibling prefix that does not exist here', () => {
    expect(placeDocAnchor('web/src/x.tsx', workspace, () => false)).toEqual({
      raw: 'web/src/x.tsx',
      project: 'web',
      path: 'src/x.tsx',
    });
  });

  it('keeps a path that really exists here, even when it starts with a sibling slug', () => {
    expect(placeDocAnchor('web/src/x.tsx', workspace, () => true).project).toBeNull();
  });

  it('strips this project own slug the same way', () => {
    expect(placeDocAnchor('core/pkg/a.py', workspace, () => false)).toEqual({ raw: 'core/pkg/a.py', project: null, path: 'pkg/a.py' });
  });

  it('leaves unprefixed paths and paths outside a Workspace alone', () => {
    expect(placeDocAnchor('pkg/a.py', workspace, () => false).path).toBe('pkg/a.py');
    expect(placeDocAnchor('web/src/x.tsx', null, () => false)).toEqual({ raw: 'web/src/x.tsx', project: null, path: 'web/src/x.tsx' });
  });
});

describe('matchDocTouches', () => {
  it('finds the feature and the part whose anchors hold an unprefixed anchor', () => {
    const chats = feature('chats', 'Chats', ['src/chats']);
    const touches = matchDocTouches(
      ['src/chats/sse/stream.ts', 'src/other.ts'],
      data({
        features: [chats, feature('billing', 'Billing', ['src/billing'])],
        partsBySlug: new Map([['chats', [part('Live events SSE', ['src/chats/sse']), part('List', ['src/chats/list'])]]]),
      }),
    );
    expect(touches).toEqual([
      {
        project: null,
        root: '/repo',
        featureId: 'feature:chats',
        featureName: 'Chats',
        parts: [{ id: 'feature:chats/live-events-sse', name: 'Live events SSE' }],
        anchors: 1,
        specific: 1,
      },
    ]);
  });

  it('counts a file in the feature folder set (name-matched) even with no anchor over it', () => {
    const artifacts = feature('artifacts', 'Artifacts', ['src/app/api/artifacts']);
    const touches = matchDocTouches(
      ['src/components/artifacts/ArtifactViewer.tsx'],
      data({
        features: [artifacts],
        filesFor: (input) =>
          input.slug === 'artifacts' ? new Map([['src/components/artifacts/ArtifactViewer.tsx', 10]]) : new Map(),
      }),
    );
    expect(touches.map((touch) => [touch.featureName, touch.anchors])).toEqual([['Artifacts', 1]]);
  });

  it('a doc folder anchor touches the feature anchored inside it; a change never counts', () => {
    const touches = matchDocTouches(
      ['src'],
      data({ features: [feature('chats', 'Chats', ['src/chats']), feature('chat-fix', 'Chat fix', ['src/chats'], 'child')] }),
    );
    expect(touches.map((touch) => touch.featureId)).toEqual(['feature:chats']);
  });
});

describe('rankTouches', () => {
  it('ranks by anchors desc, then name', () => {
    const touch = (featureName: string, anchors: number, project: string | null = null, specific = anchors): DocTouch => ({
      project,
      root: null,
      featureId: `feature:${featureName.toLowerCase()}`,
      featureName,
      parts: [],
      anchors,
      specific,
    });
    const ranked = rankTouches([touch('Zeta', 1), touch('Beta', 1), touch('Alpha', 3, 'web')]);
    expect(ranked.map((entry) => entry.featureName)).toEqual(['Alpha', 'Beta', 'Zeta']);
  });

  it('a package-wide catch-all is touched but ranks below the features that own the folders', () => {
    const touches = rankTouches(
      matchDocTouches(
        ['pkg/db/models.py', 'pkg/services/a.py', 'pkg/services/b.py'],
        data({
          features: [
            feature('pkg', 'Pkg', ['module:pkg']),
            feature('db', 'Db', ['module:pkg/db']),
            feature('services', 'Services', ['module:pkg/services']),
          ],
        }),
      ),
    );
    expect(touches.map((entry) => [entry.featureName, entry.specific, entry.anchors])).toEqual([
      ['Services', 2, 2],
      ['Db', 1, 1],
      ['Pkg', 0, 3],
    ]);
  });
});

describe('computeDocTouches — real stores on disk', () => {
  let base: string;
  let core: string;
  let web: string;
  let webKnowledge: string;

  function write(root: string, rel: string, content = 'x\n'): void {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'doc-touches-'));
    core = join(base, 'core');
    web = join(base, 'web');
    webKnowledge = join(base, 'ws', 'projects', 'web');
    write(core, 'pkg/artifacts/views.py');
    write(core, 'pkg/db/models.py');
    write(web, 'src/components/artifacts/ArtifactViewer.tsx');
    writeFeature(join(core, 'flow'), feature('artifact-api', 'Artifact API', ['pkg/artifacts']));
    writeFeature(join(core, 'flow'), feature('db', 'Database', ['pkg/db']));
    writeParts(join(core, 'flow'), 'db', [part('Models', ['pkg/db/models.py'])]);
    writeFeature(webKnowledge, feature('artifacts', 'Artifacts', ['src/components/artifacts']));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const workspaceOf = (localPath: string | null) => (): TouchWorkspace => ({
    selfSlug: 'core',
    siblings: [{ slug: 'web', localPath, flowPath: webKnowledge }],
  });

  const steps: Steps = [
    step(['web/src/components/artifacts/ArtifactViewer.tsx']),
    step(['pkg/artifacts/views.py', 'web/src/components/artifacts/Missing.tsx', 'pkg/db/models.py']),
  ];

  it('resolves prefixed anchors in the sibling and unprefixed ones here, ranked', () => {
    const result = computeDocTouches(core, join(core, 'flow'), steps, { workspace: workspaceOf(web) });
    expect(result.notice).toBeUndefined();
    expect(result.touches).toEqual([
      { project: 'web', root: web, featureId: 'feature:artifacts', featureName: 'Artifacts', parts: [], anchors: 2, specific: 2 },
      { project: null, root: core, featureId: 'feature:artifact-api', featureName: 'Artifact API', parts: [], anchors: 1, specific: 1 },
      {
        project: null,
        root: core,
        featureId: 'feature:db',
        featureName: 'Database',
        parts: [{ id: 'feature:db/models', name: 'Models' }],
        anchors: 1,
        specific: 1,
      },
    ]);
    // On disk in the sibling → resolved there; a sibling path that is not → not.
    expect(siblingResolution('web/src/components/artifacts/ArtifactViewer.tsx', result)).toBe('web');
    expect(siblingResolution('web/src/components/artifacts/Missing.tsx', result)).toBeNull();
    expect(siblingResolution('pkg/db/models.py', result)).toBeNull();
  });

  it('reads a sibling with no checkout from its knowledge folder, root null', () => {
    const result = computeDocTouches(core, join(core, 'flow'), steps, { workspace: workspaceOf(null) });
    const sibling = result.touches.find((touch) => touch.project === 'web');
    expect(sibling).toMatchObject({ root: null, featureName: 'Artifacts', anchors: 2 });
    // Claimed by a sibling feature: resolved, even without a checkout to look in.
    expect(siblingResolution('web/src/components/artifacts/Missing.tsx', result)).toBe('web');
  });

  it('is fail-soft: an unreadable project costs its touches and says so', () => {
    const result = computeDocTouches(core, join(core, 'flow'), steps, {
      workspace: workspaceOf(web),
      readProject: () => {
        throw new Error('boom');
      },
    });
    expect(result.touches).toEqual([]);
    expect(result.notice).toContain('boom');
  });

  it('is fail-soft: a Workspace lookup that throws resolves everything here', () => {
    const result = computeDocTouches(core, join(core, 'flow'), steps, {
      workspace: () => {
        throw new Error('no workspace');
      },
    });
    expect(result.touches.map((touch) => touch.project)).toEqual([null, null]);
    expect(result.notice).toContain('no workspace');
  });

  it('never throws, whatever it is handed', () => {
    const result = computeDocTouches(core, join(core, 'flow'), null as unknown as Steps);
    expect(result.touches).toEqual([]);
    expect(result.notice).toMatch(/^touches unavailable/);
  });
});
