/**
 * Tests for the push carve-out.
 *
 * The rule being guarded is a SAFETY rule the user set ("no unprompted
 * pushes"), relaxed here by exactly one namespace. So the tests are written
 * adversarially: not "does `loop/fix` pass" but "what is the shortest string
 * that reaches `main` through a check that only looks at a prefix".
 *
 * Pure — no exec, no git, no network.
 */

const {
  isLoopRef,
  isOwnLoopRef,
  loopBranch,
  loopItemBranch,
  mergeEvidenceCoverage,
  mergeEvidenceRefusal,
  mergeRefusal,
  normalizeRef,
  parsePushTarget,
  prRefusal,
  pushRefusal,
} = await import('./push-guard.js');

type Evidence = Parameters<typeof mergeEvidenceRefusal>[0];

/** Evidence that clears the merge bar: all three proofs, all exited 0. */
const LANDABLE: Evidence = {
  commands: [
    { command: 'npm run typecheck', exitCode: 0 },
    { command: 'npm run build', exitCode: 0 },
    { command: 'npm run test -- src/cli/loop', exitCode: 0 },
  ],
};

/** The same evidence with one category dropped. */
function without(key: string): Evidence {
  return {
    commands: (LANDABLE?.commands ?? []).filter((entry) => !entry.command.includes(key)),
  };
}

describe('Task 5.6 — what a loop may push', () => {
  it('allows its own branch', () => {
    expect(pushRefusal('loop/fix')).toBeNull();
    expect(pushRefusal('loop/issue-1502')).toBeNull();
    expect(pushRefusal('refs/heads/loop/fix')).toBeNull();
    expect(pushRefusal('  loop/fix  ')).toBeNull();
  });

  it('refuses every branch outside the namespace, in one line', () => {
    for (const ref of ['main', 'master', 'develop', 'feat/agent-loops', 'release/1.4.3']) {
      const refusal = pushRefusal(ref);
      expect(refusal).not.toBeNull();
      expect(refusal).toContain('outside the carve-out');
      expect((refusal as string).split('\n')).toHaveLength(1);
    }
  });

  it('refuses a refspec whose DESTINATION escapes the namespace', () => {
    // The whole point: the left-hand side looks harmless, the right-hand side
    // is what actually gets written.
    expect(pushRefusal('HEAD:main')).toContain("'main' is outside");
    expect(pushRefusal('loop/fix:main')).toContain("'main' is outside");
    expect(pushRefusal('loop/fix:refs/heads/main')).toContain("'main' is outside");
    expect(pushRefusal('+loop/fix:main')).toContain("'main' is outside");
  });

  it('allows a refspec that lands INSIDE the namespace', () => {
    expect(pushRefusal('HEAD:loop/fix')).toBeNull();
    expect(pushRefusal('HEAD:refs/heads/loop/fix')).toBeNull();
    expect(pushRefusal('+loop/fix:loop/fix')).toBeNull();
  });

  it('refuses a deletion — a beat must not remove a branch a PR may point at', () => {
    expect(pushRefusal(':loop/fix')).toContain('may not delete');
    expect(pushRefusal(':main')).toContain('may not delete');
  });

  it('refuses traversal, wildcards and the bare prefix', () => {
    expect(pushRefusal('loop/../main')).toContain('outside the carve-out');
    expect(pushRefusal('loop/')).toContain('outside the carve-out');
    expect(pushRefusal('loop/*')).toContain('outside the carve-out');
    expect(pushRefusal('loop/fix main')).toContain('outside the carve-out');
  });

  it('refuses an empty ref by naming the flag', () => {
    expect(pushRefusal('')).toBe('push requires --branch <loop/...>');
    expect(pushRefusal('   ')).toBe('push requires --branch <loop/...>');
  });

  it('a branch that merely STARTS with the word loop is not in the namespace', () => {
    expect(pushRefusal('loops/fix')).toContain('outside the carve-out');
    expect(pushRefusal('looper')).toContain('outside the carve-out');
    expect(pushRefusal('feat/loop/fix')).toContain('outside the carve-out');
  });
});

describe('Task 5.6 — reading a push argument', () => {
  it('splits source from destination, and normalizes both', () => {
    expect(parsePushTarget('loop/fix')).toEqual({
      destination: 'loop/fix',
      source: 'loop/fix',
      deletes: false,
    });
    expect(parsePushTarget('HEAD:refs/heads/loop/fix')).toEqual({
      destination: 'loop/fix',
      source: 'HEAD',
      deletes: false,
    });
    expect(parsePushTarget(':loop/fix').deletes).toBe(true);
  });

  it('normalizes the decorations a caller may legitimately write', () => {
    expect(normalizeRef('refs/heads/loop/fix')).toBe('loop/fix');
    expect(normalizeRef('+loop/fix')).toBe('loop/fix');
    expect(normalizeRef('  loop/fix ')).toBe('loop/fix');
  });

  it('names a loop\'s own branch', () => {
    expect(loopBranch('fix')).toBe('loop/fix');
    expect(isLoopRef(loopBranch('improve'))).toBe(true);
  });
});

