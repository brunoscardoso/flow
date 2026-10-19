/**
 * Tests for a thread's REMOTE binding — the remote, the remote branch and the
 * PR base its local branch publishes to.
 *
 * WHAT THIS SUITE IS DEFENDING. The bug this module exists to stop is the
 * wrong-but-VALID push: `git push origin thread/whatever` succeeds, prints a
 * green line, and puts the work on a branch nobody is watching. Every test here
 * is therefore written against the two ways that bug comes back — a guess
 * wearing a suggestion's clothes (something in the ladder quietly filling a
 * blank), and a half-truth read as a decision (a `.remote` with no `.merge`
 * treated as bound).
 *
 * PURE, OVER A FAKE EXEC. Nothing here runs git, touches PATH, or needs a
 * repository (allowed-pattern #12, and NFR-2). The fake is a lookup table
 * keyed by the argv git would have been handed, which means every test also
 * asserts, implicitly, the exact call the module makes: a question the table
 * has no answer for THROWS, exactly as `git config --get` on a missing key
 * exits 1.
 */

const {
  autoBindDecision,
  bindingRefspec,
  bindingStaleness,
  DEFAULT_REMOTE_BRANCH_PATTERNS,
  extractTicketId,
  isValidRefName,
  isValidRemoteName,
  lastBinding,
  readBinding,
  remoteNames,
  sanitizeRefName,
  suggestRemoteBranch,
  writeBinding,
} = await import('./remote-binding.js');

type GitExec = import('./worktree.js').GitExec;
type RemoteBinding = import('./remote-binding.js').RemoteBinding;

/**
 * A git that answers exactly the calls the table names and fails every other
 * one — the way the real thing behaves when a config key is unset.
 *
 * The recorded argv is the second half of the contract: a module that got the
 * right ANSWER by asking the wrong QUESTION would still be broken against a
 * real repository, and the table is the only place that shows up.
 */
function fakeExec(table: Record<string, string>): { exec: GitExec; argv: string[][] } {
  const argv: string[][] = [];
  const exec: GitExec = (file, args) => {
    argv.push([file, ...args]);
    const key = args.join(' ');
    if (key in table) return table[key] as string;
    throw new Error(`exit 1: git ${key}`);
  };
  return { exec, argv };
}

/** A binding, spelled out so a test can vary the one field it is about. */
function binding(overrides: Partial<RemoteBinding> = {}): RemoteBinding {
  return { remote: 'upstream', remoteBranch: 'feature/x', prBase: null, ...overrides };
}

// ── the ladder ───────────────────────────────────────────

