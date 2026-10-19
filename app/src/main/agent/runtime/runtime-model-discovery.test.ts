import { candidateRuntimeModels, discoverRuntimeModels } from './runtime-model-discovery'

const home = '/Users/qa'

/** A fake ~/.codex/sessions tree, newest-first by the numbers we hand back. */
function codexTree(files: Record<string, { body: string; at: number }>) {
  const dirs: Record<string, string[]> = {
    '/Users/qa/.codex/sessions': ['2025'],
    '/Users/qa/.codex/sessions/2025': ['11'],
    '/Users/qa/.codex/sessions/2025/11': ['29'],
    '/Users/qa/.codex/sessions/2025/11/29': Object.keys(files),
  }
  const base = '/Users/qa/.codex/sessions/2025/11/29/'
  return {
    homedirFn: () => home,
    env: {} as NodeJS.ProcessEnv,
    readdirFn: (path: string) => {
      const names = dirs[path]
      if (names === undefined) throw new Error('ENOENT')
      return names
    },
    readFileFn: (path: string) => {
      const entry = files[path.slice(base.length)]
      if (entry === undefined) throw new Error('ENOENT')
      return entry.body
    },
    mtimeFn: (path: string) => files[path.slice(base.length)]?.at ?? 0,
  }
}

describe('discoverRuntimeModels — Codex', () => {
  it('reads the models its own sessions recorded', () => {
    // The real shape: a rollout's opening lines carry the session's model.
    // Measured on this machine — gpt-5-codex, gpt-5, gpt-5.1-codex-max — while
    // Flow's picker offered one entry and the user was looking at Codex's own
    // list of several.
    const deps = codexTree({
      'rollout-a.jsonl': { body: '{"type":"session","model":"gpt-5.1-codex-max"}\n', at: 300 },
      'rollout-b.jsonl': { body: '{"type":"session","model":"gpt-5-codex"}\n', at: 200 },
    })
    expect(discoverRuntimeModels('codex', deps).sort()).toEqual(['gpt-5-codex', 'gpt-5.1-codex-max'])
  })

  it('ignores values that are not model ids', () => {
    const deps = codexTree({
      'rollout-a.jsonl': {
        body: '{"model":"gpt-5","note":{"model":"some model with spaces"},"p":{"model":"a/b"}}\n',
        at: 1,
      },
    })
    expect(discoverRuntimeModels('codex', deps)).toEqual(['gpt-5'])
  })

  it('answers nothing, rather than throwing, when there are no sessions', () => {
    expect(
      discoverRuntimeModels('codex', { homedirFn: () => home, env: {} as NodeJS.ProcessEnv }),
    ).toEqual([])
  })

  it('scans only the newest handful — that directory grows forever', () => {
    // The vault-scan lesson: 4,764 directories cost 2.5 s of main-process time
    // when something walked them all.
    const files: Record<string, { body: string; at: number }> = {}
    for (let i = 0; i < 40; i += 1) {
      files[`rollout-${String(i)}.jsonl`] = {
        body: `{"model":"m${String(i)}"}\n`,
        at: i,
      }
    }
    const found = discoverRuntimeModels('codex', codexTree(files))
    expect(found).toHaveLength(12)
    // …and it is the NEWEST twelve.
    expect(found).toContain('m39')
    expect(found).not.toContain('m0')
  })
})

describe('discoverRuntimeModels — Copilot', () => {
  it('reads the catalogue its own database keeps', () => {
    const models = discoverRuntimeModels('copilot', {
      homedirFn: () => home,
      env: {} as NodeJS.ProcessEnv,
      copilotModelsFn: () => ['claude-sonnet-4.5', 'gpt-5-mini'],
    })
    expect(models).toEqual(['claude-sonnet-4.5', 'gpt-5-mini'])
  })

  it('is empty when that database cannot be read — another program owns it', () => {
    expect(
      discoverRuntimeModels('copilot', {
        homedirFn: () => home,
        env: {} as NodeJS.ProcessEnv,
        copilotModelsFn: () => {
          throw new Error('SQLITE_CANTOPEN')
        },
      }),
    ).toEqual([])
  })
})

describe('discoverRuntimeModels — everyone else', () => {
  // WAS: "has nothing to discover for Claude, whose list is known". That was
  // the assumption, not a fact — the list was a hardcoded five, and an account
  // that gained a model was simply not shown it. Claude has its own describe
  // block above now; what is left here is a provider nobody has taught it.
  it('has nothing to discover for a runtime it does not know', () => {
    expect(discoverRuntimeModels('gemini')).toEqual([])
    expect(discoverRuntimeModels('')).toEqual([])
  })
})

