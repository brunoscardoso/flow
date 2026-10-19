import type { ThreadWorktreeResult } from '../../shared/ipc-contract'
import { canOfferWorktree, worktreeActionNotice } from './worktree-outcome'

const EVERY_STATUS: ThreadWorktreeResult['status'][] = [
  'ready',
  'created',
  'needs-choice',
  'disabled',
  'refused',
  'busy',
  'unavailable',
]

describe('canOfferWorktree', () => {
  it('offers the action only to a thread that has no worktree', () => {
    expect(canOfferWorktree({ worktreePath: null })).toBe(true)
    expect(canOfferWorktree({ worktreePath: '/x/.p-threads/t' })).toBe(false)
  })
})

describe('worktreeActionNotice', () => {
  it('names the thread it is talking about', () => {
    const notice = worktreeActionNotice({ status: 'created' }, 'Fix the login redirect')
    expect(notice.body).toContain('“Fix the login redirect”')
  })

  it('falls back gracefully for a thread that has no name yet', () => {
    const notice = worktreeActionNotice({ status: 'created' }, '  ')
    expect(notice.body).toContain('This thread')
    expect(notice.body).not.toContain('“”')
  })

  it('carries the detail main reported about the user’s own work', () => {
    const notice = worktreeActionNotice(
      { status: 'created', detail: 'Your changes are stashed.' },
      'T',
    )
    expect(notice.body).toContain('Your changes are stashed.')
  })

  it('relays main’s reason for a refusal rather than inventing one', () => {
    const notice = worktreeActionNotice(
      { status: 'refused', detail: 'This project isn’t tracked by git.' },
      'T',
    )
    expect(notice.body).toBe('This project isn’t tracked by git.')
    // A refusal is not an error — the thread carries on exactly as before.
    expect(notice.level).toBe('info')
  })

  it('says wait, not done, while a turn is running', () => {
    const notice = worktreeActionNotice({ status: 'busy' }, 'T')
    expect(notice.body).toContain('finished')
    expect(notice.title).not.toContain('ready')
  })

  it('points at the settings panel, never at the config key, when turned off', () => {
    const notice = worktreeActionNotice({ status: 'disabled' }, 'T')
    expect(notice.body).toContain('Flow settings')
    expect(notice.body).not.toContain('thread_worktrees')
  })

  it('answers every status — an action always owes an answer', () => {
    for (const status of EVERY_STATUS) {
      const notice = worktreeActionNotice({ status }, 'T')
      expect(notice.title.length).toBeGreaterThan(0)
      expect(notice.body.length).toBeGreaterThan(0)
      expect(['info', 'error']).toContain(notice.level)
    }
  })

  // The module kept its file name (the IPC result it reads is still called a
  // worktree) but none of its SENTENCES may say so any more: a person is told
  // about a branch, which is the whole of what they get.
  it('answers in branches — never in copies, workspaces or worktrees', () => {
    for (const status of EVERY_STATUS) {
      const notice = worktreeActionNotice({ status }, 'T')
      for (const text of [notice.title, notice.body]) {
        expect(text.toLowerCase()).not.toContain('workspace')
        expect(text.toLowerCase()).not.toContain('worktree')
        expect(text.toLowerCase()).not.toContain('copy of the')
      }
    }
  })

  it('never puts a command, a path or a config key on screen (#12)', () => {
    for (const status of EVERY_STATUS) {
      const notice = worktreeActionNotice({ status }, 'T')
      for (const text of [notice.title, notice.body]) {
        expect(text).not.toContain('`')
        expect(text).not.toContain('planflow-ai')
        expect(text).not.toContain('git ')
        expect(text).not.toMatch(/(^|\s)[~/]\S/)
      }
    }
  })
})