describe('suggestRemoteBranch — four rungs of evidence, most specific first', () => {
  describe('the branch is the third place a ticket is looked for (#1839)', () => {
    // `--here` — the mode the execute-plan skill uses, with no thread and no
    // title — could never fill `{ticket}`, so a project that had DECLARED its
    // convention was offered its own local branch name back. That is exactly
    // the confusion `source` exists to prevent.

    it('fills the pattern from the branch when nothing else names a ticket', () => {
      expect(
        suggestRemoteBranch({
          pattern: 'release/{ticket}',
          localBranch: 'feat/ACME-2446-add-login',
        }),
      ).toEqual({ suggestion: 'release/ACME-2446', source: 'pattern' });
    });

    it('a thread’s own words still win over the branch it is standing on', () => {
      // Third of three, deliberately: a title is what someone wrote about the
      // work; a branch name is where they happen to be.
      expect(
        suggestRemoteBranch({
          pattern: 'release/{ticket}',
          threadTitle: 'ACME-9999 the real subject',
          localBranch: 'feat/ACME-2446-add-login',
        }),
      ).toEqual({ suggestion: 'release/ACME-9999', source: 'pattern' });
    });

    it('and the plan wins over the branch too', () => {
      expect(
        suggestRemoteBranch({
          pattern: 'release/{ticket}',
          planName: 'ACME-7777-something',
          localBranch: 'feat/ACME-2446-add-login',
        }),
      ).toEqual({ suggestion: 'release/ACME-7777', source: 'pattern' });
    });

    it('reaches the ticket rung from the branch when no pattern is set', () => {
      expect(
        suggestRemoteBranch({ localBranch: 'feat/ACME-2446-add-login' }),
      ).toEqual({ suggestion: 'ACME-2446-add-login', source: 'ticket' });
    });

    it('a branch with no ticket in it still lands on local', () => {
      // The widening must not invent a ticket out of an ordinary name.
      expect(suggestRemoteBranch({ pattern: 'release/{ticket}', localBranch: 'feat/add-login' })).toEqual(
        { suggestion: 'feat/add-login', source: 'local' },
      );
    });
  });

  describe('a ticket keeps its case, because the rungs can no longer disagree (#1839)', () => {
    // The item reported a second, smaller inconsistency: the SAME branch read
    // `acme-2446` from the learned rung and `ACME-2446` from the ticket rung, and
    // on a case-sensitive remote those are two different branches.
    //
    // It turned out to be a SYMPTOM of the missing source, not a separate
    // defect. Nothing looked at the branch for a ticket, so rung 2 was skipped
    // and rung 3 fell through to `slug`, which lowercases. With the branch as a
    // ticket source, rung 2 answers first and the disagreement cannot arise.

    it('a branch carrying a ticket is answered by the ticket rung, with its case', () => {
      expect(
        suggestRemoteBranch({
          lastBinding: { localBranch: 'x', remoteBranch: 'feature/whatever' },
          localBranch: 'feat/ACME-2446-add-login',
        }),
      ).toEqual({ suggestion: 'ACME-2446-add-login', source: 'ticket' });
    });

    it('the learned rung is still there for a branch with no ticket', () => {
      // And it lowercases, which is correct — there is no ticket case to keep.
      expect(
        suggestRemoteBranch({
          lastBinding: { localBranch: 'x', remoteBranch: 'feature/whatever' },
          localBranch: 'feat/Add-Login',
        }),
      ).toEqual({ suggestion: 'feature/add-login', source: 'learned' });
    });

    it('no rung lowercases a ticket it emits', () => {
      const withTicket = ['feat/ACME-2446-add-login', 'ACME-2446', 'bugfix/ACME-2446'];
      for (const localBranch of withTicket) {
        const { suggestion } = suggestRemoteBranch({ localBranch });
        expect(suggestion).toContain('ACME-2446');
      }
    });
  });


  it('takes the project\'s own pattern over everything else', () => {
    expect(
      suggestRemoteBranch({
        pattern: 'feature/{ticket}',
        threadTitle: 'ACME-2204: Error endpoint',
        lastBinding: { remote: 'origin', remoteBranch: 'bugfix/old' },
        localBranch: 'thread/err',
      }),
    ).toEqual({ suggestion: 'feature/ACME-2204', source: 'pattern' });
  });

  it('fills {user} and {slug} from what the caller resolved', () => {
    expect(
      suggestRemoteBranch({
        pattern: '{user}/{slug}',
        threadTitle: 'Error endpoint here',
        localBranch: 'thread/err',
        user: 'devuser',
      }),
    ).toEqual({ suggestion: 'devuser/error-endpoint-here', source: 'pattern' });
  });

  it('falls THROUGH an unfillable {ticket} rather than suggesting `feature/`', () => {
    // The whole reason `fillPattern` returns null instead of an empty string:
    // `feature/` trimmed is `feature`, which is a perfectly valid branch name
    // and the wrong one. Falling to a lower rung offers something TRUE.
    const result = suggestRemoteBranch({
      pattern: '{user}/{ticket}',
      threadTitle: 'ACME-2204: Error endpoint',
      localBranch: 'thread/err',
    });
    expect(result).toEqual({ suggestion: 'ACME-2204-error-endpoint', source: 'ticket' });
    expect(result.suggestion).not.toContain('/');
  });

  it('treats an unknown placeholder as unfillable — a typo degrades, it does not leak braces', () => {
    const result = suggestRemoteBranch({
      pattern: 'feature/{sprint}',
      threadTitle: 'Error endpoint',
      localBranch: 'thread/err',
    });
    expect(result).toEqual({ suggestion: 'thread/err', source: 'local' });
    expect(result.suggestion).not.toContain('{');
  });

  it('falls from an unfillable pattern all the way to the learned rung', () => {
    expect(
      suggestRemoteBranch({
        pattern: '{user}/{slug}',
        threadTitle: 'Error endpoint',
        lastBinding: { remote: 'origin', remoteBranch: 'bugfix/old' },
        localBranch: 'thread/err',
      }),
    ).toEqual({ suggestion: 'bugfix/error-endpoint', source: 'learned' });
  });

  it('reads the ticket from the thread title, and truncates the sentence around it', () => {
    // Six words, because a branch carrying the whole sentence is a name nobody
    // can type or read in a pull request list.
    expect(
      suggestRemoteBranch({
        threadTitle: 'ACME-2204: Error endpoint when spaces is not enabled for a member',
        localBranch: 'thread/err',
      }),
    ).toEqual({ suggestion: 'ACME-2204-error-endpoint-when-spaces-is-not', source: 'ticket' });
  });

  it('falls back to the plan name when the thread title names no ticket', () => {
    expect(
      suggestRemoteBranch({
        threadTitle: 'Some thread',
        planName: 'PROJ2-17 remote binding',
        localBranch: 'thread/err',
      }),
    ).toEqual({ suggestion: 'PROJ2-17-some-thread', source: 'ticket' });
  });

  it('carries a `#`-shaped issue through the sanitizer instead of into a ref name', () => {
    const result = suggestRemoteBranch({
      threadTitle: 'fix #1430 the parser',
      localBranch: 'thread/err',
    });
    expect(result).toEqual({ suggestion: '1430-fix-the-parser', source: 'ticket' });
    expect(isValidRefName(result.suggestion)).toBe(true);
  });

  it('learns the namespace this repository has been using', () => {
    expect(
      suggestRemoteBranch({
        threadTitle: 'Error endpoint',
        lastBinding: { remote: 'origin', remoteBranch: 'feature/ACME-1-old' },
        localBranch: 'thread/err',
      }),
    ).toEqual({ suggestion: 'feature/error-endpoint', source: 'learned' });
  });

  it('DECLINES to learn from a flat last binding — it teaches nothing rung 4 does not', () => {
    // A repository whose last binding was `flatname` has no shape to copy, and
    // labelling `thread/err` as `learned` would claim confidence nobody has.
    expect(
      suggestRemoteBranch({
        threadTitle: 'Error endpoint',
        lastBinding: { remote: 'origin', remoteBranch: 'flatname' },
        localBranch: 'thread/err',
      }),
    ).toEqual({ suggestion: 'thread/err', source: 'local' });
  });

  it('offers the local name as the LAST resort, labelled as ours', () => {
    // The label is the whole difference between this and the old behaviour:
    // the same string, but the person is choosing it instead of inheriting it.
    expect(suggestRemoteBranch({ localBranch: 'thread/err' })).toEqual({
      suggestion: 'thread/err',
      source: 'local',
    });
  });

  it('throws on a local branch git could not name — there is no fourth rung without one', () => {
    expect(() => suggestRemoteBranch({ localBranch: '' })).toThrow("'' is not a branch name");
    expect(() => suggestRemoteBranch({ localBranch: 'bad..name' })).toThrow('is not a branch name');
  });

  it('never proposes a name git would reject, whichever rung answered', () => {
    const rungs = [
      suggestRemoteBranch({ pattern: 'feature/{ticket}', threadTitle: 'ACME-1: x', localBranch: 'thread/a' }),
      suggestRemoteBranch({ threadTitle: 'ACME-1: x', localBranch: 'thread/a' }),
      suggestRemoteBranch({
        threadTitle: 'x',
        lastBinding: { remote: 'origin', remoteBranch: 'feature/old' },
        localBranch: 'thread/a',
      }),
      suggestRemoteBranch({ localBranch: 'thread/a' }),
    ];
    expect(rungs.map((rung) => rung.source)).toEqual(['pattern', 'ticket', 'learned', 'local']);
    for (const rung of rungs) expect(isValidRefName(rung.suggestion)).toBe(true);
  });
});

