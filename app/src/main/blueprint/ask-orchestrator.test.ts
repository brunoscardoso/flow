// runAsk end to end with every dependency faked (allowed-pattern #26 makes
// that the only way to build one). Each test records the CLI argv the
// orchestrator asked for, so a write is asserted by what was RUN, not by what
// the result says.

import type { AskStateEvent } from '../../shared/ask-contract'
import type { CagedSessionParams, CliRunResult } from '../agent/learn-session'
import type { AskContext, CondensedThread } from './ask-context'
import { buildDigPrompt, buildFastPrompt, parseAskReturn, runAsk, type AskDeps, type AskRunInput } from './ask-orchestrator'

const ROOT = '/repo'

type Session = (params: CagedSessionParams) => Promise<string>

interface Harness {
  deps: AskDeps
  sessions: CagedSessionParams[]
  cli: string[][]
  emitted: AskStateEvent[]
  inputs: Array<Record<string, unknown>>
}

function context(patch: Partial<AskContext> = {}): AskContext {
  return {
    hits: [],
    features: [{ id: 'feature:connectors', name: 'Connectors', kind: 'core', summary: '', tagged: true }],
    relations: [],
    notes: [],
    threads: [],
    knownIds: ['feature:connectors', 'feature:connectors/credentials'],
    ...patch,
  }
}

function thread(patch: Partial<CondensedThread> = {}): CondensedThread {
  return {
    threadId: 't1',
    title: 'Vault work',
    checkout: '/repo-wt',
    personMessages: ['move secrets'],
    answers: ['done'],
    filesChanged: [],
    linkedDocs: [],
    branch: 'feat/vault',
    base: 'main',
    merged: false,
    ...patch,
  }
}

const SAVED_STDOUT = `${JSON.stringify({ action: 'qa-record', entry: { id: 'qa-saved-1' } })}\n`

function harness(
  sessionQueue: Session[],
  over: {
    context?: AskContext
    cli?: (args: readonly string[]) => CliRunResult
    branch?: string
    limits?: AskDeps['limits']
  } = {},
): Harness {
  const sessions: CagedSessionParams[] = []
  const cli: string[][] = []
  const emitted: AskStateEvent[] = []
  const inputs: Array<Record<string, unknown>> = []
  let clock = 0
  const deps: AskDeps = {
    runSession: (params) => {
      sessions.push(params)
      const next = sessionQueue.shift()
      if (next === undefined) throw new Error('an unexpected session was started')
      return next(params)
    },
    runCli: async (_cwd, args) => {
      cli.push([...args])
      if (over.cli !== undefined) return over.cli(args)
      if (args[1] === 'qa') return { ok: true, stdout: SAVED_STDOUT }
      return { ok: true, stdout: '' }
    },
    git: async (_cwd, args) =>
      args[0] === 'rev-parse' && args.includes('--abbrev-ref')
        ? { ok: true, stdout: `${over.branch ?? 'main'}\n` }
        : { ok: false, stdout: '' },
    now: () => (clock += 1000),
    gatherContext: async () => over.context ?? context(),
    routing: () => null,
    authEnv: async () => undefined,
    author: async () => 'Ana',
    fileExists: async () => true,
    writeInputFile: async (json) => {
      inputs.push(JSON.parse(json) as Record<string, unknown>)
      return { path: `/tmp/ask-input-${inputs.length}.json`, cleanup: async () => undefined }
    },
    emit: (event) => emitted.push(event),
    ...(over.limits !== undefined ? { limits: over.limits } : {}),
  }
  return { deps, sessions, cli, emitted, inputs }
}

function request(stop = new AbortController()): AskRunInput {
  return {
    askId: 'ask-1',
    rootId: ROOT,
    question: 'Where do connector secrets live?',
    tags: ['feature:connectors', 'feature:ghost'],
    conversationIds: [],
    stopSignal: stop.signal,
  }
}

const reply = (value: Record<string, unknown>): Session => async () => JSON.stringify(value)

const ENOUGH = reply({
  explanation: 'In the vault, per the Connectors notes.',
  knowledge: 'enough',
  sources: [{ label: 'Connectors › Credentials', featureId: 'feature:connectors/credentials' }],
})
const THIN = reply({ explanation: 'Probably the vault.', knowledge: 'thin', sources: [] })

