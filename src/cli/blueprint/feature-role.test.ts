import { describe, expect, it } from '@jest/globals';
import {
  FEATURE_ROLES,
  FEATURE_ROLE_LABELS,
  guessFeatureRole,
  isFeatureRole,
  resolveFeatureRole,
} from './feature-role.js';

describe('vocabulary', () => {
  it('labels every role and recognises only roles', () => {
    for (const role of FEATURE_ROLES) {
      expect(isFeatureRole(role)).toBe(true);
      expect(FEATURE_ROLE_LABELS[role].length).toBeGreaterThan(0);
    }
    expect(isFeatureRole('Ui')).toBe(false);
    expect(isFeatureRole(null)).toBe(false);
    expect(isFeatureRole('widget')).toBe(false);
  });
});

describe('guessFeatureRole', () => {
  it('typed anchors vote first', () => {
    expect(guessFeatureRole(['endpoint:GET /api/x'])).toBe('api');
    expect(guessFeatureRole(['datastore:users'])).toBe('data');
    expect(guessFeatureRole(['integration:stripe.com'])).toBe('integration');
  });

  it('typed anchors are not overridden by path words', () => {
    expect(guessFeatureRole(['endpoint:GET /renderer', 'module:app/src/renderer/x'])).toBe('neutral');
    expect(guessFeatureRole(['endpoint:GET /a', 'endpoint:GET /b', 'module:app/src/renderer/x'])).toBe('api');
  });

  it('path words vote', () => {
    expect(guessFeatureRole(['module:app/src/renderer/tasks'])).toBe('ui');
    expect(guessFeatureRole(['module:src/cli/daemon'])).toBe('jobs');
    expect(guessFeatureRole(['file:src/cli/state/flowconfig-parser.ts'])).toBe('config');
    expect(guessFeatureRole(['module:mobile/ios'])).toBe('mobile');
    expect(guessFeatureRole(['file:src/shared/utils/format.ts'])).toBe('function');
    expect(guessFeatureRole(['module:app/src/main/terminal'])).toBe('service');
    expect(guessFeatureRole(['file:src/db/schema.ts'])).toBe('data');
    expect(guessFeatureRole(['module:src/server/routes'])).toBe('api');
    expect(guessFeatureRole(['module:src/cli/blueprint'])).toBe('logic');
  });

  it('bare repo paths vote like file anchors', () => {
    expect(guessFeatureRole(['app/src/renderer/threads', 'app/src/renderer/tasks'])).toBe('ui');
  });

  it('the deepest matching segment wins within one path', () => {
    expect(guessFeatureRole(['file:app/src/renderer/db/x.ts'])).toBe('data');
    expect(guessFeatureRole(['file:app/src/main/renderer/x.ts'])).toBe('ui');
  });

  it('tests and docs do not vote', () => {
    expect(guessFeatureRole(['file:app/src/renderer/x.test.ts', 'file:docs/a.md', 'file:e2e/y.ts'])).toBe('neutral');
    expect(
      guessFeatureRole(['file:app/src/renderer/a.ts', 'file:app/src/main/auth/x.test.ts', 'file:.claude/resources/s.md']),
    ).toBe('ui');
  });

  it('a tie is neutral, and so is no signal', () => {
    expect(guessFeatureRole(['module:app/src/renderer/a', 'module:app/src/main/b'])).toBe('neutral');
    expect(guessFeatureRole([])).toBe('neutral');
    expect(guessFeatureRole(['symbol:foo'])).toBe('neutral');
  });

  it('real anchor lists', () => {
    // blueprint: logic (src/cli) + service (main) + ui (renderer) — three-way tie.
    expect(
      guessFeatureRole(['module:src/cli/blueprint', 'module:app/src/main/blueprint', 'module:app/src/renderer/blueprint']),
    ).toBe('neutral');
    // tasks: renderer vs main — one vote each, tie.
    expect(guessFeatureRole(['module:app/src/renderer/tasks', 'module:app/src/main/tasks'])).toBe('neutral');
    // board-collapse: a single renderer file.
    expect(guessFeatureRole(['file:app/src/renderer/tasks/board-collapse.ts'])).toBe('ui');
    // share: 5 endpoints outvote the rest (schema.sql -> data, main/ -> service).
    expect(
      guessFeatureRole([
        'endpoint:GET /api/shares',
        'endpoint:GET /p/[id]',
        'endpoint:GET /v/[id]',
        'endpoint:PATCH /api/shares/[id]',
        'endpoint:POST /api/shares',
        'file:app/src/main/auth/identity-is-not-a-gate.test.ts',
        'file:app/src/main/auth/identity-store.ts',
        'file:app/src/renderer/threads/feature-view-host.ts',
        'file:ingest/schema.sql',
        'module:app/src/main/share',
      ]),
    ).toBe('api');
  });
});