// ── the ticket heuristic ─────────────────────────────────

describe('extractTicketId — what the prose NAMES, verbatim', () => {
  it.each([
    ['ACME-2204: Error endpoint', 'ACME-2204'],
    ['fixes #1430', '#1430'],
    // The Jira key wins wherever both appear: `#2` there is a reference, not
    // the subject.
    ['ACME-2204 fixes #2', 'ACME-2204'],
    ['PROJ2-17 remote binding', 'PROJ2-17'],
  ])('reads %j as %j', (text, expected) => {
    expect(extractTicketId(text)).toBe(expected);
  });

  it.each([
    ['no ticket here'],
    // A key must start at a word boundary — `xACME-1` is not a ticket, it is a
    // word that ends in one.
    ['xACME-1 lower'],
    // …and it must END at one: `ABC-12x` is a version string, not a ticket.
    ['ABC-12x'],
    ['A-1 single leading char'],
  ])('reads %j as naming nothing', (text) => {
    expect(extractTicketId(text)).toBeNull();
  });

  it('treats absence and blankness alike', () => {
    expect(extractTicketId(null)).toBeNull();
    expect(extractTicketId(undefined)).toBeNull();
    expect(extractTicketId('   ')).toBeNull();
  });
});

// ── the sanitizer ────────────────────────────────────────

