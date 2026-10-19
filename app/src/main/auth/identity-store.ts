/**
 * WHERE A SIGNED-IN IDENTITY LIVES — the OS keychain, not the plain file.
 *
 * `credentials.ts` holds API keys at `~/.flow/credentials.json`, mode 0600.
 * That is a reasonable home for a key the user pasted in and can paste again;
 * it is the wrong home for a session token, which is a live credential to
 * somebody's account that they did not choose and cannot see.
 *
 * Electron's `safeStorage` encrypts with a key held by the OS keychain
 * (Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux), so what
 * lands on disk is ciphertext and the key is protected by the login session.
 *
 * ── IT REFUSES RATHER THAN FALLING BACK ─────────────────────────────────────
 *
 * On a Linux box with no keyring, `safeStorage.isEncryptionAvailable()` is
 * false, and the tempting move is to write the token in the clear "just this
 * once" so sign-in keeps working. This refuses instead, and says why.
 *
 * That is the opposite of the trade `credentials.ts` documents for Windows
 * ACLs — and deliberately so. There, refusing would break sign-in for a key the
 * user can re-enter, in exchange for a named exposure. Here the exposure IS the
 * session token, and signing in is OPTIONAL: the plan's own requirement is that
 * signed-out is a full state where every feature works. So refusing costs the
 * person nothing they cannot live without, and the alternative puts a live
 * credential in a world-readable-ish file to buy a feature they were told was
 * optional (forbidden-pattern #15's cousin — the convenient default that does
 * the dangerous thing).
 *
 * Pure of Electron: `safeStorage` and the filesystem arrive as dependencies, so
 * every rule here is testable under this app's node-environment jest.
 */

/** What is kept about a signed-in person. Deliberately small. */
export interface StoredIdentity {
  /** The provider's stable id for this person — the join key, and nothing more. */
  subject: string
  /** Shown in the UI so somebody can see who they are signed in as. */
  displayName: string | null
  /** The live credential. Never crosses IPC, never enters a prompt. */
  token: string
  /** When it stops being usable, epoch ms, or null when the provider said nothing. */
  expiresAt: number | null
}

export interface IdentityStoreDeps {
  /** Electron's `safeStorage`, or a stand-in. */
  encryption: {
    isEncryptionAvailable(): boolean
    encryptString(plain: string): Buffer
    decryptString(encrypted: Buffer): string
  }
  read: () => Buffer | null
  write: (data: Buffer) => void
  remove: () => void
}

export type SaveResult = { ok: true } | { ok: false; reason: string }

/** What a sign-out actually did — the plan asks it to SAY, not just do. */
export interface SignOutReport {
  /** True when something was there to remove. */
  removed: boolean
  /** One sentence, in the user's terms. No paths, no key names. */
  detail: string
}

const NO_ENCRYPTION =
  "This computer has no secure place to keep a sign-in, so Flow won't store one. Everything else works exactly as it does now."

export function createIdentityStore(deps: IdentityStoreDeps) {
  return {
    /** Whether signing in can be offered at all on this machine. */
    available(): boolean {
      try {
        return deps.encryption.isEncryptionAvailable()
      } catch {
        return false
      }
    },

    save(identity: StoredIdentity): SaveResult {
      // FAIL CLOSED. Nothing is written in the clear as a fallback.
      if (!this.available()) return { ok: false, reason: NO_ENCRYPTION }
      try {
        deps.write(deps.encryption.encryptString(JSON.stringify(identity)))
        return { ok: true }
      } catch {
        return { ok: false, reason: "Flow couldn't save your sign-in, so you are still signed out." }
      }
    },

    /**
     * The stored identity, or null.
     *
     * NULL FOR EVERY FAILURE, on purpose: a corrupt blob, a keychain that no
     * longer holds the key (a restored backup, a changed login password), a
     * half-written file. Every one of those means "not signed in", which is a
     * complete state the app already supports — so none of them is an error
     * anybody needs to see.
     */
    load(): StoredIdentity | null {
      try {
        // THE FILE FIRST, THE KEYCHAIN ONLY IF THERE IS SOMETHING TO OPEN.
        //
        // This asked the keychain before looking, which meant somebody who had
        // never signed in still triggered a macOS dialog — "Flow wants to use
        // your confidential information… enter the login keychain password" —
        // merely by opening Settings. A prompt like that, for a feature you
        // have not used, reads as malware rather than as protection.
        //
        // Reading the file costs a stat and tells us the same thing: no file,
        // nobody signed in, nothing to decrypt, no reason to disturb anyone.
        const raw = deps.read()
        if (raw === null || raw.length === 0) return null
        if (!this.available()) return null
        const parsed: unknown = JSON.parse(deps.encryption.decryptString(raw))
        return isIdentity(parsed) ? parsed : null
      } catch {
        return null
      }
    },

    /** Sign out: remove the local identity, and report what happened. */
    signOut(): SignOutReport {
      let had = false
      try {
        const raw = deps.read()
        had = raw !== null && raw.length > 0
      } catch {
        had = false
      }
      try {
        deps.remove()
      } catch {
        // A remove that fails leaves a credential behind; say so rather than
        // reporting a sign-out that did not happen.
        return {
          removed: false,
          detail: "Flow couldn't remove your sign-in from this computer. Try again in a moment.",
        }
      }
      return {
        removed: had,
        detail: had
          ? 'Signed out. Your sign-in has been removed from this computer.'
          : 'You were already signed out on this computer.',
      }
    },
  }
}

/** A stored blob is untrusted input — it may predate a shape change. */
function isIdentity(value: unknown): value is StoredIdentity {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record['subject'] !== 'string' || record['subject'] === '') return false
  if (typeof record['token'] !== 'string' || record['token'] === '') return false
  if (record['displayName'] !== null && typeof record['displayName'] !== 'string') return false
  if (record['expiresAt'] !== null && typeof record['expiresAt'] !== 'number') return false
  return true
}

/** True when a stored identity is past its expiry. Null expiry never expires. */
export function isExpired(identity: StoredIdentity, now: number): boolean {
  return identity.expiresAt !== null && identity.expiresAt <= now
}
