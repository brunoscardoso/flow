import { promptSummary } from './prompt-summary'

// #1404: the inbox is the durable record of what a blocked task asked, and it
// stored raw markdown. On the daemon's real prompt template every entry's line
// was the identical constant `# Heartbeat Prompt` — a list of them said
// nothing about any of them.

describe('promptSummary (#1404)', () => {
  it('skips the template title every prompt shares', () => {
    const body = '# Heartbeat Prompt\n\nShould I force-push the rebase?\n'
    expect(promptSummary(body)).toBe('Should I force-push the rebase?')
  })

  it('skips several headings and rules to reach the question', () => {
    const body = '# Heartbeat Prompt\n\n## Task\n\n---\n\nWhich database should I migrate first?'
    expect(promptSummary(body)).toBe('Which database should I migrate first?')
  })

  it('strips list markers and inline markup', () => {
    expect(promptSummary('# T\n\n- **Deploy** to `prod`?')).toBe('Deploy to prod?')
    expect(promptSummary('# T\n\n1. Approve the _risky_ change?')).toBe('Approve the risky change?')
  })

  it('falls back to the heading when that is genuinely all there is', () => {
    // Better a title than an empty row.
    expect(promptSummary('# Heartbeat Prompt')).toBe('Heartbeat Prompt')
  })

  it('leaves an ordinary one-line body alone', () => {
    expect(promptSummary('Build failed on main')).toBe('Build failed on main')
  })

  it('is stable for an empty body', () => {
    expect(promptSummary('')).toBe('')
    expect(promptSummary('\n\n   \n')).toBe('')
  })

  it('distinguishes two prompts from the same template', () => {
    // The actual point: a list of entries must not all read the same.
    const a = promptSummary('# Heartbeat Prompt\n\nRun the migration?')
    const b = promptSummary('# Heartbeat Prompt\n\nDelete the stale branch?')
    expect(a).not.toBe(b)
  })
})
