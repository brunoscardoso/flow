/**
 * Unit tests for the guarded-autopilot decision core.
 *
 * Pure — no fs, no mocks, no model. Covers every action kind's verdict and
 * category, the bash-family classification agreeing with permissions-hygiene,
 * the `userRequested` downgrade (ask → allow only), and determinism.
 */

import type { GuardAction } from './guard-types.js';

const { classifyGuardAction } = await import('./guard-classifier.js');

describe('classifyGuardAction', () => {
  describe('remote/local action kinds', () => {
    it('asks on push and pr-create (irreversible-remote)', () => {
      expect(classifyGuardAction({ kind: 'push' })).toMatchObject({
        verdict: 'ask',
        category: 'irreversible-remote',
      });
      expect(classifyGuardAction({ kind: 'pr-create' })).toMatchObject({
        verdict: 'ask',
        category: 'irreversible-remote',
      });
    });

    it('names the remote target in the reason', () => {
      const decision = classifyGuardAction({ kind: 'push', remote: 'origin', branch: 'feat/x' });
      expect(decision.reason).toContain('origin');
      expect(decision.reason).toContain('feat/x');
    });

    it('allows a local commit (reversible-local)', () => {
      expect(classifyGuardAction({ kind: 'commit' })).toMatchObject({
        verdict: 'allow',
        category: 'reversible-local',
      });
    });

    it('allows a delete inside the worktree, asks on one outside', () => {
      expect(classifyGuardAction({ kind: 'delete', path: 'dist/x', insideWorktree: true })).toMatchObject({
        verdict: 'allow',
        category: 'reversible-local',
      });
      const outside = classifyGuardAction({ kind: 'delete', path: '/etc/hosts', insideWorktree: false });
      expect(outside).toMatchObject({ verdict: 'ask', category: 'irreversible-delete' });
      expect(outside.reason).toContain('/etc/hosts');
    });
  });

  describe('delete containment resolves against the stated worktree', () => {
    const worktree = '/repos/.plan-flow-threads/blue-heron';

    it('allows a delete inside the thread worktree that would read as outside the project', () => {
      const decision = classifyGuardAction({
        kind: 'delete',
        path: `${worktree}/dist/bundle.js`,
        worktreeRoot: worktree,
      });
      expect(decision).toMatchObject({ verdict: 'allow', category: 'reversible-local' });
      expect(decision.reason).toContain(worktree);
    });

    it('resolves a relative path against the worktree root, not the process cwd', () => {
      expect(
        classifyGuardAction({ kind: 'delete', path: 'dist/bundle.js', worktreeRoot: worktree }),
      ).toMatchObject({ verdict: 'allow', category: 'reversible-local' });
    });

    it('asks on the main checkout — the door this feature closes', () => {
      const decision = classifyGuardAction({
        kind: 'delete',
        path: '/repos/plan-flow/src/index.ts',
        worktreeRoot: worktree,
      });
      expect(decision).toMatchObject({ verdict: 'ask', category: 'irreversible-delete' });
      expect(decision.reason).toContain('/repos/plan-flow/src/index.ts');
    });

    it('asks on a traversal escape out of the worktree', () => {
      expect(
        classifyGuardAction({ kind: 'delete', path: '../../etc/hosts', worktreeRoot: worktree }),
      ).toMatchObject({ verdict: 'ask', category: 'irreversible-delete' });
    });

    it('asks on deleting the worktree root itself (untracked files go with it)', () => {
      const decision = classifyGuardAction({
        kind: 'delete',
        path: worktree,
        worktreeRoot: worktree,
      });
      expect(decision).toMatchObject({ verdict: 'ask', category: 'irreversible-delete' });
      expect(decision.reason).toContain('itself');
    });

    it('prefers the stated root over a stale insideWorktree claim', () => {
      expect(
        classifyGuardAction({
          kind: 'delete',
          path: '/etc/hosts',
          worktreeRoot: worktree,
          insideWorktree: true,
        }),
      ).toMatchObject({ verdict: 'ask', category: 'irreversible-delete' });
    });

    it('fails closed when neither the root nor containment is stated', () => {
      const decision = classifyGuardAction({ kind: 'delete', path: 'dist/x' });
      expect(decision).toMatchObject({ verdict: 'ask', category: 'unresolved-delete' });
      expect(decision.reason).toContain('dist/x');
    });

    it('an empty worktree root is not a root — it falls through, never allows', () => {
      expect(
        classifyGuardAction({ kind: 'delete', path: 'dist/x', worktreeRoot: '' }),
      ).toMatchObject({ verdict: 'ask', category: 'unresolved-delete' });
    });
  });

  describe('bash classification (reuses permissions-hygiene vocabulary)', () => {
    const cases: Array<[string, string, string]> = [
      ['git status -sb', 'allow', 'auto-allowed'],
      ['ls -la', 'allow', 'auto-allowed'],
      ['git push origin main', 'ask', 'mutating-bash'],
      ['npm install lodash', 'ask', 'mutating-bash'],
      ['rm -rf build', 'ask', 'mutating-bash'],
      ['npx prettier .', 'ask', 'wildcard-runner'],
      ['sudo rm x', 'ask', 'wildcard-runner'],
      ['jest --watch', 'consult', 'ambiguous-bash'],
      ['tsc --noEmit', 'consult', 'ambiguous-bash'],
      ['a && b', 'ask', 'unparseable-bash'],
      ['echo x | grep y', 'ask', 'unparseable-bash'],
    ];
    for (const [command, verdict, category] of cases) {
      it(`${command} → ${verdict} (${category})`, () => {
        expect(classifyGuardAction({ kind: 'bash', command })).toMatchObject({ verdict, category });
      });
    }
  });

  describe('userRequested downgrade', () => {
    it('downgrades an ask to allow (user-requested), preserving the base reason', () => {
      const decision = classifyGuardAction({ kind: 'push', remote: 'origin', userRequested: true });
      expect(decision.verdict).toBe('allow');
      expect(decision.category).toBe('user-requested');
      expect(decision.reason).toContain('explicitly requested');
    });

    it('downgrades a mutating-bash ask', () => {
      expect(
        classifyGuardAction({ kind: 'bash', command: 'rm -rf legacy-dir', userRequested: true }),
      ).toMatchObject({ verdict: 'allow', category: 'user-requested' });
    });

    it('never changes an existing allow', () => {
      expect(classifyGuardAction({ kind: 'commit', userRequested: true })).toMatchObject({
        verdict: 'allow',
        category: 'reversible-local',
      });
    });

    it('never upgrades a consult to allow', () => {
      expect(
        classifyGuardAction({ kind: 'bash', command: 'jest --watch', userRequested: true }),
      ).toMatchObject({ verdict: 'consult', category: 'ambiguous-bash' });
    });
  });

  describe('determinism', () => {
    it('returns byte-identical decisions for the same action', () => {
      const action: GuardAction = { kind: 'bash', command: 'git push origin main' };
      expect(JSON.stringify(classifyGuardAction(action))).toBe(
        JSON.stringify(classifyGuardAction(action)),
      );
    });
  });
});
