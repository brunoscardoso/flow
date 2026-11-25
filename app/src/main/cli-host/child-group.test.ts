import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ChildGroups, killGroup, spawnInGroup } from './child-group'

const posix = process.platform !== 'win32'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return check()
}

/** A shell that starts a long `sleep` of its own and writes that grandchild's pid down. */
function parentWithGrandchild(dir: string): { child: ReturnType<typeof spawnInGroup>; grandchildPid: () => number | null } {
  const pidFile = join(dir, 'grandchild.pid')
  const child = spawnInGroup('sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], { stdio: 'ignore' })
  const grandchildPid = (): number | null => {
    try {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
      return Number.isSafeInteger(pid) ? pid : null
    } catch {
      return null
    }
  }
  return { child, grandchildPid }
}

const describePosix = posix ? describe : describe.skip

describePosix('child-group (user report 2026-11-24: a killed sync left its git running)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-child-group-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('stops the child AND what it started', async () => {
    const { child, grandchildPid } = parentWithGrandchild(dir)
    expect(await until(() => grandchildPid() !== null)).toBe(true)
    const grandchild = grandchildPid() as number
    // The positive first: both are running.
    expect(alive(child.pid as number)).toBe(true)
    expect(alive(grandchild)).toBe(true)

    killGroup(child)

    expect(await until(() => !alive(grandchild))).toBe(true)
    expect(await until(() => child.exitCode !== null || child.signalCode !== null)).toBe(true)
  })

  it('killAll stops every tracked child with its own children, and forgets children that ended', async () => {
    const groups = new ChildGroups()
    const one = parentWithGrandchild(join(dir))
    groups.track(one.child)
    const quick = spawnInGroup('true', [], { stdio: 'ignore' })
    groups.track(quick)
    expect(await until(() => groups.size === 1)).toBe(true)
    expect(await until(() => one.grandchildPid() !== null)).toBe(true)
    const grandchild = one.grandchildPid() as number
    expect(alive(grandchild)).toBe(true)

    groups.killAll()

    expect(groups.size).toBe(0)
    expect(await until(() => !alive(grandchild))).toBe(true)
  })

  it('is safe on a child that already ended', async () => {
    const quick = spawnInGroup('true', [], { stdio: 'ignore' })
    await new Promise((resolve) => quick.once('exit', resolve))
    expect(() => killGroup(quick)).not.toThrow()
  })
})