/** A dig that reads `count` files, then waits until it is aborted. */
function readingDig(count: number, during?: () => void): Session {
  return (params) =>
    new Promise((resolve) => {
      params.abortSignal?.addEventListener('abort', () => resolve(''), { once: true })
      for (let i = 0; i < count; i += 1) params.onRead?.(`${ROOT}/src/file-${i}.ts`)
      during?.()
    })
}

const observeCalls = (cli: string[][]): string[][] => cli.filter((args) => args[1] === 'observe')
const qaCalls = (cli: string[][]): string[][] => cli.filter((args) => args[1] === 'qa')

describe('runAsk — the fast pass', () => {
  it('does not dig when the knowledge was enough, and saves through qa record', async () => {
    const h = harness([ENOUGH])
    const result = await runAsk(request(), h.deps)

    expect(result.outcome).toBe('done')
    expect(h.sessions).toHaveLength(1)
    expect(h.sessions[0].maxTurns).toBeLessThanOrEqual(4)
    expect(result.answer).toMatchObject({ confidence: 'first', thin: false, partial: false, savedId: 'qa-saved-1' })
    expect(result.answer?.sources).toEqual([
      { n: 1, label: 'Connectors › Credentials', featureId: 'feature:connectors/credentials' },
    ])
    expect(qaCalls(h.cli)).toEqual([['blueprint', 'qa', 'record', '--input', '/tmp/ask-input-1.json', '--json']])
    expect(observeCalls(h.cli)).toEqual([])
    // A tag the Blueprint does not know is dropped before the save.
    expect(h.inputs[0]).toMatchObject({ author: 'Ana', tags: ['feature:connectors'], usedConversation: false, conversationCount: 0 })
    expect(h.emitted[h.emitted.length - 1].phase).toEqual({ kind: 'done' })
  })

  it('a follow-up saves through qa follow-up naming its parent', async () => {
    const h = harness([ENOUGH])
    await runAsk({ ...request(), followUpOf: 'qa-parent' }, h.deps)
    expect(qaCalls(h.cli)[0].slice(0, 3)).toEqual(['blueprint', 'qa', 'follow-up'])
    expect(h.inputs[0]).toMatchObject({ parentId: 'qa-parent' })
  })
})

describe('runAsk — the dig', () => {
  it('stops at the read cap and keeps the fast answer, marked partial', async () => {
    const h = harness([THIN, readingDig(10)], { limits: { digMaxReads: 3 } })
    const result = await runAsk(request(), h.deps)

    expect(h.sessions).toHaveLength(2)
    expect(result.outcome).toBe('partial')
    expect(result.answer).toMatchObject({ explanation: 'Probably the vault.', partial: true, savedId: 'qa-saved-1' })
    expect(result.answer?.couldNotFind).toMatch(/limit/)
    const digging = h.emitted.filter((event) => event.phase.kind === 'digging')
    const last = digging[digging.length - 1].phase
    expect(last.kind === 'digging' && last.reads).toBe(3)
    expect(h.inputs[0]).toMatchObject({ partial: true })
    expect(h.emitted[h.emitted.length - 1].phase).toEqual({ kind: 'partial' })
  })

  it('Stop here ends the dig and keeps the best answer, marked partial', async () => {
    const stop = new AbortController()
    const h = harness([THIN, readingDig(1, () => stop.abort())])
    const result = await runAsk(request(stop), h.deps)

    expect(h.sessions).toHaveLength(2)
    expect(result.outcome).toBe('partial')
    expect(result.answer).toMatchObject({ explanation: 'Probably the vault.', partial: true })
    expect(result.answer?.couldNotFind).toMatch(/Stopped/)
  })

  it('a checked answer from the dig replaces the fast one', async () => {
    const h = harness([
      THIN,
      reply({ explanation: 'In the vault service, checked.', knowledge: 'enough', sources: [{ label: 'vault', file: 'src/vault.ts' }] }),
    ])
    const result = await runAsk(request(), h.deps)
    expect(result.outcome).toBe('done')
    expect(result.answer).toMatchObject({ explanation: 'In the vault service, checked.', confidence: 'checked', partial: false })
    expect(result.answer?.sources).toEqual([{ n: 1, label: 'vault', file: 'src/vault.ts' }])
  })

  it('a malformed return still shows its explanation', async () => {
    const h = harness([async () => 'Not JSON — the vault, I think.', async () => '```\nThe vault holds them.\n```'])
    const result = await runAsk(request(), h.deps)
    expect(result.outcome).toBe('done')
    expect(result.answer?.explanation).toBe('The vault holds them.')
    expect(result.answer?.confidence).toBe('checked')
    expect(h.inputs[0]).toMatchObject({ answer: 'The vault holds them.' })
  })
})

