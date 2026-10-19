import { terminalRootTag } from './terminal-root-tag'

const PROJECT = '/Users/dev/projects/plan-flow'
const GONE = '/Users/dev/projects/plan-flow/.plan-flow-threads/a1b2c3'

describe('terminalRootTag', () => {
  it('says nothing about an ordinary shell', () => {
    // The tag is not a label for where a terminal is — it is a warning, and a
    // warning on every tab is noise repeated per tab.
    expect(terminalRootTag(PROJECT, new Set())).toBeNull()
    expect(terminalRootTag(PROJECT, undefined)).toBeNull()
  })

  it('says nothing for an unscoped shell', () => {
    // The boot terminal spawns before any project exists — it has no root, so
    // no root of its can have gone missing.
    expect(terminalRootTag(undefined, new Set([GONE]))).toBeNull()
  })

  it('tags a shell whose directory was removed', () => {
    expect(terminalRootTag(GONE, new Set([GONE]))?.label).toBe('folder gone')
  })

  it('tells the reader the shell and its output survive the removal', () => {
    // C3: the answer lives in the tag's OWN tooltip now — there is no other tag
    // left to carry half of it.
    const tag = terminalRootTag(GONE, new Set([GONE]))
    expect(tag?.tooltip).toContain('keeps running')
    expect(tag?.tooltip).toContain('still here')
    expect(tag?.tooltip).toContain('nowhere to look')
  })

  it('never calls an unheard-of root gone', () => {
    // Absence from the missing set is not evidence of removal — only a failed
    // read is, and that is what puts a root in the set.
    expect(terminalRootTag('/somewhere/else', new Set([GONE]))).toBeNull()
  })

  it('never puts a path, a command or the old vocabulary on screen (#12)', () => {
    const tag = terminalRootTag(GONE, new Set([GONE]))
    for (const text of [tag?.label ?? '', tag?.tooltip ?? '']) {
      expect(text).not.toMatch(/planflow-ai|\/Users\/|\.plan-flow-threads|`/)
      expect(text.toLowerCase()).not.toMatch(/worktree|workspace/)
    }
  })
})
