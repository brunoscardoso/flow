// Tests for learn-session — the caged SPIKE mechanism + learn-pass executor.
// The SDK is never loaded: the option-builder is tested directly, the caged
// session runs against a mocked queryFn, and the executor mocks the session +
// CLI while writing to a real temp dir (so doc/changelog behavior is real).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

import type { BundledCli } from '../blueprint/derive-runner'
import {
  buildCagedOptions,
  createCagedCanUseTool,
  createLearnReadHooks,
  runCagedSession,
  rankModuleFiles,
  buildLearnPrompt,
  parseLearnOutput,
  moduleSlug,
  writeModuleDoc,
  buildObserveArgs,
  buildAdjudicateArgs,
  buildContradictionObserveArgs,
  capClaimFiles,
  isClaimFilePath,
  parseObserveFingerprint,
  renderFeatureRoster,
  ROSTER_SUMMARY_MAX_CHARS,
  runLearnPass,
  type FeatureRosterEntry,
  runFeatureLearnPass,
  buildFeatureLearnPrompt,
  parseFeatureLearnOutput,
  FEATURE_LEARNING_MAX,
  salvageLearnOutput,
  CAGED_READ_TOOLS,
  CLAIM_FILE_MAX_COUNT,
  DEFAULT_RANK_CAPS,
  loadFeatureRoster,
  parseFeatureRoster,
  parseFeatureLearnEdges,
  FEATURE_EDGE_MAX,
  EDGE_NOTE_MAX_CHARS,
  type CagedSessionParams,
  type CliRunner,
  type ModuleFile,
} from './learn-session'
import { BRAIN_FIRST_COMPACT } from './brain-first'

const FAKE_CLI: BundledCli = { execPath: '/bin/electron', cliPath: '/app/planflow-ai.mjs' }

// ── buildCagedOptions ────────────────────────────────────────────────────────

describe('buildCagedOptions', () => {
  it('caps the tool surface to the read-only trio, headless', () => {
    const options = buildCagedOptions({ cwd: '/repo', abortController: new AbortController() })
    expect(options.allowedTools).toEqual(['Read', 'Grep', 'Glob'])
    expect(options.permissionMode).toBe('default')
    expect(typeof options.canUseTool).toBe('function')
    expect(options.cwd).toBe('/repo')
    expect(options.maxTurns).toBeGreaterThan(0)
  })

  it('observes reads via a PreToolUse hook, not canUseTool', () => {
    // The read trio is pre-approved via allowedTools, so canUseTool is never
    // invoked for it (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). Observation must be on
    // the hook channel or live learn progress silently never fires.
    const options = buildCagedOptions({ cwd: '/repo', abortController: new AbortController() })
    expect(options.hooks?.PreToolUse?.[0]?.matcher).toBe('Read')
  })

  it('applies model, maxTurns, and auth env when provided', () => {
    const authEnv = { ANTHROPIC_API_KEY: 'sk-test' }
    const options = buildCagedOptions({
      cwd: '/repo',
      abortController: new AbortController(),
      model: 'haiku',
      maxTurns: 3,
      authEnv,
    })
    expect(options.model).toBe('haiku')
    expect(options.maxTurns).toBe(3)
    expect(options.env).toBe(authEnv)
  })

  it('omits model/env when not provided', () => {
    const options = buildCagedOptions({ cwd: '/repo', abortController: new AbortController() })
    expect(options.model).toBeUndefined()
    expect(options.env).toBeUndefined()
  })
})

// ── createCagedCanUseTool ────────────────────────────────────────────────────

describe('createCagedCanUseTool', () => {
  const canUse = createCagedCanUseTool()
  const opts = { signal: new AbortController().signal, toolUseID: 'tu-1', requestId: 'rq-1' }

  it.each(CAGED_READ_TOOLS)('allows the read tool %s with echoed input', async (tool) => {
    const input = { path: 'foo.ts' }
    const result = await canUse(tool, input, opts)
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: input, toolUseID: 'tu-1' })
  })

  it.each(['Write', 'Edit', 'MultiEdit', 'Bash', 'NotebookEdit', 'WebFetch'])(
    'denies the non-read tool %s',
    async (tool) => {
      const result = await canUse(tool, {}, opts)
      expect(result?.behavior).toBe('deny')
      if (result && result.behavior === 'deny') {
        expect(result.message).toContain(tool)
        expect(result.message).toMatch(/read-only/)
      }
    },
  )
})

// ── createLearnReadHooks ─────────────────────────────────────────────────────

describe('createLearnReadHooks', () => {
  const invoke = (
    hooks: ReturnType<typeof createLearnReadHooks>,
    input: Record<string, unknown>,
  ): Promise<unknown> => {
    const hook = hooks.PreToolUse[0]?.hooks[0]
    if (!hook) throw new Error('no PreToolUse hook registered')
    // The SDK passes (input, toolUseID, options); only input is read here.
    return hook(input as never, undefined, { signal: new AbortController().signal } as never)
  }

  it('reports the file_path of each Read the caged session performs', async () => {
    const seen: string[] = []
    const hooks = createLearnReadHooks((fp) => seen.push(fp))
    await invoke(hooks, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/repo/src/a.ts' },
    })
    expect(seen).toEqual(['/repo/src/a.ts'])
  })

  it('ignores non-Read tools and malformed input without throwing', async () => {
    const seen: string[] = []
    const hooks = createLearnReadHooks((fp) => seen.push(fp))
    await invoke(hooks, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { file_path: '/repo/src/b.ts' },
    })
    await invoke(hooks, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: null })
    await invoke(hooks, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} })
    await invoke(hooks, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '' },
    })
    expect(seen).toEqual([])
  })

  it('is purely observational — always resolves an empty verdict', async () => {
    const hooks = createLearnReadHooks(() => {
      throw new Error('observer must not influence the tool call')
    })
    // A throwing observer would surface here if the hook awaited its result.
    await expect(
      invoke(hooks, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: {},
      }),
    ).resolves.toEqual({})
  })

  it('tolerates no observer at all', async () => {
    const hooks = createLearnReadHooks()
    await expect(
      invoke(hooks, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/x.ts' },
      }),
    ).resolves.toEqual({})
  })
})

// ── runCagedSession ──────────────────────────────────────────────────────────

/** Build a minimal mock Query that yields the given messages then closes. */
function mockQuery(messages: unknown[], onClose?: () => void): Query {
  async function* gen(): AsyncGenerator<unknown> {
    for (const m of messages) yield m
  }
  const iterator = gen()
  return Object.assign(iterator, {
    close: () => {
      onClose?.()
    },
  }) as unknown as Query
}

