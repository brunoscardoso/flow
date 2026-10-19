import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { planflowShimTarget, REPAIR_ARGS, repairStaleUserCliShim, userShimPath } from './user-cli-shim'

/** What `init`'s PATH rails write (src/cli/utils/platform-shim.ts, POSIX). */
function cliWrittenShim(entry: string): string {
  return [
    '#!/bin/sh',
    "# planflow-ai shim — written by plan-flow's `planflow-ai init`.",
    '# Points at this checkout: /somewhere',
    '# If that checkout moved or was deleted, this shim is stale: delete this',
    '# file and re-run `planflow-ai init` from the checkout you want on PATH.',
    `exec node "${entry}" "$@"`,
    '',
  ].join('\n')
}

describe('repairStaleUserCliShim', () => {
  let home: string
  let calls: (readonly string[])[]
  const runCli = async (args: readonly string[]): Promise<{ ok: boolean }> => {
    calls.push(args)
    return { ok: true }
  }
  const quiet = (): void => undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'flow-user-shim-home-'))
    calls = []
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  function seed(content: string): string {
    const path = userShimPath(home, 'darwin')
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    writeFileSync(path, content)
    return path
  }

  it('asks the CLI to repair a plan-flow shim whose target is gone', async () => {
    seed(cliWrittenShim('/Applications/Flow.app/Contents/Resources/cli/dist/cli/index.js'))
    const outcome = await repairStaleUserCliShim({ homeDir: home, platform: 'darwin', runCli, log: quiet })
    expect(outcome).toBe('repaired')
    expect(calls).toEqual([REPAIR_ARGS])
  })

  it('leaves a healthy shim alone — no CLI spawn at all', async () => {
    const entry = join(home, 'planflow-ai.mjs')
    writeFileSync(entry, '')
    seed(cliWrittenShim(entry))
    const outcome = await repairStaleUserCliShim({ homeDir: home, platform: 'darwin', runCli, log: quiet })
    expect(outcome).toBe('healthy')
    expect(calls).toEqual([])
  })

  it('never acts on a file plan-flow did not write', async () => {
    const mine = '#!/bin/sh\nexec node "/gone/entry.js" "$@"\n'
    const path = seed(mine)
    const outcome = await repairStaleUserCliShim({ homeDir: home, platform: 'darwin', runCli, log: quiet })
    expect(outcome).toBe('not-ours')
    expect(calls).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(mine)
  })

  it('does nothing when there is no shim', async () => {
    const outcome = await repairStaleUserCliShim({ homeDir: home, platform: 'darwin', runCli, log: quiet })
    expect(outcome).toBe('no-shim')
    expect(calls).toEqual([])
  })

  it('reports a failed repair instead of throwing', async () => {
    seed(cliWrittenShim('/gone/dist/cli/index.js'))
    const lines: string[] = []
    const outcome = await repairStaleUserCliShim({
      homeDir: home,
      platform: 'darwin',
      runCli: async () => ({ ok: false, error: 'boom' }),
      log: (line) => lines.push(line),
    })
    expect(outcome).toBe('repair-failed')
    expect(lines.join('\n')).toContain('boom')
  })

  it('reads the Windows shim name and its ASCII marker', () => {
    expect(userShimPath('C:\\Users\\me', 'win32').endsWith('planflow-ai.cmd')).toBe(true)
    const win = "@echo off\r\nrem planflow-ai shim - written by plan-flow's `planflow-ai init`.\r\nnode \"C:\\x\\planflow-ai.mjs\" %*\r\n"
    expect(planflowShimTarget(win)).toBe('C:\\x\\planflow-ai.mjs')
  })
})
