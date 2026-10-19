/**
 * THE IDENTITY STORE, WIRED TO THIS MACHINE.
 *
 * `identity-store.ts` holds every rule and knows nothing about Electron or the
 * filesystem. This is the twenty lines that give it both — kept apart so the
 * rules stay testable under a node-environment jest, and so the only code that
 * touches `safeStorage` and `userData` is code with no decisions in it.
 *
 * The file sits in userData beside the app's other state rather than in
 * `~/.flow/`, because unlike the credentials file it is NOT meant to survive a
 * reinstall or be copied between machines: it is ciphertext whose key lives in
 * this login session's keychain, so a copy of it is worthless anywhere else.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createIdentityStore, type IdentityStoreDeps } from './identity-store'

/** Built from Electron's app + safeStorage, which arrive as arguments. */
export function createMachineIdentityStore(
  userDataPath: string,
  safeStorage: IdentityStoreDeps['encryption'],
): ReturnType<typeof createIdentityStore> {
  const file = join(userDataPath, 'identity.bin')
  return createIdentityStore({
    encryption: safeStorage,
    read: () => (existsSync(file) ? readFileSync(file) : null),
    write: (data) => {
      mkdirSync(dirname(file), { recursive: true })
      // Owner-only. The contents are ciphertext, but a credential file that is
      // world-readable invites somebody to try, and costs nothing to narrow.
      writeFileSync(file, data, { mode: 0o600 })
    },
    remove: () => {
      if (existsSync(file)) rmSync(file, { force: true })
    },
  })
}
