/**
 * Tests for the decisions the `worktree bind | push | pr` verbs make BEFORE
 * they touch git or `gh`.
 *
 * THE FAILURE THESE GUARD is the one the plan's risk table named: `gh pr
 * create` works its repository out from the checkout's `origin`, so a thread
 * bound to a fork, a mirror or a second remote opens its pull request against
 * the WRONG repository and reports success. `parseRepoSlug` is the only place
 * the right answer exists, and the only way it can be wrong is by GUESSING —
 * so most of what follows is a list of strings that look like `owner/repo` and
 * must not be read as one.
 *
 * Pure — no exec, no git, no network.
 */

const { firstUrl, parseRepoSlug, previousPushRecord, resolvePrBase } = await import(
  './remote-target.js'
);

// ── which base a pull request opens against ──────────────

describe('resolvePrBase — four sources, most deliberate first', () => {
  const ALL = {
    override: 'hotfix',
    prBase: 'develop',
    worktreeBase: 'release/2',
    configBranch: 'main',
  };

  it('takes what somebody typed just now over everything recorded', () => {
    expect(resolvePrBase(ALL)).toBe('hotfix');
  });

  it('falls to the base recorded WITH the binding', () => {
    expect(resolvePrBase({ ...ALL, override: null })).toBe('develop');
  });

  it('falls to the branch the worktree was actually cut from', () => {
    expect(resolvePrBase({ ...ALL, override: null, prBase: null })).toBe('release/2');
  });

  it('falls to the project default last', () => {
    expect(
      resolvePrBase({ ...ALL, override: null, prBase: null, worktreeBase: null }),
    ).toBe('main');
  });

  it('returns NULL when nobody has said — never `main`', () => {
    // Guessing here is the same class of mistake as guessing a remote branch:
    // it succeeds, it looks right, and the pull request opens against a branch
    // nobody chose. The verb refuses on this null.
    expect(resolvePrBase({})).toBeNull();
    expect(
      resolvePrBase({ override: null, prBase: null, worktreeBase: null, configBranch: null }),
    ).toBeNull();
  });

  it('reads a BLANK string as an absence, at every rung', () => {
    // `.flowconfig` writes `branch:` with no value to mean "not configured",
    // and an empty base would reach `gh` as a flag with a missing argument.
    expect(resolvePrBase({ override: '', prBase: '   ', configBranch: 'main' })).toBe('main');
    expect(resolvePrBase({ configBranch: '   ' })).toBeNull();
  });

  it('trims what it returns', () => {
    expect(resolvePrBase({ override: '  develop  ' })).toBe('develop');
  });
});

// ── which repository a remote names ──────────────────────

