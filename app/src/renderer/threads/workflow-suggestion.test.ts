// Workflow next-step suggestion — pure logic, no DOM (node test env).

import type { SlashCommand } from '../../shared/ipc-contract'
import { computeNextStepCommand, nextStepVisible } from './workflow-suggestion'

const COMMANDS: SlashCommand[] = [
  { name: 'brainstorm', description: 'Explore an idea' },
  { name: 'discovery-plan', description: 'Gather requirements' },
  { name: 'create-plan', description: 'Build a plan' },
  { name: 'execute-plan', description: 'Execute the plan' },
  { name: 'review-code', description: 'Review changes' },
]

function user(content: string): { role: string; content: string } {
  return { role: 'user', content }
}

function assistant(content: string): { role: string; content: string } {
  return { role: 'assistant', content }
}

describe('computeNextStepCommand', () => {
  it('suggests /discovery-plan after /brainstorm', () => {
    const next = computeNextStepCommand([user('/brainstorm a new feature')], COMMANDS)
    expect(next?.name).toBe('discovery-plan')
    expect(next?.description).toBe('Gather requirements')
  })

  it('suggests /create-plan after /artifact — the artifact is written after the discovery', () => {
    const next = computeNextStepCommand([user('/artifact @flow/discovery/discovery_pay_v1.md')], COMMANDS)
    expect(next?.name).toBe('create-plan')
  })

  it('advances through the workflow: discovery → create-plan', () => {
    const next = computeNextStepCommand(
      [user('/brainstorm x'), assistant('...'), user('/discovery-plan')],
      COMMANDS,
    )
    expect(next?.name).toBe('create-plan')
  })

  it('keys off the LAST user message only', () => {
    const next = computeNextStepCommand(
      [user('/discovery-plan'), user('/create-plan')],
      COMMANDS,
    )
    expect(next?.name).toBe('execute-plan')
  })

  it('suggests nothing once the user sends a plain follow-up (not persistent)', () => {
    const next = computeNextStepCommand(
      [user('/brainstorm x'), assistant('ok'), user('actually, also consider Y')],
      COMMANDS,
    )
    expect(next).toBeNull()
  })

  it('returns null when the latest command is terminal (no successor)', () => {
    expect(computeNextStepCommand([user('/review-code')], COMMANDS)).toBeNull()
  })

  it('returns null when no workflow command has been run', () => {
    expect(computeNextStepCommand([user('hello there')], COMMANDS)).toBeNull()
  })

  it('returns null when the next skill is not installed in the project', () => {
    const withoutDiscovery = COMMANDS.filter((c) => c.name !== 'discovery-plan')
    expect(computeNextStepCommand([user('/brainstorm x')], withoutDiscovery)).toBeNull()
  })

  it('ignores a slash command that only appears in an assistant message', () => {
    expect(computeNextStepCommand([assistant('run /brainstorm next')], COMMANDS)).toBeNull()
  })
})

describe('nextStepVisible', () => {
  const idle = { hasSuggestion: true, hasThread: true, status: 'idle', backgroundBusy: false }

  it('shows the next step once the turn and its background work have finished', () => {
    expect(nextStepVisible(idle)).toBe(true)
  })

  it('waits while the turn ended but its background work still runs', () => {
    // /execute-plan replies "Phase 4 is still running" and ends its turn; the
    // step is not finished, so /review-code is not offered yet.
    expect(nextStepVisible({ ...idle, backgroundBusy: true })).toBe(false)
  })

  it('waits while the turn itself is running', () => {
    expect(nextStepVisible({ ...idle, status: 'working' })).toBe(false)
  })

  it('shows nothing without a suggestion or a thread', () => {
    expect(nextStepVisible({ ...idle, hasSuggestion: false })).toBe(false)
    expect(nextStepVisible({ ...idle, hasThread: false })).toBe(false)
  })
})
