// The one-time classify pass (plan `feature-type-icons`, FR-10 / NFR-4).
//
// Learned features with only a guessed role, sent to the smallest model in
// batches — names, summaries, part names, never code — and every answer written
// through the learnedRole verb. Stoppable; a failure is a count, never a throw.

import {
  CLASSIFY_BATCH_SIZE,
  batchCandidates,
  buildClassifyPrompt,
  classifyRoles,
  createRoleClassifier,
  parseClassifyReply,
} from './classify-roles'
import {
  countUnclassifiedRoles,
  selectRoleClassifyCandidates,
  type RoleClassifyNode,
} from '../../shared/role-classify'
import { FEATURE_ROLES, type FeatureRole } from '../../shared/feature-role'

function core(id: string, patch: Partial<RoleClassifyNode> = {}): RoleClassifyNode {
  return { id, name: id.replace('feature:', ''), kind: 'core', understanding: 'learned', roleSource: 'guess', summary: `${id} summary`, ...patch }
}
function part(parent: string, name: string, patch: Partial<RoleClassifyNode> = {}): RoleClassifyNode {
  return { id: `${parent}/${name}`, name, kind: 'part', parent, understanding: 'none', roleSource: 'guess', summary: `${name} does things`, ...patch }
}

describe('selectRoleClassifyCandidates', () => {
  it('takes learned and stale features whose role is only a guess', () => {
    const nodes = [
      core('feature:a'),
      core('feature:b', { understanding: 'stale' }),
      core('feature:c', { understanding: 'none' }),
      core('feature:d', { understanding: 'learning' }),
      core('feature:e', { roleSource: 'learn' }),
      core('feature:f', { roleSource: 'person' }),
    ]
    expect(selectRoleClassifyCandidates(nodes).map((c) => c.id)).toEqual(['feature:a', 'feature:b'])
  })

  it("takes a guessed part of a learned feature, and sends the feature's part names", () => {
    const nodes = [
      core('feature:a'),
      part('feature:a', 'sse'),
      part('feature:a', 'store', { roleSource: 'learn' }),
      core('feature:z', { understanding: 'none' }),
      part('feature:z', 'orphan'),
    ]
    const candidates = selectRoleClassifyCandidates(nodes)
    expect(candidates.map((c) => c.id)).toEqual(['feature:a', 'feature:a/sse'])
    expect(candidates[0].partNames).toEqual(['sse', 'store'])
    expect(candidates[1]).toMatchObject({ kind: 'part', featureName: 'a' })
  })

  it('ignores change records, and nodes from a CLI that names no source', () => {
    const nodes = [core('feature:a', { roleSource: undefined }), { ...core('feature:x'), kind: 'child' as const }]
    expect(countUnclassifiedRoles(nodes)).toBe(0)
  })
})

describe('batchCandidates', () => {
  it('splits into batches of twenty by default', () => {
    const items = Array.from({ length: 45 }, (_, i) => i)
    expect(batchCandidates(items).map((batch) => batch.length)).toEqual([CLASSIFY_BATCH_SIZE, CLASSIFY_BATCH_SIZE, 5])
    expect(batchCandidates([], 20)).toEqual([])
  })
})

describe('buildClassifyPrompt', () => {
  const candidates = selectRoleClassifyCandidates([core('feature:chats', { summary: 'Streams replies.' }), part('feature:chats', 'SSE stream')])

  it('names every id, the role list, and asks for a JSON map', () => {
    const prompt = buildClassifyPrompt(candidates)
    expect(prompt).toContain('- id: feature:chats')
    expect(prompt).toContain('- id: feature:chats/SSE stream')
    expect(prompt).toContain('summary: Streams replies.')
    expect(prompt).toContain('parts: SSE stream')
    for (const role of FEATURE_ROLES) expect(prompt).toContain(`- ${role}:`)
    expect(prompt).toContain('{ "roles": { "<id>": "<one word from the role list>" } }')
  })

  it('sends no code — only the fields the candidate carries', () => {
    // A node with anchors, folders and a path-shaped summary: none of the code
    // reaches the prompt, because the candidate type cannot carry it.
    const node = {
      ...core('feature:x', { summary: 'Short.' }),
      anchors: ['src/secret/impl.ts'],
      folders: { rows: [{ path: 'src/secret', lines: 1, files: 1, share: 1 }] },
      code: 'function leak() {}',
    } as unknown as RoleClassifyNode
    const prompt = buildClassifyPrompt(selectRoleClassifyCandidates([node]))
    expect(prompt).not.toContain('src/secret')
    expect(prompt).not.toContain('function leak')
    expect(Object.keys(selectRoleClassifyCandidates([node])[0]).sort()).toEqual(['id', 'kind', 'name', 'partNames', 'summary'])
  })
})

describe('parseClassifyReply', () => {
  const asked = ['feature:a', 'feature:b', 'feature:c']

  it('keeps on-list roles for asked ids only, normalising case', () => {
    const roles = parseClassifyReply(
      'Sure:\n{"roles":{"feature:a":"API","feature:b":"frontend","feature:ghost":"ui","feature:c":"data"}}',
      asked,
    )
    expect([...roles.entries()]).toEqual([
      ['feature:a', 'api'],
      ['feature:c', 'data'],
    ])
  })

  it('accepts a bare map', () => {
    expect(parseClassifyReply('{"feature:a":"jobs"}', asked).get('feature:a')).toBe('jobs')
  })

  it('reads nothing from no reply or a broken one', () => {
    expect(parseClassifyReply(null, asked).size).toBe(0)
    expect(parseClassifyReply('{"roles": ', asked).size).toBe(0)
    expect(parseClassifyReply('[1,2]', asked).size).toBe(0)
  })
})