describe('parseRepoSlug — three spellings, one answer', () => {
  it.each([
    ['https://github.com/acme/widgets.git', 'acme/widgets'],
    ['https://github.com/acme/widgets', 'acme/widgets'],
    // The scp form has no scheme at all, which is why this cannot be a
    // `new URL()` one-liner.
    ['git@github.com:acme/widgets.git', 'acme/widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'acme/widgets'],
    // A PORT is not a path segment. Converting the `:` here — as the scp form
    // needs — would invent a segment out of `2222` and shift the answer by one.
    ['ssh://git@github.com:2222/acme/widgets.git', 'acme/widgets'],
    ['https://user:token@github.com/acme/widgets.git', 'acme/widgets'],
    ['https://github.com/acme/widgets/', 'acme/widgets'],
    ['  https://github.com/acme/widgets.git  ', 'acme/widgets'],
  ])('reads %j as %j', (url, expected) => {
    expect(parseRepoSlug(url)).toBe(expected);
  });

  it.each([
    // A directory on this machine, however many segments it happens to have.
    // THE PROBE THAT MADE THE HOST CHECK NECESSARY: `/tmp/scratch/elsewhere`
    // has exactly three segments, like `github.com/owner/repo`, and was read
    // as the repository `scratch/elsewhere` — a slug `gh` would have taken
    // seriously.
    ['/tmp/scratch/elsewhere'],
    ['~/repos/thing'],
    ['../sibling/repo'],
    ['./sibling/repo'],
    ['C:\\repos\\thing'],
    ['file:///tmp/scratch/elsewhere'],
    // A namespace deeper than `owner/repo` — some self-hosted forges. Not ours
    // to flatten.
    ['https://gitlab.com/group/sub/repo.git'],
    // A single-label intranet host. The dot is the test, and this is its cost:
    // null, and the verb says it cannot tell, which is the right answer to
    // give about a guess.
    ['https://intranet/acme/widgets.git'],
    ['ssh://git@intranet:2222/acme/widgets.git'],
    // Not enough segments to name a repository.
    ['https://github.com/acme'],
    ['git@github.com:widgets.git'],
    [''],
    ['   '],
  ])('reads %j as naming no repository', (url) => {
    expect(parseRepoSlug(url)).toBeNull();
  });

  it('treats absence like blankness', () => {
    expect(parseRepoSlug(null)).toBeNull();
    expect(parseRepoSlug(undefined)).toBeNull();
  });
});

// ── what an external tool's transcript said ──────────────

describe('firstUrl — read, never parsed for meaning', () => {
  it('takes the first URL, whatever prose `gh` wrapped around it', () => {
    expect(
      firstUrl(
        'Creating pull request for feature/x into main in acme/widgets\n' +
          'https://github.com/acme/widgets/pull/42\n',
      ),
    ).toBe('https://github.com/acme/widgets/pull/42');
  });

  it('takes the FIRST when a transcript carries several', () => {
    expect(firstUrl('see http://a.example/1 and https://b.example/2')).toBe('http://a.example/1');
  });

  it('returns null rather than inventing one — a pull request that already existed prints something else', () => {
    expect(firstUrl('a pull request for branch "feature/x" already exists')).toBeNull();
    expect(firstUrl('')).toBeNull();
  });

  it('stops at whitespace, so trailing prose never rides along', () => {
    expect(firstUrl('opened https://github.com/acme/widgets/pull/42 just now')).toBe(
      'https://github.com/acme/widgets/pull/42',
    );
  });
});

// ── the rename record ────────────────────────────────────

describe('previousPushRecord — what still sits on the remote after a rename', () => {
  it('records the published name a bind is moving away from', () => {
    expect(
      previousPushRecord({ stamped: null, renamedFrom: 'feature/old', remoteBranch: 'feature/new' }),
    ).toBe('feature/old');
  });

  it('keeps only the MOST RECENT rename — the first name is not what anyone goes looking for', () => {
    expect(
      previousPushRecord({
        stamped: 'feature/first',
        renamedFrom: 'feature/second',
        remoteBranch: 'feature/third',
      }),
    ).toBe('feature/second');
  });

  it('CLEARS the record when the binding comes back to the name it records', () => {
    // The old branch is the current branch again; a note saying otherwise
    // would be wrong.
    expect(
      previousPushRecord({ stamped: 'feature/old', renamedFrom: null, remoteBranch: 'feature/old' }),
    ).toBeNull();
  });

  it('leaves an existing record alone on an unrelated bind', () => {
    // A rename away from a name that was NEVER pushed erases nothing: the
    // branch the record points at is still on the remote, and still the one
    // nobody is watching.
    expect(
      previousPushRecord({ stamped: 'feature/old', renamedFrom: null, remoteBranch: 'feature/new' }),
    ).toBe('feature/old');
  });

  it('records nothing when nothing was published and nothing was stamped', () => {
    expect(previousPushRecord({ stamped: null, renamedFrom: null, remoteBranch: 'feature/x' })).toBeNull();
  });

  it('ignores a rename that is not one', () => {
    expect(
      previousPushRecord({ stamped: null, renamedFrom: 'feature/x', remoteBranch: 'feature/x' }),
    ).toBeNull();
  });

  it('reads blank strings as absences on both sides', () => {
    expect(
      previousPushRecord({ stamped: '   ', renamedFrom: '  ', remoteBranch: 'feature/x' }),
    ).toBeNull();
    expect(
      previousPushRecord({ stamped: '  feature/old  ', renamedFrom: null, remoteBranch: 'feature/new' }),
    ).toBe('feature/old');
  });
});
