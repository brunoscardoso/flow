import type { InvariantVerdict } from '../../shared/ipc-contract'
import { invariantFlagsByFile } from './invariant-flags'

const v = (
  filePath: string,
  verdict: InvariantVerdict['verdict'],
  invariant = 'inv',
): InvariantVerdict => ({ module: 'm', invariant, verdict, filePath, evidence: '' })

describe('invariantFlagsByFile (#898)', () => {
  it('rolls violates/touches per file; clear and file-less verdicts never flag', () => {
    const flags = invariantFlagsByFile([
      v('a.ts', 'touches', 'first'),
      v('a.ts', 'violates', 'second'),
      v('b.ts', 'clear'),
      v('', 'violates'),
    ])
    expect(flags.size).toBe(1)
    const flag = flags.get('a.ts')
    expect(flag).toMatchObject({ count: 2, worst: 'violates' })
    expect(flag?.title).toBe('touches: first\nviolates: second')
  })

  it('touches-only file stays worst=touches', () => {
    const flags = invariantFlagsByFile([v('a.ts', 'touches')])
    expect(flags.get('a.ts')?.worst).toBe('touches')
  })
})
