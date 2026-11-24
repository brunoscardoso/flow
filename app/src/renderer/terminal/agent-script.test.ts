// "Fix with the agent" — the prompt, the label, the line diff, applying and
// undoing the agent's script, and the proposal store's decisions. All pure.

import type { RunProjectLayers } from '../../shared/run-setup'
import {
  agentScriptLabel,
  agentScriptMode,
  agentScriptPrompt,
  agentWrittenNote,
  applyAgentScript,
  changedLines,
  changeStep,
  isDirty,
  SETUP_STRINGS,
  startDraft,
  undoAgentScript,
  type RunSetupDraft,
} from './run-setup-model'
import { proposalOutcome, ScriptProposalStore } from './script-proposals'

const ROOT = '/work/core'

function project(): RunProjectLayers {
  return {
    root: ROOT,
    name: 'lumen-core',
    cwd: ROOT,
    hasSharedSetup: true,
    problems: [],
    setup: {
      version: 1,
      steps: [
        { id: 'web', name: 'web', command: 'npm run dev', start: 'now' },
        {
          id: 'reset',
          name: 'reset-database',
          command: '#!/usr/bin/env bash\nset -euo pipefail\ndocker compose down -v\nuv run alembic upgrade head',
          start: 'now',
          kind: 'once',
          body: 'script',
          confirm: true,
        },
        { id: 'seed', name: 'seed', command: 'make seed', start: 'now', kind: 'once', confirm: false },
      ],
    },
    personal: {},
    conversation: {},
  }
}

const step = (draft: RunSetupDraft, id: string) => draft.steps.find((candidate) => candidate.id === id)!

