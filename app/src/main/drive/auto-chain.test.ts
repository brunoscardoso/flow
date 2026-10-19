import { shouldAutoChain } from './auto-chain'

describe('what starts a chain', () => {
  it('takes the opening message of a conversation', () => {
    expect(shouldAutoChain({ messageCount: 0, content: 'add a dark mode toggle' })).toBe(true)
  })

  // A later message is a reply inside work already under way; treating one as a
  // new aim would restart a workflow mid-flight.
  it('ignores every message after the first', () => {
    for (const messageCount of [1, 2, 40]) {
      expect(shouldAutoChain({ messageCount, content: 'add a dark mode toggle' })).toBe(false)
    }
  })

  // An explicit command is somebody choosing a step themselves — and a chain
  // would then issue a second `/discovery-plan` on top of theirs.
  it.each(['/discovery-plan add dark mode', '/create-plan', '/review-code'])(
    'leaves %s alone',
    (content) => {
      expect(shouldAutoChain({ messageCount: 0, content })).toBe(false)
    },
  )

  it('ignores an empty aim — there would be nothing to name the work', () => {
    expect(shouldAutoChain({ messageCount: 0, content: '' })).toBe(false)
    expect(shouldAutoChain({ messageCount: 0, content: '   \n  ' })).toBe(false)
  })

  it('is not fooled by leading whitespace before a command', () => {
    expect(shouldAutoChain({ messageCount: 0, content: '   /create-plan' })).toBe(false)
  })

  it('takes a message that merely mentions a slash', () => {
    expect(shouldAutoChain({ messageCount: 0, content: 'fix the a/b split' })).toBe(true)
  })
})

describe('attachments', () => {
  // A chain takes the message INSTEAD of sending it, and its first rung carries
  // no files — so chaining here would lose the screenshot silently. The sidebar
  // sends first messages with attachments ("Images with no words are still a
  // message worth sending"), so this is reachable, not theoretical.
  it('does not take a first message carrying files', () => {
    expect(
      shouldAutoChain({ messageCount: 0, content: 'make it look like this', attachmentCount: 1 }),
    ).toBe(false)
  })

  it('still takes one with no files', () => {
    expect(
      shouldAutoChain({ messageCount: 0, content: 'make it look like this', attachmentCount: 0 }),
    ).toBe(true)
    expect(shouldAutoChain({ messageCount: 0, content: 'make it look like this' })).toBe(true)
  })
})
