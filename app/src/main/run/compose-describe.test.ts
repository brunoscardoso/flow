// "Does this project have a Compose file?" — the gate in front of every Docker
// call about a project's conversations. Existence only; fakes only.

import { COMPOSE_PRESENCE_TTL_MS, createComposePresence, hasComposeFile } from './compose-describe'

describe('hasComposeFile', () => {
  it('finds any name Compose looks for, and nothing else', async () => {
    for (const name of ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']) {
      expect(await hasComposeFile('/p', { exists: async (path) => path === `/p/${name}` })).toBe(true)
    }
    expect(await hasComposeFile('/p', { exists: async (path) => path === '/p/compose.override.yaml' })).toBe(false)
    expect(await hasComposeFile('/p', { exists: async () => Promise.reject(new Error('denied')) })).toBe(false)
  })
})

describe('createComposePresence', () => {
  it('answers each project from one look for a few seconds, then looks again', async () => {
    let clock = 0
    const looked: string[] = []
    const has = createComposePresence(
      {
        exists: async (path) => {
          looked.push(path)
          return path === '/a/compose.yaml'
        },
      },
      { now: () => clock },
    )
    expect(await has('/a')).toBe(true)
    expect(await has('/b')).toBe(false)
    const once = looked.length
    expect(await has('/a')).toBe(true)
    expect(await has('/b')).toBe(false)
    expect(looked).toHaveLength(once)
    clock += COMPOSE_PRESENCE_TTL_MS
    await has('/a')
    expect(looked.length).toBeGreaterThan(once)
  })
})
