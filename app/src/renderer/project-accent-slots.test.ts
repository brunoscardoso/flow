import { slotsFor } from './project-accent-slots'

describe('slotsFor — each open project wears its place in its Workspace', () => {
  it('matches checkouts to open roots, /private and trailing slashes aside; a project not here has no slot', () => {
    const slots = slotsFor(
      [
        { projects: [{ localPath: '/Users/me/core' }, { localPath: '/private/var/tmp/app/' }, { localPath: null }, { localPath: '/elsewhere' }] },
        { projects: [{ localPath: '/Users/me/mobile' }] },
      ],
      ['/Users/me/core', '/var/tmp/app', '/Users/me/mobile'],
    )
    expect([...slots.entries()]).toEqual([
      ['/Users/me/core', 0],
      ['/var/tmp/app', 1],
      ['/Users/me/mobile', 0],
    ])
  })
})