describe('sanitizeRefName — coerce prose, or say nothing survived', () => {
  it.each([
    ['feature/#123 fix', 'feature/123-fix'],
    // The sequences git rejects outright, collapsed — and collapsed in a LOOP,
    // because collapsing can create a new one (`a...b` → `a..b` → `a.b`).
    ['a..b', 'a.b'],
    ['x/', 'x'],
    ['foo.lock', 'foo'],
    ['/leading', 'leading'],
    ['--dashes--', 'dashes'],
    ['feature//x', 'feature/x'],
  ])('turns %j into %j', (input, expected) => {
    expect(sanitizeRefName(input)).toBe(expected);
    expect(isValidRefName(expected)).toBe(true);
  });

  it('returns null when nothing usable is left, rather than an empty ref', () => {
    expect(sanitizeRefName('???')).toBeNull();
    expect(sanitizeRefName('')).toBeNull();
  });

  it('collapses a sequence its own collapse created', () => {
    expect(sanitizeRefName('a...b')).toBe('a.b');
  });
});

describe('isValidRefName / isValidRemoteName — the narrowing typed input is held to', () => {
  it.each(['feature/x', 'ACME-2204-fix', 'release/v1.2', 'a'])('accepts %j', (name) => {
    expect(isValidRefName(name)).toBe(true);
  });

  it.each(['bad..name', 'feature//x', 'trailing/', '-leading', 'foo.lock', ''])(
    'rejects %j',
    (name) => {
      expect(isValidRefName(name)).toBe(false);
    },
  );

  it('holds a REMOTE name to a narrower shape than a ref — no slashes', () => {
    expect(isValidRemoteName('origin')).toBe(true);
    expect(isValidRemoteName('up-stream.2')).toBe(true);
    expect(isValidRemoteName('feature/x')).toBe(false);
    expect(isValidRemoteName('a..b')).toBe(false);
  });
});

// ── reading and writing the binding ──────────────────────

describe('readBinding — git is the truth, and half of it is not a decision', () => {
  it('reads both keys and shortens the merge ref', () => {
    const { exec } = fakeExec({
      'config --get branch.thread/fix.remote': 'origin\n',
      'config --get branch.thread/fix.merge': 'refs/heads/feature/ACME-1-fix\n',
    });
    expect(readBinding(exec, '/wt', 'thread/fix', 'main')).toEqual({
      remote: 'origin',
      remoteBranch: 'feature/ACME-1-fix',
      prBase: 'main',
    });
  });

  it('leaves prBase null when the caller has none — git has nowhere to keep it', () => {
    const { exec } = fakeExec({
      'config --get branch.thread/fix.remote': 'origin\n',
      'config --get branch.thread/fix.merge': 'refs/heads/feature/ACME-1-fix\n',
    });
    expect(readBinding(exec, '/wt', 'thread/fix')?.prBase).toBeNull();
  });

  it('reads a HALF-SET upstream as unbound — a push built from half a binding picks its own destination', () => {
    const { exec } = fakeExec({ 'config --get branch.thread/fix.remote': 'origin\n' });
    expect(readBinding(exec, '/wt', 'thread/fix')).toBeNull();
  });

  it('reads a `.merge` with no `.remote` as unbound too', () => {
    const { exec } = fakeExec({
      'config --get branch.thread/fix.merge': 'refs/heads/feature/x\n',
    });
    expect(readBinding(exec, '/wt', 'thread/fix')).toBeNull();
  });

  it('reads nothing at all as unbound, and asks for a blank branch not at all', () => {
    const { exec, argv } = fakeExec({});
    expect(readBinding(exec, '/wt', 'thread/fix')).toBeNull();
    expect(readBinding(exec, '/wt', '   ')).toBeNull();
    // The blank branch short-circuits: only the real branch was ever asked about.
    expect(argv.every((call) => call.join(' ').includes('thread/fix'))).toBe(true);
  });
});

