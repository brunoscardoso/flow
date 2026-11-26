// Every sentence the per-thread Docker data feature puts on screen, in one
// scan (forbidden-pattern #12): no backtick, no command flag, no path, no
// config key, no product-internal name. A new string added to any of these
// constants is checked the moment it exists.

import type { RunDockerNotice, RunThreadData } from '../../shared/run-setup'
import { COMPOSE_PANEL_STRINGS, composePanelFace, dataRemoveConfirm } from '../../renderer/terminal/compose-panel-model'
import { KEPT_DATA_STRINGS, keptConfirm, keptRow, keptSection } from '../../renderer/settings/kept-data-model'
import { DOCKER_STRINGS, dockerNoticeFace, switchSentence } from '../../renderer/terminal/run-group-model'
import { THREAD_DATA_STRINGS } from '../../renderer/threads/thread-data-state'
import { VOLUMES_LABEL, threadDeleteNotice, type ThreadDeleteSubject } from '../../renderer/threads/thread-sidebar-delete-notice'
import { liveThread, removeThreadVolumes, emptyThreadData } from './compose-thread-store'
import { DOCKER_UNAVAILABLE, type DockerRunner } from './docker-runner'
import { KEPT_DATA_SENTENCE } from './kept-data'
import { GUARD_REFUSAL } from './migration-guard'
import { THREAD_DATA_SENTENCE } from './thread-data'
import { DOCKER_SENTENCE, portClashSentence } from './thread-docker'