describe('Task 5.6 — what a loop may open a PR from', () => {
  it('allows a PR from its own branch into a protected base — the point of the carve-out', () => {
    expect(prRefusal('loop/fix', 'main')).toBeNull();
    expect(prRefusal('refs/heads/loop/fix', 'develop')).toBeNull();
  });

  it('refuses a PR whose head is not a loop branch', () => {
    expect(prRefusal('main', 'main')).toContain('outside the carve-out');
    expect(prRefusal('feat/whatever', 'main')).toContain('outside the carve-out');
    expect(prRefusal('', 'main')).toBe('opening a PR requires --branch <loop/...>');
  });

  it('refuses a malformed base rather than passing it to gh', () => {
    expect(prRefusal('loop/fix', '')).toContain('malformed --base');
    expect(prRefusal('loop/fix', 'main:main')).toContain('malformed --base');
    expect(prRefusal('loop/fix', 'main branch')).toContain('malformed --base');
  });
});

/**
 * Phase 4, Task 4.1 — what a loop may MERGE.
 *
 * A narrower question than what it may push, and the tests are written to the
 * difference: pushing is bounded by the carve-out (`loop/*` — every loop's
 * branch is equally not-`main`), landing is bounded by OWNERSHIP. So the shapes
 * probed here are the ones that pass a carve-out check and must still fail:
 * another loop's namespace, and a name that merely starts with this loop's.
 */
