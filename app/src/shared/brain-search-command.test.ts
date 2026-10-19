import { isBrainSearchCommand, matchBrainSearch } from './brain-search-command'

describe('matchBrainSearch', () => {
  describe('spellings that reach the real CLI', () => {
    it('matches the plain verb and extracts the quoted query', () => {
      expect(matchBrainSearch('planflow-ai brain search "chat membership"')).toEqual({
        query: 'chat membership',
      })
    })

    it('matches the IDE PATH shim (absolute path with spaces)', () => {
      expect(
        matchBrainSearch(
          '/Users/u/Library/Application Support/flow/bin/planflow-ai brain search "seed injection"',
        ),
      ).toEqual({ query: 'seed injection' })
    })

    it('matches the bundled .mjs under Electron-as-Node', () => {
      expect(
        matchBrainSearch('ELECTRON_RUN_AS_NODE=1 /x/electron /y/planflow-ai.mjs brain search topic'),
      ).toEqual({ query: 'topic' })
    })

    it('matches the repo dev node path', () => {
      expect(matchBrainSearch('node dist/cli/index.js brain search "who writes rounds"')).toEqual({
        query: 'who writes rounds',
      })
    })

    it('matches npx and strips boolean flags from the query', () => {
      expect(matchBrainSearch('npx planflow-ai brain search topic --json')).toEqual({
        query: 'topic',
      })
    })
  })

  describe('query extraction', () => {
    it('handles single-quoted queries', () => {
      expect(matchBrainSearch("planflow-ai brain search 'learn session injection'")).toEqual({
        query: 'learn session injection',
      })
    })

    it('handles escaped double quotes embedded in the query', () => {
      expect(
        matchBrainSearch('planflow-ai brain search "chat \\"membership\\" flow"'),
      ).toEqual({ query: 'chat "membership" flow' })
    })

    it('handles apostrophes inside double-quoted queries', () => {
      expect(matchBrainSearch('planflow-ai brain search "what\'s stale"')).toEqual({
        query: "what's stale",
      })
    })

    it('joins unquoted multiword queries', () => {
      expect(matchBrainSearch('planflow-ai brain search chat membership --json')).toEqual({
        query: 'chat membership',
      })
    })

    it('extracts --scope and drops --limit and its value', () => {
      expect(
        matchBrainSearch('planflow-ai brain search "learn session" --scope resources --limit 5'),
      ).toEqual({ query: 'learn session', scope: 'resources' })
    })

    it('extracts --scope=value', () => {
      expect(matchBrainSearch('planflow-ai brain search topic --scope=resources')).toEqual({
        query: 'topic',
        scope: 'resources',
      })
    })

    it('ignores a trailing redirection and || echo fallback', () => {
      expect(
        matchBrainSearch(
          'planflow-ai brain search "chat membership retrieval" 2>/dev/null || echo "NO_BRAIN_CLI"',
        ),
      ).toEqual({ query: 'chat membership retrieval' })
    })

    it('ignores 2>&1 and a downstream pipe', () => {
      expect(matchBrainSearch('planflow-ai brain search "board render" 2>&1 | head -20')).toEqual({
        query: 'board render',
      })
    })
  })

  describe('non-matches', () => {
    it('rejects other planflow-ai verbs', () => {
      expect(matchBrainSearch('planflow-ai blueprint derive')).toBeNull()
      expect(matchBrainSearch('planflow-ai brain capture "x"')).toBeNull()
      expect(matchBrainSearch('planflow-ai state-query "topic" --scope resources')).toBeNull()
    })

    it('rejects bare "brain search" with no CLI invoker', () => {
      expect(matchBrainSearch('echo brain search')).toBeNull()
      expect(matchBrainSearch('brain search "x"')).toBeNull()
    })

    it('rejects grep/rg commands that merely mention the invocation', () => {
      expect(matchBrainSearch('grep -r "brain search" src/')).toBeNull()
      expect(matchBrainSearch('grep -rn "planflow-ai brain search" docs/')).toBeNull()
      expect(matchBrainSearch("rg 'planflow-ai brain search' --files-with-matches")).toBeNull()
    })
  })
})

describe('isBrainSearchCommand', () => {
  it('is exactly "matchBrainSearch found something"', () => {
    expect(isBrainSearchCommand('planflow-ai brain search "x"')).toBe(true)
    expect(isBrainSearchCommand('planflow-ai blueprint derive')).toBe(false)
    expect(isBrainSearchCommand('grep -rn "planflow-ai brain search" docs/')).toBe(false)
  })
})
