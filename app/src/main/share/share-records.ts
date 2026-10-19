/**
 * WHAT THIS ACCOUNT HAS SHARED, REMEMBERED ON THIS MACHINE (review R2-M7).
 *
 * Opening a feature view used to ask planflow.sh about it — sending the project
 * and the discovery's name whenever someone was signed in, shared or not. Now
 * the client asks the server about a discovery ONLY when this record says it is
 * shared. A never-shared discovery sends nothing.
 *
 * Keyed by (account subject, projectId, slug) → share id. Written when a
 * publish succeeds and when a person presses "Check sharing status" and the
 * server finds one; kept when a share is revoked (so the view can say it is
 * unshared); removed when the server answers "no such share" for it.
 *
 * Stored as one small JSON file in the app's own data directory — not in the
 * project, because which account shared what is about this person, not about
 * the repository. Reads are served from memory after the first load; writes are
 * serialized and atomic (temp + rename), and never block main on a sync call.
 */
import { promises as fsPromises } from 'fs'
import { dirname } from 'path'

import { SHARE_PROJECT_ID_PATTERN, SHARE_SLUG_PATTERN } from '../../shared/share-contract'
import { errorCode } from './share-file-guard'

export interface ShareRecordKey {
  subject: string
  projectId: string
  slug: string
}

export interface ShareRecords {
  /** The share id recorded for this discovery, or null. */
  get(key: ShareRecordKey): Promise<string | null>
  set(key: ShareRecordKey, id: string): Promise<void>
  remove(key: ShareRecordKey): Promise<void>
  /** Remove whatever this account recorded under this share id. */
  removeId(subject: string, id: string): Promise<void>
}

interface StoredRecord extends ShareRecordKey {
  id: string
}

const RECORD_FILE_VERSION = 1

/** A share id as the server mints them (mirrors the client's check). */
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

function keyOf(key: ShareRecordKey): string {
  return `${key.subject}\u0000${key.projectId}\u0000${key.slug}`
}

function isRecord(value: unknown): value is StoredRecord {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['subject'] === 'string' &&
    v['subject'] !== '' &&
    typeof v['projectId'] === 'string' &&
    SHARE_PROJECT_ID_PATTERN.test(v['projectId']) &&
    typeof v['slug'] === 'string' &&
    SHARE_SLUG_PATTERN.test(v['slug']) &&
    typeof v['id'] === 'string' &&
    SHARE_ID_PATTERN.test(v['id'])
  )
}

/** The records held in memory, from whatever a backend loads. */
function createRecords(load: () => Promise<StoredRecord[]>, save: (records: StoredRecord[]) => Promise<void>): ShareRecords {
  let held: Map<string, StoredRecord> | null = null
  let loading: Promise<Map<string, StoredRecord>> | null = null
  let writes: Promise<void> = Promise.resolve()

  async function records(): Promise<Map<string, StoredRecord>> {
    if (held !== null) return held
    loading ??= load().then((list) => {
      held = new Map(list.filter(isRecord).map((record) => [keyOf(record), record]))
      return held
    })
    return loading
  }

  function persist(map: Map<string, StoredRecord>): Promise<void> {
    const snapshot = [...map.values()]
    writes = writes.then(() => save(snapshot)).catch((error: unknown) => {
      console.warn('[Share] share records could not be saved', { code: errorCode(error) })
    })
    return writes
  }

  return {
    async get(key) {
      return (await records()).get(keyOf(key))?.id ?? null
    },
    async set(key, id) {
      const map = await records()
      const record: StoredRecord = { ...key, id }
      if (!isRecord(record)) return
      if (map.get(keyOf(key))?.id === id) return
      map.set(keyOf(key), record)
      await persist(map)
    },
    async remove(key) {
      const map = await records()
      if (!map.delete(keyOf(key))) return
      await persist(map)
    },
    async removeId(subject, id) {
      const map = await records()
      let changed = false
      for (const [k, record] of map) {
        if (record.subject === subject && record.id === id) {
          map.delete(k)
          changed = true
        }
      }
      if (changed) await persist(map)
    },
  }
}

/** Records kept in one JSON file (the app's data directory). */
export function createFileShareRecords(filePath: string): ShareRecords {
  return createRecords(
    async () => {
      let raw: string
      try {
        raw = await fsPromises.readFile(filePath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
          console.warn('[Share] share records unreadable; starting empty', { code: errorCode(error) })
        }
        return []
      }
      try {
        const parsed = JSON.parse(raw) as { records?: unknown }
        return Array.isArray(parsed.records) ? (parsed.records as StoredRecord[]) : []
      } catch (error) {
        console.warn('[Share] share records unparseable; starting empty', { code: errorCode(error) })
        return []
      }
    },
    async (records) => {
      await fsPromises.mkdir(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp-${process.pid}`
      await fsPromises.writeFile(tmp, JSON.stringify({ version: RECORD_FILE_VERSION, records }), {
        encoding: 'utf8',
        mode: 0o600,
      })
      await fsPromises.rename(tmp, filePath)
    },
  )
}

/** Records kept in memory only — for tests, and seeded as given. */
export function createMemoryShareRecords(initial: Array<ShareRecordKey & { id: string }> = []): ShareRecords & {
  all(): Array<ShareRecordKey & { id: string }>
} {
  let saved: StoredRecord[] = initial.map((record) => ({ ...record }))
  const records = createRecords(
    async () => saved.map((record) => ({ ...record })),
    async (next) => {
      saved = next.map((record) => ({ ...record }))
    },
  )
  return { ...records, all: () => saved.map((record) => ({ ...record })) }
}