describe('writeBinding — the two keys `git push -u` would have written', () => {
  it('sets `.remote` and `.merge`, in that order, and writes no prBase anywhere', () => {
    const { exec, argv } = fakeExec({
      'config branch.thread/fix.remote origin': '',
      'config branch.thread/fix.merge refs/heads/feature/x': '',
    });
    writeBinding(exec, '/wt', 'thread/fix', {
      remote: 'origin',
      remoteBranch: 'feature/x',
      prBase: 'main',
    });
    expect(argv).toEqual([
      ['git', 'config', 'branch.thread/fix.remote', 'origin'],
      ['git', 'config', 'branch.thread/fix.merge', 'refs/heads/feature/x'],
    ]);
    // `git config`, NOT `git branch --set-upstream-to`, which demands a
    // remote-tracking ref that does not exist on a FIRST push.
    expect(argv.some((call) => call.includes('--set-upstream-to'))).toBe(false);
    expect(argv.flat().join(' ')).not.toContain('main');
  });

  it('VALIDATES typed input rather than sanitizing it, and writes nothing when it refuses', () => {
    const { exec, argv } = fakeExec({});
    expect(() =>
      writeBinding(exec, '/wt', 'thread/fix', {
        remote: 'origin',
        remoteBranch: 'bad..name',
        prBase: null,
      }),
    ).toThrow("'bad..name' is not a branch name");
    expect(argv).toEqual([]);
  });

  it('refuses a bad local branch and a bad remote name the same way', () => {
    const { exec } = fakeExec({});
    expect(() => writeBinding(exec, '/wt', 'bad..local', binding())).toThrow(
      "'bad..local' is not a branch name",
    );
    expect(() =>
      writeBinding(exec, '/wt', 'thread/fix', binding({ remote: 'not/a/remote' })),
    ).toThrow("'not/a/remote' is not the name of a remote");
  });
});

describe('bindingRefspec — spelled out on both sides, always', () => {
  it('names the source and the destination even when they are the same string', () => {
    expect(bindingRefspec('thread/fix', binding({ remoteBranch: 'feature/x' }))).toBe(
      'thread/fix:feature/x',
    );
    // A bare `git push <remote> <branch>` resolves through `push.default`; an
    // explicit `<src>:<dst>` is the same string on every machine.
    expect(bindingRefspec('feature/x', binding({ remoteBranch: 'feature/x' }))).toBe(
      'feature/x:feature/x',
    );
  });

  it('refuses to build a refspec out of a name git cannot carry', () => {
    expect(() => bindingRefspec('bad..name', binding())).toThrow('is not a branch name');
    expect(() => bindingRefspec('thread/fix', binding({ remoteBranch: 'x/' }))).toThrow(
      'is not a branch name',
    );
  });
});

describe('remoteNames', () => {
  it('reports git\'s own order, and an empty list when git could not answer', () => {
    expect(remoteNames(fakeExec({ remote: 'origin\nupstream\n' }).exec, '/wt')).toEqual([
      'origin',
      'upstream',
    ]);
    expect(remoteNames(fakeExec({}).exec, '/wt')).toEqual([]);
  });
});

// ── staleness ────────────────────────────────────────────

