// An agent (⚙) terminal opens WHERE THE AGENT IS.
//
// A thread that owns a git worktree runs its session there (agent-manager's
// `sessionRootFor`), so its terminal tab must start in the same checkout — a
// command the reader takes over otherwise runs against the tree the agent has
// not been writing to, which is the confusion thread worktrees exist to end.
//
// The tab still BELONGS to the project the worktree was cut from: teardown
// filters on `projectRoot` (#1484), and keying that on the worktree would leave
// a removed project's tab running for the life of the process.

import { TerminalManager, TERMINAL_REMOVED_EVENT, type TerminalRemovedEvent } from './index'
import { createBashMirrorHooks, type BashBridgeTerminals } from './bash-bridge'

const PROJECT = '/repos/project'
const WORKTREE = '/repos/.project-threads/blue-heron'

describe('agent terminal root (thread worktrees)', () => {
  it('starts in the worktree while still belonging to the project', () => {
    const mgr = new TerminalManager()
    const info = mgr.ensureAgentTerminal({
      threadId: 't1',
      cwd: WORKTREE,
      projectRoot: PROJECT,
    })

    expect(info.cwd).toBe(WORKTREE)
    expect(info.projectRoot).toBe(PROJECT)
    mgr.disposeAll()
  })

  it('is torn down with its project, not left running beside it (#1484)', () => {
    const mgr = new TerminalManager()
    const removed: string[] = []
    mgr.on(TERMINAL_REMOVED_EVENT, (event: TerminalRemovedEvent) => removed.push(event.terminalId))

    const info = mgr.ensureAgentTerminal({
      threadId: 't1',
      cwd: WORKTREE,
      projectRoot: PROJECT,
    })

    expect(mgr.disposeForRoot(PROJECT)).toBe(1)
    expect(removed).toEqual([info.terminalId])
    mgr.disposeAll()
  })

  it('a thread without a worktree is unchanged — cwd is the project, and so is the owner', () => {
    const mgr = new TerminalManager()
    const info = mgr.ensureAgentTerminal({ threadId: 't1', cwd: PROJECT })

    expect(info.cwd).toBe(PROJECT)
    expect(info.projectRoot).toBe(PROJECT)
    expect(mgr.disposeForRoot(PROJECT)).toBe(1)
    mgr.disposeAll()
  })

  it('the bash bridge opens the tab with both roots', async () => {
    const opened: Array<{ cwd?: string; projectRoot?: string }> = []
    const terminals: BashBridgeTerminals = {
      ensureAgentTerminal: (thread) => {
        opened.push({ cwd: thread.cwd, projectRoot: thread.projectRoot })
        return { terminalId: 'term-1' }
      },
      writeOutput: () => {},
      runCommand: async () => ({ output: '', exitCode: 0, timedOut: false }),
    }

    const hooks = createBashMirrorHooks(terminals, {
      threadId: 't1',
      cwd: WORKTREE,
      projectRoot: PROJECT,
    })
    await hooks.PreToolUse[0].hooks[0](
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_use_id: 'tu-1',
        session_id: 's-1',
        transcript_path: '',
        cwd: WORKTREE,
      },
      'tu-1',
      { signal: new AbortController().signal },
    )

    expect(opened).toEqual([{ cwd: WORKTREE, projectRoot: PROJECT }])
  })
})
