import { addRootAndMaybeActivate, type AddRootPorts } from './add-root'

/** In-memory ports over a single active-root cell, recording activations. */
function makePorts(initialActive: string | null): {
  ports: AddRootPorts<{ rootPath: string }>
  activations: string[]
} {
  let active = initialActive
  const activations: string[] = []
  return {
    ports: {
      addRoot: (rootPath) => ({ rootPath }),
      activeRoot: () => active,
      setActiveProject: (rootPath) => {
        active = rootPath
        activations.push(rootPath)
      },
    },
    activations,
  }
}

describe('addRootAndMaybeActivate (#382)', () => {
  it('activates the added root when nothing is active yet (first/only project)', () => {
    const { ports, activations } = makePorts(null)
    const root = addRootAndMaybeActivate(ports, '/proj/a')
    expect(root.rootPath).toBe('/proj/a')
    expect(activations).toEqual(['/proj/a'])
  })

  it('does NOT change the active project when one is already active', () => {
    const { ports, activations } = makePorts('/proj/existing')
    addRootAndMaybeActivate(ports, '/proj/b')
    expect(activations).toEqual([]) // adding a second project never hijacks focus
  })

  it('activates using the canonical path addRoot returns, not the raw argument', () => {
    const activations: string[] = []
    const ports: AddRootPorts<{ rootPath: string }> = {
      // addRoot dedupes / canonicalizes — the returned path is authoritative.
      addRoot: () => ({ rootPath: '/canonical/a' }),
      activeRoot: () => null,
      setActiveProject: (rootPath) => activations.push(rootPath),
    }
    const root = addRootAndMaybeActivate(ports, '/canonical/a/../a')
    expect(root.rootPath).toBe('/canonical/a')
    expect(activations).toEqual(['/canonical/a'])
  })
})

describe("addRootAndMaybeActivate — foreground 'always' (#1008)", () => {
  it('enters the picked project even when another one is already open', () => {
    const { ports, activations } = makePorts('/proj/existing')
    addRootAndMaybeActivate(ports, '/proj/picked', 'always')
    expect(activations).toEqual(['/proj/picked'])
  })

  it('enters an ALREADY-OPEN project the user re-picked (the total no-op case)', () => {
    // addRoot dedupes the folder to the root that already exists; the pick was
    // still an explicit "take me to this project", so it must activate.
    const activations: string[] = []
    let active: string | null = '/proj/a'
    const ports: AddRootPorts<{ rootPath: string }> = {
      addRoot: (rootPath) => ({ rootPath }), // deduped to the same canonical path
      activeRoot: () => active,
      setActiveProject: (rootPath) => {
        active = rootPath
        activations.push(rootPath)
      },
    }
    addRootAndMaybeActivate(ports, '/proj/b', 'always')
    expect(activations).toEqual(['/proj/b'])
  })

  it('does not re-fire activation when the pick is already the active project', () => {
    const { ports, activations } = makePorts('/proj/a')
    addRootAndMaybeActivate(ports, '/proj/a', 'always')
    expect(activations).toEqual([]) // no pointless activeProjectChanged churn
  })

  it("still guards the BACKGROUND add — 'when-idle' is the default (#382)", () => {
    const { ports, activations } = makePorts('/proj/existing')
    addRootAndMaybeActivate(ports, '/proj/background')
    expect(activations).toEqual([])
  })
})
