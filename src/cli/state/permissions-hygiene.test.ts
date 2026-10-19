/**
 * Unit tests for the permissions-suggest hygiene gate.
 *
 * Pure, table-driven — no fs, no mocks. Covers every rule class (mutating,
 * wildcard runner, auto-allowed, existing-allow coverage, existing-deny wins),
 * the precedence order, the npm-`i` shorthand vs `docker i` distinction, the
 * bidirectional deny overlap, the `Bash(<prefix>:*)` variant, and the
 * determinism guarantees (input order preserved, stable reason strings).
 */

import type { SuggestCandidate } from './permissions-types.js';

const { applyHygiene } = await import('./permissions-hygiene.js');

/** Build a Bash candidate for `family` (rule rendered like the real pipeline). */
const bash = (family: string): SuggestCandidate => ({
  tool: 'Bash',
  family,
  rule: `Bash(${family} *)`,
  approvals: 2,
  sources: ['transcripts'],
});

/** Run one candidate and return whether it survived + its skip reason. */
function gate(
  candidate: SuggestCandidate,
  allow: string[] = [],
  deny: string[] = [],
): { suggested: boolean; reason: string | undefined } {
  const result = applyHygiene([candidate], allow, deny);
  return {
    suggested: result.suggested.length === 1,
    reason: result.skipped[0]?.reason,
  };
}

describe('applyHygiene', () => {
  describe('mutating families are never suggested', () => {
    for (const family of ['git push', 'git commit', 'git merge', 'git rebase', 'git reset', 'rm', 'mv']) {
      it(`skips ${family}`, () => {
        const { suggested, reason } = gate(bash(family))
        expect(suggested).toBe(false)
        expect(reason).toBe('mutating operation — never auto-allowed')
      })
    }

    it('skips any <cli> install|publish|deploy|save|backfill via the verb-suffix rule', () => {
      for (const family of ['npm install', 'cargo publish', 'vercel deploy', 'db save', 'jobs backfill']) {
        expect(gate(bash(family)).suggested).toBe(false)
      }
    })

    it("treats `npm i` as install but lets `docker i` pass (not an install shorthand)", () => {
      expect(gate(bash('npm i')).suggested).toBe(false)
      expect(gate(bash('docker i')).suggested).toBe(true)
    })
  })

  describe('wildcard-equivalent runners are never suggested', () => {
    for (const family of ['npx', 'bunx', 'eval', 'xargs', 'sudo', 'sh', 'bash', 'zsh', 'node', 'bun run']) {
      it(`skips ${family}`, () => {
        const { suggested, reason } = gate(bash(family))
        expect(suggested).toBe(false)
        expect(reason).toBe('wildcard-equivalent runner (arbitrary code execution)')
      })
    }
  })

  describe('harness auto-allowed families add noise', () => {
    for (const family of ['git status', 'git log', 'git diff', 'ls', 'cat', 'pwd', 'which']) {
      it(`skips ${family}`, () => {
        const { suggested, reason } = gate(bash(family))
        expect(suggested).toBe(false)
        expect(reason).toBe('already auto-allowed by the harness')
      })
    }
  })

  describe('existing allow coverage', () => {
    it('skips a family already covered by a broader Bash prefix rule', () => {
      const { suggested, reason } = gate(bash('cargo build'), ['Bash(cargo *)'])
      expect(suggested).toBe(false)
      expect(reason).toBe('already covered by Bash(cargo *)')
    })

    it('skips an exact rule-string match', () => {
      const { suggested, reason } = gate(bash('jest'), ['Bash(jest *)'])
      expect(suggested).toBe(false)
      expect(reason).toBe('already covered by Bash(jest *)')
    })

    it('parses the Bash(<prefix>:*) variant users hand-write', () => {
      expect(gate(bash('cargo build'), ['Bash(cargo:*)']).suggested).toBe(false)
    })

    it('coverage is one-directional — a narrower allow does NOT cover a broader candidate', () => {
      // Bash(git commit *) must not be treated as covering the broad `git` family.
      expect(gate(bash('git'), ['Bash(git commit *)']).suggested).toBe(true)
    })
  })

  describe('existing deny always wins', () => {
    it('skips a candidate a deny rule covers, with the deny reason', () => {
      const { suggested, reason } = gate(bash('cargo build'), [], ['Bash(cargo *)'])
      expect(suggested).toBe(false)
      expect(reason).toBe('matches existing deny rule Bash(cargo *) — deny always wins')
    })

    it('is bidirectional — a NARROWER deny still blocks a broader candidate', () => {
      // deny Bash(git push origin *) blocks suggested Bash(git push *).
      expect(gate(bash('git push'), [], ['Bash(git push origin *)']).suggested).toBe(false)
    })

    it('deny takes precedence over a would-be suggestion', () => {
      expect(gate(bash('jest'), [], ['Bash(jest *)']).suggested).toBe(false)
    })
  })

  describe('non-Bash candidates', () => {
    const webfetch: SuggestCandidate = {
      tool: 'WebFetch',
      family: 'domain:example.com',
      rule: 'WebFetch(domain:example.com)',
      approvals: 3,
      sources: ['transcripts'],
    }

    it('are subject only to deny/coverage gates (family tables are Bash-only)', () => {
      expect(gate(webfetch).suggested).toBe(true)
      expect(gate(webfetch, ['WebFetch(domain:example.com)']).suggested).toBe(false)
      expect(gate(webfetch, [], ['WebFetch(domain:example.com)']).suggested).toBe(false)
    })
  })

  describe('determinism', () => {
    it('preserves input order across both outputs and passes clean families', () => {
      const candidates = [bash('jest'), bash('git push'), bash('tsc'), bash('npx')]
      const result = applyHygiene(candidates, [], [])
      expect(result.suggested.map((candidate) => candidate.family)).toEqual(['jest', 'tsc'])
      expect(result.skipped.map((skip) => skip.candidate)).toEqual(['Bash(git push *)', 'Bash(npx *)'])
    })
  })
})