describe('runAsk — writes', () => {
  const DIG_WITH_FACTS = reply({
    explanation: 'Secrets are in the vault.',
    knowledge: 'enough',
    sources: [],
    facts: [
      { text: 'The vault encrypts at rest.', file: 'src/vault.ts', symbol: 'encrypt' },
      { text: 'Rotation is weekly.', file: 'src/rotate.ts' },
    ],
  })

  it('records the dig facts through observe', async () => {
    const h = harness([THIN, DIG_WITH_FACTS])
    const result = await runAsk(request(), h.deps)
    expect(observeCalls(h.cli)).toEqual([
      [
        'blueprint', 'observe', '--lenient-anchors', '--conflict-scope', 'primary',
        '--note=The vault encrypts at rest.', '--anchor', 'file:src/vault.ts', '--anchor', 'symbol:src/vault.ts#encrypt',
      ],
      ['blueprint', 'observe', '--lenient-anchors', '--conflict-scope', 'primary', '--note=Rotation is weekly.', '--anchor', 'file:src/rotate.ts'],
    ])
    expect(result.answer).toMatchObject({ factsLearned: 2, factsSaved: true })
  })

  it('observe failing still saves the answer, with factsSaved false', async () => {
    const h = harness([THIN, DIG_WITH_FACTS], {
      cli: (args) => (args[1] === 'observe' ? { ok: false, stdout: '', error: 'observe refused' } : { ok: true, stdout: SAVED_STDOUT }),
    })
    const result = await runAsk(request(), h.deps)
    expect(observeCalls(h.cli)).toHaveLength(2)
    expect(result.outcome).toBe('done')
    expect(result.answer).toMatchObject({ factsLearned: 0, factsSaved: false, savedId: 'qa-saved-1' })
    expect(qaCalls(h.cli)).toHaveLength(1)
  })

  it('a failed save is an error state that keeps the answer, with no command in its sentence', async () => {
    const payload = { action: 'qa-record', refused: 'busy', detail: 'the log is busy — retry with `planflow-ai blueprint qa record --input x`' }
    const h = harness([ENOUGH], {
      cli: () => ({ ok: false, stdout: `${JSON.stringify(payload)}\nqa refused: busy — ${payload.detail}\n` }),
    })
    const result = await runAsk(request(), h.deps)

    expect(qaCalls(h.cli)).toHaveLength(1)
    expect(result.outcome).toBe('error')
    expect(result.answer?.explanation).toBe('In the vault, per the Connectors notes.')
    expect(result.answer?.savedId).toBeUndefined()
    expect(result.error).toMatch(/^The answer couldn't be saved\. The log is busy/)
    expect(result.error).not.toMatch(/planflow-ai|`|--input/)
    const last = h.emitted[h.emitted.length - 1]
    expect(last.phase).toEqual({ kind: 'error', sentence: result.error })
    expect(last.answer?.explanation).toBe('In the vault, per the Connectors notes.')
  })

  it('a save that fails without a refusal says so plainly', async () => {
    const h = harness([ENOUGH], { cli: () => ({ ok: false, stdout: '', error: 'spawn failed' }) })
    const result = await runAsk(request(), h.deps)
    expect(result.outcome).toBe('error')
    expect(result.error).toBe("The answer couldn't be saved.")
  })

  it('an unmerged branch is reported in progress, and no fact is written while on it', async () => {
    const h = harness([THIN, DIG_WITH_FACTS], { context: context({ threads: [thread()] }), branch: 'feat/vault' })
    const result = await runAsk({ ...request(), conversationIds: ['t1'] }, h.deps)

    // The positive: the dig ran and returned facts, and the answer was saved.
    expect(h.sessions).toHaveLength(2)
    expect(qaCalls(h.cli)).toHaveLength(1)
    expect(result.answer?.branchInProgress).toBe('Already in progress on branch feat/vault (not merged)')
    expect(h.inputs[0]).toMatchObject({ branchInProgress: result.answer?.branchInProgress, usedConversation: true, conversationCount: 1 })
    // Nothing from the conversation crosses into the saved record.
    expect(JSON.stringify(h.inputs[0])).not.toContain('move secrets')
    expect(observeCalls(h.cli)).toEqual([])
    expect(result.answer).toMatchObject({ factsLearned: 0 })
  })

  it('the same unmerged conversation does not stop facts when the checkout is on another branch', async () => {
    const h = harness([THIN, DIG_WITH_FACTS], { context: context({ threads: [thread()] }), branch: 'main' })
    const result = await runAsk({ ...request(), conversationIds: ['t1'] }, h.deps)
    expect(observeCalls(h.cli)).toHaveLength(2)
    expect(result.answer?.branchInProgress).toBe('Already in progress on branch feat/vault (not merged)')
  })
  it('a conversation whose merge state is unknown is not reported in progress', async () => {
    const h = harness([THIN, DIG_WITH_FACTS], { context: context({ threads: [thread({ merged: null })] }), branch: 'feat/vault' })
    const result = await runAsk({ ...request(), conversationIds: ['t1'] }, h.deps)
    expect(qaCalls(h.cli)).toHaveLength(1)
    expect(result.answer?.branchInProgress).toBeUndefined()
    expect(h.inputs[0]).not.toHaveProperty('branchInProgress')
    expect(observeCalls(h.cli)).toHaveLength(2)
  })
})

describe('runAsk — state events', () => {
  it('are sent only when the steps or the answer change', async () => {
    const dig: Session = async (params) => {
      for (let i = 0; i < 5; i += 1) params.onActivity?.('tool', 'Grep')
      params.onActivity?.('thinking')
      params.onRead?.(`${ROOT}/src/a.ts`)
      params.onActivity?.('thinking')
      params.onActivity?.('writing')
      params.onActivity?.('writing')
      return JSON.stringify({ explanation: 'Checked.', knowledge: 'enough', sources: [] })
    }
    const h = harness([THIN, dig])
    await runAsk(request(), h.deps)

    const shape = h.emitted.map((event) =>
      event.phase.kind === 'digging' ? `digging:${event.phase.steps.map((s) => s.label).join('|')}` : event.phase.kind,
    )
    expect(shape).toEqual([
      'fast',
      'digging:Looking through the code',
      'digging:Looking through the code|Searching the code',
      'digging:Looking through the code|Searching the code|Read src/a.ts',
      'digging:Looking through the code|Searching the code|Read src/a.ts|Writing the answer',
      'done',
    ])
    // The fast answer rides along on the dig events; the step marked current is the newest.
    const lastDig = h.emitted[4]
    expect(lastDig.answer?.explanation).toBe('Probably the vault.')
    expect(lastDig.phase.kind === 'digging' && lastDig.phase.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'current'])
  })

  it('a dependency that throws still ends in an error state', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const h = harness([ENOUGH])
    h.deps.gatherContext = async () => {
      throw new Error('boom')
    }
    const result = await runAsk(request(), h.deps)
    expect(result.outcome).toBe('error')
    expect(h.emitted[h.emitted.length - 1].phase.kind).toBe('error')
    expect(h.cli).toEqual([])
    warn.mockRestore()
  })
})

describe('the answer is asked for as structured markdown', () => {
  it('both prompts ask for a one-sentence lead, ### sections, - lists, backticks, positional [n] and "Not covered:"', () => {
    for (const prompt of [buildFastPrompt('How?', [], context()), buildDigPrompt('How?', [], context(), null, 10)]) {
      expect(prompt).toContain('line 1 is the answer in ONE sentence')
      expect(prompt).toContain('### ')
      expect(prompt).toContain('\\"- \\" bullet lines')
      expect(prompt).toContain('backticks')
      expect(prompt).toContain('cite a source as [n], n being its position in \\"sources\\"')
      expect(prompt).toContain('Not covered: ')
      expect(prompt).toContain('`feature:<slug>`')
    }
  })

  it('the dig prompt is still one valid JSON shape: a comma before the facts', () => {
    const prompt = buildDigPrompt('How?', [], context(), null, 10)
    expect(prompt).toMatch(/or null,\n {2}"facts"/)
  })

  it('a structured explanation survives the parse with its line breaks', () => {
    const parsed = parseAskReturn(JSON.stringify({ explanation: 'Lead.\n\n### Part\n- a [1]', knowledge: 'enough', sources: [] }))
    expect(parsed?.explanation).toBe('Lead.\n\n### Part\n- a [1]')
  })
})
