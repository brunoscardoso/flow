import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { automaticBasicDiscovery, E2E_RENDERER_ARG, e2eRendererArguments, e2eSeams } from './e2e-seams'

describe('e2eSeams', () => {
  const g = globalThis as Record<string, unknown>
  afterEach(() => {
    delete g['__flowE2ESeams']
  })

  it('hands back what a hidden run set', () => {
    const seams = { askFastModel: async () => '{}' }
    g['__flowE2ESeams'] = seams
    expect(e2eSeams({ FLOW_E2E: '1' })).toBe(seams)
  })

  it('is null outside a hidden run, whatever globalThis holds', () => {
    g['__flowE2ESeams'] = { askFastModel: async () => '{}' }
    expect(e2eSeams({})).toBeNull()
    expect(e2eSeams({ FLOW_E2E: 'true' })).toBeNull()
  })

  it('is null when nothing was set', () => {
    expect(e2eSeams({ FLOW_E2E: '1' })).toBeNull()
    g['__flowE2ESeams'] = 'not an object'
    expect(e2eSeams({ FLOW_E2E: '1' })).toBeNull()
  })

  it('sweeps automatically outside a hidden run, and inside one only with a stand-in', () => {
    expect(automaticBasicDiscovery({})).toBe(true)
    g['__flowE2ESeams'] = { basicDiscovery: async () => ({ kind: 'done', learned: 0, failed: 0 }) }
    expect(automaticBasicDiscovery({})).toBe(true)
    expect(automaticBasicDiscovery({ FLOW_E2E: '1' })).toBe(true)
    g['__flowE2ESeams'] = { askFastModel: async () => '{}' }
    expect(automaticBasicDiscovery({ FLOW_E2E: '1' })).toBe(false)
  })
})

describe('e2eRendererArguments', () => {
  it('hands the renderer the e2e flag in a hidden, unpackaged run', () => {
    expect(e2eRendererArguments({ FLOW_E2E: '1' }, false)).toEqual([E2E_RENDERER_ARG])
  })

  it('hands nothing outside a hidden run', () => {
    expect(e2eRendererArguments({}, false)).toEqual([])
    expect(e2eRendererArguments({ FLOW_E2E: 'true' }, false)).toEqual([])
  })

  it('hands nothing in a packaged app, whatever the environment says', () => {
    expect(e2eRendererArguments({ FLOW_E2E: '1' }, true)).toEqual([])
  })

  it('names the flag the preload actually reads', () => {
    // The sandboxed preload cannot import main's module, so it keeps its own
    // literal; this is what keeps the two in step.
    const preload = readFileSync(join(__dirname, '..', 'preload', 'index.ts'), 'utf-8')
    expect(preload).toContain(`const E2E_ARG = '${E2E_RENDERER_ARG}'`)
    expect(preload).toContain('process.argv.includes(E2E_ARG)')
    expect(preload).not.toContain('process.env.FLOW_E2E')
  })
})