describe('runCagedSession', () => {
  it('returns the final result:success text and closes the query', async () => {
    const close = jest.fn()
    let seenOptions: unknown
    const queryFn = jest.fn((params: { prompt: AsyncIterable<SDKUserMessage>; options?: unknown }) => {
      seenOptions = params.options
      return mockQuery(
        [
          { type: 'assistant' },
          { type: 'result', subtype: 'success', result: 'FINAL TEXT' },
        ],
        close,
      )
    })
    const params: CagedSessionParams = { cwd: '/repo', prompt: 'hi', model: 'haiku', queryFn }
    const text = await runCagedSession(params)
    expect(text).toBe('FINAL TEXT')
    expect(close).toHaveBeenCalledTimes(1)
    expect(seenOptions).toMatchObject({ allowedTools: ['Read', 'Grep', 'Glob'], model: 'haiku' })
  })

  it('returns empty string when no success result is emitted', async () => {
    const queryFn = jest.fn(() => mockQuery([{ type: 'assistant' }]))
    const text = await runCagedSession({ cwd: '/repo', prompt: 'x', queryFn })
    expect(text).toBe('')
  })

  // THE CHAIN THAT WAS WIRED AT BOTH ENDS AND CUT IN THE MIDDLE. `onActivity`
  // was threaded from index.ts through feature-view-session into this
  // function's params, and every link compiled — but the runtime hands its
  // translator an `emit` and this translator ignored it, so `onEvent` never
  // fired and the callback was never called once. Greping the built bundle for
  // the wiring found it present and proved nothing.
  //
  // A live run is what caught it, twice. This is the guard that should have.
  it('reports what the session is doing, so a watchdog can hear it', async () => {
    const heard: Array<[string, string | undefined]> = []
    const queryFn = jest.fn(() =>
      mockQuery([
        { type: 'system', subtype: 'init' },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
        { type: 'user', message: { content: [{ type: 'tool_result' }] } },
        { type: 'stream_event' },
        { type: 'assistant', message: { content: [{ type: 'thinking' }] } },
        { type: 'result', subtype: 'success', result: 'DONE' },
      ]),
    )
    await runCagedSession({
      cwd: '/repo',
      prompt: 'x',
      queryFn,
      onActivity: (kind, detail) => heard.push([kind, detail]),
    })
    expect(heard).toEqual([
      ['session', 'init'],
      ['tool', 'Read'],
      ['tool result', undefined],
      ['stream', undefined],
      ['thinking', undefined],
      ['result', 'success'],
    ])
  })

  // THE HANG THAT LOOKED LIKE A STALL FOR THREE SESSIONS RUNNING.
  //
  // ClaudeRuntime feeds the SDK an AsyncMessageQueue it never closes, so after
  // the result message the query sits waiting for a next user turn that a caged
  // pass will never send. Every mock query in this file yields a finite list
  // and closes, which is exactly what the real one does NOT do — so the suite
  // was green while every live run hung until a watchdog killed it and binned a
  // finished answer.
  //
  // This mock behaves like the real stream: result, then silence forever.
  it('returns as soon as the turn ends, on a stream that never closes', async () => {
    const queryFn = jest.fn(() => {
      async function* gen(): AsyncGenerator<unknown> {
        yield { type: 'assistant', message: { content: [{ type: 'text' }] } }
        yield { type: 'result', subtype: 'success', result: 'FINISHED' }
        await new Promise(() => {})            // the queue is still open
      }
      return Object.assign(gen(), { close: () => {} }) as unknown as Query
    })
    let timer: NodeJS.Timeout | undefined
    try {
      const text = await Promise.race([
        runCagedSession({ cwd: '/repo', prompt: 'x', queryFn }),
        new Promise<string>((_, reject) => {
          timer = setTimeout(() => reject(new Error('runCagedSession never returned')), 2000)
        }),
      ])
      expect(text).toBe('FINISHED')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  })

  // Partial messages are the ONLY signal that exists while the model composes
  // its answer — the phase a real run spent 181 seconds in before the watchdog
  // killed it. Turning them off puts that hole straight back.
  it('asks the SDK for partial messages, the composing phase heartbeat', async () => {
    let seenOptions: unknown
    const queryFn = jest.fn((params: { prompt: AsyncIterable<SDKUserMessage>; options?: unknown }) => {
      seenOptions = params.options
      return mockQuery([{ type: 'result', subtype: 'success', result: '' }])
    })
    await runCagedSession({ cwd: '/repo', prompt: 'x', queryFn })
    expect(seenOptions).toMatchObject({ includePartialMessages: true })
  })
})

// ── rankModuleFiles ──────────────────────────────────────────────────────────

describe('rankModuleFiles', () => {
  it('ranks entry files first, then by ascending size', () => {
    const files: ModuleFile[] = [
      { path: 'src/big.ts', size: 900 },
      { path: 'src/small.ts', size: 100 },
      { path: 'src/index.ts', size: 500 },
    ]
    const ranked = rankModuleFiles(files, DEFAULT_RANK_CAPS)
    expect(ranked.map((f) => f.path)).toEqual(['src/index.ts', 'src/small.ts', 'src/big.ts'])
  })

  it('caps by file count', () => {
    const files: ModuleFile[] = Array.from({ length: 30 }, (_, i) => ({
      path: `f${i}.ts`,
      size: 10,
    }))
    const ranked = rankModuleFiles(files, { maxFiles: 5, maxBytes: 1_000_000 })
    expect(ranked).toHaveLength(5)
  })

  it('caps by total bytes but always keeps at least one file', () => {
    const files: ModuleFile[] = [
      { path: 'a.ts', size: 40 },
      { path: 'b.ts', size: 40 },
      { path: 'c.ts', size: 40 },
    ]
    const ranked = rankModuleFiles(files, { maxFiles: 100, maxBytes: 50 })
    expect(ranked.map((f) => f.path)).toEqual(['a.ts'])

    const oversize: ModuleFile[] = [{ path: 'huge.ts', size: 999 }]
    expect(rankModuleFiles(oversize, { maxFiles: 100, maxBytes: 50 })).toHaveLength(1)
  })
})

// ── claim files (trust-tiers) ────────────────────────────────────────────────

describe('isClaimFilePath', () => {
  it('classifies docs and images outside own dirs as claims (case-insensitive)', () => {
    expect(isClaimFilePath('docs/README.md')).toBe(true)
    expect(isClaimFilePath('src/NOTES.TXT')).toBe(true)
    expect(isClaimFilePath('assets/diagram.png')).toBe(true)
    expect(isClaimFilePath('src/index.ts')).toBe(false)
    expect(isClaimFilePath('data.bin')).toBe(false)
  })

  it('excludes plan-flow-owned locations (flow/, .claude/)', () => {
    expect(isClaimFilePath('flow/brain/index.md')).toBe(false)
    expect(isClaimFilePath('.claude/resources/core/blueprint.md')).toBe(false)
  })

  it('detects claim images only', () => {
  })
})

describe('capClaimFiles', () => {
  it('DROPS images and orders the docs by path, deterministically (#1130)', () => {
    // Images used to be included but ranked last. This session is a caged text
    // reader, so they could only ever return `unverifiable` — budget spent on
    // rows that never resolve. They are dropped, and NOT via overCap, which
    // would still have recorded them unverifiable.
    const { claimFiles, overCap } = capClaimFiles([
      { path: 'z/pic.png', size: 10 },
      { path: 'b/notes.txt', size: 10 },
      { path: 'a/logo.svg', size: 10 },
      { path: 'a/README.md', size: 10 },
    ])
    expect(claimFiles.map((f) => f.path)).toEqual(['a/README.md', 'b/notes.txt'])
    expect(overCap).toEqual([])
  })

  it('caps the file count and carries the rest as overCap', () => {
    const files: ModuleFile[] = Array.from({ length: 12 }, (_, i) => ({
      path: `docs/d${String(i).padStart(2, '0')}.md`,
      size: 10,
    }))
    const { claimFiles, overCap } = capClaimFiles(files)
    expect(claimFiles).toHaveLength(CLAIM_FILE_MAX_COUNT)
    expect(overCap).toHaveLength(12 - CLAIM_FILE_MAX_COUNT)
    expect(overCap[0]).toBe('docs/d08.md')
  })

  it('caps by total bytes and carries oversize files as overCap', () => {
    const { claimFiles, overCap } = capClaimFiles([
      { path: 'a.md', size: 60 * 1024 },
      { path: 'b.md', size: 60 * 1024 },
      { path: 'c.md', size: 1024 },
    ])
    // a.md fits; b.md would blow the 64KB budget; c.md still fits after it.
    expect(claimFiles.map((f) => f.path)).toEqual(['a.md', 'c.md'])
    expect(overCap).toEqual(['b.md'])
  })
})

// ── buildLearnPrompt ─────────────────────────────────────────────────────────

describe('buildObserveArgs anchor filtering (2026-07-24)', () => {
  it('drops directory and missing file anchors — only stampable regular files pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'observe-args-'))
    try {
      mkdirSync(join(root, 'src', 'types', 'ontology'), { recursive: true })
      writeFileSync(join(root, 'src', 'types', 'index.ts'), 'export {}\n')
      const args = buildObserveArgs({
        rootPath: root,
        modulePath: 'src/types',
        noteSummary: 's',
        docPath: join(root, 'flow/brain/modules/src-types.md'),
        keyAnchors: ['file:src/types/ontology', 'file:src/types/index.ts', 'file:src/types/ghost.ts'],
      })
      expect(args).not.toContain('file:src/types/ontology') // directory
      expect(args).not.toContain('file:src/types/ghost.ts') // missing
      expect(args).toContain('file:src/types/index.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('drops file-less symbol anchors and passes --lenient-anchors', () => {
    const anchorRoot = mkdtempSync(join(tmpdir(), 'observe-symbols-'))
    try {
      mkdirSync(join(anchorRoot, 'src', 'components'), { recursive: true })
      writeFileSync(join(anchorRoot, 'src', 'components', 'LoginForm.tsx'), 'export const LoginForm = 1\n')
      writeFileSync(join(anchorRoot, 'src', 'components', 'index.ts'), 'export {}\n')
      const args = buildObserveArgs({
        rootPath: anchorRoot,
        modulePath: 'src/components',
        noteSummary: 'summary',
        docPath: join(anchorRoot, 'flow/brain/modules/src-components.md'),
        keyAnchors: ['symbol:LoginForm', 'symbol:src/components/LoginForm.tsx#LoginForm', 'file:src/components/index.ts'],
      })
      expect(args).toContain('--lenient-anchors')
      expect(args).not.toContain('symbol:LoginForm')
      expect(args).toContain('symbol:src/components/LoginForm.tsx#LoginForm')
      expect(args).toContain('file:src/components/index.ts')
    } finally {
      rmSync(anchorRoot, { recursive: true, force: true })
    }
  })
})

describe('buildLearnPrompt', () => {
  it('embeds the module path, the file list, and the JSON contract', () => {
    const prompt = buildLearnPrompt({
      modulePath: 'app/src/main/agent',
      rankedFiles: [{ path: 'a.ts', size: 1 }, { path: 'b.ts', size: 2 }],
    })
    expect(prompt).toContain('app/src/main/agent')
    expect(prompt).toContain('- a.ts')
    expect(prompt).toContain('- b.ts')
    expect(prompt).toContain('docMarkdown')
    expect(prompt).toContain('noteSummary')
  })

  it('carries the brain-first compact block (grep fallback — the cage has no Bash)', () => {
    const prompt = buildLearnPrompt({
      modulePath: 'm',
      rankedFiles: [{ path: 'a.ts', size: 1 }],
    })
    expect(prompt).toContain(BRAIN_FIRST_COMPACT)
    // The constant must name the no-Bash fallback the cage can actually execute.
    expect(BRAIN_FIRST_COMPACT).toContain('flow/brain/**.md')
  })

  it('requires the ## Invariants contract with the none-observed sentinel (#898)', () => {
    const prompt = buildLearnPrompt({
      modulePath: 'm',
      rankedFiles: [{ path: 'a.ts', size: 1 }],
    })
    expect(prompt).toContain('## Invariants')
    expect(prompt).toContain('ONE testable')
    expect(prompt).toContain('- (none observed)')
  })

  it('omits the adjudication block when there are no claim files', () => {
    const prompt = buildLearnPrompt({
      modulePath: 'm',
      rankedFiles: [{ path: 'a.ts', size: 1 }],
    })
    expect(prompt).not.toContain('Docs to adjudicate')
    expect(prompt).not.toContain('docVerdicts')
  })

  it('lists claim files with the trust instruction and docVerdicts contract', () => {
    const prompt = buildLearnPrompt({
      modulePath: 'm',
      rankedFiles: [{ path: 'a.ts', size: 1 }],
      claimFiles: [
        { path: 'docs/README.md', size: 10 },
        { path: 'docs/diagram.png', size: 10 },
      ],
    })
    expect(prompt).toContain('Docs to adjudicate')
    expect(prompt).toContain('- docs/README.md')
    // #1130: an image never reaches the prompt now (capClaimFiles drops it), so
    // the image marker and the "return unverifiable for images" instruction are
    // both gone — the model is no longer asked a question it cannot answer.
    expect(prompt).not.toContain('diagram.png')
    expect(prompt).not.toContain('(image)')
    expect(prompt).toContain('UNVERIFIED claims')
    expect(prompt).toContain('docVerdicts')
    expect(prompt).toContain('corroborated|contradicted|unverifiable')
  })
})

// ── parseLearnOutput ─────────────────────────────────────────────────────────

describe('parseLearnOutput', () => {
  it('parses a bare JSON object', () => {
    const out = parseLearnOutput('{"docMarkdown":"# Doc","noteSummary":"note"}')
    expect(out).toEqual({ docMarkdown: '# Doc', noteSummary: 'note' })
  })

  it('parses JSON wrapped in a fence and stray prose', () => {
    const raw = 'Here you go:\n```json\n{"docMarkdown":"# D","noteSummary":"n","keyAnchors":["file:a.ts"]}\n```\nDone.'
    const out = parseLearnOutput(raw)
    expect(out).toEqual({ docMarkdown: '# D', noteSummary: 'n', keyAnchors: ['file:a.ts'] })
  })

  it('drops non-string keyAnchors and empty arrays', () => {
    const out = parseLearnOutput('{"docMarkdown":"d","noteSummary":"n","keyAnchors":[]}')
    expect(out).toEqual({ docMarkdown: 'd', noteSummary: 'n' })
  })

  it('returns null on malformed / missing fields', () => {
    expect(parseLearnOutput('not json at all')).toBeNull()
    expect(parseLearnOutput('{"docMarkdown":"d"}')).toBeNull()
    expect(parseLearnOutput('{"docMarkdown":"","noteSummary":"n"}')).toBeNull()
    expect(parseLearnOutput('{ broken')).toBeNull()
  })

  it('keeps docVerdicts only for offered paths with valid verdicts', () => {
    const raw = JSON.stringify({
      docMarkdown: 'd',
      noteSummary: 'n',
      docVerdicts: [
        { path: 'docs/a.md', verdict: 'corroborated', evidence: 'matches index.ts' },
        { path: 'docs/unoffered.md', verdict: 'contradicted' },
        { path: 'docs/b.md', verdict: 'maybe' },
        { path: 'docs/a.md', verdict: 'contradicted' },
        'not-an-object',
      ],
    })
    const out = parseLearnOutput(raw, ['docs/a.md', 'docs/b.md'])
    expect(out?.docVerdicts).toEqual([
      { path: 'docs/a.md', verdict: 'corroborated', evidence: 'matches index.ts' },
    ])
  })

  it('coerces evidence to a single line capped at 200 chars', () => {
    const raw = JSON.stringify({
      docMarkdown: 'd',
      noteSummary: 'n',
      docVerdicts: [
        { path: 'a.md', verdict: 'unverifiable', evidence: `line one\nline   two ${'x'.repeat(300)}` },
      ],
    })
    const out = parseLearnOutput(raw, ['a.md'])
    const evidence = out?.docVerdicts?.[0].evidence ?? ''
    expect(evidence).not.toContain('\n')
    expect(evidence.startsWith('line one line two')).toBe(true)
    expect(evidence.length).toBe(200)
  })

  it('treats absent or malformed docVerdicts as none — never fails the parse', () => {
    expect(
      parseLearnOutput('{"docMarkdown":"d","noteSummary":"n"}', ['a.md'])?.docVerdicts,
    ).toBeUndefined()
    expect(
      parseLearnOutput('{"docMarkdown":"d","noteSummary":"n","docVerdicts":"garbage"}', ['a.md'])
        ?.docVerdicts,
    ).toBeUndefined()
    // Offered nothing → any returned verdicts are dropped.
    expect(
      parseLearnOutput(
        '{"docMarkdown":"d","noteSummary":"n","docVerdicts":[{"path":"a.md","verdict":"corroborated"}]}',
      )?.docVerdicts,
    ).toBeUndefined()
  })
})

// ── moduleSlug ───────────────────────────────────────────────────────────────

describe('moduleSlug', () => {
  it('kebab-cases a module path', () => {
    expect(moduleSlug('app/src/main/agent')).toBe('app-src-main-agent')
  })
})

// ── buildObserveArgs ─────────────────────────────────────────────────────────

describe('buildObserveArgs', () => {
  it('builds the base note + module anchor with a relative doc link', () => {
    const args = buildObserveArgs({
      rootPath: '/repo',
      modulePath: 'app/src/main/agent',
      noteSummary: 'summary',
      docPath: '/repo/flow/brain/modules/app-src-main-agent.md',
    })
    expect(args.slice(0, 2)).toEqual(['blueprint', 'observe'])
    const noteIdx = args.indexOf('--note')
    expect(args[noteIdx + 1]).toContain('summary')
    expect(args[noteIdx + 1]).toContain('Doc: flow/brain/modules/app-src-main-agent.md')
    const anchorIdx = args.indexOf('--anchor')
    expect(args[anchorIdx + 1]).toBe('module:app/src/main/agent')
  })

  it('appends only grammar-valid keyAnchors (backed by real files)', () => {
    const anchorRoot = mkdtempSync(join(tmpdir(), 'observe-grammar-'))
    try {
      writeFileSync(join(anchorRoot, 'a.ts'), 'export const Foo = 1\n')
      writeFileSync(join(anchorRoot, 'b.ts'), 'export {}\n')
      const args = buildObserveArgs({
        rootPath: anchorRoot,
        modulePath: 'm',
        noteSummary: 's',
        docPath: join(anchorRoot, 'flow/brain/modules/m.md'),
        keyAnchors: ['symbol:a.ts#Foo', 'garbage-no-colon', 'file:b.ts'],
      })
      const anchors = args.filter((_, i) => args[i - 1] === '--anchor')
      expect(anchors).toEqual(['module:m', 'symbol:a.ts#Foo', 'file:b.ts'])
    } finally {
      rmSync(anchorRoot, { recursive: true, force: true })
    }
  })

  it('anchors an ALREADY-PREFIXED node id under its own kind, not module: (2026-07-30)', () => {
    // `module:endpoint:GET /api/x` resolves against nothing — the CLI dropped
    // it leniently and wrote an orphan note the module could never supersede.
    const args = buildObserveArgs({
      rootPath: '/repo',
      modulePath: 'endpoint:GET /api/usage/firm/products',
      noteSummary: 's',
      docPath: '/repo/flow/brain/modules/endpoint-get-api-usage-firm-products.md',
    })
    expect(args[args.indexOf('--anchor') + 1]).toBe('endpoint:GET /api/usage/firm/products')
  })

  it('scopes the contradiction rule to the identity anchor', () => {
    const args = buildObserveArgs({
      rootPath: '/repo',
      modulePath: 'm',
      noteSummary: 's',
      docPath: '/repo/flow/brain/modules/m.md',
    })
    expect(args[args.indexOf('--conflict-scope') + 1]).toBe('primary')
  })

  it('adds the supersede trio when superseding', () => {
    const args = buildObserveArgs({
      rootPath: '/repo',
      modulePath: 'm',
      noteSummary: 's',
      docPath: '/repo/flow/brain/modules/m.md',
      supersede: { fingerprint: 'abc123', reason: 'stale after refactor' },
    })
    expect(args).toContain('--status')
    expect(args[args.indexOf('--status') + 1]).toBe('supersedes')
    expect(args[args.indexOf('--supersedes') + 1]).toBe('abc123')
    expect(args[args.indexOf('--reason') + 1]).toBe('stale after refactor')
  })
})

// ── buildAdjudicateArgs ──────────────────────────────────────────────────────

describe('buildAdjudicateArgs', () => {
  it('builds the verb with path, verdict, csv witnesses, and evidence', () => {
    const args = buildAdjudicateArgs({
      path: 'docs/README.md',
      verdict: 'corroborated',
      against: ['src/a.ts', 'src/b.ts'],
      evidence: 'both exports match',
    })
    expect(args.slice(0, 2)).toEqual(['blueprint', 'adjudicate'])
    expect(args[args.indexOf('--path') + 1]).toBe('docs/README.md')
    expect(args[args.indexOf('--verdict') + 1]).toBe('corroborated')
    expect(args[args.indexOf('--against') + 1]).toBe('src/a.ts,src/b.ts')
    expect(args[args.indexOf('--evidence') + 1]).toBe('both exports match')
  })

  it('caps --against at 10 witnesses and omits it when empty', () => {
    const against = Array.from({ length: 15 }, (_, i) => `f${i}.ts`)
    const capped = buildAdjudicateArgs({ path: 'a.md', verdict: 'unverifiable', against })
    expect(capped[capped.indexOf('--against') + 1].split(',')).toHaveLength(10)

    const bare = buildAdjudicateArgs({ path: 'a.md', verdict: 'unverifiable', against: [] })
    expect(bare).not.toContain('--against')
    expect(bare).not.toContain('--evidence')
  })
})

// ── buildContradictionObserveArgs ────────────────────────────────────────────

describe('buildContradictionObserveArgs', () => {
  it('anchors the contradiction note to the module and the doc, status corroborates', () => {
    const args = buildContradictionObserveArgs({
      modulePath: 'app/src/main/agent',
      docPath: 'docs/ARCHITECTURE.md',
      evidence: 'doc claims REST, code uses IPC',
    })
    expect(args.slice(0, 2)).toEqual(['blueprint', 'observe'])
    expect(args[args.indexOf('--note') + 1]).toBe(
      'Doc contradicts code: docs/ARCHITECTURE.md — doc claims REST, code uses IPC',
    )
    const anchors = args.filter((_, i) => args[i - 1] === '--anchor')
    expect(anchors).toEqual(['module:app/src/main/agent', 'file:docs/ARCHITECTURE.md'])
    // The observe grammar has no 'contradicted' status; a plain observed write
    // would be refused by the contradiction rule (the learn note is active on
    // the module anchor) — corroborates is what the CLI accepts.
    expect(args[args.indexOf('--status') + 1]).toBe('corroborates')
  })

  it('omits the evidence clause when there is none', () => {
    const args = buildContradictionObserveArgs({ modulePath: 'm', docPath: 'a.md' })
    expect(args[args.indexOf('--note') + 1]).toBe('Doc contradicts code: a.md')
  })
})

// ── parseObserveFingerprint ──────────────────────────────────────────────────

describe('parseObserveFingerprint', () => {
  it('extracts the fingerprint from the observed line', () => {
    expect(parseObserveFingerprint('observed: note a1b2c3 (observed) on 1 anchor(s)\n')).toBe('a1b2c3')
  })

  it('returns null when absent', () => {
    expect(parseObserveFingerprint('observe refused: no graph')).toBeNull()
  })
})

// ── writeModuleDoc ───────────────────────────────────────────────────────────

describe('writeModuleDoc', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'learn-doc-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates the doc with an initial changelog line', () => {
    const docPath = writeModuleDoc(root, 'app/agent', '# Agent\n\nDoes things.', new Date('2026-07-15'))
    expect(docPath).toBe(join(root, 'flow/brain/modules/app-agent.md'))
    const body = readFileSync(docPath, 'utf8')
    expect(body).toContain('# Agent')
    expect(body).toContain('## Changelog')
    expect(body).toContain('- 2026-07-15: initial learn of `app/agent`')
  })

  it('appends a re-learned changelog line and refreshes the body on re-learn', () => {
    writeModuleDoc(root, 'app/agent', '# Old body', new Date('2026-07-15'))
    const docPath = writeModuleDoc(root, 'app/agent', '# New body', new Date('2026-07-16'))
    const body = readFileSync(docPath, 'utf8')
    expect(body).toContain('# New body')
    expect(body).not.toContain('# Old body')
    expect(body).toContain('- 2026-07-15: initial learn of `app/agent`')
    expect(body).toContain('- 2026-07-16: re-learned `app/agent`')
  })
})

