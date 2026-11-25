import { MERGE_REASONS_UNREADABLE, MERGE_REASON_NOT_REMOVED, createMergeReasons } from './merge-reasons'
import type { WorkspaceCliRun } from './workspace-registry'

function fakeCli(answers: Record<string, WorkspaceCliRun>) {
  const calls: string[][] = []
  const runCli = async (_cwd: string, args: readonly string[]): Promise<WorkspaceCliRun> => {
    calls.push([...args])
    const answer = answers[args[2] ?? '']
    if (answer === undefined) throw new Error(`unexpected CLI call: ${args.join(' ')}`)
    return answer
  }
  return { calls, runCli }
}

const LISTED = JSON.stringify({
  action: 'merge-decision',
  op: 'list',
  decisions: [
    { id: 'aaaa000000000001', kind: 'same-plan', project: 'web', path: 'plans/x.md', reason: 'unknown kind is dropped', ts: '2026-11-01T00:00:00Z' },
    { id: 'aaaa000000000002', kind: 'overlapping-anchors', project: 'web', path: 'brain/features/a.md', take: 'both', summary: 's', reason: 'Keep both.', outcome: 'agreed', author: 'Sam', ts: '2026-11-02T00:00:00Z' },
    { id: 'aaaa000000000003', kind: 'decision', project: 'api', path: 'brain/decisions/c.md', take: 'ours', reason: 'Mine.', outcome: 'disagreed', author: '', ts: '2026-11-03T00:00:00Z' },
  ],
})

describe('the shared merge reasons', () => {
  it('lists through the CLI, newest first, rebuilding each decision and dropping what is not one', async () => {
    const cli = fakeCli({ list: { ok: true, stdout: `${LISTED}\n` } })
    const reasons = createMergeReasons({ runCli: cli.runCli, cwd: '/home' })
    const result = await reasons.list('acme')
    expect(cli.calls).toEqual([['workspace', 'merge-decision', 'list', '--workspace', 'acme', '--json']])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reasons.map((reason) => reason.id)).toEqual(['aaaa000000000003', 'aaaa000000000002'])
    expect(result.reasons[0]).toMatchObject({ kind: 'decision', outcome: 'disagreed', author: null })
    expect(result.reasons[1]).toMatchObject({ kind: 'overlapping-anchors', take: 'both', author: 'Sam' })
  })

  it('answers a plain sentence when the list cannot be read — never the CLI prose', async () => {
    const cli = fakeCli({ list: { ok: false, stdout: 'workspace refused: unknown-workspace — run planflow-ai workspace status', error: 'exit 1' } })
    const result = await createMergeReasons({ runCli: cli.runCli, cwd: '/home' }).list('acme')
    expect(result).toEqual({ ok: false, detail: MERGE_REASONS_UNREADABLE })
  })

  it('removes by id, then answers the list as it is afterwards', async () => {
    const cli = fakeCli({
      remove: { ok: true, stdout: JSON.stringify({ action: 'merge-decision', op: 'remove', id: 'aaaa000000000002', recorded: true }) },
      list: { ok: true, stdout: LISTED },
    })
    const result = await createMergeReasons({ runCli: cli.runCli, cwd: '/home' }).remove('acme', 'aaaa000000000002')
    expect(cli.calls[0]).toEqual(['workspace', 'merge-decision', 'remove', '--id', 'aaaa000000000002', '--workspace', 'acme', '--json'])
    expect(cli.calls[1]?.[2]).toBe('list')
    expect(result.ok).toBe(true)
  })

  it('a refused removal says so and lists nothing', async () => {
    const cli = fakeCli({ remove: { ok: false, stdout: '', error: 'exit 1' } })
    const result = await createMergeReasons({ runCli: cli.runCli, cwd: '/home' }).remove('acme', 'aaaa000000000002')
    expect(result).toEqual({ ok: false, detail: MERGE_REASON_NOT_REMOVED })
    expect(cli.calls).toHaveLength(1)
  })
})
