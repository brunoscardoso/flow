// What an answer is given before it reads code (ask-context.ts). Two promises
// carry the weight: a conversation's TOOL OUTPUT never reaches the prompt, and
// a branch is "in progress" only when git said it is not merged — unknown is
// never reported as in progress.

import type { BlueprintFeatureNode } from '../../shared/ipc-contract'
import type { MessageRecord, ThreadRecord } from '../store/thread-store'
import type { RunResult } from '../worktree/thread-worktree'
import {
  condenseThreadForAsk,
  gatherAskContext,
  withMergeState,
  type AskContextDeps,
  type AskGit,
  type AskThreadReader,
  type CondensedThread,
} from './ask-context'
import { buildFastPrompt } from './ask-orchestrator'

const HUGE_TOOL_OUTPUT = 'GREP-OUTPUT-SHOULD-NEVER-APPEAR '.repeat(1000)

function message(patch: Partial<MessageRecord>): MessageRecord {
  return { id: Math.random().toString(16), threadId: 't1', role: 'user', content: '', createdAt: '', model: null, ...patch }
}

function threadRecord(patch: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: 't1',
    projectRoot: '/repo',
    title: 'Vault work',
    worktreePath: '/repo-wt',
    worktreeBranch: 'feat/vault',
    worktreeBase: 'main',
    prBase: null,
    ...patch,
  } as ThreadRecord
}

/** A store double. It also carries the blob reads a careless condenser might reach for — they throw. */
function store(over: { thread?: ThreadRecord | null } = {}): AskThreadReader & { listToolCalls: () => never; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    getThread: () => (over.thread === undefined ? threadRecord() : over.thread),
    listMessages: () => {
      calls.push('listMessages')
      return [
        message({ role: 'user', content: 'Move secrets to the vault, see flow/plans/plan_vault_v1.md' }),
        message({ role: 'assistant', content: 'Working on it…' }),
        message({ role: 'assistant', content: 'Sub-agent says hi', parentToolCallId: 'task-1' }),
        message({ role: 'assistant', content: 'Moved them.', endsTurn: true }),
        message({ role: 'system', content: HUGE_TOOL_OUTPUT }),
      ]
    },
    listToolCallPaths: () => {
      calls.push('listToolCallPaths')
      return [
        { toolName: 'Edit', filePath: '/repo-wt/src/vault.ts' },
        { toolName: 'Read', filePath: '/repo-wt/src/read-only.ts' },
        { toolName: 'Grep', filePath: null },
      ]
    },
    listToolCalls: () => {
      throw new Error('tool output must never be read')
    },
  }
}

/** git double keyed by argv; anything not listed fails. Records every call. */
function fakeGit(answers: Record<string, boolean>): { git: AskGit; calls: string[][] } {
  const calls: string[][] = []
  const git: AskGit = async (_cwd, args) => {
    calls.push([...args])
    const ok = answers[args.join(' ')]
    if (ok === undefined) throw new Error(`unexpected git ${args.join(' ')}`)
    return { ok, stdout: '' } satisfies RunResult
  }
  return { git, calls }
}

const EXISTS = 'rev-parse --verify --quiet refs/heads/feat/vault'
const BASE = 'rev-parse --verify --quiet main'
const ANCESTOR = 'merge-base --is-ancestor refs/heads/feat/vault main'

describe('condenseThreadForAsk', () => {
  it('keeps what the person said, the turn-ending answers and changed files — never tool output', () => {
    const s = store()
    const condensed = condenseThreadForAsk(s, 't1') as CondensedThread

    expect(s.calls).toEqual(['listMessages', 'listToolCallPaths'])
    expect(condensed.personMessages).toEqual(['Move secrets to the vault, see flow/plans/plan_vault_v1.md'])
    expect(condensed.answers).toEqual(['Moved them.'])
    expect(condensed.filesChanged).toEqual(['src/vault.ts'])
    expect(condensed.linkedDocs).toEqual(['flow/plans/plan_vault_v1.md'])
    expect(condensed).toMatchObject({ checkout: '/repo-wt', branch: 'feat/vault', base: 'main', merged: null })
    const everything = JSON.stringify(condensed)
    expect(everything).not.toContain('GREP-OUTPUT')
    expect(everything).not.toContain('Sub-agent says hi')
    expect(everything).not.toContain('read-only.ts')
  })

  it('falls back to the last assistant message for a thread without turn marks', () => {
    const s = store()
    s.listMessages = () => [
      message({ role: 'assistant', content: 'first' }),
      message({ role: 'assistant', content: 'last' }),
    ]
    expect(condenseThreadForAsk(s, 't1')?.answers).toEqual(['last'])
  })

  it('is null for a thread that does not exist', () => {
    expect(condenseThreadForAsk(store({ thread: null }), 'gone')).toBeNull()
  })
})