describe('Task 4.1 — what a loop may merge', () => {
  it('allows its own branch, however it was written', () => {
    expect(mergeRefusal('loop/fix/12', 'fix')).toBeNull();
    expect(mergeRefusal('loop/fix', 'fix')).toBeNull();
    expect(mergeRefusal('refs/heads/loop/fix/12', 'fix')).toBeNull();
    expect(mergeRefusal('  loop/fix/12  ', 'fix')).toBeNull();
  });

  it('refuses ANOTHER loop\'s branch — inside the carve-out is not enough', () => {
    for (const head of ['loop/find/3', 'loop/cleanup', 'loop/find/nested/12']) {
      const refusal = mergeRefusal(head, 'fix');
      expect(refusal).not.toBeNull();
      expect(refusal).toContain('outside them');
      expect((refusal as string).split('\n')).toHaveLength(1);
      // ...and the push guard would have let every one of them through
      expect(pushRefusal(head)).toBeNull();
    }
  });

  it('a branch that merely STARTS with this loop\'s name is not this loop\'s', () => {
    expect(mergeRefusal('loop/fixer/3', 'fix')).toContain('outside them');
    expect(mergeRefusal('loop/fix-two', 'fix')).toContain('outside them');
    expect(isOwnLoopRef('loop/fixer/3', 'fix')).toBe(false);
    expect(isOwnLoopRef('loop/fix/3', 'fix')).toBe(true);
    expect(isOwnLoopRef('loop/fix', 'fix')).toBe(true);
  });

  // ── the namespace git would not let a beat create ──────────────────────────
  //
  // Every case below was RED before `LOOP_ITEM_SEPARATOR`, and each one is a
  // step of the same live failure (a `/beat fix` run on 2026-08-12):
  //
  //   git branch loop/fix/1430
  //   fatal: cannot lock ref 'refs/heads/loop/fix/1430':
  //          'refs/heads/loop/fix' exists; cannot create
  //
  // A loop's worktree sits on `loop/<name>`, so git stores that ref as a FILE
  // and `loop/<name>/<id>` needs it to be a DIRECTORY. The gate accepted only
  // the impossible form, so consumers fell back to `loop/<name>-<id>` and then
  // could not land it: pushed, proposed, refused. The remote still carries eight
  // `loop/sweep-*` branches stranded exactly that way.
  it('accepts the item branch a beat can ACTUALLY create beside its worktree branch', () => {
    expect(loopItemBranch('fix', '1430')).toBe('loop/fix.1430');
    expect(mergeRefusal('loop/fix.1430', 'fix')).toBeNull();
    expect(isOwnLoopRef(loopItemBranch('fix', '1430'), 'fix')).toBe(true);
    // The form the gate used to demand stays accepted — it is reachable when no
    // worktree branch is in the way, and a ref git DID create must be landable.
    expect(mergeRefusal('loop/fix/1430', 'fix')).toBeNull();
  });

  it('keeps ownership unambiguous — a `-` separator could not', () => {
    // Loop names may contain `-` (`LOOP_NAME_PATTERN`), so `loop/fix-er-12`
    // reads as loop `fix` + item `er-12` AND as loop `fix-er` + item `12`.
    // A `.` cannot appear in a loop name, so it splits exactly one way.
    expect(isOwnLoopRef('loop/fix-er.12', 'fix')).toBe(false);
    expect(isOwnLoopRef('loop/fix-er.12', 'fix-er')).toBe(true);
    expect(isOwnLoopRef('loop/fixer.3', 'fix')).toBe(false);
    // ...and the improvised form stays outside, which is why it was refused.
    expect(isOwnLoopRef('loop/fix-1430', 'fix')).toBe(false);
  });

  it('will not read a prefix alone as ownership', () => {
    // `loop/fix.` names no item; owning it on the strength of the prefix would
    // let a malformed ref through the one gate that decides what lands.
    expect(isOwnLoopRef('loop/fix.', 'fix')).toBe(false);
    expect(isOwnLoopRef('loop/fix/', 'fix')).toBe(false);
  });

  it('refuses to build a branch name out of something that is not an id', () => {
    for (const bad of ['', '  ', 'a/b', 'a b', '..', 'x..y', 'v*', 'a~1', 'a^', 'a:b']) {
      expect(() => loopItemBranch('fix', bad)).toThrow();
    }
  });

  it('names the form that WORKS when it refuses one that does not', () => {
    // The beat reaching this line has already pushed and opened a PR; a refusal
    // that only says "wrong" sends it back to the same guess.
    expect(mergeRefusal('loop/fix-1430', 'fix')).toContain("'loop/fix.<id>'");
  });

  it('refuses a human\'s branch, in one line', () => {
    for (const head of ['main', 'master', 'develop', 'feat/agent-loops', 'release/1.4.3']) {
      const refusal = mergeRefusal(head, 'fix');
      expect(refusal).toContain('outside them');
      expect((refusal as string).split('\n')).toHaveLength(1);
    }
  });

  it('refuses a refspec rather than parsing a half out of it', () => {
    // The push guard reads `<src>:<dst>` because that is a legal push argument;
    // a merge takes a branch, so a colon means the caller is describing
    // something else entirely.
    expect(mergeRefusal('loop/fix/3:main', 'fix')).toContain('not a refspec');
    expect(mergeRefusal('HEAD:loop/fix/3', 'fix')).toContain('not a refspec');
    expect(mergeRefusal(':loop/fix/3', 'fix')).toContain('not a refspec');
  });

  it('refuses traversal, wildcards and the bare namespace', () => {
    expect(mergeRefusal('loop/fix/../../main', 'fix')).toContain('outside them');
    expect(mergeRefusal('loop/*', 'fix')).toContain('outside them');
    expect(mergeRefusal('loop/', 'fix')).toContain('outside them');
    expect(mergeRefusal('loop/fix/3 main', 'fix')).toContain('outside them');
  });

  it('names the missing flag rather than guessing at it', () => {
    expect(mergeRefusal('', 'fix')).toBe('merging requires --branch <loop/fix.<id>>');
    expect(mergeRefusal('   ', 'fix')).toBe('merging requires --branch <loop/fix.<id>>');
    expect(mergeRefusal('loop/fix/3', '')).toBe('merging requires --loop <name>');
    expect(isOwnLoopRef('loop/fix/3', '')).toBe(false);
  });

  it('the namespace it names is the loop\'s own branch', () => {
    expect(mergeRefusal('main', 'fix')).toContain(loopBranch('fix'));
    expect(isLoopRef(loopBranch('fix'))).toBe(true);
  });
});

/**
 * Phase 4, Task 4.2 — a merge is gated on captured exit codes, never on prose.
 *
 * The bar `close` already enforces, raised by one notch: a `done` close needs
 * SOME passing command, a merge needs the three that say the tree still holds
 * together — because a close leaves the work in a pull request a person can
 * still read, and a merge does not.
 */