describe('candidates — offered to try, never claimed', () => {
  it('lists ids a Copilot plan commonly offers', () => {
    // Measured against a real Copilot Business account: gpt-5-mini is accepted
    // and claude-sonnet-5 ran a turn — while gpt-5 and gpt-4.1 answer "not
    // available". The set is real and per-plan, so these are things to TRY,
    // kept apart from evidence. The list now LEADS with the current generation
    // (5.5) as the candidates most worth offering.
    const candidates = candidateRuntimeModels('copilot')
    expect(candidates).toContain('claude-opus-5.5')
    expect(candidates).toContain('claude-sonnet-5.5')
    expect(candidates).toContain('claude-haiku-5.5')
    expect(candidates).toContain('claude-sonnet-5')
    expect(candidates).toContain('gpt-5-mini')
    // Never one that was measured as refused here.
    expect(candidates).not.toContain('gpt-5')
    expect(candidates).not.toContain('gpt-4.1')
  })

  it('offers none for Codex, whose own sessions already say', () => {
    expect(candidateRuntimeModels('codex')).toEqual([])
    expect(candidateRuntimeModels('claude')).toEqual([])
  })
})

describe('claude — the runtime that used to be left out', () => {
  // Claude's picker was five hardcoded aliases, and the composer explicitly
  // skipped this module for it, so a model an account gained never appeared.
  // Its config turns out to be the richest source of the three.
  const config = (body: unknown): { env: NodeJS.ProcessEnv; readFileFn: () => string } => ({
    env: {},
    readFileFn: () => JSON.stringify(body),
  })

  it('takes the CLI’s own extra picker entries verbatim', () => {
    expect(
      discoverRuntimeModels(
        'claude',
        config({
          additionalModelOptionsCache: [
            { value: 'claude-fable-5-1[1m]', label: 'Fable', description: 'Most capable' },
          ],
        }),
      ),
    ).toEqual(['claude-fable-5-1[1m]'])
  })

  it('drops a sentinel that is not a model', () => {
    // A live config held exactly this beside a real entry. A sentinel in a
    // model picker is a turn that fails at send time.
    expect(
      discoverRuntimeModels(
        'claude',
        config({
          additionalModelOptionsCache: [
            { value: 'cc-update-required-1' },
            { value: 'claude-fable-5[1m]' },
          ],
        }),
      ),
    ).toEqual(['claude-fable-5[1m]'])
  })

  it('offers nothing for families the aliases already cover', () => {
    // The entitled list is every snapshot the account was ever granted —
    // eleven on the machine this was written on, back to a 2024 Opus. Offering
    // them all would bury the four names people use under a decade of history.
    expect(
      discoverRuntimeModels(
        'claude',
        config({
          modelAccessCache: [
            { apiName: 'claude-opus-5', entitled: true },
            { apiName: 'claude-sonnet-5', entitled: true },
            { apiName: 'claude-haiku-4-5-20251001', entitled: true },
            { apiName: 'claude-3-opus-20240229', entitled: true },
          ],
        }),
      ),
    ).toEqual([])
  })

  it('surfaces a family that did not exist when this code was written', () => {
    // THE WHOLE POINT. Nothing here names the families; a new one appears on
    // its own, and no edit ships to make that happen.
    expect(
      discoverRuntimeModels(
        'claude',
        config({
          modelAccessCache: [
            { apiName: 'claude-opus-5', entitled: true },
            { apiName: 'claude-atlas-1', entitled: true },
          ],
        }),
      ),
    ).toEqual(['claude-atlas-1'])
  })

  it('never offers a model the account is not entitled to', () => {
    expect(
      discoverRuntimeModels(
        'claude',
        config({ modelAccessCache: [{ apiName: 'claude-atlas-1', entitled: false }] }),
      ),
    ).toEqual([])
  })

  it('reads CLAUDE_CONFIG_DIR, because the CLI does', () => {
    // Reading the wrong file reports the wrong account's models. This session's
    // own shell has the variable set.
    const paths: string[] = []
    discoverRuntimeModels('claude', {
      env: { CLAUDE_CONFIG_DIR: '/elsewhere' },
      readFileFn: (path) => {
        paths.push(path)
        return '{}'
      },
    })
    expect(paths).toEqual(['/elsewhere/.claude.json'])
  })

  it('falls back to the aliases when there is no config at all', () => {
    // A machine that has never run the CLI, a moved schema, a partial write
    // caught mid-parse: all mean "the static list stands", never a throw.
    for (const body of ['', 'not json', 'null', '[]', '{"modelAccessCache":"nope"}']) {
      expect(
        discoverRuntimeModels('claude', { env: {}, readFileFn: () => body }),
      ).toEqual([])
    }
    expect(
      discoverRuntimeModels('claude', {
        env: {},
        readFileFn: () => {
          throw new Error('ENOENT')
        },
      }),
    ).toEqual([])
  })
})