describe('withMergeState', () => {
  const condensed = (): CondensedThread => condenseThreadForAsk(store(), 't1') as CondensedThread

  it('reports an unmerged branch as merged: false — and the prompt says it is in progress', async () => {
    const { git, calls } = fakeGit({ [EXISTS]: true, [BASE]: true, [ANCESTOR]: false })
    const thread = await withMergeState(condensed(), git)
    expect(calls).toEqual([EXISTS.split(' '), BASE.split(' '), ANCESTOR.split(' ')])
    expect(thread.merged).toBe(false)
    const prompt = buildFastPrompt('q', [], { hits: [], features: [], relations: [], notes: [], threads: [thread], knownIds: [] })
    expect(prompt).toContain('branch feat/vault, NOT merged')
    expect(prompt).not.toContain('GREP-OUTPUT')
  })

  it('reports a merged branch as merged: true, not in progress', async () => {
    const { git } = fakeGit({ [EXISTS]: true, [BASE]: true, [ANCESTOR]: true })
    const thread = await withMergeState(condensed(), git)
    expect(thread.merged).toBe(true)
    const prompt = buildFastPrompt('q', [], { hits: [], features: [], relations: [], notes: [], threads: [thread], knownIds: [] })
    expect(prompt).toContain('A conversation the person tagged')
    expect(prompt).not.toContain('NOT merged')
  })

  it.each([
    ['the branch is gone', { [EXISTS]: false }],
    ['the base is gone', { [EXISTS]: true, [BASE]: false }],
  ])('leaves the state unknown when %s — never in progress', async (_name, answers) => {
    const { git, calls } = fakeGit(answers)
    const thread = await withMergeState(condensed(), git)
    expect(calls.length).toBeGreaterThan(0)
    expect(thread.merged).toBeNull()
    const prompt = buildFastPrompt('q', [], { hits: [], features: [], relations: [], notes: [], threads: [thread], knownIds: [] })
    expect(prompt).toContain('A conversation the person tagged')
    expect(prompt).not.toContain('NOT merged')
  })

  it('asks git nothing for a conversation on the project checkout (no branch)', async () => {
    const { git, calls } = fakeGit({})
    const thread = await withMergeState({ ...condensed(), branch: null }, git)
    expect(calls).toEqual([])
    expect(thread.merged).toBeNull()
  })
})

describe('gatherAskContext', () => {
  const node = (patch: Partial<BlueprintFeatureNode>): BlueprintFeatureNode =>
    ({ name: patch.id, slug: 'x', summary: '', ...patch }) as BlueprintFeatureNode

  function deps(over: Partial<AskContextDeps> = {}): AskContextDeps {
    return {
      searchKnowledge: async () => [{ file: 'flow/brain/features/connectors.md', title: 'Connectors', snippet: 'vault' }],
      readFeatureGraph: async () => ({
        nodes: [
          node({ id: 'feature:connectors', kind: 'core', name: 'Connectors' }),
          node({ id: 'feature:connectors/credentials', kind: 'part', name: 'Credentials', parent: 'feature:connectors' }),
          node({ id: 'feature:coworkers', kind: 'core', name: 'Coworkers' }),
          node({ id: 'plan:x', kind: 'child', name: 'A change' }),
        ],
        edges: [],
      }),
      readNotes: async () => [],
      threadStore: store(),
      git: fakeGit({ [EXISTS]: true, [BASE]: true, [ANCESTOR]: false }).git,
      ...over,
    }
  }

  it('brings a tagged feature with its parts, the tagged conversations with merge state, and every addressable id', async () => {
    const context = await gatherAskContext(
      { rootPath: '/repo', question: 'q', tags: ['feature:connectors'], conversationIds: ['t1', 'missing'] },
      deps({ threadStore: Object.assign(store(), { getThread: (id: string) => (id === 't1' ? threadRecord() : null) }) }),
    )
    expect(context.features.map((f) => f.id).sort()).toEqual(['feature:connectors', 'feature:connectors/credentials'])
    expect(context.threads).toHaveLength(1)
    expect(context.threads[0].merged).toBe(false)
    expect(context.knownIds).toEqual(['feature:connectors', 'feature:connectors/credentials', 'feature:coworkers'])
    expect(JSON.stringify(context)).not.toContain('GREP-OUTPUT')
  })

  it('is fail-soft: failing reads give empty knowledge, never a throw', async () => {
    const context = await gatherAskContext(
      { rootPath: '/repo', question: 'q', tags: [], conversationIds: [] },
      deps({
        searchKnowledge: async () => {
          throw new Error('x')
        },
        readFeatureGraph: async () => {
          throw new Error('x')
        },
        readNotes: async () => {
          throw new Error('x')
        },
      }),
    )
    expect(context).toEqual({ hits: [], features: [], relations: [], notes: [], threads: [], knownIds: [] })
  })
})