describe('the agent button', () => {
  it('fixes a script, writes an empty one, and makes a script of a command', () => {
    expect(agentScriptMode({ body: 'script', script: 'echo hi' })).toBe('fix')
    expect(agentScriptMode({ body: 'script', script: '  \n' })).toBe('write')
    expect(agentScriptMode({ body: 'command', script: 'echo hi' })).toBe('make')
    expect(agentScriptLabel('fix')).toBe('Fix with the agent')
    expect(agentScriptLabel('write')).toBe('Write with the agent')
    expect(agentScriptLabel('make')).toBe('Make a script with the agent')
  })

  it('every new sentence follows the page rules (no commands, paths or settings)', () => {
    for (const text of [
      SETUP_STRINGS.agentFix,
      SETUP_STRINGS.agentNeedsConversation,
      SETUP_STRINGS.agentWaiting,
      SETUP_STRINGS.agentKept,
      SETUP_STRINGS.agentUse,
      agentWrittenNote(3),
    ]) {
      expect(text).not.toMatch(/planflow-ai|`|flow\/|\.json\b|\b[a-z]+_[a-z_]+\b|(^|\s)--?[a-z]/)
    }
  })

  it('says how many lines the agent changed', () => {
    expect(agentWrittenNote(2)).toBe('Written by the agent: 2 lines changed. Not saved yet.')
    expect(agentWrittenNote(1)).toBe('Written by the agent: 1 line changed. Not saved yet.')
    expect(agentWrittenNote(0)).toBe('Written by the agent: no lines changed. Not saved yet.')
  })
})

describe('the message to the agent', () => {
  it('a fix carries the script today, the tool, and says not to run it', () => {
    const text = agentScriptPrompt({ action: 'reset-database', project: 'lumen-core', mode: 'fix', script: 'set -e\nmake reset\n', command: '' })
    expect(text).toBe(
      'Fix the Launchpad action "reset-database" in lumen-core, using what we discussed in this conversation. Its script today:\n' +
        '```bash\nset -e\nmake reset\n```\n' +
        'Put the new script into the Launchpad with the launchpad_set_script tool, with the action name "reset-database". Do not run it.',
    )
  })

  it('an empty script asks for a new one', () => {
    const text = agentScriptPrompt({ action: 'seed', project: 'p', mode: 'write', script: '', command: '' })
    expect(text).toContain('Write a script for the Launchpad action "seed" in p')
    expect(text).toContain('It has no script yet.')
    expect(text).not.toContain('```')
  })

  it('a command is turned into a script, its command quoted', () => {
    const text = agentScriptPrompt({ action: 'seed', project: 'p', mode: 'make', script: '', command: ' make seed ' })
    expect(text).toContain('Turn the Launchpad action "seed" in p into a script')
    expect(text).toContain('```bash\nmake seed\n```')
    expect(text).toContain('Do not run it.')
  })

  it('a script holding a fence gets a longer fence', () => {
    const text = agentScriptPrompt({ action: 'a', project: 'p', mode: 'fix', script: 'cat <<EOF\n```\nEOF', command: '' })
    expect(text).toContain('````bash\ncat <<EOF\n```\nEOF\n````')
  })
})

describe('the changed lines', () => {
  it('marks only the lines added or changed, aligned past an insertion', () => {
    const before = 'a\nb\nc\nd'
    const after = 'a\nNEW\nb\nc2\nd'
    expect(changedLines(before, after)).toEqual([1, 3])
  })

  it('marks every line of a script written from nothing, none for no change', () => {
    expect(changedLines('', 'x\ny')).toEqual([0, 1])
    expect(changedLines('x\ny', 'x\ny\n')).toEqual([])
    expect(changedLines('x', '')).toEqual([])
  })

  it('counts duplicates once each', () => {
    expect(changedLines('echo\necho', 'echo\necho\necho')).toEqual([2])
  })
})

describe('applying the agent script', () => {
  it('replaces the script, makes the draft dirty, and keeps Ask before running', () => {
    const draft = startDraft(project())
    const applied = applyAgentScript(draft, 'reset', '#!/usr/bin/env bash\nset -euo pipefail\nexport X=1\ndocker compose down -v\nuv run alembic upgrade head')!
    expect(step(applied.draft, 'reset').script).toContain('export X=1')
    expect(applied.changed).toEqual([2])
    expect(step(applied.draft, 'reset').confirm).toBe(true)
    expect(isDirty(applied.draft)).toBe(true)
  })

  it('a command becomes a script, and its "Ask before running" does not follow the new text', () => {
    const draft = startDraft(project())
    const applied = applyAgentScript(draft, 'seed', 'uv run alembic upgrade head\nmake seed')!
    expect(step(applied.draft, 'seed')).toMatchObject({ body: 'script', confirm: false })
    expect(step(applied.draft, 'seed').command).toBe('make seed')
  })

  it('Undo puts back the body, the text and Ask before running', () => {
    const draft = startDraft(project())
    const applied = applyAgentScript(draft, 'seed', 'make seed\nmake more')!
    const undone = undoAgentScript(applied.draft, 'seed', applied.undo)
    expect(step(undone, 'seed')).toMatchObject({ body: 'command', command: 'make seed', script: '', confirm: false })
    expect(isDirty(undone)).toBe(false)
  })

  it('refuses a running step or an unknown id', () => {
    const draft = startDraft(project())
    expect(applyAgentScript(draft, 'web', 'x')).toBeNull()
    expect(applyAgentScript(draft, 'nope', 'x')).toBeNull()
  })
})

describe('where an arriving script goes', () => {
  const pressedOn = (draft: RunSetupDraft, id: string, action: string) => {
    const s = step(draft, id)
    return { stepId: id, action, body: s.body, script: s.script, command: s.command }
  }

  it('replaces the script of the action pressed when nothing was typed since', () => {
    const draft = startDraft(project())
    expect(proposalOutcome(draft, { action: 'reset-database' }, [pressedOn(draft, 'reset', 'reset-database')])).toEqual({
      kind: 'replace',
      stepId: 'reset',
    })
  })

  it('only offers it when the person typed since pressing', () => {
    const draft = startDraft(project())
    const wait = pressedOn(draft, 'reset', 'reset-database')
    const typed = changeStep(draft, 'reset', { script: 'echo mine' })
    expect(proposalOutcome(typed, { action: 'reset-database' }, [wait])).toEqual({ kind: 'offer', stepId: 'reset' })
  })

  it('follows the pressed action even when it was renamed since', () => {
    const draft = startDraft(project())
    const wait = pressedOn(draft, 'seed', 'seed')
    const renamed = changeStep(draft, 'seed', { name: 'seed-data' })
    expect(proposalOutcome(renamed, { action: 'SEED' }, [wait])).toEqual({ kind: 'replace', stepId: 'seed' })
  })

  it('with no press on record: replaces a saved action left as saved, offers on an edited one', () => {
    const draft = startDraft(project())
    expect(proposalOutcome(draft, { action: 'seed' }, [])).toEqual({ kind: 'replace', stepId: 'seed' })
    const edited = changeStep(draft, 'seed', { command: 'make seed2' })
    expect(proposalOutcome(edited, { action: 'seed' }, [])).toEqual({ kind: 'offer', stepId: 'seed' })
  })

  it('never lands on a running step; an unknown name adds a new action', () => {
    const draft = startDraft(project())
    expect(proposalOutcome(draft, { action: 'web' }, [])).toEqual({ kind: 'add' })
    expect(proposalOutcome(draft, { action: 'lint' }, [])).toEqual({ kind: 'add' })
  })
})

describe('the proposal store', () => {
  it('keeps one waiting entry per action, and forgets it on stop', () => {
    const store = new ScriptProposalStore()
    store.wait('t1', { stepId: 'a', action: 'a', body: 'script', script: '', command: '' })
    store.wait('t1', { stepId: 'a', action: 'a', body: 'script', script: 'x', command: '' })
    expect(store.waits('t1')).toHaveLength(1)
    expect(store.waitingFor('t1', 'a')?.script).toBe('x')
    expect(store.waitingFor('t2', 'a')).toBeNull()
    store.stopWaiting('t1', 'a')
    expect(store.waits('t1')).toEqual([])
  })

  it('keeps scripts per conversation, the newest per action, and hands them over once', () => {
    const store = new ScriptProposalStore()
    store.keep({ threadId: 't1', action: 'seed', script: 'one' })
    store.keep({ threadId: 't1', action: 'Seed', script: 'two' })
    store.keep({ threadId: 't2', action: 'seed', script: 'other' })
    expect(store.take('t1')).toEqual([{ threadId: 't1', action: 'Seed', script: 'two' }])
    expect(store.take('t1')).toEqual([])
    expect(store.take('t2')).toHaveLength(1)
  })
})