describe('bindingStaleness — two ways a binding goes bad, only one always a problem', () => {
  it('calls a MISSING REMOTE stale — the push has nowhere to go', () => {
    const { exec } = fakeExec({ remote: 'origin\n' });
    expect(bindingStaleness({ exec, path: '/wt', binding: binding() })).toBe(
      "this worktree publishes to a remote named 'upstream', which this repository no longer has",
    );
  });

  it('calls a present remote fresh, and does not reach the network to say so', () => {
    const { exec, argv } = fakeExec({ remote: 'origin\nupstream\n' });
    expect(bindingStaleness({ exec, path: '/wt', binding: binding() })).toBeNull();
    expect(argv.some((call) => call.includes('ls-remote'))).toBe(false);
  });

  it('does NOT call a never-pushed binding stale — a first push has nothing on the remote yet', () => {
    // The default is false precisely so the feature is usable: refusing the
    // very first push as "stale" would make binding impossible to act on.
    const { exec, argv } = fakeExec({
      remote: 'upstream\n',
      'ls-remote --heads upstream refs/heads/feature/x': '',
    });
    expect(bindingStaleness({ exec, path: '/wt', binding: binding() })).toBeNull();
    expect(argv.some((call) => call.includes('ls-remote'))).toBe(false);
  });

  it('calls a pushed-then-deleted branch stale when the caller says it published before', () => {
    const { exec } = fakeExec({
      remote: 'upstream\n',
      'ls-remote --heads upstream refs/heads/feature/x': '',
    });
    expect(
      bindingStaleness({ exec, path: '/wt', binding: binding(), expectRemoteBranch: true }),
    ).toBe("'feature/x' is no longer on upstream — it was published there before");
  });

  it('is fail-soft about an UNREACHABLE remote — being offline is not evidence of a wrong binding', () => {
    // `ls-remote` has no table entry, so it throws the way an unreachable
    // remote does. The push then fails at `git push`, with git's own message,
    // rather than being refused here for the wrong reason.
    const { exec } = fakeExec({ remote: 'upstream\n' });
    expect(
      bindingStaleness({ exec, path: '/wt', binding: binding(), expectRemoteBranch: true }),
    ).toBeNull();
  });

  it('does not read `feature/x-2` as proof that `feature/x` exists', () => {
    const { exec } = fakeExec({
      remote: 'upstream\n',
      'ls-remote --heads upstream refs/heads/feature/x': 'abc123\trefs/heads/feature/x-2\n',
    });
    expect(
      bindingStaleness({ exec, path: '/wt', binding: binding(), expectRemoteBranch: true }),
    ).toBe("'feature/x' is no longer on upstream — it was published there before");
  });

  it('accepts the exact ref when the remote really has it', () => {
    const { exec } = fakeExec({
      remote: 'upstream\n',
      'ls-remote --heads upstream refs/heads/feature/x': 'abc123\trefs/heads/feature/x\n',
    });
    expect(
      bindingStaleness({ exec, path: '/wt', binding: binding(), expectRemoteBranch: true }),
    ).toBeNull();
  });

  it('does not call a binding stale when git could not list the remotes at all', () => {
    // An empty list is "git did not answer", not "this repository has no
    // remotes" — refusing on it would break every checkout with a broken config.
    const { exec } = fakeExec({});
    expect(bindingStaleness({ exec, path: '/wt', binding: binding() })).toBeNull();
  });
});

// ── the learned rung's source ────────────────────────────

describe('lastBinding — what the repository already does, read from the repository', () => {
  /** A repo whose branches track things, including one the loops own. */
  const REPO = {
    'config --get-regexp ^branch\\..*\\.merge$':
      'branch.loop/fix.merge refs/heads/loop/fix\n' +
      'branch.release/v1.2.merge refs/heads/release/v1.2\n' +
      'branch.thread/old.merge refs/heads/feature/old\n',
    'for-each-ref --sort=-committerdate --format=%(refname:short) refs/heads/':
      'loop/fix\nthread/old\nrelease/v1.2\n',
    'config --get branch.thread/old.remote': 'origin\n',
    'config --get branch.release/v1.2.remote': 'upstream\n',
  };

  it('EXCLUDES `loop/*` — a loop\'s binding is a loop\'s, and its namespace is the one threads must not touch', () => {
    // `loop/fix` is the most recent branch by commit date, and it is skipped:
    // learning from it would teach every thread in a repository with an active
    // loop to publish under `loop/`.
    expect(lastBinding(fakeExec(REPO).exec, '/repo')).toEqual({
      remote: 'origin',
      remoteBranch: 'feature/old',
    });
  });

  it('splits a DOTTED branch name from both ends, not on the first dot', () => {
    // `branch.release/v1.2.merge` naively split reports `release/v1` — a branch
    // that does not exist, whose shape would be learned from nothing.
    const withoutThread = {
      ...REPO,
      'config --get-regexp ^branch\\..*\\.merge$':
        'branch.release/v1.2.merge refs/heads/release/v1.2\n',
    };
    expect(lastBinding(fakeExec(withoutThread).exec, '/repo')).toEqual({
      remote: 'upstream',
      remoteBranch: 'release/v1.2',
    });
  });

  it('SKIPS a `.merge` with no `.remote` and moves to the next branch', () => {
    const halfSet: Record<string, string> = { ...REPO };
    delete halfSet['config --get branch.thread/old.remote'];
    expect(lastBinding(fakeExec(halfSet).exec, '/repo')).toEqual({
      remote: 'upstream',
      remoteBranch: 'release/v1.2',
    });
  });

  it('returns null when nothing tracks anything — a ladder with no third rung falls to its fourth', () => {
    expect(lastBinding(fakeExec({}).exec, '/repo')).toBeNull();
  });

  it('returns null when every tracked branch is half-set', () => {
    expect(
      lastBinding(
        fakeExec({
          'config --get-regexp ^branch\\..*\\.merge$':
            'branch.thread/old.merge refs/heads/feature/old\n',
        }).exec,
        '/repo',
      ),
    ).toBeNull();
  });

  it('still counts branches git could not ORDER — a failed ref listing is not "no conventions"', () => {
    const unordered: Record<string, string> = { ...REPO };
    delete unordered['for-each-ref --sort=-committerdate --format=%(refname:short) refs/heads/'];
    // Config order now decides, and `loop/*` is still excluded.
    expect(lastBinding(fakeExec(unordered).exec, '/repo')).toEqual({
      remote: 'upstream',
      remoteBranch: 'release/v1.2',
    });
  });

  it('ignores config lines that are not `refs/heads/` merges', () => {
    expect(
      lastBinding(
        fakeExec({
          'config --get-regexp ^branch\\..*\\.merge$':
            'branch.weird.merge refs/tags/v1\n' +
            'branch.thread/old.merge refs/heads/feature/old\n',
          'config --get branch.thread/old.remote': 'origin\n',
        }).exec,
        '/repo',
      ),
    ).toEqual({ remote: 'origin', remoteBranch: 'feature/old' });
  });
});