// ── runLearnPass (integration of the seams) ──────────────────────────────────

describe('runLearnPass', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'learn-pass-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const files: ModuleFile[] = [{ path: 'index.ts', size: 100 }]

  it('writes the doc and note, returning the parsed fingerprint (happy path)', async () => {
    const runSession = jest
      .fn()
      .mockResolvedValue('{"docMarkdown":"# Mod\\n\\nbody","noteSummary":"the summary"}')
    const runCli = jest.fn<ReturnType<CliRunner>, Parameters<CliRunner>>(async () => ({
      ok: true,
      stdout: 'observed: note fp-xyz (observed) on 1 anchor(s)\n',
    }))
    const result = await runLearnPass(
      { rootPath: root, modulePath: 'app/agent', files, model: 'haiku', bundledCli: FAKE_CLI },
      { runSession, runCli, now: () => new Date('2026-07-15') },
    )
    expect(result.ok).toBe(true)
    expect(result.noteFingerprint).toBe('fp-xyz')
    expect(result.docPath).toBe(join(root, 'flow/brain/modules/app-agent.md'))
    expect(existsSync(result.docPath!)).toBe(true)
    // The session got a caged, cwd-scoped prompt for this module.
    expect(runSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: root, model: 'haiku' }),
    )
    // The CLI got the observe args with the module anchor.
    const cliArgs = runCli.mock.calls[0][2] as string[]
    expect(cliArgs).toContain('module:app/agent')
  })

  it('passes supersede flags through to the CLI', async () => {
    const runSession = jest
      .fn()
      .mockResolvedValue('{"docMarkdown":"d","noteSummary":"n"}')
    const runCli = jest.fn<ReturnType<CliRunner>, Parameters<CliRunner>>(async () => ({
      ok: true,
      stdout: 'observed: note fp-2 (supersedes) on 1 anchor(s)\n',
    }))
    await runLearnPass(
      {
        rootPath: root,
        modulePath: 'app/agent',
        files,
        bundledCli: FAKE_CLI,
        supersede: { fingerprint: 'old-fp', reason: 'refactored' },
      },
      { runSession, runCli },
    )
    const cliArgs = runCli.mock.calls[0][2] as string[]
    expect(cliArgs).toContain('--supersedes')
    expect(cliArgs[cliArgs.indexOf('--supersedes') + 1]).toBe('old-fp')
    expect(cliArgs[cliArgs.indexOf('--reason') + 1]).toBe('refactored')
  })

  it('appends a changelog line on re-learn', async () => {
    const runCli = jest.fn<ReturnType<CliRunner>, Parameters<CliRunner>>(async () => ({
      ok: true,
      stdout: 'observed: note fp (observed) on 1 anchor(s)\n',
    }))
    const first = jest.fn().mockResolvedValue('{"docMarkdown":"# v1","noteSummary":"n1"}')
    await runLearnPass({ rootPath: root, modulePath: 'app/agent', files, bundledCli: FAKE_CLI }, {
      runSession: first,
      runCli,
      now: () => new Date('2026-07-15'),
    })
    const second = jest.fn().mockResolvedValue('{"docMarkdown":"# v2","noteSummary":"n2"}')
    const result = await runLearnPass(
      { rootPath: root, modulePath: 'app/agent', files, bundledCli: FAKE_CLI },
      { runSession: second, runCli, now: () => new Date('2026-07-16') },
    )
    const body = readFileSync(result.docPath!, 'utf8')
    expect(body).toContain('# v2')
    expect(body).toContain('- 2026-07-15: initial learn of `app/agent`')
    expect(body).toContain('- 2026-07-16: re-learned `app/agent`')
  })

  it('retries once on malformed output and succeeds when the retry parses', async () => {
    const good = JSON.stringify({ docMarkdown: '# app/agent\n\nDoes things.', noteSummary: 'agent module' })
    const runSession = jest
      .fn()
      .mockResolvedValueOnce('{"docMarkdown": "# truncated and never clo')
      .mockResolvedValueOnce(good)
    const runCli = jest.fn().mockResolvedValue({
      ok: true,
      stdout: 'observed: note abc123 (observed) on 1 anchor(s)\n',
    })
    const result = await runLearnPass(
      { rootPath: root, modulePath: 'app/agent', files, bundledCli: FAKE_CLI },
      { runSession, runCli },
    )
    expect(runSession).toHaveBeenCalledTimes(2)
    // The retry prompt carries the corrective instruction.
    expect(String(runSession.mock.calls[1][0].prompt)).toMatch(/ONLY the JSON object/)
    expect(result.ok).toBe(true)
    expect(existsSync(join(root, 'flow/brain/modules/app-agent.md'))).toBe(true)
  })

  it('retries a turn-exhausted session instead of failing the pass (2026-07-30)', async () => {
    const good = JSON.stringify({ docMarkdown: '# app/agent', noteSummary: 'agent module' })
    const runSession = jest
      .fn()
      .mockRejectedValueOnce(
        new Error('Claude Code returned an error result: Reached maximum number of turns (30)'),
      )
      .mockResolvedValueOnce(good)
    const runCli = jest.fn().mockResolvedValue({
      ok: true,
      stdout: 'observed: note abc123 (observed) on 1 anchor(s)\n',
    })
    const result = await runLearnPass(
      { rootPath: root, modulePath: 'app/agent', files, bundledCli: FAKE_CLI },
      { runSession, runCli },
    )
    expect(runSession).toHaveBeenCalledTimes(2)
    expect(String(runSession.mock.calls[1][0].prompt)).toMatch(/running low on turns/)
    expect(result.ok).toBe(true)
  })

  it('reports turn exhaustion honestly when the retry also runs out', async () => {
    const runSession = jest
      .fn()
      .mockRejectedValue(
        new Error('Claude Code returned an error result: Reached maximum number of turns (30)'),
      )
    const runCli = jest.fn()
    const result = await runLearnPass(
      { rootPath: root, modulePath: 'app/agent', files, bundledCli: FAKE_CLI },
      { runSession, runCli },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/ran out of turns twice/)
    expect(runCli).not.toHaveBeenCalled()
  })

  it('still fails immediately on a non-turn session error', async () => {
    const runSession = jest.fn().mockRejectedValue(new Error('auth expired'))
    const result = await runLearnPass(
      { rootPath: root, modulePath: 'app/agent', files, bundledCli: FAKE_CLI },
      { runSession, runCli: jest.fn() },
    )
    expect(runSession).toHaveBeenCalledTimes(1)
    expect(result.reason).toBe('learn session failed: auth expired')
  })

  it('fails soft on malformed session output twice (no writes)', async () => {
    const runSession = jest.fn().mockResolvedValue('the model rambled without JSON')
    const runCli = jest.fn()
    const result = await runLearnPass(
      { rootPath: root, modulePath: 'app/agent', files, bundledCli: FAKE_CLI },
      { runSession, runCli },
    )
    expect(runSession).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/malformed output twice/)
    expect(runCli).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'flow/brain/modules/app-agent.md'))).toBe(false)
  })

  it('reports a failed observe but keeps the written doc', async () => {
    const runSession = jest.fn().mockResolvedValue('{"docMarkdown":"d","noteSummary":"n"}')
    const runCli = jest.fn<ReturnType<CliRunner>, Parameters<CliRunner>>(async () => ({
      ok: false,
      stdout: '',
      error: 'observe refused: no graph',
    }))
    const result = await runLearnPass(
      { rootPath: root, modulePath: 'app/agent', files, bundledCli: FAKE_CLI },
      { runSession, runCli },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/observe refused/)
    expect(existsSync(result.docPath!)).toBe(true)
  })

  it('fails soft when the session throws', async () => {
    const runSession = jest.fn().mockRejectedValue(new Error('SDK boom'))
    const result = await runLearnPass(
      { rootPath: root, modulePath: 'app/agent', files, bundledCli: FAKE_CLI },
      { runSession },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/SDK boom/)
  })

  it('adjudicates doc verdicts via the CLI, observing contradictions on the board', async () => {
    const output = JSON.stringify({
      docMarkdown: 'd',
      noteSummary: 'n',
      docVerdicts: [
        { path: 'app/agent/README.md', verdict: 'contradicted', evidence: 'doc says REST' },
        { path: 'app/agent/diagram.png', verdict: 'unverifiable' },
      ],
    })
    const runSession = jest.fn().mockResolvedValue(output)
    const runCli = jest.fn<ReturnType<CliRunner>, Parameters<CliRunner>>(async () => ({
      ok: true,
      stdout: 'observed: note fp-1 (observed) on 1 anchor(s)\n',
    }))
    const result = await runLearnPass(
      {
        rootPath: root,
        modulePath: 'app/agent',
        files,
        bundledCli: FAKE_CLI,
        claimFiles: [
          { path: 'app/agent/README.md', size: 10 },
          { path: 'app/agent/diagram.png', size: 10 },
        ],
      },
      { runSession, runCli },
    )
    expect(result.ok).toBe(true)
    expect(result.adjudicationWarnings).toBeUndefined()
    // The offered claim files reached the prompt.
    expect(String(runSession.mock.calls[0][0].prompt)).toContain('Docs to adjudicate')
    const calls = runCli.mock.calls.map((call) => call[2] as string[])
    // #1130: 1 learn-note observe + 1 adjudicate + 1 contradiction observe. The
    // image is never offered, so the model's `unverifiable` verdict for it is
    // rejected as an unoffered path and no adjudicate is spent on it — which is
    // the permanently-unverifiable row this issue was about.
    expect(calls).toHaveLength(3)
    const adjudicates = calls.filter((args) => args[1] === 'adjudicate')
    expect(adjudicates).toHaveLength(1)
    expect(adjudicates.some((args) => args.join(' ').includes('diagram.png'))).toBe(false)
    const contradicted = adjudicates.find((args) => args.includes('contradicted'))!
    expect(contradicted[contradicted.indexOf('--path') + 1]).toBe('app/agent/README.md')
    // --against carries the ranked code files the pass read.
    expect(contradicted[contradicted.indexOf('--against') + 1]).toBe('index.ts')
    const observes = calls.filter((args) => args[1] === 'observe')
    expect(observes).toHaveLength(2)
    const contradictionNote = observes[1]
    expect(contradictionNote[contradictionNote.indexOf('--note') + 1]).toBe(
      'Doc contradicts code: app/agent/README.md — doc says REST',
    )
    expect(contradictionNote).toContain('file:app/agent/README.md')
  })

  it('a failed adjudicate degrades to a warning — the learn still succeeds', async () => {
    const output = JSON.stringify({
      docMarkdown: 'd',
      noteSummary: 'n',
      docVerdicts: [{ path: 'README.md', verdict: 'corroborated' }],
    })
    const runSession = jest.fn().mockResolvedValue(output)
    const runCli = jest.fn<ReturnType<CliRunner>, Parameters<CliRunner>>(async (_cli, _cwd, args) => {
      if (args[1] === 'adjudicate') {
        return { ok: false, stdout: '', error: 'adjudicate refused: no tier store' }
      }
      return { ok: true, stdout: 'observed: note fp (observed) on 1 anchor(s)\n' }
    })
    const result = await runLearnPass(
      {
        rootPath: root,
        modulePath: 'app/agent',
        files,
        bundledCli: FAKE_CLI,
        claimFiles: [{ path: 'README.md', size: 5 }],
      },
      { runSession, runCli },
    )
    expect(result.ok).toBe(true)
    expect(result.noteFingerprint).toBe('fp')
    expect(result.adjudicationWarnings).toEqual([
      'adjudicate failed for README.md: adjudicate refused: no tier store',
    ])
  })

  it('records over-cap claim files as unverifiable without offering them', async () => {
    const claimFiles: ModuleFile[] = Array.from({ length: 9 }, (_, i) => ({
      path: `docs/d${i}.md`,
      size: 10,
    }))
    const runSession = jest.fn().mockResolvedValue('{"docMarkdown":"d","noteSummary":"n"}')
    const runCli = jest.fn<ReturnType<CliRunner>, Parameters<CliRunner>>(async () => ({
      ok: true,
      stdout: 'observed: note fp (observed) on 1 anchor(s)\n',
    }))
    const result = await runLearnPass(
      { rootPath: root, modulePath: 'app/agent', files, bundledCli: FAKE_CLI, claimFiles },
      { runSession, runCli },
    )
    expect(result.ok).toBe(true)
    // The 9th doc never reached the prompt…
    expect(String(runSession.mock.calls[0][0].prompt)).not.toContain('docs/d8.md')
    // …but was adjudicated unverifiable with the over-cap evidence line.
    const calls = runCli.mock.calls.map((call) => call[2] as string[])
    const overCapCall = calls.find((args) => args[1] === 'adjudicate')!
    expect(overCapCall[overCapCall.indexOf('--path') + 1]).toBe('docs/d8.md')
    expect(overCapCall[overCapCall.indexOf('--verdict') + 1]).toBe('unverifiable')
    expect(overCapCall[overCapCall.indexOf('--evidence') + 1]).toBe('not adjudicated — over cap')
    expect(overCapCall).not.toContain('--against')
  })
})

