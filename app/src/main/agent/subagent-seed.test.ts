// The continuation seed for a promoted sub-agent child thread (#1931): first
// turn only, built from the sub-agent's task + where it left off, and null for
// an ordinary thread so it composes behind the task seed.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from '../store/db'
import { ThreadStore } from '../store/thread-store'
import { makeSubagentSeedProvider } from './subagent-seed'

const ROOT_A = '/tmp/project-a'

describe('makeSubagentSeedProvider (#1931)', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: ThreadStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-subagent-seed-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new ThreadStore(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns null for an ordinary thread', () => {
    const thread = store.createThread({ projectRoot: ROOT_A })
    expect(makeSubagentSeedProvider(store)(thread.id)).toBeNull()
  })

  it('seeds a promoted child with its task and where it left off', () => {
    const parent = store.createThread({ projectRoot: ROOT_A, title: 'Main' })
    const spawn = store.recordToolCall({
      threadId: parent.id,
      toolName: 'Agent',
      inputJson: JSON.stringify({
        description: 'Summarize the repo',
        subagent_type: 'general-purpose',
        prompt: 'Read the README and summarize',
      }),
    })
    store.appendMessage(parent.id, 'assistant', 'The repo is a CLI tool.', null, spawn.id)

    const child = store.openSubagentThread(parent.id, spawn.id)
    const seed = makeSubagentSeedProvider(store)(child.id)

    expect(seed).not.toBeNull()
    expect(seed).toContain('continuing a sub-agent')
    expect(seed).toContain('Summarize the repo')
    expect(seed).toContain('Read the README and summarize')
    expect(seed).toContain('The repo is a CLI tool.')
  })
})