describe('classifyRoles', () => {
  const nodes = Array.from({ length: 25 }, (_, i) => core(`feature:f${String(i)}`))

  /** A model that answers `api` for every id it is asked about. */
  const answerAll = (role: string) => (prompt: string): Promise<string> => {
    const ids = [...prompt.matchAll(/^- id: (.+)$/gm)].map((match) => match[1])
    return Promise.resolve(JSON.stringify({ roles: Object.fromEntries(ids.map((id) => [id, role])) }))
  }

  it('asks in batches and writes every answer through the writer', async () => {
    const prompts: string[] = []
    const writes: Array<[string, FeatureRole]> = []
    const progress: number[] = []
    const result = await classifyRoles({
      readNodes: () => Promise.resolve(nodes),
      askModel: (prompt) => {
        prompts.push(prompt)
        return answerAll('api')(prompt)
      },
      writeRole: (id, role) => {
        writes.push([id, role])
        return Promise.resolve(true)
      },
      signal: new AbortController().signal,
      onProgress: ({ done }) => progress.push(done),
    })
    expect(prompts).toHaveLength(2)
    expect(writes).toHaveLength(25)
    expect(writes[0]).toEqual(['feature:f0', 'api'])
    expect(progress).toEqual([20, 25])
    expect(result).toEqual({ written: 25, skipped: 0, failed: 0, total: 25, stopped: false })
  })

  it('skips an unusable answer, counts a refusal as failed, and never writes an invalid role', async () => {
    const writes: string[] = []
    const result = await classifyRoles({
      readNodes: () => Promise.resolve([core('feature:a'), core('feature:b'), core('feature:c')]),
      askModel: () => Promise.resolve('{"roles":{"feature:a":"ui","feature:b":"widget","feature:c":"data"}}'),
      writeRole: (id) => {
        writes.push(id)
        return Promise.resolve(id !== 'feature:c')
      },
      signal: new AbortController().signal,
    })
    expect(writes).toEqual(['feature:a', 'feature:c'])
    expect(result).toMatchObject({ written: 1, skipped: 1, failed: 1, total: 3 })
  })

  it('a failed model call fails that batch and the pass goes on', async () => {
    let call = 0
    const result = await classifyRoles({
      readNodes: () => Promise.resolve(nodes),
      askModel: (prompt) => {
        call += 1
        return call === 1 ? Promise.reject(new Error('down')) : answerAll('ui')(prompt)
      },
      writeRole: () => Promise.resolve(true),
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ written: 5, failed: 20, stopped: false })
  })

  it('stops between batches when aborted', async () => {
    const controller = new AbortController()
    let asked = 0
    const result = await classifyRoles({
      readNodes: () => Promise.resolve(nodes),
      askModel: (prompt) => {
        asked += 1
        controller.abort()
        return answerAll('ui')(prompt)
      },
      writeRole: () => Promise.resolve(true),
      signal: controller.signal,
    })
    expect(asked).toBe(1)
    expect(result.stopped).toBe(true)
    expect(result.written).toBe(0)
  })

  it('does nothing when there is nothing to classify', async () => {
    let asked = false
    const result = await classifyRoles({
      readNodes: () => Promise.resolve([core('feature:a', { roleSource: 'learn' })]),
      askModel: () => {
        asked = true
        return Promise.resolve(null)
      },
      writeRole: () => Promise.resolve(true),
      signal: new AbortController().signal,
    })
    expect(asked).toBe(false)
    expect(result.total).toBe(0)
  })
})

describe('createRoleClassifier', () => {
  it('runs one pass per project, refuses a second, and stops on request', async () => {
    let release: (value: string | null) => void = () => undefined
    const classifier = createRoleClassifier({
      readNodes: () => Promise.resolve([core('feature:a')]),
      askModel: () =>
        new Promise<string | null>((resolve) => {
          release = resolve
        }),
      writeRole: () => Promise.resolve(true),
    })
    const first = classifier.run('/repo', { stop: false })
    await new Promise((resolve) => setImmediate(resolve))
    expect(classifier.isRunning('/repo')).toBe(true)

    const second = await classifier.run('/repo', { stop: false })
    expect(second.ok).toBe(false)
    expect(second.reason).not.toMatch(/planflow-ai|--/)

    const stop = await classifier.run('/repo', { stop: true })
    expect(stop).toMatchObject({ ok: true, stopped: true })
    release('{"roles":{"feature:a":"ui"}}')
    const finished = await first
    expect(finished).toMatchObject({ ok: true, stopped: true, written: 0 })
    expect(classifier.isRunning('/repo')).toBe(false)
  })

  it('reports progress with the project it belongs to', async () => {
    const events: Array<[string, number]> = []
    const classifier = createRoleClassifier({
      readNodes: () => Promise.resolve([core('feature:a')]),
      askModel: () => Promise.resolve('{"roles":{"feature:a":"ui"}}'),
      writeRole: () => Promise.resolve(true),
      onProgress: (root, progress) => events.push([root, progress.written]),
    })
    const result = await classifier.run('/repo', { stop: false })
    expect(result).toMatchObject({ ok: true, written: 1 })
    expect(events).toEqual([['/repo', 1]])
  })
})