describe('salvageLearnOutput (#learn-large-modules)', () => {
  it('recovers the doc from truncated JSON whose docMarkdown string never closed', () => {
    const doc = '# AutomationBuilder\\n\\nBig module doing automation things across many files, with flows and state.'
    const raw = `{"docMarkdown": "${doc}` // cut mid-string — no closing quote/brace
    const salvaged = salvageLearnOutput(raw)
    expect(salvaged).not.toBeNull()
    expect(salvaged?.docMarkdown).toContain('# AutomationBuilder')
    expect(salvaged?.docMarkdown).toContain('salvaged from an oversized learn response')
    expect(salvaged?.noteSummary).toContain('Big module doing automation')
  })

  it('accepts a plain-markdown reply that ignored the JSON contract', () => {
    const raw = '# payments\n\nEverything that moves money — Stripe client, webhook fan-in, retries and idempotency handling.'
    const salvaged = salvageLearnOutput(raw)
    expect(salvaged?.docMarkdown).toContain('# payments')
    expect(salvaged?.noteSummary).toContain('Everything that moves money')
  })

  it('refuses garbage and near-empty content — the honest failure stays', () => {
    expect(salvageLearnOutput('')).toBeNull()
    expect(salvageLearnOutput('error: something broke')).toBeNull()
    expect(salvageLearnOutput('{"docMarkdown": "tiny"')).toBeNull()
  })
})