/** What may never appear in a sentence a person reads. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['a backtick', /`/],
  ['the product-internal name', /planflow/i],
  ['a command flag', /(^|\s)--?[a-z]/i],
  ['a double dash', /--/],
  ['a path', /\//],
  ['a config file', /\.flowconfig|flowconfig/i],
  ['a config key', /[a-z]+_[a-z_]+/],
  ['a command', /docker (compose|volume|ps|rm)/i],
]

function expectPlain(where: string, text: string): void {
  for (const [what, pattern] of FORBIDDEN) {
    if (pattern.test(text)) throw new Error(`${where} contains ${what}: ${JSON.stringify(text)}`)
  }
}

const failing: DockerRunner = { run: async () => ({ ok: false, code: 1, stdout: '', stderr: '', timedOut: false }) }
const THREAD = '3f2a9c1e-77b0-4d2e-9a10-5b6c7d8e9f00'

const subject = (over: Partial<ThreadDeleteSubject> = {}): ThreadDeleteSubject => ({
  threadTitle: 'Fix login redirect',
  hasWorktree: false,
  changedFiles: null,
  branch: null,
  ...over,
})

describe('the Docker data feature’s words on screen', () => {
  it('the scan itself catches each thing it forbids (positive control)', () => {
    for (const bad of ['Run `docker compose up`.', 'Set run_order in .flowconfig.', 'See /Users/me/x.', 'Use --force.', 'planflow-ai did it.']) {
      expect(() => expectPlain('control', bad)).toThrow()
    }
    expect(() => expectPlain('control', "This thread's data is running.")).not.toThrow()
  })

  it('every constant sentence', async () => {
    const constants: Record<string, Record<string, string>> = {
      DOCKER_SENTENCE,
      GUARD_REFUSAL,
      DOCKER_UNAVAILABLE,
      THREAD_DATA_SENTENCE,
      DOCKER_STRINGS,
      COMPOSE_PANEL_STRINGS,
      THREAD_DATA_STRINGS,
      KEPT_DATA_STRINGS,
      KEPT_DATA_SENTENCE,
    }
    let count = 0
    for (const [name, table] of Object.entries(constants)) {
      for (const [key, text] of Object.entries(table)) {
        expectPlain(`${name}.${key}`, text)
        count += 1
      }
    }
    expectPlain('VOLUMES_LABEL', VOLUMES_LABEL)
    expect(count).toBeGreaterThan(60)
  })

  it('the kept data section: heading, total, rows, confirm, and the Docker-closed sentence', () => {
    const kept = {
      threadId: 't1',
      projectRoot: '/repos/shop',
      projectName: 'shop',
      title: null,
      volumes: [{ volume: 'pgdata', sizeBytes: 1024 }, { volume: 'redis', sizeBytes: null }],
      totalBytes: null,
    }
    const section = keptSection({ dockerAvailable: true, items: [kept, { ...kept, title: 'Fix login', totalBytes: 2048 }] })
    expect(section?.kind).toBe('list')
    const closed = keptSection({ dockerAvailable: false, items: [] })
    expect(closed?.kind).toBe('closed')
    if (section?.kind === 'list') for (const text of [section.heading, section.total ?? '', section.explanation]) expectPlain('keptSection', text)
    if (closed?.kind === 'closed') expectPlain('keptSection.closed', closed.closed)
    for (const entry of [kept, { ...kept, title: 'Fix login', totalBytes: 2048 }]) {
      const row = keptRow(entry)
      for (const text of [row.title, row.sub]) expectPlain('keptRow', text)
      const confirm = keptConfirm(entry)
      for (const text of [confirm.title, confirm.body, confirm.cancel, confirm.confirm]) expectPlain('keptConfirm', text)
    }
  })

  it('every built sentence: the port clash, the store’s refusals, the delete notice, the panel confirm, the group notices', async () => {
    expectPlain('portClashSentence', portClashSentence('shop', 'billing', 5432))
    // The Run menu's Docker section before a switch: a known title, and none.
    expectPlain('switchSentence', switchSentence('Invoice export'))
    expectPlain('switchSentence.unknown', switchSentence(null))

    // The store's own sentences (not exported) — reached through its refusals.
    for (const result of [
      await removeThreadVolumes(failing, 'shop', THREAD),
      await emptyThreadData(failing, 'shop', THREAD),
      await removeThreadVolumes(failing, 'shop', THREAD, { confirmed: true }),
      await liveThread(failing, 'shop'),
    ]) {
      expect(result.ok).toBe(false)
      if (!result.ok) expectPlain('compose-thread-store', result.detail)
    }

    const plain = threadDeleteNotice(subject())
    const withData = threadDeleteNotice(subject({ dataVolumes: { count: 2, totalBytes: 3 * 1024 ** 3 } }))
    expect(withData.offerVolumes).toBe(true)
    for (const text of [plain.question, plain.confirmLabel, withData.volumesLabel ?? '', withData.volumesLine ?? '']) {
      expectPlain('threadDeleteNotice', text)
    }

    const data: RunThreadData = {
      threadId: 't1',
      live: true,
      services: [{ projectName: 'shop', service: 'db', state: 'running' }],
      volumes: [{ projectName: 'shop', volume: 'pgdata', service: 'db', sizeBytes: 1024 }],
      totalBytes: 1024,
      sharedFolders: ['uploads'],
      unreadable: [],
      problem: null,
    }
    const face = composePanelFace('Fix login redirect', data)
    for (const kind of ['reset', 'delete'] as const) {
      const confirm = dataRemoveConfirm(kind, face)
      for (const text of [confirm.title, confirm.body, confirm.note, confirm.cancel, confirm.confirm]) expectPlain(`dataRemoveConfirm.${kind}`, text)
    }

    const details: Record<RunDockerNotice['kind'], string> = {
      'docker-unavailable': DOCKER_UNAVAILABLE['not-running'],
      'port-clash': portClashSentence('shop', 'billing', 5432),
      'switch-failed': `${DOCKER_SENTENCE.createFailed} Docker said:\nError: pull access denied for shop-api --platform linux/amd64`,
      'migration-refused': GUARD_REFUSAL.foreign,
      'migration-failed': DOCKER_SENTENCE.migrationFailed,
      'no-data-commands': DOCKER_SENTENCE.noMigrations,
      'services-not-ready': DOCKER_SENTENCE.notReady,
    }
    for (const [kind, detail] of Object.entries(details) as Array<[RunDockerNotice['kind'], string]>) {
      for (const offer of [true, false]) {
        const notice = dockerNoticeFace({ projectRoot: '/repos/shop', kind, detail }, offer, 0)
        expectPlain(`dockerNoticeFace.${kind}`, notice.sentence)
        if (notice.title !== null) expectPlain(`dockerNoticeFace.${kind}.title`, notice.title)
      }
    }
    // What Docker printed survives, in the mono part only.
    const failed = dockerNoticeFace({ projectRoot: '/repos/shop', kind: 'switch-failed', detail: details['switch-failed'] }, false, 0)
    expect(failed.lines).toContain('--platform linux/amd64')
    expect(failed.sentence).not.toContain('pull access denied')
  })
})