describe('Task 4.2 — the evidence a merge requires', () => {
  it('accepts a typecheck, a build and the targeted tests, all exited 0', () => {
    expect(mergeEvidenceRefusal(LANDABLE)).toBeNull();
    expect(mergeEvidenceCoverage(LANDABLE?.commands ?? [])).toEqual([
      'typecheck',
      'build',
      'test',
    ]);
  });

  it('accepts however a project spells them', () => {
    expect(
      mergeEvidenceRefusal({
        commands: [
          { command: 'npx tsc --noEmit', exitCode: 0 },
          { command: 'pnpm run build:cli', exitCode: 0 },
          { command: 'npx jest src/cli/loop/push-guard.test.ts', exitCode: 0 },
        ],
      }),
    ).toBeNull();
    expect(
      mergeEvidenceRefusal({
        commands: [
          { command: 'mypy src', exitCode: 0 },
          { command: 'make build', exitCode: 0 },
          { command: 'pytest tests/test_queue.py', exitCode: 0 },
        ],
      }),
    ).toBeNull();
  });

  it('refuses prose, and refuses nothing at all', () => {
    for (const evidence of [
      undefined,
      { commands: [] } as Evidence,
      { commands: [], summary: 'everything passes, trust me' } as Evidence,
    ]) {
      const refusal = mergeEvidenceRefusal(evidence);
      expect(refusal).toContain('never prose alone');
      expect((refusal as string).split('\n')).toHaveLength(1);
    }
  });

  it('refuses a failing command instead of landing on it', () => {
    const refusal = mergeEvidenceRefusal({
      commands: [
        { command: 'npm run typecheck', exitCode: 0 },
        { command: 'npm run build', exitCode: 2 },
        { command: 'npm run test -- src/cli/loop', exitCode: 0 },
      ],
    });
    expect(refusal).toContain("'npm run build' exited 2");
    expect(refusal).toContain('every recorded command to have exited 0');
  });

  it('names the proof that is missing, and shows what WAS recorded', () => {
    const noBuild = mergeEvidenceRefusal(without('build'));
    expect(noBuild).toContain('missing a build');
    expect(noBuild).toContain("'npm run typecheck'");

    expect(mergeEvidenceRefusal(without('typecheck'))).toContain('missing a typecheck');
    expect(mergeEvidenceRefusal(without('test'))).toContain('missing the targeted tests');

    const nothingRecognized = mergeEvidenceRefusal({
      commands: [{ command: 'npm run verify', exitCode: 0 }],
    });
    expect(nothingRecognized).toContain('missing a typecheck and a build and the targeted tests');
  });

  it('refuses a malformed record with the same words the close gate uses', () => {
    expect(
      mergeEvidenceRefusal({ commands: 'npm run build' } as unknown as Evidence),
    ).toContain("must be an array of {command, exitCode} records");
    expect(
      mergeEvidenceRefusal({ commands: [{ exitCode: 0 }] } as unknown as Evidence),
    ).toContain("has no 'command'");
    expect(
      mergeEvidenceRefusal({
        commands: [{ command: 'npm run build', exitCode: 'ok' }],
      } as unknown as Evidence),
    ).toContain("no captured integer 'exitCode'");
  });
});

/**
 * The owned-branch carve-out (unattended-auto-branch, D3/FR-8). A consumer loop
 * may push/PR/merge the specific `feat/<ticket>` branch it OWNS — ownership
 * passed in, never parsed from the name (C-2) — while a trunk name and a
 * deletion are refused whatever a record says, and every non-owning caller sees
 * the historical loop-namespace rule unchanged.
 */
describe('owned non-loop branch — the widened carve-out', () => {
  const owned = 'feat/TPL-019-fix-xyz';

  it('admits exactly the branch the loop owns, for push', () => {
    expect(pushRefusal(owned, owned)).toBeNull();
    expect(pushRefusal('refs/heads/' + owned, owned)).toBeNull();
  });

  it('refuses a non-loop branch when no ownership is passed (unchanged)', () => {
    expect(pushRefusal(owned)).toContain('outside the carve-out');
  });

  it('refuses a different branch than the one owned', () => {
    expect(pushRefusal('feat/other', owned)).toContain('outside the carve-out');
  });

  it('never treats a trunk name as owned, even if a record claims it', () => {
    expect(pushRefusal('main', 'main')).toContain('outside the carve-out');
    expect(pushRefusal('master', 'master')).toContain('outside the carve-out');
  });

  it('refuses a deletion of the owned branch', () => {
    expect(pushRefusal(':' + owned, owned)).toContain('may not delete');
  });

  it('admits the owned branch for a PR, refuses another', () => {
    expect(prRefusal(owned, 'main', owned)).toBeNull();
    expect(prRefusal('feat/other', 'main', owned)).toContain('outside the carve-out');
  });

  it('merge: admits the owned branch, refuses one not owned', () => {
    expect(mergeRefusal(owned, 'fix', owned)).toBeNull();
    expect(mergeRefusal(owned, 'fix', null)).toContain('outside them');
    expect(mergeRefusal(owned, 'fix', 'feat/someone-else')).toContain('outside them');
  });

  it('merge: never lands a trunk name, even if passed as owned', () => {
    expect(mergeRefusal('main', 'fix', 'main')).toContain('outside them');
  });

  it("merge: a loop's own loop/<name>.<id> branch still lands by name (backward compatible)", () => {
    expect(mergeRefusal('loop/fix.12', 'fix')).toBeNull();
    expect(mergeRefusal('loop/fix.12', 'fix', null)).toBeNull();
  });
});