describe('runLearnPass salvage integration', () => {
  it('writes a salvaged doc when both attempts return unparseable output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flow-learn-salvage-'))
    try {
      const doc = '# AutomationBuilder\\n\\nA large builder module: canvas, nodes, and validation across dozens of files.'
      const raw = `{"docMarkdown": "${doc}` // truncated both times
      const runCli = jest.fn<ReturnType<CliRunner>, Parameters<CliRunner>>(async () => ({
        ok: true,
        stdout: 'observed: note fp-salvage (observed) on 1 anchor(s)\n',
      }))
      const result = await runLearnPass(
        {
          rootPath: root,
          modulePath: 'src/components/automations/AutomationBuilder',
          files: [{ path: 'index.tsx', size: 10 }],
          bundledCli: FAKE_CLI,
        },
        {
          runSession: async () => raw,
          runCli,
          now: () => new Date('2026-07-23T12:00:00.000Z'),
        },
      )
      expect(result.ok).toBe(true)
      const docPath = join(root, 'flow', 'brain', 'modules', 'src-components-automations-automationbuilder.md')
      const written = readFileSync(docPath, 'utf8')
      expect(written).toContain('# AutomationBuilder')
      expect(written).toContain('salvaged from an oversized learn response')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── The FEATURE learn pass ─────────────────────────────────────────────────
//
// Scoped to a feature, not a module: it reads the feature's own anchored files
// and produces LEARNINGS, which the CLI writes into the machine-owned section.
// Not a fan-out over modules and not a synthesis of their docs — a feature is
// not the sum of its directories.

describe('buildFeatureLearnPrompt', () => {
  const files: ModuleFile[] = [
    { path: 'src/chat/stream.ts', size: 100 },
    { path: 'src/chat/store.ts', size: 200 },
  ]

  it('asks for one-sentence facts, capped, and names the feature', () => {
    const prompt = buildFeatureLearnPrompt({ featureName: 'Chats', rankedFiles: files })
    expect(prompt).toContain('"Chats"')
    expect(prompt).toContain('src/chat/stream.ts')
    expect(prompt).toContain(String(FEATURE_LEARNING_MAX))
    expect(prompt).toContain('ONE SENTENCE')
  })

  it('carries the brain-first instruction, like the module pass', () => {
    expect(buildFeatureLearnPrompt({ featureName: 'Chats', rankedFiles: files })).toContain(
      BRAIN_FIRST_COMPACT,
    )
  })

  it('tells the model that an empty answer is honest', () => {
    // Otherwise it pads: the section fills with restatements of the code.
    expect(buildFeatureLearnPrompt({ featureName: 'Chats', rankedFiles: files })).toContain(
      'An empty list is a valid, honest answer',
    )
  })

  it('carries the roster, so the OTHER side of a relationship has a name', () => {
    const prompt = buildFeatureLearnPrompt({
      featureName: 'Playbooks',
      rankedFiles: files,
      roster: ROSTER,
    })
    expect(prompt).toContain('- feature:skills — Skills: a reusable instruction set')
    expect(prompt).toContain('naming its id exactly as written above')
  })
})

// ── The roster ───────────────────────────────────────────────────────────────
//
// THE MEASURED FAILURE THIS FIXES: `relates` is empty in all 101 features
// across three projects. A pass reading Playbooks sees a skill slug resolved by
// a binder and writes a sentence about the binder — because `feature:skills` is
// a name it has no way to know exists.

const ROSTER: FeatureRosterEntry[] = [
  { id: 'feature:skills', name: 'Skills', kind: 'core', summary: 'a reusable instruction set' },
  { id: 'feature:chats', name: 'Chats', kind: 'core', summary: '' },
  { id: 'feature:chat-migration', name: 'Chat Migration', kind: 'child', summary: 'moved the engine' },
]

describe('renderFeatureRoster', () => {
  it('renders one line per feature: id, name and the summary a card shows', () => {
    expect(renderFeatureRoster(ROSTER).join('\n')).toContain(
      [
        '- feature:skills — Skills: a reusable instruction set',
        '- feature:chats — Chats',
        '- feature:chat-migration — Chat Migration (change record): moved the engine',
      ].join('\n'),
    )
  })

  it('says a relationship IS an id from the list — not prose about a mechanism', () => {
    const block = renderFeatureRoster(ROSTER).join('\n')
    expect(block).toContain('naming its id exactly as written above')
    expect(block).toContain('never a sentence about a mechanism with')
    expect(block).toContain('Never invent an id that is not on the list')
  })

  it('renders NOTHING for an empty roster — no heading inviting an invented id', () => {
    expect(renderFeatureRoster([])).toEqual([])
  })

  it('truncates a long summary but never drops a NAME', () => {
    const long = 'x'.repeat(400)
    const block = renderFeatureRoster([{ id: 'feature:a', name: 'A', summary: long }])
    const line = block.find((entry) => entry.startsWith('- feature:a')) ?? ''
    expect(line).toContain('feature:a — A')
    // The NAME survives whole; only the summary is clipped, and it says so.
    expect(line.length).toBeLessThan(ROSTER_SUMMARY_MAX_CHARS + 40)
    expect(line.endsWith('…')).toBe(true)
  })
})

describe('buildLearnPrompt — the roster', () => {
  const files: ModuleFile[] = [{ path: 'a.ts', size: 1 }]

  it('lists every feature id the pass may name', () => {
    const prompt = buildLearnPrompt({ modulePath: 'm', rankedFiles: files, roster: ROSTER })
    expect(prompt).toContain("Features already named in this project's knowledge base:")
    expect(prompt).toContain('- feature:skills — Skills')
    expect(prompt).toContain('- feature:chats — Chats')
  })

  it('states that recording a relationship means naming a roster feature', () => {
    const prompt = buildLearnPrompt({ modulePath: 'm', rankedFiles: files, roster: ROSTER })
    expect(prompt).toContain('naming its id exactly as written above')
    expect(prompt).toContain('Never invent an id that is not on the list')
  })

  it('is byte-identical to the roster-free prompt when no roster is given', () => {
    const withEmpty = buildLearnPrompt({ modulePath: 'm', rankedFiles: files, roster: [] })
    expect(buildLearnPrompt({ modulePath: 'm', rankedFiles: files })).toBe(withEmpty)
    expect(withEmpty).not.toContain('knowledge base:')
  })
})

describe('parseFeatureLearnOutput', () => {
  it('reads the agreed shape', () => {
    expect(parseFeatureLearnOutput('{"learnings":["a fact","another fact"]}')).toEqual([
      'a fact',
      'another fact',
    ])
  })

  it('distinguishes "nothing to say" from "did not answer"', () => {
    expect(parseFeatureLearnOutput('{"learnings":[]}')).toEqual([]) // honest empty
    expect(parseFeatureLearnOutput('sorry, I could not')).toBeNull() // no answer
  })

  it('folds newlines — a learning is ONE line or the grammar breaks on re-read', () => {
    expect(parseFeatureLearnOutput('{"learnings":["line one\\nline two"]}')).toEqual([
      'line one line two',
    ])
  })

  it('caps the list and drops non-strings and blanks', () => {
    const many = Array.from({ length: 20 }, (_, i) => `fact ${String(i)}`)
    const parsed = parseFeatureLearnOutput(JSON.stringify({ learnings: [...many, 42, '', '   '] }))
    expect(parsed).toHaveLength(FEATURE_LEARNING_MAX)
  })
})

describe('runFeatureLearnPass', () => {
  const files: ModuleFile[] = [{ path: 'src/chat/stream.ts', size: 100 }]
  const base = {
    rootPath: '/repo',
    featureRef: 'chats',
    featureName: 'Chats',
    files,
    bundledCli: FAKE_CLI,
    now: () => new Date('2026-08-03T10:00:00.000Z'),
  }

  it('hands the pass every OTHER feature, never the one being learned', async () => {
    let prompt = ''
    await runFeatureLearnPass(
      {
        ...base,
        featureRef: 'chats',
        roster: [...ROSTER, { id: 'feature:chats', name: 'Chats', kind: 'core', summary: 's' }],
      },
      {
        runSession: (params) => {
          prompt = params.prompt
          return Promise.resolve('{"learnings":["a fact"]}')
        },
        runCli: () => Promise.resolve({ ok: true, stdout: '' }),
      },
    )
    expect(prompt).toContain('- feature:skills — Skills')
    // The subject is matched by slug as well as id — `featureRef` is either.
    expect(prompt).not.toContain('- feature:chats — Chats')
  })

  it('writes learnings through the CLI, with provenance and date', async () => {
    const cliCalls: string[][] = []
    const result = await runFeatureLearnPass(base, {
      runSession: () => Promise.resolve('{"learnings":["Reload can duplicate a completed turn"]}'),
      runCli: (_cli, _cwd, args) => {
        cliCalls.push([...args])
        return Promise.resolve({ ok: true, stdout: 'features: Chats — 1 learning(s)\n' })
      },
    })

    expect(result.ok).toBe(true)
    expect(result.learnings).toEqual(['Reload can duplicate a completed turn'])
    expect(cliCalls[0].slice(0, 5)).toEqual(['blueprint', 'features', 'learned', '--feature', 'chats'])
    expect(JSON.parse(cliCalls[0][6])).toEqual({
      text: 'Reload can duplicate a completed turn',
      provenance: 'code',
      date: '2026-08-03',
    })
  })

  it('stamps plan provenance when a run taught it', async () => {
    const cliCalls: string[][] = []
    await runFeatureLearnPass(
      { ...base, provenance: 'plan:chat-session-cache-rework' },
      {
        runSession: () => Promise.resolve('{"learnings":["a fact"]}'),
        runCli: (_cli, _cwd, args) => {
          cliCalls.push([...args])
          return Promise.resolve({ ok: true, stdout: '' })
        },
      },
    )
    expect(JSON.parse(cliCalls[0][6]).provenance).toBe('plan:chat-session-cache-rework')
  })

  it('writes NOTHING when the model honestly has nothing to say', async () => {
    // A quiet pass must not empty a section that already holds knowledge.
    let called = false
    const result = await runFeatureLearnPass(base, {
      runSession: () => Promise.resolve('{"learnings":[]}'),
      runCli: () => {
        called = true
        return Promise.resolve({ ok: true, stdout: '' })
      },
    })
    expect(result.ok).toBe(true)
    expect(result.learnings).toEqual([])
    expect(called).toBe(false)
  })

  it('surfaces a store refusal verbatim and reports failure', async () => {
    const result = await runFeatureLearnPass(base, {
      runSession: () => Promise.resolve('{"learnings":["a fact"]}'),
      runCli: () =>
        Promise.resolve({
          ok: false,
          stdout: '',
          error: 'features refused: ambiguous `## Learned` boundary — the file carries 2 of them',
        }),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('ambiguous `## Learned` boundary')
  })

  it('retries once when the model does not return the agreed shape', async () => {
    let attempt = 0
    const result = await runFeatureLearnPass(base, {
      runSession: () => {
        attempt += 1
        return Promise.resolve(attempt === 1 ? 'here you go:' : '{"learnings":["a fact"]}')
      },
      runCli: () => Promise.resolve({ ok: true, stdout: '' }),
    })
    expect(attempt).toBe(2)
    expect(result.ok).toBe(true)
  })

  it('fails cleanly when a feature claims no readable files', async () => {
    const result = await runFeatureLearnPass({ ...base, files: [] }, {
      runSession: () => Promise.resolve('{"learnings":["x"]}'),
      runCli: () => Promise.resolve({ ok: true, stdout: '' }),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('claims no readable files')
  })
})

// ── Recording relationships (phase 2) ───────────────────────────────────────
//
// The roster was plumbed and dormant: no caller populated it, so every prompt
// rendered no block and the pass could not name the other side even in
// principle. These cover the two halves that make it real — the PRODUCER that
// fills the roster from the store, and the EDGES the pass writes back through
// the store's own writer.

describe('parseFeatureRoster', () => {
  it('reads the roster verb\'s JSON', () => {
    const stdout = JSON.stringify({
      roster: [
        { id: 'feature:skills', slug: 'skills', name: 'Skills', kind: 'core', summary: 'a reusable instruction set' },
        { id: 'feature:playbooks', slug: 'playbooks', name: 'Playbooks', kind: 'core', summary: '' },
      ],
    })
    expect(parseFeatureRoster(stdout)).toEqual([
      { id: 'feature:skills', name: 'Skills', kind: 'core', summary: 'a reusable instruction set' },
      { id: 'feature:playbooks', name: 'Playbooks', kind: 'core' },
    ])
  })

  it('drops an entry with no id — a name the pass could never write', () => {
    const stdout = JSON.stringify({ roster: [{ name: 'Nameless' }, { id: 'feature:a', name: 'A' }] })
    expect(parseFeatureRoster(stdout)).toEqual([{ id: 'feature:a', name: 'A' }])
  })

  it('is empty for a refusal line, empty output or the wrong shape', () => {
    expect(parseFeatureRoster('features refused: no store\n')).toEqual([])
    expect(parseFeatureRoster('')).toEqual([])
    expect(parseFeatureRoster('{"roster":"nope"}')).toEqual([])
  })
})

describe('loadFeatureRoster', () => {
  it('asks the CLI for the roster and returns what it names', async () => {
    const calls: string[][] = []
    const roster = await loadFeatureRoster(FAKE_CLI, '/repo', (_cli, _cwd, args) => {
      calls.push([...args])
      return Promise.resolve({
        ok: true,
        stdout: JSON.stringify({ roster: [{ id: 'feature:skills', name: 'Skills' }] }),
      })
    })
    expect(calls[0]).toEqual(['blueprint', 'features', 'roster', '--json'])
    expect(roster).toEqual([{ id: 'feature:skills', name: 'Skills' }])
  })

  it('yields an empty roster when the CLI has no such verb — never a failure', async () => {
    // An older bundle renders no block at all, which is the pre-roster prompt.
    const roster = await loadFeatureRoster(FAKE_CLI, '/repo', () =>
      Promise.resolve({ ok: false, stdout: '', error: "unknown command 'roster'" }),
    )
    expect(roster).toEqual([])
  })
})

describe('parseFeatureLearnEdges', () => {
  it('reads target, via and note — the note IS the answer', () => {
    const raw = JSON.stringify({
      learnings: ['a fact'],
      relates: [
        {
          target: 'feature:skills',
          via: 'src/playbooks/playbook_manifest_binder.ts',
          note: 'a playbook step names a skill by slug; the binder resolves it at authoring time',
        },
      ],
    })
    expect(parseFeatureLearnEdges(raw)).toEqual([
      {
        target: 'feature:skills',
        via: 'src/playbooks/playbook_manifest_binder.ts',
        note: 'a playbook step names a skill by slug; the binder resolves it at authoring time',
      },
    ])
  })

  it('is empty when the model named no relationship — the honest answer', () => {
    expect(parseFeatureLearnEdges('{"learnings":["a fact"]}')).toEqual([])
    expect(parseFeatureLearnEdges('not json at all')).toEqual([])
  })

  it('keeps an edge whose mechanism is unknown — a target alone still resolves', () => {
    expect(parseFeatureLearnEdges('{"relates":[{"target":"feature:skills"}]}')).toEqual([
      { target: 'feature:skills' },
    ])
  })

  it('caps the list, drops targetless entries and folds a multi-line note', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ target: `feature:f${String(i)}` }))
    expect(parseFeatureLearnEdges(JSON.stringify({ relates: many }))).toHaveLength(FEATURE_EDGE_MAX)
    expect(parseFeatureLearnEdges('{"relates":[{"target":"   "},{"via":"x.ts"}]}')).toEqual([])
    const folded = parseFeatureLearnEdges(
      JSON.stringify({ relates: [{ target: 'feature:a', note: 'one\ntwo' }] }),
    )
    expect(folded[0].note).toBe('one two')
    const long = parseFeatureLearnEdges(
      JSON.stringify({ relates: [{ target: 'feature:a', note: 'x'.repeat(500) }] }),
    )
    expect(long[0].note?.length).toBe(EDGE_NOTE_MAX_CHARS)
  })

  it('keeps the first edge per target — a re-stated relationship is one edge', () => {
    const raw = '{"relates":[{"target":"feature:a","note":"first"},{"target":"feature:a","note":"second"}]}'
    expect(parseFeatureLearnEdges(raw)).toEqual([{ target: 'feature:a', note: 'first' }])
  })
})

describe('buildFeatureLearnPrompt — recording the relationship', () => {
  const files: ModuleFile[] = [{ path: 'a.ts', size: 1 }]

  it('asks for relates ONLY when there are ids it may name', () => {
    const withRoster = buildFeatureLearnPrompt({ featureName: 'Playbooks', rankedFiles: files, roster: ROSTER })
    expect(withRoster).toContain('"relates"')
    expect(withRoster).toContain('copied EXACTLY from the list above')
    expect(withRoster).toContain('how do these two connect?')

    // No roster ⇒ no target could be valid, so the key is never mentioned.
    const without = buildFeatureLearnPrompt({ featureName: 'Playbooks', rankedFiles: files })
    expect(without).not.toContain('"relates"')
    expect(buildFeatureLearnPrompt({ featureName: 'Playbooks', rankedFiles: files, roster: [] })).toBe(
      without,
    )
  })
})

describe('runFeatureLearnPass — edges', () => {
  const files: ModuleFile[] = [{ path: 'src/playbooks/binder.ts', size: 100 }]
  const base = {
    rootPath: '/repo',
    featureRef: 'playbooks',
    featureName: 'Playbooks',
    files,
    bundledCli: FAKE_CLI,
    now: () => new Date('2026-08-11T10:00:00.000Z'),
  }
  const reply = JSON.stringify({
    learnings: ['A playbook step is resolved at authoring time'],
    relates: [
      {
        target: 'feature:skills',
        via: 'src/playbooks/binder.ts',
        note: 'a playbook step names a skill by slug; the binder resolves it at authoring time',
      },
    ],
  })

  it('writes the edges through the SAME store writer as the learnings', async () => {
    const calls: string[][] = []
    const result = await runFeatureLearnPass(
      { ...base, roster: ROSTER },
      {
        runSession: () => Promise.resolve(reply),
        runCli: (_cli, _cwd, args) => {
          calls.push([...args])
          return Promise.resolve({ ok: true, stdout: '' })
        },
      },
    )
    expect(result.ok).toBe(true)
    // ONE invocation: the facts and the relationships can never half-land.
    expect(calls).toHaveLength(1)
    expect(calls[0].slice(0, 5)).toEqual(['blueprint', 'features', 'learned', '--feature', 'playbooks'])
    const relatesIndex = calls[0].indexOf('--relates')
    expect(relatesIndex).toBeGreaterThan(-1)
    expect(JSON.parse(calls[0][relatesIndex + 1])).toEqual([
      {
        target: 'feature:skills',
        via: 'src/playbooks/binder.ts',
        note: 'a playbook step names a skill by slug; the binder resolves it at authoring time',
      },
    ])
    expect(result.edges).toHaveLength(1)
  })

  it('writes edges even when the pass had no learning worth recording', async () => {
    const calls: string[][] = []
    const result = await runFeatureLearnPass(
      { ...base, roster: ROSTER },
      {
        runSession: () =>
          Promise.resolve('{"learnings":[],"relates":[{"target":"feature:skills","via":"a.ts","note":"n"}]}'),
        runCli: (_cli, _cwd, args) => {
          calls.push([...args])
          return Promise.resolve({ ok: true, stdout: '' })
        },
      },
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toContain('--entry')
    expect(calls[0]).toContain('--relates')
  })

  it('sends no --relates when the model named none', async () => {
    const calls: string[][] = []
    await runFeatureLearnPass(base, {
      runSession: () => Promise.resolve('{"learnings":["a fact"]}'),
      runCli: (_cli, _cwd, args) => {
        calls.push([...args])
        return Promise.resolve({ ok: true, stdout: '' })
      },
    })
    expect(calls[0]).not.toContain('--relates')
  })

  it('proposes no edge from a PART pass — relates belongs to the feature', async () => {
    const result = await runFeatureLearnPass(
      { ...base, collectOnly: true, roster: ROSTER },
      {
        runSession: () => Promise.resolve(reply),
        runCli: () => Promise.resolve({ ok: true, stdout: '' }),
      },
    )
    expect(result.ok).toBe(true)
    expect(result.edges).toBeUndefined()
  })
})