/**
 * The unattended auto-bind (unattended-auto-branch). These defend the single
 * narrowing of "never guess": it fires ONLY when a run is unattended AND the
 * evidence is confident, and the `feat/` default that makes a confident rung
 * likely is opt-in so no attended surface changes.
 */
describe('autoBindDecision — the one narrowing of never-guess', () => {
  const sug = (source: 'pattern' | 'ticket' | 'learned' | 'local') => ({
    suggestion: 'feat/x',
    source,
  });

  it('applies only on a confident rung (pattern|ticket) when unattended', () => {
    expect(autoBindDecision(sug('pattern'), { unattended: true })).toBe('apply');
    expect(autoBindDecision(sug('ticket'), { unattended: true })).toBe('apply');
    expect(autoBindDecision(sug('learned'), { unattended: true })).toBe('ask');
    expect(autoBindDecision(sug('local'), { unattended: true })).toBe('ask');
  });

  it('never applies when attended, whatever the rung', () => {
    for (const source of ['pattern', 'ticket', 'learned', 'local'] as const) {
      expect(autoBindDecision(sug(source), { unattended: false })).toBe('ask');
    }
  });
});

describe('the built-in feat/ default is opt-in (applyBuiltinDefault)', () => {
  const base = { lastBinding: null, localBranch: 'thread/whatever' };

  it('is OFF by default — attended output stays the historical ladder', () => {
    const s = suggestRemoteBranch({ ...base, threadTitle: 'TPL-019 fix xyz' });
    expect(s.source).toBe('ticket');
    expect(s.suggestion.startsWith('feat/')).toBe(false);
  });

  it('with a ticket, yields feat/{ticket}-{slug} on the pattern rung', () => {
    const s = suggestRemoteBranch({
      ...base,
      threadTitle: 'TPL-019 fix xyz',
      applyBuiltinDefault: true,
    });
    expect(s.source).toBe('pattern');
    expect(s.suggestion).toBe('feat/TPL-019-fix-xyz');
  });

  it('with no ticket, falls to the second tier feat/{slug}', () => {
    const s = suggestRemoteBranch({
      ...base,
      threadTitle: 'fixing discovery',
      applyBuiltinDefault: true,
    });
    expect(s.source).toBe('pattern');
    expect(s.suggestion).toBe('feat/fixing-discovery');
  });

  it('an explicit pattern still wins over the built-in default', () => {
    const s = suggestRemoteBranch({
      ...base,
      pattern: 'release/{slug}',
      threadTitle: 'fixing discovery',
      applyBuiltinDefault: true,
    });
    expect(s.source).toBe('pattern');
    expect(s.suggestion).toBe('release/fixing-discovery');
  });

  it('exposes the two tiers, most-specific first', () => {
    expect(DEFAULT_REMOTE_BRANCH_PATTERNS).toEqual(['feat/{ticket}-{slug}', 'feat/{slug}']);
  });
});
