import type { RunThreadData } from '../../shared/run-setup'
import {
  COMPOSE_PANEL_REFRESH_MS,
  COMPOSE_PANEL_STRINGS,
  composePanelFace,
  dataRemoveConfirm,
  serviceState,
  sharedFoldersNote,
  shouldRefreshPanel,
  volumeLabel,
} from './compose-panel-model'

const MB = 1024 * 1024
const GB = 1024 * MB

const data = (over: Partial<RunThreadData> = {}): RunThreadData => ({
  threadId: 't1',
  live: true,
  services: [
    { projectName: 'shop', service: 'db', state: 'running' },
    { projectName: 'shop', service: 'redis', state: 'running' },
    { projectName: 'shop', service: 'api', state: null },
  ],
  volumes: [
    { projectName: 'shop', volume: 'pgdata', service: 'db', sizeBytes: 1.2 * GB },
    { projectName: 'shop', volume: 'cache', service: 'redis', sizeBytes: 84 * MB },
  ],
  totalBytes: 1.2 * GB + 84 * MB,
  sharedFolders: ['uploads'],
  unreadable: [],
  problem: null,
  ...over,
})

describe('composePanelFace', () => {
  it('reads as the approved panel: title, status, services, data with sizes and total, the shared folder', () => {
    const face = composePanelFace('Fix login redirect', data())
    expect(face.title).toBe('Containers · Fix login redirect')
    expect(face.status).toBe("This thread's data is running")
    expect(face.services.map((row) => [row.name, row.state, row.tone])).toEqual([
      ['db', 'Running', 'ok'],
      ['redis', 'Running', 'ok'],
      ['api', 'Not created', 'off'],
    ])
    expect(face.volumes.map((row) => [row.label, row.size])).toEqual([
      ['Database (db)', '1.2 GB'],
      ['Cache (redis)', '84 MB'],
    ])
    expect(face.total).toBe('1.3 GB in all')
    expect(face.sharedNote).toBe('The uploads folder is shared with the project and every thread. Flow does not keep a copy per thread.')
    expect(face.restart.label).toBe('Restart')
    expect(face.canRemove).toBe(true)
  })

  it('not live: Start instead of Restart; nothing kept: no total and no removal', () => {
    const face = composePanelFace(null, data({ live: false, volumes: [], totalBytes: 0, sharedFolders: [] }))
    expect(face.title).toBe('Containers · Untitled thread')
    expect(face.status).toBe("This thread's data is not running")
    expect(face.restart.label).toBe('Start')
    expect(face).toMatchObject({ total: null, canRemove: false, noData: COMPOSE_PANEL_STRINGS.noData, sharedNote: null })
  })

  it('a size Docker did not say is said plainly, and leaves the total out', () => {
    const face = composePanelFace('x', data({ volumes: [{ projectName: 'shop', volume: 'pgdata', service: 'db', sizeBytes: null }], totalBytes: null }))
    expect(face.volumes[0]!.size).toBe('size unknown')
    expect(face.total).toBeNull()
  })

  it('names the project beside each row when a thread has several', () => {
    const face = composePanelFace('x', data({
      services: [{ projectName: 'shop', service: 'db', state: 'running' }, { projectName: 'billing', service: 'db', state: 'exited' }],
      volumes: [{ projectName: 'billing', volume: 'pg', service: 'db', sizeBytes: 1 }],
    }))
    expect(face.services.map((row) => row.name)).toEqual(['db · shop', 'db · billing'])
    expect(face.volumes[0]!.label).toBe('Database (db) · billing')
  })
})

describe('pieces', () => {
  it('Docker state words as a person reads them', () => {
    expect(serviceState('exited')).toEqual({ state: 'Stopped', tone: 'off' })
    expect(serviceState('restarting').tone).toBe('busy')
    expect(serviceState('dead').tone).toBe('bad')
  })

  it('volume labels say what kind of data it is when the service tells', () => {
    expect(volumeLabel({ volume: 'pgdata', service: 'postgres' })).toBe('Database (postgres)')
    expect(volumeLabel({ volume: 'x', service: 'worker' })).toBe('x (worker)')
    expect(volumeLabel({ volume: 'orphan', service: null })).toBe('orphan')
  })

  it('several shared folders in one sentence', () => {
    expect(sharedFoldersNote([])).toBeNull()
    expect(sharedFoldersNote(['uploads', 'media'])).toMatch(/^The uploads and media folders are shared/)
  })
})

describe('the confirms', () => {
  it('Reset lists what goes with its size, and says the project and other threads are not touched', () => {
    const confirm = dataRemoveConfirm('reset', composePanelFace('x', data()))
    expect(confirm.title).toBe("Reset this thread's data?")
    expect(confirm.volumes.map((row) => `${row.label} ${row.size}`)).toEqual(['Database (db) 1.2 GB', 'Cache (redis) 84 MB'])
    expect(confirm.note).toBe('The project and other threads are not touched.')
    expect([confirm.cancel, confirm.confirm]).toEqual(['Cancel', 'Reset data'])
    expect(dataRemoveConfirm('delete', composePanelFace('x', data())).confirm).toBe('Delete data')
  })
})

describe('shouldRefreshPanel', () => {
  const base = { open: true, onScreen: true, inflight: false, lastReadAt: 1_000, now: 1_000 }
  it('reads on open, after an action, and on the slow interval — never hidden or twice at once', () => {
    expect(shouldRefreshPanel({ ...base, lastReadAt: null })).toBe(true)
    expect(shouldRefreshPanel({ ...base, force: true })).toBe(true)
    expect(shouldRefreshPanel(base)).toBe(false)
    expect(shouldRefreshPanel({ ...base, now: 1_000 + COMPOSE_PANEL_REFRESH_MS })).toBe(true)
    expect(shouldRefreshPanel({ ...base, onScreen: false, force: true })).toBe(false)
    expect(shouldRefreshPanel({ ...base, inflight: true, force: true })).toBe(false)
    expect(shouldRefreshPanel({ ...base, open: false, force: true })).toBe(false)
  })
})

describe('UI text (forbidden-pattern #12)', () => {
  it('names no command, path or setting', () => {
    const face = composePanelFace('Fix login redirect', data())
    const texts = [...Object.values(COMPOSE_PANEL_STRINGS), face.sharedNote ?? '', face.total ?? '', ...Object.values(dataRemoveConfirm('reset', face))]
    for (const text of texts.filter((t): t is string => typeof t === 'string')) {
      expect(text).not.toMatch(/`|(^|\s)\/[a-z]|\b[a-z]+_[a-z_]+\b|(^|\s)--?[a-z]|docker (volume|compose)/i)
    }
  })
})
