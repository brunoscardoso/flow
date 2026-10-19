// What `threads:setRoots` accepts from the renderer: every root it ADDS must be
// a project Flow knows, because an attached root becomes a folder a runtime may
// read and write (agent-manager's writable roots).

import { createAddressableRoots } from './addressable-roots'
import { checkAttachRoots } from './attach-roots'

const gate = createAddressableRoots({ registeredRoots: () => [{ rootPath: '/p/api' }, { rootPath: '/p/web' }] })

describe('checkAttachRoots', () => {
  it('accepts registered projects', () => {
    expect(checkAttachRoots(['/p/web', '/p/api/'], [], gate)).toEqual({ ok: true, roots: ['/p/web', '/p/api'] })
  })

  it('refuses a root that is not a registered project — the home folder, the filesystem root, anything', () => {
    // Positive first: the same call with a registered root passes.
    expect(checkAttachRoots(['/p/web'], [], gate).ok).toBe(true)
    expect(checkAttachRoots(['/p/web', '/'], [], gate)).toEqual({ ok: false, refused: ['/'] })
    expect(checkAttachRoots(['/Users/me'], [], gate)).toEqual({ ok: false, refused: ['/Users/me'] })
  })

  it('keeps a root the thread already carries, so a removed project can still be detached around', () => {
    expect(checkAttachRoots(['/p/web', '/old/gone'], ['/old/gone'], gate)).toEqual({
      ok: true,
      roots: ['/p/web', '/old/gone'],
    })
  })
})