describe('resolveFeatureRole', () => {
  const anchors = ['endpoint:GET /x'];

  it('person beats learn beats guess', () => {
    expect(resolveFeatureRole({ role: 'ui', learnedRole: 'data', anchors })).toEqual({ role: 'ui', source: 'person' });
    expect(resolveFeatureRole({ learnedRole: 'data', anchors })).toEqual({ role: 'data', source: 'learn' });
    expect(resolveFeatureRole({ anchors })).toEqual({ role: 'api', source: 'guess' });
  });

  it('an off-list person role falls through to the learned one', () => {
    expect(resolveFeatureRole({ role: 'widget', learnedRole: 'jobs', anchors })).toEqual({ role: 'jobs', source: 'learn' });
    expect(resolveFeatureRole({ role: 'widget', learnedRole: 'nope', anchors })).toEqual({ role: 'api', source: 'guess' });
    expect(resolveFeatureRole({ role: null, learnedRole: null, anchors: [] })).toEqual({ role: 'neutral', source: 'guess' });
  });

  it('trims and lowercases', () => {
    expect(resolveFeatureRole({ role: '  UI ', anchors })).toEqual({ role: 'ui', source: 'person' });
    expect(resolveFeatureRole({ learnedRole: ' Data\n', anchors })).toEqual({ role: 'data', source: 'learn' });
  });
});

describe('guess over anchor lines copied from flow/brain/features (plan feature-type-icons, phase 6)', () => {
  it('guesses each real shape', () => {
    // heartbeat: a daemon module votes jobs; the skill .md file does not vote.
    expect(guessFeatureRole(['module:src/cli/daemon', 'file:.claude/resources/skills/resume-work-skill.md'])).toBe('jobs');
    // code-review: renderer vs main tie; the two .md skills must not break it either way.
    expect(
      guessFeatureRole([
        'module:app/src/renderer/review',
        'module:app/src/main/review',
        'file:.claude/resources/skills/review-code-skill.md',
        'file:.claude/resources/skills/review-pr-skill.md',
      ]),
    ).toBe('neutral');
    // loops-pause-all-unify: four renderer files, mixed with nothing.
    expect(
      guessFeatureRole([
        'file:app/src/renderer/loops/loops-panel-model.ts',
        'file:app/src/renderer/loops/loops-screen-model.ts',
        'file:app/src/renderer/loops/loops-screen.ts',
        'file:app/src/renderer/tasks/kanban-board.ts',
      ]),
    ).toBe('ui');
    // loops: logic (src/cli) + ui + service, one vote each.
    expect(guessFeatureRole(['module:src/cli/loop', 'module:app/src/renderer/loops', 'module:app/src/main/loops'])).toBe(
      'neutral',
    );
    // brain: service + logic tie.
    expect(guessFeatureRole(['module:app/src/main/brain', 'file:src/cli/blueprint/corpus-index.ts'])).toBe('neutral');
    // an md-only feature has no signal at all.
    expect(guessFeatureRole(['file:.claude/resources/skills/a.md', 'file:docs/b.mdx'])).toBe('neutral');
  });

  it('a mixed feature with a clear majority takes it', () => {
    expect(
      guessFeatureRole(['module:app/src/renderer/a', 'file:app/src/renderer/b.ts', 'module:app/src/main/c', 'file:docs/x.md']),
    ).toBe('ui');
  });

  it('an off-list stored value never reaches the guess result', () => {
    const resolved = resolveFeatureRole({ role: 'wizard', learnedRole: 'sorcery', anchors: ['module:src/cli/daemon'] });
    expect(resolved).toEqual({ role: 'jobs', source: 'guess' });
    expect(isFeatureRole(resolved.role)).toBe(true);
  });
});
